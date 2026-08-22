import type {
  ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedProviderStartRequest } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import {
  PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
  ProviderConnectionIdSchema,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import type { ResolvedManagedProviderRuntime } from '@/plugins/projection/registry/types';

import type {
  ProviderLaunchCleanup,
  ProviderLaunchResource,
  ProviderLaunchResourceScope,
} from './resourceScope';

export type PublicManagedProviderRuntimeStartFailureCode =
  | 'managed_provider_request_invalid'
  | 'managed_provider_runtime_unavailable'
  | 'managed_provider_authorization_changed'
  | 'managed_provider_start_aborted'
  | 'managed_provider_start_failed'
  | 'managed_provider_result_invalid'
  | 'managed_provider_endpoint_access_unavailable'
  | 'managed_provider_custody_adoption_failed'
  | 'managed_provider_cleanup_failed';

export type PublicManagedProviderRuntimeStartFailure = Readonly<{
  ok: false;
  code: PublicManagedProviderRuntimeStartFailureCode;
}>;

export type PublicManagedProviderEndpointPath = Readonly<{
  endpointTemplateId: string;
  servicePath: string;
}>;

export type PublicManagedProviderEndpointAccessProjection<TAccess> = Readonly<{
  /** Host-private opaque access. Bearers and capability paths stay with SVC09. */
  access: TAccess;
  isCurrent(): boolean;
  cleanup?: ProviderLaunchCleanup | ProviderLaunchResource;
}>;

/**
 * Scope-placed SVC09 custody supplied by the daemon operation or persistent
 * Session runner. The Provider coordinator never allocates a second service.
 */
export type PublicManagedProviderRuntimeCustody<TAccess> = Readonly<{
  managedServices: ManagedServices;
  /** Session-only commit boundary. Implementations must persist the full
   * runner-local endpoint/access outcome before this resolves. */
  adoptService?(serviceId: string): Promise<void>;
  /** Exact Session-only settlement read used when the commit response is
   * ambiguous. The custody implementation remains the outcome owner. */
  readAdoptedPublicOutcome?(): Promise<unknown>;
  projectEndpointAccess(input: Readonly<{
    service: ManagedServiceHandle;
    endpoints: readonly PublicManagedProviderEndpointPath[];
    signal: AbortSignal;
    isCurrent(): boolean;
  }>): Promise<PublicManagedProviderEndpointAccessProjection<TAccess> | null>;
}>;

export type PublicManagedProviderRuntimeStartResult<TAccess> =
  | Readonly<{
      ok: true;
      access: TAccess;
      isCurrent(): boolean;
    }>
  | PublicManagedProviderRuntimeStartFailure;

export type AcquirePublicManagedProviderRuntime = (
  identity: Readonly<{ pluginId: string; localId: string }>,
) => Promise<ResolvedManagedProviderRuntime | null>;

function readsCurrent(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function sameRuntime(
  left: ResolvedManagedProviderRuntime,
  right: ResolvedManagedProviderRuntime | null,
): boolean {
  return right !== null
    && right.runtime === left.runtime
    && right.activationGeneration === left.activationGeneration
    && right.immutableGenerationId === left.immutableGenerationId
    && readsCurrent(left.isCurrent)
    && readsCurrent(right.isCurrent);
}

function hasExactRequestKeys(
  value: object,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function readDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const record: Record<string, unknown> = {};
    for (const key of keys) record[key] = Reflect.get(value, key);
    return record;
  } catch {
    return null;
  }
}

function isManagedServiceHandle(value: unknown): value is ManagedServiceHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof Reflect.get(value, 'snapshot') === 'function'
    && typeof Reflect.get(value, 'observe') === 'function'
    && typeof Reflect.get(value, 'waitUntilHealthy') === 'function'
    && typeof Reflect.get(value, 'request') === 'function'
    && typeof Reflect.get(value, 'stop') === 'function'
    && typeof Reflect.get(value, 'dispose') === 'function';
}

function normalizeStartRequest(
  request: ManagedProviderStartRequest,
): ManagedProviderStartRequest | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const reason: unknown = Reflect.get(request, 'reason');
  const rawEndpointTemplateIds: unknown = Reflect.get(request, 'endpointTemplateIds');
  if (
    !Array.isArray(rawEndpointTemplateIds)
    || rawEndpointTemplateIds.length < 1
    || rawEndpointTemplateIds.length
      > PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration
    || new Set(rawEndpointTemplateIds).size !== rawEndpointTemplateIds.length
    || rawEndpointTemplateIds.some((id: unknown) => (
      typeof id !== 'string'
      || id.length === 0
      || id !== id.trim()
    ))
  ) return null;
  const endpointTemplateIds = Object.freeze([...rawEndpointTemplateIds]);
  if (reason === 'explicitStartLocal') {
    return hasExactRequestKeys(request, ['reason', 'endpointTemplateIds'])
      ? Object.freeze({ reason, endpointTemplateIds })
      : null;
  }
  if (reason !== 'catalogProbe' && reason !== 'sessionDemand') return null;
  if (!hasExactRequestKeys(request, [
    'reason',
    'connectionId',
    'connectionRevision',
    'endpointTemplateIds',
  ])) return null;
  const connectionId = ProviderConnectionIdSchema.safeParse(
    Reflect.get(request, 'connectionId'),
  );
  const connectionRevision: unknown = Reflect.get(request, 'connectionRevision');
  if (
    !connectionId.success
    || typeof connectionRevision !== 'number'
    || !Number.isSafeInteger(connectionRevision)
    || connectionRevision < 0
  ) return null;
  return Object.freeze({
    reason,
    connectionId: connectionId.data,
    connectionRevision,
    endpointTemplateIds,
  });
}

function readHealthyLoopbackBaseUrl(service: ManagedServiceHandle): URL | null {
  try {
    const snapshot = service.snapshot();
    if (
      snapshot.state !== 'healthy'
      || snapshot.baseUrl === null
    ) return null;
    const baseUrl = new URL(snapshot.baseUrl);
    const host = baseUrl.hostname.replace(/^\[|\]$/gu, '');
    const port = baseUrl.port === '' ? 80 : Number(baseUrl.port);
    if (
      baseUrl.protocol !== 'http:'
      || baseUrl.username !== ''
      || baseUrl.password !== ''
      || baseUrl.search !== ''
      || baseUrl.hash !== ''
      || (host !== '127.0.0.1' && host !== '::1')
      || !Number.isSafeInteger(port)
      || port < 1
      || port > 65_535
    ) return null;
    return baseUrl;
  } catch {
    return null;
  }
}

function projectEndpointPaths(input: Readonly<{
  service: ManagedServiceHandle;
  endpoints: unknown;
  endpointTemplateIds: readonly string[];
}>): readonly PublicManagedProviderEndpointPath[] | null {
  const baseUrl = readHealthyLoopbackBaseUrl(input.service);
  if (!baseUrl || !Array.isArray(input.endpoints)) return null;
  if (
    input.endpoints.length < 1
    || input.endpoints.length > input.endpointTemplateIds.length
  ) return null;
  const projected: PublicManagedProviderEndpointPath[] = [];
  let previousRequestedIndex = -1;
  for (let index = 0; index < input.endpoints.length; index += 1) {
    const value = readDataRecord(
      input.endpoints[index],
      ['endpointTemplateId', 'endpoint'],
    );
    if (!value) return null;
    const endpointTemplateId = value.endpointTemplateId;
    if (typeof endpointTemplateId !== 'string') return null;
    const requestedIndex = input.endpointTemplateIds.indexOf(endpointTemplateId);
    if (requestedIndex <= previousRequestedIndex) return null;
    previousRequestedIndex = requestedIndex;
    const endpoint = readDataRecord(value.endpoint, ['kind', 'path']);
    if (!endpoint) return null;
    const servicePath = endpoint.path;
    if (
      endpoint.kind !== 'servicePath'
      || typeof servicePath !== 'string'
      || servicePath.length < 1
      || servicePath.length > 2_048
      || servicePath !== servicePath.trim()
      || !servicePath.startsWith('/')
      || servicePath.includes('?')
      || servicePath.includes('#')
    ) return null;
    try {
      const resolved = new URL(servicePath, baseUrl);
      if (
        resolved.origin !== baseUrl.origin
        || resolved.username !== ''
        || resolved.password !== ''
        || resolved.search !== ''
        || resolved.hash !== ''
      ) return null;
    } catch {
      return null;
    }
    projected.push(Object.freeze({
      endpointTemplateId,
      servicePath,
    }));
  }
  return Object.freeze(projected);
}

function matchesExactAdoptedPublicOutcome(input: Readonly<{
  outcome: unknown;
  serviceId: string;
  endpoints: readonly PublicManagedProviderEndpointPath[];
}>): boolean {
  if (
    !input.outcome
    || typeof input.outcome !== 'object'
    || Array.isArray(input.outcome)
  ) return false;
  try {
    if (Reflect.get(input.outcome, 'serviceId') !== input.serviceId) {
      return false;
    }
    const endpointTemplateIds = Reflect.get(
      input.outcome,
      'endpointTemplateIds',
    );
    const endpoints = Reflect.get(input.outcome, 'endpoints');
    if (
      !Array.isArray(endpointTemplateIds)
      || !Array.isArray(endpoints)
      || endpointTemplateIds.length !== input.endpoints.length
      || endpoints.length !== input.endpoints.length
    ) return false;
    return input.endpoints.every((expected, index) => {
      const actual = endpoints[index];
      return endpointTemplateIds[index] === expected.endpointTemplateId
        && !!actual
        && typeof actual === 'object'
        && !Array.isArray(actual)
        && Reflect.get(actual, 'endpointTemplateId')
          === expected.endpointTemplateId
        && Reflect.get(actual, 'servicePath') === expected.servicePath;
    });
  } catch {
    return false;
  }
}

async function revalidate(
  input: Readonly<{
    signal: AbortSignal;
    isAuthorizationCurrent(): boolean;
    revalidateAuthorization(): Promise<boolean>;
  }>,
): Promise<'current' | 'aborted' | 'changed'> {
  if (input.signal.aborted) return 'aborted';
  if (!readsCurrent(input.isAuthorizationCurrent)) return 'changed';
  try {
    const current = await input.revalidateAuthorization();
    if (input.signal.aborted) return 'aborted';
    return current && readsCurrent(input.isAuthorizationCurrent)
      ? 'current'
      : 'changed';
  } catch {
    return input.signal.aborted ? 'aborted' : 'changed';
  }
}

function revalidationFailureCode(
  state: Exclude<Awaited<ReturnType<typeof revalidate>>, 'current'>,
): PublicManagedProviderRuntimeStartFailureCode {
  return state === 'aborted'
    ? 'managed_provider_start_aborted'
    : 'managed_provider_authorization_changed';
}

/**
 * Single host-private production coordinator for all new public managed
 * Provider claims. It calls the exact acquired public runtime and composes it
 * with caller-supplied SVC09 custody; it owns no registry or service allocator.
 */
export async function startPublicManagedProviderRuntime<TAccess>(input: Readonly<{
  identity: PluginContributionIdentityV1;
  request: ManagedProviderStartRequest;
  acquireRuntime: AcquirePublicManagedProviderRuntime;
  connectedAccounts: ConnectedAccountsService;
  custody: PublicManagedProviderRuntimeCustody<TAccess>;
  isAuthorizationCurrent(): boolean;
  revalidateAuthorization(): Promise<boolean>;
  signal: AbortSignal;
  launchResourceScope: ProviderLaunchResourceScope;
}>): Promise<PublicManagedProviderRuntimeStartResult<TAccess>> {
  let retireInvocation: (() => void) | null = null;
  const fail = async (
    code: PublicManagedProviderRuntimeStartFailureCode,
  ): Promise<PublicManagedProviderRuntimeStartFailure> => {
    retireInvocation?.();
    try {
      await input.launchResourceScope.release();
      return Object.freeze({ ok: false, code });
    } catch {
      return Object.freeze({
        ok: false,
        code: 'managed_provider_cleanup_failed',
      });
    }
  };

  let request: ManagedProviderStartRequest | null = null;
  try {
    if (
      input.identity.pluginId.length > 0
      && input.identity.localId.length > 0
      && input.identity.pluginId === input.identity.pluginId.trim()
      && input.identity.localId === input.identity.localId.trim()
    ) request = normalizeStartRequest(input.request);
  } catch {
    request = null;
  }
  if (!request) return await fail('managed_provider_request_invalid');
  if (input.signal.aborted) return await fail('managed_provider_start_aborted');

  const invocationAbort = new AbortController();
  const abortInvocation = (): void => invocationAbort.abort(input.signal.reason);
  let invocationRetired = false;
  retireInvocation = () => {
    if (invocationRetired) return;
    invocationRetired = true;
    input.signal.removeEventListener('abort', abortInvocation);
    invocationAbort.abort('managed Provider launch scope retired');
  };
  if (input.signal.aborted) abortInvocation();
  else input.signal.addEventListener('abort', abortInvocation, { once: true });
  input.launchResourceScope.register(retireInvocation);

  let acquired: ResolvedManagedProviderRuntime | null;
  try {
    acquired = await input.acquireRuntime(Object.freeze({
      pluginId: input.identity.pluginId,
      localId: input.identity.localId,
    }));
  } catch {
    acquired = null;
  }
  if (input.signal.aborted) {
    return await fail('managed_provider_start_aborted');
  }
  if (!acquired || !readsCurrent(acquired.isCurrent)) {
    return await fail('managed_provider_runtime_unavailable');
  }
  const initialAuthorization = await revalidate(input);
  if (initialAuthorization !== 'current') {
    return await fail(revalidationFailureCode(initialAuthorization));
  }

  let endpoint: Awaited<ReturnType<typeof acquired.runtime.start>>;
  try {
    endpoint = await acquired.runtime.start(request, Object.freeze({
      connectedAccounts: input.connectedAccounts,
      managedServices: input.custody.managedServices,
      signal: invocationAbort.signal,
    }));
  } catch {
    return await fail(
      invocationAbort.signal.aborted
        ? 'managed_provider_start_aborted'
        : 'managed_provider_start_failed',
    );
  }
  let service: ManagedServiceHandle;
  let endpoints: readonly PublicManagedProviderEndpointPath[] | null;
  let custodyProvedUnadoptedCleanup = false;
  try {
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
      return await fail(
        input.signal.aborted
          ? 'managed_provider_start_aborted'
          : 'managed_provider_result_invalid',
      );
    }
    const candidateService = Reflect.get(endpoint, 'service');
    if (!isManagedServiceHandle(candidateService)) {
      return await fail(
        input.signal.aborted
          ? 'managed_provider_start_aborted'
          : 'managed_provider_result_invalid',
      );
    }
    service = candidateService;
    // Register the returned handle before validating endpoint rows so a
    // malformed result cannot orphan an already-started service.
    input.launchResourceScope.register({
      onFailure: () => custodyProvedUnadoptedCleanup
        ? undefined
        : service.dispose(),
      // A successful Session-demand launch transfers process custody to the
      // persistent runner. Retiring only this daemon invocation must not tear
      // down that adopted service; the runner remains its exact cleanup owner.
      onExit: request.reason === 'sessionDemand'
        ? () => undefined
        : () => service.dispose(),
    });
    if (input.signal.aborted) {
      return await fail('managed_provider_start_aborted');
    }
    endpoints = projectEndpointPaths({
      service,
      endpoints: Reflect.get(endpoint, 'endpoints'),
      endpointTemplateIds: request.endpointTemplateIds,
    });
  } catch {
    return await fail(
      input.signal.aborted
        ? 'managed_provider_start_aborted'
        : 'managed_provider_result_invalid',
    );
  }
  if (!endpoints) return await fail('managed_provider_result_invalid');

  let settledRuntime: ResolvedManagedProviderRuntime | null;
  try {
    settledRuntime = await input.acquireRuntime(Object.freeze({
      pluginId: input.identity.pluginId,
      localId: input.identity.localId,
    }));
  } catch {
    settledRuntime = null;
  }
  if (input.signal.aborted) {
    return await fail('managed_provider_start_aborted');
  }
  if (!sameRuntime(acquired, settledRuntime)) {
    return await fail('managed_provider_authorization_changed');
  }
  const settledAuthorization = await revalidate(input);
  if (settledAuthorization !== 'current') {
    return await fail(revalidationFailureCode(settledAuthorization));
  }

  const isRuntimeCurrent = (): boolean => (
    !invocationAbort.signal.aborted
    && readsCurrent(input.isAuthorizationCurrent)
    && readsCurrent(acquired.isCurrent)
  );
  let projection: PublicManagedProviderEndpointAccessProjection<TAccess> | null;
  try {
    projection = await input.custody.projectEndpointAccess({
      service,
      endpoints,
      signal: invocationAbort.signal,
      isCurrent: isRuntimeCurrent,
    });
  } catch {
    projection = null;
  }
  if (!projection) {
    return await fail(
      input.signal.aborted
        ? 'managed_provider_start_aborted'
        : 'managed_provider_endpoint_access_unavailable',
    );
  }
  input.launchResourceScope.register(projection.cleanup);
  const isCurrent = (): boolean => (
    isRuntimeCurrent()
    && readsCurrent(projection.isCurrent)
  );
  if (!isCurrent()) {
    return await fail(
      input.signal.aborted
        ? 'managed_provider_start_aborted'
        : 'managed_provider_authorization_changed',
    );
  }
  const projectedAuthorization = await revalidate(input);
  if (projectedAuthorization !== 'current') {
    return await fail(revalidationFailureCode(projectedAuthorization));
  }
  if (!isCurrent()) {
    return await fail(
      input.signal.aborted
        ? 'managed_provider_start_aborted'
        : 'managed_provider_authorization_changed',
    );
  }

  if (request.reason === 'sessionDemand') {
    const adoptService = input.custody.adoptService;
    if (!adoptService) {
      return await fail('managed_provider_custody_adoption_failed');
    }
    try {
      await adoptService(service.snapshot().id);
    } catch {
      const readAdoptedPublicOutcome =
        input.custody.readAdoptedPublicOutcome;
      let adoptedPublicOutcome: unknown = undefined;
      let adoptionOutcomeReadCompleted = false;
      if (readAdoptedPublicOutcome) {
        try {
          adoptedPublicOutcome = await readAdoptedPublicOutcome();
          adoptionOutcomeReadCompleted = true;
        } catch {
          adoptedPublicOutcome = undefined;
        }
      }
      if (!matchesExactAdoptedPublicOutcome({
        outcome: adoptedPublicOutcome,
        serviceId: service.snapshot().id,
        endpoints,
      })) {
        // The canonical runner read removes every unadopted entry before
        // returning null. Do not ask the now-detached daemon proxy to repeat
        // that already-settled cleanup.
        custodyProvedUnadoptedCleanup =
          adoptionOutcomeReadCompleted
          && adoptedPublicOutcome === null;
        return await fail('managed_provider_custody_adoption_failed');
      }
    }
  }

  // Transferred cleanup is reverse-order. Register the same exact-once fence
  // last so a successful lifetime aborts before service/credential cleanup;
  // failure paths invoke it directly before releasing the scope.
  input.launchResourceScope.register(retireInvocation);

  return Object.freeze({
    ok: true,
    access: projection.access,
    isCurrent,
  });
}
