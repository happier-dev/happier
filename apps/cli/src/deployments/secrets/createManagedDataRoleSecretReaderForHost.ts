import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { DatabaseOperationClassV1 } from '@happier-dev/plugin-sdk/database';
import { parseDatabaseConnectionUrl } from '@happier-dev/databases';
import { environmentSecretBindingIdentityV1, type DeploymentEnvironmentDetailV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { DeploymentTargetRoleAdmissionHost } from '@/deployments/targets/admitDeploymentTargetRoleForHost';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import { readEnvironmentDataRoleLaunchAdmissionForHost } from './readEnvironmentSecretLaunchAdmissionForHost';

type ManagedDataRoleBinding = Extract<EnvironmentSecretBindingV1, Readonly<{ purpose: 'dataRole'; targetLinkId: string }>>;

function missing(): never {
    throw new PluginError({ code: 'secret_missing', message: 'The admitted managed data-role binding is unavailable' });
}

/** The admitted link and requested role select one binding; plugins never select a secret reference. */
function readManagedDataRoleBinding(bindings: readonly EnvironmentSecretBindingV1[], targetLinkId: string,
    role: NonNullable<Parameters<NonNullable<SecretsService['readDataRole']>>[0]>['role']): ManagedDataRoleBinding | undefined {
    return bindings.find((binding): binding is ManagedDataRoleBinding => binding.purpose === 'dataRole'
        && !('service' in binding) && binding.targetLinkId === targetLinkId && binding.role === role);
}

/**
 * Lazily opens the one P42 grant captured for an admitted managed query.
 * Constructing the SDK capability does not require a data-role binding: managed
 * providers which do not need a local password never call it.
 */
export function createManagedDataRoleSecretReaderForHost(input: Readonly<{
    host: Pick<DeploymentTargetRoleAdmissionHost,
        'credentials' | 'serverId' | 'serverHttpBaseUrl' | 'machineId' | 'installationId'>;
    environment: DeploymentEnvironmentDetailV1;
    query: Readonly<{ targetLinkId: string; expectedRevision: number }>;
    context: ActionExecutorContext;
    access?: DatabaseOperationClassV1;
    database?: string;
}>): NonNullable<SecretsService['readDataRole']> {
    return async (options) => {
        const signal = options?.signal ?? input.context.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const role = options?.role ?? 'readOnlyPassword';
        if (role === 'write' && input.access !== 'write') throw new PluginError({ code: 'deployment_access_denied' });
        const use = readManagedDataRoleBinding(input.environment.content.bindings, input.query.targetLinkId, role);
        if (!use && role === 'write') throw new PluginError({ code: 'write_connection_setup_required' });
        if (!use) return missing();
        const installation = readInstallationIdentityIfExistsSync();
        if (!installation || input.host.installationId !== installation.installationId) return missing();

        const admission = await readEnvironmentDataRoleLaunchAdmissionForHost({ credentials: input.host.credentials,
            serverId: input.host.serverId, serverHttpBaseUrl: input.host.serverHttpBaseUrl,
            environmentId: input.environment.environment.id, targetLinkId: input.query.targetLinkId,
            machineId: input.host.machineId, installationId: installation.installationId,
            expectedRevision: input.query.expectedRevision, ...(role === 'write' ? { role } : {}), context: input.context, signal });
        let seed: Uint8Array | undefined;
        let prepared: Awaited<ReturnType<typeof prepareEnvironmentSecretBindingsForLaunch>> | undefined;
        try {
            seed = decodeBase64(installation.privateKey, 'base64url').slice(0, 32);
            prepared = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: input.environment.environment.id,
                machineId: input.host.machineId, installationId: installation.installationId, installationPrivateSeed: seed,
                bindings: input.environment.content.bindings, grants: admission.grants, use,
                assertCurrent: admission.assertCurrent });
            const value = prepared.operationalValues.get(environmentSecretBindingIdentityV1(use)) ?? missing();
            if (role === 'write') {
                const selected = parseDatabaseConnectionUrl(value);
                if (selected.engine !== 'postgresql' || selected.database !== input.database) {
                    throw new PluginError({ code: 'target_mismatch' });
                }
            }
            return value;
        } finally {
            seed?.fill(0);
            prepared?.dispose();
            await admission.release?.();
        }
    };
}
