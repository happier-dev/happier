import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveAgentSpawnPurposeDeclarations } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';
import type { OrganizationPolicyLoadResult } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { getOrganizationPolicySessionDefaults } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { readAccountSettingValueForBackendTarget } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings } from '@happier-dev/protocol/account/settings/connected-services';
import { readAgentDefaultModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import { projectSessionModelSelectionV2ToV1, sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveManagedSessionDefaults, type ManagedConnectedServiceDefaultV1, type ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams/managedDefaults';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ConnectedServiceBindingsV2, SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol';
import { materializeSessionSpawnConnectedServicesDefaults, mergeSessionTeamCredentialBindingIntents, readAgentPurposeDefaults, type ResolveSpawnConnectedServicesTeamResourceCatalog } from '@/session/services/spawnConnectedServicesDefaults';

type SpawnDefaultSelections = Pick<SessionSpawnNewInputV2,
  'executionTarget' | 'agentTarget' | 'primaryTeamId' | 'initialAccess' | 'permissionMode' | 'modelSelection' | 'configuration' | 'connectedServices' | 'teamCredentialBindings'>;

function readGovernanceResult(raw: unknown): unknown {
  const failure = ActionExecuteFailureSchema.safeParse(raw);
  if (failure.success) throw createActionExecuteFailureError(failure.data);
  return raw;
}

/** Fill unset launch facets once, using the acting Account's admitted plaintext settings. */
export async function resolveSessionSpawnManagedDefaults(input: SpawnDefaultSelections, params: Readonly<{
  agentId: string;
  accountSettings: unknown;
  purposeCatalog?: ConnectedAccountCatalogSnapshotV1;
  organizationPolicy: OrganizationPolicyLoadResult;
  readTeam: (teamId: string) => Promise<unknown>;
  readHome: () => Promise<unknown>;
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
  signal?: AbortSignal;
}>) {
  const targetKey = buildBackendTargetKeyV2(input.agentTarget);
  const settings = params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
    ? params.accountSettings as Readonly<Record<string, unknown>> : {};
  const memberPermission = parseAgentPermissionIntentV1Alias(String(readAccountSettingValueForBackendTarget(
    settings, 'sessionDefaultPermissionModeByTargetKey', input.agentTarget) ?? ''));
  const memberModel = readAgentDefaultModelSelectionV1(settings.providerDefaultModelSelectionsByAgentTargetKeyV1, input.agentTarget);
  const purposes = { agentId: params.agentId, accountSettings: settings, purposeCatalog: params.purposeCatalog };
  const declarations = readAgentPurposeDefaults(purposes);
  const memberPurposes = readAgentPurposeDefaults({ ...purposes, onlySavedDefaults: true });
  const explicitPurposes = declarations.flatMap((entry): ManagedConnectedServiceDefaultV1[] => {
    const binding = input.connectedServices?.bindingsByServiceId[buildQualifiedPluginContributionKey(entry.service)];
    const slot = input.teamCredentialBindings?.find(intent => intent.slot.kind === 'connected_service_purpose'
      && qualifiedPurposeKey(intent.slot.purpose) === qualifiedPurposeKey(entry.purpose));
    if (!binding && !slot) return [];
    const target = binding?.source === 'connected'
      ? binding.selection === 'group'
        ? { kind: 'group' as const, service: entry.service, groupId: binding.groupId }
        : { kind: 'account' as const, account: { service: entry.service, accountId: binding.profileId } }
      : null;
    // Session Team bindings omit teamId; retain the authored selection below
    // only when the canonical decision actually selected explicit intent.
    return [{ purpose: entry.purpose, service: entry.service, target, teamResource: null }];
  });
  if (explicitPurposes.length > 0) {
    // An explicit authentication source leaves unchosen optional sources native,
    // rather than adding saved alternatives. Required additive purposes still default.
    // Submit that intent to the shared precedence owner so policy locks still apply.
    const requiredPurposes = new Set(resolveAgentSpawnPurposeDeclarations({
      agentId: params.agentId, contributions: readCurrentContributionRegistry(),
    })?.declarations.filter(entry => entry.required).map(entry => entry.purpose));
    const explicitKeys = new Set(explicitPurposes.map(entry => qualifiedPurposeKey(entry.purpose)));
    for (const entry of declarations) {
      if (explicitKeys.has(qualifiedPurposeKey(entry.purpose)) || requiredPurposes.has(entry.purpose.purpose)) continue;
      explicitPurposes.push({ ...entry, target: null, teamResource: null });
    }
  }
  const sharedTeamIds = new Set(input.initialAccess?.grants.flatMap(({ subject }) => subject.kind === 'account' ? [] : [subject.teamId]));
  const defaultsTeamId = input.primaryTeamId ?? (sharedTeamIds.size === 1 ? sharedTeamIds.values().next().value : undefined);
  const team = defaultsTeamId
    ? TeamSummaryV1Schema.parse(readGovernanceResult(await params.readTeam(defaultsTeamId))) : null;
  const homeDefaults = team ? team.policy.homeDefaults ?? null
    : HomeSessionDefaultsProjectionV1Schema.parse(readGovernanceResult(await params.readHome())).homeDefaults;
  const policy = getOrganizationPolicySessionDefaults(params.organizationPolicy);
  const memberDefaults: ManagedSessionDefaultsV1 = {
    ...(memberPermission ? { permissionModeByAgentTargetKey: { [targetKey]: memberPermission } } : {}),
    ...(memberModel ? { modelByAgentTargetKey: { [targetKey]: memberModel } } : {}),
    connectedServicesByAgentTargetKey: { [targetKey]: memberPurposes },
  };
  const explicitPermission = input.permissionMode ?? input.configuration?.permissionIntent.value ?? undefined;
  const explicitModelBinding = input.teamCredentialBindings?.find(intent => intent.slot.kind === 'provider_model');
  const explicitAutomatic = input.configuration?.model.value === null && input.configuration.model.selectionSource !== 'inherited';
  const explicitModel = input.modelSelection ?? (input.configuration?.model.value ? { v: 1 as const,
    updatedAt: input.configuration.model.updatedAtMs, ref: { agentTargetKey: targetKey, providerConnectionId: null,
      modelId: input.configuration.model.value } } : explicitAutomatic || explicitModelBinding ? null : undefined);
  const resolved = resolveManagedSessionDefaults({
    agentTargetKey: targetKey, memberDefaults, teamDefaults: team?.policy.managedDefaults ?? null,
    groupIds: team?.managedDefaultsGroupIds ?? [], homeDefaults, policyDefaults: policy,
    explicitChoices: {
      placement: { kind: 'machine', target: input.executionTarget },
      ...(explicitPermission ? { permissionModeByAgentTargetKey: { [targetKey]: explicitPermission } } : {}),
      ...(explicitModel !== undefined ? { modelByAgentTargetKey: { [targetKey]: explicitModel } } : {}),
      connectedServicesByAgentTargetKey: { [targetKey]: explicitPurposes },
    },
  });
  const decisions = new Map(resolved.connectedServices.flatMap(decision => decision.value
    ? [[qualifiedPurposeKey(decision.value.purpose), decision] as const] : []));
  // Managed purposes cannot introduce an undeclared consumer or service.
  const selectedPurposes = declarations.flatMap(entry => {
    const decision = decisions.get(qualifiedPurposeKey(entry.purpose));
    return decision?.value ? [decision.value] : [];
  });
  const payload = selectedPurposes.length > 0 ? await materializeSessionSpawnConnectedServicesDefaults({
    agentId: params.agentId, purposeDefaults: selectedPurposes,
    ...(params.resolveTeamCredentialResourceCatalog ? { resolveTeamCredentialResourceCatalog: params.resolveTeamCredentialResourceCatalog } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  }) : null;
  const bindingsByServiceId: ConnectedServiceBindingsV2['bindingsByServiceId'] = {
    ...input.connectedServices?.bindingsByServiceId,
    ...(payload?.connectedServices ?? projectAgentConnectedAccountPurposeDefaultsToSessionBindings(selectedPurposes))?.bindingsByServiceId,
  };
  for (const entry of declarations) {
    const serviceId = buildQualifiedPluginContributionKey(entry.service);
    const decision = decisions.get(qualifiedPurposeKey(entry.purpose));
    const explicit = input.connectedServices?.bindingsByServiceId[serviceId];
    if (decision?.source !== 'explicit') continue;
    if (explicit) bindingsByServiceId[serviceId] = explicit;
    else delete bindingsByServiceId[serviceId];
  }
  const selectedModel = resolved.model.value;
  const modelBinding = selectedModel?.v === 2 && selectedModel.ref.source === 'team_resource'
    ? sessionModelSelectionV2TeamBindingIntent(selectedModel) : undefined;
  const explicitTeamBindings = input.teamCredentialBindings?.filter(intent => intent.slot.kind === 'provider_model'
    ? !resolved.model.lock
    : !decisions.get(qualifiedPurposeKey(intent.slot.purpose))?.lock);
  const admittedTeamBindings: SessionTeamCredentialBindingIntentListV1 = [
    ...(payload?.teamCredentialBindings ?? []), ...(modelBinding ? [modelBinding] : []),
  ];
  const teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({ explicit: explicitTeamBindings, admitted: admittedTeamBindings });
  return {
    placement: resolved.placement,
    permissionMode: resolved.permissionMode.value,
    modelSelection: selectedModel ? selectedModel.v === 1 ? selectedModel : projectSessionModelSelectionV2ToV1(selectedModel) ?? undefined : input.modelSelection,
    connectedServices: { v: 2 as const, bindingsByServiceId },
    ...(teamCredentialBindings ? { teamCredentialBindings } : {}),
    ...(payload ? { connectedServicesUpdatedAt: payload.connectedServicesUpdatedAt } : {}),
  };
}
