import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { loadManagedSessionDefaultsContextV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { getOrganizationPolicySessionDefaults } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildManagedSessionDefaultsContext, resolveManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveSessionModelSelectionInputRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { SessionSpawnNewActionInputV2Schema, admitSessionSpawnNewActionInputV2, type SessionSpawnNewActionAuthoringInputV2,
  projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { resolveConnectedServicesLaunchAuthWithInventory } from '@happier-dev/protocol/connect/resolveConnectedServicesLaunchAuthV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readSettings } from '@/persistence';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { readRequesterAccountActionContext, resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { CliActionDepsParams } from '@/session/actions/cliActionDeps/types';
import { canReadPrivateSessionDefaults, createCliManagedSessionDefaultsContextLoader, sessionCreationAccountSettingsContext, type CliSessionCreationDefaults } from './cliManagedSessionDefaultsContext';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readSessionSpawnMemberDefaults } from './readSessionSpawnMemberDefaults';
import { readSessionSpawnModelChoice } from './readSessionSpawnModelChoice';
import { resolveSessionCreationAgentTarget } from './resolveSessionCreationAgentTarget';
import { prepareOriginalAccountManagedPresetAcquire } from '@/api/managedPresetOrigination';
import type { ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

function unavailable(reason: string): never {
  throw createActionExecuteFailureError({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
    details: { reason }, effectAttempted: false });
}

/** Settle authored launch auth with the inventory transport of the original requester. */
export async function resolveSessionSpawnConnectedServices(
  input: Pick<SessionSpawnNewActionAuthoringInputV2, 'connectedServicesAuthIntent'>,
  agentId: string,
  listInventory: NonNullable<ActionExecutorDeps['spawnConnectedServicesList']>,
) {
  const intent = input.connectedServicesAuthIntent;
  if (!intent) return null;
  return resolveConnectedServicesLaunchAuthWithInventory({
    intent,
    supportedServiceIds: resolveCatalogAgentConnectedAccountServiceIds(agentId),
    listInventory: () => listInventory({ agentId, includeUnavailable: false, includeDefaults: false }),
  });
}

/** Authoring omissions settle here before any Machine or Agent is admitted. */
export function createPrepareSessionSpawnInput(params: CliActionDepsParams, home: Readonly<{
  serverId: string; serverHttpBaseUrl: string;
}>, inventory: Readonly<{
  spawnConnectedServicesList: NonNullable<ActionExecutorDeps['spawnConnectedServicesList']>;
}>): NonNullable<ActionExecutorDeps['prepareSessionSpawnNewInput']> {
  return async (rawInput, context) => {
    const input = SessionSpawnNewActionInputV2Schema.parse(rawInput);
    if (context.sessionCreationDefaults) {
      return { input: projectSessionSpawnNewActionInputV2(admitSessionSpawnNewActionInputV2(input)),
        defaults: context.sessionCreationDefaults };
    }
    if (!params.credentials) return unavailable('requester_account_unavailable');
    const custody = !context.externalActionExecutionAuthorization && !context.externalActionCredential
      || readRequesterAccountActionContext(context.externalActionExecutionAuthorization)
      ? resolveRequesterSavedSecretActionCustody({ credentials: params.credentials,
        authorization: context.externalActionExecutionAuthorization, operationContext: params.savedSecretOperationContext })
      : { credentials: params.credentials, operation: undefined };
    const requesterServerHttpBaseUrl = custody.operation?.serverHttpBaseUrl ?? home.serverHttpBaseUrl;
    const loader = createCliManagedSessionDefaultsContextLoader({ credentials: custody.credentials,
      serverId: home.serverId, serverHttpBaseUrl: requesterServerHttpBaseUrl, context,
      serverIdentityId: params.serverIdentityId, externalActionMachineInstallationId: params.externalActionMachineInstallationId,
      externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey,
      ...(context.signal ? { signal: context.signal } : {}) });
    const retained = input.sourceContext !== undefined || input.configuration?.providerSessionResume !== undefined;
    const captured = retained ? { context: buildManagedSessionDefaultsContext({}), unavailableDefaults: undefined }
      : await loadManagedSessionDefaultsContextV1({ ...input.projectContext,
      primaryTeamId: input.primaryTeamId,
      sharedTeamIds: [...new Set(input.initialAccess?.grants.flatMap(({ subject }) =>
        subject.kind === 'account' ? [] : [subject.teamId]))],
      policyDefaults: getOrganizationPolicySessionDefaults(configuration.organizationPolicy),
    }, loader);
    const catalog = readAgentCatalogSnapshot();
    const defaultAgent = catalog.agentDefinitionsById.get(DEFAULT_AGENT_ID);
    const nativeAgent = defaultAgent?.identity ? listAgentExecutionTargetsV1(defaultAgent.identity)[0] : undefined;
    const agentFallback = input.agentTarget ?? nativeAgent;
    if (!agentFallback) return unavailable('agent_contribution_unavailable');
    const authoredPlacement = input.sessionPlacement && input.sessionPlacement.kind !== 'managed'
      ? input.sessionPlacement : input.executionTarget
        ? { kind: 'machine' as const, target: input.executionTarget } : undefined;
    const selected = resolveManagedSessionDefaults({ ...captured.context,
      agentTargetKey: buildBackendTargetKeyV2(agentFallback),
      explicitChoices: {
        ...(input.agentTarget ? { defaultAgentTarget: input.agentTarget } : {}),
        ...(authoredPlacement ? { placement: authoredPlacement } : {}),
      },
    });
    const agentTarget = selected.agentTarget.value ?? agentFallback;
    const resolvedAgent = resolveSessionCreationAgentTarget(agentTarget, catalog);
    if (!resolvedAgent) return unavailable('agent_contribution_unavailable');
    const memberSnapshot = retained || !canReadPrivateSessionDefaults(custody.credentials, context) ? null
      : custody.operation ? custody.operation.readSnapshot()
      : await runWithServerHttpBaseUrl(requesterServerHttpBaseUrl, () => bootstrapAccountSettingsContext({
        credentials: custody.credentials, mode: 'blocking', publication: 'invocation',
        deps: { applySideEffects: () => undefined }, ...(context.signal ? { signal: context.signal } : {}),
      }));
    if (!retained && custody.operation && !memberSnapshot) {
      throw createActionExecuteFailureError({ ok: false, errorCode: 'permission_denied', error: 'permission_denied', effectAttempted: false });
    }
    const completeContext = buildManagedSessionDefaultsContext({ context: captured.context,
      ...(memberSnapshot ? { memberDefaults: readSessionSpawnMemberDefaults(agentTarget, {
        agentId: resolvedAgent.agentId, accountSettings: memberSnapshot.settings,
        purposeCatalog: memberSnapshot.connectedPurposeCatalog,
      }) } : {}),
    });
    const selectedModel = resolveManagedSessionDefaults({ ...completeContext,
      agentTargetKey: buildBackendTargetKeyV2(agentTarget),
    }).model.value;
    const { modelSelectionInput, connectedServicesAuthIntent, ...authoredInput } = input;
    const modelSelectionRef = modelSelectionInput ? resolveSessionModelSelectionInputRefV1({
      agentTargetKey: buildBackendTargetKeyV2(agentTarget),
      providerConnectionId: modelSelectionInput.providerConnectionId ?? null,
      modelId: modelSelectionInput.modelId,
    }) : undefined;
    const sessionConfiguration = modelSelectionInput && modelSelectionRef === null ? {
      ...input.configuration,
      mode: input.configuration?.mode ?? { value: null, updatedAtMs: modelSelectionInput.updatedAt },
      permissionIntent: input.configuration?.permissionIntent ?? { value: null, updatedAtMs: modelSelectionInput.updatedAt },
      options: input.configuration?.options ?? {},
      model: { value: null, updatedAtMs: modelSelectionInput.updatedAt, selectionSource: 'explicit' as const },
    } : input.configuration;
    const connectedServices = connectedServicesAuthIntent
      ? await resolveSessionSpawnConnectedServices({ connectedServicesAuthIntent }, resolvedAgent.agentId,
        args => inventory.spawnConnectedServicesList(args, context))
      : null;
    let executionTarget = input.executionTarget;
    let managedPresetAcquisition: ManagedAcquireInputV1 | undefined;
    let managedPresetControllerAccess: ManagedControllerAccessV1 | undefined;
    if (selected.placement.value?.kind === 'machine') executionTarget = selected.placement.value.target;
    else if (selected.placement.value?.kind === 'preset') {
      const placement = selected.placement.value;
      // Preset acquisition still requires the original requester's private custody.
      // Public defaults reads alone never lend the custodian's bearer to this write.
      const presetCustody = resolveRequesterSavedSecretActionCustody({ credentials: params.credentials,
        authorization: context.externalActionExecutionAuthorization, operationContext: params.savedSecretOperationContext });
      const bound = await prepareOriginalAccountManagedPresetAcquire({ input: { selection: {
        kind: 'preset', homeId: placement.homeId, id: placement.presetId } },
        requestId: context.actionRequestId ?? input.creationKey ?? '', credentials: presetCustody.credentials,
        serverHttpBaseUrl: requesterServerHttpBaseUrl, ...(context.signal ? { signal: context.signal } : {}) });
      if (!bound || bound.kind === 'refused') return unavailable(bound?.code ?? 'controller_unavailable');
      if (!bound.input.controller) return unavailable('controller_unavailable');
      managedPresetAcquisition = bound.input;
      managedPresetControllerAccess = bound.controllerAccess;
      executionTarget = { serverId: placement.homeId, machineId: bound.input.controller.machineId };
    }
    if (!executionTarget) {
      const settings = await readSettings();
      const machineId = params.explicitMachineId ?? params.sessionSpawnDirectTargetTransport?.machineId
        ?? resolveMachineIdForServerFromSettings(settings, params.serverId ?? configuration.activeServerId,
          readAccountIdFromToken(custody.credentials.token)) ?? settings.machineId;
      if (!machineId) return unavailable('machine_target_unavailable');
      executionTarget = { serverId: home.serverId, machineId };
    }
    const exactInput = admitSessionSpawnNewActionInputV2({ ...authoredInput, executionTarget, agentTarget,
      ...(selected.placement.source === 'explicit' && input.sessionPlacement
        ? { sessionPlacement: input.sessionPlacement }
        : selected.placement.value ? { sessionPlacement: selected.placement.value } : {}),
      // A signed Machine request must carry the requester's resolved model
      // choice just as it carries its resolved Agent and placement. Leaving a
      // Team resource model in the private defaults context makes the receiver
      // resolve a different provider/runtime tuple from an explicit request.
      ...(!modelSelectionInput && readSessionSpawnModelChoice(input, buildBackendTargetKeyV2(agentTarget)) === undefined
        && selectedModel
        ? { modelSelection: selectedModel } : {}),
      ...(modelSelectionInput && modelSelectionRef ? { modelSelection: { v: 1, ref: modelSelectionRef, updatedAt: modelSelectionInput.updatedAt } } : {}),
      ...(sessionConfiguration ? { configuration: sessionConfiguration } : {}),
      ...(connectedServices ? { connectedServices } : {}),
    });
    const defaults = { context: completeContext,
      ...(memberSnapshot ? { [sessionCreationAccountSettingsContext]: memberSnapshot } : {}),
      ...(captured.unavailableDefaults ? { unavailableDefaults: captured.unavailableDefaults } : {}),
      ...(managedPresetAcquisition ? { managedPresetAcquisition } : {}),
      ...(managedPresetControllerAccess ? { managedPresetControllerAccess } : {}),
      authoredChoices: { ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
        ...(input.sessionPlacement ? { sessionPlacement: input.sessionPlacement } : {}),
        ...(input.agentTarget ? { agentTarget: input.agentTarget } : {}) } } satisfies CliSessionCreationDefaults;
    return { input: projectSessionSpawnNewActionInputV2(exactInput), defaults };
  };
}
