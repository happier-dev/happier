import { createScmFileViewedOperations } from './fileViewed';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { isScmFileViewedCurrentHead } from '@/sync/domains/scm/fileViewed';

type Operations = ReturnType<typeof createScmFileViewedOperations>;
type Transport = Parameters<typeof createScmFileViewedOperations>[0];
type Consumer = Pick<Transport, 'execute'> & Readonly<{ isCurrent(): boolean }> & { active: boolean };
type Entry = { source: Operations; consumers: Set<Consumer>; readInterest: AbortController };

function currentConsumer(consumers: ReadonlySet<Consumer>) {
    for (const consumer of consumers) if (consumer.active && consumer.isCurrent()) return consumer;
    return undefined;
}

// Handles only: the path map and every subscription remain in createScmFileViewedState.
// Entries leave with their last mounted consumer; no retained Account/PR cache.
const sources = new Map<string, Entry>();

/** Core and native plugin mounts acquire the same Account/credential + PR source. */
export function acquireScmFileViewedSource(params: Pick<Transport, 'actions' | 'execute'> & Readonly<{
    scopeKey: string;
    isCurrent(): boolean;
    comparison?: Pick<ScmComparison, 'freshness' | 'endpoints'>;
}>) {
    const key = JSON.stringify([params.scopeKey, params.actions]);
    let entry = sources.get(key);
    if (!entry) {
        const consumers = new Set<Consumer>();
        const source = createScmFileViewedOperations({ actions: params.actions,
            shouldContinue: () => currentConsumer(consumers) !== undefined,
            execute: (invocation, signal) => {
                const consumer = currentConsumer(consumers);
                return consumer ? consumer.execute(invocation, signal) : Promise.reject(new Error('action_account_scope_changed'));
            },
        });
        entry = { source, consumers, readInterest: new AbortController() };
        sources.set(key, entry);
    }
    const owned = entry;
    const consumer: Consumer = { execute: params.execute, isCurrent: params.isCurrent, active: false };
    owned.consumers.add(consumer);
    let released = false;
    let wasPresented = false;
    return {
        source: owned.source,
        setActive(active: boolean) {
            if (released || consumer.active === active) return;
            const alreadyActive = currentConsumer(owned.consumers) !== undefined;
            consumer.active = active;
            if (active) {
                // Joining a presented PR consumes its existing map, including a held first read.
                const differentHead = params.comparison && !isScmFileViewedCurrentHead(params.comparison, owned.source.getSnapshot());
                if (wasPresented || !alreadyActive || differentHead) {
                    if (owned.readInterest.signal.aborted) owned.readInterest = new AbortController();
                    void owned.source.refresh(owned.readInterest.signal);
                }
                wasPresented = true;
            } else if (!currentConsumer(owned.consumers)) {
                owned.readInterest.abort();
            }
        },
        release() {
            if (released) return;
            released = true;
            owned.consumers.delete(consumer);
            if (!currentConsumer(owned.consumers)) owned.readInterest.abort();
            if (owned.consumers.size === 0) {
                owned.source.retire();
                sources.delete(key);
            }
        },
    };
}
