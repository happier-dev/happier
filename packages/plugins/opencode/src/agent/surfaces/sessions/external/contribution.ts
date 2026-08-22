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
  AgentExternalSessionsResolvedIdentity,
  AgentExternalSessionsResult,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  getOpenCodeExternalSessionVerifiedWorkingDirectory,
  listOpenCodeSessionCandidates,
  type OpenCodeExternalSessionCandidate,
} from './candidates.js';
import {
  type OpenCodeExternalSessionSource,
  projectOpenCodeExternalSessionSource,
  validateOpenCodeExternalSessionsSource,
} from './client.js';
import {
  resolveOpenCodeExternalSessionIdentity,
  resolveOpenCodeLinkedExternalSessionIdentity,
} from './identity.js';
import {
  resolveOpenCodeExternalSessionsManagedService,
} from './managedServer.js';
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

/**
 * Output overflow is not a malformed inbound request: the caller's byte bound is
 * well formed and only this Agent's own result overran it. It is reported as a
 * NONRETRYABLE `agent_error`, the same classification the host's
 * bounded-invocation owner applies when a leaf overruns the identical budget.
 */
function bounded<T>(
  invocation: AgentExternalSessionsInvocation,
  result: AgentExternalSessionsResult<T>,
  message: string,
): AgentExternalSessionsResult<T> {
  return serializedByteLength(result) <= invocation.maxSerializedBytes
    ? result
    : failed('agent_error', message, false);
}

function toAgentSource(source: OpenCodeExternalSessionSource): AgentExternalSessionSource | null {
  return isLinkData(source)
    ? { ...source }
    : null;
}

function validateSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: Readonly<Record<string, string | undefined>>;
  baseUrlAuthority?: 'configured' | 'canonical';
}>): AgentExternalSessionsResult<Readonly<{
  source: OpenCodeExternalSessionSource;
  agentSource: AgentExternalSessionSource;
}>> {
  const source = projectOpenCodeExternalSessionSource(params.source);
  if (!source) return failed('source_invalid', 'provider/source mismatch');
  const validation = validateOpenCodeExternalSessionsSource({
    source,
    env: params.env,
    ...(params.baseUrlAuthority ? { baseUrlAuthority: params.baseUrlAuthority } : {}),
  });
  if (!validation.ok) return failed('source_invalid', validation.error);
  const agentSource = toAgentSource(validation.source);
  return agentSource
    ? ok({ source: validation.source, agentSource })
    : failed('agent_error', 'OpenCode produced a source outside the public JSON contract.');
}

function mapCandidate(candidate: OpenCodeExternalSessionCandidate): AgentExternalSessionCandidate {
  return {
    remoteSessionId: candidate.remoteSessionId,
    ...(candidate.title ? { title: candidate.title } : {}),
    updatedAtMs: candidate.updatedAtMs,
    ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
    ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}),
    ...(isLinkDataValue(candidate.runtimeDescriptor, new Set())
      ? { linkData: { runtimeDescriptorV1: candidate.runtimeDescriptor } }
      : {}),
  };
}

function mapTranscriptItem(
  item: AgentExternalSessionTranscriptItem,
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
  items: readonly AgentExternalSessionTranscriptItem[];
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
): unknown {
  const runtimeDescriptorV1 = linkData?.runtimeDescriptorV1;
  return isPlainObject(runtimeDescriptorV1)
    ? runtimeDescriptorV1
    : undefined;
}

function stripManagedEndpointAuthority(
  linkData: AgentExternalSessionLinkData,
): AgentExternalSessionLinkData {
  const {
    opencodeServerBaseUrl: _serverBaseUrl,
    opencodeServerBaseUrlExplicit: _serverBaseUrlExplicit,
    ...safeLinkData
  } = linkData;
  return safeLinkData;
}

function mapResolvedIdentity(params: Readonly<{
  resolved: ReturnType<typeof resolveOpenCodeExternalSessionIdentity>;
  fallbackLinkData?: AgentExternalSessionLinkData;
}>): AgentExternalSessionsResult<AgentExternalSessionsResolvedIdentity> {
  const source = toAgentSource(params.resolved.source);
  if (!source) {
    return failed('agent_error', 'OpenCode produced a linked source outside the public JSON contract.');
  }
  if (
    params.resolved.vendorMetadata !== undefined
    && !isLinkData(params.resolved.vendorMetadata)
  ) {
    return failed('agent_error', 'OpenCode produced linked metadata outside the public JSON contract.');
  }
  const mergedLinkData: AgentExternalSessionLinkData = {
    ...(params.fallbackLinkData ?? {}),
    ...(params.resolved.vendorMetadata ?? {}),
    ...(isLinkDataValue(params.resolved.runtimeDescriptor, new Set())
      ? { runtimeDescriptorV1: params.resolved.runtimeDescriptor }
      : {}),
  };
  const linkData = params.resolved.source.managedEndpoint === true
    ? stripManagedEndpointAuthority(mergedLinkData)
    : mergedLinkData;
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
    maxBytes: params.invocation.maxSerializedBytes,
    signal: params.invocation.signal,
    env: params.env,
    managedEndpointRead: params.invocation.managedEndpointRead,
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
    resolveManagedEndpointService(request) {
      return resolveOpenCodeExternalSessionsManagedService(request);
    },

    resolveSource(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const validation = validateSource({ source: request.source, env: readEnv() });
      return bounded(
        request,
        validation.ok ? ok({ source: validation.value.agentSource }) : validation,
        'OpenCode source result exceeds the host byte bound.',
      );
    },

    async listCandidates(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const badLimit = invalidLimit(request.maxItems, 'candidate');
      if (badLimit) return badLimit;
      const env = readEnv();
      const validation = validateSource({ source: request.source, env });
      if (!validation.ok) return validation;
      try {
        const listed = await listOpenCodeSessionCandidates({
          source: validation.value.source,
          ...(request.cursor ? { cursor: request.cursor } : {}),
          limit: request.maxItems,
          maxBytes: request.maxSerializedBytes,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
          signal: request.signal,
          env,
          managedEndpointRead: request.managedEndpointRead,
        });
        const after = invocationFailure(request);
        if (after) return after;
        const candidates = listed.candidates.map(mapCandidate);
        const value = {
          candidates,
          nextCursor: listed.nextCursor,
          ...(listed.searchIncomplete ? { searchIncomplete: true } : {}),
        };
        const result = serializedByteLength(ok(value)) <= request.maxSerializedBytes
          ? ok(value)
          : failed('agent_error', 'OpenCode candidate result byte budget cannot fit the page envelope.', false);
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
          source: validation.value.source,
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
          source: validation.value.source,
          metadata: request.linkData,
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
          source: validation.value.source,
          providerSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          env,
          managedEndpointRead: request.managedEndpointRead,
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
          source: validation.value.source,
          providerSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxSerializedBytes,
          maxItems: request.maxItems,
          signal: request.signal,
          env,
          managedEndpointRead: request.managedEndpointRead,
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

export const openCodeExternalSessionsContribution: AgentExternalSessionsContribution = createOpenCodeExternalSessionsContribution();
