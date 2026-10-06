import {
    deriveExternalSessionActivity,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    ClaudeCandidateSourceChangedError,
    findClaudeJsonlSessionsById,
    pageClaudeJsonlSessionFiles,
    type ClaudeJsonlSessionScanPosition,
    type DiscoveredClaudeJsonlSession,
} from './files.js';
import {
    readClaudeJsonlSessionTitleWithIndex,
    type ClaudeTitleIndexState,
} from './metadata.js';
import type { ClaudeExternalSessionSource } from './source.js';
import type { AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { searchClaudeExternalTranscript } from './transcript.js';
import { readClaudeJsonlFileSize } from './files.js';
import { findExternalSessionContentMatchRange } from '@happier-dev/protocol/sessions/external/contentSearchMatch';

export type ClaudeExternalSessionCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    createdAtMs?: number;
    activity?: ReturnType<typeof deriveExternalSessionActivity>;
    archived?: boolean;
    details: Readonly<{ projectId: string }>;
    candidateIndexState?: ClaudeTitleIndexState;
    match?: { snippet: string; sourceItemId: string; messageIndex: number };
}>;

type ClaudeCandidateSearchContext = Readonly<{
    searchTerm: string;
    searchMode: 'fast' | 'full';
    searchTarget: 'metadata' | 'content';
}>;

type ClaudeCandidateCursorV5 =
    | Readonly<{
        v: 5;
        kind: 'claudeCandidateIndexScan';
        sourceGeneration: string;
        scanPosition: ClaudeJsonlSessionScanPosition;
        scanned: number;
        search: ClaudeCandidateSearchContext;
    }>
    | Readonly<{
        v: 5;
        kind: 'claudeCandidateExactId';
        sourceGeneration: string;
        remoteSessionId: string;
        offset: number;
        search: ClaudeCandidateSearchContext;
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

function encodeCandidateCursor(cursor: ClaudeCandidateCursorV5): string {
    const searchMode = cursor.search.searchMode === 'fast' ? 'f' : 'l';
    const value = cursor.kind === 'claudeCandidateIndexScan'
        ? [
            5,
            cursor.sourceGeneration,
            cursor.scanPosition.projectId,
            cursor.scanPosition.sessionEntryOffset,
            cursor.scanned,
            cursor.search.searchTerm,
            searchMode,
            cursor.search.searchTarget,
        ]
        : [
            5,
            'e',
            cursor.sourceGeneration,
            cursor.remoteSessionId,
            cursor.offset,
            cursor.search.searchTerm,
            searchMode,
            cursor.search.searchTarget,
        ];
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCandidateCursor(
    raw: string | undefined,
): ClaudeCandidateCursorV5 | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== 8 || parsed[0] !== 5) return null;
        const searchMode = parsed[6] === 'f'
            ? 'fast'
            : parsed[6] === 'l'
                ? 'full'
                : null;
        if (typeof parsed[5] !== 'string' || !searchMode || (parsed[7] !== 'metadata' && parsed[7] !== 'content')) return null;
        const search: ClaudeCandidateSearchContext = {
            searchTerm: parsed[5],
            searchMode,
            searchTarget: parsed[7],
        };
        if (
            parsed[1] === 'e'
            && typeof parsed[2] === 'string'
            && parsed[2].length > 0
            && typeof parsed[3] === 'string'
            && parsed[3].length > 0
            && Number.isSafeInteger(parsed[4])
            && (parsed[4] as number) >= 0
        ) {
            return {
                v: 5,
                kind: 'claudeCandidateExactId',
                sourceGeneration: parsed[2],
                remoteSessionId: parsed[3],
                offset: parsed[4] as number,
                search,
            };
        }
        return (
            typeof parsed[1] === 'string'
            && parsed[1].length > 0
            && typeof parsed[2] === 'string'
            && parsed[2].length > 0
            && Number.isSafeInteger(parsed[3])
            && (parsed[3] as number) > 0
            && Number.isSafeInteger(parsed[4])
            && (parsed[4] as number) >= 0
        )
            ? {
                v: 5,
                kind: 'claudeCandidateIndexScan',
                sourceGeneration: parsed[1],
                scanPosition: {
                    projectId: parsed[2],
                    sessionEntryOffset: parsed[3] as number,
                },
                scanned: parsed[4] as number,
                search,
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

function normalizeCandidateSearchContext(params: Readonly<{
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    searchTarget?: 'metadata' | 'content';
}>): ClaudeCandidateSearchContext {
    return {
        searchTerm: typeof params.searchTerm === 'string' ? (params.searchTarget === 'content' ? params.searchTerm : params.searchTerm.trim()).toLowerCase() : '',
        searchMode: params.searchMode === 'fast' ? 'fast' : 'full',
        searchTarget: params.searchTarget === 'content' ? 'content' : 'metadata',
    };
}

async function buildCandidate(params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
    includeTitle: boolean;
    readCandidateIndexState?: (candidate: Readonly<{
        remoteSessionId: string;
        projectId: string;
    }>) => unknown;
    signal?: AbortSignal;
}>): Promise<ClaudeExternalSessionCandidate> {
    throwIfAborted(params.signal);
    const indexedTitle = params.includeTitle
        ? await readClaudeJsonlSessionTitleWithIndex({
            filePath: params.session.filePath,
            remoteSessionId: params.session.remoteSessionId,
            previousState: params.readCandidateIndexState?.({
                remoteSessionId: params.session.remoteSessionId,
                projectId: params.session.projectId,
            }),
        }).catch(() => null)
        : null;
    throwIfAborted(params.signal);

    return {
        remoteSessionId: params.session.remoteSessionId,
        ...(indexedTitle?.title ? { title: indexedTitle.title } : {}),
        updatedAtMs: params.session.updatedAtMs,
        activity: deriveExternalSessionActivity({
            updatedAtMs: params.session.updatedAtMs,
            env: params.env,
        }),
        details: { projectId: params.session.projectId },
        ...(indexedTitle && params.readCandidateIndexState
            ? { candidateIndexState: indexedTitle.indexState }
            : {}),
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

/**
 * A title is optional enrichment of a row the current source chunk already
 * selected. Admit the identifier-only row against the real response budget
 * before opening its transcript; if its title will not fit, preserve that
 * admitted row without inventing a substitute.
 */
async function buildCandidateForSelectedRow(params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
    page: readonly ClaudeExternalSessionCandidate[];
    nextCursor: string | null;
    searchIncomplete?: boolean;
    preparation?: ClaudeCandidatePreparation;
    resultBudget?: ClaudeCandidateResultBudget;
    readCandidateIndexState?: (candidate: Readonly<{
        remoteSessionId: string;
        projectId: string;
    }>) => unknown;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    candidate: ClaudeExternalSessionCandidate;
    fits: boolean;
}>> {
    const identifierOnly = buildMetadataCandidate({ session: params.session, env: params.env });
    if (
        params.resultBudget
        && !params.resultBudget.fits(
            [...params.page, identifierOnly],
            params.nextCursor,
            params.searchIncomplete,
            params.preparation,
        )
    ) {
        return { candidate: identifierOnly, fits: false };
    }
    const enriched = await buildCandidate({
        session: params.session,
        env: params.env,
        includeTitle: true,
        ...(params.readCandidateIndexState
            ? { readCandidateIndexState: params.readCandidateIndexState }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
    if (
        !params.resultBudget
        || params.resultBudget.fits(
            [...params.page, enriched],
            params.nextCursor,
            params.searchIncomplete,
            params.preparation,
        )
    ) {
        return { candidate: enriched, fits: true };
    }
    return { candidate: identifierOnly, fits: true };
}

export async function listClaudeExternalSessionCandidates(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    cursor?: string;
    limit: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    searchTarget?: 'metadata' | 'content';
    ripgrep?: AgentExternalSessionsInvocation['ripgrep'];
    signal?: AbortSignal;
    deadlineAtMs?: number;
    resultBudget?: ClaudeCandidateResultBudget;
    readCandidateIndexState?: (candidate: Readonly<{
        remoteSessionId: string;
        projectId: string;
    }>) => unknown;
}>): Promise<Readonly<{
    candidates: ClaudeExternalSessionCandidate[];
    nextCursor: string | null;
    searchIncomplete?: boolean;
    preparation?: ClaudeCandidatePreparation;
    contentCoverage?: 'complete' | 'partial' | 'unsupported';
}>> {
    throwIfAborted(params.signal);
    const limit = Math.max(1, Math.trunc(params.limit));
    const rawSearchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
    const search = normalizeCandidateSearchContext(params);
    const searchTerm = search.searchTerm;
    const decodedCursor = params.cursor ? decodeCandidateCursor(params.cursor) : null;
    if (params.cursor && !decodedCursor) {
        throw new ClaudeCandidateInvalidCursorError('Claude candidate cursor is invalid.');
    }
    if (
        decodedCursor
        && (
            decodedCursor.search.searchTerm !== search.searchTerm
            || decodedCursor.search.searchMode !== search.searchMode
            || decodedCursor.search.searchTarget !== search.searchTarget
        )
    ) {
        throw new ClaudeCandidateInvalidCursorError(
            'Claude candidate cursor does not match the current search.',
        );
    }

    if (search.searchTarget === 'metadata' && searchTerm && canSearchClaudeFilename(rawSearchTerm)) {
        const exactFilenameSnapshot = await findClaudeJsonlSessionsById({
            source: params.source,
            env: params.env,
            remoteSessionId: rawSearchTerm,
            signal: params.signal,
        });
        const exactFilenameMatches = exactFilenameSnapshot.matches;
        if (exactFilenameMatches.length > 0) {
            if (
                decodedCursor
                && (
                    decodedCursor.kind !== 'claudeCandidateExactId'
                    || decodedCursor.remoteSessionId !== rawSearchTerm
                )
            ) {
                throw new ClaudeCandidateInvalidCursorError(
                    'Claude exact-id candidate cursor does not match the current search.',
                );
            }
            if (
                decodedCursor?.kind === 'claudeCandidateExactId'
                && decodedCursor.sourceGeneration !== exactFilenameSnapshot.sourceGeneration
            ) {
                throw new ClaudeCandidateSourceChangedError(
                    'Claude exact-id candidate source changed during pagination.',
                );
            }
            const offset = decodedCursor?.kind === 'claudeCandidateExactId'
                ? decodedCursor.offset
                : 0;
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
                const nextOffset = offset + index + 1;
                const candidateCursor = nextOffset < exactFilenameMatches.length
                    ? encodeCandidateCursor({
                        v: 5,
                        kind: 'claudeCandidateExactId',
                        sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                        remoteSessionId: rawSearchTerm,
                        offset: nextOffset,
                        search,
                    })
                    : null;
                const selected = await buildCandidateForSelectedRow({
                    session,
                    env: params.env,
                    page,
                    nextCursor: candidateCursor,
                    ...(params.resultBudget ? { resultBudget: params.resultBudget } : {}),
                    ...(params.readCandidateIndexState
                        ? { readCandidateIndexState: params.readCandidateIndexState }
                        : {}),
                    ...(params.signal ? { signal: params.signal } : {}),
                });
                if (selected.fits) {
                    page.push(selected.candidate);
                    continue;
                }
                const continuation = encodeCandidateCursor({
                    v: 5,
                    kind: 'claudeCandidateExactId',
                    sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                    remoteSessionId: rawSearchTerm,
                    offset: offset + index,
                    search,
                });
                if (page.length === 0 && !params.resultBudget?.fits([], continuation, undefined, undefined)) {
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
                    ? encodeCandidateCursor({
                        v: 5,
                        kind: 'claudeCandidateExactId',
                        sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                        remoteSessionId: rawSearchTerm,
                        offset: nextOffset,
                        search,
                    })
                    : null,
            };
        }
    }

    if (decodedCursor?.kind === 'claudeCandidateExactId') {
        throw new ClaudeCandidateSourceChangedError(
            'Claude exact-id candidate source changed during pagination.',
        );
    }
    const scanPosition = decodedCursor?.kind === 'claudeCandidateIndexScan'
        ? decodedCursor.scanPosition
        : null;
    const scanLimit = limit;
    const traversed = await pageClaudeJsonlSessionFiles({
        source: params.source,
        env: params.env,
        scanPosition,
        skip: 0,
        limit: scanLimit,
        signal: params.signal,
    });
    let contentPartial = false;
    if (search.searchTarget === 'content') {
        if (!params.ripgrep) return { candidates: [], nextCursor: null, contentCoverage: 'unsupported' };
    }
    if (
        decodedCursor?.kind === 'claudeCandidateIndexScan'
        && decodedCursor.sourceGeneration !== traversed.sourceGeneration
    ) {
        throw new ClaudeCandidateSourceChangedError(
            'Claude candidate source changed while building its exact index.',
        );
    }
    const scannedBefore = decodedCursor?.kind === 'claudeCandidateIndexScan'
        ? decodedCursor.scanned
        : 0;
    const scanned = scannedBefore + traversed.scanned;
    const preparation: ClaudeCandidatePreparation | undefined = searchTerm
        ? undefined
        : {
            kind: 'building_candidate_index',
            scanned,
        };
    const searchIncomplete = searchTerm
        ? ((search.searchTarget === 'metadata' && search.searchMode === 'fast') || traversed.hasMore ? true : undefined)
        : undefined;
    const page: ClaudeExternalSessionCandidate[] = [];
    let previousScanPosition = scanPosition;
    let previousSourceGeneration = traversed.sourceGeneration;
    let fileStartedAtMs: number | undefined;
    let longestFileDurationMs = 0;

    for (let traversalIndex = 0; traversalIndex < traversed.entries.length; traversalIndex += 1) {
        const session = traversed.entries[traversalIndex];
        if (!session) continue;
        throwIfAborted(params.signal);
        const cursorBefore = previousScanPosition
            ? encodeCandidateCursor({
                v: 5,
                kind: 'claudeCandidateIndexScan',
                sourceGeneration: previousSourceGeneration,
                scanPosition: previousScanPosition,
                scanned: scannedBefore + traversalIndex,
                search,
            })
            : undefined;
        if (search.searchTarget === 'content' && params.deadlineAtMs !== undefined) {
            const nowMs = Date.now();
            if (fileStartedAtMs !== undefined) {
                longestFileDurationMs = Math.max(longestFileDurationMs, nowMs - fileStartedAtMs);
            }
            // Reuse the host deadline. The completed file's measured cost tells
            // us whether another unit fits; there is no subordinate timeout.
            if (cursorBefore && params.deadlineAtMs - nowMs <= longestFileDurationMs) {
                if (params.resultBudget && !params.resultBudget.fits(page, cursorBefore, searchIncomplete, preparation)) {
                    throw new ClaudeCandidateResultBudgetTooSmallError('Claude candidate result byte budget cannot fit the continuation envelope.');
                }
                return {
                    candidates: page, nextCursor: cursorBefore, contentCoverage: 'partial',
                    ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                };
            }
            fileStartedAtMs = nowMs;
        }
        previousScanPosition = session.scanPosition;
        previousSourceGeneration = session.sourceGeneration;
        let candidate: ClaudeExternalSessionCandidate;
        let needsSelectedRowTitle = false;
        if (search.searchTarget === 'content') {
            if (!searchTerm) continue;
            // Prefilter one file at a time so a large corpus can yield at a
            // completed file boundary. The native codec remains authoritative.
            if (!/[^\x00-\x7F]/.test(searchTerm)) {
                const result = await params.ripgrep!.run({
                    args: ['--no-config', '--files-with-matches', '--null', '--ignore-case', '--multiline', '--fixed-strings', '-e', searchTerm, '-e', '\\'],
                    paths: [session.filePath], signal: params.signal,
                });
                throwIfAborted(params.signal);
                if (!result.stdoutTruncated && result.exitCode !== 0 && result.exitCode !== 1) throw new Error('Claude conversation prefilter failed.');
                if (!result.stdoutTruncated && !result.stdout.split('\0').includes(session.filePath)) continue;
            }
            const projection = await searchClaudeExternalTranscript({
                filePath: session.filePath,
                fileRelPath: `${session.projectId}/${session.remoteSessionId}.jsonl`,
                query: searchTerm,
                // Source record span and serialized result size are different
                // resources: decode one real row, then pack its hit context.
                maxBytes: Math.max(1, await readClaudeJsonlFileSize(session.filePath, params.signal)),
                signal: params.signal,
            });
            contentPartial ||= projection.partial;
            if (!projection.match) continue;
            candidate = { ...await buildCandidate({ session, env: params.env, includeTitle: true, signal: params.signal }), match: projection.match };
        } else if (!searchTerm) {
            candidate = buildMetadataCandidate({ session, env: params.env });
            needsSelectedRowTitle = true;
        } else if (search.searchMode === 'fast') {
            const haystack = `${session.remoteSessionId} ${session.projectId}`.toLowerCase();
            if (!haystack.includes(searchTerm)) continue;
            candidate = buildMetadataCandidate({ session, env: params.env });
            needsSelectedRowTitle = true;
        } else {
            candidate = await buildCandidate({
                session,
                env: params.env,
                includeTitle: true,
                ...(params.readCandidateIndexState
                    ? { readCandidateIndexState: params.readCandidateIndexState }
                    : {}),
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
            ? encodeCandidateCursor({
                v: 5,
                kind: 'claudeCandidateIndexScan',
                sourceGeneration: session.sourceGeneration,
                scanPosition: session.scanPosition,
                scanned: scannedBefore + traversalIndex + 1,
                search,
            })
            : null;
        if (candidate.match && params.resultBudget) {
            const original = candidate;
            const match = candidate.match;
            const hit = findExternalSessionContentMatchRange(match.snippet, searchTerm);
            const fits = (snippet: string) => {
                const withSnippet = { ...original, match: { ...match, snippet } };
                const { title: _title, ...withoutTitle } = withSnippet;
                return params.resultBudget!.fits([...page, withSnippet], cursorAfter, searchIncomplete, preparation)
                    || params.resultBudget!.fits([...page, withoutTitle], cursorAfter, searchIncomplete, preparation);
            };
            if (hit && !fits(match.snippet)) {
                const contextSnippet = (context: number) => {
                    let start = Math.max(0, hit.start - context);
                    let end = Math.min(match.snippet.length, hit.end + context);
                    if (start > 0 && /[\uDC00-\uDFFF]/.test(match.snippet[start]!)) start -= 1;
                    if (end < match.snippet.length && /[\uD800-\uDBFF]/.test(match.snippet[end - 1]!)) end += 1;
                    return match.snippet.slice(start, end);
                };
                let lower = 0;
                let upper = match.snippet.length;
                while (lower < upper) {
                    const middle = Math.ceil((lower + upper) / 2);
                    if (fits(contextSnippet(middle))) lower = middle;
                    else upper = middle - 1;
                }
                candidate = { ...original, match: { ...match, snippet: contextSnippet(lower) } };
            }
        }

        if (needsSelectedRowTitle) {
            const selected = await buildCandidateForSelectedRow({
                session,
                env: params.env,
                page,
                nextCursor: cursorAfter,
                ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                ...(preparation !== undefined ? { preparation } : {}),
                ...(params.resultBudget ? { resultBudget: params.resultBudget } : {}),
                ...(params.readCandidateIndexState
                    ? { readCandidateIndexState: params.readCandidateIndexState }
                    : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (selected.fits) {
                page.push(selected.candidate);
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
                    ...(search.searchTarget === 'content' ? { contentCoverage: 'partial' as const } : {}),
                    ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                    ...(preparation !== undefined ? { preparation } : {}),
                };
            }
        } else {
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
                        ...(search.searchTarget === 'content' ? { contentCoverage: 'partial' as const } : {}),
                        ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                        ...(preparation !== undefined ? { preparation } : {}),
                    };
                }
            }
        }

        if (page.length >= limit) {
            return {
                candidates: page,
                nextCursor: cursorAfter,
                ...(search.searchTarget === 'content' ? { contentCoverage: contentPartial || cursorAfter ? 'partial' as const : 'complete' as const } : {}),
                ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                ...(preparation !== undefined ? { preparation } : {}),
            };
        }
    }

    const nextCursor = traversed.hasMore && traversed.nextScanPoint
        ? encodeCandidateCursor({
            v: 5,
            kind: 'claudeCandidateIndexScan',
            sourceGeneration: traversed.nextScanPoint.sourceGeneration,
            scanPosition: traversed.nextScanPoint.scanPosition,
            scanned,
            search,
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
        ...(search.searchTarget === 'content' ? { contentCoverage: contentPartial || nextCursor ? 'partial' as const : 'complete' as const } : {}),
        ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
        ...(preparation !== undefined ? { preparation } : {}),
    };
}
