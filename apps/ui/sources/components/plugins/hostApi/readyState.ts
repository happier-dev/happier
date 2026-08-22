import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';

export type PluginUiHostReadyStateStatus = 'pending' | 'ready' | 'timedOut';

export type PluginUiHostReadyStateSnapshot = Readonly<{
    state: PluginUiHostReadyStateStatus;
    surface: PluginUiSurfaceContextV1;
    updatedAtMs: number;
    diagnostics: readonly string[];
}>;

export type PluginUiHostReadyRecordResult = 'recorded' | 'duplicate';

export type PluginUiHostReadyStateChange = Readonly<{
    state: 'ready' | 'timedOut';
    surface: PluginUiSurfaceContextV1;
    updatedAtMs: number;
    diagnostics: readonly string[];
}>;

export function pluginUiSurfaceContextsMatch(
    expected: PluginUiSurfaceContextV1,
    actual: Readonly<{
        pluginId: string;
        contributionId: string;
        surfaceId: string;
        sessionId?: string;
    }>,
): boolean {
    return expected.pluginId === actual.pluginId
        && expected.contributionId === actual.contributionId
        && expected.surfaceId === actual.surfaceId
        && expected.sessionId === actual.sessionId;
}

/**
 * One bound surface, one ready state. The hosted-web adapter creates this store
 * inside its own per-surface handler and can never bind a second surface to it,
 * so the state is a single scalar rather than a keyed collection.
 */
export function createPluginUiHostReadyStateStore(options: Readonly<{
    surface: PluginUiSurfaceContextV1;
    nowMs?: () => number;
}>) {
    const nowMs = options.nowMs ?? (() => Date.now());
    const surface = options.surface;
    let state: PluginUiHostReadyStateSnapshot | null = null;

    function read(): PluginUiHostReadyStateSnapshot {
        if (state) {
            return state;
        }
        state = Object.freeze({
            state: 'pending' as const,
            surface,
            updatedAtMs: nowMs(),
            diagnostics: [],
        });
        return state;
    }

    function recordReady(): Readonly<{
        result: PluginUiHostReadyRecordResult;
        snapshot: PluginUiHostReadyStateSnapshot;
    }> {
        const current = read();
        if (current.state === 'ready') {
            return Object.freeze({ result: 'duplicate' as const, snapshot: current });
        }
        state = Object.freeze({
            state: 'ready' as const,
            surface,
            updatedAtMs: nowMs(),
            diagnostics: [],
        });
        return Object.freeze({ result: 'recorded' as const, snapshot: state });
    }

    function recordTimeout(
        diagnostics: readonly string[] = ['ready_timeout'],
    ): PluginUiHostReadyStateSnapshot {
        const current = read();
        if (current.state === 'ready') {
            return current;
        }
        state = Object.freeze({
            state: 'timedOut' as const,
            surface,
            updatedAtMs: nowMs(),
            diagnostics: [...diagnostics],
        });
        return state;
    }

    function reset(): void {
        state = null;
    }

    return Object.freeze({
        read,
        recordReady,
        recordTimeout,
        reset,
    });
}
