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
  ExternalSessionTranscriptRawMessageV1,
  RuntimeDescriptorV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  getOpenCodeExternalSessionVerifiedWorkingDirectory,
  listOpenCodeSessionCandidates,
} from './candidates.js';
import { validateOpenCodeExternalSessionsSource } from './client.js';
import {
  resolveOpenCodeExternalSessionIdentity,
  resolveOpenCodeLinkedExternalSessionIdentity,
} from './identity.js';
import { pageOpenCodeTranscript } from './pageTranscript.js';
import {
  readAfterOpenCodeTranscript,
  type OpenCodeExternalReadAfterOutcome,
} from './readAfterTranscript.js';

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
    return failed('cancelled', 'OpenCode external-session operation was cancelled.');
  }
  if (Date.now() >= invocation.deadlineAtMs) {
    return failed('timeout', 'OpenCode external-session operation exceeded its deadline.', true);
  }
  if (!Number.isFinite(invocation.maxSerializedBytes) || invocation.maxSerializedBytes < 1) {
    return failed('invalid_request', 'OpenCode external-session result byte bound must be positive.');
  }
  return null;
}

function invalidLimit(maxItems: number, noun: string): AgentExternalSessionsResult<never> | null {
  return !Number.isFinite(maxItems) || maxItems < 1
    ? failed('invalid_request', `OpenCode external-session ${noun} limit must be positive.`)
    : null;
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

function bounded<T>(
  invocation: AgentExternalSessionsInvocation,
  result: AgentExternalSessionsResult<T>,
  message: string,
): AgentExternalSessionsResult<T> {
  return serializedByteLength(result) <= invocation.maxSerializedBytes
    ? result
    : failed('invalid_request', message);
}

function toLegacySource(source: AgentExternalSessionSource): ExternalSessionsSource | null {
  if (source.kind !== 'opencodeServer') return null;
  return source as ExternalSessionsSource;
}

function toPublicSource(source: ExternalSessionsSource): AgentExternalSessionSource | null {
  return isLinkData(source)
    ? source as AgentExternalSessionSource
    : null;
}

function validateSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: Readonly<Record<string, string | undefined>>;
  baseUrlAuthority?: 'configured' | 'canonical';
}>): AgentExternalSessionsResult<Readonly<{
  legacySource: ExternalSessionsSource;
  publicSource: AgentExternalSessionSource;
}>> {
  const legacySource = toLegacySource(params.source);
  if (!legacySource) return failed('source_invalid', 'provider/source mismatch');
  const validation = validateOpenCodeExternalSessionsSource({
    source: legacySource,
    env: params.env,
    ...(params.baseUrlAuthority ? { baseUrlAuthority: params.baseUrlAuthority } : {}),
  });
  if (!validation.ok) return failed('source_invalid', validation.error);
  const publicSource = toPublicSource(validation.source);
  return publicSource
    ? ok({ legacySource: validation.source, publicSource })
    : failed('agent_error', 'OpenCode produced a source outside the public JSON contract.');
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
  const runtimeDescriptorV1 = details?.runtimeDescriptorV1;
  return {
    remoteSessionId: candidate.remoteSessionId,
    ...(candidate.title ? { title: candidate.title } : {}),
    updatedAtMs: candidate.updatedAtMs,
    ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
    ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}),
    ...(isLinkDataValue(runtimeDescriptorV1, new Set())
      ? { linkData: { runtimeDescriptorV1 } }
      : {}),
  };
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

function mapTranscriptPage(page: Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
}>): AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage> {
  const items = page.items.map(mapTranscriptItem);
  if (items.some((item) => item === null)) {
    return failed('agent_error', 'OpenCode produced a transcript item outside the public JSON contract.');
  }
  return ok({
    items: items.filter((item): item is AgentExternalSessionTranscriptItem => item !== null),
    nextCursor: page.nextCursor,
    ...(page.tailCursor !== undefined ? { tailCursor: page.tailCursor } : {}),
    ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
    ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
  });
}

function mapReadAfterOutcome(
  outcome: OpenCodeExternalReadAfterOutcome,
): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> {
  if (outcome.outcome !== 'advanced') return ok(outcome);
  const items = outcome.items.map(mapTranscriptItem);
  if (items.some((item) => item === null)) {
    return ok({ outcome: 'read_failed' });
  }
  return ok({
    ...outcome,
    items: items.filter((item): item is AgentExternalSessionTranscriptItem => item !== null),
  });
}

function readRuntimeDescriptor(
  linkData: AgentExternalSessionLinkData | undefined,
): RuntimeDescriptorV1 | undefined {
  const runtimeDescriptorV1 = linkData?.runtimeDescriptorV1;
  return isPlainObject(runtimeDescriptorV1)
    ? runtimeDescriptorV1 as RuntimeDescriptorV1
    : undefined;
}

function mapResolvedIdentity(params: Readonly<{
  resolved: ReturnType<typeof resolveOpenCodeExternalSessionIdentity>;
  fallbackLinkData?: AgentExternalSessionLinkData;
}>): AgentExternalSessionsResult<Readonly<{
  source: AgentExternalSessionSource;
  remoteSessionId: string;
  linkData: AgentExternalSessionLinkData;
}>> {
  const source = toPublicSource(params.resolved.source);
  if (!source) {
    return failed('agent_error', 'OpenCode produced a linked source outside the public JSON contract.');
  }
  if (
    params.resolved.vendorMetadata !== undefined
    && !isLinkData(params.resolved.vendorMetadata)
  ) {
    return failed('agent_error', 'OpenCode produced linked metadata outside the public JSON contract.');
  }
  const linkData: AgentExternalSessionLinkData = {
    ...(params.fallbackLinkData ?? {}),
    ...(params.resolved.vendorMetadata ?? {}),
    ...(isLinkDataValue(params.resolved.runtimeDescriptor, new Set())
      ? { runtimeDescriptorV1: params.resolved.runtimeDescriptor }
      : {}),
  };
  return ok({
    source,
    remoteSessionId: params.resolved.providerSessionId,
    linkData,
  });
}

async function canonicalizeMissingOpenCodeDirectory(params: Readonly<{
  resolved: ReturnType<typeof resolveOpenCodeExternalSessionIdentity>;
  invocation: AgentExternalSessionsInvocation;
  env: Readonly<Record<string, string | undefined>>;
}>): Promise<AgentExternalSessionsResult<
  ReturnType<typeof resolveOpenCodeExternalSessionIdentity>
>> {
  if (params.resolved.source.kind !== 'opencodeServer') {
    return failed('agent_error', 'OpenCode produced a non-server linked source.');
  }
  const existingDirectory =
    typeof params.resolved.source.directory === 'string'
      ? params.resolved.source.directory.trim()
      : '';
  if (existingDirectory) return ok(params.resolved);

  const directory = await getOpenCodeExternalSessionVerifiedWorkingDirectory({
    source: params.resolved.source,
    providerSessionId: params.resolved.providerSessionId,
    signal: params.invocation.signal,
    env: params.env,
    baseUrlAuthority: 'canonical',
  });
  const stopped = invocationFailure(params.invocation);
  if (stopped) return stopped;
  if (!directory) {
    return failed(
      'agent_unavailable',
      'OpenCode could not verify the session directory required for live event correlation.',
      true,
    );
  }
  return ok({
    ...params.resolved,
    source: {
      ...params.resolved.source,
      directory,
    },
  });
}

function operationFailure(
  invocation: AgentExternalSessionsInvocation,
  error: unknown,
  fallbackMessage: string,
): AgentExternalSessionsResult<never> {
  return invocationFailure(invocation)
    ?? failed(
      'agent_unavailable',
      error instanceof Error ? error.message : fallbackMessage,
      true,
    );
}

export function createOpenCodeExternalSessionsContribution(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
}> = {}): AgentExternalSessionsContribution {
  const readEnv = () => params.env ?? process.env;

  return Object.freeze({
    resolveSource(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const validation = validateSource({ source: request.source, env: readEnv() });
      return bounded(
        request,
        validation.ok ? ok({ source: validation.value.publicSource }) : validation,
        'OpenCode source result exceeds the host byte bound.',
      );
    },

    async listCandidates(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const badLimit = invalidLimit(request.maxItems, 'candidate');
      if (badLimit) return badLimit;
      if (request.cursor) {
        return failed(
          'unsupported',
          'OpenCode session listing exposes bounded top-N search but no official continuation cursor.',
        );
      }
      if (request.searchMode === 'full' && request.searchTerm?.trim()) {
        return failed(
          'unsupported',
          'OpenCode does not expose a bounded full id-and-title session search.',
        );
      }
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const listed = await listOpenCodeSessionCandidates({
          source: validation.value.legacySource,
          limit: request.maxItems,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
          includeActivity: false,
          signal: request.signal,
          env,
        });
        const after = invocationFailure(request);
        if (after) return after;
        const candidates = listed.candidates.map(mapCandidate);
        while (candidates.length > 0 && serializedByteLength(ok({
          candidates,
          nextCursor: null,
          ...(listed.searchIncomplete ? { searchIncomplete: true } : {}),
        })) > request.maxSerializedBytes) {
          candidates.pop();
        }
        const result = ok({
          candidates,
          nextCursor: null,
          ...((listed.searchIncomplete || candidates.length < listed.candidates.length)
            ? { searchIncomplete: true }
            : {}),
        });
        return bounded(
          request,
          result,
          'OpenCode candidate result byte budget cannot fit the page envelope.',
        );
      } catch (error) {
        return operationFailure(request, error, 'OpenCode external-session listing failed.');
      }
    },

    async resolveLinkIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const env = readEnv();
      const validation = validateSource({
        source: request.source,
        env,
        baseUrlAuthority: 'canonical',
      });
      if (!validation.ok) return validation;
      const canonical = await canonicalizeMissingOpenCodeDirectory({
        resolved: resolveOpenCodeExternalSessionIdentity({
          providerSessionId: request.remoteSessionId,
          source: validation.value.legacySource,
          runtimeDescriptor: readRuntimeDescriptor(request.linkData),
        }),
        invocation: request,
        env,
      });
      if (!canonical.ok) return canonical;
      const result = mapResolvedIdentity({
        resolved: canonical.value,
        fallbackLinkData: request.linkData,
      });
      return bounded(
        request,
        result,
        'OpenCode linked identity exceeds the host byte bound.',
      );
    },

    async resolveLinkedIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const env = readEnv();
      const validation = validateSource({
        source: request.source,
        env,
        baseUrlAuthority: 'canonical',
      });
      if (!validation.ok) return validation;
      const canonical = await canonicalizeMissingOpenCodeDirectory({
        resolved: resolveOpenCodeLinkedExternalSessionIdentity({
          providerSessionId: request.remoteSessionId,
          source: validation.value.legacySource,
          metadata: request.linkData,
        }),
        invocation: request,
        env,
      });
      if (!canonical.ok) return canonical;
      const result = mapResolvedIdentity({
        resolved: canonical.value,
        fallbackLinkData: request.linkData,
      });
      return bounded(
        request,
        result,
        'OpenCode linked identity exceeds the host byte bound.',
      );
    },

    async pageTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const badLimit = invalidLimit(request.maxItems, 'transcript');
      if (badLimit) return badLimit;
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const page = await pageOpenCodeTranscript({
          source: validation.value.legacySource,
          providerSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          env,
        });
        const after = invocationFailure(request);
        if (after) return after;
        return bounded(
          request,
          mapTranscriptPage(page),
          'OpenCode transcript result byte budget cannot fit the page envelope.',
        );
      } catch (error) {
        return operationFailure(request, error, 'OpenCode external-session transcript operation failed.');
      }
    },

    async readAfterTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const badLimit = invalidLimit(request.maxItems, 'transcript');
      if (badLimit) return badLimit;
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const page = await readAfterOpenCodeTranscript({
          source: validation.value.legacySource,
          providerSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          env,
        });
        const after = invocationFailure(request);
        if (after) return after;
        return bounded(
          request,
          mapReadAfterOutcome(page),
          'OpenCode transcript result byte budget cannot fit the page envelope.',
        );
      } catch (error) {
        const after = invocationFailure(request);
        return after ?? ok({ outcome: 'read_failed' });
      }
    },
  });
}

export const openCodeExternalSessionsContribution = createOpenCodeExternalSessionsContribution();
