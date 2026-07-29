import {
    RuntimeEventV1Schema,
    type RuntimeEventKindV1,
    type RuntimeEventV1,
} from '@happier-dev/protocol/runtime';

import { createSubscription, type TestSubscription } from './subscription.js';

type RuntimeEventSubscriberV1 = Readonly<{
    subscribeRuntimeEvents(handler: (event: RuntimeEventV1) => void): () => void;
}>;

export type RuntimeEventValidationFailureV1 = Readonly<{
    event: unknown;
    issues: readonly string[];
}>;

export interface AdapterHarnessV1 {
    attachRuntime(runtime: RuntimeEventSubscriberV1): TestSubscription;
    recordRuntimeEvent(event: unknown): void;
    rawEvents(): readonly unknown[];
    canonical(): readonly RuntimeEventV1[];
    validationFailures(): readonly RuntimeEventValidationFailureV1[];
    until(kind: RuntimeEventKindV1, options?: Readonly<{ timeoutMs?: number }>): Promise<RuntimeEventV1>;
    expectAllEventsValidated(): void;
    expectExactlyOneTerminalEvent(options?: Readonly<{ turnId?: string | null }>): void;
    dispose(): void;
}

const DEFAULT_UNTIL_TIMEOUT_MS = 1000;
const TERMINAL_EVENT_KINDS = new Set<RuntimeEventKindV1>([
    'turn-complete',
    'turn-failed',
    'turn-cancelled',
]);

function formatValidationIssues(event: unknown, issues: readonly string[]): string {
    return [
        'RuntimeEventV1Schema rejected emitted canonical event.',
        `Event: ${JSON.stringify(event)}`,
        `Issues: ${issues.join('; ')}`,
    ].join(' ');
}

export function createAdapterHarness(): AdapterHarnessV1 {
    const rawEvents: unknown[] = [];
    const canonicalEvents: RuntimeEventV1[] = [];
    const validationFailures: RuntimeEventValidationFailureV1[] = [];
    const waiters = new Map<RuntimeEventKindV1, Set<(event: RuntimeEventV1) => void>>();
    const subscriptions = new Set<TestSubscription>();

    const resolveWaiters = (event: RuntimeEventV1): void => {
        const kindWaiters = waiters.get(event.kind);
        if (!kindWaiters) return;
        waiters.delete(event.kind);
        for (const resolveWaiter of kindWaiters) resolveWaiter(event);
    };

    return {
        attachRuntime(runtime) {
            const unsubscribe = runtime.subscribeRuntimeEvents((event) => {
                this.recordRuntimeEvent(event);
            });
            const subscription = createSubscription(() => {
                unsubscribe();
                subscriptions.delete(subscription);
            });
            subscriptions.add(subscription);
            return subscription;
        },
        recordRuntimeEvent(event) {
            rawEvents.push(event);
            const parsed = RuntimeEventV1Schema.safeParse(event);
            if (!parsed.success) {
                validationFailures.push({
                    event,
                    issues: parsed.error.issues.map((issue) => issue.message),
                });
                return;
            }
            canonicalEvents.push(parsed.data);
            resolveWaiters(parsed.data);
        },
        rawEvents() {
            return [...rawEvents];
        },
        canonical() {
            return canonicalEvents;
        },
        validationFailures() {
            return [...validationFailures];
        },
        until(kind, options = {}) {
            const existing = canonicalEvents.find((event) => event.kind === kind);
            if (existing) return Promise.resolve(existing);
            const timeoutMs = options.timeoutMs ?? DEFAULT_UNTIL_TIMEOUT_MS;
            return new Promise<RuntimeEventV1>((resolvePromise, reject) => {
                const timeout = setTimeout(() => {
                    const kindWaiters = waiters.get(kind);
                    kindWaiters?.delete(resolveWaiter);
                    if (kindWaiters?.size === 0) waiters.delete(kind);
                    reject(new Error(`Timed out waiting for runtime event kind "${kind}"`));
                }, timeoutMs);
                const resolveWaiter = (event: RuntimeEventV1): void => {
                    clearTimeout(timeout);
                    resolvePromise(event);
                };
                const kindWaiters = waiters.get(kind) ?? new Set<(event: RuntimeEventV1) => void>();
                kindWaiters.add(resolveWaiter);
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
                throw new Error(`Expected exactly one terminal runtime event, received ${terminalEvents.length}`);
            }
        },
        dispose() {
            for (const subscription of subscriptions) subscription.unsubscribe();
            subscriptions.clear();
            waiters.clear();
        },
    };
}
