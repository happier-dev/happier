import type { DeploymentBackupRestoreCaptureV1 } from '@happier-dev/deployment-protocol';
import { PluginError, BackupDestinationOpenV1ProtocolSchema, type BackupDestinationOpenV1, type BackupDestinationOpenInputV1 } from '@happier-dev/plugin-sdk';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { environmentSecretBindingIdentityV1, type DeploymentBackupConfigurationV1, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupRunInputV1, DeploymentRestoreDatabaseDestinationV1 } from '@happier-dev/deployments';
import { readSQLiteRuntimeAvailabilityV1 } from '@happier-dev/deployments';
import { readStoragePathCapacity } from '@/storage/pathCapacity';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createDeploymentBackupEnvironmentForHost, prepareDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { StoragePathCapacityV1 } from '@happier-dev/protocol/storage/storageV1';
import type { DeploymentBackupConfigurationNativeHost } from './backupConfigurationNative';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { assertDeploymentSecretInvocationCurrent } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { prepareEnvironmentSecretBindings } from '@/deployments/secrets/environmentSecretBindingService';


export type OwnServerDatabaseUsernameForHost = Readonly<{ username: string; secretValues: readonly string[] }>;

/** Database connection operands use the service's admitted runtime grant and
 * masking custody. They never enter the captured restore wire model. */
export function createOwnServerDatabaseUsernameReaderForHost(input: Readonly<{
    data: NonNullable<DeploymentEnvironmentContentV1['template']>['data'];
    preparation: Pick<Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0],
        'environmentId' | 'machineId' | 'installationId' | 'installationPrivateSeed' | 'bindings' | 'grants' | 'assertCurrent' | 'resolveNonSecret'>;
}>): (service: string) => Promise<OwnServerDatabaseUsernameForHost | undefined> {
    return async service => {
        const logical = input.data?.find(data => data.service === service)?.logicalBackup;
        if (logical?.adapter !== 'postgres-v1' || !logical.username) return undefined;
        const binding = input.preparation.bindings.find(binding => binding.purpose === 'variable'
            && binding.phase === 'runtime' && binding.name === logical.username);
        if (!binding || binding.purpose !== 'variable') throw new PluginError({
            code: 'secret_missing', message: 'The configured database username binding is unavailable' });
        const { environmentId, machineId, installationId, installationPrivateSeed, grants, assertCurrent, resolveNonSecret } = input.preparation;
        const prepared = await prepareEnvironmentSecretBindingsForLaunch({ environmentId, machineId, installationId,
            installationPrivateSeed, grants, assertCurrent, resolveNonSecret, phase: 'runtime', bindings: [binding] });
        try { return { username: prepared.env[binding.name]!, secretValues: [...prepared.secretValues] }; }
        finally { prepared.dispose(); }
    };
}

export type DeploymentBackupDestinationRegistryForHost = Pick<ResolvedExecutablePluginRuntimeRegistry,
    'targetActionInvocations' | 'activateContributionsOnDemand'> & Readonly<{
        contributes: Pick<ResolvedExecutablePluginRuntimeRegistry['contributes'], 'backupDestinations'>;
    }>;

const refuse = (code: 'backup_required' | 'stale_input' | 'unsupported_action', phase?: string): never => {
    throw new PluginError({ code, message: 'The configured backup destination is unavailable',
        ...(phase ? { failureCause: projectActionFailureCauseV1({ name: 'Error', code }, phase) } : {}) });
};

/** Open the captured destination through its ordinary installed Action. No
 * storage-provider parsing or credential value crosses this host seam. */
export async function openDeploymentBackupDestinationForHost(input: Readonly<{
    registry: DeploymentBackupDestinationRegistryForHost;
    configuration: DeploymentBackupConfigurationV1;
    context: ActionExecutorContext;
    signal: AbortSignal;
}>): Promise<BackupDestinationOpenV1> {
    input.signal.throwIfAborted();
    const { configuration, registry } = input;
    const ref = configuration.destinationRef;
    const descriptor = registry.contributes.backupDestinations.find(entry =>
        entry.identity.pluginId === ref.pluginId && entry.identity.localId === ref.localId);
    if (!descriptor) return refuse('backup_required', 'deployment.backup.destination.descriptor');
    const action = descriptor.definition.actions.open;
    await registry.activateContributionsOnDemand([{ ...action, family: 'actions' }]);
    const result = await registry.targetActionInvocations.invoke({ ...action,
        input: { config: configuration.config, credentialRoles: configuration.credentialBindings.map(binding => binding.role),
            ownershipPrefix: configuration.ownership.prefix } satisfies BackupDestinationOpenInputV1,
        surface: 'plugin', requiredReadOnly: true, signal: input.signal, approvalContext: input.context,
        // The repository URL is a native restic operand; output paths redact it.
        hostConsumesExecutedValue: true,
    });
    if (result.status !== 'executed') {
        const reason = result.status === 'deferred' ? 'approval_required' : result.code;
        const authoredCause = result.status === 'failed' ? readPluginActionFailureAuthorPayload(result.data).failureCause : undefined;
        throw new PluginError({ code: 'backup_required',
            message: 'The configured backup destination Action did not open', details: { reason },
            failureCause: authoredCause ?? projectActionFailureCauseV1({ name: 'Error', code: reason }, 'deployment.backup.destination.open') });
    }
    const opened = BackupDestinationOpenV1ProtocolSchema.safeParse(result.value);
    if (!opened.success) return refuse('unsupported_action');
    if (opened.data.credentialBindings.length !== configuration.credentialBindings.length
        || opened.data.credentialBindings.some(binding =>
            !configuration.credentialBindings.some(configured =>
                environmentSecretBindingIdentityV1(configured) === environmentSecretBindingIdentityV1(binding)))) return refuse('backup_required');
    return opened.data;
}

export type OwnServerPreMigrationBackupOperandsForHost = Awaited<ReturnType<typeof prepareDeploymentBackupEnvironmentForHost>> & Readonly<{
    configuration: DeploymentBackupConfigurationV1;
    data: NonNullable<DeploymentBackupRunInputV1['data']>;
    destination: Pick<DeploymentRestoreDatabaseDestinationV1, 'environmentId' | 'service' | 'adapter' | 'database'>;
}>;

type OwnServerBackupOperandsForHost = OwnServerBackupRepositoryOperandsForHost | OwnServerBackupRunOperandsForHost
    | OwnServerPreMigrationBackupOperandsForHost;
/** Operands that also borrow database custody, which their holder disposes. */
export function hasOwnServerBackupDataOperands(operands: OwnServerBackupOperandsForHost):
    operands is OwnServerBackupRunOperandsForHost | OwnServerPreMigrationBackupOperandsForHost {
    return 'data' in operands;
}
/** A configured backup run's operands, with each logical source's restore destination. */
export function isOwnServerBackupRunOperands(operands: OwnServerBackupOperandsForHost): operands is OwnServerBackupRunOperandsForHost {
    return 'destinations' in operands;
}
/** A pre-migration safety backup's operands, bound to the one database it protects. */
export function isOwnServerPreMigrationBackupOperands(operands: OwnServerBackupOperandsForHost):
    operands is OwnServerPreMigrationBackupOperandsForHost {
    return 'destination' in operands;
}

type BackupDestinationPreparation = Readonly<{
    registry: DeploymentBackupDestinationRegistryForHost;
    configuration: DeploymentEnvironmentContentV1['backup'];
    preparation: Omit<Parameters<typeof prepareDeploymentBackupEnvironmentForHost>[0]['preparation'], 'backupDestinationUses'>;
    context: ActionExecutorContext;
    signal: AbortSignal;
    isCurrent(): boolean;
}>;

async function captureBackupDestination(input: BackupDestinationPreparation) {
    const configuration = input.configuration;
    if (!configuration || 'notNeeded' in configuration) return refuse('backup_required');
    if (configuration.ownership.environmentId !== input.preparation.environmentId) return refuse('stale_input');
    const opened = await openDeploymentBackupDestinationForHost({ ...input, configuration });
    const uses = opened.credentialBindings.map(identity => {
        const row = input.preparation.bindings.find(binding =>
            environmentSecretBindingIdentityV1(binding) === environmentSecretBindingIdentityV1(identity));
        if (!row || row.purpose !== 'backupDestination') throw new PluginError({
            code: 'secret_missing', message: 'The configured destination binding is unavailable' });
        return row;
    });
    return { configuration, opened, preparation: { ...input.preparation, backupDestinationUses: uses } };
}

export type OwnServerBackupRepositoryOperandsForHost = ReturnType<typeof createDeploymentBackupEnvironmentForHost> & Readonly<{
    configuration: DeploymentBackupConfigurationV1;
}>;

/** Inventory, verify and retention need destination custody only, never a database binding. */
export async function prepareOwnServerBackupRepositoryOperandsForHost(input: BackupDestinationPreparation): Promise<OwnServerBackupRepositoryOperandsForHost> {
    const { configuration, opened, preparation } = await captureBackupDestination(input);
    return { ...createDeploymentBackupEnvironmentForHost({ ...opened, preparation,
        signal: input.signal, isCurrent: input.isCurrent }), configuration };
}

/** Invocation-only author custody for an unsaved destination. The binding owner
 * selects and seals its exact uses; these controller seals are never persisted. */
export function createPrepareDeploymentBackupConfigurationDestinationForHost(host: Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    authorCustody?: ReturnType<typeof resolveRequesterSavedSecretActionCustody>;
    /** The configure coordinator retains the same descriptor lease through save. */
    registry?: DeploymentBackupDestinationRegistryForHost;
    acquirePluginRuntimeRegistryLease?(): Promise<Readonly<{
        registry: DeploymentBackupDestinationRegistryForHost;
        release(): Promise<void> | void;
    }>>;
}>): DeploymentBackupConfigurationNativeHost['prepareDestination'] {
    return async input => {
        input.signal.throwIfAborted();
        const { operation } = host.authorCustody ?? resolveRequesterSavedSecretActionCustody({
            authorization: input.context.externalActionExecutionAuthorization,
            credentials: host.credentials, operationContext: host.savedSecretOperationContext,
        });
        if (input.environment.environment.controllerMachineId !== host.machineId) throw new PluginError({
            code: 'target_mismatch', message: 'Backup configuration belongs to its Environment controller' });
        await assertDeploymentSecretInvocationCurrent(input.context, input.signal);
        const identity = readInstallationIdentityIfExistsSync();
        if (!identity) throw new PluginError({ code: 'secret_missing', message: 'The controller installation is unavailable' });
        const privateSeed = decodeBase64(identity.privateKey, 'base64url').slice(0, 32);
        const controller = new AbortController();
        const signal = controller.signal;
        const onAbort = () => controller.abort(input.signal.reason);
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) onAbort();
        let lease: Awaited<ReturnType<NonNullable<typeof host.acquirePluginRuntimeRegistryLease>>> | undefined;
        let releasing: Promise<void> | undefined;
        const release = () => releasing ??= (async () => {
            controller.abort();
            input.signal.removeEventListener('abort', onAbort);
            privateSeed.fill(0);
            await lease?.release();
        })();
        const assertCurrent = async () => { signal.throwIfAborted(); };
        try {
            const registry = host.registry ?? (lease = await host.acquirePluginRuntimeRegistryLease?.())?.registry;
            if (!registry) return refuse('backup_required');
            const captured = await captureBackupDestination({ registry, configuration: input.configuration,
                context: input.context, signal, isCurrent: () => !signal.aborted,
                preparation: { environmentId: input.environment.environment.id, machineId: host.machineId,
                    installationId: identity.installationId, installationPrivateSeed: privateSeed,
                    bindings: input.environment.content.bindings, grants: [], assertCurrent } });
            // Configure executes on the controller; local repository capacity
            // belongs to the linked runtime Machine's Storage owner.
            let capacity: StoragePathCapacityV1 | undefined;
            if (captured.opened.local) {
                const { selectDeploymentRuntimeTargetLinkV1, selectDeploymentSingleDataMachineV1 } = await import('@happier-dev/deployments');
                const runtimeMachine = selectDeploymentSingleDataMachineV1(selectDeploymentRuntimeTargetLinkV1({
                    environment: input.environment.environment,
                    targetLinks: input.environment.targetLinks.map(targetLink => ({ targetLink })),
                }));
                capacity = runtimeMachine?.machineId === host.machineId && runtimeMachine.installationId === identity.installationId
                    ? await readStoragePathCapacity(captured.opened.local.path, { readVolumes: () => [] })
                    : { status: 'unknown', path: captured.opened.local.path,
                        reason: input.environment.environment.runtimeTargetLinkId ? 'runtime_capacity_unavailable' : 'runtime_machine_not_linked' };
            }
            const prepared = await prepareEnvironmentSecretBindings({ environmentId: input.environment.environment.id,
                bindings: captured.preparation.backupDestinationUses, previousBindings: [], existingGrants: [],
                runtimeInstallations: [{ machineId: host.machineId, installationId: identity.installationId,
                    publicKey: decodeBase64(identity.publicKey, 'base64url') }], assertCurrent,
                materializer: async () => {
                    if (!operation) throw new PluginError({ code: 'client_required', message: 'Backup credential author custody is unavailable' });
                    const snapshot = operation.readSnapshot();
                    if (!snapshot?.scopeKey) throw new PluginError({ code: 'client_required', message: 'Backup credential author custody is unavailable' });
                    return (await readSavedSecretMaterializerForOperation({ expectedScopeKey: snapshot.scopeKey,
                        operationContext: operation, signal, references: captured.preparation.backupDestinationUses.flatMap(binding =>
                            binding.source.kind === 'secret' ? [{ ref: binding.source.ref, revision: binding.source.resourceRevision }] : []) })).materializer;
                } });
            return { ...createDeploymentBackupEnvironmentForHost({ ...captured.opened, signal,
                isCurrent: () => !signal.aborted, preparation: { ...captured.preparation, grants: prepared.grants } }), release,
                ...(capacity ? { capacity } : {}) };
        } catch (error) { await release(); throw error; }
    };
}

export type OwnServerBackupRunOperandsForHost = Awaited<ReturnType<typeof prepareDeploymentBackupEnvironmentForHost>> & Readonly<{
    configuration: DeploymentBackupConfigurationV1;
    data: NonNullable<DeploymentBackupRunInputV1['data']>;
    destinations: readonly (DeploymentBackupRestoreCaptureV1['target'] & Readonly<{ environmentId: string }>)[];
}>;

/** Resolve each configured logical source from the captured template once. P42
 * resolves the selected variable bindings together under the same custody. */
export async function prepareOwnServerBackupRunOperandsForHost(input: BackupDestinationPreparation & Readonly<{
    data: NonNullable<DeploymentEnvironmentContentV1['template']>['data'];
}>): Promise<OwnServerBackupRepositoryOperandsForHost | OwnServerBackupRunOperandsForHost> {
    const configuration = input.configuration;
    if (!configuration || 'notNeeded' in configuration) return refuse('backup_required');
    const dumps = configuration.sources.filter(source => source.kind === 'dump');
    if (!dumps.length) return prepareOwnServerBackupRepositoryOperandsForHost(input);
    const selected = dumps.map(source => {
        const data = input.data?.find(row => row.service === source.service);
        if (!data?.logicalBackup || data.logicalBackup.adapter !== 'postgres-v1' && data.logicalBackup.adapter !== 'sqlite-v1')
            return refuse('unsupported_action');
        if (data.logicalBackup.adapter === 'sqlite-v1') {
            if (!data.logicalBackup.path) return refuse('unsupported_action');
            const availability = readSQLiteRuntimeAvailabilityV1();
            if (!availability.ok) throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: availability.code, error: availability.message }), { cause: {
                ok: false, errorCode: availability.code, error: availability.message, effectAttempted: false,
                details: { reason: availability.reason, remedy: availability.remedy },
            } });
            return { data, path: data.logicalBackup.path };
        }
        const databaseKey = data.logicalBackup.database;
        const binding = input.preparation.bindings.find(binding => binding.purpose === 'variable'
            && binding.phase === 'runtime' && binding.name === databaseKey);
        if (!binding || binding.purpose !== 'variable') throw new PluginError({ code: 'secret_missing',
            message: 'The configured database binding is unavailable' });
        return { data, binding };
    });
    const { opened, preparation } = await captureBackupDestination(input);
    const databaseBindings = [...new Map(selected.flatMap(row => row.binding ? [[row.binding.name, row.binding] as const] : [])).values()];
    const prepared = await prepareDeploymentBackupEnvironmentForHost({ ...opened, databaseBindings,
        signal: input.signal, isCurrent: input.isCurrent, preparation });
    return { ...prepared, configuration, data: selected.map(row => row.data), destinations: selected.map(row => ({
        environmentId: input.preparation.environmentId, service: row.data.service,
        ...(row.path ? { adapter: 'sqlite-v1' as const, path: row.path }
            : { adapter: 'postgres-v1' as const, database: prepared.databases.get(row.binding!.name)! }),
    })) };
}

/** P41's current PostgreSQL migration receipt consumes the same selected-source
 * resolution; it does not open or resolve a second destination. */
export async function prepareOwnServerPreMigrationBackupOperandsForHost(input: BackupDestinationPreparation & Readonly<{
    data: NonNullable<DeploymentEnvironmentContentV1['template']>['data'];
}>): Promise<OwnServerPreMigrationBackupOperandsForHost> {
    const prepared = await prepareOwnServerBackupRunOperandsForHost(input);
    try {
        if (!('destinations' in prepared)) return refuse('unsupported_action');
        const source = prepared.configuration.sources.find(source => source.kind === 'dump');
        const destination = prepared.destinations.find(target => target.service === source?.service);
        if (!destination || destination.adapter !== 'postgres-v1') return refuse('unsupported_action');
        return { ...prepared, destination };
    } catch (error) { if ('dispose' in prepared) await prepared.dispose(); throw error; }
}

/** The public database field remains literal. SQLite's declared service path is
 * the native operand; neither callers nor source ids choose another file. */
export function resolveOwnServerDatabaseRestoreTargetForHost(data: NonNullable<DeploymentEnvironmentContentV1['template']>['data'],
    selected: Readonly<{ service: string; database: string }>): Extract<DeploymentBackupRestoreCaptureV1['target'], { adapter: 'postgres-v1' | 'sqlite-v1' }> {
    const logical = data?.find(row => row.service === selected.service)?.logicalBackup;
    if (logical?.adapter === 'sqlite-v1') {
        if (!logical.path || selected.database !== logical.path) return refuse('stale_input');
        return { adapter: 'sqlite-v1', service: selected.service, path: logical.path };
    }
    if (logical?.adapter !== 'postgres-v1') return refuse('unsupported_action');
    return { adapter: 'postgres-v1', service: selected.service, database: selected.database };
}
