import {
  applyProviderCatalogRefreshV1,
  createProviderProbeRequestFingerprintV1,
  mergeProviderCatalogV1,
  qualifiedPurposeKey,
  type OAuthBearerLeaseV1,
  type PluginContributionIdentityV1,
  type ProviderContributionV1,
  type ProviderCatalogTransitionStateV1,
  type ProviderModelDescriptorV1,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountPurposeV1,
  type QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';

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
}>;

export type AgentProviderCatalogObservationInput = Readonly<{
  machineId: string;
  operationId: string;
  consumer: PluginContributionIdentityV1;
  purpose: QualifiedConnectedAccountPurposeV1;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
  requestAuthUse: QualifiedConnectedAccountRequestAuthUseV1;
  provider: ProviderContributionV1;
  trigger: ProviderCatalogRefreshTrigger;
  isCurrent(): boolean;
  signal?: AbortSignal;
}>;

export type AgentProviderCatalogObservationService = Readonly<{
  observe(input: AgentProviderCatalogObservationInput): Promise<AgentProviderCatalogObservationResult>;
}>;

const MAX_OBSERVATIONS = 64;

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
  return {
    source: 'static',
    models: catalog.staticModels.map((model) => ({ ...model })),
    stale: false,
  };
}

function schedulerError(error: unknown): Readonly<{ retryAfterMs?: number }> | undefined {
  if (!(error instanceof ProviderProbeClientError) || error.retryAfterMs === undefined) {
    return undefined;
  }
  return Object.freeze({ retryAfterMs: error.retryAfterMs });
}

export function createAgentProviderCatalogObservationService(dependencies: Readonly<{
  activatePurposeBindings: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
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

  const remember = (identity: string, transition: ProviderCatalogTransitionStateV1): void => {
    transitionByIdentity.delete(identity);
    transitionByIdentity.set(identity, transition);
    while (transitionByIdentity.size > MAX_OBSERVATIONS) {
      const oldest = transitionByIdentity.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      transitionByIdentity.delete(oldest);
    }
  };

  return Object.freeze({
    async observe(input: AgentProviderCatalogObservationInput): Promise<AgentProviderCatalogObservationResult> {
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
        if (input.signal?.aborted) throw new ProviderProbeCancelledError();
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
      const endpointUrl = endpoint.baseUrl;
      if (!endpointUrl) return staticResult(catalog);
      const publicHeaders = endpoint.publicHeaders ?? Object.freeze({});
      let redaction: Pick<
        ProviderRedactionLease,
        'add' | 'containsSensitiveValue' | 'close'
      > | null = null;
      let requestAuthReady = false;
      const activateLease = (isCurrent: () => boolean) => dependencies.activatePurposeBindings({
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
        redaction = dependencies.createRedactionLease();
        const subject = scopeConnectedAccountPurposeBindingLease({
          lease,
          subjectId: lease.subjectId,
          uses: [input.requestAuthUse],
          registerRedaction: (values) => redaction?.add(values),
        });
        assertCurrent();
        assertLeaseCurrent(lease);
        let bearer = await dependencies.requestAuth.lookupRequestAuth({
          subject,
          purpose: input.purpose,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        assertCurrent();
        assertLeaseCurrent(lease);
        requestAuthReady = true;
        const requestFingerprint = createProviderProbeRequestFingerprintV1({
          method: 'GET',
          endpointUrl,
          path: probe.path,
          parser: probe.parser,
          publicHeaders,
        });
        const identityFor = (current: OAuthBearerLeaseV1): string => JSON.stringify([
          input.machineId,
          contributionKey(input.consumer),
          input.provider.id,
          input.purpose.purpose,
          requestFingerprint,
          requestAuthMaterializationKey(input.requestAuthUse),
          contributionKey(current.credentialContext.account.service),
          current.credentialContext.account.accountId,
          current.credentialContext.credentialRevision,
          current.credentialContext.group?.groupId ?? null,
          current.credentialContext.group?.generation ?? null,
        ]);
        const scheduledIdentity = identityFor(bearer);
        assertCurrent();
        assertLeaseCurrent(lease);
        redaction.close();
        redaction = null;
        lease.dispose();
        lease = null;
        assertCurrent();
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
          async (): Promise<AgentCatalogScheduledResult> => {
            let operationCurrent = true;
            const sharedLease = activateLease(() => operationCurrent);
            let sharedRedaction: Pick<
              ProviderRedactionLease,
              'add' | 'containsSensitiveValue' | 'close'
            > | null = null;
            try {
              const assertSharedWorkCurrent = (): void => assertLeaseCurrent(sharedLease);
              assertSharedWorkCurrent();
              sharedRedaction = dependencies.createRedactionLease();
              const sharedSubject = scopeConnectedAccountPurposeBindingLease({
                lease: sharedLease,
                subjectId: sharedLease.subjectId,
                uses: [input.requestAuthUse],
                registerRedaction: (values) => sharedRedaction?.add(values),
              });
              assertSharedWorkCurrent();
              let sharedBearer = await dependencies.requestAuth.lookupRequestAuth({
                subject: sharedSubject,
                purpose: input.purpose,
              });
              assertSharedWorkCurrent();
              const dispatch = async (current: OAuthBearerLeaseV1) => {
                assertSharedWorkCurrent();
                const result = await dependencies.client.getCatalog({
                  endpointUrl,
                  path: probe.path,
                  parser: probe.parser,
                  publicHeaders,
                  credentialPolicy: 'required',
                  resolveCredential: async () => ({
                    credential: {
                      kind: 'httpHeader',
                      name: 'authorization',
                      value: `Bearer ${current.accessToken}`,
                    },
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
                  completedKey: identityFor(sharedBearer),
                };
              } catch (error) {
                if (error instanceof ProviderProbeCancelledError) throw error;
                if (!(error instanceof ProviderProbeClientError) || error.httpStatus !== 401) {
                  const errorDetails = schedulerError(error);
                  return {
                    status: 'error',
                    completedKey: identityFor(sharedBearer),
                    ...(errorDetails ? { error: errorDetails } : {}),
                  };
                }
                assertSharedWorkCurrent();
                const recovery = await dependencies.requestAuth.refreshAfterAuthFailure({
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
                    completedKey: identityFor(sharedBearer),
                    ...(errorDetails ? { error: errorDetails } : {}),
                  };
                }
                sharedBearer = await dependencies.requestAuth.lookupRequestAuth({
                  subject: sharedSubject,
                  purpose: input.purpose,
                });
                assertSharedWorkCurrent();
                try {
                  return {
                    status: 'success',
                    result: await dispatch(sharedBearer),
                    completedKey: identityFor(sharedBearer),
                  };
                } catch (retryError) {
                  if (retryError instanceof ProviderProbeCancelledError) throw retryError;
                  const errorDetails = schedulerError(retryError);
                  return {
                    status: 'error',
                    completedKey: identityFor(sharedBearer),
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
            ? { status: 'success', observedAt: now(), models: scheduled.result.catalog.models }
            : { status: 'failed', failedAt: now() },
        );
        assertCurrent();
        remember(effectiveIdentity, transition);
        const merged = mergeProviderCatalogV1({
          staticModels: catalog.staticModels,
          manualModels: [],
          probeState: transition,
          membershipPolicy: catalog.membershipPolicy,
        });
        assertCurrent();
        if (!transition.snapshot) return staticResult(catalog);
        return {
          source: 'dynamic',
          stale: transition.snapshot.stale,
          models: merged.rows.map((row) => ({ ...row.descriptor })),
        };
      } catch (error) {
        if (error instanceof ProviderProbeCancelledError) throw error;
        assertCurrent();
        if (lease) assertLeaseCurrent(lease);
        if (!requestAuthReady) return staticResult(catalog);
        if (error instanceof ConnectedAccountRequestAuthError) return staticResult(catalog);
        throw error;
      } finally {
        redaction?.close();
        lease?.dispose();
      }
    },
  });
}
