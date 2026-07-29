import type {
  AgentExternalSessionCandidate,
  AgentExternalSessionLinkData,
  AgentExternalSessionLinkDataValue,
  AgentExternalSessionSource,
  AgentExternalSessionsContribution,
  AgentExternalSessionsFailureCode,
  AgentExternalSessionsInvocation,
  AgentExternalSessionsReadAfterTranscriptResult,
  AgentExternalSessionsResult,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { canonicalizePath } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import {
  AntigravityCandidateSourceChangedError,
  isSafeAntigravityConversationId,
  pageAntigravityConversationCandidates,
  resolveAntigravityBrainDir,
  resolveAntigravityConversationCandidate,
  resolveAntigravityTranscriptFullPath,
} from './conversationStore.js';
import {
  pageAntigravityTranscriptLines,
  readAntigravityTranscriptLinesAfter,
} from './transcript/jsonl.js';
import {
  projectAntigravityTranscriptRecordGroupsToExternalItems,
  projectAntigravityTranscriptRecordsToExternalItems,
} from './transcript/mapper.js';

const SOURCE_KIND = 'antigravityCliPrint';

type CandidateCursorV2 = Readonly<{
  v: 2;
  kind: 'antigravityCandidateIndexScan';
  brainDir: string;
  sourceGeneration: string;
  directoryEntryOffset: number;
}>;

type AntigravityExternalReadAfterOutcome =
  | Readonly<{ kind: 'already_current'; cursor: string; sourceRevision: string }>
  | Readonly<{
      kind: 'advanced';
      items: ReturnType<typeof projectAntigravityTranscriptRecordsToExternalItems>;
      nextCursor: string;
      hasMore: boolean;
      sourceRevision: string;
      skippedPositions?: readonly number[];
      sourceDiagnostics?: readonly Readonly<{
        code: 'malformed_source_utf8';
        count: number;
        positions: readonly number[];
      }>[];
    }>
  | Readonly<{ kind: 'gap_or_cursor_expired'; sourceRevision?: string }>
  | Readonly<{ kind: 'source_replaced'; sourceRevision: string }>
  | Readonly<{ kind: 'source_unavailable' }>
  | Readonly<{ kind: 'read_failed'; error: string }>;

function ok<T>(value: T): AgentExternalSessionsResult<T> {
  return { ok: true, value };
}

function failed(
  code: AgentExternalSessionsFailureCode,
  message?: string,
  retryable?: boolean,
): AgentExternalSessionsResult<never> {
  return {
    ok: false,
    code,
    ...(message ? { message } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function invocationFailure(
  invocation: AgentExternalSessionsInvocation,
): AgentExternalSessionsResult<never> | null {
  if (invocation.signal.aborted) return failed('cancelled');
  if (Date.now() >= invocation.deadlineAtMs) return failed('timeout', undefined, true);
  if (!Number.isFinite(invocation.maxSerializedBytes) || invocation.maxSerializedBytes < 1) {
    return failed('invalid_request');
  }
  return null;
}

function boundedResult<T>(
  invocation: AgentExternalSessionsInvocation,
  result: AgentExternalSessionsResult<T>,
): AgentExternalSessionsResult<T> {
  return serializedByteLength(result) <= invocation.maxSerializedBytes
    ? result
    : failed('invalid_request');
}

function readString(value: AgentExternalSessionLinkDataValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function encodeCandidateCursor(cursor: CandidateCursorV2): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCandidateCursor(raw: string | undefined): CandidateCursorV2 | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.v === 2
      && record.kind === 'antigravityCandidateIndexScan'
      && typeof record.brainDir === 'string'
      && typeof record.sourceGeneration === 'string'
      && record.sourceGeneration.length > 0
      && Number.isSafeInteger(record.directoryEntryOffset)
      && (record.directoryEntryOffset as number) > 0
      ? {
          v: 2,
          kind: 'antigravityCandidateIndexScan',
          brainDir: record.brainDir,
          sourceGeneration: record.sourceGeneration,
          directoryEntryOffset: record.directoryEntryOffset as number,
        }
      : null;
  } catch {
    return null;
  }
}

async function validateSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: Readonly<Record<string, string | undefined>>;
}>): Promise<AgentExternalSessionsResult<Readonly<{
  brainDir: string;
  source: AgentExternalSessionSource;
}>>> {
  if (params.source.kind !== SOURCE_KIND) return failed('source_invalid', 'provider/source mismatch');
  const configuredBrainDir = await canonicalizePath(resolveAntigravityBrainDir(params.env));
  const requestedBrainDir = readString(params.source.brainDir);
  if (Object.hasOwn(params.source, 'brainDir') && !requestedBrainDir) {
    return failed('source_invalid', 'Antigravity brain directory must be a nonempty string.');
  }
  if (requestedBrainDir && await canonicalizePath(requestedBrainDir) !== configuredBrainDir) {
    return failed('source_invalid', 'Antigravity brain directory does not match the configured source.');
  }
  return ok({
    brainDir: configuredBrainDir,
    source: { kind: SOURCE_KIND, brainDir: configuredBrainDir },
  });
}

function validateResolvedSourceIdentity(
  source: AgentExternalSessionSource,
  remoteSessionId: string,
): AgentExternalSessionsResult<never> | null {
  const sourceConversationId = readString(source.conversationId);
  if (Object.hasOwn(source, 'conversationId') && !sourceConversationId) {
    return failed('source_invalid', 'Antigravity source conversation identity is invalid.');
  }
  if (sourceConversationId && sourceConversationId !== remoteSessionId) {
    return failed('source_invalid', 'Antigravity source conversation identity does not match the request.');
  }
  if (Object.hasOwn(source, 'sourceRevision') && !readString(source.sourceRevision)) {
    return failed('source_invalid', 'Antigravity source revision is invalid.');
  }
  return null;
}

function readSourceRevision(
  source: AgentExternalSessionSource,
  linkData?: AgentExternalSessionLinkData,
): string | null {
  return readString(linkData?.sourceRevision) ?? readString(source.sourceRevision);
}

function toResolvedSource(params: Readonly<{
  brainDir: string;
  conversationId: string;
  sourceRevision: string;
}>): AgentExternalSessionSource {
  return {
    kind: SOURCE_KIND,
    brainDir: params.brainDir,
    conversationId: params.conversationId,
    sourceRevision: params.sourceRevision,
  };
}

function toCandidate(candidate: Readonly<{
  conversationId: string;
  sourceRevision: string;
  updatedAtMs: number;
}>): AgentExternalSessionCandidate {
  return {
    remoteSessionId: candidate.conversationId,
    updatedAtMs: candidate.updatedAtMs,
    linkData: { sourceRevision: candidate.sourceRevision },
  };
}

async function resolveIdentity(params: Readonly<{
  brainDir: string;
  remoteSessionId: string;
  expectedSourceRevision?: string | null;
}>): Promise<AgentExternalSessionsResult<Readonly<{
  source: AgentExternalSessionSource;
  remoteSessionId: string;
  linkData: AgentExternalSessionLinkData;
  transcriptPath: string;
}>>> {
  const candidate = await resolveAntigravityConversationCandidate({
    brainDir: params.brainDir,
    conversationId: params.remoteSessionId,
  });
  if (!candidate || (
    params.expectedSourceRevision
    && candidate.sourceRevision !== params.expectedSourceRevision
  )) {
    return failed('candidate_not_found', 'Antigravity conversation was not found or was replaced.');
  }
  return ok({
    source: toResolvedSource({
      brainDir: params.brainDir,
      conversationId: candidate.conversationId,
      sourceRevision: candidate.sourceRevision,
    }),
    remoteSessionId: candidate.conversationId,
    linkData: { sourceRevision: candidate.sourceRevision },
    transcriptPath: candidate.transcriptPath,
  });
}

async function resolveTranscriptReadTarget(params: Readonly<{
  brainDir: string;
  source: AgentExternalSessionSource;
  remoteSessionId: string;
}>): Promise<AgentExternalSessionsResult<Readonly<{
  transcriptPath: string;
  sourceRevision: string;
}>>> {
  const sourceRevision = readSourceRevision(params.source);
  if (sourceRevision) {
    if (!isSafeAntigravityConversationId(params.remoteSessionId)) {
      return failed('source_invalid', 'Antigravity conversation identity is invalid.');
    }
    return ok({
      transcriptPath: resolveAntigravityTranscriptFullPath(
        params.brainDir,
        params.remoteSessionId,
      ),
      sourceRevision,
    });
  }
  const resolved = await resolveIdentity({
    brainDir: params.brainDir,
    remoteSessionId: params.remoteSessionId,
  });
  return resolved.ok
    ? ok({
        transcriptPath: resolved.value.transcriptPath,
        sourceRevision: String(resolved.value.linkData.sourceRevision),
      })
    : resolved;
}

export async function readAntigravityExternalTranscriptAfter(params: Readonly<{
  transcriptPath: string;
  conversationId: string;
  sourceRevision: string;
  cursor: string;
  maxItems: number;
  maxBytes: number;
}>): Promise<AntigravityExternalReadAfterOutcome> {
  const outcome = await readAntigravityTranscriptLinesAfter({
    path: params.transcriptPath,
    conversationId: params.conversationId,
    sourceRevision: params.sourceRevision,
    cursor: params.cursor,
    maxItems: params.maxItems,
    maxBytes: params.maxBytes,
  });
  if (outcome.kind !== 'advanced') return outcome;
  const groups = projectAntigravityTranscriptRecordGroupsToExternalItems({
    conversationId: params.conversationId,
    records: outcome.records,
  });
  const items = groups.flatMap((group) => group.items);
  const skippedPositions = groups
    .filter((group) => group.items.length === 0)
    .map((group) => group.startOffsetBytes);
  return {
    kind: 'advanced',
    items,
    nextCursor: outcome.nextCursor,
    hasMore: outcome.hasMore,
    sourceRevision: outcome.sourceRevision,
    ...(outcome.sourceDiagnostics === undefined
      ? {}
      : { sourceDiagnostics: outcome.sourceDiagnostics }),
    ...(skippedPositions.length > 0
      ? { skippedPositions }
      : {}),
  };
}

function mapReadAfterOutcome(
  outcome: AntigravityExternalReadAfterOutcome,
): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> {
  switch (outcome.kind) {
    case 'already_current':
      return ok({ outcome: 'already_current' });
    case 'advanced':
      return ok({
        outcome: 'advanced',
        items: outcome.items,
        nextCursor: outcome.nextCursor,
        boundary: outcome.items.at(-1)?.id ?? outcome.nextCursor,
        ...(outcome.sourceDiagnostics || outcome.skippedPositions
          ? {
              diagnostics: [
                ...(outcome.sourceDiagnostics ?? []),
                ...(outcome.skippedPositions
                  ? [{
                      code: 'unsupported_record_skipped',
                      count: outcome.skippedPositions.length,
                      positions: outcome.skippedPositions.slice(0, 200),
                    }]
                  : []),
              ],
            }
          : {}),
      });
    case 'gap_or_cursor_expired':
      return ok({ outcome: 'gap_or_cursor_expired' });
    case 'source_replaced':
      return ok({ outcome: 'source_replaced' });
    case 'source_unavailable':
      return ok({ outcome: 'source_unavailable' });
    case 'read_failed':
      return ok({ outcome: 'read_failed' });
  }
}

export function createAntigravityExternalSessionsContribution(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
}> = {}): AgentExternalSessionsContribution {
  const readEnv = () => params.env ?? process.env;

  return Object.freeze({
    async resolveSource(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      return boundedResult(request, ok({ source: validation.value.source }));
    },

    async listCandidates(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) return failed('invalid_request');
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const decoded = request.cursor ? decodeCandidateCursor(request.cursor) : null;
      if (request.cursor && (!decoded || decoded.brainDir !== validation.value.brainDir)) {
        return failed('invalid_request', 'Invalid Antigravity candidate cursor.');
      }
      try {
        const page = await pageAntigravityConversationCandidates({
          brainDir: validation.value.brainDir,
          afterDirectoryEntryOffset: decoded?.directoryEntryOffset,
          expectedSourceGeneration: decoded?.sourceGeneration,
          maxItems: request.maxItems,
          signal: request.signal,
        });
        const searchTerm = request.searchTerm?.trim().toLowerCase() ?? '';
        const filtered = searchTerm
          ? page.candidates.filter((candidate) => candidate.conversationId.toLowerCase().includes(searchTerm))
          : page.candidates;
        const candidates: AgentExternalSessionCandidate[] = [];
        for (let index = 0; index < filtered.length; index += 1) {
          const candidate = filtered[index];
          if (!candidate) continue;
          const mapped = toCandidate(candidate);
          const hasMore = index < filtered.length - 1 || page.nextDirectoryEntryOffset !== null;
          const nextCursor = hasMore
            ? encodeCandidateCursor({
                v: 2,
                kind: 'antigravityCandidateIndexScan',
                brainDir: validation.value.brainDir,
                sourceGeneration: page.sourceGeneration ?? '',
                directoryEntryOffset: candidate.directoryEntryOffset,
              })
            : null;
          const proposed = ok({
            candidates: [...candidates, mapped],
            nextCursor,
            ...(searchTerm ? { searchIncomplete: true } : {}),
          });
          if (serializedByteLength(proposed) > request.maxSerializedBytes) {
            if (candidates.length === 0) return failed('invalid_request');
            const lastAcceptedCandidate = filtered[index - 1];
            if (!lastAcceptedCandidate || !page.sourceGeneration) return failed('invalid_request');
            return ok({
              candidates,
              nextCursor: encodeCandidateCursor({
                v: 2,
                kind: 'antigravityCandidateIndexScan',
                brainDir: validation.value.brainDir,
                sourceGeneration: page.sourceGeneration,
                directoryEntryOffset: lastAcceptedCandidate.directoryEntryOffset,
              }),
              ...(searchTerm ? { searchIncomplete: true } : {}),
            });
          }
          candidates.push(mapped);
        }
        const result = ok({
          candidates,
          nextCursor: page.nextDirectoryEntryOffset !== null && page.sourceGeneration
            ? encodeCandidateCursor({
                v: 2,
                kind: 'antigravityCandidateIndexScan',
                brainDir: validation.value.brainDir,
                sourceGeneration: page.sourceGeneration,
                directoryEntryOffset: page.nextDirectoryEntryOffset,
              })
            : null,
          ...(searchTerm ? { searchIncomplete: true } : {}),
        });
        return boundedResult(request, result);
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        if (error instanceof AntigravityCandidateSourceChangedError) {
          return boundedResult(request, failed('source_invalid', error.message, true));
        }
        return boundedResult(request, failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Antigravity candidate listing failed.',
          true,
        ));
      }
    },

    async resolveLinkIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const resolved = await resolveIdentity({
        brainDir: validation.value.brainDir,
        remoteSessionId: request.remoteSessionId,
        expectedSourceRevision: readSourceRevision(request.source, request.linkData),
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const { transcriptPath: _transcriptPath, ...identity } = resolved.value;
      return boundedResult(request, ok(identity));
    },

    async resolveLinkedIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const sourceRevision = readSourceRevision(request.source, request.linkData);
      if (!sourceRevision) return failed('invalid_request', 'Antigravity link identity requires sourceRevision.');
      const resolved = await resolveIdentity({
        brainDir: validation.value.brainDir,
        remoteSessionId: request.remoteSessionId,
        expectedSourceRevision: sourceRevision,
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const { transcriptPath: _transcriptPath, ...identity } = resolved.value;
      return boundedResult(request, ok(identity));
    },

    async pageTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (request.direction !== 'older') return failed('unsupported');
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) return failed('invalid_request');
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const resolved = await resolveTranscriptReadTarget({
        brainDir: validation.value.brainDir,
        source: request.source,
        remoteSessionId: request.remoteSessionId,
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const outcome = await pageAntigravityTranscriptLines({
        path: resolved.value.transcriptPath,
        conversationId: request.remoteSessionId,
        sourceRevision: resolved.value.sourceRevision,
        cursor: request.cursor,
        maxItems: request.maxItems,
        maxBytes: request.maxSerializedBytes,
      });
      const after = invocationFailure(request);
      if (after) return after;
      if (outcome.kind === 'source_unavailable') return failed('unavailable', undefined, true);
      if (outcome.kind === 'read_failed') return boundedResult(request, failed('agent_error', outcome.error));
      if (outcome.kind === 'source_replaced') {
        return boundedResult(request, ok({ items: [], nextCursor: null, hasMore: false, truncated: true }));
      }
      if (outcome.kind === 'gap_or_cursor_expired') {
        return boundedResult(request, ok({
          items: [],
          nextCursor: null,
          tailCursor: outcome.tailCursor,
          hasMore: false,
          truncated: true,
        }));
      }
      const groups = projectAntigravityTranscriptRecordGroupsToExternalItems({
        conversationId: request.remoteSessionId,
        records: outcome.records,
      });
      const items = groups.flatMap((group) => group.items);
      if (items.length > request.maxItems) return failed('invalid_request');
      return boundedResult(request, ok({
        items,
        nextCursor: outcome.nextCursor,
        tailCursor: outcome.tailCursor,
        hasMore: outcome.hasMore,
      }));
    },

    async readAfterTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) return failed('invalid_request');
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const resolved = await resolveTranscriptReadTarget({
        brainDir: validation.value.brainDir,
        source: request.source,
        remoteSessionId: request.remoteSessionId,
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const outcome = await readAntigravityExternalTranscriptAfter({
        transcriptPath: resolved.value.transcriptPath,
        conversationId: request.remoteSessionId,
        sourceRevision: resolved.value.sourceRevision,
        cursor: request.cursor,
        maxItems: request.maxItems,
        maxBytes: request.maxSerializedBytes,
      });
      const after = invocationFailure(request);
      if (after) return after;
      if (outcome.kind === 'advanced' && outcome.items.length > request.maxItems) {
        return failed('invalid_request');
      }
      return boundedResult(request, mapReadAfterOutcome(outcome));
    },
  });
}

export const antigravityExternalSessionsContribution =
  createAntigravityExternalSessionsContribution();
