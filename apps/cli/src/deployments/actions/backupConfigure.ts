import type { ActionExecutorContext, EnvironmentSecretBindingV1, EnvironmentSecretBindingInputV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { environmentSecretBindingIdentityV1, isSettledEnvironmentSecretBindingV1, type DeploymentBackupConfigurationV1, type DeploymentEnvironmentBackupV1 } from '@happier-dev/deployment-protocol';
import { prepareDeploymentBackupConfigurationV1, prepareDeploymentBackupNotNeededV1 } from '@happier-dev/deployments';
import { resolveSshKnownHostTrust } from '@happier-dev/cli-common/systemTasks';
import type { DeploymentBackupConfigurationNativeInputForHost, DeploymentBackupConfigurationNativeResultForHost } from '../targets/ownServer/backupConfigurationNative';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { DeploymentBackupConfigureInputV1, DeploymentBackupConfigureResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import type { ResolvedDeploymentCreationDefaultsV1, DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import type { readDeploymentEnvironmentForHost } from '../readEnvironmentForHost';
import type { BackupAnotherMachinePreparation } from '../backups/anotherMachineForHost';
import type { DeploymentBackupAnotherMachineSetupV1 } from '@happier-dev/protocol/deployments/deploymentBackupAnotherMachineV1';
import { projectDeploymentFailure } from '../deploymentFailure';

export type DeploymentBackupConfigurationEnvironmentForHost = Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>;

type Registry = Pick<ResolvedExecutablePluginRuntimeRegistry, 'readPluginOccurrenceId'> & Readonly<{
    contributes: Pick<ResolvedExecutablePluginRuntimeRegistry['contributes'], 'backupDestinations'>;
}>;
export type DeploymentBackupConfigureHost<TRegistry extends Registry = Registry> = Readonly<{
    serverId: string;
    readEnvironment(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<DeploymentBackupConfigurationEnvironmentForHost>;
    acquirePluginRuntimeRegistryLease(): Promise<Readonly<{ registry: TRegistry; release(): Promise<void> }>>;
    executeNative(request: DeploymentBackupConfigurationNativeInputForHost, registry: TRegistry): Promise<DeploymentBackupConfigurationNativeResultForHost>;
    resolveCreationDefaults(environment: DeploymentBackupConfigurationEnvironmentForHost, explicit: DeploymentCreationDefaultsV1,
        context: ActionExecutorContext): Promise<ResolvedDeploymentCreationDefaultsV1>;
    readActiveBackupAutomationIds(environment: DeploymentBackupConfigurationEnvironmentForHost, context: ActionExecutorContext): Promise<readonly string[]>;
    saveBackup(request: Readonly<{ environment: DeploymentBackupConfigurationEnvironmentForHost; backup: DeploymentEnvironmentBackupV1;
        context: ActionExecutorContext }>): Promise<Readonly<{ ok: true; environmentId: string; revision: number }> | ActionExecuteFailure>;
    prepareAnotherMachine?(setup: DeploymentBackupAnotherMachineSetupV1, context: ActionExecutorContext,
        environment: DeploymentBackupConfigurationEnvironmentForHost): Promise<BackupAnotherMachinePreparation>;
    saveBackupBindings?(request: Readonly<{ environmentId: string; expectedRevision: number;
        bindings: NonNullable<Extract<DeploymentBackupConfigureInputV1, { intent: 'save' }>['backupBindings']>;
        context: ActionExecutorContext }>): Promise<Readonly<{ ok: true; revision: number }> | ActionExecuteFailure>;
}>;

function withBackupBindings<TBinding extends EnvironmentSecretBindingInputV1>(environment: DeploymentBackupConfigurationEnvironmentForHost, bindings: readonly TBinding[]) {
    const candidate = new Map<string, EnvironmentSecretBindingV1 | TBinding>(environment.content.bindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
    for (const binding of bindings) candidate.set(environmentSecretBindingIdentityV1(binding), binding);
    return { ...environment, content: { ...environment.content, bindings: [...candidate.values()] } };
}

/** Configuration owns the only backup-leaf mutation and settles native proof before publishing it. */
export function createDeploymentBackupConfigureActionForHost<TRegistry extends Registry>(host: DeploymentBackupConfigureHost<TRegistry>) {
    return async (input: DeploymentBackupConfigureInputV1, context: ActionExecutorContext): Promise<DeploymentBackupConfigureResultV1 | ActionExecuteFailure> => {
        let settledSetup: Pick<Extract<DeploymentBackupConfigureResultV1, { kind: 'tested' }>, 'destinationSetup' | 'setupOperation'> | undefined;
        const retainSetupFailure = (result: ActionExecuteFailure): ActionExecuteFailure => settledSetup
            ? { ...result, effectAttempted: true, details: {
                ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {}),
                ...settledSetup } }
            : result;
        const failure = (code: string) => retainSetupFailure(projectDeploymentFailure(code));
        try {
            if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
            const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
            if (environment.environment.id !== input.environmentId || environment.environment.revision !== input.expectedRevision) {
                return failure('deployment_conflict');
            }
            if (input.intent === 'markNotNeeded') {
                const prepared = prepareDeploymentBackupNotNeededV1({ currentBackup: environment.content.backup,
                    activeAutomationIds: await host.readActiveBackupAutomationIds(environment, context) });
                if (!prepared.ok) return failure(prepared.code);
                const saved = await host.saveBackup({ environment, backup: prepared.backup, context });
                return saved.ok ? { kind: 'notNeeded', environmentId: saved.environmentId, revision: saved.revision } : saved;
            }
            if (input.intent === 'rekeyAndSave') {
                const current = environment.content.backup;
                if (!current || 'notNeeded' in current) return failure('backup_required');
                if (!host.saveBackupBindings) return failure('source_unavailable');
                const bindings = [{ purpose: 'backupDestination' as const, configKey: 'destination' as const,
                    role: 'repositoryPassword' as const, source: { kind: 'secret' as const, ...input.replacement } }];
                const lease = await host.acquirePluginRuntimeRegistryLease();
                try {
                    const native = await host.executeNative({ environment: withBackupBindings(environment, bindings),
                        previousEnvironment: environment, configuration: current, intent: input.intent, context }, lease.registry);
                    if (native.test.kind !== 'reachable') return { kind: 'tested', test: native.test };
                    const saved = await host.saveBackupBindings({ environmentId: input.environmentId,
                        expectedRevision: input.expectedRevision, bindings, context });
                    if (!saved.ok) return { ...saved, effectAttempted: true, details: {
                        ...(saved.details && typeof saved.details === 'object' && !Array.isArray(saved.details) ? saved.details : {}),
                        environmentId: input.environmentId, revision: input.expectedRevision, backupBindings: bindings } };
                    return { kind: 'configured', environmentId: input.environmentId, revision: saved.revision, configuration: current };
                } finally { await lease.release(); }
            }
            let configuration = input.configuration;
            let bindings = input.backupBindings ?? [];
            if (input.destinationSetup) {
                if (!host.prepareAnotherMachine) return failure('source_unavailable');
                const setup = await host.prepareAnotherMachine(input.destinationSetup, context, environment);
                const destinationSetup = { ...input.destinationSetup,
                    ...(setup.senderIdentity ? { senderIdentity: setup.senderIdentity } : {}) };
                if (setup.status === 'partial') return { kind: 'setupIncomplete', destinationSetup,
                    errorCode: setup.errorCode, ...(setup.setupOperation ? { setupOperation: setup.setupOperation } : {}) };
                settledSetup = { destinationSetup, setupOperation: setup.setupOperation };
                const existingPin = configuration.config.hostKey;
                if (typeof existingPin === 'string' && resolveSshKnownHostTrust({ scannedHostKeyLine: setup.config.hostKey,
                    trustedHostKey: existingPin }).status !== 'trusted') return { kind: 'setupIncomplete', destinationSetup,
                    errorCode: 'trusted_host_key_mismatch', setupOperation: setup.setupOperation };
                configuration = { ...configuration, config: { ...configuration.config, ...setup.config } };
                bindings = [...bindings.filter(binding => binding.role !== 'sshPrivateKey'
                    && !(binding.role === 'repositoryPassword' && setup.senderIdentity.repositoryPassword)),
                    { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey', source: setup.senderIdentity.sshPrivateKey },
                    ...(setup.senderIdentity.repositoryPassword ? [{ purpose: 'backupDestination' as const,
                        configKey: 'destination' as const, role: 'repositoryPassword' as const, source: setup.senderIdentity.repositoryPassword }] : [])];
            }
            const current = environment.content.backup;
            const creationDefaults = !current || 'notNeeded' in current ? await host.resolveCreationDefaults(environment, {
                ...input.explicit, backupDestination: configuration.destinationRef,
                ...(configuration.retention ? { backupRetention: configuration.retention } : {}),
            }, context) : undefined;
            const review = creationDefaults ? { creationDefaults } : undefined;
            const selectedRetention = configuration.retention ?? (current && !('notNeeded' in current) ? current.retention
                : creationDefaults?.values.backupRetention);
            const candidateEnvironment = withBackupBindings(environment, bindings);
            const lease = await host.acquirePluginRuntimeRegistryLease();
            try {
                const descriptor = lease.registry.contributes.backupDestinations.find(entry =>
                    entry.identity.pluginId === configuration.destinationRef.pluginId && entry.identity.localId === configuration.destinationRef.localId);
                if (!descriptor) return failure('destination_changed');
                const occurrenceId = lease.registry.readPluginOccurrenceId(configuration.destinationRef.pluginId);
                if (!occurrenceId) return failure('destination_changed');
                const prepared = prepareDeploymentBackupConfigurationV1({ environmentId: input.environmentId,
                    configuration: { ...configuration, ...(selectedRetention ? { retention: selectedRetention } : {}) },
                    bindings: candidateEnvironment.content.bindings, destination: { ref: descriptor.identity,
                        occurrenceId, descriptor: descriptor.definition } });
                if (!prepared.ok) return failure(prepared.code);
                if (prepared.bindingState === 'needsBinding') return { kind: 'needsBinding', configuration: prepared.configuration,
                    missingRoles: prepared.missingRoles, ...settledSetup, ...(review ? { review } : {}) };
                const native = await host.executeNative({ environment: { ...candidateEnvironment, content: { ...candidateEnvironment.content,
                    bindings: candidateEnvironment.content.bindings.filter(isSettledEnvironmentSecretBindingV1) } }, configuration: prepared.configuration,
                    intent: input.intent, context }, lease.registry);
                const nativeReview = { ...review, ...(native.capacity ? { capacity: native.capacity } : {}) };
                if (input.intent === 'test' || native.test.kind !== 'reachable') return { kind: 'tested', test: native.test,
                    ...settledSetup, ...(Object.keys(nativeReview).length ? { review: nativeReview } : {}) };
                const saved = await host.saveBackup({ environment, backup: prepared.configuration, context });
                if (!saved.ok) return retainSetupFailure(input.intent === 'initializeAndSave' ? { ...saved, effectAttempted: true } : saved);
                let revision = saved.revision;
                if (bindings.length) {
                    const bound = host.saveBackupBindings ? await host.saveBackupBindings({ environmentId: saved.environmentId,
                        expectedRevision: revision, bindings, context }) : failure('source_unavailable');
                    if (!bound.ok) return retainSetupFailure({ ...bound, effectAttempted: true, details: {
                        ...(bound.details && typeof bound.details === 'object' && !Array.isArray(bound.details) ? bound.details : {}),
                        environmentId: saved.environmentId, revision, backupBindings: bindings } });
                    revision = bound.revision;
                }
                return { kind: 'configured', environmentId: saved.environmentId, revision,
                    configuration: prepared.configuration, ...settledSetup,
                    ...(Object.keys(nativeReview).length ? { review: nativeReview } : {}) };
            } finally { await lease.release(); }
        } catch (error) {
            const code = context.signal?.aborted ? 'cancelled' : error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code : 'deployment_content_unavailable';
            return retainSetupFailure(projectDeploymentFailure(code, error));
        }
    };
}
