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

type StaticProbeCatalog = Extract<ProviderContributionV1['catalog'], { source: 'static+probe' }>;

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

export function createAgentProviderCatalogObservationService(dependencies: Readonly<{
  activatePurposeBindings: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  requestAuth: Pick<ConnectedAccountRequestAuthService, 'lookupRequestAuth' | 'refreshAfterAuthFailure'>;
  createRedactionLease: () => Pick<ProviderRedactionLease, 'add' | 'close'>;
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
      const assertCurrent = (): void => {
        let current = false;
        try {
          current = input.signal?.aborted !== true
            && input.isCurrent()
            && (lease === null || lease.isCurrent());
        } catch {
          current = false;
        }
        if (!current) throw new ProviderProbeCancelledError();
      };
      assertCurrent();
      if (
        !input.binding
        || qualifiedPurposeKey(input.binding.purpose) !== qualifiedPurposeKey(input.purpose)
        || qualifiedPurposeKey(input.requestAuthUse.purpose) !== qualifiedPurposeKey(input.purpose)
      ) {
        assertCurrent();
        return staticResult(catalog);
      }
      const probe = catalog.probes[0];
      const endpoint = input.provider.endpointTemplates.find((candidate) => candidate.id === probe.endpointTemplateId);
      if (!endpoint) throw new TypeError('agent_catalog_observation_endpoint_missing');
      let redaction: Pick<ProviderRedactionLease, 'add' | 'close'> | null = null;
      let requestAuthReady = false;
      try {
        lease = dependencies.activatePurposeBindings({
          subject: {
            kind: 'agent_catalog_observation',
            operationId: input.operationId,
            consumer: input.consumer,
            isCurrent: input.isCurrent,
          },
          purposes: [input.purpose],
          bindings: [input.binding],
        });
        assertCurrent();
        redaction = dependencies.createRedactionLease();
        const subject = scopeConnectedAccountPurposeBindingLease({
          lease,
          subjectId: lease.subjectId,
          uses: [input.requestAuthUse],
          registerRedaction: (values) => redaction?.add(values),
        });
        assertCurrent();
        let bearer = await dependencies.requestAuth.lookupRequestAuth({
          subject,
          purpose: input.purpose,
        });
        assertCurrent();
        requestAuthReady = true;
        const requestFingerprint = createProviderProbeRequestFingerprintV1({
          method: 'GET',
          endpointUrl: endpoint.baseUrl,
          path: probe.path,
          parser: probe.parser,
          publicHeaders: endpoint.publicHeaders,
        });
        const identityFor = (current: OAuthBearerLeaseV1): string => JSON.stringify([
          input.machineId,
          contributionKey(input.consumer),
          input.provider.id,
          input.purpose.purpose,
          requestFingerprint,
          contributionKey(current.credentialContext.account.service),
          current.credentialContext.account.accountId,
          current.credentialContext.credentialRevision,
          current.credentialContext.group?.groupId ?? null,
          current.credentialContext.group?.generation ?? null,
        ]);
        const scheduledIdentity = identityFor(bearer);
        assertCurrent();
        const scheduled = await scheduler.runCatalogWithEffectiveKey(scheduledIdentity, input.trigger, async () => {
          const dispatch = async (current: OAuthBearerLeaseV1) => {
            assertCurrent();
            const result = await dependencies.client.getCatalog({
              endpointUrl: endpoint.baseUrl,
              path: probe.path,
              parser: probe.parser,
              publicHeaders: endpoint.publicHeaders,
              credentialPolicy: 'required',
              resolveCredential: async () => ({
                credential: {
                  kind: 'httpHeader',
                  name: 'authorization',
                  value: `Bearer ${current.accessToken}`,
                },
                close: () => {},
              }),
              authorizeDestination: async (destination) => {
                if (!subject.isCurrent() || destination.origin !== input.requestAuthUse.materialization.origin) {
                  throw new ProviderProbeCancelledError();
                }
              },
              ...(input.signal ? { signal: input.signal } : {}),
            });
            assertCurrent();
            return result;
          };
          try {
            return { status: 'success' as const, result: await dispatch(bearer), identity: identityFor(bearer) };
          } catch (error) {
            if (error instanceof ProviderProbeCancelledError) throw error;
            if (!(error instanceof ProviderProbeClientError) || error.httpStatus !== 401) {
              return { status: 'error' as const, error, identity: identityFor(bearer) };
            }
            assertCurrent();
            const recovery = await dependencies.requestAuth.refreshAfterAuthFailure({
              subject,
              request: {
                credentialContext: bearer.credentialContext,
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
            assertCurrent();
            if (recovery.status !== 'current_changed' && recovery.status !== 'stale_context') {
              return { status: 'error' as const, error, identity: identityFor(bearer) };
            }
            bearer = await dependencies.requestAuth.lookupRequestAuth({
              subject,
              purpose: input.purpose,
            });
            assertCurrent();
            try {
              return { status: 'success' as const, result: await dispatch(bearer), identity: identityFor(bearer) };
            } catch (retryError) {
              if (retryError instanceof ProviderProbeCancelledError) throw retryError;
              return { status: 'error' as const, error: retryError, identity: identityFor(bearer) };
            }
          }
        }, (result) => {
          assertCurrent();
          return result.identity;
        });
        assertCurrent();
        const effectiveIdentity = scheduled.identity;
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
