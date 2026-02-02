import axios, { type AxiosResponse } from 'axios';
import { configuration } from '@/configuration';
import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt } from '../encryption';

export function shouldSyncSessionSnapshotOnConnect(opts: { metadataVersion: number; agentStateVersion: number }): boolean {
    return opts.metadataVersion < 0 || opts.agentStateVersion < 0;
}

export async function fetchSessionSnapshotUpdateFromServer(opts: {
    token: string;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    currentMetadataVersion: number;
    currentAgentStateVersion: number;
}): Promise<{
    metadata?: { metadata: Metadata; metadataVersion: number };
    agentState?: { agentState: AgentState | null; agentStateVersion: number };
}> {
    let raw: any | null = null;

    // Preferred path: fetch the single session by id.
    // Backward compatible: if the server doesn't implement this route yet, fall back to scanning /v2/sessions pages.
    try {
        const response = await axios.get(`${configuration.serverUrl}/v2/sessions/${opts.sessionId}`, {
            headers: {
                Authorization: `Bearer ${opts.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
            validateStatus: () => true,
        });

        if (response.status === 200) {
            const session = (response.data as any)?.session;
            if (session && typeof session === 'object') {
                raw = session;
            }
        } else if (response.status === 404) {
            // Distinguish "route missing" (older server) from "session missing".
            // Our server's 404 handler returns `{ error: "Not found", path: "<url>", method: "<verb>" }`.
            // Older/newer servers may omit/rename these fields, so keep this heuristic tolerant.
            const data = (response.data as any) ?? {};
            const error = typeof data.error === 'string' ? data.error : '';
            const path = typeof data.path === 'string' ? data.path : '';
            const message = typeof data.message === 'string' ? data.message : '';
            const looksLikeMissingRoute =
                error === 'Not found' &&
                ((path && path.includes(`/v2/sessions/${opts.sessionId}`)) || (message && message.includes(`/v2/sessions/${opts.sessionId}`)));
            const isRouteMissing = looksLikeMissingRoute;
            if (!isRouteMissing) {
                return {};
            }
        } else if (response.status === 401 || response.status === 403) {
            throw new Error(`Unauthorized (${response.status})`);
        } else if (response.status >= 400) {
            throw new Error(`Unexpected status from /v2/sessions/${opts.sessionId}: ${response.status}`);
        }
    } catch {
        // Fall through to compat path below.
    }

    if (!raw) {
        let cursor: string | null = null;
        type SessionsPage = {
            sessions?: unknown;
            hasNext?: unknown;
            nextCursor?: unknown;
        };
        for (let page = 0; page < 20; page++) {
            const response: AxiosResponse<SessionsPage> = await axios.get(`${configuration.serverUrl}/v2/sessions`, {
                headers: {
                    Authorization: `Bearer ${opts.token}`,
                    'Content-Type': 'application/json',
                },
                params: {
                    limit: 200,
                    ...(cursor ? { cursor } : {}),
                },
                timeout: 10_000,
                validateStatus: () => true,
            });

            if (response.status === 401 || response.status === 403) {
                throw new Error(`Unauthorized (${response.status})`);
            }
            if (response.status !== 200) {
                throw new Error(`Unexpected status from /v2/sessions: ${response.status}`);
            }

            const sessions = response.data?.sessions;
            if (!Array.isArray(sessions)) {
                return {};
            }

            raw = sessions.find((s: any) => s && typeof s === 'object' && s.id === opts.sessionId) ?? null;
            if (raw) {
                break;
            }

            const hasNext = response.data?.hasNext === true;
            const nextCursor: string | null = typeof response.data?.nextCursor === 'string' ? response.data.nextCursor : null;
            if (!hasNext || !nextCursor) {
                return {};
            }
            cursor = nextCursor;
        }

        if (!raw) return {};
    }

    const out: {
        metadata?: { metadata: Metadata; metadataVersion: number };
        agentState?: { agentState: AgentState | null; agentStateVersion: number };
    } = {};

    // Sync metadata if it is newer than our local view.
    const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : null;
    const rawMetadata = typeof raw.metadata === 'string' ? raw.metadata : null;
    if (rawMetadata && nextMetadataVersion !== null && nextMetadataVersion > opts.currentMetadataVersion) {
        const decrypted = decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawMetadata));
        if (decrypted) {
            out.metadata = {
                metadata: decrypted,
                metadataVersion: nextMetadataVersion,
            };
        }
    }

    // Sync agent state if it is newer than our local view.
    const nextAgentStateVersion = typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : null;
    const rawAgentState = typeof raw.agentState === 'string' ? raw.agentState : null;
    if (nextAgentStateVersion !== null && nextAgentStateVersion > opts.currentAgentStateVersion) {
        out.agentState = {
            agentState: rawAgentState ? decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawAgentState)) : null,
            agentStateVersion: nextAgentStateVersion,
        };
    }

    return out;
}
