import type {
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
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  listOhMyPiSessionCandidates,
  OhMyPiCandidateInvalidCursorError,
  OhMyPiCandidateResultBudgetTooSmallError,
  OhMyPiCandidateSourceChangedError,
} from './candidates.js';
import { resolveOhMyPiSessionFile } from './files.js';
import {
  OhMyPiExternalSessionInvalidCursorError,
  OhMyPiExternalSessionSourceChangedError,
  OhMyPiExternalSessionSourceUnavailableError,
  pageOhMyPiSessionTranscript,
  readAfterOhMyPiSessionTranscript,
} from './transcript.js';
import { validateOhMyPiExternalSessionSource } from './source.js';

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
    return failed('cancelled', 'Oh My Pi external-session operation was cancelled.');
  }
  if (Date.now() >= invocation.deadlineAtMs) {
    return failed('timeout', 'Oh My Pi external-session operation exceeded its deadline.', true);
  }
  if (!Number.isFinite(invocation.maxSerializedBytes) || invocation.maxSerializedBytes < 1) {
    return failed('invalid_request', 'Oh My Pi external-session result byte bound must be positive.');
  }
  return null;
}

function readOptionalString(value: AgentExternalSessionLinkDataValue | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toLegacySource(source: AgentExternalSessionSource): ExternalSessionsSource | null {
  if (source.kind !== 'ohMyPiAgentDir') return null;
  const agentDir = readOptionalString(source.agentDir);
  return {
    kind: 'ohMyPiAgentDir',
    ...(agentDir ? { agentDir } : {}),
  };
}

function toPublicSource(params: Readonly<{
  source: AgentExternalSessionSource;
  validatedSource: ExternalSessionsSource;
}>): AgentExternalSessionSource {
  const agentDir = params.validatedSource.kind === 'ohMyPiAgentDir'
    ? readOptionalString(
      params.validatedSource.agentDir as AgentExternalSessionLinkDataValue | undefined,
    )
    : null;
  return {
    ...params.source,
    kind: 'ohMyPiAgentDir',
    ...(agentDir ? { agentDir } : {}),
  };
}

function validateSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: NodeJS.ProcessEnv;
}>): AgentExternalSessionsResult<Readonly<{
  legacySource: ExternalSessionsSource;
  publicSource: AgentExternalSessionSource;
}>> {
  const legacySource = toLegacySource(params.source);
  if (!legacySource) {
    return failed('source_invalid', 'provider/source mismatch');
  }
  const validation = validateOhMyPiExternalSessionSource({
    source: legacySource,
    env: params.env,
  });
  if (!validation.ok) {
    return failed('source_invalid', validation.error);
  }
  return ok({
    legacySource: validation.source,
    publicSource: toPublicSource({
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
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isLinkDataValue(entry, nextAncestors));
  }
  if (!isPlainObject(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
    return false;
  }
  return Object.values(value).every((entry) => isLinkDataValue(entry, nextAncestors));
}

function isLinkData(value: unknown): value is AgentExternalSessionLinkData {
  return isPlainObject(value)
    && Reflect.ownKeys(value).every((key) => typeof key === 'string')
    && Object.values(value).every((entry) => isLinkDataValue(entry, new Set([value])));
}

function mapTranscriptItem(
  item: ExternalSessionTranscriptRawMessageV1,
): AgentExternalSessionTranscriptItem | null {
  if (!isLinkData(item.raw)) return null;
  return {
    id: item.id,
    createdAtMs: item.createdAtMs,
    ...(item.localId !== undefined ? { localId: item.localId } : {}),
    ...(item.messageRole !== undefined ? { messageRole: item.messageRole } : {}),
    raw: item.raw,
  };
}

function mapTranscriptPage(
  page: Readonly<{
    items: readonly ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    tailCursor?: string | null;
    hasMore?: boolean;
    truncated?: boolean;
  }>,
): AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage> {
  const items = page.items.map(mapTranscriptItem);
  if (items.some((item) => item === null)) {
    return failed('agent_error', 'Oh My Pi produced a transcript item outside the public JSON contract.');
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
    diagnostics?: readonly Readonly<{
      code: string;
      count: number;
      positions: readonly number[];
    }>[];
    skippedRecords?: readonly Readonly<{
      code: string;
      position: number;
    }>[];
  }>,
  inputCursor: string,
): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> {
  const mapped = mapTranscriptPage(page);
  if (!mapped.ok) return mapped;
  const positionsByCode = new Map<string, number[]>();
  for (const skipped of page.skippedRecords ?? []) {
    const positions = positionsByCode.get(skipped.code) ?? [];
    positions.push(skipped.position);
    positionsByCode.set(skipped.code, positions);
  }
  const diagnostics = [
    ...(page.diagnostics ?? []),
    ...[...positionsByCode].map(([code, positions]) => ({
      code,
      count: positions.length,
      positions: positions.slice(0, 200),
    })),
  ];
  if (mapped.value.items.length === 0 && diagnostics.length > 0) {
    if (!mapped.value.nextCursor) return ok({ outcome: 'read_failed' });
    return ok({
      outcome: 'advanced',
      items: [],
      nextCursor: mapped.value.nextCursor,
      boundary: mapped.value.nextCursor,
      diagnostics,
    });
  }
  if (mapped.value.items.length === 0) {
    if (mapped.value.truncated) return ok({ outcome: 'gap_or_cursor_expired' });
    return ok({
      outcome: mapped.value.nextCursor === inputCursor ? 'already_current' : 'read_failed',
    });
  }
  if (!mapped.value.nextCursor) return ok({ outcome: 'read_failed' });
  return ok({
    outcome: 'advanced',
    items: mapped.value.items,
    nextCursor: mapped.value.nextCursor,
    boundary: mapped.value.items.at(-1)!.id,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  });
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function transcriptFailure(error: unknown): AgentExternalSessionsResult<never> {
  if (error instanceof OhMyPiExternalSessionSourceChangedError) {
    return failed('unavailable', error.message, true);
  }
  if (error instanceof OhMyPiExternalSessionInvalidCursorError) {
    return failed('invalid_request', error.message);
  }
  return failed(
    'agent_unavailable',
    error instanceof Error ? error.message : 'Oh My Pi external-session transcript operation failed.',
    true,
  );
}

function mapCandidate(candidate: Readonly<{
  remoteSessionId: string;
  title?: string | null;
  updatedAtMs: number;
  createdAtMs?: number;
  archived?: boolean;
  details?: unknown;
}>) {
  const details = isPlainObject(candidate.details) ? candidate.details : null;
  const sessionFilePath = typeof details?.sessionFilePath === 'string'
    ? details.sessionFilePath
    : null;
  return {
    remoteSessionId: candidate.remoteSessionId,
    ...(candidate.title ? { title: candidate.title } : {}),
    updatedAtMs: candidate.updatedAtMs,
    ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
    ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}),
    ...(sessionFilePath ? { linkData: { sessionFilePath } } : {}),
  };
}

function withoutCandidateTitles(
  candidates: readonly ReturnType<typeof mapCandidate>[],
): readonly ReturnType<typeof mapCandidate>[] {
  return candidates.map(({ title: _discardedTitle, ...candidate }) => candidate);
}

function readSessionFilePath(linkData: AgentExternalSessionLinkData | undefined): string | null {
  return readOptionalString(linkData?.sessionFilePath);
}

export function createOhMyPiExternalSessionsContribution(params: Readonly<{
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
        return failed('invalid_request', 'Oh My Pi external-session candidate limit must be positive.');
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const listed = await listOhMyPiSessionCandidates({
          source: validation.value.legacySource,
          env,
          cursor: request.cursor,
          limit: request.maxItems,
          searchTerm: request.searchTerm,
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
        const value = {
          candidates: listed.candidates.map(mapCandidate),
          nextCursor: listed.nextCursor,
          ...(listed.searchIncomplete !== undefined
            ? { searchIncomplete: listed.searchIncomplete }
            : {}),
          ...(listed.preparation !== undefined ? { preparation: listed.preparation } : {}),
        };
        const result = ok(value);
        if (serializedByteLength(result) <= request.maxSerializedBytes) return result;
        const withoutTitles = ok({
          ...value,
          candidates: withoutCandidateTitles(value.candidates),
        });
        return serializedByteLength(withoutTitles) <= request.maxSerializedBytes
          ? withoutTitles
          : failed('invalid_request', 'Oh My Pi candidate result byte budget cannot fit the page envelope.');
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        if (error instanceof OhMyPiCandidateSourceChangedError) {
          return failed('source_invalid', error.message, true);
        }
        if (
          error instanceof OhMyPiCandidateInvalidCursorError
          || error instanceof OhMyPiCandidateResultBudgetTooSmallError
        ) {
          return failed('invalid_request', error.message);
        }
        return failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Oh My Pi external-session listing failed.',
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
      try {
        const resolved = await resolveOhMyPiSessionFile({
          source: validation.value.legacySource,
          env,
          remoteSessionId: request.remoteSessionId,
          sessionFilePath: readSessionFilePath(request.linkData),
        });
        const after = invocationFailure(request);
        if (after) return after;
        if (!resolved) {
          return failed('candidate_not_found', 'Oh My Pi external-session candidate was not found.');
        }
        return ok({
          source: {
            ...validation.value.publicSource,
            sessionFilePath: resolved.filePath,
          },
          remoteSessionId: request.remoteSessionId,
          linkData: { sessionFilePath: resolved.filePath },
        });
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        return failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Oh My Pi external-session identity resolution failed.',
          true,
        );
      }
    },

    async resolveLinkedIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const sessionFilePath = readSessionFilePath(request.linkData);
      if (!sessionFilePath) {
        return failed('invalid_request', 'Oh My Pi linked identity requires a sessionFilePath.');
      }
      return await this.resolveLinkIdentity({
        ...request,
        linkData: { sessionFilePath },
      });
    },

    async pageTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Oh My Pi external-session transcript limit must be positive.');
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const page = await pageOhMyPiSessionTranscript({
          source: validation.value.legacySource,
          env,
          providerSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          sessionFilePath: readOptionalString(request.source.sessionFilePath),
        });
        const after = invocationFailure(request);
        if (after) return after;
        const mapped = mapTranscriptPage(page);
        return serializedByteLength(mapped) <= request.maxSerializedBytes
          ? mapped
          : failed('invalid_request', 'Oh My Pi transcript result byte budget cannot fit the page envelope.');
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        return transcriptFailure(error);
      }
    },

    async readAfterTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Oh My Pi external-session transcript limit must be positive.');
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const page = await readAfterOhMyPiSessionTranscript({
          source: validation.value.legacySource,
          env,
          providerSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          sessionFilePath: readOptionalString(request.source.sessionFilePath),
        });
        const after = invocationFailure(request);
        if (after) return after;
        const mapped = mapReadAfterPage(page, request.cursor);
        return serializedByteLength(mapped) <= request.maxSerializedBytes
          ? mapped
          : failed('invalid_request', 'Oh My Pi transcript result byte budget cannot fit the page envelope.');
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        if (error instanceof OhMyPiExternalSessionSourceUnavailableError) {
          return ok({ outcome: 'source_unavailable' });
        }
        if (error instanceof OhMyPiExternalSessionSourceChangedError) {
          return ok({ outcome: 'source_replaced' });
        }
        if (error instanceof OhMyPiExternalSessionInvalidCursorError) {
          return ok({ outcome: 'gap_or_cursor_expired' });
        }
        return ok({ outcome: 'read_failed' });
      }
    },
  });
}

export const ohMyPiExternalSessionsContribution = createOhMyPiExternalSessionsContribution();
