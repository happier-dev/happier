import {
  ProviderConnectionIdSchema,
  ProviderMachineIdSchema,
  ProviderModelIdSchema,
  ProviderModelLoadDescriptorV1Schema,
  createProviderErrorV1,
  type AssessedProviderEndpoint,
  type ProviderErrorV1,
  type ProviderModelLoadDescriptorV1,
  type ProviderModelLoadStateV1,
} from '@happier-dev/protocol';

import {
  PROVIDER_MODEL_LOAD_HTTP_LIMITS,
  ProviderProbeCancelledError,
  ProviderProbeClientError,
  type ProviderModelLoadPostRequest,
  type ProviderModelLoadPostResult,
  type ProviderProbeCredential,
  type ProviderProbeHttpCredentialLease,
} from '../probe/client';
import {
  ProviderProbeCredentialResolutionError,
  ProviderProbeDestinationAuthorizationError,
} from '../probe/authorization';

export const PROVIDER_MODEL_LOAD_WALL_TIME_MS = PROVIDER_MODEL_LOAD_HTTP_LIMITS.wallTimeMs;
export const PROVIDER_MODEL_LOAD_MAX_DECODED_BODY_BYTES = PROVIDER_MODEL_LOAD_HTTP_LIMITS.maxDecodedBodyBytes;

export class ProviderModelLoadCancelledError extends Error {
  constructor() {
    super('Provider model load cancelled');
    this.name = 'ProviderModelLoadCancelledError';
  }
}

export type ProviderModelLoadRequest = Readonly<{
  connectionId: string;
  machineId: string;
  modelId: string;
  signal?: AbortSignal;
}>;

export type ProviderModelLoadAuthorization<TTicket, TCredentialRef> = Readonly<{
  ticket: TTicket;
  /** Minted only by the canonical provider authorization owner. */
  source: 'trusted_local_contribution';
  descriptor: ProviderModelLoadDescriptorV1;
  endpoint: Readonly<{
    endpointTemplateId: string;
    endpointUrl: string;
    endpointFingerprint: string;
    publicHeaders: Readonly<Record<string, string>>;
  }>;
  /** Already selected for credential transport use `management`. */
  credentialRef: TCredentialRef | null;
}>;

export type ProviderModelLoadAuthorizationPort<TTicket, TCredentialRef> = Readonly<{
  authorize(request: Omit<ProviderModelLoadRequest, 'signal'>): Promise<
    | Readonly<{ status: 'authorized'; authorization: ProviderModelLoadAuthorization<TTicket, TCredentialRef> }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>
  >;
  revalidate(
    ticket: TTicket,
    request: Omit<ProviderModelLoadRequest, 'signal'>,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
  authorizeDestination(
    ticket: TTicket,
    request: Omit<ProviderModelLoadRequest, 'signal'>,
    destination: AssessedProviderEndpoint,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
  resolveCredential(reference: TCredentialRef): Promise<
    | Readonly<{
        ok: true;
        lease: Readonly<{
          credential: ProviderProbeCredential;
          close(): void;
        }>;
      }>
    | Readonly<{ ok: false; error: ProviderErrorV1 }>
  >;
}>;

export type ProviderCurrentModelObservation =
  | Readonly<{
      status: 'listed';
      catalogObservationId: string;
      loadState: ProviderModelLoadStateV1;
    }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'error'; error: ProviderErrorV1 }>;

export type ProviderModelLoadCatalogPort<TTicket> = Readonly<{
  /** Reads only the exact current, non-stale catalog generation. */
  readCurrentModel(input: Readonly<{
    connectionId: string;
    machineId: string;
    modelId: string;
    ticket: TTicket;
  }>): Promise<ProviderCurrentModelObservation>;
  /** Forces a network-backed refresh; it must not satisfy from a TTL cache. */
  refresh(input: Readonly<{
    connectionId: string;
    machineId: string;
    modelId: string;
    refreshFrontier: string;
    ticket: TTicket;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{ status: 'success' }>
    | Readonly<{ status: 'not_supported' }>
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>
  >;
}>;

export type ProviderModelLoadHttpPort = Readonly<{
  /** Endpoint-safety client: re-resolves DNS, enforces the cap, and never follows redirects. */
  postJsonModelId(input: Readonly<{
    connectionId: string;
    machineId: string;
    endpointUrl: string;
    path: string;
    publicHeaders: Readonly<Record<string, string>>;
    body: Readonly<{ model: string }>;
    resolveCredential?: () => Promise<ProviderProbeHttpCredentialLease>;
    authorizeDestination(destination: AssessedProviderEndpoint): Promise<void>;
    redirectPolicy: 'reject';
    wallTimeMs: typeof PROVIDER_MODEL_LOAD_WALL_TIME_MS;
    maxDecodedBodyBytes: typeof PROVIDER_MODEL_LOAD_MAX_DECODED_BODY_BYTES;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{ ok: true; statusCode: number }>
    | Readonly<{ ok: false; error: ProviderErrorV1 }>
  >;
}>;

type ProviderModelLoadSafeClientPort = Readonly<{
  postModelLoad(input: ProviderModelLoadPostRequest): Promise<ProviderModelLoadPostResult>;
}>;

/**
 * The sole adapter from explicit model management to the canonical endpoint-
 * safety HTTP client. The client API accepts an exact model id, not an
 * arbitrary method/body/redirect policy.
 */
export function createProviderModelLoadHttpPort(
  client: ProviderModelLoadSafeClientPort,
): ProviderModelLoadHttpPort {
  return Object.freeze({
    async postJsonModelId(input) {
      const context = { connectionId: input.connectionId, machineId: input.machineId };
      try {
        const result = await client.postModelLoad({
          endpointUrl: input.endpointUrl,
          path: input.path,
          publicHeaders: input.publicHeaders,
          modelId: input.body.model,
          ...(input.resolveCredential ? { resolveCredential: input.resolveCredential } : {}),
          authorizeDestination: input.authorizeDestination,
          signal: input.signal,
        });
        return { ok: true, statusCode: result.statusCode };
      } catch (error) {
        if (error instanceof ProviderProbeCancelledError || input.signal.aborted) {
          throw new ProviderModelLoadCancelledError();
        }
        if (error instanceof ProviderProbeDestinationAuthorizationError
          || error instanceof ProviderProbeCredentialResolutionError) throw error;
        if (error instanceof ProviderProbeClientError) {
          return {
            ok: false,
            error: createProviderErrorV1(error.code, {
              ...context,
              ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            }),
          };
        }
        return {
          ok: false,
          error: createProviderErrorV1('provider_endpoint_unavailable', context),
        };
      }
    },
  });
}

export type ProviderModelLoadServiceDependencies<TTicket, TCredentialRef> = Readonly<{
  /** Must be the dependency-aware canonical decision, not a raw payload bit. */
  isFeatureEnabled(): boolean;
  authorization: ProviderModelLoadAuthorizationPort<TTicket, TCredentialRef>;
  catalog: ProviderModelLoadCatalogPort<TTicket>;
  http: ProviderModelLoadHttpPort;
}>;

export type ProviderModelLoadResult =
  | Readonly<{ status: 'loaded'; source: 'already_loaded' | 'requested' }>
  | Readonly<{ status: 'not_supported'; reason: 'feature_disabled' | 'descriptor_absent' }>
  | Readonly<{ status: 'cancelled'; providerMayContinue: true }>
  | Readonly<{ status: 'error'; error: ProviderErrorV1 }>;

export type ProviderModelLoadPreflightResult =
  | Readonly<{ status: 'allowed'; loadActionAvailable: boolean }>
  | Readonly<{ status: 'blocked'; error: ProviderErrorV1 }>;

export function evaluateProviderModelLoadPreflight(input: Readonly<{
  descriptor: ProviderModelLoadDescriptorV1 | null;
  loadState: ProviderModelLoadStateV1;
}>): ProviderModelLoadPreflightResult {
  if (input.descriptor === null) return { status: 'allowed', loadActionAvailable: false };
  const descriptor = ProviderModelLoadDescriptorV1Schema.parse(input.descriptor);
  if (descriptor.preflightPolicy === 'required' && input.loadState === 'unloaded') {
    return {
      status: 'blocked',
      error: createProviderErrorV1('provider_model_unloaded', { modelLoadAvailable: true }),
    };
  }
  return { status: 'allowed', loadActionAvailable: input.loadState !== 'loaded' };
}

type InFlightEntry = Readonly<{
  controller: AbortController;
  promise: Promise<ProviderModelLoadResult>;
  state: { subscribers: number; settled: boolean };
}>;

function cancelledResult(): ProviderModelLoadResult {
  return { status: 'cancelled', providerMayContinue: true };
}

function providerErrorForStatus(
  statusCode: number,
  context: Readonly<{ connectionId: string; machineId: string }>,
  hasCredential: boolean,
): ProviderErrorV1 {
  const errorContext = { connectionId: context.connectionId, machineId: context.machineId };
  if (statusCode === 401 || statusCode === 403) {
    return createProviderErrorV1(
      hasCredential ? 'provider_endpoint_unauthorized' : 'provider_endpoint_auth_required',
      errorContext,
    );
  }
  if (statusCode === 429) return createProviderErrorV1('provider_endpoint_rate_limited', errorContext);
  if (statusCode >= 500) return createProviderErrorV1('provider_endpoint_unavailable', errorContext);
  return createProviderErrorV1('provider_probe_response_invalid', errorContext);
}

function normalizeRequest(input: ProviderModelLoadRequest): Omit<ProviderModelLoadRequest, 'signal'> {
  return {
    connectionId: ProviderConnectionIdSchema.parse(input.connectionId),
    machineId: ProviderMachineIdSchema.parse(input.machineId),
    modelId: ProviderModelIdSchema.parse(input.modelId),
  };
}

function modelNotFound(request: Omit<ProviderModelLoadRequest, 'signal'>): ProviderModelLoadResult {
  return {
    status: 'error',
    error: createProviderErrorV1('provider_model_not_found', {
      connectionId: request.connectionId,
      machineId: request.machineId,
    }),
  };
}

function modelStillUnloaded(request: Omit<ProviderModelLoadRequest, 'signal'>): ProviderModelLoadResult {
  return {
    status: 'error',
    error: createProviderErrorV1('provider_model_unloaded', {
      connectionId: request.connectionId,
      machineId: request.machineId,
      modelLoadAvailable: true,
    }),
  };
}

export function createProviderModelLoadService<TTicket, TCredentialRef>(
  dependencies: ProviderModelLoadServiceDependencies<TTicket, TCredentialRef>,
) {
  const inFlight = new Map<string, InFlightEntry>();
  const pendingAuthorization = new Map<string, Set<AbortController>>();
  let nextRefreshFrontier = 0;

  function pendingAuthorizationKey(
    request: Omit<ProviderModelLoadRequest, 'signal'>,
  ): string {
    return JSON.stringify([
      request.machineId,
      request.connectionId,
      request.modelId,
    ]);
  }

  async function runLoad(input: Readonly<{
    request: Omit<ProviderModelLoadRequest, 'signal'>;
    authorization: ProviderModelLoadAuthorization<TTicket, TCredentialRef>;
    signal: AbortSignal;
  }>): Promise<ProviderModelLoadResult> {
    const { request, authorization, signal } = input;
    try {
      if (signal.aborted) return cancelledResult();
      const beforeCatalogRead = await dependencies.authorization.revalidate(authorization.ticket, request);
      if (signal.aborted) return cancelledResult();
      if (!beforeCatalogRead.ok) return { status: 'error', error: beforeCatalogRead.error };
      const before = await dependencies.catalog.readCurrentModel({ ...request, ticket: authorization.ticket });
      if (signal.aborted) return cancelledResult();
      const afterCatalogRead = await dependencies.authorization.revalidate(authorization.ticket, request);
      if (signal.aborted) return cancelledResult();
      if (!afterCatalogRead.ok) return { status: 'error', error: afterCatalogRead.error };
      if (before.status === 'error') return { status: 'error', error: before.error };
      if (before.status === 'not_found') return modelNotFound(request);
      if (before.loadState === 'loaded') return { status: 'loaded', source: 'already_loaded' };

      const beforeDispatch = await dependencies.authorization.revalidate(authorization.ticket, request);
      if (signal.aborted) return cancelledResult();
      if (!beforeDispatch.ok) return { status: 'error', error: beforeDispatch.error };

      const credentialRef = authorization.credentialRef;
      const requestHadCredential = credentialRef !== null;
      const response = await dependencies.http.postJsonModelId({
        connectionId: request.connectionId,
        machineId: request.machineId,
        endpointUrl: authorization.endpoint.endpointUrl,
        path: authorization.descriptor!.path,
        publicHeaders: authorization.endpoint.publicHeaders,
        body: { model: request.modelId },
        ...(credentialRef === null ? {} : {
          resolveCredential: async () => {
            const resolved = await dependencies.authorization.resolveCredential(credentialRef);
            if (!resolved.ok) throw new ProviderProbeCredentialResolutionError(resolved.error);
            return resolved.lease;
          },
        }),
        authorizeDestination: async (destination) => {
          const result = await dependencies.authorization.authorizeDestination(
            authorization.ticket,
            request,
            destination,
          );
          if (!result.ok) throw new ProviderProbeDestinationAuthorizationError(result.error);
        },
        redirectPolicy: 'reject',
        wallTimeMs: PROVIDER_MODEL_LOAD_WALL_TIME_MS,
        maxDecodedBodyBytes: PROVIDER_MODEL_LOAD_MAX_DECODED_BODY_BYTES,
        signal,
      });
      if (signal.aborted) return cancelledResult();
      const afterResponse = await dependencies.authorization.revalidate(authorization.ticket, request);
      if (signal.aborted) return cancelledResult();
      if (!afterResponse.ok) return { status: 'error', error: afterResponse.error };
      if (!response.ok) return { status: 'error', error: response.error };
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return {
          status: 'error',
          error: providerErrorForStatus(response.statusCode, request, requestHadCredential),
        };
      }

      const refreshed = await dependencies.catalog.refresh({
        connectionId: request.connectionId,
        machineId: request.machineId,
        modelId: request.modelId,
        refreshFrontier: String(++nextRefreshFrontier),
        ticket: authorization.ticket,
        signal,
      });
      if (signal.aborted) return cancelledResult();
      const afterRefresh = await dependencies.authorization.revalidate(authorization.ticket, request);
      if (signal.aborted) return cancelledResult();
      if (!afterRefresh.ok) return { status: 'error', error: afterRefresh.error };
      if (refreshed.status === 'error') return { status: 'error', error: refreshed.error };
      if (refreshed.status === 'not_supported') return modelStillUnloaded(request);

      const confirmed = await dependencies.catalog.readCurrentModel({ ...request, ticket: authorization.ticket });
      if (signal.aborted) return cancelledResult();
      const afterRead = await dependencies.authorization.revalidate(authorization.ticket, request);
      if (signal.aborted) return cancelledResult();
      if (!afterRead.ok) return { status: 'error', error: afterRead.error };
      if (confirmed.status === 'error') return { status: 'error', error: confirmed.error };
      if (confirmed.status !== 'listed'
        || confirmed.catalogObservationId === before.catalogObservationId
        || confirmed.loadState !== 'loaded') {
        return modelStillUnloaded(request);
      }
      return { status: 'loaded', source: 'requested' };
    } catch (error) {
      if (signal.aborted || error instanceof ProviderModelLoadCancelledError) return cancelledResult();
      try {
        const current = await dependencies.authorization.revalidate(authorization.ticket, request);
        if (!current.ok) return { status: 'error', error: current.error };
      } catch {
        // Fall through to the redacted error below. Revalidation itself is
        // allowed to fail closed but must never expose its raw exception.
      }
      if (error instanceof ProviderProbeDestinationAuthorizationError) {
        return { status: 'error', error: error.error };
      }
      if (error instanceof ProviderProbeCredentialResolutionError) {
        return { status: 'error', error: error.error };
      }
      return {
        status: 'error',
        error: createProviderErrorV1('provider_endpoint_unavailable', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
  }

  function subscribe(entry: InFlightEntry, signal: AbortSignal | undefined): Promise<ProviderModelLoadResult> {
    if (signal?.aborted) {
      if (entry.state.subscribers === 0 && !entry.state.settled) entry.controller.abort();
      return Promise.resolve(cancelledResult());
    }
    entry.state.subscribers += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.state.subscribers -= 1;
      if (entry.state.subscribers === 0 && !entry.state.settled) entry.controller.abort();
    };
    if (!signal) return entry.promise.finally(release);
    let onAbort = () => {};
    return new Promise<ProviderModelLoadResult>((resolve) => {
      onAbort = () => resolve(cancelledResult());
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(resolve, () => resolve({
        status: 'error',
        error: createProviderErrorV1('provider_endpoint_unavailable'),
      })).finally(() => signal.removeEventListener('abort', onAbort));
    }).finally(() => {
      signal.removeEventListener('abort', onAbort);
      release();
    });
  }

  return Object.freeze({
    async loadNow(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult> {
      if (!dependencies.isFeatureEnabled()) return { status: 'not_supported', reason: 'feature_disabled' };
      if (input.signal?.aborted) return cancelledResult();
      const request = normalizeRequest(input);
      const authorizationController = new AbortController();
      const pendingKey = pendingAuthorizationKey(request);
      const pendingControllers =
        pendingAuthorization.get(pendingKey) ?? new Set<AbortController>();
      pendingControllers.add(authorizationController);
      pendingAuthorization.set(pendingKey, pendingControllers);
      const onInputAbort = () => authorizationController.abort();
      input.signal?.addEventListener('abort', onInputAbort, { once: true });
      let resolved: Awaited<
        ReturnType<typeof dependencies.authorization.authorize>
      >;
      try {
        resolved = await dependencies.authorization.authorize(request);
      } finally {
        input.signal?.removeEventListener('abort', onInputAbort);
        pendingControllers.delete(authorizationController);
        if (pendingControllers.size === 0
          && pendingAuthorization.get(pendingKey) === pendingControllers) {
          pendingAuthorization.delete(pendingKey);
        }
      }
      if (authorizationController.signal.aborted || input.signal?.aborted) {
        return cancelledResult();
      }
      if (resolved.status === 'error') return { status: 'error', error: resolved.error };
      if (resolved.status === 'unavailable') {
        return { status: 'not_supported', reason: 'descriptor_absent' };
      }
      if (input.signal?.aborted) return cancelledResult();
      const authorization = resolved.authorization;
      if (authorization.source !== 'trusted_local_contribution') {
        return { status: 'not_supported', reason: 'descriptor_absent' };
      }
      const parsedDescriptor = ProviderModelLoadDescriptorV1Schema.parse(authorization.descriptor);
      if (parsedDescriptor.endpointTemplateId !== authorization.endpoint.endpointTemplateId) {
        return { status: 'not_supported', reason: 'descriptor_absent' };
      }
      const verifiedAuthorization = { ...authorization, descriptor: parsedDescriptor };
      const key = JSON.stringify([
        request.machineId,
        request.connectionId,
        authorization.endpoint.endpointFingerprint,
        request.modelId,
      ]);
      let entry = inFlight.get(key);
      if (entry?.controller.signal.aborted) {
        if (inFlight.get(key) === entry) inFlight.delete(key);
        entry = undefined;
      }
      if (!entry) {
        const controller = new AbortController();
        const state = { subscribers: 0, settled: false };
        const promise = runLoad({ request, authorization: verifiedAuthorization, signal: controller.signal });
        entry = { controller, promise, state };
        inFlight.set(key, entry);
        void promise.finally(() => {
          state.settled = true;
          if (inFlight.get(key) === entry) inFlight.delete(key);
        });
      }
      return subscribe(entry, input.signal);
    },
    async cancelNow(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult> {
      if (!dependencies.isFeatureEnabled()) return { status: 'not_supported', reason: 'feature_disabled' };
      const request = normalizeRequest(input);
      pendingAuthorization.get(pendingAuthorizationKey(request))
        ?.forEach((controller) => controller.abort());
      const resolved = await dependencies.authorization.authorize(request);
      if (resolved.status === 'error') return { status: 'error', error: resolved.error };
      if (resolved.status === 'unavailable') {
        return { status: 'not_supported', reason: 'descriptor_absent' };
      }
      const authorization = resolved.authorization;
      if (authorization.source !== 'trusted_local_contribution') {
        return { status: 'not_supported', reason: 'descriptor_absent' };
      }
      const parsedDescriptor = ProviderModelLoadDescriptorV1Schema.parse(authorization.descriptor);
      if (parsedDescriptor.endpointTemplateId !== authorization.endpoint.endpointTemplateId) {
        return { status: 'not_supported', reason: 'descriptor_absent' };
      }
      const key = JSON.stringify([
        request.machineId,
        request.connectionId,
        authorization.endpoint.endpointFingerprint,
        request.modelId,
      ]);
      inFlight.get(key)?.controller.abort();
      return cancelledResult();
    },
  });
}
