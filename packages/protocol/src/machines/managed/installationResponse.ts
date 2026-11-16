import type { ActionExecutorContext, ActionExecutorDeps } from '../../actions/executor/types.js';
import type { ActionOperationGetV1Response } from '../../actions/operations/v1.js';
import type { CapabilitiesInvokeResponse } from '../../capabilities/index.js';
import type { ManagedMachineV1 } from './managedMachineV1.js';
import { ManagedTerminalPairingContextV1Schema, projectManagedEnrollmentCorrelationV1,
    type ManagedInstallationResponseV1 } from './actionsV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { managedMachineOperationMatchesResource, readManagedInstallationPromptSnapshot } from './installationPrompt.js';

type InstallationInput = Parameters<NonNullable<ActionExecutorDeps['machineManagedInstallationRespond']>>[0];
type Pairing = ReturnType<typeof ManagedTerminalPairingContextV1Schema.parse>;
type TaskResponse = Pick<ManagedInstallationResponseV1, 'taskId' | 'expectedPromptKind' | 'expectedPromptId' | 'answer'>;

/** Platform custody and transport; installation decisions belong to this shared answering-client owner. */
export type ManagedInstallationAnsweringClient = Readonly<{
    accountId: string;
    homeId: string | null | undefined;
    accountAuthority: boolean;
    assertCurrent(): void;
    readMachine(input: InstallationInput, signal?: AbortSignal): Promise<Readonly<{
        originalMachine: ManagedMachineV1; machine: ManagedMachineV1 | undefined;
    }>>;
    readOperation(machineId: string, operationId: string, signal?: AbortSignal): Promise<ActionOperationGetV1Response>;
    invokeInstallation(input: ManagedInstallationResponseV1, signal?: AbortSignal): Promise<CapabilitiesInvokeResponse>;
    invokeTask(machineId: string, input: TaskResponse, signal?: AbortSignal): Promise<CapabilitiesInvokeResponse>;
    approvePairing(pairing: Pairing, signal?: AbortSignal): Promise<string | undefined>;
}>;

/** Answer the current resource's exact question without transferring client custody to a daemon. */
export async function respondToManagedInstallation(input: InstallationInput, context: ActionExecutorContext,
    client: ManagedInstallationAnsweringClient) {
    const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    const signal = context.signal;
    client.assertCurrent();
    if (context.expectedAccountId && context.expectedAccountId !== client.accountId
        || context.runtimeAccountId && context.runtimeAccountId !== client.accountId) return fail('action_account_scope_changed');
    if (!client.homeId || client.homeId !== input.homeId) return fail('server_target_mismatch');
    const { originalMachine, machine } = await client.readMachine(input, signal);
    client.assertCurrent();
    if (!machine || machine.id !== input.managedId || machine.homeId !== input.homeId
        || machine.creationState !== 'active' || machine.archivedAt !== undefined
        || machine.allocation !== 'bound' || !machine.resource || machine.cleanup || machine.desired === 'delete') return fail('no_prompt');
    // Foreground Account enrollment owns its private prompts inline.
    const controller = machine.controller;
    if (!controller) return fail('no_prompt');
    if ((machine.enrollmentAccountId ?? machine.custodianAccountId) !== machine.custodianAccountId) {
        // A managed creation purpose is not a controller Machine grant. Home and the
        // installed runner check the exact current row/request/operation/task instead.
        if (machine.enrollmentAccountId !== client.accountId || !client.accountAuthority) return fail('action_account_scope_changed');
        const binding = projectManagedEnrollmentCorrelationV1(originalMachine, {
            homeId: input.homeId, managedId: input.managedId, operationId: input.operationId,
            taskId: input.taskId, controller, resource: machine.resource,
            expectedIntentRevision: machine.intentRevision });
        const promptKind = input.purpose === 'establish' ? 'administrator.establish' : input.prompt.kind;
        const respond = (response: Pick<ManagedInstallationResponseV1, 'answer' | 'delivery'>) =>
            client.invokeInstallation({ ...binding, expectedPromptKind: promptKind,
                ...(input.purpose === 'establish' ? { expectedPromptId: input.promptId } : {}), ...response }, signal);
        const approved = input.purpose === 'approve' && input.approved;
        if (input.purpose === 'approve' && input.prompt.kind === 'auth.approveRemoteProvisioning' && input.approved) {
            const delivered = await respond({ delivery: { kind: 'terminalPairing' } });
            if (!delivered.ok) return fail(delivered.error.code ?? 'managed_request_failed');
            const pairing = ManagedTerminalPairingContextV1Schema.safeParse(delivered.result);
            if (!pairing.success) return fail('managed_response_invalid');
            if (pairing.data.enrollmentAccountId !== client.accountId) return fail('action_account_scope_changed');
            if (pairing.data.homeServerIdentityId !== input.homeId) return fail('server_target_mismatch');
            if (Date.now() >= pairing.data.pairing.expiresAtMs
                || pairing.data.pairing.expiresAtMs <= pairing.data.pairing.createdAtMs) return fail('auth_request_expired');
            const pairingFailure = await client.approvePairing(pairing.data, signal);
            if (pairingFailure) return fail(pairingFailure);
        }
        client.assertCurrent();
        signal?.throwIfAborted();
        const answer: NonNullable<ManagedInstallationResponseV1['answer']> = input.purpose === 'establish' ? { password: input.password }
            : promptKind === 'ssh.trustHost' || promptKind === 'ssh.replaceHostKey' ? { trusted: input.approved }
            : promptKind === 'daemon.replaceRemoteBackgroundServices' ? { replaceExistingServices: input.approved }
            : { approved };
        const result = await respond({ answer });
        if (!result.ok) return fail(result.error.code ?? 'managed_request_failed');
        return { taskId: input.taskId };
    }
    const found = await client.readOperation(controller.machineId, input.operationId, signal);
    client.assertCurrent();
    if (found.kind !== 'found' || found.operation.scope.accountId !== client.accountId
        || !managedMachineOperationMatchesResource(machine, found.operation)) return fail('no_prompt');
    const openPrompt = readManagedInstallationPromptSnapshot(found.operation);
    if (!openPrompt || openPrompt.taskId !== input.taskId) return fail('no_prompt');
    const { taskId: _taskId, ...prompt } = openPrompt;
    let response: TaskResponse;
    if (input.purpose === 'establish') {
        if (prompt.kind !== 'administrator.establish' || prompt.promptId !== input.promptId) return fail('no_prompt');
        response = { taskId: input.taskId, expectedPromptKind: prompt.kind, expectedPromptId: input.promptId,
            answer: { password: input.password } };
    } else {
        if (prompt.kind === 'administrator.establish' || !sameStrictJsonValue(prompt, input.prompt)) return fail('no_prompt');
        const answer: NonNullable<ManagedInstallationResponseV1['answer']> = prompt.kind === 'ssh.trustHost' || prompt.kind === 'ssh.replaceHostKey' ? { trusted: input.approved }
            : prompt.kind === 'daemon.replaceRemoteBackgroundServices' ? { replaceExistingServices: input.approved }
            : { approved: input.approved };
        response = { taskId: input.taskId, expectedPromptKind: prompt.kind, answer };
    }
    const result = await client.invokeTask(controller.machineId, response, signal);
    if (!result.ok) return fail(result.error.code ?? 'managed_request_failed');
    return { taskId: input.taskId };
}
