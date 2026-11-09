import type { ExternalSessionTranscriptPageRequest, ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createReducer, reducer, projectSidechainMessages } from '@happier-dev/session-core/reducer';
import type { Message } from '@happier-dev/session-core/messages';
import { machineExternalSessionTranscriptPage } from '@/sync/ops/machineExternalSessions';
import { normalizeExternalSessionTranscriptMessages } from '@/sync/runtime/external/normalizeExternalSessionTranscriptMessages';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type ExternalSessionExchange = Readonly<{
    /** The prompt, when available, followed by only the selected message's display blocks. */
    messages: readonly Message[];
    /** Projected message identity, including when a tool-result hit updates a prior tool call. */
    matchedMessageId: string | null;
    elidedMessageCount: number;
}>;

/** Read a hit-centred preview through the incumbent paged reader; never publish the full turn. */
export async function readExternalSessionExchange(input: Readonly<{
    request: Omit<ExternalSessionTranscriptPageRequest, 'direction' | 'cursor'>;
    sourceItemId: string;
    accountLifetime: ServerAccountScopeLifetime;
    signal: AbortSignal;
}>): Promise<ExternalSessionExchange> {
    let cursor: string | undefined;
    let adjacent: readonly ExternalSessionTranscriptRawMessageV1[] = [];
    const visited = new Set<string>();
    const checkCurrent = () => {
        input.signal.throwIfAborted();
        if (!input.accountLifetime.isCurrent()) throw Object.assign(new Error('Account changed'), { name: 'AbortError' });
    };
    while (true) {
        checkCurrent();
        const page = await machineExternalSessionTranscriptPage({ ...input.request, sourceItemId: input.sourceItemId,
            direction: 'older', ...(cursor ? { cursor } : {}) }, {
            ...input.accountLifetime.scope, signal: input.signal,
        });
        checkCurrent();
        if (!page.ok) throw new Error(page.errorCode);
        const items = [...page.items, ...adjacent];
        const normalized = normalizeExternalSessionTranscriptMessages(items);
        const target = normalized.findIndex(message => message.id === input.sourceItemId);
        const isPrompt = (message: (typeof normalized)[number] | undefined) => message !== undefined
            && (message.role === 'user' || (message.role === 'agent' && message.content[0]?.type === 'sidechain'));
        const retainedIds = new Set<string>();
        if (target >= 0) {
            const scope = normalized[target]!.sidechainId;
            const isScopePrompt = (message: (typeof normalized)[number] | undefined) => message?.sidechainId === scope && isPrompt(message);
            let from = target;
            while (from > 0 && !isScopePrompt(normalized[from])) from--;
            const hasPrompt = isScopePrompt(normalized[from]);
            let to = target + 1;
            while (to < normalized.length && !isScopePrompt(normalized[to])) to++;
            if (hasPrompt || !page.hasMore) {
                const state = createReducer();
                const result = reducer(state, normalized.slice(from, to).filter(message => message.sidechainId === scope));
                const messages = scope ? [...projectSidechainMessages(state, scope)] : result.messages;
                const selected = normalized[target]!;
                const toolIds = selected.role === 'agent' ? new Set(selected.content.flatMap(content =>
                    content.type === 'tool-result' ? [content.tool_use_id] : content.type === 'tool-call' ? [content.id] : [])) : new Set<string>();
                const matched = messages.filter(message => message.realID === input.sourceItemId
                    || (message.kind === 'tool-call' && message.tool.id !== undefined && toolIds.has(message.tool.id)));
                const prompt = hasPrompt ? messages.find(message => message.realID === normalized[from]!.id) : undefined;
                const firstMatch = matched[0];
                return {
                    messages: [...(prompt && !matched.includes(prompt) ? [prompt] : []), ...matched],
                    matchedMessageId: firstMatch?.id ?? null,
                    elidedMessageCount: prompt && firstMatch ? Math.max(0, messages.indexOf(firstMatch) - messages.indexOf(prompt) - 1) : 0,
                };
            }
            // The prompt is across the page boundary. Keep this turn until its preceding page arrives.
            for (const message of normalized.slice(from, to)) {
                if (message.sidechainId === scope) retainedIds.add(message.id);
            }
        } else {
            // Only the leading answer tail in each scope can continue an older
            // selected exchange. A prompt closes that scope's newer turns.
            const closedScopes = new Set<string | undefined>();
            for (const message of normalized) {
                if (isPrompt(message)) closedScopes.add(message.sidechainId);
                if (!closedScopes.has(message.sidechainId)) retainedIds.add(message.id);
            }
        }
        const normalizedIds = new Set(normalized.map(message => message.id));
        let lastRetained = -1;
        for (let index = 0; index < items.length; index++) {
            if (retainedIds.has(items[index]!.id)) lastRetained = index;
        }
        // Nonvisible raw rows within the unresolved prefix can carry sequence
        // normalization context (for example a suppressed empty tool call).
        adjacent = items.filter((item, index) => index <= lastRetained
            && (retainedIds.has(item.id) || !normalizedIds.has(item.id)));
        if (!page.hasMore) return { messages: [], matchedMessageId: null, elidedMessageCount: 0 };
        if (!page.nextCursor || visited.has(page.nextCursor)) throw new Error('Transcript cursor did not advance');
        visited.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}
