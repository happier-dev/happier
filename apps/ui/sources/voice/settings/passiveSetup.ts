import {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId,
  resolveConnectedServiceSessionSelection,
} from '@happier-dev/agents';
import {
  CodexPassiveRealtimeSetupResultV1Schema,
  ConnectedServiceBindingsV1Schema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
  type CodexPassiveRealtimeSetupResultV1,
  type CapabilityId,
  type ConnectedServiceBindingsV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';

import type { VoiceReadinessFact } from '@/voice/registry/readiness';
import type { ExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';

type CanonicalVoiceAgentRealtimeExecution = NonNullable<Extract<
  VoiceProviderContribution,
  Readonly<{ kind: 'conversation' }>
>['execution']>;
type VoiceAgentRealtimeExecution = Readonly<{
  kind: 'experimental_agent_session_realtime';
  agent: CanonicalVoiceAgentRealtimeExecution['agent'];
  supportedRuntimeVersions?: readonly string[];
}>;

export type VoiceProviderAgentRealtimePassiveSetup = Readonly<{
  capabilityId: CapabilityId;
  supportedRuntimeVersions?: readonly string[];
}>;

export type VoiceProviderPassiveSetupFacts = Readonly<{
  executionMachine?: VoiceReadinessFact;
  runtime?: VoiceReadinessFact;
  credential?: VoiceReadinessFact;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function projectVoiceProviderPassiveSetupFacts(
  input: Readonly<{
    execution: VoiceAgentRealtimeExecution | null;
    executionMachineId: string | null;
    executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
    executionMachineOnline: boolean;
    runtimeCapabilityResult: unknown;
    passiveRealtimeSetupResult?: unknown;
  }>,
): VoiceProviderPassiveSetupFacts {
  const passiveSetup = projectVoiceProviderAgentRealtimePassiveSetup(input.execution);
  if (!passiveSetup) return Object.freeze({});
  // The execution-machine owner distinguishes no saved target from a target
  // that remains persisted but is currently unreachable. Do not erase that
  // fact merely because no live daemon request can be made against it.
  if (input.executionMachineSelectionKind === 'selected_unreachable') {
    return Object.freeze({
      executionMachine: 'incompatible',
      runtime: 'unknown',
    });
  }
  const executionMachineReady = typeof input.executionMachineId === 'string'
    && input.executionMachineId.trim().length > 0
    && input.executionMachineOnline;
  if (!executionMachineReady) {
    return Object.freeze({
      executionMachine: 'missing',
      runtime: 'unknown',
    });
  }

  const passiveRealtimeSetup = readVoiceProviderPassiveRealtimeSetupResult(
    input.passiveRealtimeSetupResult,
  );
  if (passiveRealtimeSetup?.status === 'ready') {
    return Object.freeze({
      executionMachine: 'ready',
      runtime: 'ready',
      credential: 'ready',
    });
  }
  if (passiveRealtimeSetup?.status === 'runtime_incompatible') {
    return Object.freeze({
      executionMachine: 'ready',
      runtime: 'incompatible',
    });
  }
  if (passiveRealtimeSetup?.status === 'authentication_required') {
    return Object.freeze({
      executionMachine: 'ready',
      credential: 'missing',
    });
  }
  if (passiveRealtimeSetup?.status === 'feature_disabled') {
    return Object.freeze({
      executionMachine: 'ready',
      runtime: 'missing',
      credential: 'ready',
    });
  }

  const result = isRecord(input.runtimeCapabilityResult)
    ? input.runtimeCapabilityResult
    : null;
  const data = result?.ok === true && isRecord(result.data) ? result.data : null;
  let runtime: VoiceReadinessFact = 'unknown';
  if (data?.available === false) {
    runtime = 'missing';
  } else if (
    data?.available === true
    && typeof data.version === 'string'
    && (
      (typeof data.resolvedPath === 'string' && data.resolvedPath.trim().length > 0)
      || (typeof data.resolvedCommand === 'string' && data.resolvedCommand.trim().length > 0)
    )
  ) {
    runtime = passiveSetup.supportedRuntimeVersions === undefined
      ? 'unknown'
      : passiveSetup.supportedRuntimeVersions.includes(data.version)
        // Exact version compatibility is only a trusted-provider passive
        // bound. The app-server Start path remains authoritative.
        ? 'unknown'
        : 'incompatible';
  }

  return Object.freeze({
    executionMachine: 'ready',
    runtime,
  });
}

/**
 * Settings receives only this strict, data-only capability result; it never
 * interprets raw Codex app-server responses.
 */
export function readVoiceProviderPassiveRealtimeSetupResult(
  value: unknown,
): CodexPassiveRealtimeSetupResultV1 | null {
  const parsed = CodexPassiveRealtimeSetupResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function projectVoiceProviderAgentRealtimePassiveSetup(
  execution: VoiceAgentRealtimeExecution | null | undefined,
): VoiceProviderAgentRealtimePassiveSetup | null {
  if (execution?.kind !== 'experimental_agent_session_realtime') return null;
  const agentId = typeof execution.agent === 'string'
    ? execution.agent
    : execution.agent.localId;
  return Object.freeze({
    capabilityId: `cli.${agentId}` as CapabilityId,
    ...(execution.supportedRuntimeVersions === undefined
      ? {}
      : { supportedRuntimeVersions: Object.freeze([...execution.supportedRuntimeVersions]) }),
  });
}

export function readVoiceProviderConnectedServicesBinding(
  input: Readonly<{
    providerSettings: Pick<ExternalVoiceProviderSettingsDescriptor, 'connectedServicesBinding'> | null;
    providerConfig: unknown;
  }>,
): ConnectedServiceBindingsV1 | null {
  const bindingDeclaration = input.providerSettings?.connectedServicesBinding;
  if (!bindingDeclaration || !isRecord(input.providerConfig)) return null;
  const parsedBindings = ConnectedServiceBindingsV1Schema.safeParse(
    input.providerConfig[bindingDeclaration.id],
  );
  if (!parsedBindings.success) return null;
  if (bindingDeclaration.serviceIds.some((serviceId) => {
    const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
    return !serviceKey || parsedBindings.data.bindingsByServiceId[serviceKey] === undefined;
  })) return null;
  return parsedBindings.data;
}

export function projectVoiceProviderConnectedServicesCredentialFact(
  input: Readonly<{
    providerSettings: Pick<ExternalVoiceProviderSettingsDescriptor, 'connectedServicesBinding'> | null;
    providerConfig: unknown;
    accountProfileConnectedServicesV2: Parameters<
      typeof buildConnectedServiceProfileOptionsByServiceId
    >[0]['accountProfileConnectedServicesV2'];
    labelsByKey: Readonly<Record<string, string | undefined>>;
    accountGroupsEnabled: boolean;
  }>,
): VoiceReadinessFact | undefined {
  const bindingDeclaration = input.providerSettings?.connectedServicesBinding;
  if (!bindingDeclaration) return undefined;
  const bindings = readVoiceProviderConnectedServicesBinding(input);
  if (!bindings) return 'missing';

  const profileOptionsByServiceId = buildConnectedServiceProfileOptionsByServiceId({
    accountProfileConnectedServicesV2: input.accountProfileConnectedServicesV2,
    supportedConnectedServiceIds: bindingDeclaration.serviceIds,
    labelsByKey: { ...input.labelsByKey },
  });
  const groupOptionsByServiceId = buildConnectedServiceAccountGroupOptionsByServiceId({
    accountGroupsFeatureEnabled: input.accountGroupsEnabled,
    accountProfileConnectedServicesV2: input.accountProfileConnectedServicesV2,
    supportedConnectedServiceIds: bindingDeclaration.serviceIds,
  });

  for (const serviceId of bindingDeclaration.serviceIds) {
    const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
    if (!serviceKey) return 'missing';
    const resolution = resolveConnectedServiceSessionSelection({
      serviceId,
      binding: bindings.bindingsByServiceId[serviceKey],
      availability: {
        kind: 'known',
        profileOptions: profileOptionsByServiceId[serviceId] ?? [],
        groupOptions: groupOptionsByServiceId[serviceId] ?? [],
        accountGroupsEnabled: input.accountGroupsEnabled,
      },
    });
    if (resolution.status !== 'valid_selection') return 'missing';
  }
  return 'ready';
}
