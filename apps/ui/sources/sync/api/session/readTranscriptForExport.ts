import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { serializeTranscript, type TranscriptExportFormat } from './serializeTranscript';
import { runSessionMessagesPagePipeline, type SessionMessagesEncryption } from '@/sync/engine/sessions/sessionMessagesPagePipeline';
import { createReducer, projectSidechainMessages, reducer } from '@happier-dev/session-core/reducer';
import type { Message } from '@happier-dev/session-core/messages';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { log } from '@/log';

export type HostedTranscriptExport = Readonly<{
    sessionId: string;
    seqs?: readonly number[];
    format: TranscriptExportFormat;
    encryptionMode: 'plain' | 'e2ee';
    request: (path: string) => Promise<Response>;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    shouldContinue?: () => boolean;
    /** Off leaves every subagent transcript out: nested ones and standalone sidechains alike. */
    includeSubagents?: boolean;
}>;

function collectNestedMessageIds(message: Message, ids: Set<string>): void {
    if (message.kind !== 'tool-call') return;
    for (const child of message.children) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);
        collectNestedMessageIds(child, ids);
    }
}

export async function readTranscriptForExport(params: HostedTranscriptExport): Promise<string> {
    const pages: NormalizedMessage[][] = [];
    const sessionReceivedMessages = new Map<string, Map<string, number>>();
    let beforeSeq: number | undefined;
    for (;;) {
        if (params.shouldContinue?.() === false) throw new Error('Transcript export canceled');
        const pagePath = { sessionId: params.sessionId, scope: 'all' as const, beforeSeq };
        const result = await runSessionMessagesPagePipeline({
            sessionId: params.sessionId,
            sessionEncryptionMode: params.encryptionMode,
            page: { direction: 'older', ...pagePath, requestPath: buildSessionMessagesPath(pagePath) },
            purpose: 'older',
            lifecyclePolicy: 'suppress',
            getSessionEncryption: params.getSessionEncryption,
            sessionReceivedMessages,
            request: async (path) => {
                const response = await params.request(path);
                if (!response.ok) throw new Error(`Could not read transcript (HTTP ${response.status})`);
                return response;
            },
            shouldContinue: params.shouldContinue,
            applyMessages: (_sessionId, messages) => { pages.push(messages); },
            log,
        });
        if (result.skippedSuperseded || result.skippedMissingSession) throw new Error('Transcript export canceled');
        if (!result.page.hasMore) break;
        const next = result.page.nextBeforeSeq;
        if (typeof next !== 'number' || (beforeSeq !== undefined && next >= beforeSeq)) {
            throw new Error('Transcript paging did not advance');
        }
        beforeSeq = next;
    }
    const state = createReducer();
    const messages = reducer(state, pages.reverse().flat(), null, [], { mainHistoryStartLoaded: true }).messages;
    const includeSubagents = params.includeSubagents !== false;
    const sidechainMessages = includeSubagents
        ? Array.from(state.sidechains.keys()).flatMap(sidechainId => projectSidechainMessages(state, sidechainId))
        : [];
    if (params.seqs) {
        const wanted = new Set(params.seqs);
        const selected = new Map<string, Message>();
        const visit = (message: Message) => {
            if (message.seq !== undefined && wanted.has(message.seq)) selected.set(message.id, message);
            if (includeSubagents && message.kind === 'tool-call') message.children.forEach(visit);
        };
        [...messages, ...sidechainMessages].forEach(visit);
        return serializeTranscript([...selected.values()], params.format, { includeSubagents: false });
    }
    if (!includeSubagents) return serializeTranscript(messages, params.format, { includeSubagents: false });
    const nestedIds = new Set<string>();
    for (const message of messages) collectNestedMessageIds(message, nestedIds);
    for (const message of sidechainMessages) {
        if (!nestedIds.has(message.id)) collectNestedMessageIds(message, nestedIds);
    }
    return serializeTranscript([...messages, ...sidechainMessages.filter(message => !nestedIds.has(message.id))], params.format);
}
