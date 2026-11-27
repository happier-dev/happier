import { buildSessionMessagesPath } from './sessionMessagesApi';
import { serializeTranscript, type TranscriptExportFormat } from './serializeTranscript';
import { runSessionMessagesPagePipeline, type SessionMessagesEncryption } from '@/sync/engine/sessions/sessionMessagesPagePipeline';
import { createReducer, readReducerSidechainMessages, reducer } from '@/sync/reducer/reducer';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { log } from '@/log';

export type HostedTranscriptExport = Readonly<{
    sessionId: string;
    seqs?: readonly number[];
    loadedMessages?: readonly Message[];
    format: TranscriptExportFormat;
    encryptionMode: 'plain' | 'e2ee';
    request: (path: string) => Promise<Response>;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    shouldContinue?: () => boolean;
    onReadProgress?: (loaded: number, total: number | null) => void;
    onFormatting?: () => void | Promise<void>;
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

function selectBySequences(
    messages: readonly Message[],
    sequences: readonly number[],
    includeSubagents: boolean,
): Message[] | null {
    const wanted = new Set(sequences);
    const found = new Set<number>();
    const selected = new Map<string, Message>();
    const visit = (message: Message) => {
        if (message.seq !== undefined && wanted.has(message.seq)) {
            selected.set(message.id, message);
            found.add(message.seq);
        }
        if (includeSubagents && message.kind === 'tool-call') message.children.forEach(visit);
    };
    messages.forEach(visit);
    return found.size === wanted.size ? [...selected.values()] : null;
}

export async function readTranscriptForExport(params: HostedTranscriptExport): Promise<string> {
    if (params.shouldContinue?.() === false) throw new Error('Transcript export canceled');
    const includeSubagents = params.includeSubagents !== false;
    if (params.seqs && params.loadedMessages) {
        const selected = selectBySequences(params.loadedMessages, params.seqs, includeSubagents);
        if (selected) {
            if (params.onFormatting) await params.onFormatting();
            if (params.shouldContinue?.() === false) throw new Error('Transcript export canceled');
            return serializeTranscript(selected, params.format, { includeSubagents: false });
        }
    }

    const pages: NormalizedMessage[][] = [];
    const sessionReceivedMessages = new Map<string, Map<string, number>>();
    let beforeSeq: number | undefined;
    let loaded = 0;
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
        if (result.skippedSuperseded) throw new Error('Transcript export canceled');
        loaded += result.debugDecryptStats.toDecrypt;
        params.onReadProgress?.(loaded, result.page.hasMore ? null : loaded);
        if (!result.page.hasMore) break;
        const next = result.page.nextBeforeSeq;
        if (result.page.messages.length === 0 || typeof next !== 'number' || (beforeSeq !== undefined && next >= beforeSeq)) {
            throw new Error('Transcript paging did not advance');
        }
        beforeSeq = next;
    }
    if (params.onFormatting) await params.onFormatting();
    if (params.shouldContinue?.() === false) throw new Error('Transcript export canceled');
    const state = createReducer();
    const messages = reducer(state, pages.reverse().flat(), null, { mainHistoryStartLoaded: true }).messages;
    const sidechainMessages = includeSubagents
        ? Array.from(state.sidechains.keys()).flatMap(sidechainId => readReducerSidechainMessages(state, sidechainId))
        : [];
    if (params.seqs) {
        const selected = selectBySequences([...messages, ...sidechainMessages], params.seqs, includeSubagents);
        if (!selected) throw new Error('Selected transcript messages are unavailable');
        return serializeTranscript(selected, params.format, { includeSubagents: false });
    }
    if (!includeSubagents) return serializeTranscript(messages, params.format, { includeSubagents: false });
    const nestedIds = new Set<string>();
    for (const message of messages) collectNestedMessageIds(message, nestedIds);
    for (const message of sidechainMessages) {
        if (!nestedIds.has(message.id)) collectNestedMessageIds(message, nestedIds);
    }
    return serializeTranscript([...messages, ...sidechainMessages.filter(message => !nestedIds.has(message.id))], params.format);
}
