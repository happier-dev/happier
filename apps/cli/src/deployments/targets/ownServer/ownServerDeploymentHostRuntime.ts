import { join } from 'node:path';
import { nativeCaddyProfile, createNativeCaddySetupInput, createNativeCaddyBindings,
    createCaddyContainerSetupSteps, ensureNativeCaddyContainer, type NativeCaddyFirewallExposure } from '@happier-dev/cli-common/machineSetup';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { runElevatedMachineSetupIntent, resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentOwnServerContentV1, DeploymentEnvironmentDetailV1, DeploymentReceiptHeaderV1, DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol';
import { decodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { readDeploymentSourceIntentForHost } from '@/deployments/readDeploymentSourceIntentForHost';
import { readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { readEnvironmentSecretLaunchAdmissionForHost } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import type { OwnServerDeploymentMaterialization, OwnServerDeploymentRuntime, OwnServerDeploymentRuntimeAcquisition, OwnServerDeploymentRuntimeRequest } from './ownServerDeploymentTarget';
import { resolveDeploymentSourcePathForHost } from './exactCommitRelease';
import { resolveOwnServerDeploymentIdentityForHost, resolveOwnServerDeploymentRootForHost } from './paths';
import { resolveOwnServerImageArchivePathForHost } from './releaseProvenance';
import { createDeploymentImageArchiveCopyForHost } from './imageArchiveCopy';
import { createOwnServerNativeRuntime } from './nativeRuntime';
import { resolvePrivateServiceReferenceForHost } from './privateServiceReference';
import { prepareOwnServerPreMigrationBackupOperandsForHost } from './backupDestination';
import { materializeCaddyInitialConfigV1 } from './caddyRouteMaterialization';
export { openDeploymentBackupDestinationForHost, prepareOwnServerPreMigrationBackupOperandsForHost } from './backupDestination';

type LaunchInput = Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0];
export type OwnServerSecretLaunchAdmissionRequest = Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    installationId: string;
    environmentId: string;
    materialization: OwnServerDeploymentMaterialization;
    /** Restoration consumes the current receipt's original accepted generation. */
    actionOperationId?: string;
    targetLinkId: string;
    context: ActionExecutorContext;
    signal: AbortSignal;
}>;
export type OwnServerSecretLaunchAdmission = Readonly<{
    grants: LaunchInput['grants'];
    assertCurrent(): Promise<void>;
    release?(): void | Promise<void>;
}>;
export type OwnServerDeploymentRuntimeHostInput = Readonly<{
    credentials: StoredCredentials;
    resolveRequesterIdentity: import('@/deployments/readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    /** Installed daemon profile identity; never inferred from the stable Server id. */
    credentialProfileId?: string;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    acquirePluginRuntimeRegistryLease(): Promise<PluginRuntimeRegistryLease>;
    /** Current installed credential generation, independently of requester content custody. */
    assertInstalledCurrent?(): Promise<void>;
    /** P42's authenticated storage reader. Never an actor catalog or value supplier. */
    readEnvironmentSecretLaunchAdmission?: (input: OwnServerSecretLaunchAdmissionRequest) => Promise<OwnServerSecretLaunchAdmission>;
    signal?: AbortSignal;
}>;

const refuse = (code: string, details?: unknown): never => {
    throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
};

/** Installed host composition; the registry lends its one existing service owner. */
export function createOwnServerDeploymentRuntimeForHost(host: OwnServerDeploymentRuntimeHostInput): OwnServerDeploymentRuntime {
    const readSecretAdmission = host.readEnvironmentSecretLaunchAdmission ?? readEnvironmentSecretLaunchAdmissionForHost;
    async function acquire(request: Pick<OwnServerDeploymentRuntimeRequest, 'actionId' | 'context' | 'executionRole'> & Readonly<{
        input: Pick<OwnServerDeploymentRuntimeRequest['input'], 'serverId' | 'environmentId' | 'targetLinkId'>;
    }> & (Pick<OwnServerDeploymentRuntimeRequest, 'materialization'> | Readonly<{
        sourceIntent?: DeploymentSourceIntentV1;
        sha?: string;
        stageContent(sourceIntent: DeploymentSourceIntentV1): Promise<string>;
    }>), snapshot: Readonly<{ environment: DeploymentEnvironmentDetailV1; content?: DeploymentOwnServerContentV1;
        deployment?: DeploymentReceiptHeaderV1;
        readReferenceEnvironment?: import('./ownServerDeploymentTarget').OwnServerDeploymentTargetHostInput['readEnvironment'] }>) {
            const { environment, content } = snapshot;
            const hostSignal = host.signal ?? new AbortController().signal;
            const signal = request.context.signal ? AbortSignal.any([hostSignal, request.context.signal]) : hostSignal;
            signal.throwIfAborted();
            if (request.input.serverId !== host.serverId || request.input.environmentId !== environment.environment.id) return refuse('target_mismatch');
            const identity = readInstallationIdentityIfExistsSync();
            const link = environment.targetLinks.find(item => item.targetLink.id === request.input.targetLinkId)?.targetLink;
            const build = request.executionRole === 'build';
            const requestedMaterialization = 'materialization' in request ? request.materialization : undefined;
            const preparation = !requestedMaterialization || requestedMaterialization.kind === 'review';
            const accepted = snapshot.deployment?.acceptedExecution;
            if (!identity || !link || (build ? (preparation ? environment.environment.buildMachineId !== host.machineId
                : accepted?.builder?.machineId !== host.machineId || accepted.builder.installationId !== identity.installationId)
                || content !== undefined && content.buildMachineId !== host.machineId
                : !link.members.some(member => member.machineId === host.machineId
                    && member.installationId === identity.installationId))) return refuse('target_mismatch');

            const assertAuthority = async () => {
                signal.throwIfAborted();
                await host.assertInstalledCurrent?.();
                const authorization = request.context.externalActionExecutionAuthorization;
                if (authorization && (!authorization.requesterAccountProjection || !authorization.requesterHttpProjection)) return refuse('action_forbidden');
                signal.throwIfAborted();
            };
            const capturedSource = await readDeploymentSourceIntentForHost({ host: { ...host, signal, assertAuthority },
                request: { environment, context: request.context, actionId: request.actionId,
                    ...(content ? { sourceIntent: content.sourceIntent } : 'sourceIntent' in request && request.sourceIntent
                        ? { sourceIntent: request.sourceIntent } : {}),
                    ...('sha' in request && request.sha ? { sha: request.sha } : {}),
                    ...('materialization' in request && request.materialization.kind === 'restoration' ? { restoration: true } : {}) } });
            const { sourceIntent: intent, workspace, sourceRepository } = capturedSource;
            // Persist the actual resolved source intent before P42 re-admits
            // this exact candidate Artifact. Discovery later updates that head.
            const materialization = 'stageContent' in request
                ? { kind: 'review' as const, contentArtifactId: await request.stageContent(intent) }
                : request.materialization;
            const materializationId = materialization.kind === 'review' ? materialization.contentArtifactId
                : materialization.kind === 'restoration' ? materialization.sourceDeploymentId : materialization.deploymentId;
            const restorationForDeploymentId = materialization.kind === 'restoration' ? materialization.deploymentId : undefined;
            const admission = await readSecretAdmission({ credentials: host.credentials,
                serverId: host.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId,
                installationId: identity.installationId, environmentId: environment.environment.id,
                materialization: materialization.kind === 'restoration' ? { kind: 'deployment',
                    deploymentId: materialization.deploymentId } : materialization,
                ...(materialization.kind === 'restoration' ? { actionOperationId: snapshot.deployment?.actionOperationId } : {}),
                targetLinkId: request.input.targetLinkId, context: request.context, signal });
            let lease: PluginRuntimeRegistryLease | undefined;
            let buildExecutionDirectory: string | undefined;
            let registryConfigDirectory: string | undefined;
            const removeRegistryConfigDirectory = async () => {
                if (!registryConfigDirectory) return;
                await rm(registryConfigDirectory, { recursive: true, force: true });
                registryConfigDirectory = undefined;
            };
            const privateSeed = decodeBase64(identity.privateKey, 'base64url').slice(0, 32);
            try {
                lease = await host.acquirePluginRuntimeRegistryLease();
                let released = false;
                const assertSourceCurrent = async () => {
                    if (released) return refuse('deployment_source_unavailable');
                    // Source selection and its workspace were admitted above.
                    // Retained native work keeps local custody; a new phase
                    // resolves the current Source through acquisition again.
                    await assertAuthority();
                };
                const assertCurrent = assertSourceCurrent;
                await assertCurrent();
                const { deploymentRoot, environmentInstanceId, homeServerIdentityId } = await resolveOwnServerDeploymentIdentityForHost({
                    happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: environment.environment.id });
                const releasePath = resolveDeploymentSourcePathForHost({ deploymentRoot,
                    environmentInstanceId, deploymentId: materializationId,
                    ...(build ? { materializationRole: 'build' } : {}),
                    ...(restorationForDeploymentId === undefined ? {} : { restorationForDeploymentId }) });
                if (build) {
                    const buildRoot = join(configuration.happyHomeDir, 'tmp', 'deployment-build');
                    await mkdir(buildRoot, { recursive: true, mode: 0o700 });
                    buildExecutionDirectory = await mkdtemp(join(buildRoot, 'native-'));
                }
                const registryRoot = join(configuration.happyHomeDir, 'tmp', 'deployment-registry');
                await mkdir(registryRoot, { recursive: true, mode: 0o700 });
                registryConfigDirectory = await mkdtemp(join(registryRoot, 'native-'));
                const { exec, nativeIo, settleNative } = createOwnServerNativeRuntime({ cwd: releasePath,
                    ...(buildExecutionDirectory ? { buildExecutionDirectory } : {}), signal, nativeIoSignal: hostSignal,
                    isCurrent: () => !released });
                const retainedLease = lease;
                const selectedArchives = structuredClone(content?.ownServer?.imageArchives ?? []);
                const environmentName = environment.content.name;
                const commitSha = intent.kind === 'repository' ? intent.sha : undefined;
                const secrets: OwnServerDeploymentRuntimeAcquisition['secrets'] = {
                    installationPrivateSeed: privateSeed, grants: admission.grants,
                    registryConfigBaseDir: registryConfigDirectory,
                    async resolveNonSecret(source) {
                        // These primitives belong to the already admitted acquisition.
                        if (source.kind === 'deploymentFact') {
                            if (source.fact === 'environmentName') return environmentName;
                            if (source.fact === 'commitSha' && commitSha !== undefined) return commitSha;
                            if (source.fact === 'deploymentId' && materialization.kind !== 'review') return materializationId;
                        }
                        if (source.kind === 'reference') return resolvePrivateServiceReferenceForHost({
                            source, environment, homeServerIdentityId, readEnvironment: snapshot.readReferenceEnvironment,
                            host, context: request.context, actionId: request.actionId, signal,
                            owner: retainedLease.registry.projectManagedServices,
                            installationId: identity.installationId, privateKey: decodeBase64(identity.privateKey, 'base64url'),
                        });
                        return refuse('reference_unavailable');
                    },
                };
                return { exec, nativeIo, projectManagedServices: retainedLease.registry.projectManagedServices,
                    currentDomainEdgeObservation: retainedLease.registry.currentDomainEdgeObservation, sourceIntent: intent,
                    ...(buildExecutionDirectory === undefined ? {} : { buildExecutionDirectory }),
                    source: { environmentId: environment.environment.id, environmentInstanceId,
                        deploymentId: materializationId, machineId: host.machineId, installationId: identity.installationId,
                        ...(build ? { materializationRole: 'build' as const } : {}),
                        ...(restorationForDeploymentId === undefined ? {} : { restorationForDeploymentId }),
                        ...(intent.kind === 'stored' ? { definition: intent } : { sourcePath: workspace!.rootPath, commitSha: intent.sha,
                            ...(intent.pullRequestHead ? { pullRequestHead: intent.pullRequestHead, repository: sourceRepository } : {}) }), deploymentRoot,
                        artifactDirectory: join(configuration.happyHomeDir, 'tmp', 'deployment-source') },
                    secrets,
                    async preparePreMigrationBackupOperands() {
                        return prepareOwnServerPreMigrationBackupOperandsForHost({ registry: retainedLease.registry,
                            configuration: environment.content.backup, data: environment.content.template?.data,
                            preparation: { ...secrets, environmentId: environment.environment.id, machineId: host.machineId,
                                installationId: identity.installationId, bindings: environment.content.bindings, assertCurrent },
                            context: request.context, signal, isCurrent: () => !released });
                    },
                    assertCurrent, assertSourceCurrent, settleNative,
                    async copyDeploymentImageArchive(copy: Parameters<NonNullable<OwnServerDeploymentRuntimeAcquisition['copyDeploymentImageArchive']>>[0]) {
                        const archive = selectedArchives.find(candidate => isDeepStrictEqual(candidate, copy.archive));
                        if (!archive || !host.credentialProfileId) throw new PluginError({ code: 'filesystem_transfer_custody_required',
                            message: 'The selected receipt and installed credential profile are required for image transfer' });
                        const copySignal = AbortSignal.any([signal, copy.signal]);
                        const assertCopyCurrent = async () => {
                            copySignal.throwIfAborted();
                            await assertCurrent();
                            await copy.assertCurrent();
                            copySignal.throwIfAborted();
                        };
                        await assertCopyCurrent();
                        const destination = resolveOwnServerImageArchivePathForHost({ deploymentRoot,
                            environmentInstanceId, deploymentId: materializationId,
                            ...(restorationForDeploymentId === undefined ? {} : { restorationForDeploymentId }) }, archive.sha256);
                        return await createDeploymentImageArchiveCopyForHost({ credentials: host.credentials,
                            deploymentRoot,
                            credentialProfileId: host.credentialProfileId, serverId: homeServerIdentityId,
                            serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId, installationId: identity.installationId })({
                            archive, destination, context: request.context, signal: copySignal, assertCurrent: assertCopyCurrent });
                    },
                    async release() {
                        if (released) return;
                        released = true;
                        // Detached observations keep this canonical IO capture. Its
                        // later controls carry their own signals/admission; ending
                        // this finite caller must not close their generation IO.
                        const processCustody = readPluginExecProcessCustodyForHost(exec);
                        try { await settleNative(); await processCustody.requestStop(); }
                        finally {
                            privateSeed.fill(0);
                            // Follow the incumbent launch-lease settlement
                            // contract without holding an incomplete-stop
                            // response open or deleting another acquisition.
                            try {
                                const cleanupRegistry = processCustody.waitForSettlement().then(removeRegistryConfigDirectory);
                                if (processCustody.hasUnsettledProcesses()) void cleanupRegistry.catch(() => {
                                    logger.infoFile('[Deployment] Private registry cleanup failed', { code: 'registry_config_cleanup_failed' });
                                });
                                else await cleanupRegistry;
                            } finally {
                                try { if (buildExecutionDirectory) await rm(buildExecutionDirectory, { recursive: true, force: true }); }
                                finally { try { await admission.release?.(); } finally { await retainedLease.release(); } }
                            }
                        }
                    },
                };
            } catch (error) {
                privateSeed.fill(0);
                try { await removeRegistryConfigDirectory(); }
                finally {
                    try { if (buildExecutionDirectory) await rm(buildExecutionDirectory, { recursive: true, force: true }); }
                    finally { try { await admission.release?.(); } finally { await lease?.release(); } }
                }
                throw error;
            }
    }
    return {
        prepareDomainCaddy(request) {
            const routedNetworks = [...new Set(request.replicas.flatMap(replica => [...replica.networkNames]))];
            if (!request.replicas.length || !routedNetworks.length) return { status: 'unavailable', reason: 'required_fact_unavailable' };
            // Workload exports select the private network, never Caddy's port.
            // No export is required for an unpublished container-network app.
            const networks = [...new Set((request.environment.ownServer?.serviceExports ?? []).filter(item =>
                item.service === request.domain.target.service && item.containerPort === request.domain.target.containerPort
                && item.exposure === 'privateNetwork').map(item => item.privateNetwork!))];
            if (networks.length > 1) return { status: 'unavailable', reason: 'private_scope_unenforceable' };
            const exposures: NativeCaddyFirewallExposure[] = [];
            const candidates = request.privateNetworks.filter(network => network.state === 'ready'
                && network.interfaceName && network.networkIdentity && (!networks.length || network.networkIdentity === networks[0]));
            if (candidates.length > 1) return { status: 'unavailable', reason: 'private_scope_unenforceable' };
            if (candidates.length) {
                const network = candidates[0]!;
                if (!network.addresses.length) return { status: 'unavailable', reason: 'required_fact_unavailable' };
                const requirement = nativeCaddyProfile.portRequirement;
                exposures.push({ requirementId: requirement.id, exposure: requirement.exposure, protocol: requirement.protocol,
                    hostPort: requirement.hostPort, containerPort: requirement.containerPort,
                    hostAddress: network.addresses[0]!, networkIdentity: network.networkIdentity!,
                    providerId: 'kind' in network.provider ? network.provider.id : buildQualifiedPluginContributionKey(network.provider) });
            }
            const bindings = createNativeCaddyBindings({ originPort: nativeCaddyProfile.portRequirement.containerPort,
                exposures, privateNetworks: request.privateNetworks });
            if (bindings.status !== 'ready') return bindings;
            const input = createNativeCaddySetupInput({ daemonGroup: request.daemonGroup, daemonGroupId: request.daemonGroupId,
                routedNetworks, initialConfig: JSON.stringify(materializeCaddyInitialConfigV1({
                    adminSocket: '/run/happier-caddy/admin.sock', originListen: [`:${nativeCaddyProfile.portRequirement.containerPort}`],
                })), bindings: { privateBinding: bindings.privateBinding, publicBindings: bindings.publicBindings } });
            const steps = createCaddyContainerSetupSteps(input);
            return { status: 'ready', input, steps,
                async ensure({ setup, context, actionId, installationId, dockerEngineId, run, signal }) {
                    const operationId = context.operationAcceptance?.operationId ?? context.actionRequestId;
                    if (!operationId) return refuse('operation_unavailable');
                    const desired = await setup.readDesired();
                    if (desired.status !== 'ready') return refuse('required_fact_unavailable');
                    const basis = { kind: 'setup' as const, machineId: host.machineId, desiredRevision: desired.policy.revision };
                    const elevation = { ...setup.elevation, installationId, installedCli: resolveInstalledMachineEffectCli() };
                    return machineNativeEffectAdmission.run({ operation: { operationId, kind: actionId, signal },
                        keys: [{ kind: 'machineSetup' }, { kind: 'dockerEngine', dockerEndpoint: dockerEngineId }] }, async native => {
                        let applied: import('@happier-dev/cli-common/machineSetup').MachineSetupApplyResultV1 | undefined;
                        const elevated = await machineNativeEffectAdmission.runStage(native, () => runElevatedMachineSetupIntent({
                            machineId: host.machineId, operationId, signal, basis, steps,
                            onSetupApplied(result) { applied = result; },
                        }, { ...elevation, verifyCurrent: async () => !signal.aborted }));
                        if (elevated.outcome !== 'applied') return refuse('reasonCode' in elevated ? elevated.reasonCode : elevated.outcome, {
                            ...('recovery' in elevated && elevated.recovery ? { recovery: elevated.recovery } : {}),
                            ...('failure' in elevated && elevated.failure ? { failure: elevated.failure,
                                remedy: elevated.outcome === 'outcome_unknown'
                                    ? 'Inspect and reconcile Caddy setup on this Machine before retrying the Domain action.'
                                    : 'Check Caddy setup prerequisites on this Machine, including parent directories and the configured owner/group, then retry the Domain action.',
                            } : {}),
                        });
                        if (!applied) return refuse('outcome_unknown');
                        if (input.privateBinding && !setup.settleCaddyFirewall) return refuse('private_scope_unenforceable');
                        const setupResult = applied;
                        return machineNativeEffectAdmission.runStage(native, () => ensureNativeCaddyContainer(input, { run, signal, setupResult,
                            settleBindings: async () => {
                                if (input.privateBinding) await setup.settleCaddyFirewall!({ machineId: host.machineId, installationId,
                                    operationId, basis, caddy: input, native, elevation, signal });
                            } }));
                    });
                } };

        },
        acquire,
        async acquireRetention(input, recheck) {
            const identity = readInstallationIdentityIfExistsSync();
            if (!identity || input.machineId !== host.machineId || input.installationId !== identity.installationId
                || input.request.input.serverId !== host.serverId) return refuse('target_mismatch');
            const context = input.request.context;
            const signal = context.signal && host.signal ? AbortSignal.any([context.signal, host.signal])
                : context.signal ?? host.signal ?? new AbortController().signal;
            let released = false;
            const assertCurrent = async () => {
                signal.throwIfAborted();
                if (released) return refuse('deployment_source_unavailable');
                await host.assertInstalledCurrent?.();
                const authorization = context.externalActionExecutionAuthorization;
                if (authorization && (!authorization.requesterAccountProjection || !authorization.requesterHttpProjection)) return refuse('action_forbidden');
                if (!authorization && (context.externalActionCredential || context.rpcSessionAuthorization)) return refuse('action_forbidden');
                await recheck();
                signal.throwIfAborted();
            };
            await assertCurrent();
            const deploymentRoot = await resolveOwnServerDeploymentRootForHost(configuration.happyHomeDir, host.serverId);
            const native = createOwnServerNativeRuntime({ cwd: deploymentRoot, signal, isCurrent: () => !released });
            return { ...native, deploymentRoot, assertCurrent, async release() {
                if (released) return;
                released = true;
                try { await native.settleNative(); }
                finally { await readPluginExecProcessCustodyForHost(native.exec).requestStop(); }
            } };
        },
        acquireCandidate(request, environment) {
            return acquire({ actionId: 'deployments.deploy', context: request.context, executionRole: 'build',
                input: { serverId: host.serverId, environmentId: request.environmentId, targetLinkId: request.targetLinkId },
                ...(request.sourceIntent ? { sourceIntent: request.sourceIntent } : {}),
                ...(request.sha ? { sha: request.sha } : {}),
                stageContent: request.stageContent }, { environment, readReferenceEnvironment: request.readReferenceEnvironment });
        },
    };
}
