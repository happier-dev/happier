import type { ActionExecutorContext, HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/executor/types';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineSetupApplyResultV1Schema, MachineSetupPlanResultV1Schema, machineSetupApplyTargetFromPlanV1,
    buildMachineSetupTargetApplyInput } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionExecuteFailureSchema, isActionOutcomeUnknownErrorCodeV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isRecord } from '@happier-dev/protocol/common/records';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { BackupReceiverEndpointV1Schema } from '@happier-dev/protocol/machines/setup/backupReceiverV1';
import { BACKUP_RECEIVER_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { readMachineSetupRecipeIdentityV1, type MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { readSharedPrivateNetworkAddresses } from '@/machines/reachability/sharedPrivateNetworkAddresses';
import { DeploymentBackupReceiverSetupOperationV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupAnotherMachineV1';
import type { DeploymentBackupAnotherMachineSetupV1, DeploymentBackupSenderIdentityV1,
    DeploymentBackupReceiverSetupOperationV1 } from '@happier-dev/protocol/deployments/deploymentBackupAnotherMachineV1';
import { createBackupSenderIdentityForHost, type BackupSenderIdentityHostInput } from './senderIdentityForHost';

export type BackupAnotherMachineHost = Omit<BackupSenderIdentityHostInput, 'retained'> & Readonly<{
    sourceMachineId: string;
    readMachinePrivateNetworks(machineId: string, context: ActionExecutorContext): Promise<Readonly<{
        installationId: string; networks: readonly MachinePrivateNetworkObservationV1[];
    }> | null>;
}>;

/** Preserve certified copies; the canonical Setup merger decides any preset conflict. */
function receiverSources(sources: MachineSetupSourceV1, item: MachinePresetItemV1): MachineSetupSourceV1 {
    const identity = readMachineSetupRecipeIdentityV1(BACKUP_RECEIVER_RECIPE_REF_V1);
    const direct = sources.find(source => source.kind === 'direct');
    if (!direct) return [...sources, { kind: 'direct', setup: { items: [item] } }];
    const items = direct.setup.items ?? [];
    const matches = (entry: MachinePresetItemV1) => entry.kind !== 'app'
        && readMachineSetupRecipeIdentityV1(entry.selection.ref) === identity;
    const replacement = items.some(matches) ? items.map(entry => matches(entry) ? item : entry) : [...items, item];
    return sources.map(source => source === direct ? { ...source, setup: { ...source.setup, items: replacement } } : source);
}

export function prepareBackupAnotherMachineChildrenForHost(input: Readonly<{
    serverId: string; setup: DeploymentBackupAnotherMachineSetupV1;
}>): HostReviewedChildrenPlanV1 {
    return { children: Object.values(BACKUP_RECEIVER_SETUP_CHILDREN_V1).map(child => ({ ...child,
        scopeInput: { homeId: input.serverId, machineId: input.setup.machineId },
    })) };
}

export type BackupAnotherMachinePreparation =
    | Readonly<{ status: 'ready'; senderIdentity: DeploymentBackupSenderIdentityV1;
        config: Readonly<{ host: string; port: number; username: string; path: string; hostKey: string }>;
        fingerprint: string; setupOperation: DeploymentBackupReceiverSetupOperationV1 }>
    | Readonly<{ status: 'partial'; errorCode: string; senderIdentity?: DeploymentBackupSenderIdentityV1;
        setupOperation?: DeploymentBackupReceiverSetupOperationV1 }>;

export async function prepareBackupAnotherMachineForHost(input: Readonly<{
    serverId: string; setup: DeploymentBackupAnotherMachineSetupV1; context: ActionExecutorContext;
}>, host: BackupAnotherMachineHost): Promise<BackupAnotherMachinePreparation> {
    let senderIdentity = input.setup.senderIdentity;
    let setupOperation: DeploymentBackupReceiverSetupOperationV1 | undefined;
    const partial = (failure: string | ActionExecuteFailure): BackupAnotherMachinePreparation => {
        if (typeof failure !== 'string' && !isActionOutcomeUnknownErrorCodeV1(failure.errorCode)) {
            throw Object.assign(new Error(failure.errorCode, { cause: failure }), { code: failure.errorCode });
        }
        return { status: 'partial', errorCode: typeof failure === 'string' ? failure : failure.errorCode,
            ...(senderIdentity ? { senderIdentity } : {}), ...(setupOperation ? { setupOperation } : {}) };
    };
    const invoke = input.context.hostReviewedChild?.invoke;
    if (!invoke) return partial('source_unavailable');
    const endpoint = BackupReceiverEndpointV1Schema.safeParse(input.setup.receiverInputs.endpoint);
    if (!endpoint.success || input.setup.machineId === host.sourceMachineId) return partial('invalid_parameters');
    const [observer, receiver] = await Promise.all([host.readMachinePrivateNetworks(host.sourceMachineId, input.context),
        host.readMachinePrivateNetworks(input.setup.machineId, input.context)]);
    if (!readSharedPrivateNetworkAddresses({ observer: observer?.networks ?? [], target: receiver?.networks ?? [] })
        .some(candidate => candidate.address === endpoint.data.host)) return partial('no_shared_private_network');
    try {
        const identity = await createBackupSenderIdentityForHost({ ...host, ...(senderIdentity ? { retained: senderIdentity } : {}) });
        if (identity.status === 'partial') { senderIdentity = identity.senderIdentity; return partial(identity.errorCode); }
        senderIdentity = { publicKey: identity.publicKey, sshPrivateKey: identity.sshPrivateKey,
            repositoryPassword: identity.repositoryPassword };
        const target = { homeId: input.serverId, machineId: input.setup.machineId };
        const read = await invoke({ ...BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan, input: target });
        if (!read.ok) return partial(read);
        const current = MachineSetupPlanResultV1Schema.safeParse(read.result);
        if (!current.success) return partial('invalid_action_output');
        const item: MachinePresetItemV1 = { kind: 'setupRecipe', selection: { ref: BACKUP_RECEIVER_RECIPE_REF_V1,
            inputs: { ...input.setup.receiverInputs, senderPublicKey: senderIdentity.publicKey } } };
        const sources = receiverSources(current.data.sources, item);
        const identityKey = readMachineSetupRecipeIdentityV1(BACKUP_RECEIVER_RECIPE_REF_V1);
        const exclusions = current.data.exclusions.filter(exclusion => readMachineSetupRecipeIdentityV1(exclusion.ref) !== identityKey);
        const planned = await invoke({ ...BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan,
            input: projectNativeJsonValueForTransport({ ...target, sources, exclusions, mode: 'effects' }) });
        if (!planned.ok) return partial(planned);
        const plan = MachineSetupPlanResultV1Schema.safeParse(planned.result);
        if (!plan.success) return partial('invalid_action_output');
        const witness = plan.data.backupReceivers?.find(entry => entry.machineId === input.setup.machineId);
        if (!witness) return partial('receiver_evidence_unavailable');
        if (witness.installationId !== input.setup.expectedInstallationId) return partial('receiver_installation_changed');
        const applied = await invoke({ ...BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply,
            input: projectNativeJsonValueForTransport(buildMachineSetupTargetApplyInput(machineSetupApplyTargetFromPlanV1(target, plan.data))) });
        if (!applied.ok) {
            const operation = isRecord(applied.details)
                ? DeploymentBackupReceiverSetupOperationV1Schema.safeParse(applied.details.setupOperation) : null;
            if (operation?.success) setupOperation = operation.data;
            return partial(applied);
        }
        const settled = MachineSetupApplyResultV1Schema.safeParse(applied.result);
        if (!settled.success) return partial('invalid_action_output');
        setupOperation = DeploymentBackupReceiverSetupOperationV1Schema.parse({ operationId: settled.data.operationId,
            ...(settled.data.runId ? { runId: settled.data.runId } : {}), ...(settled.data.terminalId ? { terminalId: settled.data.terminalId } : {}) });
        const evidence = settled.data.backupReceivers?.find(entry => entry.sourceIndex === witness.sourceIndex
            && entry.itemIndex === witness.itemIndex && entry.machineId === witness.machineId);
        if (!evidence || evidence.status !== 'ready') return partial('receiver_evidence_unavailable');
        return { status: 'ready', senderIdentity, setupOperation, fingerprint: evidence.fingerprint,
            config: { ...evidence.endpoint, username: evidence.username, path: evidence.path, hostKey: evidence.hostKey } };
    } catch (error) {
        if (error instanceof Error) {
            const failure = ActionExecuteFailureSchema.safeParse(error.cause);
            if (failure.success) {
                const details = isRecord(failure.data.details)
                    ? failure.data.details : {};
                const retained = details.senderIdentity ?? senderIdentity;
                throw Object.assign(new Error(failure.data.errorCode, { cause: { ...failure.data, details: { ...details,
                    destinationSetup: { ...input.setup, ...(retained ? { senderIdentity: retained } : {}) } } } }),
                { code: failure.data.errorCode });
            }
        }
        throw error;
    }
}
