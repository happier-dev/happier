import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { StoragePathCapacityV1 } from '@happier-dev/protocol/storage/storageV1';
import type { DeploymentBackupConfigurationV1, DeploymentBackupTestResultV1 } from '@happier-dev/deployment-protocol';
import { testDeploymentBackupDestinationV1 } from '@happier-dev/deployments';
import { configuration } from '@/configuration';
import type { readDeploymentEnvironmentForHost } from '@/deployments/readEnvironmentForHost';
import { withNativeBackupRepositoryForHost, type NativeBackupRepositoryForHostInput } from '@/daemon/local/services/launch/nativeResticCommand';
import { createOwnServerNativeRuntime } from './nativeRuntime';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';

export type DeploymentBackupConfigurationNativeInputForHost = Readonly<{
    environment: Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>;
    configuration: DeploymentBackupConfigurationV1;
    intent: 'test' | 'save' | 'initializeAndSave';
    context: ActionExecutorContext;
}>;

export type DeploymentBackupConfigurationNativeHost = Readonly<{
    serverId: string;
    prepareDestination(input: DeploymentBackupConfigurationNativeInputForHost & Readonly<{ signal: AbortSignal }>):
        ReturnType<NativeBackupRepositoryForHostInput['prepareDestination']>;
}>;

export type DeploymentBackupConfigurationNativeResultForHost = Readonly<{
    test: DeploymentBackupTestResultV1;
    capacity?: StoragePathCapacityV1;
}>;

/** Controller setup consumes the same pinned native/P42 owners before a runtime
 * Target is selected; a configuration test never fabricates a deployment. */
export async function executeDeploymentBackupConfigurationNativeForHost(input: DeploymentBackupConfigurationNativeInputForHost,
    host: DeploymentBackupConfigurationNativeHost): Promise<DeploymentBackupConfigurationNativeResultForHost> {
    const operationId = input.context.operationAcceptance?.operationId;
    if (!operationId) throw new PluginError({ code: 'operation_unavailable', message: 'Backup configuration requires its admitted operation' });
    const signal = input.context.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
        serverId: host.serverId, environmentId: input.environment.environment.id });
    const directory = await mkdtemp(join(tmpdir(), 'happier-backup-configuration-'));
    let active = true;
    try {
        const runtime = createOwnServerNativeRuntime({ cwd: directory, signal, isCurrent: () => active });
        return await withNativeBackupRepositoryForHost({ cwd: directory, directory,
            environmentInstanceId: identity.environmentInstanceId, projectName: identity.projectName,
            operation: { operationId, kind: 'deployments.backups.configure', signal }, runtime,
            prepareDestination: nativeSignal => host.prepareDestination({ ...input, signal: nativeSignal }) },
        async native => ({ test: await testDeploymentBackupDestinationV1({ environmentId: input.environment.environment.id,
            operationId, ...native, initializeIfMissing: input.intent === 'initializeAndSave' }),
            ...(native.capacity ? { capacity: native.capacity } : {}) }));
    } finally { active = false; await rm(directory, { recursive: true, force: true }); }
}
