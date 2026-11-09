import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionStateEvidenceSchema,
    type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { projectSessionUsageWorkEvidence, projectUsageSessionStateEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { ServedHomeRequest } from './actionHomesHttpHarness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { V2SessionListRowSchema, V2SessionRecordSchema, type V2SessionRecord, type V2SessionListRow } from '@happier-dev/protocol/sessions/control/contract';
import { parsePlainSessionMetadata, parsePlainSessionAgentStateResult } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';

/** Full external source facts, retained until the HTTP boundary projects the list wire. */
export function createSessionListSourceFixture<T extends Readonly<{ sessions: readonly V2SessionRecord[] }>>(page: T): Omit<T, 'sessions'> & { sessions: V2SessionRecord[] } {
    return { ...page, sessions: page.sessions.map(row => V2SessionRecordSchema.parse(row)) };
}

/** Project external full-document fixtures into the current list wire. */
export function createCompactSessionListRowFixture(record: V2SessionRecord): V2SessionListRow {
    return V2SessionListRowSchema.parse(compactSessionListRow(record));
}

function compactSessionListRow(record: V2SessionRecord) {
    const { metadata: _metadata, ownerMetadata: _ownerMetadata, agentState: _agentState, ...facts } = record;
    const shared = facts.effectiveAccess !== undefined && facts.effectiveAccess.level !== 'owner';
    return { ...facts, documents: 'omitted',
        metadataLayoutVersion: facts.metadataLayoutVersion ?? 0,
        metadataAudience: shared ? 'shared' : 'owner', agentStateDocument: shared ? 'redacted' : 'omitted',
        agentStateVersion: facts.agentStateVersion ?? 0 };
}

/**
 * Only HTTP fixtures retain full source documents. The consumer sees compact
 * lists and obtains demanded documents through the real read-batch parser.
 * Return undefined for unhandled routes; explicit batch responses are preserved.
 */
export function createCompactSessionListFetchBoundary(
    request: (path: string, init: RequestInit) => Promise<Response | undefined>,
    options?: Readonly<{ preferExactSnapshot?: boolean }>,
): RuntimeFetch;
export function createCompactSessionListFetchBoundary(
    request: (path: string, init: RequestInit) => Promise<Response | null | undefined>,
    options?: Readonly<{ preferExactSnapshot?: boolean }>,
): (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;
export function createCompactSessionListFetchBoundary(
    request: (path: string, init: RequestInit) => Promise<Response | null | undefined>,
    options: Readonly<{ preferExactSnapshot?: boolean }> = {},
): (...args: Parameters<RuntimeFetch>) => Promise<Response | null> {
    const sources = new Map<string, Map<string, V2SessionRecord>>();
    const scope = (path: string, init: RequestInit) => `${new URL(path, 'https://session-fixture.test').origin}:${new Headers(init.headers).get('authorization') ?? ''}`;
    return async (input, requestInit) => {
        const path = input instanceof Request ? input.url : String(input);
        const init: RequestInit = input instanceof Request
            ? { method: input.method, headers: input.headers, signal: input.signal,
                ...(input.body ? { body: await input.clone().text() } : {}), ...requestInit }
            : requestInit ?? {};
        const url = new URL(path, 'https://session-fixture.test');
        if (url.pathname === '/v2/sessions/read-batch' && init.method === 'POST') {
            const explicit = await request(path, init);
            if (explicit) return explicit;
            const batch = createSessionReadBatchFetchBoundary(async (input, componentInit) => {
                const componentUrl = new URL(String(input));
                const match = /^\/v2\/sessions\/([^/]+)$/.exec(componentUrl.pathname);
                const source = match ? sources.get(scope(path, init))?.get(decodeURIComponent(match[1]!)) : undefined;
                if (source && !options.preferExactSnapshot) return Response.json({ session: source });
                const response = await request(path.startsWith('/') ? `${componentUrl.pathname}${componentUrl.search}` : componentUrl.href, componentInit ?? {});
                if (response) return response;
                return source ? Response.json({ session: source }) : undefined;
            });
            const response = await batch(url.href, init);
            if (!response) throw new Error('[testkit] Missing synthesized Session batch response');
            return response;
        }
        const response = await request(path, init);
        if (response === null) return null;
        if (!response) return Response.json({ error: 'not_found' }, { status: 404 });
        if (!response.ok || !['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived', '/v2/sessions/query'].includes(url.pathname)) return response;
        const body: unknown = await response.clone().json().catch(() => null);
        if (!body || typeof body !== 'object' || !('sessions' in body) || !Array.isArray(body.sessions)) return response;
        const captured = sources.get(scope(path, init)) ?? new Map<string, V2SessionRecord>();
        sources.set(scope(path, init), captured);
        const sessions = body.sessions.map((row: unknown) => {
            // Explicit current-wire claims belong to the tested parser, even if malformed.
            if (row && typeof row === 'object' && ('documents' in row || 'metadataAudience' in row || 'agentStateDocument' in row)) return row;
            const parsed = V2SessionRecordSchema.safeParse(row);
            if (!parsed.success) return row;
            const compact = V2SessionListRowSchema.safeParse(compactSessionListRow(parsed.data));
            if (!compact.success) return row;
            captured.set(parsed.data.id, parsed.data);
            return compact.data;
        });
        return new Response(JSON.stringify({ ...body, sessions }), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
}

/** HTTP fixture adapter: single and batch transports use the same external Session facts. */
export function createSessionReadBatchHttpBoundary(route: (request: ServedHomeRequest) => Response | undefined | Promise<Response | undefined>) {
    const componentRequests: ServedHomeRequest[] = [];
    return {
        componentRequests,
        async handle(request: ServedHomeRequest): Promise<Response | undefined> {
            const explicit = await route(request);
            if (explicit || request.path !== '/v2/sessions/read-batch') return explicit;
            const input = SessionReadBatchRequestV1Schema.parse(request.body);
            const read = async (path: string) => {
                const url = new URL(path, request.url.origin);
                const component = { ...request, path: url.pathname, url, method: 'GET', body: undefined };
                componentRequests.push(component);
                const response = await route(component) ?? Response.json({ error: 'not_found' }, { status: 404 });
                // A malformed external fixture stays malformed for the real
                // component parser; it must not throw away sibling outcomes.
                return { status: response.status, body: await response.json().catch(() => null) };
            };
            const results = await Promise.all(input.sessionIds.map(async sessionId => {
                const detail = input.includeSnapshot ? await read(`/v2/sessions/${encodeURIComponent(sessionId)}${input.accessProjectionVersion === 1 ? '?accessProjectionVersion=1' : ''}`) : undefined;
                const admitted = !detail || detail.status === 200;
                const turns = input.includeSnapshot && input.includeTurns !== false && admitted ? await read(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`) : undefined;
                const messages = input.includeMessages && admitted ? await read(buildSessionMessagesPath({ sessionId, scope: 'all', roles: ['user', 'agent', 'event'] })) : undefined;
                return { sessionId, ...(detail ? { detail } : {}), ...(turns ? { turns } : {}), ...(messages ? { messages } : {}) };
            }));
            return Response.json({ results });
        },
    };
}

/** Project external Session fixtures onto Usage's content-free plain Account wire. */
export function createUsageSessionEvidenceHttpBoundary(
    route: (request: ServedHomeRequest) => Response | undefined | Promise<Response | undefined>,
    readSessionIds: () => readonly string[],
) {
    const sessions = createSessionReadBatchHttpBoundary(route);
    return {
        componentRequests: sessions.componentRequests,
        async handle(request: ServedHomeRequest): Promise<Response | undefined> {
            if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return sessions.handle(request);
            const explicit = await route(request);
            if (explicit) return explicit;
            const input = UsageSessionEvidenceRequestSchema.parse(request.body);
            const selections = input.requests.map(demand => ({ query: demand.query,
                sessionIds: demand.sessionIds ?? (demand.query.session === null ? [...readSessionIds()]
                    : typeof demand.query.session === 'string' ? [demand.query.session] : demand.query.session) }));
            const results: UsageSessionEvidenceResponse['results'] = [];
            for (const selection of selections) {
                const response = (await sessions.handle({ ...request, path: '/v2/sessions/read-batch',
                    url: new URL('/v2/sessions/read-batch', request.url), body: {
                        sessionIds: selection.sessionIds, includeSnapshot: true, includeTurns: true,
                        includeMessages: selection.query.includeTranscriptEvidence, accessProjectionVersion: 1,
                    } }))!;
                if (!response.ok) return response;
                const payload: unknown = await response.json();
                const parsed = SessionReadBatchResponseV1Schema.safeParse(payload);
                if (!parsed.success) return Response.json({ requests: selections,
                    results: payload && typeof payload === 'object' && 'results' in payload ? payload.results : null });
                for (const row of parsed.data.results) {
                    if (row.detail?.status !== 200 || row.detail.body.session.encryptionMode !== 'plain') {
                        results.push(row);
                        continue;
                    }
                    const record = row.detail.body.session;
                    const metadata = record.metadataLayoutVersion === 1 && record.ownerMetadata?.t === 'plain'
                        ? projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(record.metadata), ownerMetadata: record.ownerMetadata.v })
                        : parsePlainSessionMetadata(record.metadata, record.metadataLayoutVersion);
                    const state = parsePlainSessionAgentStateResult(record.agentState);
                    const stateEvidence = state.status === 'available' ? UsageSessionStateEvidenceSchema.parse(projectUsageSessionStateEvidence({
                        id: row.sessionId, metadata: metadata ? { machineId: metadata.machineId ?? undefined,
                            actionConfirmationsV1: metadata.actionConfirmationsV1 } : null,
                        agentState: state.value, ...(row.turns?.status === 200 ? { sessionTurns: row.turns.body } : {}),
                    })) : undefined;
                    const { actionConfirmationsV1: _confirmations, ...safeMetadata } = record.metadataLayoutVersion === 1
                        ? JSON.parse(record.metadata) : metadata ?? {};
                    const projected = { ...row, detail: { ...row.detail, body: { ...row.detail.body,
                        session: { ...record, agentState: null, metadata: JSON.stringify(safeMetadata) } } },
                        ...(stateEvidence ? { stateEvidence } : {}) };
                    if (row.messages?.status !== 200) { results.push(projected); continue; }
                    const messages = await Promise.all(row.messages.body.messages.map(message =>
                        readStoredSessionMessage({ message, sessionEncryptionMode: 'plain' })));
                    const opened = messages.filter((message): message is NonNullable<typeof message> => message !== null && message.content !== null);
                    const complete = !row.messages.body.hasMore && opened.length === messages.length;
                    const { messages: _messages, ...parts } = projected;
                    if (messages.length > 0 && opened.length === 0) { results.push(parts); continue; }
                    const detail = projectSessionUsageWorkEvidence({ id: row.sessionId, metadata: null, agentState: null,
                        ...(row.turns?.status === 200 ? { sessionTurns: row.turns.body } : {}) }, opened, { messagesComplete: complete });
                    results.push({ ...parts, messageEvidence: { acceptedInputs: detail.acceptedInputs, phaseEvents: detail.phaseEvents,
                        coach: detail.coach, collaboration: detail.collaboration }, messagesComplete: complete });
                }
            }
            return Response.json({ requests: selections, results });
        },
    };
}

/** Keep existing external per-Session facts beneath the current batch wire. */
export function createSessionReadBatchFetchBoundary<TResult extends Response | null | undefined>(
    request: (...args: Parameters<RuntimeFetch>) => Promise<TResult>,
): (...args: Parameters<RuntimeFetch>) => Promise<TResult | Response> {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/v2/sessions/read-batch' || init?.method !== 'POST') return request(input, init);
        const boundary = createSessionReadBatchHttpBoundary(async component => {
            if (component.path === '/v2/sessions/read-batch') return undefined;
            return await request(component.url.href, { ...init, method: component.method, headers: component.headers,
                signal: component.signal, body: undefined }) ?? undefined;
        });
        return (await boundary.handle({ home: url.origin, accountId: null, url, path: url.pathname,
            method: init.method, headers: new Headers(init.headers), signal: init.signal,
            body: init.body ? JSON.parse(String(init.body)) : undefined }))!;
    };
}
