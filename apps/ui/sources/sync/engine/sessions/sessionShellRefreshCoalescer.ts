/**
 * Per-session leading+trailing rate limiter for targeted session shell
 * refreshes.
 *
 * Used by the socket durable-message path when a hidden session receives a
 * message whose fan-out payload lacks `attentionImpact` (legacy servers only —
 * current servers always attach it, see the server-side
 * `serializeUpdateMessage` fallback). The first request per session triggers
 * immediately; further requests within `floorMs` collapse into one trailing
 * trigger at floor expiry, which guarantees convergence for messages that
 * arrive while a refresh is already underway.
 */
type SessionLeadingTrailingEntry<Payload> = {
    lastTriggeredAtMs: number;
    trailingTimer: ReturnType<typeof setTimeout> | null;
    latestPayload: Payload;
};

export type SessionLeadingTrailingCoalescer<Payload, TriggerResult = void> = Readonly<{
    request: (sessionId: string, payload: Payload) => TriggerResult | undefined;
    drop: (sessionId: string) => void;
    reset: () => void;
}>;

export function createSessionLeadingTrailingCoalescer<Payload, TriggerResult = void>(params: Readonly<{
    floorMs: number;
    trigger: (sessionId: string, payload: Payload) => TriggerResult;
}>): SessionLeadingTrailingCoalescer<Payload, TriggerResult> {
    const entries = new Map<string, SessionLeadingTrailingEntry<Payload>>();

    const triggerNow = (sessionId: string, entry: SessionLeadingTrailingEntry<Payload>): TriggerResult => {
        entry.lastTriggeredAtMs = Date.now();
        return params.trigger(sessionId, entry.latestPayload);
    };

    return {
        request: (sessionId: string, payload: Payload) => {
            const existing = entries.get(sessionId);
            if (!existing) {
                const entry: SessionLeadingTrailingEntry<Payload> = {
                    lastTriggeredAtMs: 0,
                    trailingTimer: null,
                    latestPayload: payload,
                };
                entries.set(sessionId, entry);
                return triggerNow(sessionId, entry);
            }

            existing.latestPayload = payload;
            const elapsedMs = Date.now() - existing.lastTriggeredAtMs;
            if (elapsedMs >= params.floorMs) {
                if (existing.trailingTimer) {
                    clearTimeout(existing.trailingTimer);
                    existing.trailingTimer = null;
                }
                return triggerNow(sessionId, existing);
            }

            if (existing.trailingTimer) return;
            existing.trailingTimer = setTimeout(() => {
                existing.trailingTimer = null;
                triggerNow(sessionId, existing);
            }, Math.max(0, params.floorMs - elapsedMs));
            return undefined;
        },
        drop: (sessionId: string) => {
            const entry = entries.get(sessionId);
            if (entry?.trailingTimer) clearTimeout(entry.trailingTimer);
            entries.delete(sessionId);
        },
        reset: () => {
            for (const entry of entries.values()) {
                if (entry.trailingTimer) clearTimeout(entry.trailingTimer);
            }
            entries.clear();
        },
    };
}

export type SessionShellRefreshCoalescer = Readonly<{
    request: (sessionId: string) => void;
    drop: (sessionId: string) => void;
    reset: () => void;
}>;

export function createSessionShellRefreshCoalescer(params: Readonly<{
    floorMs: number;
    trigger: (sessionId: string) => void;
}>): SessionShellRefreshCoalescer {
    const coalescer = createSessionLeadingTrailingCoalescer<undefined>({
        floorMs: params.floorMs,
        trigger: (sessionId) => params.trigger(sessionId),
    });
    return {
        request: (sessionId) => {
            coalescer.request(sessionId, undefined);
        },
        drop: coalescer.drop,
        reset: coalescer.reset,
    };
}
