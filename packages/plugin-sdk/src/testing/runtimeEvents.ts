import {
    AgentSessionRuntimeEventSchema,
    type AgentSessionRuntimeEvent,
} from '../agentRuntime/projections.js';

import type { Disposable } from '../lifecycle.js';

export type AgentSessionRuntimeEventKind = AgentSessionRuntimeEvent['kind'];

export type AgentSessionRuntimeEventSubscriber = Readonly<{
    subscribeRuntimeEvents(
        listener: (event: AgentSessionRuntimeEvent) => void,
    ): Disposable;
}>;

export type AgentSessionRuntimeEventValidationFailure = Readonly<{
    event: unknown;
    issues: readonly string[];
}>;

export interface AgentSessionRuntimeHarness extends Disposable {
    attachRuntime(runtime: AgentSessionRuntimeEventSubscriber): Disposable;
    recordRuntimeEvent(event: unknown): void;
    rawEvents(): readonly unknown[];
    canonicalEvents(): readonly AgentSessionRuntimeEvent[];
    validationFailures(): readonly AgentSessionRuntimeEventValidationFailure[];
    until(
        kind: AgentSessionRuntimeEventKind,
        options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>,
    ): Promise<AgentSessionRuntimeEvent>;
    expectAllEventsValidated(): void;
    expectExactlyOneTerminalEvent(options?: Readonly<{ turnId?: string | null }>): void;
    dispose(): void;
}

type EventWaiter = Readonly<{
    resolve(event: AgentSessionRuntimeEvent): void;
    reject(error: unknown): void;
    cleanup(): void;
}>;

const DEFAULT_UNTIL_TIMEOUT_MS = 1000;
const TERMINAL_EVENT_KINDS = new Set<AgentSessionRuntimeEventKind>([
    'turn-complete',
    'turn-failed',
    'turn-cancelled',
]);

function formatValidationIssues(
    event: unknown,
    issues: readonly string[],
): string {
    let eventDescription: string;
    try {
        eventDescription = JSON.stringify(event) ?? String(event);
    } catch {
        eventDescription = '[not JSON-serializable]';
    }
    return [
        'AgentSessionRuntimeEventSchema rejected emitted canonical event.',
        `Event: ${eventDescription}`,
        `Issues: ${issues.join('; ')}`,
    ].join(' ');
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error('Agent Session runtime event wait was cancelled');
}

export function createAgentSessionRuntimeHarness(): AgentSessionRuntimeHarness {
    const rawEvents: unknown[] = [];
    const canonicalEvents: AgentSessionRuntimeEvent[] = [];
    const validationFailures: AgentSessionRuntimeEventValidationFailure[] = [];
    const waiters = new Map<AgentSessionRuntimeEventKind, Set<EventWaiter>>();
    const subscriptions = new Set<Disposable>();
    let disposed = false;

    const removeWaiter = (
        kind: AgentSessionRuntimeEventKind,
        waiter: EventWaiter,
    ): void => {
        const kindWaiters = waiters.get(kind);
        kindWaiters?.delete(waiter);
        if (kindWaiters?.size === 0) waiters.delete(kind);
    };

    const resolveWaiters = (event: AgentSessionRuntimeEvent): void => {
        const kindWaiters = waiters.get(event.kind);
        if (!kindWaiters) return;
        waiters.delete(event.kind);
        for (const waiter of kindWaiters) {
            waiter.cleanup();
            waiter.resolve(event);
        }
    };

    const harness: AgentSessionRuntimeHarness = {
        attachRuntime(runtime) {
            if (disposed) throw new Error('Agent Session runtime harness is disposed');
            const runtimeSubscription = runtime.subscribeRuntimeEvents((event) => {
                harness.recordRuntimeEvent(event);
            });
            let subscriptionDisposed = false;
            const subscription: Disposable = Object.freeze({
                dispose() {
                    if (subscriptionDisposed) return;
                    subscriptionDisposed = true;
                    subscriptions.delete(subscription);
                    return runtimeSubscription.dispose();
                },
            });
            subscriptions.add(subscription);
            return subscription;
        },
        recordRuntimeEvent(event) {
            if (disposed) throw new Error('Agent Session runtime harness is disposed');
            rawEvents.push(event);
            const parsed = AgentSessionRuntimeEventSchema.safeParse(event);
            if (!parsed.success) {
                validationFailures.push(Object.freeze({
                    event,
                    issues: Object.freeze(parsed.error.issues.map((issue) => issue.message)),
                }));
                return;
            }
            canonicalEvents.push(parsed.data);
            resolveWaiters(parsed.data);
        },
        rawEvents() {
            return Object.freeze([...rawEvents]);
        },
        canonicalEvents() {
            return Object.freeze([...canonicalEvents]);
        },
        validationFailures() {
            return Object.freeze([...validationFailures]);
        },
        until(kind, options = {}) {
            if (disposed) {
                return Promise.reject(new Error('Agent Session runtime harness is disposed'));
            }
            const existing = canonicalEvents.find((event) => event.kind === kind);
            if (existing) return Promise.resolve(existing);
            if (options.signal?.aborted) {
                return Promise.reject(abortReason(options.signal));
            }

            const timeoutMs = options.timeoutMs ?? DEFAULT_UNTIL_TIMEOUT_MS;
            return new Promise<AgentSessionRuntimeEvent>((resolve, reject) => {
                let timeout: ReturnType<typeof setTimeout> | undefined;
                let settled = false;
                const cleanup = (): void => {
                    if (timeout !== undefined) clearTimeout(timeout);
                    options.signal?.removeEventListener('abort', onAbort);
                };
                const waiter: EventWaiter = {
                    resolve(event) {
                        if (settled) return;
                        settled = true;
                        resolve(event);
                    },
                    reject(error) {
                        if (settled) return;
                        settled = true;
                        reject(error);
                    },
                    cleanup,
                };
                const settleReject = (error: unknown): void => {
                    if (settled) return;
                    removeWaiter(kind, waiter);
                    cleanup();
                    waiter.reject(error);
                };
                const onAbort = (): void => {
                    settleReject(abortReason(options.signal!));
                };

                timeout = setTimeout(() => {
                    settleReject(new Error(`Timed out waiting for Agent Session runtime event kind "${kind}"`));
                }, timeoutMs);
                options.signal?.addEventListener('abort', onAbort, { once: true });
                const kindWaiters = waiters.get(kind) ?? new Set<EventWaiter>();
                kindWaiters.add(waiter);
                waiters.set(kind, kindWaiters);
            });
        },
        expectAllEventsValidated() {
            if (validationFailures.length === 0) return;
            const [firstFailure] = validationFailures;
            throw new Error(formatValidationIssues(firstFailure.event, firstFailure.issues));
        },
        expectExactlyOneTerminalEvent(options = {}) {
            const terminalEvents = canonicalEvents.filter((event) => {
                if (!TERMINAL_EVENT_KINDS.has(event.kind)) return false;
                if (!options.turnId) return true;
                return 'turnId' in event && event.turnId === options.turnId;
            });
            if (terminalEvents.length !== 1) {
                throw new Error(`Expected exactly one terminal Agent Session runtime event, received ${terminalEvents.length}`);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const subscription of [...subscriptions]) {
                void subscription.dispose();
            }
            subscriptions.clear();
            for (const kindWaiters of waiters.values()) {
                for (const waiter of kindWaiters) {
                    waiter.cleanup();
                    waiter.reject(new Error('Agent Session runtime harness was disposed'));
                }
            }
            waiters.clear();
        },
    };

    return Object.freeze(harness);
}
