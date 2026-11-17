import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentTargetDataQueryInputV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import { environmentSecretBindingIdentityV1, type DeploymentEnvironmentDetailV1,
    type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { DeploymentTargetRoleAdmissionHost } from '@/deployments/targets/admitDeploymentTargetRoleForHost';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import { readEnvironmentDataRoleLaunchAdmissionForHost } from './readEnvironmentSecretLaunchAdmissionForHost';

type ManagedDataRoleBinding = Extract<EnvironmentSecretBindingV1, Readonly<{
    purpose: 'dataRole'; targetLinkId: string; role: 'readOnlyPassword';
}>>;

function missing(): never {
    throw new PluginError({ code: 'secret_missing', message: 'The admitted managed data-role binding is unavailable' });
}

/** The selected link is captured by target-role admission; plugins never select a secret or role. */
function readManagedDataRoleBinding(bindings: readonly EnvironmentSecretBindingV1[], targetLinkId: string): ManagedDataRoleBinding | undefined {
    return bindings.find((binding): binding is ManagedDataRoleBinding => binding.purpose === 'dataRole'
        && !('service' in binding) && binding.targetLinkId === targetLinkId && binding.role === 'readOnlyPassword');
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
    query: Pick<DeploymentTargetDataQueryInputV1, 'targetLinkId' | 'expectedRevision'>;
    context: ActionExecutorContext;
}>): NonNullable<SecretsService['readDataRole']> {
    return async (options) => {
        const signal = options?.signal ?? input.context.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const use = readManagedDataRoleBinding(input.environment.content.bindings, input.query.targetLinkId);
        if (!use) return missing();
        const installation = readInstallationIdentityIfExistsSync();
        if (!installation || input.host.installationId !== installation.installationId) return missing();

        const admission = await readEnvironmentDataRoleLaunchAdmissionForHost({ credentials: input.host.credentials,
            serverId: input.host.serverId, serverHttpBaseUrl: input.host.serverHttpBaseUrl,
            environmentId: input.environment.environment.id, targetLinkId: input.query.targetLinkId,
            machineId: input.host.machineId, installationId: installation.installationId,
            expectedRevision: input.query.expectedRevision, context: input.context, signal });
        let seed: Uint8Array | undefined;
        let prepared: Awaited<ReturnType<typeof prepareEnvironmentSecretBindingsForLaunch>> | undefined;
        try {
            seed = decodeBase64(installation.privateKey, 'base64url').slice(0, 32);
            prepared = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: input.environment.environment.id,
                machineId: input.host.machineId, installationId: installation.installationId, installationPrivateSeed: seed,
                bindings: input.environment.content.bindings, grants: admission.grants, use,
                assertCurrent: admission.assertCurrent });
            return prepared.operationalValues.get(environmentSecretBindingIdentityV1(use)) ?? missing();
        } finally {
            seed?.fill(0);
            prepared?.dispose();
            await admission.release?.();
        }
    };
}
