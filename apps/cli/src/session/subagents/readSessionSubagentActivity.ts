import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { SESSION_SUBAGENTS_GET_ACTION_ID, SESSION_SUBAGENTS_LIST_ACTION_ID } from '@happier-dev/protocol/actions/actionIds';
import { SESSION_MESSAGES_PAGE_SIZE, type SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { resolveAgentActivityEntryAgentHandle } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityEntryId';
import { readSessionAgentActivityHeadlineFromMetadata } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { resolveSessionMessageRouteId, type Message } from '@happier-dev/session-core/messages';
import { normalizeRawMessages } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { deriveAgentActivityEntries, deriveSubAgentSidechainSubagents, resolveSessionSubagentActivityHandle, toLocalAgentActivityEntry } from '@happier-dev/session-core/transcript';

import type { StoredCredentials } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { resolveSessionTransportContext, type ResolveSessionTransportContextResult } from '@/session/services/resolveSessionTransportContext';
import { openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';

type SessionTransport = Extract<ResolveSessionTransportContextResult, { ok: true }>;
type ChildReadActionId = typeof SESSION_SUBAGENTS_LIST_ACTION_ID | typeof SESSION_SUBAGENTS_GET_ACTION_ID;

function refusal(code: string) {
    return { ok: false as const, errorCode: code, error: code };
}

function openMessages(rows: readonly SessionMessageV1[], transport: SessionTransport) {
    return normalizeRawMessages([...rows].sort((a, b) => a.seq - b.seq).map(row => ({
        ...row,
        raw: openSessionMessageContent(transport.mode === 'plain'
            ? { content: row.content, mode: 'plain', ctx: null }
            : { content: row.content, mode: 'e2ee', ctx: transport.ctx }),
    })));
}

export function createSessionSubagentActivityReads(params: Readonly<{
    credentials?: StoredCredentials;
    withHome: <T>(run: () => Promise<T>) => Promise<T>;
    isSameActionHomeId: (serverId: string) => boolean;
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
    readTransportSessionOwnerMetadata: (transport: SessionTransport) => unknown;
    resolveServerRequestHeaders: (context: ActionExecutorContext, actionId: ChildReadActionId,
        request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Required<Pick<ActionExecutorDeps, 'subagentsList' | 'subagentsGet'>> {
    async function read(
        sessionId: string, beforeSeq: number | undefined, context: ActionExecutorContext, actionId: ChildReadActionId,
    ) {
        const credentials = params.credentials;
        if (!credentials) return refusal('not_authenticated');
        if (context.serverId && !params.isSameActionHomeId(context.serverId)) return refusal('session_not_found');
        const resolveAuthorizationHeaders = (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            params.resolveServerRequestHeaders(context, actionId, request);
        const transport = await resolveSessionTransportContext({
            reason: 'session-action', credentials, idOrPrefix: sessionId, exact: true, usage: 'read', signal: context.signal,
            expectedSessionAddress: context.expectedSessionAddress,
            serverFeaturesSnapshot: await params.readServerFeaturesSnapshot(), resolveAuthorizationHeaders,
        });
        if (!transport.ok) return refusal(transport.code);
        const request = { token: credentials.token, sessionId, signal: context.signal, resolveAuthorizationHeaders,
            limit: SESSION_MESSAGES_PAGE_SIZE };
        const page = await fetchEncryptedTranscriptMessagesPage({ ...request, scope: 'main', beforeSeq });
        const state = createReducer();
        const { messages } = reducer(state, openMessages(page.messages, transport));
        const children = deriveSubAgentSidechainSubagents({ messages });
        const childById = new Map(children.map(child => [child.id, child]));
        const headline = readSessionAgentActivityHeadlineFromMetadata(params.readTransportSessionOwnerMetadata(transport));
        const { entries } = deriveAgentActivityEntries({ headline, local: children.map(subagent => toLocalAgentActivityEntry({ subagent })) });
        // The newest page can move between list and get. Keep this operand on the window that
        // actually witnessed the launch, using the existing exclusive transcript cursor.
        const newestSeq = Math.max(-1, ...page.messages.map(row => row.seq));
        const windowBeforeSeq = beforeSeq ?? (newestSeq >= 0 && newestSeq < Number.MAX_SAFE_INTEGER ? newestSeq + 1 : undefined);
        const rows = entries.flatMap(entry => {
            const child = entry.subagentId ? childById.get(entry.subagentId) : undefined;
            const toolId = child ? resolveSessionSubagentActivityHandle(child) : resolveAgentActivityEntryAgentHandle(entry.id);
            if (!toolId) return [];
            const { id, title, status, startedAtMs, endedAtMs, parentId } = entry;
            return [{
                row: { id, title, status, startedAtMs, endedAtMs, parentId, operand: {
                    sessionId, entryId: id, toolId,
                    ...(windowBeforeSeq !== undefined ? { beforeSeq: windowBeforeSeq } : {}),
                } },
                child,
            }];
        });
        return { ok: true as const, rows, page, request, state, messages, transport };
    }

    return {
        subagentsList: ({ parentSessionId, beforeSeq }, context) => params.withHome(async () => {
            const result = await read(parentSessionId, beforeSeq, context, SESSION_SUBAGENTS_LIST_ACTION_ID);
            return result.ok ? { rows: result.rows.map(({ row }) => row), nextBeforeSeq: result.page.nextBeforeSeq } : result;
        }),
        subagentsGet: (operand, context) => params.withHome(async () => {
            const result = await read(operand.sessionId, operand.beforeSeq, context, SESSION_SUBAGENTS_GET_ACTION_ID);
            if (!result.ok) return result;
            const match = result.rows.find(({ row }) => row.operand.toolId === operand.toolId && row.id === operand.entryId);
            if (!match) return null;
            const { row, child } = match;
            if (!child?.transcript.toolMessageRouteId) return { ...row, detail: null };
            const { toolMessageRouteId: routeMessageId, sidechainId } = child.transcript;

            const messagesById = Object.fromEntries(result.messages.map(message => [message.id, message]));
            const messageId = resolveSessionMessageRouteId({ routeMessageId, messagesById, reducerState: result.state });
            const message = messageId ? messagesById[messageId] : null;
            if (message?.kind !== 'tool-call') return { ...row, detail: null };

            const detailPage = sidechainId ? await fetchEncryptedTranscriptMessagesPage({
                ...result.request, scope: 'sidechain', sidechainId,
            }) : null;
            const updated = detailPage ? reducer(result.state, openMessages(detailPage.messages, result.transport)).messages
                .find(candidate => candidate.id === message.id) : null;
            const detail = updated?.kind === 'tool-call' ? updated : message;
            const { name, input, result: output } = detail.tool;
            return { ...row, detail: {
                sidechainId,
                tool: { name, input: input ?? null, ...(output === undefined ? {} : { result: output }) },
                messages: detail.children.map(projectChildMessage),
                nextBeforeSeq: detailPage?.nextBeforeSeq ?? null,
            } };
        }),
    };
}

function projectChildMessage(message: Message): unknown {
    if (message.kind === 'tool-call') {
        const { name, input, result } = message.tool;
        return { kind: message.kind, name, input: input ?? null, ...(result === undefined ? {} : { result }),
            children: message.children.map(projectChildMessage) };
    }
    if ('text' in message) return { kind: message.kind, text: message.text };
    return { kind: message.kind };
}
