import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedMachineActionClient, invokeManagedInstallationResponse, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { ManagedTerminalPairingContextV1Schema, type ManagedInstallationResponseV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { approveTerminalPairing } from '@/auth/terminal/approveTerminalPairing';
import { buildEstablishedHomeTransportDescriptor, resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { decodeBase64 } from '@/encryption/base64';
import { managedMachineOperationMatchesResource, readManagedInstallationPromptSnapshot } from '@/sync/domains/actionOperations/managedMachineOperation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { captureLazyActionAccountContext, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { createManagedMachinePresetReadCustodyV1 } from '@/sync/ops/machines/managedMachinePresetCustody';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Resolve the controller and open installer question from current owners, never caller-supplied task authority. */
export function createManagedMachineInstallationRespond(captured?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['machineManagedInstallationRespond']> {
    return async (input, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, input.serverId)
            || captured && !areServerProfileIdentifiersEquivalent(captured.serverId, input.serverId)) return fail('server_target_mismatch');
        const account = captured ?? await captureLazyActionAccountContext(input.serverId, context.signal);
        try {
            account.assertCurrent();
            if (context.expectedAccountId && context.expectedAccountId !== account.accountId
                || context.runtimeAccountId && context.runtimeAccountId !== account.accountId) return fail('action_account_scope_changed');
            if (!account.serverIdentityId || account.serverIdentityId !== input.homeId) return fail('server_target_mismatch');
            return await withActionAccountRequestSignal(account, context.signal, async signal => {
                const read = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get',
                    { homeId: input.homeId, managedId: input.managedId }, { signal });
                const custody = createManagedMachinePresetReadCustodyV1({ account, signal });
                let machine: ManagedMachineV1 | undefined;
                try {
                    // The default Action executor owns this module's load graph. Keep the
                    // collection reader at its actual post-GET boundary so this Action does
                    // not eagerly pull the front-door executor back through collection setup.
                    const { openManagedMachineReadSnapshotsAtCustody } = await import(
                        '@/sync/ops/machines/machinePresetCollectionClient',
                    );
                    [machine] = await openManagedMachineReadSnapshotsAtCustody([read], custody);
                } finally {
                    await custody?.dispose();
                }
                account.assertCurrent();
                if (!machine || machine.id !== input.managedId || machine.homeId !== input.homeId
                    || machine.creationState !== 'active' || machine.archivedAt !== undefined
                    || machine.allocation !== 'bound' || !machine.resource || machine.cleanup || machine.desired === 'delete') return fail('no_prompt');
                // Foreground Account enrollment owns its private prompts inline.
                const controller = machine.controller;
                if (!controller) return fail('no_prompt');
                if ((machine.enrollmentAccountId ?? machine.custodianAccountId) !== machine.custodianAccountId) {
                    // A managed creation purpose is not a controller Machine grant. Home and the
                    // installed runner check the exact current row/request/operation/task instead.
                    if (machine.enrollmentAccountId !== account.accountId || !account.credentials
                        || account.credentialAuthorityKind !== 'account') return fail('action_account_scope_changed');
                    const binding = { homeId: input.homeId, managedId: input.managedId, operationId: input.operationId,
                        taskId: input.taskId, controller, resource: machine.resource,
                        expectedIntentRevision: machine.intentRevision };
                    const promptKind = input.purpose === 'establish' ? 'administrator.establish' : input.prompt.kind;
                    const respond = (response: Pick<ManagedInstallationResponseV1, 'answer' | 'delivery'>) =>
                        invokeManagedInstallationResponse({ account, signal, input: { ...binding, expectedPromptKind: promptKind,
                            ...(input.purpose === 'establish' ? { expectedPromptId: input.promptId } : {}), ...response } });
                    const approved = input.purpose === 'approve' && input.approved;
                    if (input.purpose === 'approve' && input.prompt.kind === 'auth.approveRemoteProvisioning' && input.approved) {
                        const delivered = await respond({ delivery: { kind: 'terminalPairing' } });
                        if (!delivered.ok) return fail(delivered.error.code ?? 'managed_request_failed');
                        const pairing = ManagedTerminalPairingContextV1Schema.safeParse(delivered.result);
                        if (!pairing.success) return fail('managed_response_invalid');
                        if (pairing.data.enrollmentAccountId !== account.accountId) return fail('action_account_scope_changed');
                        if (pairing.data.homeServerIdentityId !== input.homeId) return fail('server_target_mismatch');
                        if (Date.now() >= pairing.data.pairing.expiresAtMs
                            || pairing.data.pairing.expiresAtMs <= pairing.data.pairing.createdAtMs) return fail('auth_request_expired');
                        // Action admission owns the supplied answer. Pairing delivery must
                        // never ask again and replace an accepted approval with a decline.
                        account.assertCurrent();
                        signal?.throwIfAborted();
                        const home = await account.resolveHomeTarget();
                        const descriptor = home.descriptor ?? buildEstablishedHomeTransportDescriptor({
                            canonicalServerUrl: home.canonicalAuthUrl, homeServerIdentityId: input.homeId });
                        if (!descriptor || descriptor.homeServerIdentityId !== input.homeId) return fail('server_target_mismatch');
                        const target = await resolveHomeEnrollmentTransport(descriptor);
                        if (!target.ok) return fail(target.reason);
                        try {
                            account.assertCurrent();
                            signal?.throwIfAborted();
                            const pairingResult = await approveTerminalPairing({ target: target.transport, targetCredentials: account.credentials,
                                requesterPublicKey: decodeBase64(pairing.data.publicKey), supportsTokenOnly: pairing.data.supportsTokenOnly,
                                pairingContext: { secret: decodeBase64(pairing.data.pairing.secretB64Url, 'base64url'),
                                    createdAtMs: pairing.data.pairing.createdAtMs, expiresAtMs: pairing.data.pairing.expiresAtMs }, signal });
                            if (pairingResult !== 'approved') return fail(pairingResult === 'not_found' ? 'no_prompt' : 'auth_request_already_authorized');
                        } finally { await target.transport.close(); }
                    }
                    account.assertCurrent();
                    signal?.throwIfAborted();
                    const answer: NonNullable<ManagedInstallationResponseV1['answer']> = input.purpose === 'establish' ? { password: input.password }
                        : promptKind === 'ssh.trustHost' || promptKind === 'ssh.replaceHostKey' ? { trusted: input.approved }
                        : promptKind === 'daemon.replaceRemoteBackgroundServices' ? { replaceExistingServices: input.approved }
                        : { approved };
                    const result = await respond({ answer });
                    if (!result.ok) return fail(result.error.code ?? 'managed_request_failed');
                    return { taskId: input.taskId };
                }
                const found = await getActionOperation({
                    serverId: account.serverId, accountId: account.accountId, machineId: controller.machineId,
                    operationId: input.operationId, requireCurrentDomainFacts: true, signal,
                });
                account.assertCurrent();
                if (found.kind !== 'found' || found.operation.scope.accountId !== account.accountId
                    || !managedMachineOperationMatchesResource(machine, found.operation)) return fail('no_prompt');
                const openPrompt = readManagedInstallationPromptSnapshot(found.operation);
                if (!openPrompt || openPrompt.taskId !== input.taskId) return fail('no_prompt');
                const { taskId: _taskId, ...prompt } = openPrompt;
                let response;
                if (input.purpose === 'establish') {
                    if (prompt.kind !== 'administrator.establish' || prompt.promptId !== input.promptId) return fail('no_prompt');
                    response = { taskId: input.taskId, expectedPromptKind: prompt.kind, expectedPromptId: input.promptId,
                        answer: { password: input.password } };
                } else {
                    if (prompt.kind === 'administrator.establish' || !sameStrictJsonValue(prompt, input.prompt)) return fail('no_prompt');
                    const answer = prompt.kind === 'ssh.trustHost' || prompt.kind === 'ssh.replaceHostKey' ? { trusted: input.approved }
                        : prompt.kind === 'daemon.replaceRemoteBackgroundServices' ? { replaceExistingServices: input.approved }
                        : { approved: input.approved };
                    response = { taskId: input.taskId, expectedPromptKind: prompt.kind, answer };
                }
                const result = await machineCapabilitiesInvoke(controller.machineId, {
                    id: 'tool.systemTasks', method: 'respond', params: response,
                }, { serverId: account.serverId, accountId: account.accountId, signal });
                if (!result.supported) return fail(result.reason === 'not-supported' ? 'unsupported_action'
                    : result.requestDisposition === 'outcomeUnknown' ? 'outcome_uncertain' : 'managed_request_failed');
                if (!result.response.ok) return fail(result.response.error.code ?? 'managed_request_failed');
                return { taskId: input.taskId };
            });
        } catch (error) {
            if (error instanceof ManagedMachineActionError) return fail(error.code);
            throw error;
        } finally { if (!captured) account.dispose(); }
    };
}
