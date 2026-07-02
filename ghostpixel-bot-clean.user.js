// ==UserScript==
// @name         GhostPixel Bot Clean
// @namespace    https://github.com/Fox3225/GeoPixelsBotClean
// @version      1.0.7-clean
// @description  Clean and optimized GeoPixels userscript for painting ghost images, syncing progress, prioritizing colors, buying missing colors, and managing Energy Capacity.
// @author       Fox3225 + Codex
// @match        https://geopixels.net/*
// @match        https://*.geopixels.net/*
// @icon         https://raw.githubusercontent.com/nymtuta/GeoPixelsBot/refs/heads/main/img/icon.png
// @license      GPL-3.0
// @homepageURL  https://github.com/Fox3225/GeoPixelsBotClean
// @supportURL   https://github.com/Fox3225/GeoPixelsBotClean/issues
// @downloadURL  https://raw.githubusercontent.com/Fox3225/GeoPixelsBotClean/main/ghostpixel-bot-clean.user.js
// @updateURL    https://raw.githubusercontent.com/Fox3225/GeoPixelsBotClean/main/ghostpixel-bot-clean.user.js
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
	"use strict";

	const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
	const VERSION = "1.0.7-clean";
	const TILE_SIZE = 1000;
	const TILE_BATCH_SIZE = 9;
	const MAX_PIXELS_PER_REQUEST = 5000;
	const REQUEST_PAUSE_MS = 1200;
	const EMPTY_ENERGY_PAUSE_MIN_MS = 15000;
	const PURCHASE_RESULT_TIMEOUT_MS = 12000;
	const COLOR_PURCHASE_PAUSE_MS = 300;
	const ENERGY_CAPACITY_PURCHASE_CHUNK = 50;
	const SETTINGS_KEY = "ghostpixel_clean_settings";

	const FREE_COLOR_IDS = new Set([
		"#FFFFFF", "#FFCA3A", "#FF595E", "#F3BBC2", "#BD637D", "#6A4C93",
		"#A8D0DC", "#1A535C", "#1982C4", "#8AC926", "#6B4226", "#CFD078",
		"#8B1D24", "#C49A6C", "#000000", "#00000000",
	].map(toColorId).filter((id) => id !== null));

	const state = {
		running: false,
		stopRequested: false,
		placedThisRun: 0,
		totalTargets: 0,
		remaining: 0,
		localEnergy: null,
		serverTimestamp: 0,
		status: "idle",
		message: "Pronto",
	};

	let settings = loadSettings();
	let stopWake = null;
	let targetCache = null;
	let purchaseObserverInstalled = false;
	let originalFetch = null;
	let authCache = null;
	const purchaseEvents = [];
	const purchasedColorIds = new Set();
	const boardColors = new Map();
	const tileTimestamps = new Map();
	const ui = {};

	function log(level, ...args) {
		console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
			"%c[GhostPixel Clean]",
			"color:#38bdf8;font-weight:700",
			...args
		);
	}

	function storageGet(key) {
		try {
			const value = win.localStorage && win.localStorage.getItem(key);
			if (value !== null && value !== undefined) return value;
		} catch {}
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	function storageSet(key, value) {
		try {
			if (win.localStorage) win.localStorage.setItem(key, value);
		} catch {}
		try {
			localStorage.setItem(key, value);
		} catch {}
	}

	function installPageBridge() {
		try {
			if (
				typeof win.__gpcReadGlobal === "function" &&
				typeof win.__gpcPlacePixels === "function" &&
				typeof win.__gpcMakePurchase === "function" &&
				typeof win.__gpcGetUserData === "function" &&
				typeof win.__gpcGetFetchEvents === "function"
			) {
				return true;
			}
			const script = document.createElement("script");
			script.textContent = `
				(() => {
					const readPageGlobal = (name) => {
						try { return eval(name); }
						catch (error) { return undefined; }
					};
					const authSnapshot = () => {
						const data = {};
						try { data.tokenUser = typeof tokenUser !== "undefined" ? tokenUser : ""; } catch {}
						try { data.subject = typeof subject !== "undefined" ? subject : ""; } catch {}
						try { data.userID = typeof userID !== "undefined" ? userID : null; } catch {}
						try { data.userData = typeof userData !== "undefined" ? userData : null; } catch {}
						return data;
					};
					const authPayload = () => {
						const data = authSnapshot();
						const rawUserId = data.userID || (data.userData && data.userData.id);
						const parsedUserId = Number(rawUserId);
						const loginSubject = data.subject || (data.userData && data.userData.subject) || "";
						if (!data.tokenUser || !Number.isFinite(parsedUserId) || !loginSubject) {
							return {
								error: "Dados de login nao encontrados. Atualize o GeoPixels ou faca login de novo.",
								debug: {
									hasToken: !!data.tokenUser,
									hasSubject: !!loginSubject,
									userID: rawUserId || null
								}
							};
						}
						return {
							Token: String(data.tokenUser),
							Subject: String(loginSubject),
							UserId: Math.trunc(parsedUserId)
						};
					};
					const readResponse = async (response) => ({
						ok: response.ok,
						status: response.status,
						text: await response.text().catch(() => "")
					});
					const redactBody = (body) => {
						if (typeof body !== "string") return null;
						try {
							const data = JSON.parse(body);
							if (data.Token) data.Token = "[redacted]";
							if (data.Subject) data.Subject = "[redacted]";
							if (data.token) data.token = "[redacted]";
							return data;
						} catch {
							return body.slice(0, 300);
						}
					};
					const requestUrlOf = (input) => {
						if (typeof input === "string") return input;
						if (input && typeof input.url === "string") return input.url;
						return "";
					};
					const shouldRecordFetch = (requestUrl) =>
						/\\/(MakePurchase|GetUserData|PlacePixels)\\b/.test(requestUrl);
					if (!window.__gpcFetchEvents) {
						Object.defineProperty(window, "__gpcFetchEvents", {
							configurable: true,
							value: []
						});
					}
					const recordFetchEvent = (requestUrl, init, response, text) => {
						try {
							window.__gpcFetchEvents.push({
								url: requestUrl,
								ok: response.ok,
								status: response.status,
								body: redactBody(init && init.body),
								text,
								at: new Date().toISOString()
							});
							if (window.__gpcFetchEvents.length > 80) {
								window.__gpcFetchEvents.splice(0, window.__gpcFetchEvents.length - 80);
							}
						} catch {}
					};
					if (!window.__gpcFetchRecorderInstalled && typeof window.fetch === "function") {
						const originalFetch = window.fetch.bind(window);
						Object.defineProperty(window, "__gpcFetchRecorderInstalled", {
							configurable: true,
							value: true
						});
						window.fetch = async (input, init) => {
							const requestUrl = requestUrlOf(input);
							const response = await originalFetch(input, init);
							if (shouldRecordFetch(requestUrl)) {
								response.clone().text()
									.then((text) => recordFetchEvent(requestUrl, init, response, text))
									.catch(() => {});
							}
							return response;
						};
					}
					const currentEnergyFromData = (data) => {
						if (!data) return null;
						const energy = Number(data.energy);
						const max = Number(data.maxEnergy);
						const rate = Number(data.energyRate);
						const checked = Number(data.checkedTick);
						if (![energy, max, rate, checked].every(Number.isFinite) || rate <= 0) return null;
						if (energy > max) return Math.max(0, Math.floor(energy));
						const now = Math.floor(Date.now() / 1000);
						const regenerated = Math.max(0, Math.floor((now - checked) / rate));
						return Math.max(0, Math.floor(Math.min(energy + regenerated, max)));
					};
					const applyUserData = (data) => {
						if (!data) return;
						try { userData = data; } catch {}
						try { maxEnergy = Number(data.maxEnergy) || maxEnergy; } catch {}
						try { energyRate = Number(data.energyRate) || energyRate; } catch {}
						const energy = currentEnergyFromData(data);
						if (energy !== null) {
							try { currentEnergy = energy; } catch {}
						}
					};
					Object.defineProperty(window, "__gpcReadGlobal", {
						configurable: true,
						value: readPageGlobal
					});
					Object.defineProperty(window, "__gpcAuthSnapshot", {
						configurable: true,
						value: authSnapshot
					});
					Object.defineProperty(window, "__gpcGetFetchEvents", {
						configurable: true,
						value: () => window.__gpcFetchEvents.slice()
					});
					Object.defineProperty(window, "__gpcPlacePixels", {
						configurable: true,
						value: async (pixels) => {
							const auth = authPayload();
							if (auth.error) {
								return { ok: false, status: 0, text: auth.error, debug: auth.debug };
							}
							const cleanPixels = (Array.isArray(pixels) ? pixels : [])
								.map((pixel) => ({
									GridX: Number(pixel.GridX),
									GridY: Number(pixel.GridY),
									Color: Number(pixel.Color),
									UserId: auth.UserId
								}))
								.filter((pixel) =>
									Number.isFinite(pixel.GridX) &&
									Number.isFinite(pixel.GridY) &&
									Number.isFinite(pixel.Color) &&
									Number.isFinite(pixel.UserId)
								);
							if (!cleanPixels.length) {
								return { ok: false, status: 0, text: "Nenhum pixel valido para enviar." };
							}
							try {
								return await readResponse(await fetch("/PlacePixels", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ ...auth, Pixels: cleanPixels })
								}));
							} catch (error) {
								return { ok: false, status: 0, text: error && error.message ? error.message : String(error) };
							}
						}
					});
					Object.defineProperty(window, "__gpcMakePurchase", {
						configurable: true,
						value: async (type, amount) => {
							const auth = authPayload();
							if (auth.error) {
								return { ok: false, status: 0, text: auth.error, debug: auth.debug, type, amount };
							}
							try {
								return await readResponse(await fetch("/MakePurchase", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ ...auth, type, amount })
								}));
							} catch (error) {
								return {
									ok: false,
									status: 0,
									text: error && error.message ? error.message : String(error),
									type,
									amount
								};
							}
						}
					});
					Object.defineProperty(window, "__gpcGetUserData", {
						configurable: true,
						value: async () => {
							const auth = authPayload();
							if (auth.error) {
								return { ok: false, status: 0, text: auth.error, debug: auth.debug, data: null };
							}
							try {
								const response = await fetch("/GetUserData", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ userId: auth.UserId, token: auth.Token })
								});
								const text = await response.text().catch(() => "");
								let data = null;
								try { data = JSON.parse(text); } catch {}
								if (response.ok && data) applyUserData(data);
								return { ok: response.ok, status: response.status, text, data };
							} catch (error) {
								return {
									ok: false,
									status: 0,
									text: error && error.message ? error.message : String(error),
									data: null
								};
							}
						}
					});
				})();
			`;
			(document.head || document.documentElement).appendChild(script);
			script.remove();
		} catch {}
		return typeof win.__gpcReadGlobal === "function";
	}

	function loadSettings() {
		const fallback = {
			includeFreeColors: true,
			includeTransparent: false,
			ignoredColors: [],
			priorityColors: [],
			smartPriority: true,
			panelLeft: null,
			panelTop: null,
			minimized: false,
		};
		try {
			const loaded = { ...fallback, ...JSON.parse(storageGet(SETTINGS_KEY) || "{}") };
			loaded.ignoredColors = Array.isArray(loaded.ignoredColors)
				? loaded.ignoredColors.map(toColorId).filter((id) => id !== null)
				: [];
			loaded.priorityColors = Array.isArray(loaded.priorityColors)
				? loaded.priorityColors.map(toColorId).filter((id) => id !== null)
				: [];
			loaded.smartPriority = loaded.smartPriority !== false;
			return loaded;
		} catch {
			return fallback;
		}
	}

	function saveSettings() {
		storageSet(SETTINGS_KEY, JSON.stringify(settings));
	}

	function readGlobal(name) {
		installPageBridge();
		try {
			if (typeof win.__gpcReadGlobal === "function") {
				const bridged = win.__gpcReadGlobal(name);
				if (typeof bridged !== "undefined") return bridged;
			}
		} catch {}
		try {
			if (typeof win[name] !== "undefined") return win[name];
		} catch {}
		try {
			if (typeof win.eval === "function") {
				return win.eval("typeof " + name + " !== 'undefined' ? " + name + " : undefined");
			}
		} catch {}
		return undefined;
	}

	function readNumberGlobal(name) {
		const value = Number(readGlobal(name));
		return Number.isFinite(value) ? value : null;
	}

	function normalizeUserId(value) {
		if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
		if (typeof value !== "string") return null;

		const trimmed = value.trim();
		if (/^\d+$/.test(trimmed)) return Number(trimmed);

		const hashMatch = trimmed.match(/#(\d+)$/);
		if (hashMatch) return Number(hashMatch[1]);

		const numericMatch = trimmed.match(/\d+/);
		return numericMatch ? Number(numericMatch[0]) : null;
	}

	function toColorId(value) {
		if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
		if (value && typeof value === "object") {
			const r = value.r ?? value.R;
			const g = value.g ?? value.G;
			const b = value.b ?? value.B;
			const a = value.a ?? value.A ?? 255;
			if ([r, g, b, a].every((n) => Number.isFinite(Number(n)))) {
				return rgbaToColorId(Number(r), Number(g), Number(b), Number(a));
			}
			return null;
		}
		if (typeof value !== "string") return null;

		let text = value.trim();
		if (!text) return null;
		if (/^-?\d+$/.test(text)) return Number(text);
		if (text.toLowerCase() === "transparent") return -1;

		if (text.startsWith("#")) text = text.slice(1);
		if (/^[0-9a-fA-F]{3,4}$/.test(text)) {
			text = text.split("").map((c) => c + c).join("");
		}
		if (/^[0-9a-fA-F]{8}$/.test(text)) {
			const alpha = parseInt(text.slice(6, 8), 16);
			if (alpha === 0) return -1;
			text = text.slice(0, 6);
		}
		if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
		return parseInt(text, 16);
	}

	function rgbaToColorId(r, g, b, a) {
		if (a === 0) return -1;
		return ((r & 255) << 16) + ((g & 255) << 8) + (b & 255);
	}

	function colorHex(id) {
		if (id === -1) return "#00000000";
		return "#" + (id & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
	}

	function coordKey(x, y) {
		return x + "," + y;
	}

	function tileKey(x, y) {
		return tileOrigin(x) + "_" + tileOrigin(y);
	}

	function tileOrigin(value) {
		return Math.floor(value / TILE_SIZE) * TILE_SIZE;
	}

	function parseTileKey(key) {
		const cleanKey = String(key || "").replace(/^tile[_-]?/i, "").replace(",", "_");
		const [x, y] = (cleanKey.match(/-?\d+/g) || []).map(Number);
		return { x, y };
	}

	function chunk(array, size) {
		const chunks = [];
		for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
		return chunks;
	}

	function clampPositiveInt(value, fallback = 1, max = 999999) {
		const number = Math.floor(Number(value));
		if (!Number.isFinite(number) || number < 1) return fallback;
		return Math.min(number, max);
	}

	function delay(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function parseColorList(text) {
		return String(text || "")
			.split(",")
			.map((part) => toColorId(part.trim()))
			.filter((id) => id !== null);
	}

	function getOwnedColorIds() {
		const colors = readGlobal("Colors");
		if (!Array.isArray(colors)) {
			return purchasedColorIds.size ? new Set(purchasedColorIds) : null;
		}

		const result = new Set();
		for (const color of colors) {
			const id = toColorId(color);
			if (id !== null) result.add(id);
		}
		for (const id of purchasedColorIds) result.add(id);
		return result;
	}

	function getAuthPayload() {
		installPageBridge();
		let snapshot = {};
		try {
			snapshot = typeof win.__gpcAuthSnapshot === "function" ? win.__gpcAuthSnapshot() : {};
		} catch {}

		const userData = readGlobal("userData");
		const profileInput = document.getElementById("userID");
		const rawUserId =
			readGlobal("userID") ||
			snapshot.userID ||
			(userData && userData.id) ||
			(snapshot.userData && snapshot.userData.id) ||
			storageGet("userID") ||
			(profileInput && profileInput.value) ||
			"";
		const userId = normalizeUserId(rawUserId);
		const cached = authCache || {};
		return {
			token: readGlobal("tokenUser") || snapshot.tokenUser || cached.token || storageGet("tokenUser") || "",
			subject: readGlobal("subject") || snapshot.subject || (userData && userData.subject) || (snapshot.userData && snapshot.userData.subject) || cached.subject || "",
			userId,
		};
	}

	async function getAuthPayloadAsync() {
		const current = getAuthPayload();
		if (current.token && current.subject && Number.isFinite(current.userId)) return current;
		if (!current.token || !Number.isFinite(current.userId)) return current;

		try {
			const response = await fetch("/TryLogIn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: current.userId, token: String(current.token) }),
			});
			if (!response.ok) return current;

			const data = await response.json();
			authCache = {
				token: data.token || current.token,
				subject: data.subject || current.subject || "",
				userId: normalizeUserId(data.id) || current.userId,
			};

			try {
				if (authCache.token) storageSet("tokenUser", authCache.token);
				if (authCache.userId) storageSet("userID", String(authCache.userId));
			} catch {}

			return {
				token: authCache.token,
				subject: authCache.subject,
				userId: authCache.userId,
			};
		} catch {
			return current;
		}
	}

	function pixelsFromUserData(data) {
		if (!data || !Number.isFinite(Number(data.pixels))) return null;
		return Math.max(0, Math.floor(Number(data.pixels) / 5));
	}

	function energyFromUserData(data) {
		if (!data) return null;
		const energy = Number(data.energy);
		const maxEnergy = Number(data.maxEnergy);
		const energyRate = Number(data.energyRate);
		const checkedTick = Number(data.checkedTick);
		if (![energy, maxEnergy, energyRate, checkedTick].every(Number.isFinite) || energyRate <= 0) {
			return null;
		}
		if (energy > maxEnergy) return Math.max(0, Math.floor(energy));

		const now = Math.floor(Date.now() / 1000);
		const regenerated = Math.max(0, Math.floor((now - checkedTick) / energyRate));
		return Math.max(0, Math.floor(Math.min(energy + regenerated, maxEnergy)));
	}

	function readCachedAvailablePixels() {
		const fromUserData = pixelsFromUserData(readGlobal("userData"));
		if (fromUserData !== null) return fromUserData;

		const captured = Number(win._gbUserPixels);
		if (Number.isFinite(captured) && captured >= 0) return Math.floor(captured / 5);

		const balance = document.getElementById("pixelBalance");
		if (balance) {
			const parsed = parseInt(balance.textContent.replace(/[^\d]/g, ""), 10);
			if (Number.isFinite(parsed)) return parsed;
		}
		return 0;
	}

	async function fetchAvailablePixels() {
		installPageBridge();
		if (typeof win.__gpcGetUserData === "function") {
			try {
				const result = await win.__gpcGetUserData();
				if (result && result.ok) {
					const pixels = pixelsFromUserData(result.data);
					if (pixels !== null) return pixels;
				}
			} catch {}
		}

		const auth = await getAuthPayloadAsync();
		if (!auth.token || !Number.isFinite(auth.userId)) return readCachedAvailablePixels();

		try {
			const response = await fetch("/GetUserData", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: auth.userId, token: String(auth.token) }),
			});
			if (!response.ok) return readCachedAvailablePixels();

			const data = await response.json();
			const pixels = pixelsFromUserData(data);
			if (pixels !== null) return pixels;
		} catch {}

		return readCachedAvailablePixels();
	}

	async function fetchCurrentEnergy() {
		installPageBridge();
		if (typeof win.__gpcGetUserData === "function") {
			try {
				const result = await win.__gpcGetUserData();
				if (result && result.ok) {
					const energy = energyFromUserData(result.data);
					if (energy !== null) {
						state.localEnergy = energy;
						return energy;
					}
				}
			} catch {}
		}

		const fromUserData = energyFromUserData(readGlobal("userData"));
		if (fromUserData !== null) {
			state.localEnergy = fromUserData;
			return fromUserData;
		}

		return readEnergy();
	}

	function urlToString(input) {
		if (typeof input === "string") return input;
		if (input && typeof input.url === "string") return input.url;
		return "";
	}

	function parseRequestBody(init) {
		try {
			if (!init || typeof init.body !== "string") return null;
			return JSON.parse(init.body);
		} catch {
			return null;
		}
	}

	function installPurchaseObserver() {
		if (purchaseObserverInstalled) return;
		if (typeof win.fetch !== "function") throw new Error("fetch indisponivel na pagina.");

		originalFetch = win.fetch.bind(win);
		win.fetch = async function (input, init) {
			const requestUrl = urlToString(input);
			const body = parseRequestBody(init);
			const startedAt = Date.now();
			const response = await originalFetch(input, init);

			if (requestUrl.includes("MakePurchase")) {
				response.clone().text()
					.then((text) => {
						purchaseEvents.push({
							ok: response.ok,
							status: response.status,
							text,
							type: body && body.type,
							amount: body && body.amount,
							startedAt,
							at: Date.now(),
						});
						if (purchaseEvents.length > 30) purchaseEvents.splice(0, purchaseEvents.length - 30);
					})
					.catch(() => {});
			}

			return response;
		};
		purchaseObserverInstalled = true;
	}

	async function waitForPageFunction(name, timeoutMs = 10000) {
		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const fn = readGlobal(name);
			if (typeof fn === "function") return fn.bind(win);
			await delay(200);
		}
		throw new Error("Funcao da pagina indisponivel: " + name);
	}

	function normalizeEndpointResult(result, extra = {}) {
		if (!result || typeof result !== "object") return null;
		const status = Number(result.status);
		return {
			ok: !!result.ok,
			status: Number.isFinite(status) ? status : 0,
			text: typeof result.text === "string" ? result.text : "",
			...extra,
		};
	}

	async function callPurchaseEndpoint(type, amount) {
		const normalizedAmount = type === "ExtraColor" ? toColorId(amount) : amount;
		let bridgeResult = null;
		installPageBridge();
		if (typeof win.__gpcMakePurchase === "function") {
			try {
				bridgeResult = normalizeEndpointResult(
					await win.__gpcMakePurchase(type, normalizedAmount),
					{ type, amount: normalizedAmount }
				);
				if (bridgeResult && (bridgeResult.ok || bridgeResult.status !== 0)) return bridgeResult;
			} catch (error) {
				bridgeResult = {
					ok: false,
					status: 0,
					text: error && error.message ? error.message : String(error),
					type,
					amount: normalizedAmount,
				};
			}
		}

		const auth = await getAuthPayloadAsync();
		if (!auth.token || !auth.subject || !Number.isFinite(auth.userId)) {
			return {
				ok: false,
				status: 0,
				text: bridgeResult && bridgeResult.text
					? bridgeResult.text
					: "Dados de login insuficientes para /MakePurchase.",
				type,
				amount: normalizedAmount,
			};
		}

		const payload = {
			Token: String(auth.token),
			UserId: auth.userId,
			Subject: String(auth.subject),
			type,
			amount: normalizedAmount,
		};

		const response = await fetch("/MakePurchase", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		return {
			ok: response.ok,
			status: response.status,
			text: await response.text(),
			type,
			amount,
		};
	}

	async function waitForPurchaseResult(type, amount, startedAt) {
		const deadline = Date.now() + PURCHASE_RESULT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const result = purchaseEvents.find((event) => {
				if (event.startedAt < startedAt - 50) return false;
				if (event.type && event.type !== type) return false;
				if (event.amount && amount && event.amount !== amount) return false;
				return true;
			});
			if (result) return result;
			await delay(200);
		}

		return {
			ok: false,
			status: 0,
			text: "Nenhuma resposta de /MakePurchase foi observada.",
			type,
			amount,
		};
	}

	async function callPagePurchase(type, amount) {
		const direct = await callPurchaseEndpoint(type, amount);
		if (direct && (direct.ok || direct.status !== 0)) return direct;

		installPurchaseObserver();
		try {
			const makePurchase = await waitForPageFunction("MakePurchase", 1500);
			const startedAt = Date.now();
			const returned = await makePurchase(type, amount);
			if (returned && typeof returned === "object" && "ok" in returned) return returned;
			const observed = await waitForPurchaseResult(type, amount, startedAt);
			if (observed && observed.status !== 0) return observed;
		} catch {}
		return direct || callPurchaseEndpoint(type, amount);
	}

	function getGhostSource() {
		const imageData = readGlobal("ghostImageOriginalData");
		const topLeft = readGlobal("ghostImageTopLeft");
		if (!imageData || !imageData.data || !topLeft) return null;

		const gridX = Number(topLeft.gridX ?? topLeft.x);
		const gridY = Number(topLeft.gridY ?? topLeft.y);
		if (!Number.isFinite(gridX) || !Number.isFinite(gridY)) return null;

		return { imageData, gridX, gridY };
	}

	function settingsSignature() {
		return [
			settings.includeFreeColors ? "free" : "paid",
			settings.includeTransparent ? "alpha" : "opaque",
			[...settings.ignoredColors].sort((a, b) => a - b).join("."),
			[...settings.priorityColors].sort((a, b) => a - b).join("."),
			settings.smartPriority ? "smart" : "simple",
		].join("|");
	}

	function invalidateTargets() {
		targetCache = null;
		boardColors.clear();
		tileTimestamps.clear();
		state.serverTimestamp = 0;
		state.totalTargets = 0;
		state.remaining = 0;
	}

	function buildTargets() {
		const source = getGhostSource();
		if (!source) {
			throw new Error("Ghost image nao carregada. Carregue ou posicione a ghost image no GeoPixels primeiro.");
		}

		const sourceKey = [
			source.imageData.width,
			source.imageData.height,
			source.gridX,
			source.gridY,
			source.imageData.data.length,
			settingsSignature(),
		].join(":");

		if (targetCache && targetCache.sourceKey === sourceKey) return targetCache;

		const ignored = new Set(settings.ignoredColors);
		const priority = new Set(settings.priorityColors);
		const owned = getOwnedColorIds();
		const targets = [];
		const targetKeys = new Set();
		const targetsByTile = new Map();
		const data = source.imageData.data;
		const width = source.imageData.width;

		for (let dataIndex = 0, pixelIndex = 0; dataIndex < data.length; dataIndex += 4, pixelIndex++) {
			const colorId = rgbaToColorId(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2], data[dataIndex + 3]);
			const isTransparent = colorId === -1;
			const isFree = FREE_COLOR_IDS.has(colorId);

			if (!settings.includeTransparent && isTransparent) continue;
			if (!settings.includeFreeColors && isFree) continue;
			if (priority.size && !priority.has(colorId)) continue;
			if (ignored.has(colorId)) continue;
			if (owned && !isFree && !owned.has(colorId)) continue;

			const x = source.gridX + (pixelIndex % width);
			const y = source.gridY - Math.floor(pixelIndex / width);
			const key = coordKey(x, y);
			const target = { x, y, key, colorId };
			const tk = tileKey(x, y);

			targets.push(target);
			targetKeys.add(key);
			if (!targetsByTile.has(tk)) targetsByTile.set(tk, []);
			targetsByTile.get(tk).push(target);
		}

		targetCache = {
			sourceKey,
			targets: orderTargets(targets),
			targetKeys,
			targetsByTile,
			tileKeys: [...targetsByTile.keys()],
		};
		state.totalTargets = targetCache.targets.length;
		return targetCache;
	}

	function orderTargets(targets) {
		const colorCounts = new Map();
		for (const target of targets) {
			colorCounts.set(target.colorId, (colorCounts.get(target.colorId) || 0) + 1);
		}

		const priorityRank = new Map(settings.priorityColors.map((id, index) => [id, index]));
		if (settings.smartPriority) annotateRegionSizes(targets);

		return [...targets].sort((a, b) => {
			const priorityA = priorityRank.has(a.colorId) ? priorityRank.get(a.colorId) : Number.MAX_SAFE_INTEGER;
			const priorityB = priorityRank.has(b.colorId) ? priorityRank.get(b.colorId) : Number.MAX_SAFE_INTEGER;
			if (priorityA !== priorityB) return priorityA - priorityB;

			if (settings.smartPriority) {
				const regionA = Number.isFinite(a.regionSize) ? a.regionSize : Number.MAX_SAFE_INTEGER;
				const regionB = Number.isFinite(b.regionSize) ? b.regionSize : Number.MAX_SAFE_INTEGER;
				if (regionA !== regionB) return regionA - regionB;
			}

			const byRarity = colorCounts.get(a.colorId) - colorCounts.get(b.colorId);
			if (byRarity !== 0) return byRarity;
			if (a.y !== b.y) return b.y - a.y;
			return a.x - b.x;
		});
	}

	function annotateRegionSizes(targets) {
		const targetByKey = new Map();
		for (const target of targets) targetByKey.set(target.key, target);

		const visited = new Set();
		const stack = [];
		const pushNeighbor = (key, colorId) => {
			if (visited.has(key)) return;
			const next = targetByKey.get(key);
			if (!next || next.colorId !== colorId) return;
			visited.add(key);
			stack.push(next);
		};

		for (const target of targets) {
			if (visited.has(target.key)) continue;

			const region = [];
			const colorId = target.colorId;
			visited.add(target.key);
			stack.push(target);

			while (stack.length) {
				const current = stack.pop();
				region.push(current);

				pushNeighbor(coordKey(current.x + 1, current.y), colorId);
				pushNeighbor(coordKey(current.x - 1, current.y), colorId);
				pushNeighbor(coordKey(current.x, current.y + 1), colorId);
				pushNeighbor(coordKey(current.x, current.y - 1), colorId);
			}

			const size = region.length;
			for (const item of region) item.regionSize = size;
		}
	}

	function getGhostColorIds() {
		const source = getGhostSource();
		if (!source) {
			throw new Error("Ghost image nao carregada. Carregue ou posicione a ghost image no GeoPixels primeiro.");
		}

		const colors = new Set();
		const data = source.imageData.data;
		for (let i = 0; i < data.length; i += 4) {
			const colorId = rgbaToColorId(data[i], data[i + 1], data[i + 2], data[i + 3]);
			if (colorId !== -1 && !FREE_COLOR_IDS.has(colorId)) colors.add(colorId);
		}
		return colors;
	}

	function getMissingGhostColors() {
		const owned = getOwnedColorIds();
		if (!owned) throw new Error("Lista de cores compradas ainda nao carregou no GeoPixels.");

		return [...getGhostColorIds()]
			.filter((id) => !owned.has(id))
			.sort((a, b) => a - b);
	}

	async function buyColor(colorId) {
		colorId = toColorId(colorId);
		if (colorId === null || colorId === -1) throw new Error("Cor invalida para compra.");
		const hex = colorHex(colorId);
		setStatus("buying", "Comprando cor " + hex + "...");
		const result = await callPagePurchase("ExtraColor", hex);
		if (result.status === 402) return "insufficient";
		if (!result.ok) {
			log("warn", "Falha ao comprar cor", hex, result.status, result.text);
			return false;
		}

		purchasedColorIds.add(colorId);
		return true;
	}

	async function buyEnergyCapacity(amount = 1) {
		amount = clampPositiveInt(amount, 1);
		let remaining = amount;
		let bought = 0;
		let chunkSize = Math.min(remaining, ENERGY_CAPACITY_PURCHASE_CHUNK);

		while (remaining > 0) {
			const chunkAmount = Math.min(remaining, chunkSize);
			setStatus(
				"buying",
				"Comprando Energy Capacity " + bought + "/" + amount + "..."
			);

			const result = await callPagePurchase("EnergyCapacity", chunkAmount);
			log("log", "EnergyCapacity purchase result", {
				chunkAmount,
				ok: result && result.ok,
				status: result && result.status,
				text: result && result.text,
			});

			if (result && result.status === 402) {
				if (chunkAmount > 1) {
					chunkSize = Math.max(1, Math.floor(chunkAmount / 2));
					continue;
				}
				setStatus("waiting", "Pixels insuficientes para Energy Capacity.");
				return bought > 0 ? true : "insufficient";
			}
			if (!result || !result.ok) {
				log("warn", "Falha ao comprar Energy Capacity", result && result.status, result && result.text);
				setStatus("error", "Falha ao comprar Energy Capacity: " + (result && result.status) + " " + ((result && result.text) || ""));
				return bought > 0 ? true : false;
			}

			bought += chunkAmount;
			remaining -= chunkAmount;
			chunkSize = Math.min(remaining, ENERGY_CAPACITY_PURCHASE_CHUNK);
			if (remaining > 0) await delay(COLOR_PURCHASE_PAUSE_MS);
		}

		state.localEnergy = null;
		setStatus("done", "Energy Capacity comprado: +" + (bought * 5) + " max.");
		return true;
	}

	async function buyAllAffordableEnergyCapacity() {
		const availablePixels = await fetchAvailablePixels();
		const amount = Math.floor(availablePixels / 50);
		log("log", "EnergyCapacity buy-all calculation", { availablePixels, amount });
		if (amount < 1) {
			setStatus("done", "Paint concluido. Pixels insuficientes para Energy Capacity.");
			return false;
		}

		setStatus("buying", "Usando " + (amount * 50) + "/" + availablePixels + " Pixels em Energy Capacity...");
		return buyEnergyCapacity(amount);
	}

	async function buyMissingGhostColors() {
		if (state.running) {
			throw new Error("Pare o bot antes de comprar cores.");
		}

		const missing = getMissingGhostColors();
		if (!missing.length) {
			setStatus("idle", "Voce ja tem todas as cores da ghost image.");
			return { bought: 0, total: 0, insufficient: false };
		}

		const ok = confirm("Comprar " + missing.length + " cor(es) faltante(s) da ghost image?");
		if (!ok) {
			setStatus("idle", "Compra cancelada.");
			return { bought: 0, total: missing.length, cancelled: true };
		}

		let bought = 0;
		for (const colorId of missing) {
			const result = await buyColor(colorId);
			if (result === "insufficient") {
				setStatus("waiting", "Pixels insuficientes. Compradas " + bought + "/" + missing.length + ".");
				invalidateTargets();
				return { bought, total: missing.length, insufficient: true };
			}
			if (result === true) bought++;
			await delay(COLOR_PURCHASE_PAUSE_MS);
		}

		invalidateTargets();
		setStatus("idle", bought + "/" + missing.length + " cor(es) comprada(s).");
		return { bought, total: missing.length, insufficient: false };
	}

	function loadImage(src) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.decoding = "async";
			img.onload = () => resolve(img);
			img.onerror = reject;
			img.src = src;
		});
	}

	async function webpToImageData(base64) {
		const img = await loadImage("data:image/webp;base64," + base64);
		const canvas = document.createElement("canvas");
		canvas.width = TILE_SIZE;
		canvas.height = TILE_SIZE;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.translate(0, TILE_SIZE);
		ctx.scale(1, -1);
		ctx.drawImage(img, 0, 0);
		return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
	}

	function readFullTilePixels(tileX, tileY, imageData, targets) {
		const data = imageData.data;
		const topY = tileY + TILE_SIZE - 1;

		for (const target of targets) {
			const col = target.x - tileX;
			const row = topY - target.y;
			if (col < 0 || col >= TILE_SIZE || row < 0 || row >= TILE_SIZE) continue;

			const index = ((row * TILE_SIZE) + col) * 4;
			boardColors.set(
				target.key,
				rgbaToColorId(data[index], data[index + 1], data[index + 2], data[index + 3])
			);
		}
	}

	async function fetchTiles(tileCoords) {
		const response = await fetch("/GetPixelsCached", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				Tiles: tileCoords.map((tile) => ({
					x: tile.x,
					y: tile.y,
					timestamp: tileTimestamps.get(tileKey(tile.x, tile.y)) || 0,
				})),
			}),
		});

		if (!response.ok) {
			throw new Error("GetPixelsCached failed: " + response.status + " " + await response.text());
		}
		return response.json();
	}

	async function syncBoard() {
		const cache = buildTargets();
		if (!cache.tileKeys.length) return;

		setStatus("syncing", "Sincronizando " + cache.tileKeys.length + " tile(s)...");
		for (const group of chunk(cache.tileKeys.map(parseTileKey), TILE_BATCH_SIZE)) {
			if (state.stopRequested) return;

			const payload = await fetchTiles(group);
			if (payload && payload.ServerTimestamp) state.serverTimestamp = payload.ServerTimestamp;
			const timestamp = payload && Number(payload.ServerTimestamp);

			for (const [responseKey, tile] of Object.entries((payload && payload.Tiles) || {})) {
				const { x: tileX, y: tileY } = parseTileKey(responseKey);
				if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
				if (Number.isFinite(timestamp)) tileTimestamps.set(tileKey(tileX, tileY), timestamp);
				const targetGroup = cache.targetsByTile.get(tileKey(tileX, tileY));
				if (!targetGroup || !tile) continue;

				if (tile.Type === "delta" && Array.isArray(tile.Pixels)) {
					for (const pixel of tile.Pixels) {
						const [x, y, color] = pixel;
						const key = coordKey(x, y);
						if (cache.targetKeys.has(key)) boardColors.set(key, toColorId(color));
					}
				} else if (tile.Type === "full" && tile.ColorWebP) {
					const imageData = await webpToImageData(tile.ColorWebP);
					readFullTilePixels(tileX, tileY, imageData, targetGroup);
				}
			}
		}
		updateProgress();
	}

	function getRemainingTargets() {
		const cache = buildTargets();
		return cache.targets.filter((target) => boardColors.get(target.key) !== target.colorId);
	}

	function readEnergy() {
		const observed = readNumberGlobal("currentEnergy");
		if (state.localEnergy === null) return Math.max(0, Math.floor(observed || 0));
		if (observed !== null && observed > state.localEnergy) state.localEnergy = Math.floor(observed);
		return Math.max(0, Math.floor(state.localEnergy));
	}

	function markEnergySpent(amount, previousEnergy) {
		const base = state.localEnergy !== null ? state.localEnergy : Math.floor(previousEnergy || 0);
		state.localEnergy = Math.max(0, base - amount);
	}

	function readEnergyRateMs() {
		const seconds = readNumberGlobal("energyRate");
		const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
		return Math.max(EMPTY_ENERGY_PAUSE_MIN_MS, safeSeconds * 1000);
	}

	function formatDuration(seconds) {
		seconds = Math.max(0, Math.round(seconds));
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		if (h > 0) return h + "h " + m + "m";
		if (m > 0) return m + "m " + s + "s";
		return s + "s";
	}

	function estimateEta(remaining) {
		const currentEnergy = readEnergy();
		const missingEnergy = Math.max(0, remaining - currentEnergy);
		const rateSeconds = readEnergyRateMs() / 1000;
		return formatDuration(missingEnergy * rateSeconds);
	}

	async function sendPixelBatch(targets) {
		const pixels = targets
			.map((target) => ({
				GridX: Number(target.x),
				GridY: Number(target.y),
				Color: Number(target.colorId),
			}))
			.filter((pixel) =>
				Number.isFinite(pixel.GridX) &&
				Number.isFinite(pixel.GridY) &&
				Number.isFinite(pixel.Color)
			);

		if (!pixels.length) {
			return { ok: false, status: 0, text: "Nenhum pixel valido para enviar." };
		}

		let bridgeResult = null;
		installPageBridge();
		if (typeof win.__gpcPlacePixels === "function") {
			try {
				bridgeResult = normalizeEndpointResult(await win.__gpcPlacePixels(pixels));
				if (bridgeResult && bridgeResult.ok) {
					for (const target of targets) boardColors.set(target.key, target.colorId);
					state.placedThisRun += targets.length;
					return bridgeResult;
				}
				if (bridgeResult && bridgeResult.status !== 0) {
					log("warn", "PlacePixels failed via page bridge", {
						status: bridgeResult.status,
						text: bridgeResult.text,
						pixelCount: pixels.length,
						firstPixel: pixels[0],
					});
					return bridgeResult;
				}
			} catch (error) {
				bridgeResult = {
					ok: false,
					status: 0,
					text: error && error.message ? error.message : String(error),
				};
			}
		}

		const auth = await getAuthPayloadAsync();
		if (!auth.token || !Number.isFinite(auth.userId)) {
			return {
				ok: false,
				status: 0,
				text: bridgeResult && bridgeResult.text
					? bridgeResult.text
					: "Token ou userID nao encontrados. Faca login no GeoPixels de novo.",
			};
		}
		if (!auth.subject) {
			return {
				ok: false,
				status: 0,
				text: bridgeResult && bridgeResult.text
					? bridgeResult.text
					: "Subject de login nao encontrado. A sessao salva nao retornou /TryLogIn.",
			};
		}

		const pixelsWithUserId = pixels.map((pixel) => ({
			...pixel,
			UserId: auth.userId,
		}));
		const payload = {
			Token: String(auth.token),
			Subject: String(auth.subject),
			UserId: auth.userId,
			Pixels: pixelsWithUserId,
		};

		const response = await fetch("/PlacePixels", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const text = await response.text();
			log("warn", "PlacePixels failed", {
				status: response.status,
				text,
				userIdType: typeof payload.UserId,
				pixelCount: payload.Pixels.length,
				firstPixel: payload.Pixels[0],
			});
			return { ok: false, status: response.status, text };
		}

		for (const target of targets) boardColors.set(target.key, target.colorId);
		state.placedThisRun += targets.length;
		return { ok: true, status: response.status, text: await response.text().catch(() => "") };
	}

	function wait(ms) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				stopWake = null;
				resolve();
			}, ms);
			stopWake = () => {
				clearTimeout(timer);
				stopWake = null;
				resolve();
			};
		});
	}

	function requestStop() {
		state.stopRequested = true;
		if (stopWake) stopWake();
	}

	async function startBot() {
		if (state.running) return;

		state.running = true;
		state.stopRequested = false;
		state.placedThisRun = 0;
		state.localEnergy = null;
		setButtons();

		try {
			setStatus("running", "Preparando alvo...");
			buildTargets();
			await syncBoard();

			while (!state.stopRequested) {
				const remainingTargets = getRemainingTargets();
				state.remaining = remainingTargets.length;
				updateProgress();

				if (!remainingTargets.length) {
					setStatus("done", "Pronto. Todos os pixels ja estao corretos.");
					break;
				}

				const energy = await fetchCurrentEnergy();
				if (energy <= 0) {
					setStatus("waiting", "Sem energia. Aguardando recarga...");
					await wait(readEnergyRateMs());
					continue;
				}

				const amount = Math.min(energy, remainingTargets.length, MAX_PIXELS_PER_REQUEST);
				const batch = remainingTargets.slice(0, amount);
				setStatus("running", "Enviando " + amount + " pixel(s)...");

				const result = await sendPixelBatch(batch);
				if (!result.ok) {
					const message = "Send failed: " + result.status + " " + result.text;
					log("warn", message);
					setStatus(result.status === 401 ? "error" : "waiting", message);
					if (result.status === 401) break;
					if (result.status === 403 && /not enough energy/i.test(result.text || "")) {
						state.localEnergy = 0;
						setStatus("waiting", "Energia insuficiente. Aguardando recarga...");
						await wait(readEnergyRateMs());
						continue;
					}
					if (result.status === 403) break;
					await wait(5000);
					continue;
				}

				markEnergySpent(batch.length, energy);
				state.remaining = Math.max(0, state.remaining - batch.length);
				updateProgress();

				if (state.remaining === 0) {
					setStatus("done", "Pronto. Todos os pixels foram enviados.");
					break;
				}

				await wait(REQUEST_PAUSE_MS);
				await syncBoard();
			}

			if (state.stopRequested) setStatus("stopped", "Parado");
		} catch (error) {
			log("error", error);
			setStatus("error", error && error.message ? error.message : String(error));
		} finally {
			state.running = false;
			state.stopRequested = false;
			setButtons();
		}
	}

	async function manualSync() {
		try {
			invalidateTargets();
			buildTargets();
			await syncBoard();
			const remainingTargets = getRemainingTargets();
			state.remaining = remainingTargets.length;
			setStatus("idle", "Sincronizado");
			updateProgress();
		} catch (error) {
			log("error", error);
			setStatus("error", error && error.message ? error.message : String(error));
		}
	}

	function setStatus(status, message) {
		state.status = status;
		if (message) state.message = message;
		if (ui.status) {
			ui.status.textContent = status;
			ui.status.dataset.status = status;
		}
		if (ui.message) ui.message.textContent = state.message;
		if (ui.dot) ui.dot.dataset.status = status;
	}

	function setButtons() {
		if (!ui.start || !ui.stop || !ui.sync) return;
		ui.start.disabled = state.running;
		ui.stop.disabled = !state.running;
		ui.sync.disabled = state.running;
		if (ui.buyColors) ui.buyColors.disabled = state.running;
		if (ui.buyCapacity) ui.buyCapacity.disabled = state.running;
	}

	function updateProgress() {
		const total = state.totalTargets || (targetCache ? targetCache.targets.length : 0);
		const remaining = targetCache ? getRemainingTargets().length : state.remaining;
		const done = Math.max(0, total - remaining);
		const percent = total > 0 ? Math.round((done / total) * 100) : 0;
		state.remaining = remaining;

		if (ui.bar) ui.bar.style.width = percent + "%";
		if (ui.countText) ui.countText.textContent = done + " / " + total;
		if (ui.remainingText) ui.remainingText.textContent = String(remaining);
		if (ui.energyText) ui.energyText.textContent = String(readEnergy());
		if (ui.etaText) ui.etaText.textContent = remaining ? estimateEta(remaining) : "-";
	}

	function renderIgnoredColors() {
		renderColorChips(ui.ignoredList, settings.ignoredColors);
	}

	function renderPriorityColors() {
		renderColorChips(ui.priorityList, settings.priorityColors);
	}

	function renderColorChips(element, colors) {
		if (!element) return;
		if (!colors.length) {
			element.textContent = "Nenhuma";
			return;
		}
		element.innerHTML = "";
		for (const id of colors) {
			const chip = document.createElement("span");
			chip.className = "gpc-chip";
			chip.textContent = colorHex(id);
			if (id !== -1) chip.style.setProperty("--chip-color", colorHex(id));
			element.appendChild(chip);
		}
	}

	function applyFiltersChanged() {
		saveSettings();
		invalidateTargets();
		renderIgnoredColors();
		renderPriorityColors();
		updateProgress();
	}

	function mountUI() {
		if (document.getElementById("gpc-panel")) return;

		const style = document.createElement("style");
		style.textContent = `
			#gpc-panel {
				position: fixed;
				z-index: 2147483647;
				top: 18px;
				right: 18px;
				width: min(292px, calc(100vw - 16px));
				color: #e5e7eb;
				background: #111827;
				border: 1px solid #374151;
				border-radius: 8px;
				box-shadow: 0 18px 48px rgba(0,0,0,.35);
				font: 12px/1.4 Arial, sans-serif;
				overflow: hidden;
			}
			#gpc-panel * { box-sizing: border-box; }
			#gpc-head {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				padding: 10px 11px;
				background: #0f172a;
				border-bottom: 1px solid #253044;
				cursor: move;
			}
			.gpc-title {
				display: flex;
				align-items: center;
				gap: 7px;
				min-width: 0;
				font-weight: 700;
			}
			.gpc-title span:last-child {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			#gpc-dot {
				width: 8px;
				height: 8px;
				border-radius: 50%;
				background: #94a3b8;
			}
			#gpc-dot[data-status="running"] { background: #22c55e; }
			#gpc-dot[data-status="waiting"],
			#gpc-dot[data-status="syncing"] { background: #f59e0b; }
			#gpc-dot[data-status="buying"] { background: #a78bfa; }
			#gpc-dot[data-status="error"] { background: #ef4444; }
			#gpc-dot[data-status="done"] { background: #38bdf8; }
			#gpc-min {
				width: 26px;
				height: 24px;
				border: 1px solid #334155;
				border-radius: 6px;
				background: #172033;
				color: #cbd5e1;
				cursor: pointer;
				flex: 0 0 auto;
			}
			#gpc-body { padding: 11px; }
			#gpc-panel.gpc-min #gpc-body { display: none; }
			#gpc-panel.gpc-min { width: min(206px, calc(100vw - 16px)); }
			.gpc-row { display: flex; gap: 7px; align-items: center; }
			#gpc-head > .gpc-row { flex: 0 0 auto; }
			.gpc-row + .gpc-row { margin-top: 7px; }
			.gpc-btn {
				height: 30px;
				border: 1px solid #334155;
				border-radius: 6px;
				background: #1f2937;
				color: #e5e7eb;
				padding: 0 10px;
				font-weight: 700;
				cursor: pointer;
				white-space: nowrap;
			}
			.gpc-btn:hover { background: #263445; }
			.gpc-btn:disabled { opacity: .45; cursor: not-allowed; }
			.gpc-primary { background: #0f766e; border-color: #14b8a6; }
			.gpc-danger { background: #7f1d1d; border-color: #ef4444; }
			.gpc-grow { flex: 1; }
			#gpc-message {
				min-height: 18px;
				margin: 8px 0;
				color: #cbd5e1;
				overflow-wrap: anywhere;
			}
			#gpc-progress {
				height: 8px;
				border-radius: 999px;
				background: #020617;
				overflow: hidden;
				border: 1px solid #1f2937;
			}
			#gpc-bar {
				width: 0%;
				height: 100%;
				background: #22c55e;
				transition: width .18s ease;
			}
			.gpc-stats {
				display: grid;
				grid-template-columns: repeat(4, 1fr);
				gap: 6px;
				margin: 9px 0 10px;
			}
			.gpc-stat {
				min-width: 0;
				padding: 6px;
				border: 1px solid #273449;
				border-radius: 6px;
				background: #0b1220;
			}
			.gpc-stat b {
				display: block;
				color: #94a3b8;
				font-size: 10px;
				font-weight: 700;
			}
			.gpc-stat span {
				display: block;
				margin-top: 2px;
				font-size: 12px;
				font-weight: 700;
				overflow: hidden;
				text-overflow: ellipsis;
			}
			.gpc-section {
				margin-top: 10px;
				padding-top: 10px;
				border-top: 1px solid #273449;
			}
			.gpc-check {
				display: flex;
				align-items: center;
				gap: 6px;
				color: #d1d5db;
			}
			.gpc-check input { accent-color: #14b8a6; }
			.gpc-input {
				width: 100%;
				height: 30px;
				border: 1px solid #334155;
				border-radius: 6px;
				background: #020617;
				color: #e5e7eb;
				padding: 0 8px;
				outline: none;
			}
			.gpc-input:focus { border-color: #14b8a6; }
			.gpc-muted { color: #94a3b8; font-size: 11px; }
			#gpc-ignored-list,
			#gpc-priority-list {
				display: flex;
				flex-wrap: wrap;
				gap: 5px;
				margin-top: 7px;
				color: #94a3b8;
			}
			.gpc-chip {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				max-width: 100%;
				border: 1px solid #334155;
				border-radius: 999px;
				padding: 3px 7px;
				background: #0b1220;
				color: #dbeafe;
				font-size: 11px;
			}
			.gpc-chip::before {
				content: "";
				width: 9px;
				height: 9px;
				border-radius: 50%;
				background: var(--chip-color, transparent);
				border: 1px solid #475569;
			}
			#gpc-status {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				min-width: 58px;
				border: 1px solid #334155;
				border-radius: 999px;
				padding: 2px 7px;
				color: #cbd5e1;
				background: #111827;
				font-size: 11px;
				font-weight: 700;
			}
		`;
		document.head.appendChild(style);

		const panel = document.createElement("div");
		panel.id = "gpc-panel";
		panel.innerHTML = `
			<div id="gpc-head">
				<div class="gpc-title"><span id="gpc-dot"></span><span>GhostPixel</span></div>
				<div class="gpc-row">
					<span id="gpc-status">idle</span>
					<button id="gpc-min" type="button" title="Minimize">-</button>
				</div>
			</div>
			<div id="gpc-body">
				<div class="gpc-row">
					<button id="gpc-start" class="gpc-btn gpc-primary gpc-grow" type="button">Iniciar</button>
					<button id="gpc-stop" class="gpc-btn gpc-danger gpc-grow" type="button">Parar</button>
					<button id="gpc-sync" class="gpc-btn" type="button">Sync</button>
				</div>
				<div id="gpc-message">Pronto</div>
				<div id="gpc-progress"><div id="gpc-bar"></div></div>
				<div class="gpc-stats">
					<div class="gpc-stat"><b>Feitos</b><span id="gpc-count">0 / 0</span></div>
					<div class="gpc-stat"><b>Faltam</b><span id="gpc-left">0</span></div>
					<div class="gpc-stat"><b>Energia</b><span id="gpc-energy">0</span></div>
					<div class="gpc-stat"><b>ETA</b><span id="gpc-eta">-</span></div>
				</div>
				<div class="gpc-row">
					<label class="gpc-check"><input id="gpc-free" type="checkbox"> Cores gratis</label>
					<label class="gpc-check"><input id="gpc-alpha" type="checkbox"> Transparentes</label>
				</div>
				<div class="gpc-row">
					<label class="gpc-check"><input id="gpc-smart-priority" type="checkbox"> Prioridade inteligente</label>
				</div>
				<div class="gpc-section">
					<div class="gpc-muted">Excluir cores</div>
					<div class="gpc-row" style="margin-top:6px;">
						<input id="gpc-ignore-input" class="gpc-input" type="text" placeholder="#FF0000, #00FF00">
					</div>
					<div class="gpc-row">
						<button id="gpc-ignore-add" class="gpc-btn gpc-grow" type="button">Adicionar</button>
						<button id="gpc-ignore-clear" class="gpc-btn gpc-grow" type="button">Limpar</button>
					</div>
					<div id="gpc-ignored-list">Nenhuma</div>
				</div>
				<div class="gpc-section">
					<div class="gpc-muted">Priorizar cores</div>
					<div class="gpc-muted" style="margin-top:3px;">Quando preenchido, coloca apenas essas cores.</div>
					<div class="gpc-row" style="margin-top:6px;">
						<input id="gpc-priority-input" class="gpc-input" type="text" placeholder="#FF0000, #00FF00">
					</div>
					<div class="gpc-row">
						<button id="gpc-priority-add" class="gpc-btn gpc-grow" type="button">Adicionar</button>
						<button id="gpc-priority-clear" class="gpc-btn gpc-grow" type="button">Limpar</button>
					</div>
					<div id="gpc-priority-list">Nenhuma</div>
				</div>
				<div class="gpc-section">
					<button id="gpc-buy-colors" class="gpc-btn gpc-grow" type="button" style="width:100%;">Comprar todas as cores</button>
				</div>
				<div class="gpc-section">
					<button id="gpc-buy-capacity" class="gpc-btn gpc-grow" type="button" style="width:100%;">Comprar Energy Capacity agora</button>
				</div>
			</div>
		`;
		document.body.appendChild(panel);

		ui.panel = panel;
		ui.head = panel.querySelector("#gpc-head");
		ui.start = panel.querySelector("#gpc-start");
		ui.stop = panel.querySelector("#gpc-stop");
		ui.sync = panel.querySelector("#gpc-sync");
		ui.min = panel.querySelector("#gpc-min");
		ui.status = panel.querySelector("#gpc-status");
		ui.dot = panel.querySelector("#gpc-dot");
		ui.message = panel.querySelector("#gpc-message");
		ui.bar = panel.querySelector("#gpc-bar");
		ui.countText = panel.querySelector("#gpc-count");
		ui.remainingText = panel.querySelector("#gpc-left");
		ui.energyText = panel.querySelector("#gpc-energy");
		ui.etaText = panel.querySelector("#gpc-eta");
		ui.free = panel.querySelector("#gpc-free");
		ui.alpha = panel.querySelector("#gpc-alpha");
		ui.smartPriority = panel.querySelector("#gpc-smart-priority");
		ui.ignoreInput = panel.querySelector("#gpc-ignore-input");
		ui.ignoreAdd = panel.querySelector("#gpc-ignore-add");
		ui.ignoreClear = panel.querySelector("#gpc-ignore-clear");
		ui.ignoredList = panel.querySelector("#gpc-ignored-list");
		ui.priorityInput = panel.querySelector("#gpc-priority-input");
		ui.priorityAdd = panel.querySelector("#gpc-priority-add");
		ui.priorityClear = panel.querySelector("#gpc-priority-clear");
		ui.priorityList = panel.querySelector("#gpc-priority-list");
		ui.buyColors = panel.querySelector("#gpc-buy-colors");
		ui.buyCapacity = panel.querySelector("#gpc-buy-capacity");

		ui.free.checked = !!settings.includeFreeColors;
		ui.alpha.checked = !!settings.includeTransparent;
		ui.smartPriority.checked = !!settings.smartPriority;
		panel.classList.toggle("gpc-min", !!settings.minimized);
		ui.min.textContent = settings.minimized ? "+" : "-";
		ui.min.title = settings.minimized ? "Expandir" : "Minimize";
		if (Number.isFinite(settings.panelLeft) && Number.isFinite(settings.panelTop)) {
			panel.style.left = settings.panelLeft + "px";
			panel.style.top = settings.panelTop + "px";
			panel.style.right = "auto";
		}

		ui.start.addEventListener("click", startBot);
		ui.stop.addEventListener("click", requestStop);
		ui.sync.addEventListener("click", manualSync);
		ui.free.addEventListener("change", () => {
			settings.includeFreeColors = ui.free.checked;
			applyFiltersChanged();
		});
		ui.alpha.addEventListener("change", () => {
			settings.includeTransparent = ui.alpha.checked;
			applyFiltersChanged();
		});
		ui.smartPriority.addEventListener("change", () => {
			settings.smartPriority = ui.smartPriority.checked;
			applyFiltersChanged();
			setStatus("idle", settings.smartPriority ? "Prioridade inteligente ativada." : "Prioridade inteligente desativada.");
		});
		ui.ignoreAdd.addEventListener("click", () => {
			const ids = parseColorList(ui.ignoreInput.value);
			if (!ids.length) {
				setStatus("idle", "Nenhuma cor valida encontrada.");
				return;
			}
			const next = new Set(settings.ignoredColors);
			for (const id of ids) next.add(id);
			settings.ignoredColors = [...next];
			ui.ignoreInput.value = "";
			applyFiltersChanged();
			setStatus("idle", settings.ignoredColors.length + " cor(es) excluida(s).");
		});
		ui.ignoreClear.addEventListener("click", () => {
			settings.ignoredColors = [];
			applyFiltersChanged();
			setStatus("idle", "Exclusao de cores limpa.");
		});
		ui.ignoreInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") ui.ignoreAdd.click();
		});
		ui.priorityAdd.addEventListener("click", () => {
			const ids = parseColorList(ui.priorityInput.value);
			if (!ids.length) {
				setStatus("idle", "Nenhuma cor valida encontrada.");
				return;
			}
			const next = new Set(settings.priorityColors);
			for (const id of ids) next.add(id);
			settings.priorityColors = [...next];
			ui.priorityInput.value = "";
			applyFiltersChanged();
			setStatus("idle", settings.priorityColors.length + " cor(es) prioritaria(s).");
		});
		ui.priorityClear.addEventListener("click", () => {
			settings.priorityColors = [];
			applyFiltersChanged();
			setStatus("idle", "Prioridade de cores limpa.");
		});
		ui.priorityInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") ui.priorityAdd.click();
		});
		ui.buyColors.addEventListener("click", async () => {
			ui.buyColors.disabled = true;
			try {
				const result = await buyMissingGhostColors();
				if (result && result.cancelled) return;
				updateProgress();
			} catch (error) {
				log("error", error);
				setStatus("error", error && error.message ? error.message : String(error));
			} finally {
				ui.buyColors.disabled = state.running;
			}
		});
		ui.buyCapacity.addEventListener("click", async () => {
			ui.buyCapacity.disabled = true;
			try {
				await buyAllAffordableEnergyCapacity();
			} catch (error) {
				log("error", error);
				setStatus("error", error && error.message ? error.message : String(error));
			} finally {
				ui.buyCapacity.disabled = state.running;
			}
		});
		ui.min.addEventListener("click", () => {
			settings.minimized = !settings.minimized;
			panel.classList.toggle("gpc-min", settings.minimized);
			ui.min.textContent = settings.minimized ? "+" : "-";
			ui.min.title = settings.minimized ? "Expandir" : "Minimize";
			requestAnimationFrame(() => clampPanelToViewport(true));
			saveSettings();
		});

		enableDrag();
		clampPanelToViewport(false);
		window.addEventListener("resize", () => clampPanelToViewport(true));
		renderIgnoredColors();
		renderPriorityColors();
		setStatus("idle", "Pronto");
		setButtons();
		updateProgress();
	}

	function clampPanelToViewport(persist) {
		if (!ui.panel || !ui.head) return;
		const rect = ui.panel.getBoundingClientRect();
		const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
		const maxTop = Math.max(8, window.innerHeight - ui.head.offsetHeight - 8);
		const left = Math.max(8, Math.min(maxLeft, rect.left));
		const top = Math.max(8, Math.min(maxTop, rect.top));

		ui.panel.style.left = left + "px";
		ui.panel.style.top = top + "px";
		ui.panel.style.right = "auto";

		if (persist) {
			settings.panelLeft = Math.round(left);
			settings.panelTop = Math.round(top);
			saveSettings();
		}
	}

	function enableDrag() {
		let dragging = false;
		let offsetX = 0;
		let offsetY = 0;

		ui.head.addEventListener("pointerdown", (event) => {
			if (event.target === ui.min || event.target === ui.status) return;
			dragging = true;
			const rect = ui.panel.getBoundingClientRect();
			offsetX = event.clientX - rect.left;
			offsetY = event.clientY - rect.top;
			ui.head.setPointerCapture(event.pointerId);
		});

		ui.head.addEventListener("pointermove", (event) => {
			if (!dragging) return;
			const maxLeft = window.innerWidth - ui.panel.offsetWidth - 8;
			const maxTop = window.innerHeight - ui.head.offsetHeight - 8;
			const left = Math.max(8, Math.min(maxLeft, event.clientX - offsetX));
			const top = Math.max(8, Math.min(maxTop, event.clientY - offsetY));
			ui.panel.style.left = left + "px";
			ui.panel.style.top = top + "px";
			ui.panel.style.right = "auto";
		});

		ui.head.addEventListener("pointerup", () => {
			if (!dragging) return;
			dragging = false;
			const rect = ui.panel.getBoundingClientRect();
			settings.panelLeft = Math.round(rect.left);
			settings.panelTop = Math.round(rect.top);
			saveSettings();
		});
	}

	win.ghostBot = {
		version: VERSION,
		start: startBot,
		stop: requestStop,
		sync: manualSync,
		settings: () => ({ ...settings }),
		clearCache: invalidateTargets,
		ignoreColors(input) {
			const values = Array.isArray(input) ? input : parseColorList(input);
			settings.ignoredColors = values.map(toColorId).filter((id) => id !== null);
			applyFiltersChanged();
		},
		excludeColors(input) {
			const values = Array.isArray(input) ? input : parseColorList(input);
			settings.ignoredColors = values.map(toColorId).filter((id) => id !== null);
			applyFiltersChanged();
		},
		priorityColors(input) {
			const values = Array.isArray(input) ? input : parseColorList(input);
			settings.priorityColors = values.map(toColorId).filter((id) => id !== null);
			applyFiltersChanged();
		},
		smartPriority(enabled = true) {
			settings.smartPriority = !!enabled;
			if (ui.smartPriority) ui.smartPriority.checked = settings.smartPriority;
			applyFiltersChanged();
		},
		buyColor,
		buyMissingColors: buyMissingGhostColors,
		buyEnergyCapacity,
		buyAllEnergyCapacity: buyAllAffordableEnergyCapacity,
		purchaseDebug: async () => {
			const availablePixels = await fetchAvailablePixels();
			let events = [];
			try {
				events = typeof win.__gpcGetFetchEvents === "function" ? win.__gpcGetFetchEvents() : [];
			} catch {}
			return {
				version: VERSION,
				availablePixels,
				energyCapacityUnits: Math.floor(availablePixels / 50),
				bridgePurchase: typeof win.__gpcMakePurchase === "function",
				bridgeUserData: typeof win.__gpcGetUserData === "function",
				fetchRecorder: typeof win.__gpcGetFetchEvents === "function",
				events: events.slice(-20),
			};
		},
		authDebug: async () => {
			const auth = await getAuthPayloadAsync();
			return {
				hasToken: !!auth.token,
				hasSubject: !!auth.subject,
				userId: auth.userId,
				bridge: typeof win.__gpcReadGlobal === "function",
				bridgePlacePixels: typeof win.__gpcPlacePixels === "function",
				bridgePurchase: typeof win.__gpcMakePurchase === "function",
				bridgeUserData: typeof win.__gpcGetUserData === "function",
				pageToken: !!readGlobal("tokenUser"),
				pageSubject: !!readGlobal("subject"),
				storedToken: !!storageGet("tokenUser"),
				storedUserId: storageGet("userID"),
			};
		},
	};

	win.ghostBotUI = {
		show: () => { if (ui.panel) ui.panel.style.display = "block"; },
		hide: () => { if (ui.panel) ui.panel.style.display = "none"; },
		toggle: () => {
			if (ui.panel) ui.panel.style.display = ui.panel.style.display === "none" ? "block" : "none";
		},
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mountUI, { once: true });
	} else {
		mountUI();
	}

	log("log", "loaded", VERSION);
})();
