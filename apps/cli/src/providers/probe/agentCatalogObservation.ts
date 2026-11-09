import type { NativeCatalogTarget } from './nativeCatalogCredential';
import type { ContributedProviderCatalogParserBinding } from './catalog';
import { applyProviderCatalogRefreshV1 } from '@happier-dev/protocol/providers/catalog/merge';
import { projectAgentCatalogObservationSnapshot } from './agentCatalogSnapshot';
import { createProviderProbeRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { RequestAuthHeadersV1, PluginContributionIdentityV1, ProviderContributionV1, ProviderCatalogTransitionStateV1, ProviderModelDescriptorV1, QualifiedConnectedAccountPurposeBindingV1, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRequestAuthUseV1 } from '@happier-dev/protocol';

import type {
  ConnectedAccountPurposeBindingOwner,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
  scopeConnectedAccountPurposeBindingLease,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type {
  ConnectedAccountRequestAuthService,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import {
  ConnectedAccountRequestAuthError,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import type { ProviderRedactionLease } from '@/providers/spawn/redaction';

import {
  ProviderProbeCancelledError,
  ProviderProbeClientError,
  type ProviderCatalogGetRequest,
  type ProviderCatalogGetResult,
} from './client';
import {
  createProviderProbeScheduler,
  type ProviderCatalogRefreshTrigger,
} from './scheduler';

type ClientPort = Readonly<{
  getCatalog(input: ProviderCatalogGetRequest): Promise<ProviderCatalogGetResult>;
}>;

export type AgentProviderCatalogObservationResult = Readonly<{
  source: 'dynamic' | 'static';
  models: readonly ProviderModelDescriptorV1[];
  stale: boolean;
  observedAt?: number;
  refreshError?: boolean;
}>;

export type AgentProviderCatalogObservationInput = Readonly<{
  machineId: string;
  operationId: string;
  consumer: PluginContributionIdentityV1;
  purpose: QualifiedConnectedAccountPurposeV1;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
  requestAuthUse: QualifiedConnectedAccountRequestAuthUseV1;
  provider: ProviderContributionV1;
  resolveContributedCatalogParsers?: () => Promise<ContributedProviderCatalogParserBinding | null>;
  trigger: ProviderCatalogRefreshTrigger;
  currentOnly?: boolean;
  isCurrent(): boolean;
  signal?: AbortSignal;
  wallDeadlineAtMs?: number;
}>;

export type AgentProviderNativeCatalogObservationInput = Omit<
  AgentProviderCatalogObservationInput,
  'binding'
> & Readonly<{
  service: PluginContributionIdentityV1;
  target: NativeCatalogTarget;
}>;

export type AgentProviderCatalogObservationService = Readonly<{
  observe(input: AgentProviderCatalogObservationInput): Promise<AgentProviderCatalogObservationResult>;
  observeNative(input: AgentProviderNativeCatalogObservationInput): Promise<AgentProviderCatalogObservationResult>;
}>;

function contributionKey(identity: PluginContributionIdentityV1): string {
  return JSON.stringify([identity.pluginId, identity.localId]);
}

function requestAuthMaterializationKey(use: QualifiedConnectedAccountRequestAuthUseV1): string {
  const materialization = use.materialization;
  return JSON.stringify([
    materialization.kind,
    new URL(materialization.origin).origin,
    [...materialization.headerNames].map((name) => name.trim().toLowerCase()).sort(),
  ]);
}

type StaticProbeCatalog = Extract<ProviderContributionV1['catalog'], { source: 'static+probe' }>;
type AgentCatalogScheduledResult =
  | Readonly<{
      status: 'success';
      completedKey: string;
      result: ProviderCatalogGetResult;
      observedAt: number;
    }>
  | Readonly<{
      status: 'error';
      completedKey: string;
      error?: Readonly<{ retryAfterMs?: number }>;
    }>;

function requireSingleStaticProbeCatalog(provider: ProviderContributionV1): StaticProbeCatalog {
  if (provider.catalog.source !== 'static+probe' || provider.catalog.probes.length !== 1) {
    throw new TypeError('agent_catalog_observation_requires_one_static_probe');
  }
  return provider.catalog;
}

function staticResult(catalog: StaticProbeCatalog): AgentProviderCatalogObservationResult {
  return projectAgentCatalogObservationSnapshot(catalog);
}

function schedulerError(error: unknown): Readonly<{ retryAfterMs?: number }> | undefined {
  if (!(error instanceof ProviderProbeClientError) || error.retryAfterMs === undefined) {
    return undefined;
  }
  return Object.freeze({ retryAfterMs: error.retryAfterMs });
}

export function createAgentProviderCatalogObservationService(dependencies: Readonly<{
  activatePurposeBindings: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  readBindingObservation: ConnectedAccountPurposeBindingOwner['readBindingObservation'];
  requestAuth: Pick<ConnectedAccountRequestAuthService, 'lookupRequestAuth' | 'refreshAfterAuthFailure'>;
  createRedactionLease: () => Pick<
    ProviderRedactionLease,
    'add' | 'containsSensitiveValue' | 'close'
  >;
  client: ClientPort;
  scheduler: ReturnType<typeof createProviderProbeScheduler>;
  now?: () => number;
}>) {
  const scheduler = dependencies.scheduler;
  const now = dependencies.now ?? Date.now;
  const transitionByIdentity = new Map<string, ProviderCatalogTransitionStateV1>();
  type ObservationDependencies = typeof dependencies;

  const remember = (identity: string, transition: ProviderCatalogTransitionStateV1): void => {
    transitionByIdentity.set(identity, transition);
  };

  const observeWithDependencies = async (
    runtimeDependencies: ObservationDependencies,
    input: AgentProviderCatalogObservationInput,
    nativeTarget?: NativeCatalogTarget,
  ): Promise<AgentProviderCatalogObservationResult> => {
      const catalog = requireSingleStaticProbeCatalog(input.provider);
      let lease: ReturnType<ConnectedAccountPurposeBindingOwner['activatePurposeBindings']> | null = null;
      const assertInputCurrent = (): void => {
        let current = false;
        try {
          current = input.isCurrent();
        } catch {
          current = false;
        }
        if (!current) throw new ProviderProbeCancelledError();
      };
      const assertCurrent = (): void => {
        if (input.signal?.aborted || (input.wallDeadlineAtMs !== undefined && Date.now() >= input.wallDeadlineAtMs)) throw new ProviderProbeCancelledError();
        assertInputCurrent();
      };
      const assertLeaseCurrent = (
        activeLease: ReturnType<ConnectedAccountPurposeBindingOwner['activatePurposeBindings']>,
      ): void => {
        let current = false;
        try {
          current = activeLease.isCurrent();
        } catch {
          current = false;
        }
        if (!current) throw new ProviderProbeCancelledError();
      };
      assertCurrent();
      const binding = input.binding;
      if (
        !binding
        || qualifiedPurposeKey(binding.purpose) !== qualifiedPurposeKey(input.purpose)
        || qualifiedPurposeKey(input.requestAuthUse.purpose) !== qualifiedPurposeKey(input.purpose)
      ) {
        assertCurrent();
        return staticResult(catalog);
      }
      const probe = catalog.probes[0];
      const endpoint = input.provider.endpointTemplates.find((candidate) => candidate.id === probe.endpointTemplateId);
      if (!endpoint) throw new TypeError('agent_catalog_observation_endpoint_missing');
      const endpointUrl = nativeTarget?.endpointUrl ?? endpoint.baseUrl;
      if (!endpointUrl) return staticResult(catalog);
      const probePath = nativeTarget ? (() => {
        const base = new URL(endpointUrl);
        if (!base.pathname.endsWith('/')) base.pathname += '/';
        const request = new URL(probe.path.replace(/^\/+/, ''), base);
        return request.pathname + request.search;
      })() : probe.path;
      const publicHeaders = endpoint.publicHeaders ?? Object.freeze({});
      let observationReady = false;
      const activateLease = (isCurrent: () => boolean) => runtimeDependencies.activatePurposeBindings({
        subject: {
          kind: 'agent_catalog_observation',
          operationId: input.operationId,
          consumer: input.consumer,
          isCurrent,
        },
        purposes: [input.purpose],
        bindings: [binding],
      });
      try {
        lease = activateLease(input.isCurrent);
        assertCurrent();
        assertLeaseCurrent(lease);
        const observation = await runtimeDependencies.readBindingObservation({
          purpose: input.purpose,
          serviceRefs: [binding.target.kind === 'account' ? binding.target.account.service : binding.target.service],
          exactPurposeBindingSubjectId: lease.subjectId,
          signal: input.signal ?? new AbortController().signal,
        });
        assertCurrent();
        assertLeaseCurrent(lease);
        if (!observation || typeof observation.credentialRevision !== 'string') return staticResult(catalog);
        observationReady = true;
        const requestFingerprint = createProviderProbeRequestFingerprintV1({
          method: 'GET',
          endpointUrl,
          path: probePath,
          parser: probe.parser,
          publicHeaders,
        });
        const identityFor = (current: Pick<RequestAuthHeadersV1['credentialContext'], 'account' | 'credentialRevision' | 'group'>): string => JSON.stringify([
          input.machineId,
          contributionKey(input.consumer),
          input.provider.id,
          input.purpose.purpose,
          requestFingerprint,
          requestAuthMaterializationKey(input.requestAuthUse),
          nativeTarget?.headerBindings.map(({ name, format }) => [name.toLowerCase(), format]).sort() ?? null,
          contributionKey(current.account.service),
          current.account.accountId,
          current.credentialRevision,
          observation.configurationRevision ?? null,
          current.group?.groupId ?? null,
          current.group?.generation ?? null,
        ]);
        const scheduledIdentity = identityFor({ ...observation, credentialRevision: observation.credentialRevision });
        assertCurrent();
        assertLeaseCurrent(lease);
        lease.dispose();
        lease = null;
        assertCurrent();
        if (input.currentOnly) return projectAgentCatalogObservationSnapshot(catalog, transitionByIdentity.get(scheduledIdentity));
        const schedulerWaiter = {
          unavailable: (): AgentCatalogScheduledResult => ({
            status: 'error',
            completedKey: scheduledIdentity,
          }),
          ...(input.signal ? { signal: input.signal } : {}),
          isCurrent: input.isCurrent,
        };
        const scheduled = await scheduler.runCatalog(
          scheduledIdentity,
          input.trigger,
          async (signal): Promise<AgentCatalogScheduledResult> => {
            let operationCurrent = true;
            const sharedLease = activateLease(() => operationCurrent);
            let sharedRedaction: Pick<
              ProviderRedactionLease,
              'add' | 'containsSensitiveValue' | 'close'
            > | null = null;
            try {
              const assertSharedWorkCurrent = (): void => assertLeaseCurrent(sharedLease);
              assertSharedWorkCurrent();
              const contributedCatalogParsers = await input.resolveContributedCatalogParsers?.();
              assertSharedWorkCurrent();
              sharedRedaction = runtimeDependencies.createRedactionLease();
              const sharedSubject = scopeConnectedAccountPurposeBindingLease({
                lease: sharedLease,
                subjectId: sharedLease.subjectId,
                uses: [input.requestAuthUse],
                registerRedaction: (values) => sharedRedaction?.add(values),
              });
              assertSharedWorkCurrent();
              let sharedBearer = await runtimeDependencies.requestAuth.lookupRequestAuth({
                subject: sharedSubject,
                purpose: input.purpose,
              });
              assertSharedWorkCurrent();
              const dispatch = async (current: RequestAuthHeadersV1) => {
                assertSharedWorkCurrent();
                const result = await runtimeDependencies.client.getCatalog({
                  signal,
                  // Shared work outlives an individual waiter; the scheduler cancels it when no callers remain.
                  endpointUrl,
                  path: probePath,
                  parser: probe.parser,
                  ...(contributedCatalogParsers
                    ? { contributedCatalogParsers: contributedCatalogParsers.parsersByFormat }
                    : {}),
                  publicHeaders,
                  credentialPolicy: 'required',
                  resolveCredential: async () => ({
                    credential: (() => {
                      const credentials = Object.entries(current.headers).map(([name, value]) => ({ kind: 'httpHeader' as const, name, value }));
                      const first = credentials[0];
                      if (!first) throw new TypeError('native_catalog_header_binding_missing');
                      return { ...first, additionalCredentials: credentials.slice(1) };
                    })(),
                    containsSensitiveValue: (value) =>
                      sharedRedaction?.containsSensitiveValue(value) ?? false,
                    close: () => {},
                  }),
                  authorizeDestination: async (destination) => {
                    if (!sharedSubject.isCurrent() || destination.origin !== input.requestAuthUse.materialization.origin) {
                      throw new ProviderProbeCancelledError();
                    }
                  },
                });
                assertSharedWorkCurrent();
                return result;
              };
              try {
                return {
                  status: 'success',
                  result: await dispatch(sharedBearer),
                  observedAt: now(),
                  completedKey: identityFor(sharedBearer.credentialContext),
                };
              } catch (error) {
                if (error instanceof ProviderProbeCancelledError) throw error;
                if (!(error instanceof ProviderProbeClientError) || error.httpStatus !== 401) {
                  const errorDetails = schedulerError(error);
                  return {
                    status: 'error',
                    completedKey: identityFor(sharedBearer.credentialContext),
                    ...(errorDetails ? { error: errorDetails } : {}),
                  };
                }
                assertSharedWorkCurrent();
                const recovery = await runtimeDependencies.requestAuth.refreshAfterAuthFailure({
                  subject: sharedSubject,
                  request: {
                    credentialContext: sharedBearer.credentialContext,
                    normalizedFailure: {
                      class: 'authentication',
                      evidence: {
                        httpStatus: 401,
                        limitCategory: 'auth_invalid',
                        quotaScope: 'unknown',
                        evidenceSource: { kind: 'structured' },
                      },
                    },
                  },
                });
                assertSharedWorkCurrent();
                if (recovery.status !== 'current_changed' && recovery.status !== 'stale_context') {
                  const errorDetails = schedulerError(error);
                  return {
                    status: 'error',
                    completedKey: identityFor(sharedBearer.credentialContext),
                    ...(errorDetails ? { error: errorDetails } : {}),
                  };
                }
                sharedBearer = await runtimeDependencies.requestAuth.lookupRequestAuth({
                  subject: sharedSubject,
                  purpose: input.purpose,
                });
                assertSharedWorkCurrent();
                try {
                  return {
                    status: 'success',
                    result: await dispatch(sharedBearer),
                    observedAt: now(),
                    completedKey: identityFor(sharedBearer.credentialContext),
                  };
                } catch (retryError) {
                  if (retryError instanceof ProviderProbeCancelledError) throw retryError;
                  const errorDetails = schedulerError(retryError);
                  return {
                    status: 'error',
                    completedKey: identityFor(sharedBearer.credentialContext),
                    ...(errorDetails ? { error: errorDetails } : {}),
                  };
                }
              }
            } finally {
              operationCurrent = false;
              sharedRedaction?.close();
              sharedLease.dispose();
            }
          },
          schedulerWaiter,
        );
        assertCurrent();
        const effectiveIdentity = scheduled.completedKey;
        const previous = transitionByIdentity.get(effectiveIdentity)
          ?? { snapshot: null, staleProbeModels: [] };
        const transition = applyProviderCatalogRefreshV1(
              previous,
              scheduled.status === 'success'
                ? { status: 'success', observedAt: scheduled.observedAt, models: scheduled.result.catalog.models }
                : { status: 'failed', failedAt: now() },
            );
        assertCurrent();
        remember(effectiveIdentity, transition);
        assertCurrent();
        return projectAgentCatalogObservationSnapshot(catalog, transition, scheduled.status !== 'success');
      } catch (error) {
        if (error instanceof ProviderProbeCancelledError) throw error;
        assertCurrent();
        if (lease) assertLeaseCurrent(lease);
        if (!observationReady) return staticResult(catalog);
        if (error instanceof ConnectedAccountRequestAuthError) return staticResult(catalog);
        throw error;
      } finally {
        lease?.dispose();
      }
  };

  return Object.freeze({
    observe: async (input: AgentProviderCatalogObservationInput) => (
      await observeWithDependencies(dependencies, input)
    ),
    observeNative: async (input: AgentProviderNativeCatalogObservationInput) => {
      const nativeBinding = Object.freeze({
        purpose: input.purpose,
        target: Object.freeze({
          kind: 'account' as const,
          account: Object.freeze({ service: input.service, accountId: 'native' }),
        }),
      });
      const credentialRevision = `csr_${input.target.credentialFingerprint.slice('sha256:'.length, 'sha256:'.length + 32)}`;
      const nativeDependencies: ObservationDependencies = {
        ...dependencies,
        readBindingObservation: async () => ({
          purpose: input.purpose.purpose,
          service: input.service,
          target: { kind: 'account', displayName: 'Native account' },
          account: { service: input.service, accountId: 'native' },
          credentialRevision,
        }),
        requestAuth: {
          lookupRequestAuth: async ({ subject }) => {
            subject.registerRedaction([input.target.credentialValue]);
            return Object.freeze({
              headers: Object.fromEntries((input.target.headerBindings ?? [{ name: 'authorization', format: 'bearer' as const }])
                .map(binding => [binding.name, binding.format === 'bearer' ? `Bearer ${input.target.credentialValue}` : input.target.credentialValue])),
              facts: {},
              credentialContext: Object.freeze({
                account: Object.freeze({ service: input.service, accountId: 'native' }),
                credentialRevision,
                failingAccessTokenFingerprint: input.target.credentialFingerprint,
              }),
            });
          },
          refreshAfterAuthFailure: async () => Object.freeze({ status: 'current_unchanged' as const }),
        },
      };
      return await observeWithDependencies(nativeDependencies, {
        ...input,
        requestAuthUse: { purpose: input.purpose, materialization: {
          kind: 'httpHeaders', origin: new URL(input.target.endpointUrl).origin,
          headerNames: input.target.headerBindings.map(binding => binding.name),
        } },
        binding: nativeBinding,
      }, input.target);
    },
  });
}
