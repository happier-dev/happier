import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { HappyError } from '@/utils/errors/errors';
import {
    CreateOrUpdateSessionOrganizationFolderResponseSchema,
    CreateOrUpdateSessionOrganizationTagResponseSchema,
    DeleteSessionOrganizationLabelResponseSchema,
    DeleteSessionOrganizationFolderResponseSchema,
    DeleteSessionOrganizationTagResponseSchema,
    ImportLegacySessionOrganizationRequestSchema,
    ImportLegacySessionOrganizationResponseSchema,
    MoveSessionFolderAssignmentsResponseSchema,
    ReorderSessionOrganizationResponseSchema,
    SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS,
    SESSION_ORGANIZATION_SNAPSHOT_VERSION,
    SessionFolderAssignmentListResponseSchema,
    SessionOrganizationSnapshotRequestSchema,
    SessionOrganizationSnapshotResponseSchema,
    SetSessionAttentionStandingResponseSchema,
    SetSessionFolderAssignmentResponseSchema,
    SetSessionPinResponseSchema,
    SetSessionTagAssignmentsResponseSchema,
    UpsertSessionOrganizationLabelResponseSchema,
    type CreateOrUpdateSessionOrganizationFolderRequest,
    type CreateOrUpdateSessionOrganizationFolderResponse,
    type CreateOrUpdateSessionOrganizationTagRequest,
    type CreateOrUpdateSessionOrganizationTagResponse,
    type DeleteSessionOrganizationFolderRequest,
    type DeleteSessionOrganizationFolderResponse,
    type DeleteSessionOrganizationLabelRequest,
    type DeleteSessionOrganizationLabelResponse,
    type DeleteSessionOrganizationTagRequest,
    type DeleteSessionOrganizationTagResponse,
    type ImportLegacySessionOrganizationRequest,
    type ImportLegacySessionOrganizationResponse,
    type MoveSessionFolderAssignmentsRequest,
    type MoveSessionFolderAssignmentsResponse,
    type ReorderSessionOrganizationRequest,
    type ReorderSessionOrganizationResponse,
    type SessionFolderAssignmentListResponse,
    type SessionOrganizationSnapshotRequest,
    type SessionOrganizationSnapshotResponse,
    type SetSessionAttentionStandingRequest,
    type SetSessionAttentionStandingResponse,
    type SetSessionFolderAssignmentRequest,
    type SetSessionFolderAssignmentResponse,
    type SetSessionPinRequest,
    type SetSessionPinResponse,
    type SetSessionTagAssignmentsRequest,
    type SetSessionTagAssignmentsResponse,
    type UpsertSessionOrganizationLabelRequest,
    type UpsertSessionOrganizationLabelResponse,
} from '@happier-dev/protocol';
import type { z } from 'zod';

const SESSION_ORGANIZATION_ROUTE = '/v2/session-organization';

function normalizeServerUrl(serverUrl: string | null | undefined): string {
    return String(serverUrl ?? '').trim().replace(/\/+$/, '');
}

function buildServerScopedPath(serverUrl: string | null | undefined, path: string): string {
    const base = normalizeServerUrl(serverUrl);
    if (!base) return path;
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function authHeaders(credentials: AuthCredentials): Record<string, string> {
    return {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
    };
}

async function readJsonBody(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function parseJsonBody<T>(raw: unknown, schema: z.ZodType<T>, fallbackMessage: string): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new HappyError(fallbackMessage, false);
    }
    return parsed.data;
}

function readErrorMessage(raw: unknown, fallbackMessage: string): string {
    if (raw && typeof raw === 'object' && typeof (raw as { error?: unknown }).error === 'string') {
        return (raw as { error: string }).error;
    }
    return fallbackMessage;
}

async function parseJsonResponse<T>(response: Response, schema: z.ZodType<T>, fallbackMessage: string): Promise<T> {
    const raw = await readJsonBody(response);
    if (!response.ok) {
        throw new HappyError(readErrorMessage(raw, fallbackMessage), false);
    }
    return parseJsonBody(raw, schema, fallbackMessage);
}

function looksLikeMissingSessionOrganizationRoute(status: number, raw: unknown): boolean {
    if (status === 405 || status === 501) return true;
    if (status !== 404 || !raw || typeof raw !== 'object') return false;
    const record = raw as Record<string, unknown>;
    const error = typeof record.error === 'string' ? record.error : '';
    const path = typeof record.path === 'string' ? record.path : '';
    const message = typeof record.message === 'string' ? record.message : '';
    return error === 'Not found'
        && (
            (path === '' && message === '')
            || path.includes(SESSION_ORGANIZATION_ROUTE)
            || message.includes(SESSION_ORGANIZATION_ROUTE)
        );
}

function emptySessionOrganizationSnapshotResponse(): SessionOrganizationSnapshotResponse {
    return SessionOrganizationSnapshotResponseSchema.parse({
        snapshot: {
            schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
            version: 0,
            pins: [],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        },
    });
}

async function fetchSessionOrganizationRoute(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    path: string;
    init: RequestInit;
}>): Promise<Response> {
    const serverUrl = normalizeServerUrl(params.serverUrl);
    if (serverUrl) {
        return runtimeFetchWithServerReachability({
            serverUrl,
            token: params.credentials.token,
            url: buildServerScopedPath(serverUrl, params.path),
            init: params.init,
        });
    }
    return serverFetch(params.path, params.init, { includeAuth: false });
}

function appendBooleanParam(params: URLSearchParams, key: string, value: boolean | undefined): void {
    if (typeof value === 'boolean') {
        params.set(key, String(value));
    }
}

function appendArrayParam(params: URLSearchParams, key: string, values: readonly string[] | undefined): void {
    if (values && values.length > 0) {
        params.set(key, values.join(','));
    }
}

function buildSnapshotQuery(request: Partial<SessionOrganizationSnapshotRequest> | undefined): string {
    if (!request) return '';
    SessionOrganizationSnapshotRequestSchema.parse(request);
    const params = new URLSearchParams();
    appendBooleanParam(params, 'includeFolders', request.includeFolders);
    appendBooleanParam(params, 'includeTags', request.includeTags);
    appendBooleanParam(params, 'includeLabels', request.includeLabels);
    appendBooleanParam(params, 'includeAllFolderAssignments', request.includeAllFolderAssignments);
    appendBooleanParam(params, 'includeAllTagAssignments', request.includeAllTagAssignments);
    appendBooleanParam(params, 'includeAttentionStandings', request.includeAttentionStandings);
    appendArrayParam(params, 'assignmentSessionIds', request.assignmentSessionIds);
    appendArrayParam(params, 'folderIds', request.folderIds);
    appendArrayParam(params, 'tagIds', request.tagIds);
    if (request.orderScopes && request.orderScopes.length > 0) {
        params.set('orderScopes', JSON.stringify(request.orderScopes));
    }
    const query = params.toString();
    return query ? `?${query}` : '';
}

export async function fetchSessionOrganizationSnapshot(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request?: Partial<SessionOrganizationSnapshotRequest>;
}>): Promise<SessionOrganizationSnapshotResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}${buildSnapshotQuery(params.request)}`,
        init: { headers: authHeaders(params.credentials) },
    });
    const raw = await readJsonBody(response);
    if (!response.ok) {
        if (looksLikeMissingSessionOrganizationRoute(response.status, raw)) {
            return emptySessionOrganizationSnapshotResponse();
        }
        throw new HappyError(readErrorMessage(raw, 'Failed to fetch session organization snapshot'), false);
    }
    return parseJsonBody(raw, SessionOrganizationSnapshotResponseSchema, 'Failed to fetch session organization snapshot');
}

export async function importLegacySessionOrganization(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: ImportLegacySessionOrganizationRequest;
}>): Promise<ImportLegacySessionOrganizationResponse> {
    const request = ImportLegacySessionOrganizationRequestSchema.parse(params.request);
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/import`,
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(request),
        },
    });
    return parseJsonResponse(response, ImportLegacySessionOrganizationResponseSchema, 'Failed to import legacy session organization');
}

export async function setSessionPin(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionId: string;
    request: SetSessionPinRequest;
}>): Promise<SetSessionPinResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/pins/${encodeURIComponent(params.sessionId)}`,
        init: {
            method: 'PUT',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, SetSessionPinResponseSchema, 'Failed to set session pin');
}

export async function setSessionAttentionStanding(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionId: string;
    request: SetSessionAttentionStandingRequest;
}>): Promise<SetSessionAttentionStandingResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/attention-standings/${encodeURIComponent(params.sessionId)}`,
        init: {
            method: 'PUT',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, SetSessionAttentionStandingResponseSchema, 'Failed to set session attention standing');
}

export async function reorderSessionOrganization(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: ReorderSessionOrganizationRequest;
}>): Promise<ReorderSessionOrganizationResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/order`,
        init: {
            method: 'PUT',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, ReorderSessionOrganizationResponseSchema, 'Failed to reorder session organization');
}

export async function upsertSessionOrganizationFolder(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: CreateOrUpdateSessionOrganizationFolderRequest;
}>): Promise<CreateOrUpdateSessionOrganizationFolderResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/folders`,
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, CreateOrUpdateSessionOrganizationFolderResponseSchema, 'Failed to save session folder');
}

export async function deleteSessionOrganizationFolder(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: DeleteSessionOrganizationFolderRequest;
}>): Promise<DeleteSessionOrganizationFolderResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/folders/${encodeURIComponent(params.request.folderId)}`,
        init: {
            method: 'DELETE',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, DeleteSessionOrganizationFolderResponseSchema, 'Failed to delete session folder');
}

export async function setSessionFolderAssignment(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionId: string;
    request: SetSessionFolderAssignmentRequest;
}>): Promise<SetSessionFolderAssignmentResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/folder-assignments/${encodeURIComponent(params.sessionId)}`,
        init: {
            method: 'PUT',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, SetSessionFolderAssignmentResponseSchema, 'Failed to set session folder assignment');
}

export async function moveSessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: MoveSessionFolderAssignmentsRequest;
}>): Promise<MoveSessionFolderAssignmentsResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/folder-assignments/move`,
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, MoveSessionFolderAssignmentsResponseSchema, 'Failed to move session folder assignments');
}

export async function fetchSessionFolderAssignmentsForSessions(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionIds: readonly string[];
}>): Promise<SessionFolderAssignmentListResponse> {
    if (params.sessionIds.length === 0) return { assignments: [] };
    const assignments: SessionFolderAssignmentListResponse['assignments'] = [];
    for (let index = 0; index < params.sessionIds.length; index += SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS) {
        const chunk = params.sessionIds.slice(index, index + SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS);
        const response = await fetchSessionOrganizationRoute({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            path: `${SESSION_ORGANIZATION_ROUTE}${buildSnapshotQuery({
                includeFolders: false,
                includeTags: false,
                includeLabels: false,
                assignmentSessionIds: chunk,
            })}`,
            init: { headers: authHeaders(params.credentials) },
        });
        const raw = await readJsonBody(response);
        if (!response.ok) {
            if (looksLikeMissingSessionOrganizationRoute(response.status, raw)) {
                return { assignments: [] };
            }
            throw new HappyError(readErrorMessage(raw, 'Failed to fetch session organization snapshot'), false);
        }
        const parsed = parseJsonBody(raw, SessionOrganizationSnapshotResponseSchema, 'Failed to fetch session organization snapshot');
        assignments.push(...parsed.snapshot.folderAssignments);
    }
    return SessionFolderAssignmentListResponseSchema.parse({ assignments });
}

export async function upsertSessionOrganizationTag(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: CreateOrUpdateSessionOrganizationTagRequest;
}>): Promise<CreateOrUpdateSessionOrganizationTagResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/tags`,
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, CreateOrUpdateSessionOrganizationTagResponseSchema, 'Failed to save session tag');
}

export async function deleteSessionOrganizationTag(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: DeleteSessionOrganizationTagRequest;
}>): Promise<DeleteSessionOrganizationTagResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/tags/${encodeURIComponent(params.request.tagId)}`,
        init: {
            method: 'DELETE',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, DeleteSessionOrganizationTagResponseSchema, 'Failed to delete session tag');
}

export async function setSessionTagAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionId: string;
    request: SetSessionTagAssignmentsRequest;
}>): Promise<SetSessionTagAssignmentsResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/tag-assignments/${encodeURIComponent(params.sessionId)}`,
        init: {
            method: 'PUT',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, SetSessionTagAssignmentsResponseSchema, 'Failed to set session tag assignments');
}

export async function upsertSessionOrganizationLabel(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: UpsertSessionOrganizationLabelRequest;
}>): Promise<UpsertSessionOrganizationLabelResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/labels`,
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, UpsertSessionOrganizationLabelResponseSchema, 'Failed to save session organization label');
}

export async function deleteSessionOrganizationLabel(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    request: DeleteSessionOrganizationLabelRequest;
}>): Promise<DeleteSessionOrganizationLabelResponse> {
    const response = await fetchSessionOrganizationRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `${SESSION_ORGANIZATION_ROUTE}/labels`,
        init: {
            method: 'DELETE',
            headers: authHeaders(params.credentials),
            body: JSON.stringify(params.request),
        },
    });
    return parseJsonResponse(response, DeleteSessionOrganizationLabelResponseSchema, 'Failed to delete session organization label');
}
