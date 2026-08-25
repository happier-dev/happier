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
import {
  createProviderOperationLifetime,
  type ProviderOperationLifetime,
} from '../operationLifetime';
import type { ProviderContributionRegistryView } from '../registry';

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

/** Exact authority and one wall deadline shared by a model-load operation. */
export type ProviderModelLoadOperationScope = Readonly<{
  registry?: ProviderContributionRegistryView;
  lifetime: ProviderOperationLifetime;
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
  /**
   * Host-private registry generation selected while authorizing this load.
   * The service carries it through every later revalidation and refresh so one
   * operation cannot combine facts from two plugin generations.
   */
  operationScope?: Pick<ProviderModelLoadOperationScope, 'registry'>;
}>;

export type ProviderModelLoadAuthorizationPort<TTicket, TCredentialRef> = Readonly<{
  authorize(
    request: Omit<ProviderModelLoadRequest, 'signal'>,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<
    | Readonly<{ status: 'authorized'; authorization: ProviderModelLoadAuthorization<TTicket, TCredentialRef> }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>
  >;
  revalidate(
    ticket: TTicket,
    request: Omit<ProviderModelLoadRequest, 'signal'>,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
  authorizeDestination(
    ticket: TTicket,
    request: Omit<ProviderModelLoadRequest, 'signal'>,
    destination: AssessedProviderEndpoint,
    scope?: ProviderModelLoadOperationScope,
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
    scope: ProviderModelLoadOperationScope;
  }>): Promise<ProviderCurrentModelObservation>;
  /** Forces a network-backed refresh; it must not satisfy from a TTL cache. */
  refresh(input: Readonly<{
    connectionId: string;
    machineId: string;
    modelId: string;
    refreshFrontier: string;
    ticket: TTicket;
    signal: AbortSignal;
    scope: ProviderModelLoadOperationScope;
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
    wallDeadlineAtMs?: number;
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
          ...(input.wallDeadlineAtMs !== undefined
            ? { wallDeadlineAtMs: input.wallDeadlineAtMs }
            : {}),
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
  /** Logical user intent (machine, connection, model) that a cancel names. */
  logicalKey: string;
  controller: AbortController;
  promise: Promise<ProviderModelLoadResult>;
  state: { subscribers: number; settled: boolean };
}>;

const authorizationCancelled = Symbol('provider-model-load-authorization-cancelled');

/**
 * Authorization is an existing boundary without a cancellation parameter.
 * Once an operation is locally cancelled, stop waiting for that boundary and
 * ignore any late authorization result rather than letting it start work.
 */
function awaitAuthorizationOrCancellation<T>(
  authorization: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof authorizationCancelled> {
  if (signal.aborted) {
    void authorization.catch(() => undefined);
    return Promise.resolve(authorizationCancelled);
  }
  return new Promise<T | typeof authorizationCancelled>((resolve, reject) => {
    let settled = false;
    const finish = (result: T | typeof authorizationCancelled) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => finish(authorizationCancelled);
    signal.addEventListener('abort', onAbort, { once: true });
    authorization.then((result) => finish(result), fail);
    if (signal.aborted) onAbort();
  });
}

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
  /** Execution single-flight by the exact endpoint generation an operation runs against. */
  const inFlight = new Map<string, InFlightEntry>();
  /** Authorizations still resolving, addressed by the logical intent a cancel names. */
  const pendingAuthorizations = new Map<string, Set<AbortController>>();
  let nextRefreshFrontier = 0;

  function logicalOperationKey(
    request: Omit<ProviderModelLoadRequest, 'signal'>,
  ): string {
    return JSON.stringify([
      request.machineId,
      request.connectionId,
      request.modelId,
    ]);
  }

  /**
   * A load operation is identified by the endpoint generation it dispatches to,
   * so a request resolving to a rotated endpoint never joins an operation
   * already running against the previous one.
   */
  function executionOperationKey(
    request: Omit<ProviderModelLoadRequest, 'signal'>,
    endpointFingerprint: string,
  ): string {
    return JSON.stringify([
      request.machineId,
      request.connectionId,
      endpointFingerprint,
      request.modelId,
    ]);
  }

  function registerPendingAuthorization(
    logicalKey: string,
    controller: AbortController,
  ): () => void {
    const existing = pendingAuthorizations.get(logicalKey);
    if (existing) existing.add(controller);
    else pendingAuthorizations.set(logicalKey, new Set([controller]));
    return () => {
      const current = pendingAuthorizations.get(logicalKey);
      if (!current) return;
      current.delete(controller);
      if (current.size === 0) pendingAuthorizations.delete(logicalKey);
    };
  }

  type AuthorizedLoad = Readonly<{
    ok: true;
    authorization: ProviderModelLoadAuthorization<TTicket, TCredentialRef>;
    scope: ProviderModelLoadOperationScope;
  }> | Readonly<{ ok: false; result: ProviderModelLoadResult }>;

  async function authorizeLoad(input: Readonly<{
    request: Omit<ProviderModelLoadRequest, 'signal'>;
    signal: AbortSignal;
    scope: ProviderModelLoadOperationScope;
  }>): Promise<AuthorizedLoad> {
    const { request, signal, scope } = input;
    if (signal.aborted) return { ok: false, result: cancelledResult() };
    const resolved = await awaitAuthorizationOrCancellation(
      dependencies.authorization.authorize(request, scope),
      signal,
    );
    if (resolved === authorizationCancelled || signal.aborted) {
      return { ok: false, result: cancelledResult() };
    }
    if (resolved.status === 'error') {
      return { ok: false, result: { status: 'error', error: resolved.error } };
    }
    if (resolved.status === 'unavailable') {
      return { ok: false, result: { status: 'not_supported', reason: 'descriptor_absent' } };
    }
    const authorization = resolved.authorization;
    if (authorization.source !== 'trusted_local_contribution') {
      return { ok: false, result: { status: 'not_supported', reason: 'descriptor_absent' } };
    }
    const parsedDescriptor = ProviderModelLoadDescriptorV1Schema.parse(authorization.descriptor);
    if (parsedDescriptor.endpointTemplateId !== authorization.endpoint.endpointTemplateId) {
      return { ok: false, result: { status: 'not_supported', reason: 'descriptor_absent' } };
    }
    return {
      ok: true,
      authorization: { ...authorization, descriptor: parsedDescriptor },
      scope: {
        ...(authorization.operationScope?.registry
          ? { registry: authorization.operationScope.registry }
          : scope.registry ? { registry: scope.registry } : {}),
        lifetime: scope.lifetime,
      },
    };
  }

  async function runLoad(input: Readonly<{
    request: Omit<ProviderModelLoadRequest, 'signal'>;
    authorization: ProviderModelLoadAuthorization<TTicket, TCredentialRef>;
    signal: AbortSignal;
    scope: ProviderModelLoadOperationScope;
  }>): Promise<ProviderModelLoadResult> {
    const { request, authorization, signal, scope } = input;
    try {
      if (signal.aborted) return cancelledResult();
      const beforeCatalogRead = await dependencies.authorization.revalidate(authorization.ticket, request, scope);
      if (signal.aborted) return cancelledResult();
      if (!beforeCatalogRead.ok) return { status: 'error', error: beforeCatalogRead.error };
      const before = await dependencies.catalog.readCurrentModel({ ...request, ticket: authorization.ticket, scope });
      if (signal.aborted) return cancelledResult();
      const afterCatalogRead = await dependencies.authorization.revalidate(authorization.ticket, request, scope);
      if (signal.aborted) return cancelledResult();
      if (!afterCatalogRead.ok) return { status: 'error', error: afterCatalogRead.error };
      if (before.status === 'error') return { status: 'error', error: before.error };
      if (before.status === 'not_found') return modelNotFound(request);
      if (before.loadState === 'loaded') return { status: 'loaded', source: 'already_loaded' };

      const beforeDispatch = await dependencies.authorization.revalidate(authorization.ticket, request, scope);
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
            scope,
          );
          if (!result.ok) throw new ProviderProbeDestinationAuthorizationError(result.error);
        },
        redirectPolicy: 'reject',
        wallTimeMs: PROVIDER_MODEL_LOAD_WALL_TIME_MS,
        wallDeadlineAtMs: scope.lifetime.wallDeadlineAtMs,
        maxDecodedBodyBytes: PROVIDER_MODEL_LOAD_MAX_DECODED_BODY_BYTES,
        signal,
      });
      if (signal.aborted) return cancelledResult();
      const afterResponse = await dependencies.authorization.revalidate(authorization.ticket, request, scope);
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
        scope,
      });
      if (signal.aborted) return cancelledResult();
      const afterRefresh = await dependencies.authorization.revalidate(authorization.ticket, request, scope);
      if (signal.aborted) return cancelledResult();
      if (!afterRefresh.ok) return { status: 'error', error: afterRefresh.error };
      if (refreshed.status === 'error') return { status: 'error', error: refreshed.error };
      if (refreshed.status === 'not_supported') return modelStillUnloaded(request);

      const confirmed = await dependencies.catalog.readCurrentModel({ ...request, ticket: authorization.ticket, scope });
      if (signal.aborted) return cancelledResult();
      const afterRead = await dependencies.authorization.revalidate(authorization.ticket, request, scope);
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
        const current = await dependencies.authorization.revalidate(authorization.ticket, request, scope);
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
      const authorizationScope: ProviderModelLoadOperationScope = {
        lifetime: createProviderOperationLifetime({
          ...(input.signal ? { signal: input.signal } : {}),
          wallTimeMs: PROVIDER_MODEL_LOAD_WALL_TIME_MS,
        }),
      };
      const logicalKey = logicalOperationKey(request);
      const authorizationController = new AbortController();
      const abortAuthorization = () => authorizationController.abort();
      const unregisterAuthorization = registerPendingAuthorization(logicalKey, authorizationController);
      input.signal?.addEventListener('abort', abortAuthorization, { once: true });
      let authorized: AuthorizedLoad;
      try {
        authorized = await authorizeLoad({
          request,
          signal: authorizationController.signal,
          scope: authorizationScope,
        });
      } finally {
        unregisterAuthorization();
        input.signal?.removeEventListener('abort', abortAuthorization);
      }
      if (!authorized.ok) return authorized.result;
      const key = executionOperationKey(
        request,
        authorized.authorization.endpoint.endpointFingerprint,
      );
      let entry = inFlight.get(key);
      if (entry?.controller.signal.aborted) {
        if (inFlight.get(key) === entry) inFlight.delete(key);
        entry = undefined;
      }
      if (!entry) {
        const controller = new AbortController();
        const state = { subscribers: 0, settled: false };
        const promise = runLoad({
          request,
          authorization: authorized.authorization,
          signal: controller.signal,
          scope: {
            // The single-flight belongs to all callers; carry only the shared
            // deadline once admission has detached individual cancellation, but
            // retain the exact registry generation that authorized it.
            ...(authorized.scope.registry ? { registry: authorized.scope.registry } : {}),
            lifetime: { wallDeadlineAtMs: authorizationScope.lifetime.wallDeadlineAtMs },
          },
        });
        const createdEntry = { logicalKey, controller, promise, state };
        inFlight.set(key, createdEntry);
        const settle = () => {
          state.settled = true;
          if (inFlight.get(key) === createdEntry) inFlight.delete(key);
        };
        void promise.then(settle, settle);
        entry = createdEntry;
      }
      return subscribe(entry, input.signal);
    },
    async cancelNow(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult> {
      // Cancellation names the user's logical intent, so it reaches both the
      // authorizations still resolving for it and whichever endpoint generation
      // that intent is currently executing against.
      const request = normalizeRequest(input);
      const logicalKey = logicalOperationKey(request);
      for (const controller of pendingAuthorizations.get(logicalKey) ?? []) controller.abort();
      for (const entry of inFlight.values()) {
        if (entry.logicalKey === logicalKey) entry.controller.abort();
      }
      return cancelledResult();
    },
  });
}
