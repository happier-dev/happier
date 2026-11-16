import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { readMachineIsolationPolicyV1, type MachineIsolationPolicyV1, type MachineIsolationV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { isHomeAdmittedPresentUserHostInvocation, isPresentUserHostInvocation, readInitiatingActionCallerV1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
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
  'executionTarget' | 'agentTarget' | 'primaryTeamId' | 'initialAccess' | 'permissionMode' | 'modelSelection' | 'configuration' | 'teamCredentialBindings' | 'identity' | 'attestedContext' | 'isolationOverride' | 'sourceContext'>
  & Readonly<{ connectedServices?: SessionSpawnNewInputV2['connectedServices'] | null }>;

export type SessionSpawnIsolationDecision = Readonly<{
  policy: MachineIsolationPolicyV1;
  workKind: keyof MachineIsolationPolicyV1['workKinds'];
  choice: MachineIsolationPolicyV1['workKinds']['sessions'];
  configuredSandbox?: MachineIsolationPolicyV1['configuredSandboxes'][string];
}>;

function isolationUnavailable(reason: string): never {
  throw createActionExecuteFailureError({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
    details: { reason }, effectAttempted: false });
}

function resolveSessionSpawnIsolation(input: SpawnDefaultSelections, openedMetadata: unknown,
  context: ActionExecutorContext | undefined): SessionSpawnIsolationDecision | null {
  let policy: MachineIsolationPolicyV1 | null;
  try { policy = readMachineIsolationPolicyV1(openedMetadata ?? {}); }
  catch { return isolationUnavailable('machine_isolation_policy_unreadable'); }
  if (!policy || input.sourceContext || input.configuration?.providerSessionResume) return null;
  const binding = context?.externalActionExecutionAuthorization?.binding;
  const caller = readInitiatingActionCallerV1(context?.actionCaller);
  const run = caller?.kind === 'workflowRun' || caller?.kind === 'automationRun' || Boolean(binding?.workflowActionOrigin);
  const bot = binding?.actionId === BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
    || (context?.actionCaller?.kind === 'plugin' && input.attestedContext !== undefined);
  if (!run && !bot && (input.identity?.bot || input.identity?.createdAsBot)) {
    return isolationUnavailable('machine_isolation_bot_origin_unavailable');
  }
  const workKind = run ? 'automationsWorkflows' : bot ? 'botsChannels' : 'sessions';
  if (input.isolationOverride) {
    const manage = context?.machineAdmission?.role === 'manage' || binding?.admittedMachineRole === 'manage';
    const interactive = context !== undefined
      && (isPresentUserHostInvocation(context) || isHomeAdmittedPresentUserHostInvocation(context, SESSION_SPAWN_NEW_ACTION_ID_V1))
      && context.interactivePresentation !== 'unavailable'
      && context.presentUserApproval?.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1
      && Boolean(context.presentUserApproval.inputDigest);
    if (!manage || !interactive || run || bot) throw createActionExecuteFailureError({ ok: false,
      errorCode: 'permission_denied', error: 'permission_denied',
      details: { reason: 'machine_isolation_override_requires_interactive_manage' }, effectAttempted: false });
    return { policy, workKind, choice: { kind: 'directly' } };
  }
  const choice = policy.workKinds[workKind];
  if (choice.kind === 'directly') return { policy, workKind, choice };
  const configuredSandbox = policy.configuredSandboxes[choice.configuredSandboxId];
  if (!configuredSandbox) return isolationUnavailable('machine_isolation_sandbox_unavailable');
  return { policy, workKind, choice, configuredSandbox };
}

function readGovernanceResult(raw: unknown): unknown {
  const failure = ActionExecuteFailureSchema.safeParse(raw);
  if (failure.success) throw createActionExecuteFailureError(failure.data);
  return raw;
}

/** Fill unset launch facets once, using the acting Account's admitted plaintext settings. */
export async function resolveSessionSpawnManagedDefaults(input: SpawnDefaultSelections, params: Readonly<{
  agentId: string;
  openedMachineMetadata?: unknown;
  startContext?: ActionExecutorContext;
  machineIsolation?: MachineIsolationV1 | null;
  machineIsolationPolicy?: Readonly<Pick<MachineIsolationPolicyV1, 'agentNativeSandboxEnabled'>> | null;
  sandboxTypeSupportsNativeSandbox?: boolean;
  nativeSandboxAvailable?: boolean;
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
    if (input.connectedServices === null) return [{ ...entry, target: null, teamResource: null }];
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
    machineIsolation: params.machineIsolation,
    machineIsolationPolicy: params.machineIsolationPolicy,
    sandboxTypeSupportsNativeSandbox: params.sandboxTypeSupportsNativeSandbox,
    nativeSandboxAvailable: params.nativeSandboxAvailable,
    explicitAgentSandbox: input.configuration?.nativeSandbox,
    retainedNativeProfile: input.configuration?.providerSessionResume !== undefined,
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
    resolveIsolation: () => resolveSessionSpawnIsolation(input, params.openedMachineMetadata, params.startContext),
    placement: resolved.placement,
    nativeSandbox: resolved.agentSandbox.value,
    agentSandbox: resolved.agentSandbox,
    permissionMode: resolved.permissionMode.value,
    modelSelection: selectedModel ? selectedModel.v === 1 ? selectedModel : projectSessionModelSelectionV2ToV1(selectedModel) ?? undefined : input.modelSelection,
    connectedServices: { v: 2 as const, bindingsByServiceId },
    ...(teamCredentialBindings ? { teamCredentialBindings } : {}),
    ...(payload ? { connectedServicesUpdatedAt: payload.connectedServicesUpdatedAt } : {}),
  };
}
