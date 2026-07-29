import {
  applyProviderCatalogRefreshV1,
  createProviderCatalogFingerprintV1,
  createProviderEndpointFingerprintV1,
  createProviderErrorV1,
  createProviderProbeRequestFingerprintV1,
  createProviderManagedProbeRequestFingerprintV1,
  ProviderConnectionIdSchema,
  ProviderMachineIdSchema,
  type ProviderCatalogProbeV1,
  type ProviderCatalogCommandFallbackV1,
  type ProviderErrorV1,
  type ProviderModelDescriptorV1,
  type ProviderObservationAuthorizationFingerprintV1,
  type ProviderRuntimeStateFileV1,
  type ProviderWireProtocol,
  type ProviderManagedCatalogSourceIdentityV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type AssessedProviderEndpoint,
} from '@happier-dev/protocol';

import {
  replaceProviderRuntimeStateRecord,
  serializeProviderRuntimeStateRecordKey,
  type ProviderRuntimeStateStore,
} from '../runtimeState';
import {
  ProviderProbeCredentialResolutionError,
  ProviderProbeDestinationAuthorizationError,
  type ProviderProbeAuthorizationPort,
  type ProviderProbeAuthorizationRequest,
} from './authorization';
import {
  ProviderProbeClientError,
  ProviderProbeCancelledError,
  type ProviderCatalogGetRequest,
  type ProviderCatalogGetResult,
} from './client';
import { providerProbeFailureHealthState, providerProbeSuccessHealthState } from './health';
import type { ResolvedFirstPartyManagedProviderFacet } from '../managed/types';
import type { ManagedProviderRuntimeAdapterV1 } from '../managed/types';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

export type ProviderProbeEndpoint = Readonly<{
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  normalizedUrl: string;
  publicHeaders: Readonly<Record<string, string>>;
  credentialPolicy?: 'none' | 'optional' | 'required';
}>;

export type ProviderManagedCatalogSource = Readonly<{
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  managedFacet: ResolvedFirstPartyManagedProviderFacet;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  catalogSource: ProviderManagedCatalogSourceIdentityV1;
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  publicHeaders: Readonly<Record<string, string>>;
  runtimeBinding?: Readonly<{
    contribution: ResolvedProviderContribution;
    runtimeAdapter: ManagedProviderRuntimeAdapterV1;
  }>;
}>;

export type ProviderManagedCatalogRuntimePort<TTicket> = Readonly<{
  launch(input: Readonly<{
    source: ProviderManagedCatalogSource;
    request: ProviderProbeAuthorizationRequest;
    ticket: TTicket;
    signal?: AbortSignal;
    revalidateBeforeEffect: () => Promise<
      Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>
    >;
  }>): Promise<
    | Readonly<{
        ok: true;
        endpointUrl: string;
        downstreamBearer: string;
        isCurrent: () => boolean;
        close: () => Promise<void>;
      }>
    | Readonly<{ ok: false; error: ProviderErrorV1 }>
  >;
}>;

type ProviderProbeClientPort = Readonly<{
  getCatalog(request: ProviderCatalogGetRequest): Promise<ProviderCatalogGetResult>;
}>;

export type ProviderCatalogRefreshResult =
  | Readonly<{
      status: 'success';
      models: ProviderCatalogGetResult['catalog']['models'];
      requestFingerprint: ProviderCatalogGetResult['requestFingerprint'];
    }>
  | Readonly<{ status: 'error'; error: ProviderErrorV1 }>
  | Readonly<{ status: 'not_supported' }>;

type ResolvedProviderProbeRequest = Readonly<{
  probe: ProviderCatalogProbeV1;
  endpoint: ProviderProbeEndpoint;
  requestFingerprint: ReturnType<typeof createProviderProbeRequestFingerprintV1>;
}>;

function resolveProviderProbeRequests(input: Readonly<{
  endpoints: readonly ProviderProbeEndpoint[];
  probes: readonly ProviderCatalogProbeV1[];
  catalogFallback?: ProviderCatalogCommandFallbackV1;
}>): Readonly<{
  requests: readonly ResolvedProviderProbeRequest[];
  catalogFingerprint: ReturnType<typeof createProviderCatalogFingerprintV1>;
}> {
  const endpointById = new Map(input.endpoints.map((endpoint) => [endpoint.endpointTemplateId, endpoint]));
  const requests = input.probes.map((probe) => {
    const endpoint = endpointById.get(probe.endpointTemplateId);
    if (!endpoint) throw new TypeError('Provider catalog probe references an unresolved endpoint');
    const requestFingerprint = createProviderProbeRequestFingerprintV1({
      method: 'GET',
      endpointUrl: endpoint.normalizedUrl,
      path: probe.path,
      parser: probe.parser,
      publicHeaders: endpoint.publicHeaders,
    });
    return { probe, endpoint, requestFingerprint };
  });
  return {
    requests,
    catalogFingerprint: createProviderCatalogFingerprintV1({
      probeRequestFingerprints: requests.map((request) => request.requestFingerprint),
      ...(input.catalogFallback ? {
        catalogFallback: {
          descriptor: input.catalogFallback,
          endpointUrl: (() => {
            const endpoint = endpointById.get(input.catalogFallback.endpointTemplateId);
            if (!endpoint) throw new TypeError('Provider catalog fallback references an unresolved endpoint');
            return endpoint.normalizedUrl;
          })(),
        },
      } : {}),
    }),
  };
}

export function createProviderCatalogRefreshFingerprint(input: Readonly<{
  endpoints: readonly ProviderProbeEndpoint[];
  probes: readonly ProviderCatalogProbeV1[];
  catalogFallback?: ProviderCatalogCommandFallbackV1;
  managedSource?: ProviderManagedCatalogSource;
}>): ReturnType<typeof createProviderCatalogFingerprintV1> {
  if (input.managedSource) {
    if (input.probes.length !== 1 || input.catalogFallback) {
      throw new TypeError('Managed Provider catalog requires one declared HTTP probe and no command fallback');
    }
    const probe = input.probes[0]!;
    if (probe.endpointTemplateId !== input.managedSource.endpointTemplateId) {
      throw new TypeError('Managed Provider catalog probe references another endpoint template');
    }
    return createProviderCatalogFingerprintV1({
      probeRequestFingerprints: [createProviderManagedProbeRequestFingerprintV1({
        implementationIdentity: input.managedSource.implementationIdentity,
        managedFacet: input.managedSource.managedFacet,
        purposeBindings: input.managedSource.purposeBindings,
        catalogSource: input.managedSource.catalogSource,
        endpointTemplateId: input.managedSource.endpointTemplateId,
        protocol: input.managedSource.protocol,
        method: 'GET',
        path: probe.path,
        parser: probe.parser,
        publicHeaders: input.managedSource.publicHeaders,
      })],
    });
  }
  return resolveProviderProbeRequests(input).catalogFingerprint;
}

class ProviderProbeCommitAuthorizationError extends Error {
  readonly error: ProviderErrorV1;
  constructor(error: ProviderErrorV1) {
    super(error.code);
    this.name = 'ProviderProbeCommitAuthorizationError';
    this.error = error;
  }
}

function providerErrorFromClient(
  error: ProviderProbeClientError,
  context: Readonly<{ connectionId: string; machineId: string }>,
): ProviderErrorV1 {
  return createProviderErrorV1(error.code, {
    connectionId: context.connectionId,
    machineId: context.machineId,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  });
}

export function createProviderCatalogService<TTicket, TCredentialRef>(dependencies: Readonly<{
  client: ProviderProbeClientPort;
  authorization: ProviderProbeAuthorizationPort<TTicket, TCredentialRef>;
  runtimeStore: ProviderRuntimeStateStore;
  now?: () => number;
  createObservationId: () => string;
  retryDelayMs: (failureCount: number) => number;
  managedCatalogRuntime?: ProviderManagedCatalogRuntimePort<TTicket>;
  localCatalogFallback?: Readonly<{
    run(input: Readonly<{
      descriptor: ProviderCatalogCommandFallbackV1;
      endpointUrl: string;
    }>): Promise<Readonly<{
      status: 'success';
      models: readonly ProviderModelDescriptorV1[];
    }> | Readonly<{ status: 'unavailable' }>>;
  }>;
}>) {
  const now = dependencies.now ?? Date.now;

  async function updateAuthorized(
    authorizations: readonly Readonly<{ ticket: TTicket; request: ProviderProbeAuthorizationRequest }>[],
    transform: (state: ProviderRuntimeStateFileV1) => ProviderRuntimeStateFileV1,
  ): Promise<ProviderErrorV1 | null> {
    try {
      await dependencies.runtimeStore.update(async (state) => {
        for (const authorization of authorizations) {
          const validation = await dependencies.authorization.revalidate(authorization.ticket, authorization.request);
          if (!validation.ok) throw new ProviderProbeCommitAuthorizationError(validation.error);
        }
        return transform(state);
      });
      return null;
    } catch (error) {
      if (error instanceof ProviderProbeCommitAuthorizationError) return error.error;
      throw error;
    }
  }

  return {
    async refresh(input: Readonly<{
      connectionId: string;
      machineId: string;
      endpoints: readonly ProviderProbeEndpoint[];
      probes: readonly ProviderCatalogProbeV1[];
      catalogFallback?: ProviderCatalogCommandFallbackV1;
      mode?: 'catalog' | 'health';
      signal?: AbortSignal;
      managedSource?: ProviderManagedCatalogSource;
    }>): Promise<ProviderCatalogRefreshResult> {
      if (input.probes.length === 0) return { status: 'not_supported' };
      const connectionId = ProviderConnectionIdSchema.parse(input.connectionId);
      const machineId = ProviderMachineIdSchema.parse(input.machineId);
      if (input.managedSource) {
        if (input.mode === 'health') return { status: 'not_supported' };
        if (!dependencies.managedCatalogRuntime) {
          return {
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
              connectionId,
              machineId,
            }),
          };
        }
        if (input.endpoints.length !== 0 || input.probes.length !== 1 || input.catalogFallback) {
          throw new TypeError('Managed Provider catalog uses no durable endpoints or command fallback');
        }
        const probe = input.probes[0]!;
        if (probe.endpointTemplateId !== input.managedSource.endpointTemplateId) {
          throw new TypeError('Managed Provider catalog probe references another endpoint template');
        }
        const managedRequestFingerprint = createProviderManagedProbeRequestFingerprintV1({
          implementationIdentity: input.managedSource.implementationIdentity,
          managedFacet: input.managedSource.managedFacet,
          purposeBindings: input.managedSource.purposeBindings,
          catalogSource: input.managedSource.catalogSource,
          endpointTemplateId: input.managedSource.endpointTemplateId,
          protocol: input.managedSource.protocol,
          method: 'GET',
          path: probe.path,
          parser: probe.parser,
          publicHeaders: input.managedSource.publicHeaders,
        });
        const catalogFingerprint = createProviderCatalogFingerprintV1({
          probeRequestFingerprints: [managedRequestFingerprint],
        });
        const authorizationRequest: ProviderProbeAuthorizationRequest = {
          deployment: 'managedLocal',
          connectionId,
          machineId,
          implementationIdentity: input.managedSource.implementationIdentity,
          managedFacet: input.managedSource.managedFacet,
          purposeBindings: input.managedSource.purposeBindings,
          catalogSource: input.managedSource.catalogSource,
          endpointTemplateId: input.managedSource.endpointTemplateId,
          protocol: input.managedSource.protocol,
          path: probe.path,
          parser: probe.parser,
          probeRequestFingerprint: managedRequestFingerprint,
        };
        const authorization = await dependencies.authorization.authorize(authorizationRequest);
        if (!authorization.ok) return { status: 'error', error: authorization.error };
        if (authorization.credentialRef !== null) {
          throw new TypeError('Managed Provider catalog authorization must be credential-free');
        }
        const initialValidation = await dependencies.authorization.revalidate(
          authorization.ticket,
          authorizationRequest,
        );
        if (!initialValidation.ok) return { status: 'error', error: initialValidation.error };

        const launched = await dependencies.managedCatalogRuntime.launch({
          source: input.managedSource,
          request: authorizationRequest,
          ticket: authorization.ticket,
          ...(input.signal ? { signal: input.signal } : {}),
          revalidateBeforeEffect: () => dependencies.authorization.revalidate(
            authorization.ticket,
            authorizationRequest,
          ),
        });
        if (!launched.ok) return { status: 'error', error: launched.error };
        try {
          const dispatchValidation = await dependencies.authorization.revalidate(
            authorization.ticket,
            authorizationRequest,
          );
          if (!dispatchValidation.ok) return { status: 'error', error: dispatchValidation.error };
          if (!launched.isCurrent()) {
            return {
              status: 'error',
              error: createProviderErrorV1('provider_authorization_changed', {
                connectionId,
                machineId,
              }),
            };
          }
          const exactRuntimeFingerprint = createProviderProbeRequestFingerprintV1({
            method: 'GET',
            endpointUrl: launched.endpointUrl,
            path: probe.path,
            parser: probe.parser,
            publicHeaders: input.managedSource.publicHeaders,
          });
          const result = await dependencies.client.getCatalog({
            endpointUrl: launched.endpointUrl,
            path: probe.path,
            parser: probe.parser,
            publicHeaders: input.managedSource.publicHeaders,
            credentialPolicy: 'required',
            authorizeDestination: async (destination: AssessedProviderEndpoint) => {
              const expectedOrigin = new URL(launched.endpointUrl).origin;
              if (
                !launched.isCurrent()
                || destination.origin !== expectedOrigin
                || destination.locality !== 'loopback'
              ) {
                throw new ProviderProbeDestinationAuthorizationError(
                  createProviderErrorV1('provider_authorization_changed', {
                    connectionId,
                    machineId,
                  }),
                );
              }
            },
            resolveCredential: async () => ({
              credential: {
                kind: 'httpHeader',
                name: 'authorization',
                value: `Bearer ${launched.downstreamBearer}`,
              },
              close: () => {},
            }),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (result.requestFingerprint !== exactRuntimeFingerprint) {
            throw new TypeError('Managed Provider probe client returned a mismatched realized request fingerprint');
          }
          const observedAt = now();
          const catalogObservationId = dependencies.createObservationId();
          const commitError = await updateAuthorized(
            [{ ticket: authorization.ticket, request: authorizationRequest }],
            (state) => {
              if (!launched.isCurrent()) {
                throw new ProviderProbeCommitAuthorizationError(
                  createProviderErrorV1('provider_authorization_changed', {
                    connectionId,
                    machineId,
                  }),
                );
              }
              const catalogKey = {
                machineId,
                connectionId,
                catalogFingerprint,
                observationAuthorizationFingerprint:
                  authorization.observationAuthorizationFingerprint,
              };
              const serializedCatalogKey = serializeProviderRuntimeStateRecordKey(
                'catalogs',
                { key: catalogKey },
              );
              const previous = state.catalogs.find((candidate) =>
                serializeProviderRuntimeStateRecordKey('catalogs', candidate)
                  === serializedCatalogKey);
              const transition = applyProviderCatalogRefreshV1(
                previous?.state.snapshot
                  ? {
                      snapshot: previous.state.snapshot,
                      staleProbeModels: previous.state.staleProbeModels,
                    }
                  : { snapshot: null, staleProbeModels: [] },
                { status: 'success', observedAt, models: result.catalog.models },
              );
              return {
                ...state,
                catalogs: [...replaceProviderRuntimeStateRecord('catalogs', state.catalogs, {
                  key: catalogKey,
                  state: { catalogObservationId, ...transition },
                  lastAccessedAt: observedAt,
                })],
                modelLoadStates: state.modelLoadStates
                  .filter((row) => !(
                    row.key.machineId === machineId
                    && row.key.connectionId === connectionId
                  ))
                  .concat(result.catalog.loadStates.map((load) => ({
                    key: {
                      machineId,
                      connectionId,
                      catalogObservationId,
                      modelId: load.modelId,
                    },
                    loadState: load.loadState,
                    observedAt,
                    lastAccessedAt: observedAt,
                  }))),
              };
            },
          );
          if (commitError) return { status: 'error', error: commitError };
          return {
            status: 'success',
            models: result.catalog.models,
            requestFingerprint: managedRequestFingerprint,
          };
        } catch (error) {
          if (error instanceof ProviderProbeCredentialResolutionError
            || error instanceof ProviderProbeDestinationAuthorizationError) {
            return { status: 'error', error: error.error };
          }
          if (error instanceof ProviderProbeCancelledError) throw error;
          if (error instanceof ProviderProbeClientError) {
            return {
              status: 'error',
              error: providerErrorFromClient(error, { connectionId, machineId }),
            };
          }
          throw error;
        } finally {
          await launched.close();
        }
      }
      const { requests, catalogFingerprint } = resolveProviderProbeRequests(input);
      let lastError: ProviderErrorV1 | undefined;
      const failedAuthorizations: Array<Readonly<{
        ticket: TTicket;
        request: ProviderProbeAuthorizationRequest;
        observationAuthorizationFingerprint: ProviderObservationAuthorizationFingerprintV1;
      }>> = [];

      for (const request of requests) {
        const authorizationRequest: ProviderProbeAuthorizationRequest = {
          connectionId,
          machineId,
          endpointTemplateId: request.endpoint.endpointTemplateId,
          endpointUrl: request.endpoint.normalizedUrl,
          protocol: request.endpoint.protocol,
          path: request.probe.path,
          parser: request.probe.parser,
          probeRequestFingerprint: request.requestFingerprint,
        };
        const authorization = await dependencies.authorization.authorize(authorizationRequest);
        if (!authorization.ok) return { status: 'error', error: authorization.error };
        const secretResolutionValidation = await dependencies.authorization.revalidate(
          authorization.ticket,
          authorizationRequest,
        );
        if (!secretResolutionValidation.ok) {
          return { status: 'error', error: secretResolutionValidation.error };
        }
        const endpointFingerprint = createProviderEndpointFingerprintV1({
          endpointTemplateId: request.endpoint.endpointTemplateId,
          protocol: request.endpoint.protocol,
          probeRequestFingerprint: request.requestFingerprint,
        });
        const endpointKey = {
          machineId,
          connectionId,
          endpointTemplateId: request.endpoint.endpointTemplateId,
          endpointFingerprint,
          observationAuthorizationFingerprint: authorization.observationAuthorizationFingerprint,
        };
        const serializedEndpointKey = serializeProviderRuntimeStateRecordKey('endpointHealth', { key: endpointKey });
        const checkingAt = now();
        let createdCheckingRecord = false;
        let checkingCommitError: ProviderErrorV1 | null;
        checkingCommitError = await updateAuthorized(
          [{ ticket: authorization.ticket, request: authorizationRequest }],
          (state) => {
            const previous = state.endpointHealth.find((candidate) =>
              serializeProviderRuntimeStateRecordKey('endpointHealth', candidate) === serializedEndpointKey);
            createdCheckingRecord = previous === undefined;
            const checkingRecord = {
              key: endpointKey,
              state: previous
                ? { ...previous.state, activity: 'checking' as const }
                : { status: 'not_checked' as const, activity: 'checking' as const },
              lastAccessedAt: checkingAt,
            };
            return {
              ...state,
              endpointHealth: [...replaceProviderRuntimeStateRecord('endpointHealth', state.endpointHealth, checkingRecord)],
            };
          },
        );
        if (checkingCommitError) {
          return { status: 'error', error: checkingCommitError };
        }

        const clearCheckingActivity = async (): Promise<void> => {
          await dependencies.runtimeStore.update((state) => {
            const previous = state.endpointHealth.find((candidate) =>
              serializeProviderRuntimeStateRecordKey('endpointHealth', candidate) === serializedEndpointKey);
            if (!previous) return state;
            if (previous.state.activity === 'idle') return state;
            if (createdCheckingRecord) {
              return {
                ...state,
                endpointHealth: state.endpointHealth.filter((candidate) =>
                  serializeProviderRuntimeStateRecordKey('endpointHealth', candidate) !== serializedEndpointKey),
              };
            }
            return {
              ...state,
              endpointHealth: [...replaceProviderRuntimeStateRecord('endpointHealth', state.endpointHealth, {
                ...previous,
                state: { ...previous.state, activity: 'idle' as const },
                lastAccessedAt: now(),
              })],
            };
          });
        };
        try {
          const credentialRef = authorization.credentialRef;
          const result = await dependencies.client.getCatalog({
            endpointUrl: request.endpoint.normalizedUrl,
            path: request.probe.path,
            parser: request.probe.parser,
            publicHeaders: request.endpoint.publicHeaders,
            credentialPolicy: request.endpoint.credentialPolicy ?? 'optional',
            authorizeDestination: async (destination) => {
              const result = await dependencies.authorization.authorizeDestination(
                authorization.ticket,
                authorizationRequest,
                destination,
              );
              if (!result.ok) throw new ProviderProbeDestinationAuthorizationError(result.error);
            },
            ...(credentialRef === null ? {} : {
              resolveCredential: async () => {
                const resolution = await dependencies.authorization.resolveCredential(credentialRef);
                if (!resolution.ok) throw new ProviderProbeCredentialResolutionError(resolution.error);
                return resolution.lease;
              },
            }),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (result.requestFingerprint !== request.requestFingerprint) {
            throw new TypeError('Provider probe client returned a mismatched request fingerprint');
          }
          const observedAt = now();
          const catalogObservationId = dependencies.createObservationId();
          const commitError = await updateAuthorized([{ ticket: authorization.ticket, request: authorizationRequest }], (state) => {
            const catalogKey = {
              machineId,
              connectionId,
              catalogFingerprint,
              observationAuthorizationFingerprint: authorization.observationAuthorizationFingerprint,
            };
            const serializedCatalogKey = serializeProviderRuntimeStateRecordKey('catalogs', { key: catalogKey });
            const previous = state.catalogs.find((candidate) =>
              serializeProviderRuntimeStateRecordKey('catalogs', candidate) === serializedCatalogKey);
            const transition = applyProviderCatalogRefreshV1(
              previous?.state.snapshot
                ? { snapshot: previous.state.snapshot, staleProbeModels: previous.state.staleProbeModels }
                : { snapshot: null, staleProbeModels: [] },
              { status: 'success', observedAt, models: result.catalog.models },
            );
            const endpointRecord = {
              key: endpointKey,
              state: providerProbeSuccessHealthState(observedAt),
              lastAccessedAt: observedAt,
            };
            const catalogRecord = {
              key: catalogKey,
              state: { catalogObservationId, ...transition },
              lastAccessedAt: observedAt,
            };
            const modelLoadStates = state.modelLoadStates
              .filter((row) => !(row.key.machineId === machineId && row.key.connectionId === connectionId))
              .concat(result.catalog.loadStates.map((load) => ({
                key: {
                  machineId,
                  connectionId,
                  catalogObservationId,
                  modelId: load.modelId,
                },
                loadState: load.loadState,
                observedAt,
                lastAccessedAt: observedAt,
              })));
            if (input.mode === 'health') {
              return {
                ...state,
                endpointHealth: [...replaceProviderRuntimeStateRecord('endpointHealth', state.endpointHealth, endpointRecord)],
              };
            }
            return {
              ...state,
              endpointHealth: [...replaceProviderRuntimeStateRecord('endpointHealth', state.endpointHealth, endpointRecord)],
              catalogs: [...replaceProviderRuntimeStateRecord('catalogs', state.catalogs, catalogRecord)],
              modelLoadStates: [...modelLoadStates],
            };
          });
          if (commitError) {
            await clearCheckingActivity();
            return { status: 'error', error: commitError };
          }
          return { status: 'success', models: result.catalog.models, requestFingerprint: result.requestFingerprint };
        } catch (error) {
          if (error instanceof ProviderProbeCredentialResolutionError) {
            await clearCheckingActivity();
            return { status: 'error', error: error.error };
          }
          if (error instanceof ProviderProbeDestinationAuthorizationError) {
            await clearCheckingActivity();
            return { status: 'error', error: error.error };
          }
          if (error instanceof ProviderProbeCancelledError) {
            await clearCheckingActivity();
            throw error;
          }
          if (!(error instanceof ProviderProbeClientError)) {
            await clearCheckingActivity();
            throw error;
          }
          const observedAt = now();
          const retryAt = observedAt + Math.max(dependencies.retryDelayMs(1), error.retryAfterMs ?? 0);
          const commitError = await updateAuthorized([{ ticket: authorization.ticket, request: authorizationRequest }], (state) => ({
            ...state,
            endpointHealth: [...replaceProviderRuntimeStateRecord('endpointHealth', state.endpointHealth, {
              key: {
                ...endpointKey,
              },
              state: providerProbeFailureHealthState(error, { observedAt, retryAt }),
              lastAccessedAt: observedAt,
            })],
          }));
          if (commitError) {
            await clearCheckingActivity();
            return { status: 'error', error: commitError };
          }
          lastError = providerErrorFromClient(error, {
            connectionId,
            machineId,
          });
          failedAuthorizations.push({
            ticket: authorization.ticket,
            request: authorizationRequest,
            observationAuthorizationFingerprint: authorization.observationAuthorizationFingerprint,
          });
        }
      }

      if (!lastError || failedAuthorizations.length === 0) {
        return {
          status: 'error',
          error: createProviderErrorV1('provider_probe_response_invalid', {
            connectionId,
            machineId,
          }),
        };
      }
      if (input.mode === 'health') return { status: 'error', error: lastError };

      if (input.catalogFallback && dependencies.localCatalogFallback) {
        const fallbackAuthorization = failedAuthorizations.find((candidate) =>
          candidate.request.endpointTemplateId === input.catalogFallback?.endpointTemplateId);
        const fallbackEndpoint = input.endpoints.find((candidate) =>
          candidate.endpointTemplateId === input.catalogFallback?.endpointTemplateId);
        if (!fallbackAuthorization || !fallbackEndpoint) {
          throw new TypeError('Provider catalog fallback does not match an authorized failed probe endpoint');
        }
        const validation = await dependencies.authorization.revalidate(
          fallbackAuthorization.ticket,
          fallbackAuthorization.request,
        );
        if (!validation.ok) return { status: 'error', error: validation.error };
        const fallback = await dependencies.localCatalogFallback.run({
          descriptor: input.catalogFallback,
          endpointUrl: fallbackEndpoint.normalizedUrl,
        });
        if (fallback.status === 'success') {
          const observedAt = now();
          const catalogObservationId = dependencies.createObservationId();
          const commitError = await updateAuthorized(
            [{ ticket: fallbackAuthorization.ticket, request: fallbackAuthorization.request }],
            (state) => {
              const catalogKey = {
                machineId,
                connectionId,
                catalogFingerprint,
                observationAuthorizationFingerprint: fallbackAuthorization.observationAuthorizationFingerprint,
              };
              const serializedCatalogKey = serializeProviderRuntimeStateRecordKey('catalogs', { key: catalogKey });
              const previous = state.catalogs.find((candidate) =>
                serializeProviderRuntimeStateRecordKey('catalogs', candidate) === serializedCatalogKey);
              const transition = applyProviderCatalogRefreshV1(
                previous?.state.snapshot
                  ? { snapshot: previous.state.snapshot, staleProbeModels: previous.state.staleProbeModels }
                  : { snapshot: null, staleProbeModels: [] },
                { status: 'success', observedAt, models: fallback.models },
              );
              return {
                ...state,
                catalogs: [...replaceProviderRuntimeStateRecord('catalogs', state.catalogs, {
                  key: catalogKey,
                  state: { catalogObservationId, ...transition },
                  lastAccessedAt: observedAt,
                })],
                modelLoadStates: state.modelLoadStates.filter((row) =>
                  !(row.key.machineId === machineId && row.key.connectionId === connectionId)),
              };
            },
          );
          if (commitError) return { status: 'error', error: commitError };
          return {
            status: 'success',
            models: fallback.models,
            requestFingerprint: fallbackAuthorization.request.probeRequestFingerprint,
          };
        }
      }

      const failedAt = now();
      const attemptedAuthorizationFingerprints = new Set(
        failedAuthorizations.map((authorization) => authorization.observationAuthorizationFingerprint),
      );
      const staleCommitError = await updateAuthorized(failedAuthorizations, (state) => ({
        ...state,
        catalogs: state.catalogs.map((previous) => {
          if (previous.key.machineId !== machineId
            || previous.key.connectionId !== connectionId
            || previous.key.catalogFingerprint !== catalogFingerprint
            || !attemptedAuthorizationFingerprints.has(previous.key.observationAuthorizationFingerprint)
            || !previous.state.snapshot) return previous;
          return {
            ...previous,
            state: {
              catalogObservationId: previous.state.catalogObservationId,
              ...applyProviderCatalogRefreshV1(
                { snapshot: previous.state.snapshot, staleProbeModels: previous.state.staleProbeModels },
                { status: 'failed', failedAt },
              ),
            },
            lastAccessedAt: failedAt,
          };
        }),
      }));
      if (staleCommitError) return { status: 'error', error: staleCommitError };
      return { status: 'error', error: lastError };
    },
  };
}
