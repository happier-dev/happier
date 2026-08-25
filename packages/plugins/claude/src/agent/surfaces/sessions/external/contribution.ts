import type {
    AgentExternalSessionCandidate,
    AgentExternalSessionLinkData,
    AgentExternalSessionLinkDataValue,
    AgentExternalSessionSource,
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsContribution,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsReadAfterTranscriptResult,
    AgentExternalSessionsResult,
    AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    createAgentExternalSessionsProducerOverflowFailure,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    ClaudeCandidateInvalidCursorError,
    ClaudeCandidateResultBudgetTooSmallError,
    ClaudeCandidateSourceChangedError,
    listClaudeExternalSessionCandidates as listClaudeJsonlSessionCandidates,
} from './candidates.js';
import { isSafeClaudeJsonlPathSegment, resolveClaudeJsonlSessionFile } from './files.js';
import {
    projectClaudeExternalSessionSource,
    validateClaudeExternalSessionSource,
    type ClaudeExternalSessionSource,
} from './source.js';
import {
    ClaudeTranscriptInvalidCursorError,
    ClaudeTranscriptResultBudgetTooSmallError,
    pageClaudeExternalSessionTranscript as pageClaudeJsonlExternalSessionTranscript,
    readAfterClaudeExternalSessionTranscript as readAfterClaudeJsonlExternalSessionTranscript,
} from './transcript.js';

export {
    resolveClaudeJsonlSessionFile as resolveClaudeExternalSessionJsonlFile,
} from './files.js';
export {
    readClaudeJsonlSessionTitle as readClaudeExternalSessionTitle,
    readClaudeJsonlSessionWorkingDirectory as readClaudeExternalSessionWorkingDirectory,
} from './metadata.js';

function ok<T>(value: T): AgentExternalSessionsResult<T> {
    return { ok: true, value };
}

function failed(
    code: AgentExternalSessionsFailureCode,
    message: string,
    retryable?: boolean,
): AgentExternalSessionsResult<never> {
    return {
        ok: false,
        code,
        message,
        ...(typeof retryable === 'boolean' ? { retryable } : {}),
    };
}

function invocationFailure(
    invocation: AgentExternalSessionsInvocation,
): AgentExternalSessionsResult<never> | null {
    if (invocation.signal.aborted) {
        return failed('cancelled', 'Claude external-session operation was cancelled.');
    }
    if (Date.now() >= invocation.deadlineAtMs) {
        return failed('timeout', 'Claude external-session operation exceeded its deadline.', true);
    }
    if (!Number.isFinite(invocation.maxSerializedBytes) || invocation.maxSerializedBytes < 1) {
        return failed('invalid_request', 'Claude external-session result byte bound must be positive.');
    }
    return null;
}

function readOptionalString(value: AgentExternalSessionLinkDataValue | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toPublicClaudeSource(params: Readonly<{
    source: AgentExternalSessionSource;
    validatedSource: ClaudeExternalSessionSource;
    projectId?: string | null;
}>): AgentExternalSessionSource {
    const configDir = params.validatedSource.kind === 'claudeConfig'
        ? readOptionalString(params.validatedSource.configDir as AgentExternalSessionLinkDataValue | undefined)
        : null;
    const sourceProjectId = params.validatedSource.kind === 'claudeConfig'
        ? readOptionalString(params.validatedSource.projectId as AgentExternalSessionLinkDataValue | undefined)
        : null;
    const projectId = params.projectId === undefined ? sourceProjectId : params.projectId;
    return {
        kind: 'claudeConfig',
        ...(configDir ? { configDir } : {}),
        ...(projectId ? { projectId } : {}),
    };
}

function validateSource(params: Readonly<{
    source: AgentExternalSessionSource;
    env: NodeJS.ProcessEnv;
}>): AgentExternalSessionsResult<Readonly<{
    legacySource: ClaudeExternalSessionSource;
    publicSource: AgentExternalSessionSource;
}>> {
    const legacySource = projectClaudeExternalSessionSource(params.source);
    if (!legacySource) {
        return failed('source_invalid', 'provider/source mismatch');
    }
    const validation = validateClaudeExternalSessionSource({
        source: legacySource,
        env: params.env,
    });
    if (!validation.ok) {
        return failed('source_invalid', validation.error);
    }
    return ok({
        legacySource: validation.source,
        publicSource: toPublicClaudeSource({
            source: params.source,
            validatedSource: validation.source,
        }),
    });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isLinkDataValue(
    value: unknown,
    ancestors: ReadonlySet<object>,
): value is AgentExternalSessionLinkDataValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    if (ancestors.has(value)) return false;
    const nextAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        return value.every((entry) => isLinkDataValue(entry, nextAncestors));
    }
    if (!isPlainObject(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
    return Object.values(value).every((entry) => isLinkDataValue(entry, nextAncestors));
}

function isLinkData(value: unknown): value is AgentExternalSessionLinkData {
    return isPlainObject(value)
        && Reflect.ownKeys(value).every((key) => typeof key === 'string')
        && Object.values(value).every((entry) => isLinkDataValue(entry, new Set([value])));
}

function mapTranscriptItem(
    item: Awaited<ReturnType<typeof pageClaudeJsonlExternalSessionTranscript>>['items'][number],
): AgentExternalSessionTranscriptItem | null {
    if (!isLinkData(item.raw)) return null;
    return {
        id: item.id,
        createdAtMs: item.createdAtMs,
        ...(item.localId !== undefined ? { localId: item.localId } : {}),
        ...(item.messageRole !== undefined ? { messageRole: item.messageRole } : {}),
        ...(item.userProjection !== undefined ? { userProjection: item.userProjection } : {}),
        raw: item.raw,
    };
}

function mapTranscriptPage(
    page: Readonly<{
        items: readonly Awaited<ReturnType<typeof pageClaudeJsonlExternalSessionTranscript>>['items'][number][];
        nextCursor: string | null;
        tailCursor?: string | null;
        hasMore?: boolean;
        truncated?: boolean;
    }>,
): AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage> {
    const items = page.items.map(mapTranscriptItem);
    if (items.some((item) => item === null)) {
        return failed('agent_error', 'Claude produced a transcript item outside the public JSON contract.');
    }
    return ok({
        items: items.filter((item): item is AgentExternalSessionTranscriptItem => item !== null),
        nextCursor: page.nextCursor,
        ...(page.tailCursor !== undefined ? { tailCursor: page.tailCursor } : {}),
        ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
        ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
    });
}

function mapReadAfterPage(
    page: Parameters<typeof mapTranscriptPage>[0] & Readonly<{
        readAfterOutcome?: 'already_current' | 'gap_or_cursor_expired' | 'source_replaced' | 'source_unavailable';
        diagnostics?: readonly Readonly<{ code: string; count: number; positions: readonly number[] }>[];
    }>,
): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> {
    if (page.readAfterOutcome) return ok({ outcome: page.readAfterOutcome });
    const mapped = mapTranscriptPage(page);
    if (!mapped.ok) return ok({ outcome: 'read_failed' });
    if (mapped.value.items.length === 0) {
        if (!page.diagnostics?.length || !mapped.value.nextCursor) {
            return ok({ outcome: 'already_current' });
        }
        return ok({
            outcome: 'advanced',
            items: [],
            nextCursor: mapped.value.nextCursor,
            boundary: mapped.value.nextCursor,
            diagnostics: page.diagnostics,
        });
    }
    if (!mapped.value.nextCursor) return ok({ outcome: 'read_failed' });
    return ok({
        outcome: 'advanced',
        items: mapped.value.items,
        nextCursor: mapped.value.nextCursor,
        boundary: mapped.value.items.at(-1)!.id,
        ...(page.diagnostics?.length ? { diagnostics: page.diagnostics } : {}),
    });
}

function mapCandidate(candidate: Readonly<{
    remoteSessionId: string;
    title?: string | null;
    updatedAtMs: number;
    createdAtMs?: number;
    archived?: boolean;
    details?: unknown;
}>): AgentExternalSessionCandidate {
    const details = isPlainObject(candidate.details) ? candidate.details : null;
    const projectId = typeof details?.projectId === 'string' ? details.projectId : null;
    return {
        remoteSessionId: candidate.remoteSessionId,
        ...(candidate.title ? { title: candidate.title } : {}),
        updatedAtMs: candidate.updatedAtMs,
        ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
        ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}),
        ...(projectId ? { linkData: { projectId } } : {}),
    };
}

function serializedByteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function readProjectId(linkData: AgentExternalSessionLinkData | undefined): string | null {
    const projectId = readOptionalString(linkData?.projectId);
    return projectId && isSafeClaudeJsonlPathSegment(projectId) ? projectId : null;
}

export function createClaudeExternalSessionsContribution(params: Readonly<{
    env?: NodeJS.ProcessEnv;
}> = {}): AgentExternalSessionsContribution {
    const readEnv = () => params.env ?? process.env;

    return Object.freeze({
        resolveSource(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            const validation = validateSource({ source: request.source, env: readEnv() });
            return validation.ok ? ok({ source: validation.value.publicSource }) : validation;
        },

        async listCandidates(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
                return failed('invalid_request', 'Claude external-session candidate limit must be positive.');
            }
            const env = readEnv();
            const validation = validateSource({ source: request.source, env });
            if (!validation.ok) return validation;
            try {
                const listed = await listClaudeJsonlSessionCandidates({
                    source: validation.value.legacySource,
                    env,
                    cursor: request.cursor,
                    limit: request.maxItems,
                    searchTerm: request.searchTerm,
                    searchMode: request.searchMode,
                    signal: request.signal,
                    resultBudget: {
                        fits(candidates, nextCursor, searchIncomplete, preparation) {
                            return serializedByteLength(ok({
                                candidates: candidates.map(mapCandidate),
                                nextCursor,
                                ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
                                ...(preparation !== undefined ? { preparation } : {}),
                            })) <= request.maxSerializedBytes;
                        },
                    },
                });
                const after = invocationFailure(request);
                if (after) return after;
                return ok({
                    candidates: listed.candidates.map(mapCandidate),
                    nextCursor: listed.nextCursor,
                    ...(listed.searchIncomplete !== undefined ? { searchIncomplete: listed.searchIncomplete } : {}),
                    ...(listed.preparation !== undefined ? { preparation: listed.preparation } : {}),
                });
            } catch (error) {
                const after = invocationFailure(request);
                if (after) return after;
                if (error instanceof ClaudeCandidateResultBudgetTooSmallError) {
                    return createAgentExternalSessionsProducerOverflowFailure(error.message);
                }
                if (error instanceof ClaudeCandidateInvalidCursorError) {
                    return failed('invalid_request', error.message);
                }
                if (error instanceof ClaudeCandidateSourceChangedError) {
                    return failed('source_invalid', error.message, true);
                }
                return failed(
                    'agent_unavailable',
                    error instanceof Error ? error.message : 'Claude external-session listing failed.',
                    true,
                );
            }
        },

        async resolveLinkIdentity(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            const env = readEnv();
            const validation = validateSource({ source: request.source, env });
            if (!validation.ok) return validation;
            const requestedProjectId = readProjectId(request.linkData)
                ?? readProjectId({ projectId: request.source.projectId });
            const source = toPublicClaudeSource({
                source: validation.value.publicSource,
                validatedSource: validation.value.legacySource,
                projectId: requestedProjectId,
            });
            const legacySource = projectClaudeExternalSessionSource(source);
            if (!legacySource) return failed('source_invalid', 'provider/source mismatch');
            try {
                const resolved = await resolveClaudeJsonlSessionFile({
                    source: legacySource,
                    env,
                    remoteSessionId: request.remoteSessionId,
                    signal: request.signal,
                });
                const after = invocationFailure(request);
                if (after) return after;
                if (!resolved || (requestedProjectId && resolved.projectId !== requestedProjectId)) {
                    return failed('candidate_not_found', 'Claude external-session candidate was not found.');
                }
                return ok({
                    source: toPublicClaudeSource({
                        source: validation.value.publicSource,
                        validatedSource: validation.value.legacySource,
                        projectId: resolved.projectId,
                    }),
                    remoteSessionId: request.remoteSessionId,
                    linkData: { projectId: resolved.projectId },
                });
            } catch (error) {
                const after = invocationFailure(request);
                if (after) return after;
                return failed(
                    'agent_unavailable',
                    error instanceof Error ? error.message : 'Claude external-session identity resolution failed.',
                    true,
                );
            }
        },

        resolveLinkedIdentity(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            const validation = validateSource({ source: request.source, env: readEnv() });
            if (!validation.ok) return validation;
            const projectId = readProjectId(request.linkData);
            if (!projectId) {
                return failed('invalid_request', 'Claude linked identity requires a valid projectId.');
            }
            return ok({
                source: toPublicClaudeSource({
                    source: validation.value.publicSource,
                    validatedSource: validation.value.legacySource,
                    projectId,
                }),
                remoteSessionId: request.remoteSessionId,
                linkData: { projectId },
            });
        },

        async pageTranscript(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
                return failed('invalid_request', 'Claude external-session transcript limit must be positive.');
            }
            const env = readEnv();
            const validation = validateSource({ source: request.source, env });
            if (!validation.ok) return validation;
            try {
                const page = await pageClaudeJsonlExternalSessionTranscript({
                    source: validation.value.legacySource,
                    env,
                    providerSessionId: request.remoteSessionId,
                    direction: request.direction,
                    cursor: request.cursor,
                    maxBytes: request.maxSerializedBytes,
                    maxItems: request.maxItems,
                    signal: request.signal,
                    resultBudget: {
                        fits(page) {
                            const mapped = mapTranscriptPage(page);
                            return mapped.ok
                                && serializedByteLength(mapped) <= request.maxSerializedBytes;
                        },
                    },
                });
                const after = invocationFailure(request);
                if (after) return after;
                const mapped = mapTranscriptPage(page);
                return serializedByteLength(mapped) <= request.maxSerializedBytes
                    ? mapped
                    : createAgentExternalSessionsProducerOverflowFailure(
                        'Claude transcript result byte budget cannot fit the page envelope.',
                    );
            } catch (error) {
                const after = invocationFailure(request);
                if (after) return after;
                if (error instanceof ClaudeTranscriptInvalidCursorError) {
                    return failed('invalid_request', error.message);
                }
                if (error instanceof ClaudeTranscriptResultBudgetTooSmallError) {
                    return createAgentExternalSessionsProducerOverflowFailure(error.message);
                }
                return failed(
                    'agent_unavailable',
                    error instanceof Error ? error.message : 'Claude external-session transcript operation failed.',
                    true,
                );
            }
        },

        async readAfterTranscript(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
                return failed('invalid_request', 'Claude external-session transcript limit must be positive.');
            }
            const env = readEnv();
            const validation = validateSource({ source: request.source, env });
            if (!validation.ok) return validation;
            try {
                const page = await readAfterClaudeJsonlExternalSessionTranscript({
                    source: validation.value.legacySource,
                    env,
                    providerSessionId: request.remoteSessionId,
                    cursor: request.cursor,
                    maxBytes: request.maxSerializedBytes,
                    maxItems: request.maxItems,
                    signal: request.signal,
                    resultBudget: {
                        fits(page) {
                            const mapped = mapReadAfterPage(page);
                            return mapped.ok
                                && serializedByteLength(mapped) <= request.maxSerializedBytes;
                        },
                    },
                });
                const after = invocationFailure(request);
                if (after) return after;
                const mapped = mapReadAfterPage(page);
                return serializedByteLength(mapped) <= request.maxSerializedBytes
                    ? mapped
                    : createAgentExternalSessionsProducerOverflowFailure(
                        'Claude transcript result byte budget cannot fit the page envelope.',
                    );
            } catch (error) {
                const after = invocationFailure(request);
                if (after) return after;
                if (error instanceof ClaudeTranscriptResultBudgetTooSmallError) {
                    return createAgentExternalSessionsProducerOverflowFailure(error.message);
                }
                return ok({ outcome: 'read_failed' });
            }
        },
    });
}

export const claudeExternalSessionsContribution: AgentExternalSessionsContribution = createClaudeExternalSessionsContribution();
