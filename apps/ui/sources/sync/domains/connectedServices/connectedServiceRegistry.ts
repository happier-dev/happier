import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  buildQualifiedPluginContributionKey,
  ConnectedServiceIdSchema,
  parseQualifiedPluginContributionKey,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginConnectedAccountAuthenticationV2,
  type ConnectedServiceId,
  type ConnectedAccountUiProjectionEntryV1,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import type {
  ConnectedAccountDescriptorProjectionConflict,
  ConnectedAccountDescriptorProjectionState,
} from './connectedAccountDescriptorProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

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
  projectionStatus?: ConnectedAccountDescriptorProjectionState['status'];
  projectionConflicts?: readonly ConnectedAccountDescriptorProjectionConflict[];
  executable?: boolean;
}>;

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

function readBundledLegacyConnectedAccountCompatibility(
  serviceId: string,
) {
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceId);
  if (!parsedServiceId.success) return null;
  return {
    serviceId: parsedServiceId.data,
    compatibility:
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        parsedServiceId.data
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
): void {
  if (accountLifetime && !accountLifetime.isCurrent()) return;
  const descriptorsByQualifiedService = new Map<string, ConnectedAccountUiProjectionEntryV1[]>();
  for (const descriptor of projection.descriptors) {
    const key = projectedEntryKey(descriptor);
    const descriptors = descriptorsByQualifiedService.get(key) ?? [];
    descriptors.push(descriptor);
    descriptorsByQualifiedService.set(key, descriptors);
  }

  const projected = Object.freeze([...descriptorsByQualifiedService.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, candidates]) => {
    const descriptor = candidates[0]!;
    const service = resolveProjectedService(descriptor);
    const legacyServiceId = resolveLegacyServiceId(service);
    const descriptorIdentityValue = descriptorIdentity(descriptor);
    const projectionConflicts = projection.conflicts.filter((conflict) => (
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
    const projectionStatus = projection.status === 'conflict' && projectionConflicts.length === 0
      ? 'ready'
      : projection.status;
    const executable = projectionStatus === 'ready'
      && projectionConflicts.length === 0
      && candidates.length === 1
      && descriptor.availability.state === 'available';
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
  connectedServiceRegistrySnapshot = {
    scopeKey: projection.scopeKey,
    status: projection.status,
    entries: projected,
    errorReason: projection.errorReason,
  };
  connectedServiceRegistryAccountLifetime = accountLifetime;
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
}

export function getConnectedServiceRegistrySnapshot(): ConnectedServiceRegistrySnapshot {
  // A direct module reader has no React revision subscription. Never expose a
  // descriptor from an Account whose canonical lifetime has already retired.
  if (connectedServiceRegistryAccountLifetime && !connectedServiceRegistryAccountLifetime.isCurrent()) {
    return createConnectedServiceRegistryLoadingSnapshot(
      connectedServiceRegistrySnapshot.scopeKey,
    );
  }
  return connectedServiceRegistrySnapshot;
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
 * Returns the exact daemon-projected authentication descriptor for a qualified
 * service. A conflicted or incomplete projection must remain unknown rather
 * than borrowing a mode from a similarly named descriptor.
 */
export function getConnectedAccountAuthentication(
  service: Readonly<{ pluginId: string; localId: string }>,
): PluginConnectedAccountAuthenticationV2 | null {
  const entry = getQualifiedConnectedServiceRegistryEntry(service);
  if (!entry || (entry.projectedDescriptorCandidates?.length ?? 0) > 1) return null;
  return entry.projectedDescriptor?.authentication ?? null;
}
