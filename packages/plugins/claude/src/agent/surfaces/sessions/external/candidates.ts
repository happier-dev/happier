import type { ExternalSessionCandidateV1, ExternalSessionsSource } from '@happier-dev/protocol';

import {
    discoverClaudeJsonlSessions,
    findClaudeJsonlSessionsById,
    type DiscoveredClaudeJsonlSession,
} from './files.js';
import { deriveClaudeExternalSessionActivity, readClaudeJsonlSessionTitle } from './metadata.js';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function encodeIndexCursor(offset: number): string {
    const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
    if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
        const record = parsed as Record<string, unknown>;
        if (record.v !== 1 || record.kind !== 'index') return 0;
        const offset = typeof record.offset === 'number' && Number.isFinite(record.offset)
            ? Math.trunc(record.offset)
            : 0;
        return Math.max(0, offset);
    } catch {
        return 0;
    }
}

function canSearchClaudeFilename(searchTerm: string): boolean {
    return searchTerm.length > 0
        && !searchTerm.includes('/')
        && !searchTerm.includes('\\')
        && !searchTerm.endsWith('.jsonl');
}

function resolveClaudeTitleSearchCandidateLimit(env: NodeJS.ProcessEnv): number {
    const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_CLAUDE_SEARCH_TITLE_CANDIDATE_LIMIT ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1000;
    return Math.max(1, Math.min(25_000, configured));
}

async function buildCandidate(params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
    includeTitle: boolean;
}>): Promise<ExternalSessionCandidateV1> {
    const title = params.includeTitle
        ? await readClaudeJsonlSessionTitle(params.session.filePath).catch(() => null)
        : null;

    return {
        remoteSessionId: params.session.remoteSessionId,
        ...(title ? { title } : {}),
        updatedAtMs: params.session.updatedAtMs,
        activity: deriveClaudeExternalSessionActivity({
            updatedAtMs: params.session.updatedAtMs,
            env: params.env,
        }),
        details: { projectId: params.session.projectId },
    };
}

function buildMetadataCandidate(params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
}>): ExternalSessionCandidateV1 {
    return {
        remoteSessionId: params.session.remoteSessionId,
        updatedAtMs: params.session.updatedAtMs,
        activity: deriveClaudeExternalSessionActivity({
            updatedAtMs: params.session.updatedAtMs,
            env: params.env,
        }),
        details: { projectId: params.session.projectId },
    };
}

export async function listClaudeExternalSessionCandidates(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    cursor?: string;
    limit: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{
    candidates: ExternalSessionCandidateV1[];
    nextCursor: string | null;
    searchIncomplete?: boolean;
}>> {
    const limit = Math.max(1, Math.trunc(params.limit));
    const offset = decodeIndexCursor(params.cursor);
    const rawSearchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
    const searchTerm = rawSearchTerm.toLowerCase();

    if (searchTerm && canSearchClaudeFilename(rawSearchTerm)) {
        const exactFilenameMatches = await findClaudeJsonlSessionsById({
            source: params.source,
            env: params.env,
            remoteSessionId: rawSearchTerm,
        });
        if (exactFilenameMatches.length > 0) {
            const pageSessions = exactFilenameMatches.slice(offset, offset + limit);
            const page = await Promise.all(pageSessions.map((session) => buildCandidate({
                session,
                env: params.env,
                includeTitle: true,
            })));
            const nextOffset = offset + page.length;
            return {
                candidates: page,
                nextCursor: nextOffset < exactFilenameMatches.length ? encodeIndexCursor(nextOffset) : null,
            };
        }
    }

    const sessions = await discoverClaudeJsonlSessions({ source: params.source, env: params.env });

    if (searchTerm) {
        if (params.searchMode === 'fast') {
            const metadataMatches = sessions.filter((session) => {
                const haystack = `${session.remoteSessionId} ${session.projectId}`.toLowerCase();
                return haystack.includes(searchTerm);
            });
            const pageSessions = metadataMatches.slice(offset, offset + limit);
            const page = pageSessions.map((session) => buildMetadataCandidate({
                session,
                env: params.env,
            }));
            const nextOffset = offset + page.length;
            return {
                candidates: page,
                nextCursor: nextOffset < metadataMatches.length ? encodeIndexCursor(nextOffset) : null,
                searchIncomplete: true,
            };
        }

        const searchCandidateLimit = resolveClaudeTitleSearchCandidateLimit(params.env);
        const sessionsToSearch = sessions.slice(0, searchCandidateLimit);
        const searchableCandidates = await Promise.all(sessionsToSearch.map((session) => buildCandidate({
            session,
            env: params.env,
            includeTitle: true,
        })));
        const filteredCandidates = searchableCandidates.filter((candidate) => {
            const details = candidate.details as Record<string, unknown> | undefined;
            const projectId = typeof details?.projectId === 'string' ? details.projectId : '';
            const title = typeof candidate.title === 'string' ? candidate.title : '';
            const haystack = `${candidate.remoteSessionId} ${projectId} ${title}`.toLowerCase();
            return haystack.includes(searchTerm);
        });
        const page = filteredCandidates.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
            candidates: page,
            nextCursor: nextOffset < filteredCandidates.length ? encodeIndexCursor(nextOffset) : null,
            ...(sessionsToSearch.length < sessions.length ? { searchIncomplete: true } : {}),
        };
    }

    const matchedSessions = sessions;
    const pageSessions = matchedSessions.slice(offset, offset + limit);
    const page = await Promise.all(pageSessions.map((session) => buildCandidate({
        session,
        env: params.env,
        includeTitle: true,
    })));
    const nextOffset = offset + page.length;
    return {
        candidates: page,
        nextCursor: nextOffset < matchedSessions.length ? encodeIndexCursor(nextOffset) : null,
    };
}
