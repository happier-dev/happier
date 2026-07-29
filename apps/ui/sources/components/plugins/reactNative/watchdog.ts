export type PluginReactNativeWatchdogState = Readonly<{
    surfaceId: string;
    cacheKey: string;
    crashCount: number;
    startupFailureCount: number;
    disabled: boolean;
}>;

export type PluginReactNativeWatchdogTimeout = Readonly<{
    surfaceId: string;
    cacheKey: string;
    code: 'startup_ack_timeout';
    diagnostics: readonly string[];
}>;

export type PluginReactNativeWatchdog = Readonly<{
    start: (input: Readonly<{ surfaceId: string; cacheKey: string }>) => void;
    acknowledge: (input: Readonly<{ surfaceId: string }>) => void;
    cancel: (input: Readonly<{ surfaceId: string; cacheKey?: string }>) => void;
    collectExpired: () => readonly PluginReactNativeWatchdogTimeout[];
    recordRenderError: (input: Readonly<{ surfaceId: string; cacheKey: string }>) => PluginReactNativeWatchdogState & Readonly<{
        diagnostics: readonly string[];
    }>;
    readState: (surfaceId: string) => PluginReactNativeWatchdogState | null;
}>;

export type PluginReactNativeWatchdogPersistence = Readonly<{
    readSnapshot: () => unknown;
    writeSnapshot: (snapshot: PluginReactNativeWatchdogSnapshot) => void;
}>;

export type PluginReactNativeWatchdogSnapshot = Readonly<{
    v: 1;
    states: readonly PluginReactNativeWatchdogState[];
}>;

type MutableWatchdogState = {
    surfaceId: string;
    cacheKey: string;
    crashCount: number;
    startupFailureCount: number;
    disabled: boolean;
};

function freezeState(state: MutableWatchdogState): PluginReactNativeWatchdogState {
    return Object.freeze({ ...state });
}

export function createPluginReactNativeWatchdog(options: Readonly<{
    ackTimeoutMs: number;
    crashThreshold: number;
    nowMs: () => number;
    persistence?: PluginReactNativeWatchdogPersistence;
    maxPersistedStates?: number;
}>): PluginReactNativeWatchdog {
    const states = new Map<string, MutableWatchdogState>();
    const pendingStartup = new Map<string, { cacheKey: string; deadlineMs: number }>();
    const maxPersistedStates = Math.max(1, options.maxPersistedStates ?? 100);

    function restorePersistedSnapshot(): void {
        const snapshot = readPersistedSnapshot(options.persistence);
        if (!snapshot) {
            return;
        }
        for (const entry of snapshot.states.slice(-maxPersistedStates)) {
            states.set(entry.surfaceId, {
                surfaceId: entry.surfaceId,
                cacheKey: entry.cacheKey,
                crashCount: entry.crashCount,
                startupFailureCount: entry.startupFailureCount,
                disabled: entry.disabled,
            });
        }
    }

    function persistSnapshot(): void {
        if (!options.persistence) {
            return;
        }
        const snapshot = Object.freeze({
            v: 1 as const,
            states: Object.freeze([...states.values()]
                .slice(-maxPersistedStates)
                .map((state) => freezeState(state))),
        });
        try {
            options.persistence.writeSnapshot(snapshot);
        } catch {
            // Persistence must never make plugin UI crash containment fail open.
        }
    }

    function readOrCreate(surfaceId: string, cacheKey: string): MutableWatchdogState {
        const existing = states.get(surfaceId);
        if (existing) {
            if (existing.cacheKey !== cacheKey) {
                existing.cacheKey = cacheKey;
                existing.crashCount = 0;
                existing.startupFailureCount = 0;
                existing.disabled = false;
                persistSnapshot();
                return existing;
            }
            existing.cacheKey = cacheKey;
            return existing;
        }
        const created: MutableWatchdogState = {
            surfaceId,
            cacheKey,
            crashCount: 0,
            startupFailureCount: 0,
            disabled: false,
        };
        states.set(surfaceId, created);
        return created;
    }

    restorePersistedSnapshot();

    return Object.freeze({
        start: (input) => {
            readOrCreate(input.surfaceId, input.cacheKey);
            pendingStartup.set(input.surfaceId, {
                cacheKey: input.cacheKey,
                deadlineMs: options.nowMs() + options.ackTimeoutMs,
            });
        },
        acknowledge: (input) => {
            pendingStartup.delete(input.surfaceId);
            const state = states.get(input.surfaceId);
            if (state) {
                state.startupFailureCount = 0;
                state.disabled = false;
                persistSnapshot();
            }
        },
        cancel: (input) => {
            const pending = pendingStartup.get(input.surfaceId);
            if (!pending) {
                return;
            }
            if (input.cacheKey && pending.cacheKey !== input.cacheKey) {
                return;
            }
            pendingStartup.delete(input.surfaceId);
        },
        collectExpired: () => {
            const expired: PluginReactNativeWatchdogTimeout[] = [];
            const now = options.nowMs();
            for (const [surfaceId, pending] of pendingStartup.entries()) {
                if (pending.deadlineMs > now) {
                    continue;
                }
                pendingStartup.delete(surfaceId);
                const state = readOrCreate(surfaceId, pending.cacheKey);
                state.startupFailureCount += 1;
                if (state.startupFailureCount >= options.crashThreshold) {
                    state.disabled = true;
                }
                persistSnapshot();
                expired.push(Object.freeze({
                    surfaceId,
                    cacheKey: pending.cacheKey,
                    code: 'startup_ack_timeout',
                    diagnostics: Object.freeze(['startup_ack_timeout', 'js_thread_hard_hang_not_contained']),
                }));
            }
            return Object.freeze(expired);
        },
        recordRenderError: (input) => {
            const state = readOrCreate(input.surfaceId, input.cacheKey);
            state.crashCount += 1;
            if (state.crashCount >= options.crashThreshold) {
                state.disabled = true;
            }
            persistSnapshot();
            return Object.freeze({
                ...freezeState(state),
                diagnostics: Object.freeze(state.disabled ? ['crash_threshold_reached'] : []),
            });
        },
        readState: (surfaceId) => {
            const state = states.get(surfaceId);
            return state ? freezeState(state) : null;
        },
    });
}

function readPersistedSnapshot(
    persistence: PluginReactNativeWatchdogPersistence | undefined,
): PluginReactNativeWatchdogSnapshot | null {
    if (!persistence) {
        return null;
    }
    let snapshot: unknown;
    try {
        snapshot = persistence.readSnapshot();
    } catch {
        return null;
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return null;
    }
    const record = snapshot as Readonly<Record<string, unknown>>;
    if (record.v !== 1 || !Array.isArray(record.states)) {
        return null;
    }
    const states = record.states.flatMap((entry): PluginReactNativeWatchdogState[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return [];
        }
        const state = entry as Readonly<Record<string, unknown>>;
        const surfaceId = typeof state.surfaceId === 'string' ? state.surfaceId.trim() : '';
        const cacheKey = typeof state.cacheKey === 'string' ? state.cacheKey.trim() : '';
        const crashCount = typeof state.crashCount === 'number' && Number.isInteger(state.crashCount) && state.crashCount >= 0
            ? state.crashCount
            : null;
        const startupFailureCount = typeof state.startupFailureCount === 'number'
            && Number.isInteger(state.startupFailureCount)
            && state.startupFailureCount >= 0
            ? state.startupFailureCount
            : null;
        if (!surfaceId || !cacheKey || crashCount === null || startupFailureCount === null) {
            return [];
        }
        return [Object.freeze({
            surfaceId,
            cacheKey,
            crashCount,
            startupFailureCount,
            disabled: state.disabled === true,
        })];
    });

    return Object.freeze({
        v: 1,
        states: Object.freeze(states),
    });
}
