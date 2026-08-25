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
import { getAgentExternalSessionsInvocationFailure } from '@happier-dev/plugin-sdk/sessions/external';

import {
  canonicalizeCodexHomePath,
  homeEntries,
  resolveConfiguredCodexHomePath,
} from '../../../rollout/discovery/homeEntries.js';
import { normalizeCodexBackendMode } from '../../../../protocol/runtimeDescriptorV1.js';
import {
  CodexExternalSessionCandidateSourceChangedError,
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
  CodexExternalSessionUnsupportedRolloutRecordError,
  pageCodexExternalSessionTranscript,
  readAfterCodexExternalSessionTranscript,
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

function fitsResult(result: AgentExternalSessionsResult<unknown>, maxSerializedBytes: number): boolean {
  return serializedByteLength(result) <= maxSerializedBytes;
}

/**
 * Output overflow is not a malformed inbound request: the caller's byte bound is
 * well formed and only this Agent's own result overran it. It is reported as a
 * NONRETRYABLE `agent_error`, the same classification the host's
 * bounded-invocation owner applies when a leaf overruns the identical budget.
 */
function bounded<T>(
  value: T,
  maxSerializedBytes: number,
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
    return failed('agent_error', 'Codex produced a transcript item outside the public JSON contract.');
  }
  return ok(projected);
}

function mapReadAfterPage(
  page: CodexExternalSessionTranscriptSourcePage,
): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> {
  if (page.readAfterOutcome) return ok({ outcome: page.readAfterOutcome });
  const mapped = mapTranscriptPage(page);
  if (!mapped.ok) return ok({ outcome: 'read_failed' });
  if (mapped.value.truncated) return ok({ outcome: 'gap_or_cursor_expired' });
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
    const remoteSessionId = request.remoteSessionId.trim();
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
    }, request.maxSerializedBytes, 'Codex link identity cannot fit the result byte bound.');
  };

  return Object.freeze({
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
      return bounded(
        {
          source: validation.value.publicSource,
          transcriptMediaReadRoots: mediaReadRoots.value,
        },
        request.maxSerializedBytes,
        'Codex source result cannot fit the result byte bound.',
      );
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
          source: validation.value.codexSource,
          env,
          cursor: request.cursor,
          limit: request.maxItems,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
          exec: request.exec,
        });
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        return bounded({
          candidates: listed.candidates.map(projectCodexExternalSessionCandidateToAgent),
          nextCursor: listed.nextCursor,
          ...(listed.searchIncomplete !== undefined ? { searchIncomplete: listed.searchIncomplete } : {}),
          ...(listed.preparation !== undefined ? { preparation: listed.preparation } : {}),
        }, request.maxSerializedBytes, 'Codex candidate page cannot fit the result byte bound.');
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        if (error instanceof CodexExternalSessionCandidateSourceChangedError) {
          return failed('source_invalid', error.message);
        }
        return failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Codex external-session listing failed.',
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
        const page = await pageCodexExternalSessionTranscript({
          source: validation.value.codexSource,
          env,
          remoteSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
        });
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        const mapped = mapTranscriptPage(page);
        return fitsResult(mapped, request.maxSerializedBytes)
          ? mapped
          : failed('agent_error', 'Codex transcript page cannot fit the result byte bound.', false);
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        if (error instanceof CodexExternalSessionUnsupportedRolloutRecordError) {
          return failed('agent_error', error.message, false);
        }
        return failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Codex external-session transcript operation failed.',
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
        const page = await readAfterCodexExternalSessionTranscript({
          source: validation.value.codexSource,
          env,
          remoteSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
        });
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        const mapped = mapReadAfterPage(page);
        return fitsResult(mapped, request.maxSerializedBytes)
          ? mapped
          : failed('agent_error', 'Codex transcript page cannot fit the result byte bound.', false);
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        if (error instanceof CodexExternalSessionUnsupportedRolloutRecordError) {
          return failed('agent_error', error.message, false);
        }
        return ok({ outcome: 'read_failed' });
      }
    },

  });
}

export const codexExternalSessionsContribution: AgentExternalSessionsContribution = createCodexExternalSessionsContribution();
