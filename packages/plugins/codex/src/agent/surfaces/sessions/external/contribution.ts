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

import {
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
  inferCodexExternalSessionsActiveServerDir,
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

function invocationFailure(
  invocation: AgentExternalSessionsInvocation,
): AgentExternalSessionsResult<never> | null {
  if (invocation.signal.aborted) {
    return failed('cancelled', 'Codex external-session operation was cancelled.');
  }
  if (Date.now() >= invocation.deadlineAtMs) {
    return failed('timeout', 'Codex external-session operation exceeded its deadline.', true);
  }
  if (!Number.isFinite(invocation.maxSerializedBytes) || invocation.maxSerializedBytes < 1) {
    return failed('invalid_request', 'Codex external-session result byte bound must be positive.');
  }
  return null;
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
    ? codexSource.homePath.trim() || null
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

function transcriptMediaReadRootsFor(source: CodexExternalSessionSource): readonly string[] {
  const homePath = typeof source.homePath === 'string' ? source.homePath.trim() : '';
  return homePath ? [homePath] : [];
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitsResult(result: AgentExternalSessionsResult<unknown>, maxSerializedBytes: number): boolean {
  return serializedByteLength(result) <= maxSerializedBytes;
}

function bounded<T>(
  value: T,
  maxSerializedBytes: number,
  message: string,
): AgentExternalSessionsResult<T> {
  const result = ok(value);
  return fitsResult(result, maxSerializedBytes)
    ? result
    : failed('invalid_request', message);
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
  if (mapped.value.items.length === 0) {
    if (!page.diagnostics?.length || !mapped.value.nextCursor) {
      return ok({ outcome: mapped.value.truncated ? 'gap_or_cursor_expired' : 'already_current' });
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
  activeServerDir?: string;
}> = {}): AgentExternalSessionsContribution {
  const readEnv = () => params.env ?? process.env;
  const activeServerDirFor = (source: AgentExternalSessionSource) =>
    params.activeServerDir?.trim()
    || inferCodexExternalSessionsActiveServerDir(source)
    || '';

  const resolveIdentity = (
    request: Readonly<{
      source: AgentExternalSessionSource;
      remoteSessionId: string;
      linkData?: AgentExternalSessionLinkData;
    }> & AgentExternalSessionsInvocation,
  ) => {
    const stopped = invocationFailure(request);
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
    return bounded({
      source,
      remoteSessionId: identity.remoteSessionId,
      transcriptMediaReadRoots: transcriptMediaReadRootsFor(identity.source),
      linkData: buildIdentityLinkData({
        source,
        runtimeDescriptor: identity.runtimeDescriptor,
        codexBackendMode: identityBackendMode,
      }),
    }, request.maxSerializedBytes, 'Codex link identity cannot fit the result byte bound.');
  };

  return Object.freeze({
    resolveSource(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const validation = validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return validation;
      return bounded(
        {
          source: validation.value.publicSource,
          transcriptMediaReadRoots: transcriptMediaReadRootsFor(validation.value.codexSource),
        },
        request.maxSerializedBytes,
        'Codex source result cannot fit the result byte bound.',
      );
    },

    async listCandidates(request) {
      const stopped = invocationFailure(request);
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
          activeServerDir: activeServerDirFor(validation.value.publicSource),
          env,
          cursor: request.cursor,
          limit: request.maxItems,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
          exec: request.exec,
        });
        const after = invocationFailure(request);
        if (after) return after;
        return bounded({
          candidates: listed.candidates.map(projectCodexExternalSessionCandidateToAgent),
          nextCursor: listed.nextCursor,
          ...(listed.searchIncomplete !== undefined ? { searchIncomplete: listed.searchIncomplete } : {}),
          ...(listed.preparation !== undefined ? { preparation: listed.preparation } : {}),
        }, request.maxSerializedBytes, 'Codex candidate page cannot fit the result byte bound.');
      } catch (error) {
        const after = invocationFailure(request);
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
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Codex external-session transcript limit must be positive.');
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const page = await pageCodexExternalSessionTranscript({
          source: validation.value.codexSource,
          activeServerDir: activeServerDirFor(validation.value.publicSource),
          env,
          remoteSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
        });
        const after = invocationFailure(request);
        if (after) return after;
        const mapped = mapTranscriptPage(page);
        return fitsResult(mapped, request.maxSerializedBytes)
          ? mapped
          : failed('invalid_request', 'Codex transcript page cannot fit the result byte bound.');
      } catch (error) {
        const after = invocationFailure(request);
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
      const stopped = invocationFailure(request);
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
          activeServerDir: activeServerDirFor(validation.value.publicSource),
          env,
          remoteSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
        });
        const after = invocationFailure(request);
        if (after) return after;
        const mapped = mapReadAfterPage(page);
        return fitsResult(mapped, request.maxSerializedBytes)
          ? mapped
          : failed('invalid_request', 'Codex transcript page cannot fit the result byte bound.');
      } catch (error) {
        const after = invocationFailure(request);
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
