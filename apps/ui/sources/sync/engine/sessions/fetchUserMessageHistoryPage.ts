import type { SessionMessageRole } from '@happier-dev/protocol';

import { buildSessionMessagesPath } from '@/sync/api/session/sessionMessagesApi';
import type { NormalizedMessage } from '@/sync/typesRaw';

import {
    runSessionMessagesPagePipeline,
    type SessionMessagesEncryption,
    type SessionMessagesEncryptionMode,
} from './sessionMessagesPagePipeline';

export const USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE = 40;

/**
 * Roles requested for session history. `role=user` is sent alongside so a server that predates
 * the multi-role filter still answers with a narrower user-only page instead of erroring; the
 * returned rows are always classified here, so a server that ignores both params cannot corrupt
 * the result either.
 */
export const SESSION_MESSAGE_HISTORY_REMOTE_ROLES: readonly SessionMessageRole[] = ['user', 'agent'];
export const SESSION_MESSAGE_HISTORY_REMOTE_ROLES_QUERY = SESSION_MESSAGE_HISTORY_REMOTE_ROLES.join(',');

/**
 * Captured agent/tool text is a navigation subtitle source, never replayed as input, so it is
 * clamped at ingestion to keep long replies out of memory. User prompts are intentionally kept
 * verbatim: composer history restores them into the input.
 */
const AGENT_HISTORY_TEXT_CAPTURE_LIMIT = 512;

export type SessionMessageHistoryRemoteRole = 'user' | 'assistant' | 'tool';

/**
 * Rows are ordered newest-first (descending seq) and successive pages are strictly older, so
 * concatenating pages in fetch order stays globally newest-first. Composer history walks that
 * array positionally from the most recent prompt; navigation re-sorts by seq and is order-agnostic.
 */
export type SessionMessageHistoryRemoteRow = Readonly<{
    messageId: string;
    routeMessageId: string;
    seq: number;
    createdAt: number;
    role: SessionMessageHistoryRemoteRole;
    text: string;
}>;

export type FetchUserMessageHistoryPageResult =
    | Readonly<{ status: 'loaded'; rows: SessionMessageHistoryRemoteRow[]; hasMore: boolean; nextBeforeSeq: number | null }>
    | Readonly<{ status: 'not_ready' | 'unsupported' | 'error' }>;

// `runSessionMessagesPagePipeline` only logs when it skips an unknown session, which this caller
// never reports; history pages have no debug-log surface of their own.
const SILENT_HISTORY_PAGE_LOG = { log: () => undefined };

function normalizeHistoryPageLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE;
    return Math.min(100, Math.max(1, Math.trunc(value)));
}

function normalizeBeforeSeq(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(1, Math.trunc(value));
}

function normalizeFiniteInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function clampAgentHistoryText(value: string): string {
    return value.length <= AGENT_HISTORY_TEXT_CAPTURE_LIMIT
        ? value
        : value.slice(0, AGENT_HISTORY_TEXT_CAPTURE_LIMIT).trimEnd();
}

/**
 * Agent rows collapse to the last readable text block, falling back to the last tool call.
 * Thinking blocks are deliberately skipped: they never stand in for a reply preview.
 */
function readAgentHistoryText(
    content: Extract<NormalizedMessage, { role: 'agent' }>['content'],
): Readonly<{ role: SessionMessageHistoryRemoteRole; text: string }> | null {
    let agentText: string | null = null;
    let toolText: string | null = null;
    for (const block of content) {
        if (block.type === 'text') {
            const text = block.text.trim();
            if (text) agentText = text;
            continue;
        }
        if (block.type === 'tool-call') {
            const text = (block.description ?? block.name).trim();
            if (text) toolText = text;
        }
    }
    if (agentText) return { role: 'assistant', text: clampAgentHistoryText(agentText) };
    if (toolText) return { role: 'tool', text: clampAgentHistoryText(toolText) };
    return null;
}

function buildHistoryRow(message: NormalizedMessage): SessionMessageHistoryRemoteRow | null {
    const seq = normalizeFiniteInteger(message.seq);
    const createdAt = normalizeFiniteInteger(message.createdAt);
    if (seq === null || createdAt === null) return null;

    const identity = {
        messageId: message.id,
        routeMessageId: `server:${message.id}`,
        seq,
        createdAt,
    } as const;

    if (message.role === 'user') {
        const text = message.content.text.trim();
        return text ? { ...identity, role: 'user', text } : null;
    }
    if (message.role === 'agent') {
        const agentText = readAgentHistoryText(message.content);
        return agentText ? { ...identity, ...agentText } : null;
    }
    return null;
}

/**
 * The shared page pipeline hands `older` pages back ascending because the transcript renders them
 * that way. History rows are ordered here, once, instead of at each consumer.
 */
function compareHistoryRowsNewestFirst(a: SessionMessageHistoryRemoteRow, b: SessionMessageHistoryRemoteRow): number {
    if (a.seq !== b.seq) return b.seq - a.seq;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return b.messageId.localeCompare(a.messageId);
}

function classifyHistoryPageFailure(status: number | null): 'unsupported' | 'error' {
    if (status === null) return 'error';
    // Old servers reject the role/roles filter outright; a 2xx body this client cannot parse is
    // an equally unsupported response shape. Everything else is transient.
    if (status === 400 || status === 404 || status === 405 || status === 501) return 'unsupported';
    return status >= 200 && status < 300 ? 'unsupported' : 'error';
}

export async function fetchUserMessageHistoryPage(params: Readonly<{
    sessionId: string;
    beforeSeq?: number | null;
    limit?: number;
    sessionEncryptionMode?: SessionMessagesEncryptionMode;
    request: (path: string) => Promise<Response>;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
}>): Promise<FetchUserMessageHistoryPageResult> {
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) return { status: 'not_ready' };

    const sessionEncryptionMode = params.sessionEncryptionMode === 'plain' ? 'plain' : 'e2ee';
    if (sessionEncryptionMode === 'e2ee' && !params.getSessionEncryption(sessionId)) {
        return { status: 'not_ready' };
    }

    const limit = normalizeHistoryPageLimit(params.limit);
    const beforeSeq = normalizeBeforeSeq(params.beforeSeq);
    const requestPath = buildSessionMessagesPath({
        sessionId,
        scope: 'main',
        role: 'user',
        roles: SESSION_MESSAGE_HISTORY_REMOTE_ROLES,
        limit,
        ...(beforeSeq !== null ? { beforeSeq } : {}),
    });

    const transport: { lastResponseStatus: number | null } = { lastResponseStatus: null };
    try {
        const page = await runSessionMessagesPagePipeline({
            sessionId,
            purpose: 'older',
            page: {
                direction: 'older',
                requestPath,
                scope: 'main',
                limit,
                ...(beforeSeq !== null ? { beforeSeq } : {}),
            },
            // History pages are a read-only projection: they never touch the transcript store and
            // must not re-emit task lifecycle events already handled by the transcript pipeline.
            lifecyclePolicy: 'suppress',
            sessionEncryptionMode,
            getSessionEncryption: params.getSessionEncryption,
            request: async (path) => {
                const response = await params.request(path);
                transport.lastResponseStatus = typeof response?.status === 'number' ? response.status : null;
                return response;
            },
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: () => undefined,
            log: SILENT_HISTORY_PAGE_LOG,
        });

        const rows: SessionMessageHistoryRemoteRow[] = [];
        for (const message of page.normalizedMessages) {
            const row = buildHistoryRow(message);
            if (row) rows.push(row);
        }
        rows.sort(compareHistoryRowsNewestFirst);

        return {
            status: 'loaded',
            rows,
            hasMore: page.page.hasMore === true,
            nextBeforeSeq: typeof page.page.nextBeforeSeq === 'number' ? page.page.nextBeforeSeq : null,
        };
    } catch {
        return { status: classifyHistoryPageFailure(transport.lastResponseStatus) };
    }
}
