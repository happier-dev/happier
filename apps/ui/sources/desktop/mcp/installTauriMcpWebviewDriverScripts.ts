import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { applyLocalSettingsFromDesktopMcpBridge } from '@/sync/store/settingsWriters';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildDesktopActivityOverlaySnapshot } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { syncDesktopActivityOverlay } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
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
    };
};

const REF_PATTERN = /^\[?(?:ref=)?(e\d+)\]?$/;

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
}>) {
    const windowObj = options?.windowObj ?? (typeof window !== 'undefined' ? (window as unknown as McpWindowLike) : null);
    const documentObj = options?.documentObj ?? (typeof document !== 'undefined' ? document : null);
    const applyLocalSettings = options?.applyLocalSettings ?? applyLocalSettingsFromDesktopMcpBridge;
    const ensureSessionVisible = options?.ensureSessionVisible
        ?? ((sessionId: string, helperOptions?: Readonly<{ forceRefresh?: boolean }>) =>
            sync.ensureSessionVisibleForMessageRoute(sessionId, helperOptions));
    const flushDesktopOverlaySync = options?.flushDesktopOverlaySync ?? (async () => {
        // This bridge runs in both the main and overlay windows. Only the main window is allowed to
        // call `desktop_activity_overlay_sync` (the Rust command validates the caller label).
        if (isDesktopActivityOverlayWindowContext()) {
            return;
        }

        const storageState = getStorage().getState();
        const localSettings = storageState.localSettings as unknown as Record<string, unknown>;
        const sessions = (storageState.isDataReady
            ? Object.values(storageState.sessions ?? {}) as Session[]
            : []) satisfies Session[];
        sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

        const desktopPolicy = resolveDesktopOverlayPolicy(localSettings);
        const activityPolicy = resolveActivitySurfacePolicy(localSettings);
        const snapshot = buildDesktopActivityOverlaySnapshot({
            sessions,
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
}
