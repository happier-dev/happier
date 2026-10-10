import type { ExternalSessionTranscriptPageRequest, ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createReducer, reducer, projectSidechainMessages } from '@happier-dev/session-core/reducer';
import type { Message } from '@happier-dev/session-core/messages';
import { machineExternalSessionTranscriptPage } from '@/sync/ops/machineExternalSessions';
import { normalizeExternalSessionTranscriptMessages } from '@/sync/runtime/external/normalizeExternalSessionTranscriptMessages';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Read just the selected turn through the incumbent paged reader; no import or index is needed. */
export async function readExternalSessionExchange(input: Readonly<{
    request: Omit<ExternalSessionTranscriptPageRequest, 'direction' | 'cursor'>;
    sourceItemId: string;
    accountLifetime: ServerAccountScopeLifetime;
    signal: AbortSignal;
}>): Promise<readonly Message[]> {
    let cursor: string | undefined;
    let adjacent: readonly ExternalSessionTranscriptRawMessageV1[] = [];
    const visited = new Set<string>();
    const checkCurrent = () => {
        input.signal.throwIfAborted();
        if (!input.accountLifetime.isCurrent()) throw Object.assign(new Error('Account changed'), { name: 'AbortError' });
    };
    while (true) {
        checkCurrent();
        const page = await machineExternalSessionTranscriptPage({ ...input.request, direction: 'older', ...(cursor ? { cursor } : {}) }, {
            ...input.accountLifetime.scope, signal: input.signal,
        });
        checkCurrent();
        if (!page.ok) throw new Error(page.errorCode);
        const items = [...page.items, ...adjacent];
        const normalized = normalizeExternalSessionTranscriptMessages(items);
        const target = normalized.findIndex(message => message.id === input.sourceItemId);
        if (target >= 0) {
            const scope = normalized[target]!.sidechainId;
            const isPrompt = (message: (typeof normalized)[number] | undefined) => message !== undefined && message.sidechainId === scope
                && (message.role === 'user' || (message.role === 'agent' && message.content[0]?.type === 'sidechain'));
            let from = target;
            while (from > 0 && !isPrompt(normalized[from])) from--;
            const hasPrompt = isPrompt(normalized[from]);
            if (hasPrompt || !page.hasMore) {
                let to = target + 1;
                while (to < normalized.length && !isPrompt(normalized[to])) to++;
                const state = createReducer();
                const result = reducer(state, normalized.slice(from, to).filter(message => message.sidechainId === scope));
                return scope ? [...projectSidechainMessages(state, scope)] : result.messages;
            }
            // The prompt is across the page boundary. Keep this turn until its preceding page arrives.
            adjacent = items;
        } else {
            // A selected answer can precede several answer-only pages. Keep the
            // newer suffix until its prompt is found; the turn boundary above
            // excludes following prompts and their answers from the result.
            adjacent = items;
        }
        if (!page.hasMore) return [];
        if (!page.nextCursor || visited.has(page.nextCursor)) throw new Error('Transcript cursor did not advance');
        visited.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}
