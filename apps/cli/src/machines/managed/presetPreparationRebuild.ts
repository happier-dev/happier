import type { ActionExecutorContext } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readExternalActionBindingAuthority } from '@happier-dev/protocol/actions/externalActionBindingAuthority';
import { readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { MachinePresetActionOutputSchemasV1, MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetGetResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { createManagedMachinePresetPreparationBindingV1, readManagedMachinePresetPreparationV1 } from '@happier-dev/cli-common/machines/managed';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { dispatchOriginalAccountAction, readExternalActionRequesterInvocation } from '@/api/externalActionExecutionAuthorization';
import { observeManagedChildApprovalExecution } from '@/api/managedChildApproval';
import { configuration } from '@/configuration';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { ManagedMachineControllerError } from './controllerErrors';
import type { ManagedMachineReconciliationInput } from './reconcile';
import { createManagedPresetHydrator, type ManagedPresetHydrator } from './presetHydration';

/** A first-use CLI change can spend only the starter's existing requester custody. */
export async function rebuildManagedPresetAtFirstUse(params: Readonly<{
    input: ManagedMachineReconciliationInput['input'];
    options: ManagedMachineReconciliationInput['options'];
    machine: ManagedMachineReconciliationInput['machine'];
    hydrator: ManagedPresetHydrator;
    content: ManagedMachinePresetContentV1;
    cliIdentity: string;
    credentialConfigurations: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'];
}>): Promise<void> {
    const { input, options, machine, hydrator, content, cliIdentity, credentialConfigurations } = params;
    const context = options.context;
    const authorization = context?.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    const executeChild = context?.executeOrdinaryChildAction;
    const waitForCompletion = input.waitForActionOperationCompletion;
    // Codec-only controller custody carries no requester credential. Its warm
    // image remains usable with the ordinary CLI swap; it cannot start Prepare.
    if (!context || !authorization || !requester) return;
    if (!executeChild || !waitForCompletion || !machine.preset || !machine.controller) {
        throw new ManagedMachineControllerError('admission_unavailable');
    }
    const authority = readExternalActionBindingAuthority(authorization.binding, context.authority);
    const readContext: ActionExecutorContext = { surface: context.surface, authority, actionCaller: context.actionCaller };
    const deps = createAccountServerActionDeps({ token: requester.credentials.token, credentials: requester.credentials,
        serverId: context.serverId ?? configuration.activeServerId, serverHttpBaseUrl: requester.serverHttpBaseUrl,
        serverIdentityId: machine.homeId, isCredentialCurrent: requester.isCustodyCurrent ?? requester.isCurrent });
    const readPreset = async () => {
        const result = await deps.machinePresetAction!({ actionId: 'machines.presets.get',
            input: { homeId: machine.homeId, id: machine.preset!.id }, context: readContext, signal: options.signal });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) throw ManagedMachineControllerError.fromActionFailure(failure.data, 'machines.presets.get');
        return ManagedMachinePresetGetResultV1Schema.parse(result);
    };
    const latest = await readPreset();
    if (latest.kind !== 'found') return;
    const preset = latest.preset;
    let canManage = preset.owner.kind === 'account' && preset.owner.accountId === authorization.binding.accountId;
    if (preset.owner.kind === 'team') {
        const team = await deps.homeDomainAction!({ actionId: 'teams.get', input: { v: 1, teamId: preset.owner.teamId },
            context: readContext, signal: options.signal });
        const failure = ActionExecuteFailureSchema.safeParse(team);
        if (failure.success) throw ManagedMachineControllerError.fromActionFailure(failure.data, 'teams.get');
        canManage = TeamSummaryV1Schema.parse(team).capabilities.manageSettings;
    }
    if (!canManage) return;
    const requesterHydrator = createManagedPresetHydrator({ ...input, credentials: requester.credentials,
        token: requester.credentials.token, serverUrl: requester.serverHttpBaseUrl });
    const needsRebuild = await requesterHydrator.withPresetDefinition(preset, async latestContent => {
        if (latestContent.preparation?.enabled !== true || latestContent.preparation.whenHappierUpdates !== 'rebuild-automatically'
        || latestContent.launch === undefined || content.launch === undefined
        || !sameStrictJsonValue(createManagedMachinePresetPreparationBindingV1({ content: { ...latestContent, launch: latestContent.launch },
            cliIdentity, credentialConfigurations }).configuration,
        createManagedMachinePresetPreparationBindingV1({ content: { ...content, launch: content.launch },
            cliIdentity, credentialConfigurations }).configuration, { omitUndefinedObjectMembers: true })) return false;
        const latestDecision = readManagedMachinePresetPreparationV1({ content: latestContent, cliIdentity,
            credentialConfigurations, canManagePreset: canManage });
        if (latestDecision.kind === 'warm' && !latestDecision.updateCli && latestContent.prepared) {
            await hydrator.replacePreparation(machine, latestContent.prepared, options.signal);
        }
        return latestDecision.kind === 'rebuild';
    }, options.signal);
    if (!needsRebuild) return;
    const target = { kind: 'machine' as const, machineId: machine.controller.machineId };
    const result = await executeChild(MACHINE_PRESET_PREPARE_ACTION_ID_V1, { homeId: machine.homeId, id: preset.id,
        expectedRevision: preset.revision, machineId: target.machineId }, { externalActionTarget: target, signal: options.signal,
        execute: async (actionId, childInput, childContext) => {
            const childAuthority = readExternalActionBindingAuthority(authorization.binding, childContext.authority);
            const execution = await dispatchOriginalAccountAction({ actionId, input: childInput, requestId: childContext.actionRequestId!, target,
                credentials: requester.credentials, serverHttpBaseUrl: requester.serverHttpBaseUrl,
                serverIdentityId: machine.homeId, authority: childAuthority, requesterCustody: authorization,
                invocation: readExternalActionRequesterInvocation({ ...childContext, authority: childAuthority }), signal: options.signal });
            return observeManagedChildApprovalExecution({ execution, context: childContext, signal: options.signal,
                expectedOrigin: { actionId, requestId: childContext.actionRequestId!, accountId: authorization.binding.accountId,
                    serverIdentityId: machine.homeId, machineId: target.machineId },
                isCurrent: requester.isCustodyCurrent ?? requester.isCurrent,
                observeRecordedApprovalExecution: input.observeRecordedApprovalExecution });
        } });
    if (!result.ok) throw ManagedMachineControllerError.fromActionFailure(result, MACHINE_PRESET_PREPARE_ACTION_ID_V1);
    const accepted = MachinePresetActionOutputSchemasV1[MACHINE_PRESET_PREPARE_ACTION_ID_V1].parse(result.result);
    const completed = await waitForCompletion({ accountId: authorization.binding.accountId, machineId: target.machineId }, accepted.operationId);
    const terminal = completed ? readActionOperationTerminalResultV1(completed) : null;
    if (!terminal) throw new ManagedMachineControllerError('admission_unavailable');
    if (!terminal.ok) throw ManagedMachineControllerError.fromActionFailure(terminal, MACHINE_PRESET_PREPARE_ACTION_ID_V1);
    const completedPreset = await readPreset();
    if (completedPreset.kind !== 'found') throw new ManagedMachineControllerError('credential_unavailable');
    await requesterHydrator.withPresetDefinition(completedPreset.preset, async completedContent => {
        const prepared = completedContent.prepared;
        if (!prepared) throw new ManagedMachineControllerError('credential_unavailable');
        await hydrator.replacePreparation(machine, prepared, options.signal);
    }, options.signal);
}
