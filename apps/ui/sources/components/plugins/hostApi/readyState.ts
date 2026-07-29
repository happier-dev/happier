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

function createSurfaceKey(surface: PluginUiSurfaceContextV1): string {
    return [
        surface.pluginId,
        surface.contributionId,
        surface.surfaceId,
        surface.sessionId ?? '',
    ].join('\u001f');
}

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

export function createPluginUiHostReadyStateStore(options: Readonly<{
    nowMs?: () => number;
}> = {}) {
    const nowMs = options.nowMs ?? (() => Date.now());
    const states = new Map<string, PluginUiHostReadyStateSnapshot>();

    function read(surface: PluginUiSurfaceContextV1): PluginUiHostReadyStateSnapshot {
        const key = createSurfaceKey(surface);
        const existing = states.get(key);
        if (existing) {
            return existing;
        }
        const pending = Object.freeze({
            state: 'pending' as const,
            surface,
            updatedAtMs: nowMs(),
            diagnostics: [],
        });
        states.set(key, pending);
        return pending;
    }

    function recordReady(surface: PluginUiSurfaceContextV1): Readonly<{
        result: PluginUiHostReadyRecordResult;
        snapshot: PluginUiHostReadyStateSnapshot;
    }> {
        const current = read(surface);
        if (current.state === 'ready') {
            return Object.freeze({ result: 'duplicate' as const, snapshot: current });
        }
        const snapshot = Object.freeze({
            state: 'ready' as const,
            surface,
            updatedAtMs: nowMs(),
            diagnostics: [],
        });
        states.set(createSurfaceKey(surface), snapshot);
        return Object.freeze({ result: 'recorded' as const, snapshot });
    }

    function recordTimeout(
        surface: PluginUiSurfaceContextV1,
        diagnostics: readonly string[] = ['ready_timeout'],
    ): PluginUiHostReadyStateSnapshot {
        const current = read(surface);
        if (current.state === 'ready') {
            return current;
        }
        const snapshot = Object.freeze({
            state: 'timedOut' as const,
            surface,
            updatedAtMs: nowMs(),
            diagnostics: [...diagnostics],
        });
        states.set(createSurfaceKey(surface), snapshot);
        return snapshot;
    }

    function reset(surface: PluginUiSurfaceContextV1): void {
        states.delete(createSurfaceKey(surface));
    }

    return Object.freeze({
        read,
        recordReady,
        recordTimeout,
        reset,
    });
}
