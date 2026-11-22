import { retireMachineProviderState } from '@happier-dev/protocol/machines/account/revokeWithProviderCleanup';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';

/** Consume Home's settled Delete in the enrolled Account's existing catalog custody. */
export async function retireManagedMachineProviderState(machine: ManagedMachineV1, host: Readonly<{
    credentials: StoredCredentials; serverUrl: string; context?: ActionExecutorContext; signal?: AbortSignal;
}>): Promise<void> {
    if (machine.desired !== 'delete' || machine.allocation !== 'confirmed-absent'
        || !machine.enrolledMachineId || machine.submittedNativeEffect) return;
    const machineId = machine.enrolledMachineId;
    const enrollmentAccountId = machine.enrollmentAccountId ?? machine.custodianAccountId;
    const requester = readRequesterAccountActionContext(host.context?.externalActionExecutionAuthorization);
    const owner = requester && readAccountIdFromToken(requester.credentials.token) === enrollmentAccountId ? requester : null;
    const credentials = owner?.credentials ?? host.credentials;
    // An absent guest does not give its native controller access to another Account.
    if (readAccountIdFromToken(credentials.token) !== enrollmentAccountId) return;
    await runWithServerHttpBaseUrl(owner?.serverHttpBaseUrl ?? host.serverUrl, async () => {
        try {
            const { prepareCliProviderConnectionsStore } = await import('@/providers/settings/catalogStore');
            const store = await prepareCliProviderConnectionsStore({ credentials,
                operationContext: owner?.savedSecretOperationContext, signal: host.signal });
            const cleanup = await retireMachineProviderState(machineId, {
                readCatalog: store.readCatalogForMutation, writeCatalog: store.mutateCatalog,
            });
            if (cleanup.ok) return;
            logger.warn('[MANAGED MACHINE] Provider cleanup pending', { managedId: machine.id, code: cleanup.error });
        } catch {
            logger.warn('[MANAGED MACHINE] Provider cleanup pending', { managedId: machine.id, code: 'provider_catalog_unavailable' });
        }
    });
}
