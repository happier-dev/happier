import type {
  ConnectedAccountPurposeDeclarationV1,
  PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import {
  PluginContributionIdentityV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
} from '@happier-dev/protocol';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import {
  isPluginHostAccessRequestAuthorizedBySelection,
} from '@/plugins/runtime/hostAccess/resourceSelection';
import { resolveManifestHostAccessRequests } from '@/plugins/runtime/hostAccess/manifestRequests';
import type {
  ConnectedAccountPurposeAuthorizationScope,
} from './ConnectedAccountPurposeBindingOwner';

type RegistryAuthorizationAgent = Readonly<{
  id: string;
  pluginId?: string;
  identity?: PluginContributionIdentityV1;
  richDefinition?: Readonly<{
    definition: Readonly<{
      connectedAccounts?: readonly ConnectedAccountPurposeDeclarationV1[];
    }>;
  }>;
}>;

type RegistryAuthorizationProvider = Readonly<{
  provenance: 'first_party' | 'external';
  identity: PluginContributionIdentityV1;
  managed?: Readonly<{
    connectedAccounts: readonly Readonly<
      Omit<ConnectedAccountPurposeDeclarationV1, 'service'> & {
        service: PluginContributionIdentityV1;
      }
    >[];
  }>;
}>;

export type RegistryAuthorizationScmHostingProvider = Readonly<{
  identity?: PluginContributionIdentityV1;
  pluginId?: string;
  definition: Readonly<{
    id: string;
    authService?: string | PluginContributionIdentityV1;
  }>;
}>;

type RegistryAuthorizationActivationTarget = Readonly<{
  pluginId: string;
  manifest: CanonicalPluginManifest;
}>;

type RegistryServiceReference = string | PluginContributionIdentityV1;

export type RegistryConnectedAccountPurposeAuthorizationProjection = Readonly<{
  agents: readonly RegistryAuthorizationAgent[];
  providers?: readonly RegistryAuthorizationProvider[];
  scmHostingProviders?: readonly RegistryAuthorizationScmHostingProvider[];
  activationTargets: readonly RegistryAuthorizationActivationTarget[];
}>;

export type ResolveRegistryConnectedAccountOptionalAccess = (
  pluginId: string,
) => readonly PluginAccessSelection[];

export type RegistryConnectedAccountPurposeConsumerScope = Readonly<{
  consumer: PluginContributionIdentityV1;
  authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
}>;

export const SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID = 'authentication';

function identityKey(identity: PluginContributionIdentityV1): string {
  return JSON.stringify([identity.pluginId, identity.localId]);
}

function qualifyServiceReference(
  pluginId: string,
  reference: RegistryServiceReference,
): PluginContributionIdentityV1 {
  return Object.freeze(PluginContributionIdentityV1Schema.parse(
    typeof reference === 'string'
      ? { pluginId, localId: reference }
      : reference,
  ));
}

/**
 * SCM hosting already declares exactly one authentication service. Its qualified
 * contribution identity is therefore the consumer and the family supplies one
 * stable authentication purpose; the exact auth service remains authorization
 * scope rather than becoming a second manifest selector or default.
 */
export function deriveScmHostingProviderConnectedAccountPurposeAuthorization(
  provider: RegistryAuthorizationScmHostingProvider,
): ConnectedAccountPurposeAuthorizationScope | null {
  const authService = provider.definition.authService;
  if (!authService) return null;
  const consumer = Object.freeze(PluginContributionIdentityV1Schema.parse(
    provider.identity ?? (
      provider.pluginId
        ? { pluginId: provider.pluginId, localId: provider.definition.id }
        : null
    ),
  ));
  if (
    consumer.localId !== provider.definition.id
    || (provider.pluginId !== undefined && consumer.pluginId !== provider.pluginId)
  ) {
    throw new Error('connected_account_scm_hosting_purpose_consumer_identity_mismatch');
  }
  const service = qualifyServiceReference(consumer.pluginId, authService);
  return Object.freeze({
    purpose: Object.freeze(QualifiedConnectedAccountPurposeV1Schema.parse({
      consumer,
      purpose: SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID,
    })),
    serviceRefs: Object.freeze([service]),
  });
}

function serviceRefsKey(serviceRefs: readonly PluginContributionIdentityV1[]): string {
  return JSON.stringify(serviceRefs.map(identityKey).sort());
}

export function deriveRegistryConnectedAccountPurposeAuthorizations(
  registry: RegistryConnectedAccountPurposeAuthorizationProjection,
  resolveOptionalAccess: ResolveRegistryConnectedAccountOptionalAccess = () => Object.freeze([]),
): readonly RegistryConnectedAccountPurposeConsumerScope[] {
  const purposesByConsumer = new Map<string, {
    consumer: PluginContributionIdentityV1;
    purposesById: Map<string, ConnectedAccountPurposeAuthorizationScope>;
  }>();
  const addPurpose = (
    consumerLike: PluginContributionIdentityV1,
    purposeId: string,
    serviceRefsLike: readonly RegistryServiceReference[],
  ): void => {
    const consumer = Object.freeze(PluginContributionIdentityV1Schema.parse(consumerLike));
    const consumerKey = identityKey(consumer);
    const owner = purposesByConsumer.get(consumerKey) ?? {
      consumer,
      purposesById: new Map<string, ConnectedAccountPurposeAuthorizationScope>(),
    };
    purposesByConsumer.set(consumerKey, owner);
    const purpose = Object.freeze(QualifiedConnectedAccountPurposeV1Schema.parse({
      consumer,
      purpose: purposeId,
    }));
    const serviceRefs = Object.freeze(
      [...serviceRefsLike]
        .map((service) => Object.freeze(PluginContributionIdentityV1Schema.parse(service)))
        .sort((left, right) => identityKey(left).localeCompare(identityKey(right))),
    );
    const existing = owner.purposesById.get(purpose.purpose);
    if (existing) {
      if (serviceRefsKey(existing.serviceRefs) !== serviceRefsKey(serviceRefs)) {
        throw new Error('connected_account_purpose_projection_conflicting_scope');
      }
      return;
    }
    owner.purposesById.set(purpose.purpose, Object.freeze({ purpose, serviceRefs }));
  };
  const ensureConsumer = (consumerLike: PluginContributionIdentityV1): void => {
    const consumer = Object.freeze(PluginContributionIdentityV1Schema.parse(consumerLike));
    const consumerKey = identityKey(consumer);
    if (purposesByConsumer.has(consumerKey)) return;
    purposesByConsumer.set(consumerKey, {
      consumer,
      purposesById: new Map<string, ConnectedAccountPurposeAuthorizationScope>(),
    });
  };
  const addDeclarations = (
    consumer: PluginContributionIdentityV1,
    ownerPluginId: string,
    declarations: readonly ConnectedAccountPurposeDeclarationV1[],
  ): void => {
    for (const declaration of declarations) {
      addPurpose(
        consumer,
        declaration.purpose,
        [qualifyServiceReference(ownerPluginId, declaration.service)],
      );
    }
  };

  for (const agent of registry.agents) {
    const declarations = agent.richDefinition?.definition.connectedAccounts ?? [];
    if (declarations.length === 0) continue;
    const consumer = agent.identity ?? (
      agent.pluginId
        ? PluginContributionIdentityV1Schema.parse({
            pluginId: agent.pluginId,
            localId: agent.id,
          })
        : null
    );
    if (!consumer) {
      throw new Error('connected_account_agent_purpose_consumer_identity_missing');
    }
    addDeclarations(consumer, consumer.pluginId, declarations);
  }

  for (const provider of registry.providers ?? []) {
    if (provider.provenance !== 'first_party' || !provider.managed) continue;
    addDeclarations(
      provider.identity,
      provider.identity.pluginId,
      provider.managed.connectedAccounts,
    );
  }

  for (const provider of registry.scmHostingProviders ?? []) {
    const authorization =
      deriveScmHostingProviderConnectedAccountPurposeAuthorization(provider);
    if (!authorization) continue;
    addPurpose(
      authorization.purpose.consumer,
      authorization.purpose.purpose,
      authorization.serviceRefs,
    );
  }

  for (const target of registry.activationTargets) {
    const addReferencedRequests = (
      family: 'actions' | 'hooks',
      localId: string,
      requestIds: readonly string[] | undefined,
    ): void => {
      const requests = resolveManifestHostAccessRequests({
        manifest: target.manifest,
        pluginId: target.pluginId,
        contribution: { family, localId },
        ...(requestIds ? { requestIds } : {}),
      });
      const consumer = { pluginId: target.pluginId, localId };
      for (const { request, required } of requests) {
        if (request.capability !== 'connectedAccounts') continue;
        ensureConsumer(consumer);
        if (!isPluginHostAccessRequestAuthorizedBySelection({
          pluginId: target.pluginId,
          request,
          required,
          optionalAccess: resolveOptionalAccess(target.pluginId),
        })) {
          continue;
        }
        addPurpose(
          consumer,
          request.id,
          request.scope.serviceRefs.map((reference) =>
            qualifyServiceReference(target.pluginId, reference)),
        );
      }
    };
    for (const action of target.manifest.contributes.actions) {
      addReferencedRequests('actions', action.id, action.hostAccess);
    }
    for (const hook of target.manifest.contributes.hooks) {
      addReferencedRequests('hooks', hook.id, hook.hostAccess);
    }
  }

  return Object.freeze(
    [...purposesByConsumer.values()]
      .sort((left, right) => identityKey(left.consumer).localeCompare(identityKey(right.consumer)))
      .map(({ consumer, purposesById }) => Object.freeze({
        consumer,
        authorizedPurposes: Object.freeze(
          [...purposesById.values()].sort((left, right) =>
            left.purpose.purpose.localeCompare(right.purpose.purpose)),
        ),
      })),
  );
}

export function deriveRegistryConnectedAccountPurposeReconciliationScopes(
  previous: RegistryConnectedAccountPurposeAuthorizationProjection | null,
  candidate: RegistryConnectedAccountPurposeAuthorizationProjection,
  persistedConsumers: readonly PluginContributionIdentityV1[] = Object.freeze([]),
  resolveCandidateOptionalAccess: ResolveRegistryConnectedAccountOptionalAccess =
    () => Object.freeze([]),
): readonly RegistryConnectedAccountPurposeConsumerScope[] {
  const previousScopes = previous
    ? deriveRegistryConnectedAccountPurposeAuthorizations(previous)
    : Object.freeze([]);
  const candidateScopes = deriveRegistryConnectedAccountPurposeAuthorizations(
    candidate,
    resolveCandidateOptionalAccess,
  );
  const scopesByConsumerKey = new Map(
    candidateScopes.map((scope) => [identityKey(scope.consumer), scope]),
  );
  for (const previousScope of previousScopes) {
    const key = identityKey(previousScope.consumer);
    if (scopesByConsumerKey.has(key)) continue;
    scopesByConsumerKey.set(key, Object.freeze({
      consumer: previousScope.consumer,
      authorizedPurposes: Object.freeze([]),
    }));
  }
  for (const persistedConsumerLike of persistedConsumers) {
    const persistedConsumer = Object.freeze(
      PluginContributionIdentityV1Schema.parse(persistedConsumerLike),
    );
    const key = identityKey(persistedConsumer);
    if (scopesByConsumerKey.has(key)) continue;
    scopesByConsumerKey.set(key, Object.freeze({
      consumer: persistedConsumer,
      authorizedPurposes: Object.freeze([]),
    }));
  }
  return Object.freeze(
    [...scopesByConsumerKey.values()].sort((left, right) =>
      identityKey(left.consumer).localeCompare(identityKey(right.consumer))),
  );
}
