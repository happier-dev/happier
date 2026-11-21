import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { respondToManagedInstallation } from '@happier-dev/protocol/machines/managed/installationResponse';
import { unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createManagedMachineActionClient, invokeManagedInstallationResponse, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { approveTerminalPairing } from '@/auth/terminal/approveTerminalPairing';
import { buildEstablishedHomeTransportDescriptor, resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { decodeBase64 } from '@/encryption/base64';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { captureLazyActionAccountContext, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { createManagedMachinePresetReadCustodyV1 } from '@/sync/ops/machines/managedMachinePresetCustody';

/** Capture UI custody; installation decisions are shared with the native CLI answering client. */
export function createManagedMachineInstallationRespond(captured?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['machineManagedInstallationRespond']> {
    return async (input, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, input.serverId)
            || captured && !areServerProfileIdentifiersEquivalent(captured.serverId, input.serverId)) return fail('server_target_mismatch');
        const account = captured ?? await captureLazyActionAccountContext(input.serverId, context.signal);
        try {
            return await withActionAccountRequestSignal(account, context.signal, async signal => respondToManagedInstallation(input,
                { ...context, signal }, {
                    accountId: account.accountId, homeId: account.serverIdentityId,
                    accountAuthority: Boolean(account.credentials && account.credentialAuthorityKind === 'account'),
                    assertCurrent: () => account.assertCurrent(),
                    readMachine: async () => {
                        const read = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get',
                            { homeId: input.homeId, managedId: input.managedId }, { signal });
                        const originalMachine = unwrapManagedMachineReadV1(read);
                        const custody = createManagedMachinePresetReadCustodyV1({ account, signal });
                        let machine: ManagedMachineV1 | undefined;
                        try {
                            // Preserve the post-GET collection boundary; avoid the front-door executor load cycle.
                            const { openManagedMachineReadSnapshotsAtCustody } = await import('@/sync/ops/machines/machinePresetCollectionClient');
                            [machine] = await openManagedMachineReadSnapshotsAtCustody([read], custody);
                        } finally { await custody?.dispose(); }
                        return { originalMachine, machine };
                    },
                    readOperation: (machineId, operationId) => getActionOperation({
                        serverId: account.serverId, accountId: account.accountId, machineId, operationId,
                        requireCurrentDomainFacts: true, signal,
                    }),
                    invokeInstallation: body => invokeManagedInstallationResponse({ account, signal, input: body }),
                    invokeTask: async (machineId, response) => {
                        const result = await machineCapabilitiesInvoke(machineId, {
                            id: 'tool.systemTasks', method: 'respond', params: response,
                        }, { serverId: account.serverId, accountId: account.accountId, signal });
                        if (result.supported) return result.response;
                        const code = result.reason === 'not-supported' ? 'unsupported_action'
                            : result.requestDisposition === 'outcomeUnknown' ? 'outcome_uncertain' : 'managed_request_failed';
                        return { ok: false, error: { code, message: code } };
                    },
                    approvePairing: async pairing => {
                        // The admitted explicit answer must never trigger a second confirmation.
                        account.assertCurrent();
                        signal?.throwIfAborted();
                        const home = await account.resolveHomeTarget();
                        const descriptor = home.descriptor ?? buildEstablishedHomeTransportDescriptor({
                            canonicalServerUrl: home.canonicalAuthUrl, homeServerIdentityId: input.homeId });
                        if (!descriptor || descriptor.homeServerIdentityId !== input.homeId) return 'server_target_mismatch';
                        const target = await resolveHomeEnrollmentTransport(descriptor);
                        if (!target.ok) return target.reason;
                        try {
                            account.assertCurrent();
                            signal?.throwIfAborted();
                            // The shared owner admits pairing only with live Account credentials.
                            if (!account.credentials) return 'action_account_scope_changed';
                            const result = await approveTerminalPairing({ target: target.transport, targetCredentials: account.credentials,
                                requesterPublicKey: decodeBase64(pairing.publicKey), supportsTokenOnly: pairing.supportsTokenOnly,
                                pairingContext: { secret: decodeBase64(pairing.pairing.secretB64Url, 'base64url'),
                                    createdAtMs: pairing.pairing.createdAtMs, expiresAtMs: pairing.pairing.expiresAtMs }, signal });
                            if (result === 'approved' || result === 'approved_without_team_access') return undefined;
                            return result === 'not_found' ? 'no_prompt' : 'auth_request_already_authorized';
                        } finally { await target.transport.close(); }
                    },
                }));
        } catch (error) {
            if (error instanceof ManagedMachineActionError) return fail(error.code);
            throw error;
        } finally { if (!captured) account.dispose(); }
    };
}
