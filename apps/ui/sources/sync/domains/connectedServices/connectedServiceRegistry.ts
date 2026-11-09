import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServiceIdSchema, isBuiltInLegacyConnectedAccountPeerOperationSupported, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginConnectedAccountAuthenticationModeV2, PluginConnectedAccountAuthenticationV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { ConnectedAccountUiProjectionEntryV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type {
  ConnectedAccountDescriptorProjectionConflict,
  ConnectedAccountDescriptorProjectionState,
} from './connectedAccountDescriptorProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ConnectedAccountUiNegotiation } from './resolveConnectedAccountUiNegotiation';
import { isAccountDirectConnectedAccountModeV1, resolveConnectedAccountPlanLabel } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';

export type ConnectedServiceDisplayNameKey =
  | 'connectedServices.serviceNames.claudeSubscription'
  | 'connectedServices.serviceNames.openaiCodex'
  | 'connectedServices.serviceNames.openai'
  | 'connectedServices.serviceNames.anthropic'
  | 'connectedServices.serviceNames.gemini'
  | 'connectedServices.serviceNames.github'
  | 'connectedServices.serviceNames.bitbucket'
  | 'connectedServices.fallbackName';

export type ConnectedServiceOauthPasteCopyKeyPrefix =
  | 'connectedServices.oauthPaste'
  | 'connectedServices.oauthPaste.providerOverrides.claudeSubscription';

type ConnectedServiceOauthAddActionMode = 'device' | 'paste' | 'browser';
type ConnectedServiceTokenKind =
  | 'api-key'
  | 'setup-token'
  | 'personal-access-token'
  | 'api-token';

// Built-in presentation follows the same exact qualified identity as the released compatibility
// owner. A third-party contribution with a matching local id never borrows these instructions.
const BUILT_IN_SETUP_PRESENTATION = {
  'claude-subscription': { order: 0, firstRun: true, catalogDescriptionKey: 'connectedServicesSettings.catalogClaude' },
  'openai-codex': { order: 1, firstRun: true, catalogDescriptionKey: 'connectedServicesSettings.catalogChatGpt' },
  gemini: { order: 2, firstRun: true, catalogDescriptionKey: 'connectedServicesSettings.catalogGemini' },
  anthropic: {
    order: 3, firstRun: false, catalogDescriptionKey: 'connectedServicesSettings.catalogAnthropic',
  },
  openai: { order: 4, firstRun: false, catalogDescriptionKey: 'connectedServicesSettings.catalogOpenAi' },
} as const;

export function getConnectedServiceSetupPresentation(service: PluginContributionIdentityV1) {
  const legacyServiceId = resolveLegacyServiceId(service);
  if (!legacyServiceId || !(legacyServiceId in BUILT_IN_SETUP_PRESENTATION)) return null;
  return BUILT_IN_SETUP_PRESENTATION[legacyServiceId as keyof typeof BUILT_IN_SETUP_PRESENTATION];
}

export type ConnectedServiceRegistryEntry = Readonly<{
  serviceId: ConnectedAccountUiProjectionEntryV1['serviceId'];
  /**
   * The single authoritative service identity for every projected V4 entry.
   * `serviceId` remains descriptor presentation/legacy-compatibility data only.
   */
  service?: Readonly<{ pluginId: string; localId: string }>;
  /** Present only when this exact qualified owner has a released V2/V3 adapter. */
  legacyServiceId?: ConnectedServiceId;
  connectCommand: string;
  displayNameKey?: ConnectedServiceDisplayNameKey;
  /** Short brand-only name for compact surfaces; fall back to the localized display name when absent. */
  shortName?: string;
  oauthPasteCopyKeyPrefix?: ConnectedServiceOauthPasteCopyKeyPrefix;
  supportsOauth: boolean;
  /**
   * Optional list of OAuth "add profile" surface modes this service wants to expose
   * explicitly in the service detail Actions group.
   *
   * When omitted or length <= 1, the UI uses the generic "Add OAuth profile" action.
   */
  oauthAddActionModes?: ReadonlyArray<ConnectedServiceOauthAddActionMode>;
  defaultAuthenticationModeId?: ConnectedAccountUiProjectionEntryV1['authentication']['defaultModeId'];
  authenticationModes?: ConnectedAccountUiProjectionEntryV1['authentication']['modes'];
  supportsToken?: boolean;
  tokenKind?: ConnectedServiceTokenKind;
  tokenSetupUrl?: string;
  tokenPromptLabelKey?: string;
  tokenMissingValueErrorKey?: string;
  tokenIdentityPromptLabelKey?: string;
  tokenIdentityMissingValueErrorKey?: string;
  /** Full serializable daemon-projected descriptor fact for this exact qualified service. */
  projectedDescriptor?: ConnectedAccountUiProjectionEntryV1;
  /** Every candidate is retained when ownership facts conflict; none is executable. */
  projectedDescriptorCandidates?: readonly ConnectedAccountUiProjectionEntryV1[];
  projectedTitle?: ConnectedAccountUiProjectionEntryV1['title'];
  projectedDescription?: ConnectedAccountUiProjectionEntryV1['description'];
  provenance?: ConnectedAccountUiProjectionEntryV1['provenance'];
  sourceKind?: string;
  availability?: ConnectedAccountUiProjectionEntryV1['availability'];
  diagnostics?: readonly string[];
  /** Entry readiness; Account census freshness stays on the registry snapshot. */
  projectionStatus?: ConnectedAccountDescriptorProjectionState['status'];
  projectionConflicts?: readonly ConnectedAccountDescriptorProjectionConflict[];
  executable?: boolean;
}>;

/**
 * Offers Account authoring, not native execution. A retained account does not
 * consume its service's auth declaration; the Action still admits execution.
 */
export function canExecuteConnectedServiceAction(
  entry: ConnectedServiceRegistryEntry,
  transport: ConnectedAccountUiNegotiation,
): boolean {
  const availability = entry.availability ?? entry.projectedDescriptor?.availability;
  if (entry.projectionStatus === 'conflict' || entry.projectionConflicts?.length
    || (entry.projectedDescriptorCandidates?.length ?? 0) > 1
    || availability?.state === 'disabled'
    || (availability?.state === 'blocked' && availability.reason !== 'execution_origin_unavailable')) return false;
  return entry.executable === true
    || Boolean(entry.service && (getConnectedAccountAuthentication(entry.service, { entries: [entry] })?.modes.length ?? 0) > 0)
    || (transport === 'legacy' && Boolean(entry.legacyServiceId) && !entry.projectedDescriptor);
}

function readAccountDirectConnectedServiceModes(
  entry: ConnectedServiceRegistryEntry,
): readonly PluginConnectedAccountAuthenticationModeV2[] {
  if (entry.projectionStatus === 'conflict' || entry.projectionConflicts?.length
    || (entry.projectedDescriptorCandidates?.length ?? 0) > 1) return [];
  if (entry.projectionStatus === 'ready' && entry.availability?.state === 'available') {
    return entry.authenticationModes?.filter(isAccountDirectConnectedAccountModeV1) ?? [];
  }
  // prepareDescriptor withdraws native execution with this exact fact. The
  // admitted bundled manifest still owns Account-only field declarations;
  // other blocked/disabled policy facts must not borrow that authority.
  if (entry.availability?.state !== 'blocked' || entry.availability.reason !== 'execution_origin_unavailable'
    || entry.provenance !== 'first_party' || entry.sourceKind !== 'bundled' || !entry.service) return [];
  return BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[buildQualifiedPluginContributionKey(entry.service)]
    ?.descriptor.authentication.modes.filter(isAccountDirectConnectedAccountModeV1) ?? [];
}

export type ConnectedServiceRegistrySnapshot = Readonly<{
  scopeKey: string | null;
  status: ConnectedAccountDescriptorProjectionState['status'];
  entries: readonly ConnectedServiceRegistryEntry[];
  errorReason: ConnectedAccountDescriptorProjectionState['errorReason'];
}>;

let connectedServiceRegistrySnapshot: ConnectedServiceRegistrySnapshot = {
  scopeKey: null,
  status: 'loading',
  entries: Object.freeze([]),
  errorReason: null,
};
let connectedServiceRegistryAccountLifetime: ActiveServerAccountScopeLifetime | null = null;
let connectedServiceRegistryDescriptorProjection: ConnectedAccountDescriptorProjectionState | null = null;
const EMPTY_ACCOUNT_DESCRIPTORS: readonly ConnectedAccountUiProjectionEntryV1[] = Object.freeze([]);
let connectedServiceRegistryAccountDescriptors = EMPTY_ACCOUNT_DESCRIPTORS;
const registryListeners = new Set<() => void>();

export function subscribeConnectedServiceRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => { registryListeners.delete(listener); };
}

function createConnectedServiceRegistryLoadingSnapshot(
  scopeKey: string | null,
): ConnectedServiceRegistrySnapshot {
  return Object.freeze({
    scopeKey,
    status: 'loading' as const,
    entries: Object.freeze([]),
    errorReason: null,
  });
}

function readProjectedFieldTitle(
  value: ConnectedAccountUiProjectionEntryV1['title'],
): string {
  return typeof value === 'string' ? value : value.fallback;
}

// Validate the generated immutable input once. Its projection can contain
// newer qualified services that are not part of the released scalar contract.
const bundledLegacyServiceIds = Object.keys(BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID)
  .filter((serviceId): serviceId is ConnectedServiceId => ConnectedServiceIdSchema.safeParse(serviceId).success);

function readBundledLegacyConnectedAccountCompatibility(
  serviceId: string,
) {
  const legacyServiceId = bundledLegacyServiceIds.find(id => id === serviceId);
  if (!legacyServiceId) return null;
  return {
    serviceId: legacyServiceId,
    compatibility:
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        legacyServiceId
      ],
  };
}

function sameService(
  left: Readonly<{ pluginId: string; localId: string }>,
  right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function resolveProjectedService(
  descriptor: ConnectedAccountUiProjectionEntryV1,
): PluginContributionIdentityV1 | null {
  if (descriptor.pluginId) {
    return {
      pluginId: descriptor.pluginId,
      localId: descriptor.id,
    };
  }
  return readBundledLegacyConnectedAccountCompatibility(
    descriptor.serviceId,
  )?.compatibility.service ?? null;
}

function resolveLegacyServiceId(
  service: Readonly<{ pluginId: string; localId: string }> | null,
): ConnectedServiceId | null {
  if (!service) return null;
  for (const legacyServiceId of Object.keys(
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  )) {
    const legacy = readBundledLegacyConnectedAccountCompatibility(
      legacyServiceId,
    );
    if (legacy && sameService(legacy.compatibility.service, service)) {
      return legacy.serviceId;
    }
  }
  return null;
}

function descriptorIdentity(
  descriptor: ConnectedAccountUiProjectionEntryV1,
): string {
  return `${descriptor.pluginId ?? 'first_party'}\u0000${descriptor.id}`;
}

function projectedEntryKey(
  descriptor: ConnectedAccountUiProjectionEntryV1,
): string {
  const service = resolveProjectedService(descriptor);
  // A descriptor without a qualified service cannot be executable, but retain
  // it as a visible unavailable row instead of inventing a scalar owner.
  return service
    ? buildQualifiedPluginContributionKey(service)
    : `unqualified\u0000${descriptorIdentity(descriptor)}`;
}

export function installConnectedAccountDescriptorProjection(
  projection: ConnectedAccountDescriptorProjectionState,
  accountLifetime: ActiveServerAccountScopeLifetime | null = null,
  accountDescriptors: readonly ConnectedAccountUiProjectionEntryV1[] = EMPTY_ACCOUNT_DESCRIPTORS,
): boolean {
  if (accountLifetime && !accountLifetime.isCurrent()) return false;
  if (connectedServiceRegistryDescriptorProjection === projection && connectedServiceRegistryAccountLifetime === accountLifetime
    && connectedServiceRegistryAccountDescriptors === accountDescriptors) return false;
  connectedServiceRegistrySnapshot = {
    scopeKey: projection.scopeKey,
    status: projection.status,
    entries: projectConnectedServiceRegistryEntries(projection, accountDescriptors),
    errorReason: projection.errorReason,
  };
  connectedServiceRegistryAccountLifetime = accountLifetime;
  connectedServiceRegistryDescriptorProjection = projection;
  connectedServiceRegistryAccountDescriptors = accountDescriptors;
  for (const listener of registryListeners) listener();
  return true;
}

/** The same descriptor projection for an explicitly captured target, without installing it as focused Account state. */
export function projectConnectedServiceRegistryEntries(
  projection: ConnectedAccountDescriptorProjectionState,
  accountDescriptors: readonly ConnectedAccountUiProjectionEntryV1[] = EMPTY_ACCOUNT_DESCRIPTORS,
): readonly ConnectedServiceRegistryEntry[] {
  const answeredIdentities = new Set(projection.answeredDescriptorIdentities ?? (
    projection.status === 'ready' || projection.status === 'conflict'
      ? projection.descriptors.map(descriptorIdentity)
      : []
  ));
  const descriptorsByQualifiedService = new Map<string, ConnectedAccountUiProjectionEntryV1[]>();
  for (const descriptor of projection.descriptors) {
    const key = projectedEntryKey(descriptor);
    const descriptors = descriptorsByQualifiedService.get(key) ?? [];
    descriptors.push(descriptor);
    descriptorsByQualifiedService.set(key, descriptors);
  }
  // Machine publication alone owns native execution. Account declarations may
  // replace authoring metadata without borrowing its availability or conflicts.
  const nativeExecutableKeys = new Set([...descriptorsByQualifiedService].flatMap(([key, candidates]) => {
    const descriptor = candidates[0]!;
    return candidates.length === 1 && answeredIdentities.has(descriptorIdentity(descriptor))
      && descriptor.availability.state === 'available'
      && !projection.conflicts.some(conflict => conflict.kind === 'identity_divergence'
        && conflict.descriptorIdentity === descriptorIdentity(descriptor)) ? [key] : [];
  }));
  const accountAuthoringIdentities = new Set<string>();
  for (const descriptor of accountDescriptors) {
    const key = projectedEntryKey(descriptor);
    if (!descriptor.authentication.account && !descriptor.authentication.modes.some(isAccountDirectConnectedAccountModeV1)) continue;
    descriptorsByQualifiedService.set(key, [descriptor]);
    accountAuthoringIdentities.add(descriptorIdentity(descriptor));
    answeredIdentities.add(descriptorIdentity(descriptor));
  }
  for (const [key, declaration] of Object.entries(BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS)) {
    // Account-runtime authentication is declared by the bundled owner just as
    // direct-save authentication is; neither needs a Machine census to be offered.
    const authentication = declaration.descriptor.authentication;
    if (descriptorsByQualifiedService.has(key)
      || (!authentication.account && !authentication.modes.some(isAccountDirectConnectedAccountModeV1))) continue;
    const service = parseQualifiedPluginContributionKey(key);
    if (!service) continue;
    const descriptor = projectConnectedAccountDescriptorV1({ descriptor: declaration.descriptor,
      serviceId: service.localId, pluginId: service.pluginId, provenance: 'first_party', sourceKind: 'bundled',
      availability: { state: 'available', reason: 'account_direct_declaration' }, diagnostics: [] });
    descriptorsByQualifiedService.set(key, [descriptor]);
    answeredIdentities.add(descriptorIdentity(descriptor));
  }

  const projected = Object.freeze([...descriptorsByQualifiedService.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, candidates]) => {
    const descriptor = candidates[0]!;
    const service = resolveProjectedService(descriptor);
    const legacyServiceId = resolveLegacyServiceId(service);
    const descriptorIdentityValue = descriptorIdentity(descriptor);
    const projectionConflicts = accountAuthoringIdentities.has(descriptorIdentityValue) ? [] : projection.conflicts.filter((conflict) => (
      conflict.kind === 'identity_divergence'
        && conflict.descriptorIdentity === descriptorIdentityValue
    ));
    const modes = descriptor.authentication.modes;
    const executableManualModes = modes.flatMap((mode) => {
      if (mode.kind !== 'manual') return [];
      const secretFields = mode.fields.filter((field) => field.secret);
      const identityFields = mode.fields.filter((field) => !field.secret);
      return secretFields.length === 1 && identityFields.length <= 1
        ? [{ mode, secretFields, identityFields }]
        : [];
    });
    const defaultManualMode = executableManualModes.find(
      ({ mode }) => mode.id === descriptor.authentication.defaultModeId,
    ) ?? executableManualModes[0];
    const entryReady = answeredIdentities.has(descriptorIdentityValue)
      && projectionConflicts.length === 0
      && candidates.length === 1;
    const projectionStatus = entryReady
      ? 'ready'
      : projectionConflicts.length > 0 || candidates.length > 1
        ? 'conflict'
        : projection.status === 'ready' || projection.status === 'conflict'
          ? 'stale'
          : projection.status;
    const executable = entryReady && nativeExecutableKeys.has(key) && descriptor.availability.state === 'available';
    const supportsToken = executable && executableManualModes.length > 0;
    const oauthModes = modes.filter((mode) => mode.kind !== 'manual');
    const supportsOauth = executable && oauthModes.length > 0;
    const oauthAddActionModes = supportsOauth
      ? [...new Set(oauthModes.flatMap((mode) => (
          mode.kind === 'oauthDeviceCode'
            ? ['device' as const]
            : ['browser' as const, 'paste' as const]
        )))]
      : [];
    const defaultModeSupportsToken = executableManualModes.some(
      ({ mode }) => mode.id === descriptor.authentication.defaultModeId,
    );
    return Object.freeze({
      serviceId: descriptor.serviceId,
      ...(service
        ? { service }
        : {}),
      ...(legacyServiceId ? { legacyServiceId } : {}),
      connectCommand: `happier connect ${legacyServiceId ?? descriptor.serviceId}${supportsToken && defaultModeSupportsToken ? ' --token' : ''}`,
      supportsOauth,
      oauthAddActionModes,
      defaultAuthenticationModeId: descriptor.authentication.defaultModeId,
      authenticationModes: modes,
      supportsToken,
      tokenKind: supportsToken ? 'api-token' as const : undefined,
      tokenPromptLabelKey: supportsToken && defaultManualMode?.secretFields[0]
        ? readProjectedFieldTitle(defaultManualMode.secretFields[0].title)
        : undefined,
      tokenIdentityPromptLabelKey: supportsToken && defaultManualMode?.identityFields[0]
        ? readProjectedFieldTitle(defaultManualMode.identityFields[0].title)
        : undefined,
      projectedDescriptor: descriptor,
      projectedDescriptorCandidates: candidates,
      projectedTitle: descriptor.title,
      projectedDescription: descriptor.description,
      provenance: descriptor.provenance,
      sourceKind: descriptor.sourceKind,
      availability: descriptor.availability,
      diagnostics: descriptor.diagnostics,
      projectionStatus,
      projectionConflicts,
      executable,
    });
  }));
  return projected;
}

/**
 * The AppShell owns descriptor lifetime. Retire only the snapshot installed by
 * that exact Account, so a late cleanup cannot clear a newer Account's view.
 */
export function retireConnectedAccountDescriptorProjection(
  accountLifetime: ActiveServerAccountScopeLifetime,
): void {
  if (connectedServiceRegistryAccountLifetime !== accountLifetime) return;
  connectedServiceRegistrySnapshot = createConnectedServiceRegistryLoadingSnapshot(
    connectedServiceRegistrySnapshot.scopeKey,
  );
  connectedServiceRegistryAccountLifetime = null;
  connectedServiceRegistryDescriptorProjection = null;
  connectedServiceRegistryAccountDescriptors = EMPTY_ACCOUNT_DESCRIPTORS;
  for (const listener of registryListeners) listener();
}

export function getConnectedServiceRegistrySnapshot(scope?: ServerAccountScope): ConnectedServiceRegistrySnapshot {
  // A direct module reader has no React revision subscription. Never expose a
  // descriptor from an Account whose canonical lifetime has already retired.
  if ((scope && (!connectedServiceRegistryAccountLifetime
      || !areServerAccountScopesEqual(scope, connectedServiceRegistryAccountLifetime.scope)))
    || (connectedServiceRegistryAccountLifetime && !connectedServiceRegistryAccountLifetime.isCurrent())) {
    return createConnectedServiceRegistryLoadingSnapshot(
      connectedServiceRegistrySnapshot.scopeKey,
    );
  }
  return connectedServiceRegistrySnapshot;
}

/** Read capability, not execution admission: sleeping services keep their usage identity. */
export function isConnectedServiceUsageCapable(
  service: PluginContributionIdentityV1,
  snapshot: Pick<ConnectedServiceRegistrySnapshot, 'entries'> = getConnectedServiceRegistrySnapshot(),
): boolean {
  const entry = snapshot.entries.find(candidate => candidate.service && sameService(candidate.service, service));
  if (entry?.projectedDescriptorCandidates && entry.projectedDescriptorCandidates.length > 1) return false;
  if (entry?.projectedDescriptor?.capabilities.includes('usage')) return true;
  const legacyId = resolveLegacyServiceId(service);
  return legacyId !== null && isBuiltInLegacyConnectedAccountPeerOperationSupported({
    serviceId: legacyId,
    peerClass: 'revisioned_v2_v3',
    operation: 'quota_read',
  });
}

/**
 * The provenance-named UI ingress for Connected Account service ids on live
 * binding paths. A canonical qualified key passes through unchanged; a
 * released bundled scalar id is translated through the exact generated
 * built-in mapping. Anything else is unknown and fails closed (`null`) —
 * never a new current bare-key producer.
 */
export function resolveQualifiedConnectedAccountServiceKey(serviceId: string): string | null {
  if (parseQualifiedPluginContributionKey(serviceId)) return serviceId;
  const legacy = readBundledLegacyConnectedAccountCompatibility(serviceId);
  return legacy
    ? buildQualifiedPluginContributionKey(legacy.compatibility.service)
    : null;
}

export function getQualifiedConnectedServiceRegistryEntry(
  service: Readonly<{ pluginId: string; localId: string }>,
): ConnectedServiceRegistryEntry | null {
  const key = buildQualifiedPluginContributionKey(service);
  return getConnectedServiceRegistrySnapshot().entries.find((entry) => (
    entry.service
      && buildQualifiedPluginContributionKey(entry.service) === key
  )) ?? null;
}

/** Usage context comes from the same plugin declaration as authentication. */
export function getConnectedServiceUsageIdentity(
  service: PluginContributionIdentityV1,
): ConnectedAccountUiProjectionEntryV1['usageIdentity'] | null {
  const entry = getQualifiedConnectedServiceRegistryEntry(service);
  const candidates = entry?.projectedDescriptorCandidates
    ?? (entry?.projectedDescriptor ? [entry.projectedDescriptor] : []);
  if (candidates.length > 0) return candidates.find(candidate => candidate.usageIdentity)?.usageIdentity ?? null;
  return BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[`${service.pluginId}/${service.localId}`]?.descriptor.usageIdentity ?? null;
}

/** Account authoring consumes current declaration facts, not native execution availability. */
export function getAccountConnectedServiceConfigurationMode(
  target: Readonly<{ service: PluginContributionIdentityV1; modeId: string }>,
  scope: ServerAccountScope,
): PluginConnectedAccountAuthenticationModeV2 | null {
  if (!connectedServiceRegistryAccountLifetime?.isCurrent()
    || !areServerAccountScopesEqual(connectedServiceRegistryAccountLifetime.scope, scope)) return null;
  const entry = getQualifiedConnectedServiceRegistryEntry(target.service);
  if (!entry) return null;
  const directMode = readAccountDirectConnectedServiceModes(entry).find(mode => mode.id === target.modeId);
  if (directMode) return directMode;
  if (entry.projectionStatus !== 'ready') return null;
  const mode = entry.authenticationModes?.find(candidate => candidate.id === target.modeId);
  return mode && 'configuration' in mode && mode.configuration?.scope === 'service' ? mode : null;
}

/**
 * The localized name of each released built-in service, for the one moment its
 * descriptor is not projected (no online machine publishes it). Each stored
 * account records its exact qualified service, and every released scalar id
 * maps to exactly one of them, so the name is known without the descriptor.
 * A projected descriptor title always wins over this.
 */
const LEGACY_CONNECTED_SERVICE_DISPLAY_NAME_KEYS: Readonly<Record<ConnectedServiceId, ConnectedServiceDisplayNameKey>> = {
  'openai-codex': 'connectedServices.serviceNames.openaiCodex',
  openai: 'connectedServices.serviceNames.openai',
  anthropic: 'connectedServices.serviceNames.anthropic',
  'claude-subscription': 'connectedServices.serviceNames.claudeSubscription',
  gemini: 'connectedServices.serviceNames.gemini',
  github: 'connectedServices.serviceNames.github',
  bitbucket: 'connectedServices.serviceNames.bitbucket',
};

function createLegacyConnectedServiceRegistryFallback(
  serviceId: string,
): ConnectedServiceRegistryEntry {
  const legacy = readBundledLegacyConnectedAccountCompatibility(serviceId);
  return {
    serviceId,
    ...(legacy
      ? {
          service: legacy.compatibility.service,
          legacyServiceId: legacy.serviceId,
          displayNameKey: LEGACY_CONNECTED_SERVICE_DISPLAY_NAME_KEYS[legacy.serviceId],
        }
      : {}),
    connectCommand: `happier connect ${serviceId}`,
    supportsOauth: false,
    oauthAddActionModes: [],
    supportsToken: false,
    executable: false,
  };
}

/**
 * Builds the exact generated V2/V3 compatibility entry when a released
 * qualified owner is not yet represented by the current projection. This
 * does not consult the live registry, so callers cannot accidentally borrow
 * a descriptor from a different projection snapshot.
 */
export function getGeneratedLegacyConnectedServiceRegistryFallback(
  service: Readonly<{ pluginId: string; localId: string }>,
): ConnectedServiceRegistryEntry | null {
  const legacyServiceId = resolveLegacyServiceId(service);
  return legacyServiceId
    ? createLegacyConnectedServiceRegistryFallback(legacyServiceId)
    : null;
}

/**
 * Saved Account/pool identities outlive their Machine's descriptor projection.
 * This entry permits read-only navigation; it declares no authentication modes,
 * installation, availability or native execution authority. Released scalar
 * presentation still belongs to the exact generated compatibility adapter.
 * Bundled titles come from the admitted declaration, just as they do when a
 * Machine answers; loading must not publish a different name first.
 */
export function getConnectedServiceRegistryIdentityFallback(
  service: PluginContributionIdentityV1,
): ConnectedServiceRegistryEntry {
  const fallback = getGeneratedLegacyConnectedServiceRegistryFallback(service) ?? {
    serviceId: service.localId,
    service,
    connectCommand: '',
    supportsOauth: false,
    supportsToken: false,
    executable: false,
  };
  const declaration = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[buildQualifiedPluginContributionKey(service)];
  return declaration ? { ...fallback, projectedTitle: declaration.descriptor.title } : fallback;
}

/**
 * Released V2/V3 compatibility ingress for scalar built-in callers. A scalar
 * id never selects a novel or foreign plugin descriptor with the same local id.
 */
export function getLegacyConnectedServiceRegistryEntry(serviceId: string): ConnectedServiceRegistryEntry {
  const legacy = readBundledLegacyConnectedAccountCompatibility(serviceId);
  const entry = legacy
    ? getQualifiedConnectedServiceRegistryEntry(legacy.compatibility.service)
    : null;
  if (entry) return entry;
  return createLegacyConnectedServiceRegistryFallback(serviceId);
}

export function getConnectedAccountAuthenticationMode(
  service: Readonly<{ pluginId: string; localId: string }>,
  authenticationModeId: string | null,
): PluginConnectedAccountAuthenticationModeV2 | null {
  if (!authenticationModeId) return null;
  return getConnectedAccountAuthentication(service)?.modes.find(
    (mode) => mode.id === authenticationModeId,
  ) ?? null;
}

/**
 * Authentication declarations for passive Account target eligibility do not
 * require a Machine supplier. Prefer its exact projected descriptor when
 * present; otherwise the admitted bundled declaration supplies the same facts.
 * Neither source admits execution, and conflicting suppliers remain unknown.
 */
export function getConnectedAccountAuthentication(
  service: Readonly<{ pluginId: string; localId: string }>,
  snapshot?: Pick<ConnectedServiceRegistrySnapshot, 'entries'>,
): PluginConnectedAccountAuthenticationV2 | null {
  const entry = snapshot ? snapshot.entries.find(candidate => candidate.service && sameService(candidate.service, service))
    : getQualifiedConnectedServiceRegistryEntry(service);
  if (entry?.projectionStatus === 'conflict' || (entry?.projectedDescriptorCandidates?.length ?? 0) > 1) return null;
  return entry?.projectedDescriptor?.authentication
    ?? BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[`${service.pluginId}/${service.localId}`]?.descriptor.authentication
    ?? null;
}

/** Retained quota reads consume the same plugin-owned labels as fresh observations. */
export function resolveConnectedServicePlanLabel(
  service: PluginContributionIdentityV1,
  planLabel: string | null | undefined,
): string | null {
  return resolveConnectedAccountPlanLabel(planLabel,
    BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[buildQualifiedPluginContributionKey(service)]?.descriptor.metadata);
}
