import type {
  ConnectedAccountPurposeDeclarationV1,
  PluginActionConnectedAccountPurposeBindingV2,
  PluginEventAutomationHistoryGapResetActionInputV1,
  PluginContributionIdentityV1,
  QualifiedConnectedAccountPurposeBindingV1,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';
import {
  buildQualifiedPluginContributionKey,
  PluginEventAutomationHistoryGapResetActionInputV1Schema,
  PluginContributionIdentityV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
  readActionInputOptionValue,
  readActionInputPath,
} from '@happier-dev/protocol';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import {
  isPluginHostAccessRequestAuthorizedBySelection,
} from '@/plugins/runtime/hostAccess/resourceSelection';
import { resolveManifestHostAccessRequests } from '@/plugins/runtime/hostAccess/manifestRequests';
import type {
  ConnectedAccountPurposeAuthorizationScope,
  ConnectedAccountPurposeBindingOwner,
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
  definition: Readonly<{
    managedRuntime?: Readonly<{
      connectedAccounts?: readonly ConnectedAccountPurposeDeclarationV1[];
    }>;
  }>;
  managedRuntime?: Readonly<{ runtime: unknown }>;
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

type ActionFormConnectedAccountBindings = Pick<
  ConnectedAccountPurposeBindingOwner,
  'resolveBindingIntent'
>;

type RegistryConnectedAccountPurposeReconciliationOptions = Readonly<{
  /**
   * A declared activation target has no live Connected Account consumer until
   * its runtime activation is current. The caller supplies the registry's
   * canonical activation result; this projection does not infer availability.
   */
  candidateActivePluginIds?: ReadonlySet<string>;
}>;

/**
 * The sole declaration-to-purpose bridge for the Connected Account Action
 * form source. Its caller supplies only current target identity and field
 * path; purpose and services are derived from the target Action's own
 * HostAccess declaration.
 */
export type RegistryConnectedAccountActionFormPurposeAuthorization = Readonly<{
    action: PluginContributionIdentityV1;
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionIdentityV1[];
}>;

export type RegistryConnectedAccountActionPurposeBindingSnapshot = Readonly<{
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
}>;

/**
 * Host-only bridge from an admitted history-gap reset to its revalidated,
 * canonical persisted Event source. It is injected by the runtime owner, not
 * supplied by a plugin or derived from an arbitrary listed account.
 */
export type ResolveRegistryCurrentAutomationEventHistoryGapSource = (
  input: Readonly<{
    pluginId: string;
    eventLocalIds: readonly string[];
    reset: PluginEventAutomationHistoryGapResetActionInputV1;
    signal: AbortSignal;
    isCurrent(): boolean;
  }>,
) => Promise<Readonly<{
  eventLocalId: string;
  sourceConfig: unknown;
}> | null>;

export type RegistryConnectedAccountActionFormRevalidationResult = Readonly<{
  status: 'unavailable';
  code: string;
  message: string;
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

function resolveRegistryConnectedAccountAction(input: Readonly<{
  registry: Pick<RegistryConnectedAccountPurposeAuthorizationProjection, 'activationTargets'>;
  qualifiedActionId: string;
}>) {
  const matches = input.registry.activationTargets.flatMap((target) => (
    target.manifest.contributes.actions.flatMap((action) => {
      const identity = Object.freeze(PluginContributionIdentityV1Schema.parse({
        pluginId: target.pluginId,
        localId: action.id,
      }));
      return buildQualifiedPluginContributionKey(identity) === input.qualifiedActionId
        ? [Object.freeze({ target, action, identity })]
        : [];
    })
  ));
  return matches.length === 1 ? matches[0]! : null;
}

type RegistryConnectedAccountActionMatch = NonNullable<
  ReturnType<typeof resolveRegistryConnectedAccountAction>
>;

function resolveRegistryConnectedAccountActionPurposeAuthorizationFromMatch(input: Readonly<{
  match: RegistryConnectedAccountActionMatch;
  purposeId: string;
  requireSelect: boolean;
  resolveOptionalAccess?: ResolveRegistryConnectedAccountOptionalAccess;
}>): RegistryConnectedAccountActionFormPurposeAuthorization | null {
  const { target, action, identity } = input.match;
  let requests: ReturnType<typeof resolveManifestHostAccessRequests>;
  try {
    requests = resolveManifestHostAccessRequests({
      manifest: target.manifest,
      pluginId: identity.pluginId,
      contribution: { family: 'actions', localId: identity.localId },
      ...(action.hostAccess ? { requestIds: action.hostAccess } : {}),
    });
  } catch {
    return null;
  }
  const connectedAccountRequests = requests.filter((entry) => (
    entry.request.capability === 'connectedAccounts'
    && entry.request.id === input.purposeId
    && entry.request.scope.operations.includes('use')
    && (!input.requireSelect || entry.request.scope.operations.includes('select'))
  ));
  if (connectedAccountRequests.length !== 1) return null;
  const resolved = connectedAccountRequests[0]!;
  if (resolved.request.capability !== 'connectedAccounts') return null;
  if (!isPluginHostAccessRequestAuthorizedBySelection({
    pluginId: identity.pluginId,
    request: resolved.request,
    required: resolved.required,
    optionalAccess: input.resolveOptionalAccess?.(identity.pluginId) ?? Object.freeze([]),
  })) return null;

  return Object.freeze({
    action: identity,
    purpose: Object.freeze(QualifiedConnectedAccountPurposeV1Schema.parse({
      consumer: identity,
      purpose: input.purposeId,
    })),
    serviceRefs: Object.freeze(resolved.request.scope.serviceRefs.map((service) => (
      qualifyServiceReference(identity.pluginId, service)
    ))),
  });
}

function resolveRegistryConnectedAccountActionCredentialPurposeAuthorization(input: Readonly<{
  registry: Pick<RegistryConnectedAccountPurposeAuthorizationProjection, 'activationTargets'>;
  qualifiedActionId: string;
  fieldPath: string;
  requireSelect: boolean;
  resolveOptionalAccess?: ResolveRegistryConnectedAccountOptionalAccess;
}>): RegistryConnectedAccountActionFormPurposeAuthorization | null {
  const match = resolveRegistryConnectedAccountAction(input);
  if (!match) return null;
  const { target, action, identity } = match;
  const purposeMappings = action.connectedAccountPurposeBindings?.filter((binding) => (
    binding.path === input.fieldPath
  )) ?? [];
  if (purposeMappings.length !== 1) return null;
  return resolveRegistryConnectedAccountActionPurposeAuthorizationFromMatch({
    match: Object.freeze({ target, action, identity }),
    purposeId: purposeMappings[0]!.purpose,
    requireSelect: input.requireSelect,
    ...(input.resolveOptionalAccess
      ? { resolveOptionalAccess: input.resolveOptionalAccess }
      : {}),
  });
}

export function resolveRegistryConnectedAccountActionFormPurposeAuthorization(input: Readonly<{
  registry: Pick<RegistryConnectedAccountPurposeAuthorizationProjection, 'activationTargets'>;
  qualifiedActionId: string;
  fieldPath: string;
  resolveOptionalAccess?: ResolveRegistryConnectedAccountOptionalAccess;
}>): RegistryConnectedAccountActionFormPurposeAuthorization | null {
  const match = resolveRegistryConnectedAccountAction(input);
  if (!match) return null;
  const connectedAccountFields = match.action.inputHints?.fields.filter((field) => (
    field.path === input.fieldPath && field.connectedAccountOptions === true
  )) ?? [];
  if (connectedAccountFields.length !== 1) return null;
  return resolveRegistryConnectedAccountActionCredentialPurposeAuthorization({
    ...input,
    requireSelect: true,
  });
}

type RegistryAutomationEventHistoryGapSourceCandidate = Readonly<{
  eventLocalId: string;
  purposeBindings: readonly PluginActionConnectedAccountPurposeBindingV2[];
}>;

/**
 * Canonical manifests have already passed the Protocol Event declaration
 * schema. The intersection only bridges a temporarily stale generated CLI
 * dependency declaration; it does not reinterpret plugin input here.
 */
type HistoryGapRecoveryEventSourceDeclaration = Readonly<{
  connectedAccountPurposeBindings?: readonly PluginActionConnectedAccountPurposeBindingV2[];
}>;

function readRegistryAutomationEventHistoryGapSourceCandidates(
  match: RegistryConnectedAccountActionMatch,
): readonly RegistryAutomationEventHistoryGapSourceCandidate[] {
  return Object.freeze((match.target.manifest.contributes.events ?? []).flatMap((event) => {
    const source = event.kind === 'event' && event.automation?.eligible === true
      ? event.automation.source
      : null;
    if (
      source === null
      || source.historyGapResetActionRef?.pluginId !== match.identity.pluginId
      || source.historyGapResetActionRef.localId !== match.identity.localId
    ) return [];
    return [Object.freeze({
      eventLocalId: event.id,
      purposeBindings: Object.freeze([
        ...((source as typeof source & HistoryGapRecoveryEventSourceDeclaration)
          .connectedAccountPurposeBindings ?? []),
      ]),
    })];
  }));
}

function actionFormUnavailable(): RegistryConnectedAccountActionFormRevalidationResult {
  return Object.freeze({
    status: 'unavailable',
    code: 'plugin_action_form_connected_account_options_unavailable',
    message: 'The selected Connected Account is no longer available for this Action form',
  });
}

function historyGapSourceUnavailable(): RegistryConnectedAccountActionFormRevalidationResult {
  return Object.freeze({
    status: 'unavailable',
    code: 'plugin_action_history_gap_source_unavailable',
    message: 'The current Automation Event source is unavailable for this history-gap recovery Action',
  });
}

function actionGenerationRetired(): RegistryConnectedAccountActionFormRevalidationResult {
  return Object.freeze({
    status: 'unavailable',
    code: 'plugin_action_generation_retired',
    message: 'The target Action is no longer current',
  });
}

/**
 * Revalidates only a submitted dynamic Action-form ref. Declaration scope is
 * resolved here, while Account truth remains with the purpose-binding owner.
 */
export async function revalidateRegistryConnectedAccountActionFormInput(input: Readonly<{
  registry: Pick<RegistryConnectedAccountPurposeAuthorizationProjection, 'activationTargets'>;
  qualifiedActionId: string;
  value: unknown;
  resolveOptionalAccess?: ResolveRegistryConnectedAccountOptionalAccess;
  actionFormConnectedAccounts?: ActionFormConnectedAccountBindings;
  signal: AbortSignal;
  isCurrent(): boolean;
}>): Promise<RegistryConnectedAccountActionFormRevalidationResult | null> {
  input.signal.throwIfAborted();
  if (!input.isCurrent()) return actionGenerationRetired();
  const match = resolveRegistryConnectedAccountAction(input);
  if (!match) return null;
  const fields = match.action.inputHints?.fields.filter((field) => (
    field.connectedAccountOptions === true
  )) ?? [];
  for (const field of fields) {
    const rawValue = readActionInputPath(input.value, field.path);
    // The canonical Action input schema has already admitted this object. An
    // omitted optional dynamic field has no Account capability to revalidate.
    if (rawValue === undefined) continue;
    const selected = readActionInputOptionValue(rawValue);
    if (!selected || typeof selected === 'string') return actionFormUnavailable();
    const authorization = resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      registry: input.registry,
      qualifiedActionId: input.qualifiedActionId,
      fieldPath: field.path,
      ...(input.resolveOptionalAccess
        ? { resolveOptionalAccess: input.resolveOptionalAccess }
        : {}),
    });
    if (!authorization || !input.actionFormConnectedAccounts) return actionFormUnavailable();
    try {
      await input.actionFormConnectedAccounts.resolveBindingIntent({
        purpose: authorization.purpose,
        target: Object.freeze({
          kind: 'account' as const,
          account: selected,
        }),
        serviceRefs: authorization.serviceRefs,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      return input.isCurrent() ? actionFormUnavailable() : actionGenerationRetired();
    }
    input.signal.throwIfAborted();
    if (!input.isCurrent()) return actionGenerationRetired();
  }
  return null;
}

/**
 * Resolves one Action's explicitly declared credential-ref mappings into the
 * immutable operation snapshot consumed by the host target-Action lifetime.
 * A mapped but absent ref remains a covered, unbound purpose so an old durable
 * selection cannot silently regain authority.
 */
export async function resolveRegistryConnectedAccountActionPurposeBindingSnapshot(input: Readonly<{
  registry: Pick<RegistryConnectedAccountPurposeAuthorizationProjection, 'activationTargets'>;
  qualifiedActionId: string;
  value: unknown;
  resolveOptionalAccess?: ResolveRegistryConnectedAccountOptionalAccess;
  actionFormConnectedAccounts?: ActionFormConnectedAccountBindings;
  resolveAutomationEventHistoryGapSource?: ResolveRegistryCurrentAutomationEventHistoryGapSource;
  signal: AbortSignal;
  isCurrent(): boolean;
}>): Promise<
  | RegistryConnectedAccountActionPurposeBindingSnapshot
  | RegistryConnectedAccountActionFormRevalidationResult
> {
  input.signal.throwIfAborted();
  if (!input.isCurrent()) return actionGenerationRetired();
  const match = resolveRegistryConnectedAccountAction(input);
  if (!match) return Object.freeze({ purposes: [], bindings: [] });
  const mappings = match.action.connectedAccountPurposeBindings ?? [];
  const historyGapSourceCandidates = readRegistryAutomationEventHistoryGapSourceCandidates(match);
  const requiresHistoryGapSourceBinding = historyGapSourceCandidates.some((candidate) => (
    candidate.purposeBindings.length > 0
  ));
  const mappedPaths = new Set(mappings.map((mapping) => mapping.path));
  const dynamicFields = match.action.inputHints?.fields.filter((field) => (
    field.connectedAccountOptions === true
  )) ?? [];
  if (dynamicFields.some((field) => !mappedPaths.has(field.path))) {
    return actionFormUnavailable();
  }
  if (mappings.length === 0 && !requiresHistoryGapSourceBinding) {
    return Object.freeze({ purposes: [], bindings: [] });
  }
  const actionFormConnectedAccounts = input.actionFormConnectedAccounts;
  if (!actionFormConnectedAccounts) return actionFormUnavailable();

  const purposes: QualifiedConnectedAccountPurposeV1[] = [];
  const bindings: QualifiedConnectedAccountPurposeBindingV1[] = [];
  const purposeKeys = new Set<string>();
  for (const mapping of mappings) {
    const authorization = resolveRegistryConnectedAccountActionCredentialPurposeAuthorization({
      registry: input.registry,
      qualifiedActionId: input.qualifiedActionId,
      fieldPath: mapping.path,
      requireSelect: false,
      ...(input.resolveOptionalAccess
        ? { resolveOptionalAccess: input.resolveOptionalAccess }
        : {}),
    });
    if (!authorization) return actionFormUnavailable();
    const purposeKey = JSON.stringify([
      authorization.purpose.consumer.pluginId,
      authorization.purpose.consumer.localId,
      authorization.purpose.purpose,
    ]);
    if (purposeKeys.has(purposeKey)) return actionFormUnavailable();
    purposeKeys.add(purposeKey);
    purposes.push(authorization.purpose);

    const rawValue = readActionInputPath(input.value, mapping.path);
    if (rawValue === undefined || rawValue === null) continue;
    const selected = readActionInputOptionValue(rawValue);
    if (!selected || typeof selected === 'string') return actionFormUnavailable();
    try {
      bindings.push(await actionFormConnectedAccounts.resolveBindingIntent({
        purpose: authorization.purpose,
        target: Object.freeze({
          kind: 'account' as const,
          account: selected,
        }),
        serviceRefs: authorization.serviceRefs,
        signal: input.signal,
      }));
    } catch (error) {
      if (input.signal.aborted) throw error;
      return input.isCurrent() ? actionFormUnavailable() : actionGenerationRetired();
    }
    input.signal.throwIfAborted();
    if (!input.isCurrent()) return actionGenerationRetired();
  }

  if (requiresHistoryGapSourceBinding) {
    const reset = PluginEventAutomationHistoryGapResetActionInputV1Schema.safeParse(input.value);
    if (!reset.success || !input.resolveAutomationEventHistoryGapSource) {
      return historyGapSourceUnavailable();
    }
    let currentSource: Awaited<ReturnType<ResolveRegistryCurrentAutomationEventHistoryGapSource>>;
    try {
      currentSource = await input.resolveAutomationEventHistoryGapSource({
        pluginId: match.identity.pluginId,
        eventLocalIds: Object.freeze(historyGapSourceCandidates.map((candidate) => candidate.eventLocalId)),
        reset: reset.data,
        signal: input.signal,
        isCurrent: input.isCurrent,
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      return input.isCurrent() ? historyGapSourceUnavailable() : actionGenerationRetired();
    }
    input.signal.throwIfAborted();
    if (!input.isCurrent()) return actionGenerationRetired();
    if (currentSource === null) return historyGapSourceUnavailable();
    const sourceCandidates = historyGapSourceCandidates.filter((candidate) => (
      candidate.eventLocalId === currentSource.eventLocalId
    ));
    if (sourceCandidates.length !== 1) return historyGapSourceUnavailable();
    const sourceCandidate = sourceCandidates[0]!;
    for (const mapping of sourceCandidate.purposeBindings) {
      const authorization = resolveRegistryConnectedAccountActionPurposeAuthorizationFromMatch({
        match,
        purposeId: mapping.purpose,
        requireSelect: false,
        ...(input.resolveOptionalAccess
          ? { resolveOptionalAccess: input.resolveOptionalAccess }
          : {}),
      });
      if (!authorization) return historyGapSourceUnavailable();
      const purposeKey = JSON.stringify([
        authorization.purpose.consumer.pluginId,
        authorization.purpose.consumer.localId,
        authorization.purpose.purpose,
      ]);
      if (purposeKeys.has(purposeKey)) return historyGapSourceUnavailable();
      purposeKeys.add(purposeKey);
      purposes.push(authorization.purpose);

      const rawValue = readActionInputPath(currentSource.sourceConfig, mapping.path);
      if (rawValue === undefined || rawValue === null) continue;
      const selected = readActionInputOptionValue(rawValue);
      if (!selected || typeof selected === 'string') return historyGapSourceUnavailable();
      try {
        bindings.push(await actionFormConnectedAccounts.resolveBindingIntent({
          purpose: authorization.purpose,
          target: Object.freeze({
            kind: 'account' as const,
            account: selected,
          }),
          serviceRefs: authorization.serviceRefs,
          signal: input.signal,
        }));
      } catch (error) {
        if (input.signal.aborted) throw error;
        return input.isCurrent() ? historyGapSourceUnavailable() : actionGenerationRetired();
      }
      input.signal.throwIfAborted();
      if (!input.isCurrent()) return actionGenerationRetired();
    }
  }
  return Object.freeze({
    purposes: Object.freeze(purposes),
    bindings: Object.freeze(bindings),
  });
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
    const managedDeclaration = provider.definition.managedRuntime;
    if (!managedDeclaration || !provider.managedRuntime) continue;
    addDeclarations(
      provider.identity,
      provider.identity.pluginId,
      managedDeclaration.connectedAccounts ?? [],
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
      family: 'actions' | 'hooks' | 'backgroundServices',
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
    for (const backgroundService of target.manifest.contributes.backgroundServices) {
      addReferencedRequests('backgroundServices', backgroundService.id, undefined);
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

/**
 * Projects only an authoritative local registry transition. Empty scopes mean
 * a consumer was declared in the prior active registry and was then removed
 * from its candidate; persisted Account bindings cannot make that claim,
 * because another machine may still own their consumer.
 */
export function deriveRegistryConnectedAccountPurposeReconciliationScopes(
  previous: RegistryConnectedAccountPurposeAuthorizationProjection | null,
  candidate: RegistryConnectedAccountPurposeAuthorizationProjection,
  resolveCandidateOptionalAccess: ResolveRegistryConnectedAccountOptionalAccess =
    () => Object.freeze([]),
  options: RegistryConnectedAccountPurposeReconciliationOptions = Object.freeze({}),
): readonly RegistryConnectedAccountPurposeConsumerScope[] {
  const previousScopes = previous
    ? deriveRegistryConnectedAccountPurposeAuthorizations(previous)
    : Object.freeze([]);
  const candidateActivePluginIds = options.candidateActivePluginIds;
  const unavailableCandidatePluginIds = new Set(
    candidateActivePluginIds
      ? candidate.activationTargets
        .filter((target) => !candidateActivePluginIds.has(target.pluginId))
        .map((target) => target.pluginId)
      : [],
  );
  const candidateScopes = deriveRegistryConnectedAccountPurposeAuthorizations(
    candidate,
    resolveCandidateOptionalAccess,
  ).filter((scope) => !unavailableCandidatePluginIds.has(scope.consumer.pluginId));
  const scopesByConsumerKey = new Map(
    candidateScopes.map((scope) => [identityKey(scope.consumer), scope]),
  );
  for (const previousScope of previousScopes) {
    const key = identityKey(previousScope.consumer);
    if (scopesByConsumerKey.has(key)) continue;
    if (unavailableCandidatePluginIds.has(previousScope.consumer.pluginId)) continue;
    scopesByConsumerKey.set(key, Object.freeze({
      consumer: previousScope.consumer,
      authorizedPurposes: Object.freeze([]),
    }));
  }
  return Object.freeze(
    [...scopesByConsumerKey.values()].sort((left, right) =>
      identityKey(left.consumer).localeCompare(identityKey(right.consumer))),
  );
}
