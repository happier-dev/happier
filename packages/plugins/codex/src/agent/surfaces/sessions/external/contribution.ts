import { isPluginError } from '@happier-dev/plugin-sdk';
import type {
  AgentExternalSessionLinkData,
  AgentExternalSessionSource,
  AgentExternalSessionsContribution,
  AgentExternalSessionsFailureCode,
  AgentExternalSessionsInvocation,
  AgentExternalSessionsReadAfterTranscriptResult,
  AgentExternalSessionsResult,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { canonicalizePath } from '@happier-dev/plugin-sdk/fs';
import { getAgentExternalSessionsInvocationFailure } from '@happier-dev/plugin-sdk/sessions/external';
import { CODEX_NATIVE_ACCOUNTING_SOURCE, readCodexNativeAccounting } from '../../../usage/nativeAccounting.js';
import { CodexNativeProxyUnavailableError } from './nativeProxy.js';
import { hydrateCodexCandidateMetadata } from './candidateMetadata.js';

import {
  canonicalizeCodexHomePath,
  homeEntries,
  resolveConfiguredCodexHomePath,
} from '../../../rollout/discovery/homeEntries.js';
import {
  normalizeCodexBackendMode,
  readExactCodexProviderSessionId,
} from '../../../../protocol/runtimeDescriptorV1.js';
import {
  CodexExternalSessionCandidateSourceChangedError,
  CodexExternalSessionNativeListingUnavailableError,
  listCodexSessionCandidates,
} from './candidateSource.js';
import {
  resolveCodexExternalSessionLinkIdentity,
  type CodexExternalSessionLinkIdentity,
} from './identity.js';
import {
  validateCodexExternalSessionsSourcePolicy,
} from './sourceValidation.js';
import {
  pageCodexExternalSessionTranscript,
  readAfterCodexExternalSessionTranscript,
  CodexExternalTranscriptSourceUnavailableError,
  CodexExternalTranscriptReadError,
} from './transcriptSource.js';
import {
  isCodexExternalSessionLinkDataValue,
  projectAgentExternalSessionSourceToCodex,
  projectCodexExternalSessionCandidateToAgent,
  projectCodexExternalSessionSourceToAgent,
  projectCodexExternalSessionTranscriptPageToAgent,
  type CodexExternalSessionSource,
  type CodexExternalSessionTranscriptSourcePage,
} from './models.js';

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

/** Only reader-owned location facts and exception identifiers enter file logs. */
function logTranscriptReadFailure(request: AgentExternalSessionsInvocation & Readonly<{ remoteSessionId: string }>,
  error: unknown, phase: 'pageTranscript' | 'readAfterTranscript') {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(record.code) ? record.code : undefined;
  const errno = typeof record?.errno === 'number' && Number.isSafeInteger(record.errno) ? record.errno : undefined;
  const location = error instanceof CodexExternalTranscriptReadError ? error : null;
  request.logger?.debug('[codex] Native transcript read failed', {
    exceptionClass: error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError'
      : error instanceof SyntaxError ? 'SyntaxError' : error instanceof Error ? 'Error' : 'Unknown',
    ...(code ? { code } : {}), ...(errno === undefined ? {} : { errno }),
    phase: location?.phase ?? phase, sourceItemId: request.remoteSessionId,
    byteOffset: location?.byteOffset ?? null, ...(location ? { fileBasename: location.fileBasename } : {}),
  });
}

function isSafeConnectedServiceId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function validateSource(params: Readonly<{
  source: unknown;
  env: NodeJS.ProcessEnv;
}>): AgentExternalSessionsResult<Readonly<{
  codexSource: CodexExternalSessionSource;
  publicSource: AgentExternalSessionSource;
}>> {
  const codexSource = projectAgentExternalSessionSourceToCodex(params.source);
  if (!codexSource) return failed('source_invalid', 'provider/source mismatch');
  const canonicalRequestedHomePath = typeof codexSource.homePath === 'string'
    && codexSource.homePath.trim().length > 0
    ? canonicalizeCodexHomePath(codexSource.homePath, params.env) || null
    : null;
  const validation = validateCodexExternalSessionsSourcePolicy({
    source: codexSource,
    configuredCodexHomePath: resolveConfiguredCodexHomePath(params.env),
    canonicalRequestedHomePath,
    isSafeConnectedServiceId,
  });
  if (!validation.ok) return failed('source_invalid', validation.error);
  return ok({
    codexSource: validation.source,
    publicSource: projectCodexExternalSessionSourceToAgent(validation.source),
  });
}

/**
 * The media read roots a source grants are the homes this Agent actually
 * resolves for it, never the value the request carried. `homeEntries` is that
 * single owner: for a connected source, the host has already admitted and
 * stamped the exact materialized home. The leaf only verifies that exact home
 * is readable, so it never turns a source path back into a daemon-root
 * authority.
 */
async function transcriptMediaReadRootsFor(params: Readonly<{
  source: CodexExternalSessionSource;
  env: NodeJS.ProcessEnv;
  invocation: AgentExternalSessionsInvocation;
}>): Promise<AgentExternalSessionsResult<readonly string[]>> {
  try {
    const entries = await homeEntries({
      source: params.source,
      env: params.env,
      signal: params.invocation.signal,
      deadlineAtMs: params.invocation.deadlineAtMs,
    });
    if (entries.length === 0) {
      return failed('unavailable', 'The selected Codex home is not available on this machine. Open a session with this account before searching its history.', true);
    }
    return ok(entries.map((entry) => entry.codexHome));
  } catch (error) {
    const stopped = getAgentExternalSessionsInvocationFailure(params.invocation);
    if (stopped) return stopped;
    return failed(
      'agent_unavailable',
      error instanceof Error ? error.message : 'Codex external-session home resolution failed.',
      true,
    );
  }
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitsResult(result: AgentExternalSessionsResult<unknown>, maxSerializedBytes: number | undefined): boolean {
  return maxSerializedBytes === undefined || serializedByteLength(result) <= maxSerializedBytes;
}

/**
 * Output overflow is not a malformed inbound request: the caller's byte bound is
 * well formed and only this Agent's own result overran it. It is reported as a
 * NONRETRYABLE `agent_error`, the same classification the host's
 * bounded-invocation owner applies when a leaf overruns the identical budget.
 */
function bounded<T>(
  value: T,
  maxSerializedBytes: number | undefined,
  message: string,
): AgentExternalSessionsResult<T> {
  const result = ok(value);
  return fitsResult(result, maxSerializedBytes)
    ? result
    : failed('agent_error', message, false);
}

function mapTranscriptPage(
  page: CodexExternalSessionTranscriptSourcePage,
): AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage> {
  const projected = projectCodexExternalSessionTranscriptPageToAgent(page);
  if (!projected) {
    return failed('agent_error', 'external_sessions_transcript_item_json');
  }
  return ok(projected);
}

function mapReadAfterPage(
  page: CodexExternalSessionTranscriptSourcePage,
): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> {
  if (page.readAfterOutcome) return ok({ outcome: page.readAfterOutcome });
  const mapped = mapTranscriptPage(page);
  if (!mapped.ok) return ok({ outcome: 'read_failed' });
  // A bounded nonempty read is ordinary pagination: an item/byte budget that
  // stopped before the source head leaves a valid continuation cursor, and the
  // host follow owner resumes immediately from it. `readAfterOutcome` above
  // remains the only gap/replacement voice; truncation alone never retroactively
  // invalidates the cursor the source just built.
  if (mapped.value.items.length === 0) {
    if ((!page.diagnostics?.length && !page.hasMore) || !mapped.value.nextCursor) {
      return ok({ outcome: 'already_current' });
    }
    return ok({
      outcome: 'advanced',
      items: [],
      nextCursor: mapped.value.nextCursor,
      boundary: mapped.value.nextCursor,
      hasMore: page.hasMore === true,
      ...(page.diagnostics?.length ? { diagnostics: page.diagnostics } : {}),
    });
  }
  if (!mapped.value.nextCursor) return ok({ outcome: 'read_failed' });
  return ok({
    outcome: 'advanced',
    items: mapped.value.items,
    nextCursor: mapped.value.nextCursor,
    boundary: mapped.value.items.at(-1)!.id,
    hasMore: mapped.value.truncated === true,
    ...(page.diagnostics?.length ? { diagnostics: page.diagnostics } : {}),
  });
}

async function readByteBoundedTranscript<T>(
  maxSerializedBytes: number,
  read: (maxBytes: number) => Promise<CodexExternalSessionTranscriptSourcePage>,
  map: (page: CodexExternalSessionTranscriptSourcePage) => AgentExternalSessionsResult<T>,
): Promise<AgentExternalSessionsResult<T>> {
  let maxBytes = maxSerializedBytes;
  for (;;) {
    const page = await read(maxBytes);
    const result = map(page);
    const bytes = serializedByteLength(result);
    if (bytes <= maxSerializedBytes) return result;
    // The native selector budgets items; the public boundary also carries
    // opaque continuation/tail cursors. Re-page the same source frontier with
    // its measured envelope cost reserved, preserving every unreturned item.
    if (page.items.length <= 1) return failed('agent_error', 'external_sessions_transcript_page_byte_budget', false);
    const itemBytes = page.items.reduce((total, item) => total + serializedByteLength(item), 0);
    maxBytes = Math.min(maxBytes - 1, maxSerializedBytes - (bytes - itemBytes));
    if (maxBytes <= 0) return failed('agent_error', 'external_sessions_transcript_page_byte_budget', false);
  }
}

function readLinkSource(linkData: AgentExternalSessionLinkData | undefined): CodexExternalSessionSource | null {
  return projectAgentExternalSessionSourceToCodex(linkData?.source);
}

function readRuntimeDescriptor(linkData: AgentExternalSessionLinkData | undefined): unknown {
  return linkData?.runtimeDescriptorV1;
}

function buildIdentityLinkData(params: Readonly<{
  source: AgentExternalSessionSource;
  runtimeDescriptor?: CodexExternalSessionLinkIdentity['runtimeDescriptor'];
  codexBackendMode?: string | null;
}>): AgentExternalSessionLinkData {
  return {
    source: params.source,
    ...(params.runtimeDescriptor && isCodexExternalSessionLinkDataValue(params.runtimeDescriptor, new Set())
      ? { runtimeDescriptorV1: params.runtimeDescriptor }
      : {}),
    ...(params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : {}),
  };
}

export function createCodexExternalSessionsContribution(params: Readonly<{
  env?: NodeJS.ProcessEnv;
}> = {}): AgentExternalSessionsContribution {
  const readEnv = () => params.env ?? process.env;

  const resolveIdentity = async (
    request: Readonly<{
      source: AgentExternalSessionSource;
      remoteSessionId: string;
      linkData?: AgentExternalSessionLinkData;
    }> & AgentExternalSessionsInvocation,
  ) => {
    const stopped = getAgentExternalSessionsInvocationFailure(request);
    if (stopped) return stopped;
    // Codex minted this id; the resolved link identity keeps its exact bytes.
    const remoteSessionId = readExactCodexProviderSessionId(request.remoteSessionId);
    if (!remoteSessionId) return failed('invalid_request', 'Codex remote session id must be non-empty.');
    const env = readEnv();
    const requestedSource = readLinkSource(request.linkData) ?? request.source;
    const validation = validateSource({ source: requestedSource, env });
    if (!validation.ok) return validation;
    const hasCodexBackendMode = request.linkData !== undefined
      && Object.hasOwn(request.linkData, 'codexBackendMode');
    const codexBackendMode = hasCodexBackendMode
      ? normalizeCodexBackendMode(request.linkData?.codexBackendMode)
      : null;
    if (hasCodexBackendMode && !codexBackendMode) {
      return failed('source_invalid', 'codex_backend_mode_unsupported');
    }
    const identity = resolveCodexExternalSessionLinkIdentity({
      remoteSessionId,
      source: validation.value.codexSource,
      runtimeDescriptor: readRuntimeDescriptor(request.linkData),
      ...(codexBackendMode ? { metadata: { codexBackendMode } } : {}),
    });
    const source = projectCodexExternalSessionSourceToAgent(identity.source);
    const identityBackendMode = typeof identity.externalSessionMetadata?.codexBackendMode === 'string'
      ? identity.externalSessionMetadata.codexBackendMode
      : null;
    const mediaReadRoots = await transcriptMediaReadRootsFor({
      source: identity.source,
      env,
      invocation: request,
    });
    if (!mediaReadRoots.ok) return mediaReadRoots;
    return bounded({
      source,
      remoteSessionId: identity.remoteSessionId,
      transcriptMediaReadRoots: mediaReadRoots.value,
      linkData: buildIdentityLinkData({
        source,
        runtimeDescriptor: identity.runtimeDescriptor,
        codexBackendMode: identityBackendMode,
      }),
    }, request.maxSerializedBytes, 'external_sessions_result_byte_budget');
  };

  return Object.freeze({
    readAccounting(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      return validation.ok ? readCodexNativeAccounting(request, validation.value.codexSource, env) : validation;
    },
    async resolveSource(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      const mediaReadRoots = await transcriptMediaReadRootsFor({
        source: validation.value.codexSource,
        env,
        invocation: request,
      });
      if (!mediaReadRoots.ok) return mediaReadRoots;
      if (request.includeAccountingSource === false) return bounded({
        source: validation.value.publicSource,
        transcriptMediaReadRoots: mediaReadRoots.value,
      }, request.maxSerializedBytes, 'external_sessions_result_byte_budget');
      // Materialized homes may link native history directories. The watcher
      // requires physical roots; both aliases must observe the same writes.
      const roots = [...new Set(await Promise.all(mediaReadRoots.value.flatMap((home) =>
        [join(home, 'sessions'), join(home, 'archived_sessions')]).map(canonicalizePath)))];
      const inventory = await discoverAgentAccountingJsonlSource(roots, request.signal);
      return bounded(
        {
          source: validation.value.publicSource,
          transcriptMediaReadRoots: mediaReadRoots.value,
          accountingSource: {
            accountingSources: [CODEX_NATIVE_ACCOUNTING_SOURCE],
            discoveredFileCount: inventory.files.length,
            ...(mediaReadRoots.value.length === 1 ? { rootPath: mediaReadRoots.value[0], rootField: 'homePath' } : {}),
            resourceKey: `codex:accounting:${createHash('sha256').update(JSON.stringify(roots)).digest('base64url')}`,
            changeObservation: 'watch_file_changes' as const,
            watchFileChanges: { files: [...inventory.files], topologyDirectories: [...inventory.topologyDirectories] },
          },
        },
        request.maxSerializedBytes,
        'external_sessions_result_byte_budget',
      );
    },

    async hydrateCandidates(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const candidates = await hydrateCodexCandidateMetadata({
          source: validation.value.codexSource, env, candidates: request.candidates, invocation: request,
        });
        const after = getAgentExternalSessionsInvocationFailure(request);
        return after ?? bounded({ candidates }, request.maxSerializedBytes, 'external_sessions_result_byte_budget');
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        throw error;
      }
    },

    async listCandidates(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Codex external-session candidate limit must be positive.');
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const listed = await listCodexSessionCandidates({
          logger: request.logger,
          source: validation.value.codexSource,
          env,
          cursor: request.cursor,
          limit: request.maxItems,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
          searchTarget: request.searchTarget,
          ripgrep: request.ripgrep,
          includeThreads: request.includeThreads,
          updatedAfterMs: request.updatedAfterMs,
          includeTitles: request.includeTitles,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
          scanDeadlineAtMs: request.scanDeadlineAtMs,
          exec: request.exec,
          resultBudget: {
            fits(page) {
              return fitsResult(ok({
                candidates: page.candidates.map(projectCodexExternalSessionCandidateToAgent),
                nextCursor: page.nextCursor,
                ...(page.searchIncomplete !== undefined ? { searchIncomplete: page.searchIncomplete } : {}),
                ...(page.preparation !== undefined ? { preparation: page.preparation } : {}),
                ...(page.contentCoverage !== undefined ? { contentCoverage: page.contentCoverage } : {}),
              }), request.maxSerializedBytes);
            },
          },
        });
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        return bounded({
          candidates: listed.candidates.map(projectCodexExternalSessionCandidateToAgent),
          nextCursor: listed.nextCursor,
          ...(listed.searchIncomplete !== undefined ? { searchIncomplete: listed.searchIncomplete } : {}),
          ...(listed.preparation !== undefined ? { preparation: listed.preparation } : {}),
          ...(listed.contentCoverage !== undefined ? { contentCoverage: listed.contentCoverage } : {}),
        }, request.maxSerializedBytes, 'external_sessions_result_byte_budget');
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        if (isPluginError(error) && error.code === 'JSONL_RECORD_TOO_LARGE') return failed('agent_error', error.message, false);
        if (error instanceof CodexExternalSessionCandidateSourceChangedError) {
          return failed('source_invalid', error.message);
        }
        if (error instanceof CodexExternalSessionNativeListingUnavailableError) {
          return failed('agent_unavailable', error.message, true);
        }
        // The rollout store was reachable but could not be read into a page:
        // an Agent fault, never evidence that Codex is missing.
        return failed(
          'agent_error',
          error instanceof TypeError ? 'external_sessions_operation_type_error'
            : error instanceof RangeError ? 'external_sessions_operation_range_error'
              : error instanceof SyntaxError ? 'external_sessions_operation_syntax_error' : 'external_sessions_operation_rejected',
          true,
        );
      }
    },

    resolveLinkIdentity(request) {
      return resolveIdentity(request);
    },

    resolveLinkedIdentity(request) {
      return resolveIdentity(request);
    },

    async pageTranscript(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Codex external-session transcript limit must be positive.');
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      if (request.direction === 'newer') {
        return failed('unsupported', 'Codex external-session newer paging is not supported.', false);
      }
      try {
        return await readByteBoundedTranscript(request.maxSerializedBytes, maxBytes => pageCodexExternalSessionTranscript({
          logger: request.logger,
          observation: request.observation,
          exec: request.exec,
          source: validation.value.codexSource,
          env,
          remoteSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
        }), mapTranscriptPage);
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        if (isPluginError(error) && error.code === 'JSONL_RECORD_TOO_LARGE') return failed('agent_error', error.message, false);
        if (error instanceof CodexExternalTranscriptSourceUnavailableError) return failed('candidate_not_found', 'Codex transcript source is no longer available.', false);
        if (error instanceof CodexNativeProxyUnavailableError) return failed('agent_unavailable', error.message, true);
        logTranscriptReadFailure(request, error, 'pageTranscript');
        return failed(
          'agent_error',
          'external_sessions_transcript_read_failed',
          true,
        );
      }
    },

    async readAfterTranscript(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Codex external-session transcript limit must be positive.');
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        return await readByteBoundedTranscript(request.maxSerializedBytes, maxBytes => readAfterCodexExternalSessionTranscript({
          logger: request.logger,
          observation: request.observation,
          exec: request.exec,
          source: validation.value.codexSource,
          env,
          remoteSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
        }), mapReadAfterPage);
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        if (isPluginError(error) && error.code === 'JSONL_RECORD_TOO_LARGE') return failed('agent_error', error.message, false);
        if (error instanceof CodexNativeProxyUnavailableError) return failed('agent_unavailable', error.message, true);
        logTranscriptReadFailure(request, error, 'readAfterTranscript');
        return ok({ outcome: 'read_failed' });
      }
    },

  });
}

export const codexExternalSessionsContribution: AgentExternalSessionsContribution = createCodexExternalSessionsContribution();
