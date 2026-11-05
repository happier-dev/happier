import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { applyLocalSettingsFromDesktopMcpBridge } from '@/sync/store/settingsWriters';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import {
    hasDesktopActivityOverlayQaFixtureProducer,
    selectDesktopActivityOverlayQaFixture,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtureSelection';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { getDefaultSystemTaskRunner, waitForSystemTaskResult } from '@/components/systemTasks';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { runRelayRuntimeUninstallTask } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import {
    controlPersonalHomeBootstrapQaMutationPause,
    type PersonalHomeBootstrapQaPauseRequest,
} from '@/components/personalHome/bootstrap/personalHomeBootstrapQaMutationPause';

type McpWindowLike = typeof globalThis & {
    __happierPersonalHomeQaForbiddenSurface?: {
        state?: {
            documentStart?: unknown;
            seen?: unknown;
        };
    };
    __MCP__?: {
        resolveRef?: unknown;
        resolveAll?: unknown;
        countAll?: unknown;
        reverseRefs?: unknown;
        applyHappierLocalSettings?: unknown;
        ensureHappierSessionVisible?: unknown;
        seedDesktopActivityOverlayQaState?: unknown;
        clearDesktopActivityOverlayQaState?: unknown;
        readPersonalHomeBootstrapQaObservation?: unknown;
        navigateHappierQaPath?: unknown;
        readPersonalHomeDaemonQaStatus?: unknown;
        stopPersonalHomeDaemonForQa?: unknown;
        controlPersonalHomeBootstrapQaPause?: unknown;
        uninstallPersonalHomeRuntimeForQa?: unknown;
    };
};

const REF_PATTERN = /^\[?(?:ref=)?(e\d+)\]?$/;
function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
    seedDesktopOverlayQaState?: (mode: string) => Promise<Record<string, unknown>>;
    runPersonalHomeDaemonQaTask?: (action: 'status' | 'stop') => Promise<unknown>;
    uninstallPersonalHomeRuntimeQaTask?: () => Promise<boolean>;
}>) {
    const windowObj = options?.windowObj ?? (typeof window !== 'undefined' ? (window as unknown as McpWindowLike) : null);
    const documentObj = options?.documentObj ?? (typeof document !== 'undefined' ? document : null);
    const applyLocalSettings = options?.applyLocalSettings ?? applyLocalSettingsFromDesktopMcpBridge;
    const ensureSessionVisible = options?.ensureSessionVisible
        ?? (async (sessionId: string, helperOptions?: Readonly<{ forceRefresh?: boolean }>) => {
            return getSyncSingleton().ensureSessionVisibleForMessageRoute(sessionId, helperOptions);
        });
    const runPersonalHomeDaemonQaTask = options?.runPersonalHomeDaemonQaTask ?? (async (action: 'status' | 'stop') => {
        const runner = getDefaultSystemTaskRunner();
        const kind = action === 'status' ? 'daemon.service.status.v1' : 'daemon.service.stop.v1';
        const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind));
        return await waitForSystemTaskResult(runner, taskId);
    });
    // The canonical Settings uninstall helper, invoked verbatim. Loaded QA needs it while the
    // bootstrap gate owns the window, where the Settings surface is unreachable by design.
    const uninstallPersonalHomeRuntimeQaTask = options?.uninstallPersonalHomeRuntimeQaTask
        ?? (async () => await runRelayRuntimeUninstallTask(getDefaultSystemTaskRunner()));
    const setNotchState = async (state: 'rest' | 'pinned') => {
        const result = await createDefaultActionExecutor().execute(
            'desktop.notch.set', { state },
            { surface: 'mcp', authority: 'present_user', actionCaller: { kind: 'host' } },
        );
        if (!result.ok) throw new Error(result.errorCode ?? result.error);
    };
    const flushDesktopOverlaySync = options?.flushDesktopOverlaySync ?? (async () => {
        if (isDesktopActivityOverlayWindowContext()) return;
        if (!hasDesktopActivityOverlayQaFixtureProducer()) throw new Error('producer-unavailable');
        await setNotchState('rest');
    });
    const seedDesktopOverlayQaState = options?.seedDesktopOverlayQaState ?? (async (mode: string) => {
        if (isDesktopActivityOverlayWindowContext()) return { ok: false, reason: 'overlay-window-context', mode };
        const { desktopActivityOverlayQaSeedModes } = await import('@/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtures.mjs');
        const seedMode = desktopActivityOverlayQaSeedModes.find(candidate => candidate === mode);
        if (!seedMode) return { ok: false, reason: 'unsupported-mode', mode };
        if (!hasDesktopActivityOverlayQaFixtureProducer()) return { ok: false, reason: 'producer-unavailable', mode };
        await selectDesktopActivityOverlayQaFixture(seedMode);
        await setNotchState('pinned');
        return { ok: true, mode, state: 'pinned' };
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

    mcp.readPersonalHomeBootstrapQaObservation = (() => {
        const state = windowObj.__happierPersonalHomeQaForbiddenSurface?.state;
        return {
            installedAtDocumentStart: state?.documentStart === true,
            seenForbiddenOnboarding: state?.seen === true,
        };
    }) as unknown;
    mcp.navigateHappierQaPath = ((path: unknown) => {
        const normalizedPath = String(path ?? '').trim();
        if (!normalizedPath.startsWith('/') || normalizedPath.startsWith('//')) {
            return { ok: false, reason: 'invalid-path' };
        }
        windowObj.history.pushState({}, '', normalizedPath);
        windowObj.dispatchEvent(new windowObj.PopStateEvent('popstate'));
        return { ok: true, pathname: normalizedPath };
    }) as unknown;
    mcp.readPersonalHomeDaemonQaStatus = (async () => await runPersonalHomeDaemonQaTask('status')) as unknown;
    mcp.stopPersonalHomeDaemonForQa = (async () => await runPersonalHomeDaemonQaTask('stop')) as unknown;
    mcp.controlPersonalHomeBootstrapQaPause = ((request: unknown) => {
        const action = isRecord(request) ? readString(request.action) : null;
        if (action !== 'arm' && action !== 'read' && action !== 'release') {
            return { ok: false, reason: 'invalid-action' };
        }
        const record = isRecord(request) ? request : {};
        return controlPersonalHomeBootstrapQaMutationPause({
            action,
            ...(readString(record.kind) ? { kind: readString(record.kind)! } : {}),
            ...(typeof record.ordinal === 'number' ? { ordinal: record.ordinal } : {}),
            ...(typeof record.ttlMs === 'number' ? { ttlMs: record.ttlMs } : {}),
        } satisfies PersonalHomeBootstrapQaPauseRequest);
    }) as unknown;
    mcp.uninstallPersonalHomeRuntimeForQa = (async () => {
        // This bridge installs in every desktop shell, so the destructive-arbitration boundary
        // stays inert until the checked-in bootstrap pause is armed. The QA journey always holds
        // that pause when it competes with bootstrap; Settings remains the product owner.
        const pause = controlPersonalHomeBootstrapQaMutationPause({ action: 'read' });
        if (!pause.armed && !pause.held) return { ok: false, reason: 'qa-pause-not-armed' };
        try {
            return { ok: await uninstallPersonalHomeRuntimeQaTask() === true };
        } catch (error) {
            return {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }) as unknown;

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
            // Settings publish through the mounted canonical producer; this only resets presentation.
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
        return await seedDesktopOverlayQaState(normalizedMode);
    }) as unknown;

    mcp.clearDesktopActivityOverlayQaState = (async () => {
        selectDesktopActivityOverlayQaFixture(null);
        await setNotchState('rest');
        return { ok: true };
    }) as unknown;
}
