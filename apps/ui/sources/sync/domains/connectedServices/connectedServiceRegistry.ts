import {
  type ConnectedAccountUiProjectionEntryV1,
} from '@happier-dev/protocol';
import type {
  ConnectedAccountDescriptorProjectionConflict,
  ConnectedAccountDescriptorProjectionState,
} from './connectedAccountDescriptorProjection';

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
  service?: Readonly<{ pluginId: string; localId: string }>;
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

function readProjectedFieldTitle(
  value: ConnectedAccountUiProjectionEntryV1['title'],
): string {
  return typeof value === 'string' ? value : value.fallback;
}

export function installConnectedAccountDescriptorProjection(
  projection: ConnectedAccountDescriptorProjectionState,
): void {
  const descriptorsByService = new Map<ConnectedAccountUiProjectionEntryV1['serviceId'], ConnectedAccountUiProjectionEntryV1[]>();
  for (const descriptor of projection.descriptors) {
    const descriptors = descriptorsByService.get(descriptor.serviceId) ?? [];
    descriptors.push(descriptor);
    descriptorsByService.set(descriptor.serviceId, descriptors);
  }

  const projected = Object.freeze([...descriptorsByService.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([serviceId, candidates]) => {
    const descriptor = candidates[0]!;
    const descriptorIdentity = `${descriptor.pluginId ?? 'first_party'}\u0000${descriptor.id}`;
    const projectionConflicts = projection.conflicts.filter((conflict) => (
      conflict.kind === 'service_ownership'
        ? conflict.serviceId === serviceId
        : conflict.descriptorIdentity === descriptorIdentity || conflict.serviceIds.includes(serviceId)
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
      serviceId,
      ...(descriptor.pluginId
        ? { service: { pluginId: descriptor.pluginId, localId: descriptor.id } }
        : {}),
      connectCommand: `happier connect ${descriptor.serviceId}${supportsToken && defaultModeSupportsToken ? ' --token' : ''}`,
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
}

export function getConnectedServiceRegistrySnapshot(): ConnectedServiceRegistrySnapshot {
  return connectedServiceRegistrySnapshot;
}

export function getConnectedServiceRegistryEntry(serviceId: string): ConnectedServiceRegistryEntry {
  const entry = connectedServiceRegistrySnapshot.entries.find((s) => s.serviceId === serviceId);
  if (entry) return entry;
  return {
    serviceId,
    connectCommand: `happier connect ${serviceId}`,
    supportsOauth: false,
    oauthAddActionModes: [],
    supportsToken: false,
    executable: false,
  };
}
