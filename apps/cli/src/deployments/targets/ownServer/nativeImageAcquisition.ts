import { environmentSecretBindingIdentityV1, type DeploymentEnvironmentContentV1, type OwnServerDeploymentImageArchiveV1 } from '@happier-dev/deployment-protocol';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import type { NativeComposeEnvironmentProjectInput } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import type { OwnServerDeploymentRuntimeAcquisition } from './ownServerDeploymentTarget';

/** Both deploy and rollback lend the native owner the current exact binding.
 * Merely constructing this facade never opens registry credential material. */
export function createOwnServerNativeImageAcquisition(input: Readonly<{
    runtime: Pick<OwnServerDeploymentRuntimeAcquisition, 'exec' | 'secrets' | 'copyDeploymentImageArchive' | 'buildExecutionDirectory'>;
    source: DeploymentSourceMaterializationV1;
    environment: DeploymentEnvironmentContentV1;
    targetLinkId: string;
    operation: 'deploy' | 'rollback';
    signal: AbortSignal;
    assertCurrent(): Promise<void>;
    imageArchives?: readonly OwnServerDeploymentImageArchiveV1[];
}>): NonNullable<NativeComposeEnvironmentProjectInput['imageAcquisition']> {
    return { operation: input.operation,
        publicRegistryEnvPort: createDeploymentExecEnvPortForHost({ source: input.source, phase: 'build',
            signal: input.signal, isCurrent: () => !input.signal.aborted,
            // Explicit empty registry demand uses the same private config writer.
            // It opens neither variables nor ambient Docker credential helpers.
            prepare: () => prepareEnvironmentSecretBindingsForLaunch({ ...input.runtime.secrets,
                environmentId: input.source.environmentId, machineId: input.source.machineId,
                installationId: input.source.installationId, registryUses: [], bindings: input.environment.bindings,
                assertCurrent: input.assertCurrent }),
        }), registries: input.environment.bindings.flatMap(binding => {
        if (binding.purpose !== 'registry' || binding.targetLinkId !== input.targetLinkId) return [];
        const bindingIdentity = environmentSecretBindingIdentityV1(binding);
        return [{ access: binding.access, origin: binding.registryOrigin, bindingIdentity,
            envPort: createDeploymentExecEnvPortForHost({ bindingIdentity, signal: input.signal,
                isCurrent: () => !input.signal.aborted,
                prepare: () => prepareEnvironmentSecretBindingsForLaunch({ ...input.runtime.secrets,
                    environmentId: input.source.environmentId, machineId: input.source.machineId,
                    installationId: input.source.installationId, bindings: input.environment.bindings,
                    use: { ...binding, access: 'pull' }, assertCurrent: input.assertCurrent }),
            }),
            ...(binding.access === 'pushPull' ? { publicationEnvPort: createDeploymentExecEnvPortForHost({
                bindingIdentity, signal: input.signal,
                isCurrent: () => !input.signal.aborted,
                prepare: () => prepareEnvironmentSecretBindingsForLaunch({ ...input.runtime.secrets,
                    environmentId: input.source.environmentId, machineId: input.source.machineId,
                    installationId: input.source.installationId, bindings: input.environment.bindings,
                    use: binding, assertCurrent: input.assertCurrent }),
            }) } : {}),
        }];
    }), archives: input.imageArchives?.map(archive => ({ image: archive.image, sizeBytes: archive.sizeBytes, sha256: archive.sha256,
        async acquire() {
            input.signal.throwIfAborted();
            await input.assertCurrent();
            if (!input.runtime.copyDeploymentImageArchive) throw new PluginError({ code: 'filesystem_transfer_custody_required',
                message: 'Receiving daemon image-transfer custody is unavailable' });
            const received = await input.runtime.copyDeploymentImageArchive({ archive, signal: input.signal, assertCurrent: input.assertCurrent });
            await input.assertCurrent();
            input.signal.throwIfAborted();
            return received;
        },
    })) };
}
