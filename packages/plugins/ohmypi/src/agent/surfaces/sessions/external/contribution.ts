import { isPluginError } from '@happier-dev/plugin-sdk';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import {
  createExternalSessionContentSearchControl,
  discoverAgentAccountingJsonlSource,
  searchExternalSessionContent,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import {
  AgentExternalSessionTranscriptRawRecordSchema,
  compareExternalSessionCandidatePrecedence,
  getAgentExternalSessionsInvocationFailure as invocationFailure,
} from '@happier-dev/plugin-sdk/sessions/external';
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
  listOhMyPiSessionCandidates,
  OhMyPiCandidateInvalidCursorError,
  OhMyPiCandidateResultBudgetTooSmallError,
  OhMyPiCandidateSourceChangedError,
  type OhMyPiExternalSessionCandidate,
} from './candidates.js';
import { resolveOhMyPiSessionFile, resolveOhMyPiSessionsRoot } from './files.js';
import {
  OhMyPiExternalSessionIncompleteBranchError,
  OhMyPiExternalSessionInvalidCursorError,
  OhMyPiExternalSessionSourceChangedError,
  OhMyPiExternalSessionSourceUnavailableError,
  pageOhMyPiSessionTranscript,
  readAfterOhMyPiSessionTranscript,
  type OhMyPiRawTranscriptPage,
} from './transcript.js';
import {
  projectOhMyPiExternalSessionSource,
  validateOhMyPiExternalSessionSource,
  type OhMyPiExternalSessionSource,
} from './source.js';

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

function readOptionalString(value: AgentExternalSessionLinkDataValue | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toPublicSource(params: Readonly<{
  source: AgentExternalSessionSource;
  validatedSource: OhMyPiExternalSessionSource;
}>): AgentExternalSessionSource {
  const agentDir = params.validatedSource.kind === 'ohMyPiAgentDir'
    ? readOptionalString(
      params.validatedSource.agentDir as AgentExternalSessionLinkDataValue | undefined,
    )
    : null;
  return {
    kind: 'ohMyPiAgentDir',
    ...(agentDir ? { agentDir } : {}),
  };
}

function validateSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: NodeJS.ProcessEnv;
}>): AgentExternalSessionsResult<Readonly<{
  legacySource: OhMyPiExternalSessionSource;
  publicSource: AgentExternalSessionSource;
}>> {
  const legacySource = projectOhMyPiExternalSessionSource(params.source);
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

type OhMyPiContentSearchProgress = {
  filePath: string;
  sourceIdentity: string;
  maxItems: number;
  maxSerializedBytes: number;
  page: NonNullable<Parameters<typeof searchExternalSessionContent>[0]['pageProgress']>;
};

function readContentSearchProgress(value: unknown): OhMyPiContentSearchProgress | null {
  if (!isPlainObject(value) || typeof value.filePath !== 'string' || !value.filePath
    || typeof value.sourceIdentity !== 'string' || !value.sourceIdentity
    || typeof value.maxItems !== 'number' || !Number.isSafeInteger(value.maxItems) || value.maxItems < 1
    || typeof value.maxSerializedBytes !== 'number' || !Number.isSafeInteger(value.maxSerializedBytes) || value.maxSerializedBytes < 1
    || !isPlainObject(value.page)) return null;
  const page = value.page;
  if (typeof page.complete !== 'boolean' || typeof page.itemCount !== 'number'
    || !Number.isSafeInteger(page.itemCount) || page.itemCount < 0
    || (page.cursor !== undefined && (typeof page.cursor !== 'string' || !page.cursor))) return null;
  const match = page.match;
  let parsedMatch: OhMyPiContentSearchProgress['page']['match'] = null;
  if (match !== null) {
    if (!isPlainObject(match) || typeof match.id !== 'string' || !match.id
      || (match.cursor !== undefined && (typeof match.cursor !== 'string' || !match.cursor))
      || typeof match.distanceFromEnd !== 'number' || !Number.isSafeInteger(match.distanceFromEnd)
      || match.distanceFromEnd < 1 || match.distanceFromEnd > page.itemCount) return null;
    parsedMatch = {
      ...(typeof match.cursor === 'string' ? { cursor: match.cursor } : {}),
      id: match.id,
      distanceFromEnd: match.distanceFromEnd,
    };
  }
  return {
    filePath: value.filePath,
    sourceIdentity: value.sourceIdentity,
    maxItems: value.maxItems,
    maxSerializedBytes: value.maxSerializedBytes,
    page: {
      ...(typeof page.cursor === 'string' ? { cursor: page.cursor } : {}),
      complete: page.complete,
      itemCount: page.itemCount,
      match: parsedMatch,
    },
  };
}

async function readContentSourceIdentity(filePath: string): Promise<string> {
  const metadata = await stat(filePath, { bigint: true }).catch(() => null);
  if (!metadata?.isFile()) throw new OhMyPiCandidateSourceChangedError('Oh My Pi transcript is unavailable during content search.');
  return [metadata.dev, metadata.ino, metadata.birthtimeNs, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
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

/**
 * Admits one projected row into the canonical transcript raw-record contract.
 * `isLinkData` keeps the row inside the public JSON contract; the schema then
 * admits the `{ role, content }` envelope every transcript reader parses, so a
 * row neither check accepts fails the page here instead of reaching a reader
 * that cannot render it.
 */
function mapTranscriptItem(
  item: OhMyPiRawTranscriptPage['items'][number],
): AgentExternalSessionTranscriptItem | null {
  if (!isLinkData(item.raw)) return null;
  const parsedRaw = AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw);
  if (!parsedRaw.success) return null;
  return {
    id: item.id,
    createdAtMs: item.createdAtMs,
    ...(item.localId !== undefined ? { localId: item.localId } : {}),
    raw: parsedRaw.data,
    ...(item.messageRole !== undefined ? { messageRole: item.messageRole } : {}),
  };
}

function mapTranscriptPage(
  page: Readonly<{
    items: OhMyPiRawTranscriptPage['items'];
    nextCursor: string | null;
    tailCursor?: string | null;
    hasMore?: boolean;
    truncated?: boolean;
    diagnostics?: AgentExternalSessionsTranscriptPage['diagnostics'];
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
    ...(page.diagnostics?.length ? { diagnostics: page.diagnostics } : {}),
  });
}

function mapReadAfterPage(
  page: Parameters<typeof mapTranscriptPage>[0] & Readonly<{
    diagnostics?: readonly Readonly<{
      code: string;
      severity: 'benign' | 'required';
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
      severity: code === 'non_transcript_record_skipped' ? 'benign' as const : 'required' as const,
      count: positions.length,
      positions: positions.slice(0, 200),
    })),
  ];
  // A bounded JSONL stop is ordinary pagination, not a discontinuity: every
  // real discontinuity (source replacement, branch change, in-place rewrite)
  // is already a typed error the source throws before a page exists, and this
  // page always carries the exact continuation cursor for what it served.
  // Reporting a bounded stop as a gap would make the host follow owner discard
  // a cursor the source just advanced and re-read the suffix as a fresh gap.
  if (mapped.value.items.length === 0 && diagnostics.length > 0) {
    if (!mapped.value.nextCursor) return ok({ outcome: 'read_failed' });
    return ok({
      outcome: 'advanced',
      items: [],
      nextCursor: mapped.value.nextCursor,
      boundary: mapped.value.nextCursor,
      hasMore: false,
      diagnostics,
    });
  }
  if (mapped.value.items.length === 0) {
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
    hasMore: mapped.value.truncated === true,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  });
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function transcriptFailure(error: unknown): AgentExternalSessionsResult<never> {
  if (isPluginError(error) && error.code === 'JSONL_RECORD_TOO_LARGE') return failed('agent_error', error.message, false);
  if (error instanceof OhMyPiExternalSessionSourceUnavailableError) {
    return failed('source_unreachable', error.message, true);
  }
  if (error instanceof OhMyPiExternalSessionSourceChangedError) {
    return failed('unavailable', error.message, true);
  }
  if (error instanceof OhMyPiExternalSessionInvalidCursorError) {
    return failed('invalid_request', error.message);
  }
  // Not retryable: the source is intact and its branch is genuinely rootless.
  if (error instanceof OhMyPiExternalSessionIncompleteBranchError) {
    return failed('agent_error', error.message, false);
  }
  // A readable-source fault the leaf did not classify (for example an
  // unreadable file) is an Agent fault, never evidence that the Agent is missing.
  return failed(
    'agent_error',
    error instanceof Error ? error.message : 'Oh My Pi external-session transcript operation failed.',
    true,
  );
}

function mapCandidate(candidate: Readonly<{
  remoteSessionId: string;
  title?: string | null;
  messageCount?: number;
  updatedAtMs: number;
  createdAtMs?: number;
  archived?: boolean;
  details?: unknown;
  match?: AgentExternalSessionCandidate['match'];
}>): AgentExternalSessionCandidate {
  const details = isPlainObject(candidate.details) ? candidate.details : null;
  const sessionFilePath = typeof details?.sessionFilePath === 'string'
    ? details.sessionFilePath
    : null;
  return {
    remoteSessionId: candidate.remoteSessionId,
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(typeof details?.workingDirectory === 'string' && details.workingDirectory.trim() ? { cwd: details.workingDirectory } : {}),
    ...(candidate.messageCount !== undefined ? { messageCount: candidate.messageCount } : {}),
    updatedAtMs: candidate.updatedAtMs,
    ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
    ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}),
    ...(sessionFilePath ? { linkData: { sessionFilePath } } : {}),
    ...(candidate.match ? { match: candidate.match } : {}),
  };
}

function withoutCandidateTitles(
  candidates: readonly ReturnType<typeof mapCandidate>[],
): readonly ReturnType<typeof mapCandidate>[] {
  return candidates.map(({ title: _discardedTitle, ...candidate }) => candidate);
}

function candidateResultFits(params: Readonly<{
  candidates: readonly ReturnType<typeof mapCandidate>[];
  nextCursor: string | null;
  searchIncomplete: boolean | undefined;
  maxSerializedBytes?: number;
  contentSearch?: boolean;
}>): boolean {
  return params.maxSerializedBytes === undefined || serializedByteLength(ok({
    candidates: params.candidates,
    nextCursor: params.nextCursor,
    ...(params.searchIncomplete !== undefined ? { searchIncomplete: params.searchIncomplete } : {}),
    ...(params.contentSearch ? { contentCoverage: 'complete' } : {}),
  })) <= params.maxSerializedBytes;
}

/**
 * A public ref has no private file path. Reuse this leaf's cursor-backed
 * candidate discovery, retain only the exact id's shared-precedence winner,
 * and discard it at the end of this invocation.
 */
async function resolveUnqualifiedOhMyPiCandidate(params: Readonly<{
  source: OhMyPiExternalSessionSource;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
  invocation: AgentExternalSessionsInvocation;
}>): Promise<OhMyPiExternalSessionCandidate | null> {
  let cursor: string | undefined;
  let winner: OhMyPiExternalSessionCandidate | null = null;
  do {
    params.invocation.signal.throwIfAborted();
    const listed = await listOhMyPiSessionCandidates({
      source: params.source,
      env: params.env,
      ...(cursor ? { cursor } : {}),
      limit: 50,
      searchTerm: params.remoteSessionId,
      signal: params.invocation.signal,
      resultBudget: {
        fits(candidates, nextCursor, searchIncomplete) {
          return candidateResultFits({
            candidates: candidates.map(mapCandidate),
            nextCursor,
            searchIncomplete,
            maxSerializedBytes: params.invocation.maxSerializedBytes,
          });
        },
      },
    });
    params.invocation.signal.throwIfAborted();
    for (const candidate of listed.candidates) {
      if (
        candidate.remoteSessionId === params.remoteSessionId
        && (
          !winner
          || compareExternalSessionCandidatePrecedence(
            mapCandidate(candidate),
            mapCandidate(winner),
          ) < 0
        )
      ) {
        winner = candidate;
      }
    }
    cursor = listed.nextCursor ?? undefined;
  } while (cursor);
  return winner;
}

/**
 * Candidate-supplied hint only. A candidate's `linkData` is a transient request
 * input; it never reaches session owner metadata.
 */
function readCandidateSessionFilePath(
  linkData: AgentExternalSessionLinkData | undefined,
): string | null {
  return readOptionalString(linkData?.sessionFilePath);
}

/**
 * The resolved session file travels on `source.sessionFilePath` — the carrier every
 * Oh My Pi read path (transcript paging, read-after, observation, takeover) already
 * uses, and the one the host persists inside `externalSessionV1.source`.
 *
 * It must NOT also travel on the resolved `linkData`: that record is persisted
 * only as the nested `externalSessionV1.linkData` vendor bag, so a duplicate
 * copy there would be a second, silently divergable carrier for the same fact.
 */
function readResolvedSessionFilePath(source: AgentExternalSessionSource): string | null {
  return readOptionalString(source.sessionFilePath);
}

export function createOhMyPiExternalSessionsContribution(params: Readonly<{
  env?: NodeJS.ProcessEnv;
}> = {}): AgentExternalSessionsContribution {
  const readEnv = () => params.env ?? process.env;

  return Object.freeze({
    async resolveSource(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const validation = validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return validation;
      if (request.includeAccountingSource === false) return ok({ source: validation.value.publicSource });
      const sessionsRoot = await resolveOhMyPiSessionsRoot({ source: validation.value.legacySource, env: readEnv() });
      const inventory = await discoverAgentAccountingJsonlSource([sessionsRoot], request.signal);
      return ok({ source: validation.value.publicSource, accountingSource: {
        rootPath: sessionsRoot,
        resourceKey: `ohmypi:transcripts:${createHash('sha256').update(sessionsRoot).digest('base64url')}`,
        changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files: [...inventory.files], topologyDirectories: [...inventory.topologyDirectories] },
      } });
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
      const contentSearch = request.searchTarget === 'content';
      const query = request.searchTerm ?? '';
      const sourceKey = JSON.stringify(validation.value.publicSource);
      let contentProgress: OhMyPiContentSearchProgress | null = null;
      const wrapCursor = (cursor: string | null) => contentSearch && cursor
        ? Buffer.from(JSON.stringify({ v: 1, kind: 'ohMyPiContentSearch', query, sourceKey, cursor,
          ...(contentProgress ? { progress: contentProgress } : {}) }), 'utf8').toString('base64url')
        : cursor;
      let cursor = request.cursor;
      if (contentSearch && cursor) {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { parsed = null; }
        if (!isPlainObject(parsed) || parsed.v !== 1 || parsed.kind !== 'ohMyPiContentSearch'
          || parsed.query !== query || parsed.sourceKey !== sourceKey || typeof parsed.cursor !== 'string') {
          return failed('invalid_request', 'Oh My Pi content cursor does not match this query and source.');
        }
        if (parsed.progress !== undefined) {
          contentProgress = readContentSearchProgress(parsed.progress);
          if (!contentProgress) return failed('invalid_request', 'Oh My Pi content cursor progress is invalid.');
        }
        cursor = parsed.cursor;
      }
      const control = contentSearch ? createExternalSessionContentSearchControl({
        signal: request.signal,
        deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs,
      }) : null;
      let partial = false;
      try {
        const listed = await listOhMyPiSessionCandidates({
          source: validation.value.legacySource,
          env,
          cursor,
          limit: request.maxItems,
          searchTerm: request.searchTerm,
          ...(request.updatedAfterMs === undefined ? {} : { updatedAfterMs: request.updatedAfterMs }),
          signal: request.signal,
          ...(control ? {
            async searchCandidate(candidate: OhMyPiExternalSessionCandidate) {
              const filePath = candidate.details.sessionFilePath;
              const resuming = contentProgress !== null;
              const sourceIdentity = await readContentSourceIdentity(filePath);
              if (contentProgress && (contentProgress.filePath !== filePath || contentProgress.sourceIdentity !== sourceIdentity)) {
                throw new OhMyPiCandidateSourceChangedError('Oh My Pi transcript changed during content search.');
              }
              const progress: OhMyPiContentSearchProgress = contentProgress ?? {
                filePath, sourceIdentity, maxItems: request.maxItems, maxSerializedBytes: request.maxSerializedBytes,
                page: { complete: false, itemCount: 0, match: null },
              };
              contentProgress = progress;
              // Commit native branch/byte pages before cooperative yield;
              // every read still observes actual cancellation.
              const nativeControl = createExternalSessionContentSearchControl({ signal: request.signal });
              const searched = await searchExternalSessionContent({
                query,
                ...(resuming ? {} : { paths: [filePath] }),
                ripgrep: request.ripgrep,
                control,
                pageProgress: progress.page,
                async decode(matchText, transcriptCursor) {
                  if (await readContentSourceIdentity(filePath) !== progress.sourceIdentity) {
                    throw new OhMyPiCandidateSourceChangedError('Oh My Pi transcript changed during content search.');
                  }
                  const page = await pageOhMyPiSessionTranscript({
                    source: validation.value.legacySource,
                    env,
                    providerSessionId: candidate.remoteSessionId,
                    sessionFilePath: filePath,
                    direction: 'older',
                    cursor: transcriptCursor,
                    maxBytes: progress.maxSerializedBytes,
                    maxItems: progress.maxItems,
                    scannerFileSystem: nativeControl.fileSystem,
                  });
                  if (await readContentSourceIdentity(filePath) !== progress.sourceIdentity) {
                    throw new OhMyPiCandidateSourceChangedError('Oh My Pi transcript changed during content search.');
                  }
                  return { records: page.items.map((item) => {
                    const content = isPlainObject(item.raw.content) ? item.raw.content : null;
                    const data = isPlainObject(content?.data) ? content.data : null;
                    const text = content?.type === 'text' ? content.text
                      : content?.type === 'acp' && data?.type === 'message' ? data.message : null;
                    const snippet = typeof text === 'string' ? matchText(text) : null;
                    return { id: item.id, ...(snippet === null ? {} : { snippet }) };
                  }), nextCursor: page.nextCursor, partial: page.truncated === true };
                },
              });
              contentProgress = null;
              partial ||= searched.partial;
              return searched.match ? { ...candidate, match: searched.match,
                ...(!searched.partial ? { messageCount: progress.page.itemCount } : {}) } : null;
            },
          } : {}),
          resultBudget: {
            fits(candidates, nextCursor, searchIncomplete) {
              return candidateResultFits({
                candidates: candidates.map(mapCandidate),
                nextCursor: wrapCursor(nextCursor),
                searchIncomplete,
                maxSerializedBytes: request.maxSerializedBytes,
                contentSearch,
              });
            },
          },
        });
        request.signal.throwIfAborted();
        const after = invocationFailure(request);
        if (after) return after;
        const value = {
          candidates: listed.candidates.map(mapCandidate),
          nextCursor: wrapCursor(listed.nextCursor),
          ...(contentSearch ? { contentCoverage: listed.nextCursor || partial ? 'partial' as const : 'complete' as const } : {}),
          ...(listed.searchIncomplete !== undefined
            ? { searchIncomplete: listed.searchIncomplete }
            : {}),
        };
        const result = ok(value);
        if (serializedByteLength(result) <= request.maxSerializedBytes) return result;
        const withoutTitles = ok({
          ...value,
          candidates: withoutCandidateTitles(value.candidates),
        });
        return serializedByteLength(withoutTitles) <= request.maxSerializedBytes
          ? withoutTitles
          : failed('agent_error', 'Oh My Pi candidate result byte budget cannot fit the page envelope.', false);
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        if (isPluginError(error) && error.code === 'JSONL_RECORD_TOO_LARGE') return failed('agent_error', error.message, false);
        if (error instanceof OhMyPiCandidateSourceChangedError) {
          return failed('source_invalid', error.message, true);
        }
        if (error instanceof OhMyPiCandidateInvalidCursorError) {
          return failed('invalid_request', error.message);
        }
        if (error instanceof OhMyPiCandidateResultBudgetTooSmallError) {
          return failed('agent_error', error.message, false);
        }
        return failed(
          'agent_error',
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
        const requestedSessionFilePath = readResolvedSessionFilePath(request.source)
          ?? readCandidateSessionFilePath(request.linkData);
        const candidate = requestedSessionFilePath
          ? null
          : await resolveUnqualifiedOhMyPiCandidate({
              source: validation.value.legacySource,
              env,
              remoteSessionId: request.remoteSessionId,
              invocation: request,
            });
        const sessionFilePath = requestedSessionFilePath
          ?? candidate?.details.sessionFilePath;
        if (!sessionFilePath) {
          return failed('candidate_not_found', 'Oh My Pi external-session candidate was not found.');
        }
        const resolved = await resolveOhMyPiSessionFile({
          source: validation.value.legacySource,
          env,
          remoteSessionId: request.remoteSessionId,
          sessionFilePath,
        });
        const after = invocationFailure(request);
        if (after) return after;
        if (!resolved.ok) {
          return failed('candidate_not_found', 'Oh My Pi external-session candidate was not found.');
        }
        return ok({
          source: {
            ...validation.value.publicSource,
            sessionFilePath: resolved.filePath,
          },
          remoteSessionId: request.remoteSessionId,
          linkData: {},
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
      if (!readResolvedSessionFilePath(request.source)) {
        return failed('invalid_request', 'Oh My Pi linked identity requires a source sessionFilePath.');
      }
      return await this.resolveLinkIdentity({ ...request, linkData: {} });
    },

    async pageTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Oh My Pi external-session transcript limit must be positive.');
      }
      if (request.direction !== 'older') {
        return failed('unsupported', 'Oh My Pi transcript paging supports only older pages.');
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
          : failed('agent_error', 'Oh My Pi transcript result byte budget cannot fit the page envelope.', false);
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
          : failed('agent_error', 'Oh My Pi transcript result byte budget cannot fit the page envelope.', false);
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        if (isPluginError(error) && error.code === 'JSONL_RECORD_TOO_LARGE') return failed('agent_error', error.message, false);
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

export const ohMyPiExternalSessionsContribution: AgentExternalSessionsContribution = createOhMyPiExternalSessionsContribution();
