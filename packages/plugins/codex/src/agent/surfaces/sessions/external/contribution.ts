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
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/plugin-sdk/experimental/sessions';
import { resolveTranscriptBodySessionMessageRole } from '@happier-dev/protocol';

import {
  resolveConfiguredCodexHomePath,
} from '../../../rollout/discovery/homeEntries.js';
import { normalizeCodexBackendMode } from '../../../../protocol/runtimeDescriptorV1.js';
import {
  CodexExternalSessionCandidateSourceChangedError,
  listCodexSessionCandidates,
} from './candidateSource.js';
import { resolveCodexExternalSessionLinkIdentity } from './identity.js';
import {
  inferCodexExternalSessionsActiveServerDir,
  validateCodexExternalSessionsSourcePolicy,
} from './sourceValidation.js';
import {
  pageCodexExternalSessionTranscript,
  readAfterCodexExternalSessionTranscript,
} from './transcriptSource.js';

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

function readOptionalString(value: AgentExternalSessionLinkDataValue | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toLegacyCodexSource(source: AgentExternalSessionSource): ExternalSessionsSource | null {
  if (source.kind !== 'codexHome') return null;
  const home = source.home;
  if (home !== 'user' && home !== 'connectedService') return null;
  const homePath = readOptionalString(source.homePath);
  const connectedServiceId = readOptionalString(source.connectedServiceId);
  const connectedServiceProfileId = readOptionalString(source.connectedServiceProfileId);
  const connectedServiceGroupId = readOptionalString(source.connectedServiceGroupId);
  return {
    kind: 'codexHome',
    home,
    ...(homePath ? { homePath } : {}),
    ...(connectedServiceId ? { connectedServiceId } : {}),
    ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
    ...(connectedServiceGroupId ? { connectedServiceGroupId } : {}),
  };
}

function toPublicCodexSource(source: unknown): AgentExternalSessionSource | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const sourceRecord = source as Readonly<Record<string, unknown>>;
  if (sourceRecord.kind !== 'codexHome') return null;
  const home = sourceRecord.home;
  if (home !== 'user' && home !== 'connectedService') return null;
  const homePath = typeof sourceRecord.homePath === 'string' ? sourceRecord.homePath.trim() : '';
  const connectedServiceId = typeof sourceRecord.connectedServiceId === 'string'
    ? sourceRecord.connectedServiceId.trim()
    : '';
  const connectedServiceProfileId = typeof sourceRecord.connectedServiceProfileId === 'string'
    ? sourceRecord.connectedServiceProfileId.trim()
    : '';
  const connectedServiceGroupId = typeof sourceRecord.connectedServiceGroupId === 'string'
    ? sourceRecord.connectedServiceGroupId.trim()
    : '';
  return {
    kind: 'codexHome',
    home,
    ...(homePath ? { homePath } : {}),
    ...(connectedServiceId ? { connectedServiceId } : {}),
    ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
    ...(connectedServiceGroupId ? { connectedServiceGroupId } : {}),
  };
}

function validateSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: NodeJS.ProcessEnv;
}>): AgentExternalSessionsResult<Readonly<{
  legacySource: ExternalSessionsSource;
  publicSource: AgentExternalSessionSource;
}>> {
  const legacySource = toLegacyCodexSource(params.source);
  if (!legacySource) return failed('source_invalid', 'provider/source mismatch');
  const canonicalRequestedHomePath = typeof legacySource.homePath === 'string'
    ? legacySource.homePath.trim() || null
    : null;
  const validation = validateCodexExternalSessionsSourcePolicy({
    source: legacySource,
    configuredCodexHomePath: resolveConfiguredCodexHomePath(params.env),
    canonicalRequestedHomePath,
    isSafeConnectedServiceId,
  });
  if (!validation.ok) return failed('source_invalid', validation.error);
  const publicSource = toPublicCodexSource(validation.source);
  return publicSource
    ? ok({ legacySource: validation.source, publicSource })
    : failed('source_invalid', 'provider/source mismatch');
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

function mapCandidate(candidate: Readonly<{
  remoteSessionId: string;
  title?: string | null;
  updatedAtMs: number;
  createdAtMs?: number;
  archived?: boolean;
  details?: unknown;
}>): AgentExternalSessionCandidate {
  const details = isPlainObject(candidate.details) ? candidate.details : null;
  const source = details ? toPublicCodexSource(details.source) : null;
  const linkData: Record<string, AgentExternalSessionLinkDataValue> = {};
  if (source) linkData.source = source;
  if (isLinkDataValue(details?.runtimeDescriptorV1, new Set())) {
    linkData.runtimeDescriptorV1 = details.runtimeDescriptorV1;
  }
  const codexBackendMode = typeof details?.codexBackendMode === 'string'
    ? details.codexBackendMode.trim()
    : '';
  if (codexBackendMode) linkData.codexBackendMode = codexBackendMode;
  return {
    remoteSessionId: candidate.remoteSessionId,
    ...(candidate.title ? { title: candidate.title } : {}),
    updatedAtMs: candidate.updatedAtMs,
    ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
    ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}),
    ...(Object.keys(linkData).length > 0 ? { linkData } : {}),
  };
}

function mapTranscriptItem(item: Readonly<{
  id: string;
  createdAtMs: number;
  localId?: string | null;
  messageRole?: AgentExternalSessionTranscriptItem['messageRole'];
  raw: unknown;
}>): AgentExternalSessionTranscriptItem | null {
  if (!isPlainObject(item.raw) || !isLinkData(item.raw)) return null;
  const rawRole = item.raw.role;
  const content = item.raw.content;
  if (!isPlainObject(content) || !isLinkData(content)) return null;
  const codexData = content.type === 'codex' ? content.data : null;
  const raw = isPlainObject(codexData) && isLinkData(codexData)
    ? codexData
    : content;
  const derivedRole = isPlainObject(codexData)
    ? resolveTranscriptBodySessionMessageRole({
      protocol: 'codex',
      body: codexData,
    })
    : rawRole === 'user' || rawRole === 'agent' || rawRole === 'event'
      ? rawRole
      : 'unknown';
  const messageRole = isPlainObject(codexData)
    ? derivedRole
    : item.messageRole ?? derivedRole;
  if (messageRole === null || messageRole === 'unknown') return null;
  return {
    id: item.id,
    createdAtMs: item.createdAtMs,
    ...(item.localId !== undefined ? { localId: item.localId } : {}),
    messageRole,
    raw,
  };
}

function mapTranscriptPage(page: Readonly<{
  items: readonly Readonly<{
    id: string;
    createdAtMs: number;
    localId?: string | null;
    messageRole?: AgentExternalSessionTranscriptItem['messageRole'];
    raw: unknown;
  }>[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
}>): AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage> {
  const items = page.items.map(mapTranscriptItem);
  if (items.some((item) => item === null)) {
    return failed('agent_error', 'Codex produced a transcript item outside the public JSON contract.');
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

function readLinkSource(linkData: AgentExternalSessionLinkData | undefined): AgentExternalSessionSource | null {
  const source = linkData?.source;
  if (!isPlainObject(source) || typeof source.kind !== 'string' || source.kind.trim().length === 0) return null;
  return isLinkData(source) ? { ...source, kind: source.kind } : null;
}

function readRuntimeDescriptor(linkData: AgentExternalSessionLinkData | undefined): RuntimeDescriptorV1 | null {
  return readRuntimeDescriptorV1FromMetadata({
    runtimeDescriptorV1: linkData?.runtimeDescriptorV1,
  });
}

function buildIdentityLinkData(params: Readonly<{
  source: AgentExternalSessionSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  codexBackendMode?: string | null;
}>): AgentExternalSessionLinkData {
  return {
    source: params.source,
    ...(params.runtimeDescriptor && isLinkDataValue(params.runtimeDescriptor, new Set())
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
      source: validation.value.legacySource,
      runtimeDescriptor: readRuntimeDescriptor(request.linkData),
      ...(codexBackendMode ? { metadata: { codexBackendMode } } : {}),
    });
    const source = toPublicCodexSource(identity.source);
    if (!source) return failed('source_invalid', 'Codex identity resolved an invalid source.');
    const identityBackendMode = typeof identity.externalSessionMetadata?.codexBackendMode === 'string'
      ? identity.externalSessionMetadata.codexBackendMode
      : null;
    return bounded({
      source,
      remoteSessionId: identity.remoteSessionId,
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
        { source: validation.value.publicSource },
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
          source: validation.value.legacySource,
          activeServerDir: activeServerDirFor(validation.value.publicSource),
          env,
          cursor: request.cursor,
          limit: request.maxItems,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
        });
        const after = invocationFailure(request);
        if (after) return after;
        return bounded({
          candidates: listed.candidates.map(mapCandidate),
          nextCursor: listed.nextCursor,
          ...(listed.searchIncomplete !== undefined ? { searchIncomplete: listed.searchIncomplete } : {}),
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
          source: validation.value.legacySource,
          activeServerDir: activeServerDirFor(validation.value.publicSource),
          env,
          remoteSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
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
          source: validation.value.legacySource,
          activeServerDir: activeServerDirFor(validation.value.publicSource),
          env,
          remoteSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
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
        return ok({ outcome: 'read_failed' });
      }
    },

  });
}

export const codexExternalSessionsContribution = createCodexExternalSessionsContribution();
