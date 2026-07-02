import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch } from '@/sync/http/client';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    MoveSessionFolderAssignmentsResponseSchema,
    QuerySessionFolderSessionsResponseSchema,
    SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_SESSION_IDS,
    SessionFolderAssignmentListResponseSchema,
    SetSessionFolderAssignmentResponseSchema,
    type MoveSessionFolderAssignmentsResponse,
    type QuerySessionFolderSessionsResponse,
    type SessionFolderAssignment,
    type SessionFolderAssignmentListResponse,
    type SetSessionFolderAssignmentResponse,
} from '@happier-dev/protocol/sessionFolders';
import type { z } from 'zod';

export type SessionFolderAssignmentResponse = SessionFolderAssignment;

const SESSION_FOLDER_ASSIGNMENTS_ROUTE = '/v2/session-folder-assignments';

function buildServerScopedPath(serverUrl: string | null | undefined, path: string): string {
    const base = String(serverUrl ?? '').trim();
    if (!base) return path;
    return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeServerUrl(serverUrl: string | null | undefined): string {
    return String(serverUrl ?? '').trim().replace(/\/+$/, '');
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

function looksLikeMissingSessionFolderAssignmentsRoute(status: number, raw: unknown): boolean {
    if (status === 405 || status === 501) return true;
    if (status !== 404 || !raw || typeof raw !== 'object') return false;
    const record = raw as Record<string, unknown>;
    const error = typeof record.error === 'string' ? record.error : '';
    const path = typeof record.path === 'string' ? record.path : '';
    const message = typeof record.message === 'string' ? record.message : '';
    return error === 'Not found'
        && (
            (path === '' && message === '')
            || path.includes(SESSION_FOLDER_ASSIGNMENTS_ROUTE)
            || message.includes(SESSION_FOLDER_ASSIGNMENTS_ROUTE)
        );
}

async function parseJsonResponse<T>(response: Response, schema: z.ZodType<T>, fallbackMessage: string): Promise<T> {
    const raw = await readJsonBody(response);
    if (!response.ok) {
        throw new HappyError(readErrorMessage(raw, fallbackMessage), false);
    }
    return parseJsonBody(raw, schema, fallbackMessage);
}

function authHeaders(credentials: AuthCredentials): Record<string, string> {
    return {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
    };
}

async function fetchSessionFolderAssignmentRoute(params: Readonly<{
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

export async function fetchSessionFolderAssignmentsForSessions(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionIds: readonly string[];
}>): Promise<SessionFolderAssignmentListResponse> {
    if (params.sessionIds.length === 0) return { assignments: [] };

    const assignments: SessionFolderAssignmentListResponse["assignments"] = [];
    for (let index = 0; index < params.sessionIds.length; index += SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_SESSION_IDS) {
        const chunk = params.sessionIds.slice(index, index + SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_SESSION_IDS);
        const encoded = encodeURIComponent(chunk.join(','));
        const response = await fetchSessionFolderAssignmentRoute({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            path: `/v2/session-folder-assignments?sessionIds=${encoded}`,
            init: { headers: authHeaders(params.credentials) },
        });
        const raw = await readJsonBody(response);
        if (!response.ok) {
            if (looksLikeMissingSessionFolderAssignmentsRoute(response.status, raw)) {
                return { assignments: [] };
            }
            throw new HappyError(readErrorMessage(raw, 'Failed to fetch session folder assignments'), false);
        }
        assignments.push(...parseJsonBody(raw, SessionFolderAssignmentListResponseSchema, 'Failed to fetch session folder assignments').assignments);
    }
    return { assignments };
}

export async function setSessionFolderAssignment(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionId: string;
    folderId: string | null;
}>): Promise<SetSessionFolderAssignmentResponse> {
    const response = await fetchSessionFolderAssignmentRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: `/v2/session-folder-assignments/${encodeURIComponent(params.sessionId)}`,
        init: {
            method: 'PUT',
            headers: authHeaders(params.credentials),
            body: JSON.stringify({ folderId: params.folderId }),
        },
    });
    return parseJsonResponse(response, SetSessionFolderAssignmentResponseSchema, 'Failed to set session folder assignment');
}

export async function querySessionsByFolderScope(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    folderIds: readonly string[];
    includeArchived?: boolean;
    cursor?: string | null;
    limit?: number;
}>): Promise<QuerySessionFolderSessionsResponse> {
    const response = await fetchSessionFolderAssignmentRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: '/v2/session-folder-assignments/query',
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify({
                folderIds: params.folderIds,
                archived: params.includeArchived ?? false,
                cursor: params.cursor ?? null,
                limit: params.limit,
            }),
        },
    });
    return parseJsonResponse(response, QuerySessionFolderSessionsResponseSchema, 'Failed to query session folder scope');
}

export async function moveSessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    fromFolderIds: readonly string[];
    toFolderId: string | null;
}>): Promise<MoveSessionFolderAssignmentsResponse> {
    const response = await fetchSessionFolderAssignmentRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: '/v2/session-folder-assignments/move',
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify({
                fromFolderIds: params.fromFolderIds,
                toFolderId: params.toFolderId,
            }),
        },
    });
    return parseJsonResponse(response, MoveSessionFolderAssignmentsResponseSchema, 'Failed to move session folder assignments');
}
