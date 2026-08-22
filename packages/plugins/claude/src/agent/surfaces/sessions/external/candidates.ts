import {
    deriveExternalSessionActivity,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    decodeIndexCursor,
    encodeIndexCursor,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import {
    ClaudeCandidateSourceChangedError,
    findClaudeJsonlSessionsById,
    pageClaudeJsonlSessionFiles,
    type ClaudeJsonlSessionScanPosition,
    type DiscoveredClaudeJsonlSession,
} from './files.js';
import { readClaudeJsonlSessionTitle } from './metadata.js';
import type { ClaudeExternalSessionSource } from './source.js';

export type ClaudeExternalSessionCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    createdAtMs?: number;
    activity?: ReturnType<typeof deriveExternalSessionActivity>;
    archived?: boolean;
    details: Readonly<{ projectId: string }>;
}>;

type ClaudeCandidateCursorV2 = Readonly<{
    v: 2;
    kind: 'claudeCandidates';
    afterTraversalKey: string;
}>;

type ClaudeCandidateCursorV3 = Readonly<{
    v: 3;
    kind: 'claudeCandidateIndexScan';
    sourceGeneration: string;
    scanPosition: ClaudeJsonlSessionScanPosition;
    scanned: number;
}>;

type ClaudeCandidateExactIdCursorV4 = Readonly<{
    v: 4;
    kind: 'claudeCandidateExactId';
    sourceGeneration: string;
    remoteSessionId: string;
    offset: number;
}>;

export type ClaudeCandidatePreparation = Readonly<{
    kind: 'building_candidate_index';
    scanned: number;
    total?: number;
}>;

export type ClaudeCandidateResultBudget = Readonly<{
    fits(
        candidates: readonly ClaudeExternalSessionCandidate[],
        nextCursor: string | null,
        searchIncomplete: boolean | undefined,
        preparation: ClaudeCandidatePreparation | undefined,
    ): boolean;
}>;

export class ClaudeCandidateResultBudgetTooSmallError extends Error {
    readonly name = 'ClaudeCandidateResultBudgetTooSmallError';
}

export { ClaudeCandidateSourceChangedError } from './files.js';

export class ClaudeCandidateInvalidCursorError extends Error {
    readonly name = 'ClaudeCandidateInvalidCursorError';
}

function encodeCandidateCursor(afterTraversalKey: string): string {
    const cursor: ClaudeCandidateCursorV2 = {
        v: 2,
        kind: 'claudeCandidates',
        afterTraversalKey,
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function encodeCandidateScanCursor(cursor: Omit<ClaudeCandidateCursorV3, 'v' | 'kind'>): string {
    return Buffer.from(JSON.stringify([
        3,
        cursor.sourceGeneration,
        cursor.scanPosition.projectId,
        cursor.scanPosition.sessionEntryOffset,
        cursor.scanned,
    ]), 'utf8').toString('base64url');
}

function encodeCandidateExactIdCursor(cursor: Omit<ClaudeCandidateExactIdCursorV4, 'v' | 'kind'>): string {
    return Buffer.from(JSON.stringify([
        4,
        cursor.sourceGeneration,
        cursor.remoteSessionId,
        cursor.offset,
    ]), 'utf8').toString('base64url');
}

function decodeCandidateCursor(
    raw: string | undefined,
): ClaudeCandidateCursorV2 | ClaudeCandidateCursorV3 | ClaudeCandidateExactIdCursorV4 | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        if (
            Array.isArray(parsed)
            && parsed.length === 4
            && parsed[0] === 4
            && typeof parsed[1] === 'string'
            && parsed[1].length > 0
            && typeof parsed[2] === 'string'
            && parsed[2].length > 0
            && Number.isSafeInteger(parsed[3])
            && (parsed[3] as number) >= 0
        ) {
            return {
                v: 4,
                kind: 'claudeCandidateExactId',
                sourceGeneration: parsed[1],
                remoteSessionId: parsed[2],
                offset: parsed[3] as number,
            };
        }
        if (
            Array.isArray(parsed)
            && parsed.length === 5
            && parsed[0] === 3
            && typeof parsed[1] === 'string'
            && parsed[1].length > 0
            && typeof parsed[2] === 'string'
            && parsed[2].length > 0
            && Number.isSafeInteger(parsed[3])
            && (parsed[3] as number) > 0
            && Number.isSafeInteger(parsed[4])
            && (parsed[4] as number) >= 0
        ) {
            return {
                v: 3,
                kind: 'claudeCandidateIndexScan',
                sourceGeneration: parsed[1],
                scanPosition: {
                    projectId: parsed[2],
                    sessionEntryOffset: parsed[3] as number,
                },
                scanned: parsed[4] as number,
            };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        if (
            record.v === 3
            && record.kind === 'claudeCandidateIndexScan'
            && typeof record.sourceGeneration === 'string'
            && record.sourceGeneration.length > 0
            && Number.isSafeInteger(record.scanned)
            && (record.scanned as number) >= 0
            && record.scanPosition
            && typeof record.scanPosition === 'object'
            && !Array.isArray(record.scanPosition)
        ) {
            const position = record.scanPosition as Record<string, unknown>;
            if (
                typeof position.projectId === 'string'
                && position.projectId.length > 0
                && Number.isSafeInteger(position.sessionEntryOffset)
                && (position.sessionEntryOffset as number) > 0
            ) {
                return {
                    v: 3,
                    kind: 'claudeCandidateIndexScan',
                    sourceGeneration: record.sourceGeneration,
                    scanPosition: {
                        projectId: position.projectId,
                        sessionEntryOffset: position.sessionEntryOffset as number,
                    },
                    scanned: record.scanned as number,
                };
            }
        }
        return record.v === 2
            && record.kind === 'claudeCandidates'
            && typeof record.afterTraversalKey === 'string'
            ? {
                v: 2,
                kind: 'claudeCandidates',
                afterTraversalKey: record.afterTraversalKey,
            }
            : null;
    } catch {
        return null;
    }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
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
    signal?: AbortSignal;
}>): Promise<ClaudeExternalSessionCandidate> {
    throwIfAborted(params.signal);
    const title = params.includeTitle
        ? await readClaudeJsonlSessionTitle(params.session.filePath).catch(() => null)
        : null;
    throwIfAborted(params.signal);

    return {
        remoteSessionId: params.session.remoteSessionId,
        ...(title ? { title } : {}),
        updatedAtMs: params.session.updatedAtMs,
        activity: deriveExternalSessionActivity({
            updatedAtMs: params.session.updatedAtMs,
            env: params.env,
        }),
        details: { projectId: params.session.projectId },
    };
}

function buildMetadataCandidate(params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
}>): ClaudeExternalSessionCandidate {
    return {
        remoteSessionId: params.session.remoteSessionId,
        updatedAtMs: params.session.updatedAtMs,
        activity: deriveExternalSessionActivity({
            updatedAtMs: params.session.updatedAtMs,
            env: params.env,
        }),
        details: { projectId: params.session.projectId },
    };
}

export async function listClaudeExternalSessionCandidates(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    cursor?: string;
    limit: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    signal?: AbortSignal;
    resultBudget?: ClaudeCandidateResultBudget;
}>): Promise<Readonly<{
    candidates: ClaudeExternalSessionCandidate[];
    nextCursor: string | null;
    searchIncomplete?: boolean;
    preparation?: ClaudeCandidatePreparation;
}>> {
    throwIfAborted(params.signal);
    const limit = Math.max(1, Math.trunc(params.limit));
    const rawSearchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
    const searchTerm = rawSearchTerm.toLowerCase();

    if (searchTerm && canSearchClaudeFilename(rawSearchTerm)) {
        const exactFilenameSnapshot = await findClaudeJsonlSessionsById({
            source: params.source,
            env: params.env,
            remoteSessionId: rawSearchTerm,
            signal: params.signal,
        });
        const exactFilenameMatches = exactFilenameSnapshot.matches;
        if (exactFilenameMatches.length > 0) {
            const exactCursor = params.cursor ? decodeCandidateCursor(params.cursor) : null;
            if (
                params.cursor
                && (
                    exactCursor?.v !== 4
                    || exactCursor.remoteSessionId !== rawSearchTerm
                )
            ) {
                throw new ClaudeCandidateInvalidCursorError(
                    'Claude exact-id candidate cursor does not match the current search.',
                );
            }
            if (
                exactCursor?.v === 4
                && exactCursor.sourceGeneration !== exactFilenameSnapshot.sourceGeneration
            ) {
                throw new ClaudeCandidateSourceChangedError(
                    'Claude exact-id candidate source changed during pagination.',
                );
            }
            const offset = exactCursor?.v === 4 ? exactCursor.offset : 0;
            if (offset >= exactFilenameMatches.length) {
                throw new ClaudeCandidateInvalidCursorError(
                    'Claude exact-id candidate cursor is outside the current result set.',
                );
            }
            const pageSessions = exactFilenameMatches.slice(offset, offset + limit);
            const page: ClaudeExternalSessionCandidate[] = [];
            for (let index = 0; index < pageSessions.length; index += 1) {
                const session = pageSessions[index];
                if (!session) continue;
                const candidate = await buildCandidate({
                    session,
                    env: params.env,
                    includeTitle: true,
                    signal: params.signal,
                });
                const nextOffset = offset + index + 1;
                const candidateCursor = nextOffset < exactFilenameMatches.length
                    ? encodeCandidateExactIdCursor({
                        sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                        remoteSessionId: rawSearchTerm,
                        offset: nextOffset,
                    })
                    : null;
                const withTitle = [...page, candidate];
                if (!params.resultBudget || params.resultBudget.fits(withTitle, candidateCursor, undefined, undefined)) {
                    page.push(candidate);
                    continue;
                }
                const { title: _discardedTitle, ...candidateWithoutTitle } = candidate;
                const withoutTitle = [...page, candidateWithoutTitle];
                if (params.resultBudget.fits(withoutTitle, candidateCursor, undefined, undefined)) {
                    page.push(candidateWithoutTitle);
                    continue;
                }
                const continuation = encodeCandidateExactIdCursor({
                    sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                    remoteSessionId: rawSearchTerm,
                    offset: offset + index,
                });
                if (page.length === 0 && !params.resultBudget.fits([], continuation, undefined, undefined)) {
                    throw new ClaudeCandidateResultBudgetTooSmallError(
                        'Claude candidate result byte budget cannot fit the continuation envelope.',
                    );
                }
                return { candidates: page, nextCursor: continuation };
            }
            const nextOffset = offset + pageSessions.length;
            return {
                candidates: page,
                nextCursor: nextOffset < exactFilenameMatches.length
                    ? encodeCandidateExactIdCursor({
                        sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                        remoteSessionId: rawSearchTerm,
                        offset: nextOffset,
                    })
                    : null,
            };
        }
    }

    const decodedCursor = decodeCandidateCursor(params.cursor);
    if (decodedCursor?.v === 4) {
        throw new ClaudeCandidateSourceChangedError(
            'Claude exact-id candidate source changed during pagination.',
        );
    }
    const afterTraversalKey = decodedCursor?.v === 2 ? decodedCursor.afterTraversalKey : null;
    const scanPosition = decodedCursor?.v === 3 ? decodedCursor.scanPosition : null;
    const legacyOffset = decodedCursor === null ? decodeIndexCursor(params.cursor) ?? 0 : 0;
    const scanLimit = searchTerm && params.searchMode !== 'fast'
        ? resolveClaudeTitleSearchCandidateLimit(params.env)
        : limit;
    const traversed = await pageClaudeJsonlSessionFiles({
        source: params.source,
        env: params.env,
        afterTraversalKey,
        scanPosition,
        skip: legacyOffset,
        limit: scanLimit,
        signal: params.signal,
    });
    if (
        decodedCursor?.v === 3
        && decodedCursor.sourceGeneration !== traversed.sourceGeneration
    ) {
        throw new ClaudeCandidateSourceChangedError(
            'Claude candidate source changed while building its exact index.',
        );
    }
    const scannedBefore = decodedCursor?.v === 3 ? decodedCursor.scanned : legacyOffset;
    const scanned = scannedBefore + traversed.scanned;
    const preparation: ClaudeCandidatePreparation | undefined = searchTerm
        ? undefined
        : {
            kind: 'building_candidate_index',
            scanned,
        };
    const searchIncomplete = searchTerm
        ? (params.searchMode === 'fast' || traversed.hasMore ? true : undefined)
        : undefined;
    const page: ClaudeExternalSessionCandidate[] = [];
    let previousTraversalKey = afterTraversalKey;
    let previousScanPosition = scanPosition;
    let previousSourceGeneration = traversed.sourceGeneration;

    for (let traversalIndex = 0; traversalIndex < traversed.entries.length; traversalIndex += 1) {
        const session = traversed.entries[traversalIndex];
        if (!session) continue;
        throwIfAborted(params.signal);
        const cursorBefore = previousScanPosition
            ? encodeCandidateScanCursor({
                sourceGeneration: previousSourceGeneration,
                scanPosition: previousScanPosition,
                scanned: scannedBefore + traversalIndex,
            })
            : previousTraversalKey
                ? encodeCandidateCursor(previousTraversalKey)
                : undefined;
        previousTraversalKey = session.traversalKey;
        previousScanPosition = session.scanPosition;
        previousSourceGeneration = session.sourceGeneration;
        let candidate: ClaudeExternalSessionCandidate;
        if (!searchTerm) {
            candidate = buildMetadataCandidate({ session, env: params.env });
        } else if (params.searchMode === 'fast') {
            const haystack = `${session.remoteSessionId} ${session.projectId}`.toLowerCase();
            if (!haystack.includes(searchTerm)) continue;
            candidate = buildMetadataCandidate({ session, env: params.env });
        } else {
            candidate = await buildCandidate({
                session,
                env: params.env,
                includeTitle: true,
                signal: params.signal,
            });
            if (searchTerm) {
                const details = candidate.details as Record<string, unknown> | undefined;
                const projectId = typeof details?.projectId === 'string' ? details.projectId : '';
                const title = typeof candidate.title === 'string' ? candidate.title : '';
                const haystack = `${candidate.remoteSessionId} ${projectId} ${title}`.toLowerCase();
                if (!haystack.includes(searchTerm)) continue;
            }
        }

        const cursorAfter = traversalIndex < traversed.entries.length - 1 || traversed.hasMore
            ? encodeCandidateScanCursor({
                sourceGeneration: session.sourceGeneration,
                scanPosition: session.scanPosition,
                scanned: scannedBefore + traversalIndex + 1,
            })
            : null;
        const withTitle = [...page, candidate];
        if (!params.resultBudget || params.resultBudget.fits(
            withTitle,
            cursorAfter,
            searchIncomplete,
            preparation,
        )) {
            page.push(candidate);
        } else {
            const { title: _discardedTitle, ...candidateWithoutTitle } = candidate;
            const withoutTitle = [...page, candidateWithoutTitle];
            if (params.resultBudget.fits(withoutTitle, cursorAfter, searchIncomplete, preparation)) {
                page.push(candidateWithoutTitle);
            } else {
                const continuation = cursorBefore;
                if (page.length === 0) {
                    throw new ClaudeCandidateResultBudgetTooSmallError(
                        'Claude candidate result byte budget cannot fit one candidate.',
                    );
                }
                if (!continuation) {
                    throw new ClaudeCandidateResultBudgetTooSmallError(
                        'Claude candidate result byte budget cannot preserve the continuation cursor.',
                    );
                }
                return {
                    candidates: page,
                    nextCursor: continuation,
                    ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                    ...(preparation !== undefined ? { preparation } : {}),
                };
            }
        }

        if (page.length >= limit) {
            return {
                candidates: page,
                nextCursor: cursorAfter,
                ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                ...(preparation !== undefined ? { preparation } : {}),
            };
        }
    }

    const nextCursor = traversed.hasMore && traversed.nextScanPoint
        ? encodeCandidateScanCursor({
            sourceGeneration: traversed.nextScanPoint.sourceGeneration,
            scanPosition: traversed.nextScanPoint.scanPosition,
            scanned,
        })
        : null;
    if (params.resultBudget && !params.resultBudget.fits(
        page,
        nextCursor,
        searchIncomplete,
        preparation,
    )) {
        throw new ClaudeCandidateResultBudgetTooSmallError(
            'Claude candidate result byte budget cannot fit the requested page envelope.',
        );
    }
    return {
        candidates: page,
        nextCursor,
        ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
        ...(preparation !== undefined ? { preparation } : {}),
    };
}
