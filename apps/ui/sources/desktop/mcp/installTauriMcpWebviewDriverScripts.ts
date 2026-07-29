import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { applyLocalSettingsFromDesktopMcpBridge } from '@/sync/store/settingsWriters';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildDesktopActivityOverlaySnapshot } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import {
    getDesktopActivityOverlayWindowState,
    syncDesktopActivityOverlay,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import type {
    DesktopActivityOverlaySyncPayload,
    DesktopActivityOverlayWindowStatePayload,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import {
    buildDesktopActivityOverlayQaSyncPayload,
    desktopActivityOverlayQaSeedModes,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtures.mjs';
import {
    clearDesktopActivityOverlayQaSyncOverride,
    DESKTOP_ACTIVITY_OVERLAY_QA_PROOF_PIN_UNTIL_MODEL_KEY,
    readDesktopActivityOverlayQaSyncOverride,
    writeDesktopActivityOverlayQaSyncOverride,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayQaSyncOverride';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { resolveDesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

type McpWindowLike = typeof globalThis & {
    __MCP__?: {
        resolveRef?: unknown;
        resolveAll?: unknown;
        countAll?: unknown;
        reverseRefs?: unknown;
        applyHappierLocalSettings?: unknown;
        ensureHappierSessionVisible?: unknown;
        seedDesktopActivityOverlayQaState?: unknown;
        clearDesktopActivityOverlayQaState?: unknown;
    };
};

const REF_PATTERN = /^\[?(?:ref=)?(e\d+)\]?$/;
const desktopOverlayQaSeedModeSet = new Set(desktopActivityOverlayQaSeedModes);
const DESKTOP_OVERLAY_QA_SEED_PIN_DURATION_MS = 30_000;
const DESKTOP_OVERLAY_QA_SEED_PIN_INTERVAL_MS = 100;
const DESKTOP_OVERLAY_QA_SEED_VERIFY_ATTEMPTS = 5;
const DESKTOP_OVERLAY_QA_SEED_VERIFY_DELAY_MS = 50;
const desktopOverlayQaSeedPinTimers = new WeakMap<object, ReturnType<typeof setInterval>>();

type DesktopOverlayQaSeedVerificationResult = Readonly<{
    ok: boolean;
    reason?: string;
    expectedCardKind: string;
    observedCardKind: string | null;
    attempts: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveExpectedQaSeedCardKind(mode: string): string {
    switch (mode) {
        case 'active_session':
        case 'attention_only':
            return 'session_overview';
        case 'idle':
            return 'idle_state';
        default:
            return mode;
    }
}

function readOverlayWindowStatePrimaryCardKind(state: unknown): string | null {
    if (!isRecord(state) || !isRecord(state.model)) {
        return null;
    }

    const collapsed = state.model.collapsed;
    if (isRecord(collapsed)) {
        const collapsedKind = readString(collapsed.primaryCardKind);
        if (collapsedKind) {
            return collapsedKind;
        }
    }

    const expanded = state.model.expanded;
    if (!isRecord(expanded) || !Array.isArray(expanded.cards)) {
        return null;
    }

    const firstCard = expanded.cards[0];
    return isRecord(firstCard) ? readString(firstCard.kind) : null;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
    });
}

export async function waitForDesktopOverlayQaSeedState({
    mode,
    payload,
    attempts = DESKTOP_OVERLAY_QA_SEED_VERIFY_ATTEMPTS,
    delayMs = DESKTOP_OVERLAY_QA_SEED_VERIFY_DELAY_MS,
    syncDesktopOverlayPayload = syncDesktopActivityOverlay,
    readDesktopOverlayWindowState = getDesktopActivityOverlayWindowState,
    wait: waitFn = wait,
}: Readonly<{
    mode: string;
    payload: DesktopActivityOverlaySyncPayload;
    attempts?: number;
    delayMs?: number;
    syncDesktopOverlayPayload?: (payload: DesktopActivityOverlaySyncPayload) => Promise<void>;
    readDesktopOverlayWindowState?: () => Promise<DesktopActivityOverlayWindowStatePayload | null>;
    wait?: (ms: number) => Promise<void>;
}>): Promise<DesktopOverlayQaSeedVerificationResult> {
    const expectedCardKind = resolveExpectedQaSeedCardKind(mode);
    let observedCardKind: string | null = null;
    const boundedAttempts = Math.max(1, Math.floor(attempts));

    for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
        // Re-sync before every read because live runtime sync can race the first proof-state write.
        // The native pin then forces any interleaved unpinned live sync back to this payload.
        // eslint-disable-next-line no-await-in-loop
        await syncDesktopOverlayPayload(payload);
        // eslint-disable-next-line no-await-in-loop
        const state = await readDesktopOverlayWindowState().catch(() => null);
        observedCardKind = readOverlayWindowStatePrimaryCardKind(state);
        if (state?.expanded === payload.expanded && observedCardKind === expectedCardKind) {
            return {
                ok: true,
                expectedCardKind,
                observedCardKind,
                attempts: attempt,
            };
        }
        if (attempt < boundedAttempts) {
            // eslint-disable-next-line no-await-in-loop
            await waitFn(delayMs);
        }
    }

    return {
        ok: false,
        reason: 'seed-state-not-applied',
        expectedCardKind,
        observedCardKind,
        attempts: boundedAttempts,
    };
}

function stopDesktopOverlayQaSeedPinning(windowObj: object): void {
    const timer = desktopOverlayQaSeedPinTimers.get(windowObj);
    if (!timer) {
        return;
    }

    clearInterval(timer);
    desktopOverlayQaSeedPinTimers.delete(windowObj);
    clearDesktopActivityOverlayQaSyncOverride(windowObj);
}

function startDesktopOverlayQaSeedPinning(
    windowObj: object,
): void {
    stopDesktopOverlayQaSeedPinning(windowObj);

    const startedAt = Date.now();
    const timer = setInterval(() => {
        if (Date.now() - startedAt >= DESKTOP_OVERLAY_QA_SEED_PIN_DURATION_MS) {
            stopDesktopOverlayQaSeedPinning(windowObj);
            return;
        }

        const pinnedPayload = readDesktopActivityOverlayQaSyncOverride({ windowObj });
        if (!pinnedPayload) {
            stopDesktopOverlayQaSeedPinning(windowObj);
            return;
        }

        void syncDesktopActivityOverlay(pinnedPayload).catch(() => {
            stopDesktopOverlayQaSeedPinning(windowObj);
        });
    }, DESKTOP_OVERLAY_QA_SEED_PIN_INTERVAL_MS);
    desktopOverlayQaSeedPinTimers.set(windowObj, timer);
}

function xpathForText(text: string): string {
    if (!text.includes('\'')) {
        return `//*[contains(text(), '${text}')]`;
    }

    const parts = text.split('\'');
    const expr = `concat(${parts.map((part, index) => {
        if (index === 0) {
            return `'${part}'`;
        }
        return `,"'",'${part}'`;
    }).join('')})`;
    return `//*[contains(text(), ${expr})]`;
}

export function installTauriMcpWebviewDriverScripts(options?: Readonly<{
    windowObj?: McpWindowLike;
    documentObj?: Document;
    applyLocalSettings?: (delta: Partial<LocalSettings>) => void;
    ensureSessionVisible?: (sessionId: string, options?: Readonly<{ forceRefresh?: boolean }>) => Promise<boolean>;
    flushDesktopOverlaySync?: () => void | Promise<void>;
    syncDesktopOverlayPayload?: (payload: DesktopActivityOverlaySyncPayload) => Promise<void>;
    readDesktopOverlayWindowState?: () => Promise<DesktopActivityOverlayWindowStatePayload | null>;
    seedDesktopOverlayQaState?: (mode: string) => Promise<Record<string, unknown>>;
}>) {
    const windowObj = options?.windowObj ?? (typeof window !== 'undefined' ? (window as unknown as McpWindowLike) : null);
    const documentObj = options?.documentObj ?? (typeof document !== 'undefined' ? document : null);
    const applyLocalSettings = options?.applyLocalSettings ?? applyLocalSettingsFromDesktopMcpBridge;
    const syncDesktopOverlayPayload = options?.syncDesktopOverlayPayload ?? syncDesktopActivityOverlay;
    const readDesktopOverlayWindowState = options?.readDesktopOverlayWindowState ?? getDesktopActivityOverlayWindowState;
    const ensureSessionVisible = options?.ensureSessionVisible
        ?? (async (sessionId: string, helperOptions?: Readonly<{ forceRefresh?: boolean }>) => {
            return getSyncSingleton().ensureSessionVisibleForMessageRoute(sessionId, helperOptions);
        });
    const flushDesktopOverlaySync = options?.flushDesktopOverlaySync ?? (async () => {
        // This bridge runs in both the main and overlay windows. Only the main window is allowed to
        // call `desktop_activity_overlay_sync` (the Rust command validates the caller label).
        if (isDesktopActivityOverlayWindowContext()) {
            return;
        }

        const storageState = getStorage().getState();
        const localSettings = storageState.localSettings as unknown as Record<string, unknown>;

        const desktopPolicy = resolveDesktopOverlayPolicy(localSettings);
        const activityPolicy = resolveActivitySurfacePolicy(localSettings);
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                isDataReady: storageState.isDataReady,
                sessionsById: storageState.sessions ?? {},
                sessionListRenderablesById: storageState.sessionListRenderables ?? {},
                sessionListIndexByServerId: storageState.sessionListIndexByServerId ?? {},
                concurrentSessionListCacheByServerId: storageState.concurrentSessionListCacheByServerId ?? {},
                quotaSummaries: [],
            },
            activityPolicy,
            desktopPolicy,
        });
        const model = buildDesktopActivityOverlayModel({
            snapshot,
            policy: desktopPolicy,
            isExpanded: false,
        });

        await syncDesktopActivityOverlay({
            visible: model.visible,
            expanded: false,
            model,
            policy: desktopPolicy,
            window: model.window,
        });
    });
    const seedDesktopOverlayQaState = options?.seedDesktopOverlayQaState ?? (async (mode: string) => {
        if (isDesktopActivityOverlayWindowContext()) {
            return {
                ok: false,
                reason: 'overlay-window-context',
                mode,
            };
        }

        const storageState = getStorage().getState();
        const localSettings = storageState.localSettings as unknown as Record<string, unknown>;
        const desktopPolicy = resolveDesktopOverlayPolicy(localSettings);
        if (!desktopOverlayQaSeedModeSet.has(mode as typeof desktopActivityOverlayQaSeedModes[number])) {
            return {
                ok: false,
                reason: 'unsupported-mode',
                mode,
            };
        }
        const payload = buildDesktopActivityOverlayQaSyncPayload({
            mode,
            policy: desktopPolicy,
        });
        const pinnedModel = {
            ...payload.model,
            [DESKTOP_ACTIVITY_OVERLAY_QA_PROOF_PIN_UNTIL_MODEL_KEY]: Date.now() + DESKTOP_OVERLAY_QA_SEED_PIN_DURATION_MS,
        };
        const pinnedPayload: DesktopActivityOverlaySyncPayload = {
            ...payload,
            model: pinnedModel,
        };
        writeDesktopActivityOverlayQaSyncOverride({
            payload: pinnedPayload,
            ttlMs: DESKTOP_OVERLAY_QA_SEED_PIN_DURATION_MS,
            windowObj,
        });
        const verification = await waitForDesktopOverlayQaSeedState({
            mode,
            payload: pinnedPayload,
            syncDesktopOverlayPayload,
            readDesktopOverlayWindowState,
        });
        if (!verification.ok) {
            return {
                ok: false,
                mode,
                reason: verification.reason ?? 'seed-state-not-applied',
                expectedCardKind: verification.expectedCardKind,
                observedCardKind: verification.observedCardKind,
                attempts: verification.attempts,
            };
        }
        const firstCard = Array.isArray(payload.model?.expanded?.cards) ? payload.model.expanded.cards[0] : null;
        return {
            ok: true,
            mode,
            cardKind: firstCard?.kind ?? null,
            expanded: payload.expanded === true,
            seedStateAttempts: verification.attempts,
        };
    });
    if (!windowObj) {
        return;
    }

    windowObj.__MCP__ = windowObj.__MCP__ ?? {};
    const mcp = windowObj.__MCP__;
    if (!mcp || typeof mcp !== 'object') {
        return;
    }

    if (!documentObj) {
        return;
    }

    if (typeof mcp.resolveRef !== 'function') {
        mcp.resolveRef = ((selectorOrRef: string, strategy?: string) => {
            if (!selectorOrRef) {
                return null;
            }

            const refMatch = selectorOrRef.match(REF_PATTERN);
            if (refMatch) {
                const reverseRefs = mcp.reverseRefs;
                if (!(reverseRefs instanceof Map)) {
                    throw new Error('Ref IDs require a snapshot. Run webview_dom_snapshot first to index elements.');
                }
                return (reverseRefs.get(refMatch[1]) as Element | undefined) ?? null;
            }

            if (strategy === 'text') {
                const xpath = xpathForText(selectorOrRef);
                const result = documentObj.evaluate(xpath, documentObj, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue as Element | null;
            }

            if (strategy === 'xpath') {
                const result = documentObj.evaluate(selectorOrRef, documentObj, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue as Element | null;
            }

            return documentObj.querySelector(selectorOrRef);
        }) as unknown;
    }

    if (typeof mcp.resolveAll !== 'function') {
        mcp.resolveAll = ((selector: string, strategy?: string) => {
            if (!selector) {
                return [];
            }

            const refMatch = selector.match(REF_PATTERN);
            if (refMatch) {
                const resolved = (mcp.resolveRef as (selectorOrRef: string, strategy?: string) => Element | null)(selector);
                return resolved ? [resolved] : [];
            }

            if (strategy === 'text') {
                const xpath = xpathForText(selector);
                const snapshot = documentObj.evaluate(xpath, documentObj, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const results: Element[] = [];
                for (let index = 0; index < snapshot.snapshotLength; index += 1) {
                    const item = snapshot.snapshotItem(index);
                    if (item) {
                        results.push(item as Element);
                    }
                }
                return results;
            }

            if (strategy === 'xpath') {
                const snapshot = documentObj.evaluate(selector, documentObj, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const results: Element[] = [];
                for (let index = 0; index < snapshot.snapshotLength; index += 1) {
                    const item = snapshot.snapshotItem(index);
                    if (item) {
                        results.push(item as Element);
                    }
                }
                return results;
            }

            return Array.from(documentObj.querySelectorAll(selector));
        }) as unknown;
    }

    if (typeof mcp.countAll !== 'function') {
        mcp.countAll = ((selector: string, strategy?: string) => {
            const resolved = mcp.resolveAll as ((selector: string, strategy?: string) => readonly Element[]) | undefined;
            return resolved ? resolved(selector, strategy).length : 0;
        }) as unknown;
    }

    mcp.applyHappierLocalSettings = (async (delta: unknown) => {
        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
            return { ok: false, reason: 'invalid-delta' };
        }
        applyLocalSettings(delta as Partial<LocalSettings>);
        const keys = Object.keys(delta as Record<string, unknown>);
        const touchesDesktopOverlay = keys.some((key) => key.startsWith('desktopOverlay'));
        let overlaySyncOk = true;
        let overlaySyncError: string | null = null;
        if (touchesDesktopOverlay) {
            // Best-effort flush so the overlay window becomes available to QA automation even if the
            // desktop overlay runtime is not currently mounted (e.g. during onboarding/auth flows).
            try {
                await flushDesktopOverlaySync();
            } catch (error) {
                overlaySyncOk = false;
                overlaySyncError = String(error && typeof error === 'object' && 'message' in error ? (error as { message?: unknown }).message : error);
            }
        }
        return {
            ok: true,
            appliedKeys: keys,
            ...(touchesDesktopOverlay ? { overlaySyncOk, ...(overlaySyncError ? { overlaySyncError } : {}) } : {}),
        };
    }) as unknown;

    if (typeof mcp.ensureHappierSessionVisible !== 'function') {
        mcp.ensureHappierSessionVisible = (async (sessionId: unknown, helperOptions?: Readonly<{ forceRefresh?: boolean }>) => {
            const normalizedSessionId = String(sessionId ?? '').trim();
            if (!normalizedSessionId) {
                return { ok: false, reason: 'missing-session-id' };
            }
            const ok = await ensureSessionVisible(normalizedSessionId, {
                forceRefresh: helperOptions?.forceRefresh === true,
            });
            return {
                ok,
                sessionId: normalizedSessionId,
            };
        }) as unknown;
    }

    mcp.seedDesktopActivityOverlayQaState = (async (mode: unknown) => {
        const normalizedMode = String(mode ?? '').trim();
        if (!normalizedMode) {
            return { ok: false, reason: 'missing-mode' };
        }
        stopDesktopOverlayQaSeedPinning(windowObj);
        const result = await seedDesktopOverlayQaState(normalizedMode);
        if (result.ok === true) {
            startDesktopOverlayQaSeedPinning(windowObj);
        }
        return result;
    }) as unknown;

    mcp.clearDesktopActivityOverlayQaState = (() => {
        stopDesktopOverlayQaSeedPinning(windowObj);
        return { ok: true };
    }) as unknown;
}
