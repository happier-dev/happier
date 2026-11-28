import { createActionExecuteFailureError, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DEPLOYMENT_COLLECTOR_PRIVATE_BINDING_FAILURE_PHASE_V1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { refuseDeploymentAuthorization } from '@/deployments/deploymentAuthorizationFailure';
import { join } from 'node:path';
import { nativeCaddyProfile, createNativeCaddySetupInput, createNativeCaddyBindings,
    createCaddyContainerSetupSteps, ensureNativeCaddyContainer, type NativeCaddyFirewallExposure } from '@happier-dev/cli-common/machineSetup';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { machineNativeEffectAdmission, type MachineNativeEffectKey } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { runElevatedMachineSetupIntent } from '@/machines/adminAccess/runElevatedEffect';
import { resolveMachineEffectCli } from '@/machines/adminAccess/machineEffectCli';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { isDeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentOwnServerContentV1, DeploymentEnvironmentDetailV1, DeploymentReceiptHeaderV1, DeploymentSourceIntentV1 } from '@happier-dev/deployments/contracts/v1';
import type { EnvironmentSecretLaunchAdmissionBodyV1 } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { decodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { readDeploymentSourceIntentForHost } from '@/deployments/readDeploymentSourceIntentForHost';
import { captureRetainedDeploymentFolderForHost } from '@/deployments/captureDeploymentFolderSourceForHost';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createDeploymentLogicalBackupSourceChoicesV1, createDeploymentVolumeBackupSourceIdV1 } from '@happier-dev/deployments';
import { readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveEnvironmentDeploymentFactForHost } from '@/deployments/secrets/deploymentFacts';
import { preparePreviewDomainFactForHost } from '@/deployments/previewDomainForHost';
import type { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { readEnvironmentSecretLaunchAdmissionForHost } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import type { OwnServerDeploymentMaterialization, OwnServerDeploymentRuntime, OwnServerDeploymentRuntimeAcquisition, OwnServerDeploymentRuntimeRequest } from './ownServerDeploymentTarget';
import { resolveDeploymentSourcePathForHost, createDeploymentSourceMaterializationPort,
    selectDeploymentSourceMaterializationForHost } from './exactCommitRelease';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { resolveOwnServerDeploymentIdentityForHost, resolveOwnServerDeploymentRootForHost } from './paths';
import { resolveOwnServerImageArchivePathForHost } from './releaseProvenance';
import { createDeploymentImageArchiveCopyForHost } from './imageArchiveCopy';
import { createOwnServerNativeRuntime } from './nativeRuntime';
import { acquirePrivateServiceReferenceForwardForHost, resolvePrivateServiceReferenceMaterialForHost } from './privateServiceReference';
import { createServiceReferenceForwardCustody, releaseRemovedServiceReferenceForwards } from './serviceReferenceForwardCustody';
import { createOwnServerTelemetryRelayForward, ownServerTelemetryRelayKey } from './localTelemetryRelay';
import { acquirePrivateServiceContainerBridge, PrivateServiceContainerBridgeUnavailableError } from './privateServiceContainerBridge';
import { resolvePrivateServiceLocalContainerAddress } from './privateServiceLocalNetwork';
import type { ServiceExportMachineForward } from '@/daemon/peer/iroh/serviceExportMachineForward';
import { privateServiceForwardAcquisitionError, projectDeploymentFailure } from '../../deploymentFailure';
import { openDeploymentBackupDestinationForHost, prepareOwnServerPreMigrationBackupOperandsForHost, prepareOwnServerBackupRunOperandsForHost, prepareOwnServerBackupRepositoryOperandsForHost } from './backupDestination';
import { materializeCaddyInitialConfigV1 } from './caddyRouteMaterialization';
import { enrollOwnServerAppServices } from './appEnrollment';
export { openDeploymentBackupDestinationForHost, prepareOwnServerPreMigrationBackupOperandsForHost, prepareOwnServerBackupRunOperandsForHost } from './backupDestination';

type LaunchInput = Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0];
export type OwnServerSecretLaunchAdmissionRequest = Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    installationId: string;
    environmentId: string;
    materialization: OwnServerDeploymentMaterialization
        | Extract<EnvironmentSecretLaunchAdmissionBodyV1['materialization'], { kind: 'copySourceRead' }>;
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
    ensureServiceObservations?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
    acquireServiceExportForward?: (input: Readonly<{
        targetMachineId: string;
        serviceExport: import('@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1').TcpTunnelServiceExportBindingV1;
        context: ActionExecutorContext;
        signal: AbortSignal;
        preferredListenPort?: number;
        onFailure?(error: import('@/daemon/peer/iroh/machineCarrier').MachineCarrierError): void;
        onRecovered?(): void;
    }>) => Promise<import('@/daemon/peer/iroh/serviceExportMachineForward').ServiceExportMachineForward>;
    acquirePluginRuntimeRegistryLease(): Promise<PluginRuntimeRegistryLease>;
    /** Admitted installed-holder lifetime, independently of requester content custody. */
    assertInstalledCurrent?(): Promise<void>;
    /** P42's authenticated storage reader. Never an actor catalog or value supplier. */
    readEnvironmentSecretLaunchAdmission?: (input: OwnServerSecretLaunchAdmissionRequest) => Promise<OwnServerSecretLaunchAdmission>;
    signal?: AbortSignal;
}>;

const refuse = (code: string, details?: unknown, failureCause?: ActionFailureCauseV1): never => {
    throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code,
        ...(details === undefined ? {} : { details }), ...(failureCause === undefined ? {} : { failureCause }) });
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
        retainedSourceIntent?: DeploymentOwnServerContentV1['sourceIntent'] | null;
        retainedFolderSource?: Readonly<{ environmentId: string; sources: NonNullable<NonNullable<DeploymentOwnServerContentV1['ownServer']>['sources']> }>;
        deployment?: DeploymentReceiptHeaderV1;
        readReferenceEnvironment?: import('./ownServerDeploymentTarget').OwnServerDeploymentTargetHostInput['readEnvironment'];
        readTelemetryCollectorDomain?: import('./ownServerDeploymentTarget').OwnServerDeploymentTargetHostInput['readTelemetryCollectorDomain'];
        readPreviewDomain?: import('./ownServerDeploymentTarget').OwnServerDeploymentTargetHostInput['readPreviewDomain'] }>): Promise<OwnServerDeploymentRuntimeAcquisition & Readonly<{
            sourceIntent: DeploymentOwnServerContentV1['sourceIntent'];
        }>> {
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
                const authorization = request.context.externalActionExecutionAuthorization;
                if (authorization && !authorization.requesterAccountProjection) return refuseDeploymentAuthorization('requester_account_projection_missing');
                if (authorization && !authorization.requesterHttpProjection) return refuseDeploymentAuthorization('requester_http_projection_missing');
                signal.throwIfAborted();
            };
            // Admit installed custody once per acquisition; finite native work
            // retains that custody and observes cancellation through its local signal.
            await host.assertInstalledCurrent?.();
            const retainedSourceIntent = snapshot.retainedSourceIntent
                ?? (requestedMaterialization?.kind === 'restoration' ? content?.sourceIntent : undefined);
            let lease: PluginRuntimeRegistryLease | undefined;
            let buildExecutionDirectory: string | undefined;
            let registryConfigDirectory: string | undefined;
            const removeRegistryConfigDirectory = async () => {
                if (!registryConfigDirectory) return;
                await rm(registryConfigDirectory, { recursive: true, force: true });
                registryConfigDirectory = undefined;
            };
            const privateSeed = decodeBase64(identity.privateKey, 'base64url').slice(0, 32);
            let captured: Awaited<ReturnType<typeof readDeploymentSourceIntentForHost>> | undefined;
            let secretAdmission: OwnServerSecretLaunchAdmission | undefined;
            try {
                const retainedFolder = content?.sourceIntent.kind === 'folder' && snapshot.retainedFolderSource
                    ? content.sourceIntent : undefined;
                const rootIdentity = await resolveOwnServerDeploymentIdentityForHost({
                    happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: environment.environment.id });
                const openRetainedFolder = async (sourceIntent: NonNullable<typeof retainedFolder>) => {
                    const custody = snapshot.retainedFolderSource;
                    if (!custody) return refuse('deployment_source_unavailable');
                    const retained = custody.sources.find(source => source.role === 'runtime'
                        && source.machineId === host.machineId && source.installationId === identity.installationId
                        && source.manifestFingerprint === sourceIntent.manifestFingerprint);
                    if (!retained) return refuse('deployment_source_unavailable');
                    const retainedIdentity = custody.environmentId === environment.environment.id ? rootIdentity
                        : await resolveOwnServerDeploymentIdentityForHost({
                            happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: custody.environmentId });
                    const deploymentRoot = await realpath(retainedIdentity.deploymentRoot).catch(() => null);
                    if (!deploymentRoot) return refuse('deployment_source_unavailable');
                    const rootPath = resolveDeploymentSourcePathForHost({ ...retainedIdentity, deploymentRoot,
                        deploymentId: retained.deploymentId, restorationForDeploymentId: retained.restorationForDeploymentId });
                    const assertRetainedRoot = async () => {
                        await assertAuthority();
                        if (await realpath(rootPath) !== rootPath || await computeWorkspaceSyncRootFingerprint(rootPath) !== retained.rootFingerprint)
                            return refuse('deployment_source_unavailable');
                    };
                    await assertRetainedRoot();
                    const folderExport = await runWithWorkspaceSource(localWorkspaceSource, () => captureRetainedDeploymentFolderForHost({
                        rootPath, assertCurrentAuthority: assertAuthority, manifest: retained.manifestEntries,
                        manifestFingerprint: retained.manifestFingerprint }));
                    try { await assertRetainedRoot(); }
                    catch (error) { await folderExport.dispose(); throw error; }
                    return { sourceIntent, folderExport, assertSourceCurrent: assertAuthority };
                };
                const capturedSource = captured = retainedFolder ? await openRetainedFolder(retainedFolder) : await readDeploymentSourceIntentForHost({ host: { ...host, signal, assertAuthority },
                    request: { environment, retainFolderExport: true, context: request.context, actionId: request.actionId,
                        ...(retainedSourceIntent ? { retainedSourceIntent } : {}),
                        ...(content ? { sourceIntent: content.sourceIntent } : 'sourceIntent' in request && request.sourceIntent
                            ? { sourceIntent: request.sourceIntent } : {}),
                        ...('sha' in request && request.sha ? { sha: request.sha } : {}) } });
                const nativeSource = DeploymentOwnServerContentV1Schema.shape.sourceIntent.safeParse(capturedSource.sourceIntent);
                if (!nativeSource.success) return refuse('deployment_invalid');
                const intent = nativeSource.data;
                // Persist the actual resolved source intent before P42 re-admits
                // this exact candidate Artifact. Discovery later updates that head.
                const materialization = 'stageContent' in request
                    ? { kind: 'review' as const, contentArtifactId: await request.stageContent(intent) }
                    : request.materialization;
                const materializationId = materialization.kind === 'review' ? materialization.contentArtifactId
                    : materialization.kind === 'restoration' ? materialization.sourceDeploymentId : materialization.deploymentId;
                const restorationForDeploymentId = materialization.kind === 'restoration' ? materialization.deploymentId : undefined;
                const maintenanceOperationId = isDeploymentBackupActionIdV1(request.actionId)
                    ? request.context.operationAcceptance?.operationId ?? request.context.actionRequestId ?? undefined : undefined;
                const admission = secretAdmission = await readSecretAdmission({ credentials: host.credentials,
                    serverId: host.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId,
                    installationId: identity.installationId, environmentId: environment.environment.id,
                    materialization: materialization.kind === 'restoration' ? { kind: 'deployment',
                        deploymentId: materialization.deploymentId } : materialization,
                    ...(materialization.kind === 'restoration' ? { actionOperationId: snapshot.deployment?.actionOperationId } : {}),
                    targetLinkId: request.input.targetLinkId, context: request.context, signal });
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
                const { deploymentRoot, environmentInstanceId, homeServerIdentityId } = rootIdentity;
                const releasePath = resolveDeploymentSourcePathForHost({ deploymentRoot,
                    environmentInstanceId, deploymentId: materializationId,
                    ...(build ? { materializationRole: 'build' } : {}),
                    ...(maintenanceOperationId === undefined ? {} : { maintenanceOperationId }),
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
                let referenceContainerNetwork: Parameters<NonNullable<OwnServerDeploymentRuntimeAcquisition['prepareReferenceContainerNetwork']>>[0] | undefined;
                const referenceBridges = new Map<ServiceExportMachineForward, {
                    routeKey: string;
                    bridge?: ReturnType<typeof acquirePrivateServiceContainerBridge>;
                    local?: Extract<import('./privateServiceReference').PrivateServiceExportAdmissionForHost, { kind: 'local' }>;
                    address?: Awaited<ReturnType<typeof resolvePrivateServiceLocalContainerAddress>>;
                }>();
                let telemetryForward: ServiceExportMachineForward | undefined;
                const releaseBridge = async (forward: ServiceExportMachineForward) => {
                    try {
                        // A failed acquisition has already settled and has no bridge to close.
                        const bridge = await referenceBridges.get(forward)?.bridge?.catch(() => undefined);
                        await bridge?.close();
                    } finally { referenceBridges.delete(forward); }
                };
                const materializeBridge = async (forward: ServiceExportMachineForward) => {
                    const retained = referenceBridges.get(forward)!;
                    if (retained.local) return retained.address ?? forward;
                    if (!referenceContainerNetwork?.networkId) return forward;
                    let bridge = retained.bridge;
                    if (!bridge) {
                        bridge = acquirePrivateServiceContainerBridge({ ...referenceContainerNetwork,
                            networkId: referenceContainerNetwork.networkId, forward, route: { key: retained.routeKey }, signal: hostSignal });
                        retained.bridge = bridge;
                    }
                    try { return await bridge; }
                    catch (error) {
                        if (forward === telemetryForward && error instanceof PrivateServiceContainerBridgeUnavailableError) return refuse('collector_unreachable', {
                            ...error.details, nextActions: ['use_native_linux_docker', 'configure_public_collector_route'],
                        }, error.failureCause);
                        throw error;
                    }
                };
                const referenceForwards = createServiceReferenceForwardCustody({ signal: hostSignal, async acquire(selected, lifetimeSignal) {
                    const acquisition = new AbortController();
                    const abort = () => acquisition.abort(signal.reason);
                    signal.throwIfAborted();
                    signal.addEventListener('abort', abort, { once: true });
                    let nativeForward: ServiceExportMachineForward;
                    try {
                        nativeForward = await acquirePrivateServiceReferenceForwardForHost(selected, remote => {
                            if (!host.acquireServiceExportForward) return refuse('machine_carrier_unavailable');
                            return host.acquireServiceExportForward({ targetMachineId: remote.machineId,
                                serviceExport: remote.serviceExport, context: request.context,
                                onFailure(error) {
                                    const failure = privateServiceForwardAcquisitionError(error);
                                    referenceForwards.reportFailure(selected, projectDeploymentFailure(failure.code, failure));
                                },
                                onRecovered() { referenceForwards.reportFailure(selected, null); },
                                signal: AbortSignal.any([lifetimeSignal, acquisition.signal]) });
                        });
                    }
                    finally { signal.removeEventListener('abort', abort); }
                    const forward: ServiceExportMachineForward = { ...nativeForward, async close() {
                        try { await releaseBridge(forward); }
                        finally { await nativeForward.close(); }
                    } };
                    const routeKey = JSON.stringify([environmentInstanceId, materializationId, 'service',
                        selected.serviceExport.service.environmentId, selected.serviceExport.exportKey]);
                    referenceBridges.set(forward, { routeKey, ...(selected.kind === 'local' ? { local: selected } : {}) });
                    return forward;
                } });
                const selectedArchives = structuredClone(content?.ownServer?.imageArchives ?? []);
                const environmentName = environment.content.name;
                const commitSha = intent.kind === 'repository' ? intent.sha : undefined;
                let previewDomain: Promise<Readonly<{ domainId: string; url: string }>> | undefined;
                const readPreviewDomain = (source: Parameters<NonNullable<OwnServerDeploymentRuntimeAcquisition['secrets']['resolveNonSecret']>>[0]) => previewDomain ??= (async () => {
                    const captured = content?.previewDomain ?? request.context.invocationServices?.deploymentPreviewDomain;
                    if (captured) return captured;
                    if (!snapshot.readReferenceEnvironment || !snapshot.readPreviewDomain)
                        return refuse('reference_unavailable');
                    return await preparePreviewDomainFactForHost({ serverId: host.serverId,
                        provenance: environment.content.previewProvenance, sources: [source] }, {
                        readTemplate: environmentId => snapshot.readReferenceEnvironment!({ environmentId, context: request.context }),
                        readDomain: input => snapshot.readPreviewDomain!({ ...input, context: request.context }),
                    }) ?? refuse('reference_unavailable');
                })();
                const collectorMachineId = environment.environment.telemetryMachineId;
                const deferredTelemetryCollectorMachineId = materialization.kind === 'review' && collectorMachineId
                    && collectorMachineId !== host.machineId && environment.content.bindings.some(binding =>
                        binding.purpose === 'variable' && binding.source.kind === 'deploymentFact' && binding.source.fact === 'telemetryEndpoint')
                    ? collectorMachineId : undefined;
                const secrets: OwnServerDeploymentRuntimeAcquisition['secrets'] = {
                    installationPrivateSeed: privateSeed, grants: admission.grants,
                    registryConfigBaseDir: registryConfigDirectory,
                    async resolveNonSecret(source) {
                        // These primitives belong to the already admitted acquisition.
                        if (source.kind === 'deploymentFact') {
                            if (source.fact === 'telemetryEndpoint') {
                                // Compose review needs a value for interpolation. The private route
                                // itself can only be read by launch with an accepted Receipt.
                                if (deferredTelemetryCollectorMachineId) return 'http://collector-at-launch.invalid';
                                if (collectorMachineId !== host.machineId) {
                                    if (!collectorMachineId || !snapshot.readTelemetryCollectorDomain || !snapshot.deployment)
                                        return refuse('collector_unreachable', { reason: 'collector_route_unavailable' });
                                    const route = await snapshot.readTelemetryCollectorDomain({ environmentId: environment.environment.id,
                                        targetLinkId: request.input.targetLinkId ?? environment.environment.runtimeTargetLinkId!,
                                        collectorMachineId, deployment: snapshot.deployment,
                                        context: request.context });
                                    if (route.kind !== 'ready') return route.reason === 'private_scope_unenforceable'
                                        ? refuse(route.reason, undefined, {
                                            phase: DEPLOYMENT_COLLECTOR_PRIVATE_BINDING_FAILURE_PHASE_V1,
                                            errorClass: 'Error', errorCode: route.reason, httpStatus: null })
                                        : refuse('collector_unreachable', { reason: route.reason });
                                    return route.endpoint;
                                }
                                const readEndpoint = retainedLease.registry.readTelemetryCollectorEndpoint;
                                const endpoint = readEndpoint?.();
                                if (!endpoint) return refuse('collector_unreachable', {
                                    reason: 'receiver_unavailable', nextActions: ['enable_telemetry_role'],
                                });
                                if (!telemetryForward) {
                                    const target = createOwnServerTelemetryRelayForward(() => readEndpoint?.());
                                    const forward: ServiceExportMachineForward = { get host() { return target.host; },
                                        get port() { return target.port; }, observedPath: 'direct', close: () => releaseBridge(forward) };
                                    referenceBridges.set(forward, { routeKey: ownServerTelemetryRelayKey(environmentInstanceId, materializationId) });
                                    telemetryForward = referenceForwards.adopt(forward);
                                }
                                const address = await materializeBridge(telemetryForward);
                                return `http://${address.host}:${address.port}`;
                            }
                            if (source.fact === 'domainUrl' || source.fact === 'primaryUrl') {
                                const planned = await readPreviewDomain(source);
                                if (source.fact === 'domainUrl' && source.domainId !== planned.domainId)
                                    return refuse('reference_unavailable');
                                return planned.url;
                            }
                            return resolveEnvironmentDeploymentFactForHost(source.fact, { environmentName, commitSha,
                                deploymentId: materialization.kind === 'review' ? undefined : materializationId,
                                domainUrl: undefined, primaryUrl: undefined, telemetryEndpoint: undefined });
                        }
                        if (source.kind === 'reference') return resolvePrivateServiceReferenceMaterialForHost({
                            source, environment, homeServerIdentityId, readEnvironment: snapshot.readReferenceEnvironment,
                            host, context: request.context, actionId: request.actionId, signal,
                            owner: retainedLease.registry.projectManagedServices,
                            installationId: identity.installationId, privateKey: decodeBase64(identity.privateKey, 'base64url'),
                            acquireForward: referenceForwards.acquire,
                            materializeForwardAddress: materializeBridge,
                        });
                        return refuse('reference_unavailable');
                    },
                };
                return { exec, nativeIo, projectManagedServices: retainedLease.registry.projectManagedServices,
                    enrollAppServices: input => enrollOwnServerAppServices(input, {
                        credentials: host.credentials, credentialProfileId: host.credentialProfileId,
                        serverId: host.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl,
                        machineId: host.machineId, identity, context: request.context, nativeIo,
                    }),
                    async prepareReferenceContainerNetwork(network) {
                        referenceContainerNetwork = network;
                        // Local exports borrow their source network. Remote
                        // carriers and host telemetry receive a private relay.
                        await Promise.all([...referenceBridges].map(async ([forward, retained]) => {
                            const local = retained.local;
                            if (local && network.localReferences?.some(reference => reference.source.environmentId === local.serviceExport.service.environmentId
                                && reference.source.export === local.serviceExport.exportKey)) {
                                retained.address = await resolvePrivateServiceLocalContainerAddress({ admission: local,
                                    owner: retainedLease.registry.projectManagedServices, homeServerIdentityId,
                                    docker: network.docker, signal: network.signal });
                            } else await materializeBridge(forward);
                        }));
                        return { localNetworks: [...referenceBridges.values()].flatMap(retained => retained.local && retained.address
                            ? [{ source: { environmentId: retained.local.serviceExport.service.environmentId,
                                export: retained.local.serviceExport.exportKey }, networkId: retained.address.networkId }] : []) };
                    },
                    retainServiceReferences(consumers, keys) {
                        referenceForwards.retain(consumers.map(consumer => consumer.retirementSignal),
                            failure => { for (const consumer of consumers) consumer.reportDependencyFailure?.(failure); }, keys);
                    },
                    currentDomainEdgeObservation: retainedLease.registry.currentDomainEdgeObservation,
                    readHealthAlertSource: retainedLease.registry.readHealthAlertSource, sourceIntent: intent,
                    ...(buildExecutionDirectory === undefined ? {} : { buildExecutionDirectory }),
                    source: { environmentId: environment.environment.id, environmentInstanceId,
                        deploymentId: materializationId, machineId: host.machineId, installationId: identity.installationId,
                        ...(build ? { materializationRole: 'build' as const } : {}),
                        ...(maintenanceOperationId === undefined ? {} : { maintenanceOperationId }),
                        ...(restorationForDeploymentId === undefined ? {} : { restorationForDeploymentId }),
                        ...selectDeploymentSourceMaterializationForHost(capturedSource), deploymentRoot,
                        artifactDirectory: join(configuration.happyHomeDir, 'tmp', 'deployment-source') },
                    secrets,
                    ...(deferredTelemetryCollectorMachineId ? { deferredTelemetryCollectorMachineId } : {}),
                    async acquireCopySourceSecrets(source) {
                        await assertCurrent();
                        return readSecretAdmission({ credentials: host.credentials, serverId: host.serverId,
                            serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId,
                            installationId: identity.installationId, environmentId: source.environmentId,
                            targetLinkId: source.targetLinkId, materialization: { kind: 'copySourceRead',
                                deploymentId: source.deploymentId, actionOperationId: source.actionOperationId },
                            context: request.context, signal });
                    },
                    async openBackupDestination(configuration) {
                        return openDeploymentBackupDestinationForHost({ registry: retainedLease.registry,
                            configuration, context: request.context, signal });
                    },
                    async prepareBackupRepositoryOperands() {
                        return prepareOwnServerBackupRepositoryOperandsForHost({ registry: retainedLease.registry,
                            configuration: environment.content.backup,
                            preparation: { ...secrets, environmentId: environment.environment.id, machineId: host.machineId,
                                installationId: identity.installationId, bindings: environment.content.bindings, assertCurrent },
                            context: request.context, signal, isCurrent: () => !released });
                    },
                    async preparePreMigrationBackupOperands() {
                        return prepareOwnServerPreMigrationBackupOperandsForHost({ registry: retainedLease.registry,
                            configuration: environment.content.backup, data: environment.content.template?.data,
                            preparation: { ...secrets, environmentId: environment.environment.id, machineId: host.machineId,
                                installationId: identity.installationId, bindings: environment.content.bindings, assertCurrent },
                            context: request.context, signal, isCurrent: () => !released });
                    },
                    async prepareBackupRunOperands() {
                        return prepareOwnServerBackupRunOperandsForHost({ registry: retainedLease.registry,
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
                                finally {
                                    try { await referenceForwards.release(); }
                                    finally {
                                        try { await capturedSource.folderExport?.dispose(); }
                                        finally { try { await admission.release?.(); } finally { await retainedLease.release(); } }
                                    }
                                }
                            }
                        }
                    },
                };
            } catch (error) {
                privateSeed.fill(0);
                try { await removeRegistryConfigDirectory(); }
                finally {
                    try { if (buildExecutionDirectory) await rm(buildExecutionDirectory, { recursive: true, force: true }); }
                    finally {
                        try { await captured?.folderExport?.dispose(); }
                        finally { try { await secretAdmission?.release?.(); } finally { await lease?.release(); } }
                    }
                }
                throw error;
            }
    }
    const acquireNative = async (input: Readonly<{ machineId: string; installationId: string;
        request: Readonly<{ input: Readonly<{ serverId: string }>; context: ActionExecutorContext }> }>, recheck: () => Promise<void>) => {
        const identity = readInstallationIdentityIfExistsSync();
        if (!identity || input.machineId !== host.machineId || input.installationId !== identity.installationId
            || input.request.input.serverId !== host.serverId) return refuse('target_mismatch');
        const context = input.request.context;
        const signal = context.signal && host.signal ? AbortSignal.any([context.signal, host.signal])
            : context.signal ?? host.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const authorization = context.externalActionExecutionAuthorization;
        if (authorization && !authorization.requesterAccountProjection) return refuseDeploymentAuthorization('requester_account_projection_missing');
        if (authorization && !authorization.requesterHttpProjection) return refuseDeploymentAuthorization('requester_http_projection_missing');
        if (!authorization && (context.externalActionCredential || context.rpcSessionAuthorization)) return refuseDeploymentAuthorization('requester_authorization_missing');
        let released = false;
        const assertCurrent = async () => {
            signal.throwIfAborted();
            if (released) return refuse('deployment_source_unavailable');
        };
        await host.assertInstalledCurrent?.();
        await recheck();
        const deploymentRoot = await resolveOwnServerDeploymentRootForHost(configuration.happyHomeDir, host.serverId);
        const native = createOwnServerNativeRuntime({ cwd: deploymentRoot, signal, isCurrent: () => !released });
        type ObserverScope = Readonly<{ homeServerIdentityId: string; environmentId: string }>;
        const visitEnvironmentObservers = async (scope: ObserverScope, visit: (handle: ProjectManagedServiceHandle) => void | Promise<void>) => {
            const lease = await host.acquirePluginRuntimeRegistryLease();
            try {
                for (const handle of lease.registry.projectManagedServices.listProjectServices()) {
                    if (handle.kind === 'environment' && handle.machineId === input.machineId
                        && handle.homeServerIdentityId === scope.homeServerIdentityId && handle.environmentId === scope.environmentId) {
                        await visit(handle);
                    }
                }
            } finally { await lease.release(); }
        };
        return { ...native, deploymentRoot, assertCurrent,
          async expectEnvironmentStop(scope: ObserverScope) {
            const undo: (() => void)[] = [];
            const undoExpectedStop = () => { for (const restore of undo) restore(); };
            try {
                await visitEnvironmentObservers(scope, handle => {
                    const restore = handle.expectNativeStop?.();
                    if (restore) undo.push(restore);
                });
            } catch (error) {
                undoExpectedStop();
                throw error;
            }
            return undoExpectedStop;
          },
          async releaseEnvironmentServiceReferences(scope: ObserverScope, keys: readonly MachineNativeEffectKey[]) {
            const consumers = new Set<AbortSignal>();
            await visitEnvironmentObservers(scope, handle => { consumers.add(handle.retirementSignal); });
            await releaseRemovedServiceReferenceForwards(consumers, keys);
          },
          retireEnvironmentObservers(scope: ObserverScope) {
            return visitEnvironmentObservers(scope, handle => handle.dispose());
          },
          async release() {
            if (released) return;
            released = true;
            try { await native.settleNative(); }
            finally { await readPluginExecProcessCustodyForHost(native.exec).requestStop(); }
        } };
    };
    return {
        async prepareBackupSourceChoices({ environment, context }) {
            const signal = context.signal && host.signal ? AbortSignal.any([context.signal, host.signal])
                : context.signal ?? host.signal ?? new AbortController().signal;
            signal.throwIfAborted();
            await host.assertInstalledCurrent?.();
            const identity = readInstallationIdentityIfExistsSync();
            if (!identity) return refuse('target_unavailable');
            const placement = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                serverId: host.serverId, environmentId: environment.environment.id });
            const temporaryRoot = join(configuration.happyHomeDir, 'tmp', 'deployment-definition');
            await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
            const root = await mkdtemp(join(temporaryRoot, 'backup-'));
            let source: Awaited<ReturnType<ReturnType<typeof createDeploymentSourceMaterializationPort>['materialize']>> | undefined;
            let project: Pick<import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeEnvironmentProject,
                'reviewDefinition' | 'dispose'> | undefined;
            let native: ReturnType<typeof createOwnServerNativeRuntime> | undefined;
            let released = false;
            let capturedSource: Awaited<ReturnType<typeof readDeploymentSourceIntentForHost>> | undefined;
            try {
                const captured = capturedSource = await readDeploymentSourceIntentForHost({ host: { ...host, signal,
                    async assertAuthority() { signal.throwIfAborted(); } },
                    request: { environment, context, retainFolderExport: true, actionId: 'deployments.environments.update' } });
                const intent = captured.sourceIntent;
                const port = createDeploymentSourceMaterializationPort({ async admit() {
                    return { environmentId: environment.environment.id, environmentInstanceId: placement.environmentInstanceId,
                        deploymentId: 'definition', machineId: host.machineId, installationId: identity.installationId,
                        deploymentRoot: root, artifactDirectory: join(root, 'artifacts'), assertCurrent: captured.assertSourceCurrent,
                        ...selectDeploymentSourceMaterializationForHost(captured) };
                } });
                source = await port.materialize({ environmentId: environment.environment.id, deploymentId: 'definition' }, { signal });
                native = createOwnServerNativeRuntime({ cwd: source.rootPath, signal, isCurrent: () => !released });
                const compose = intent.kind === 'stored' ? { path: 'compose.yaml', ...intent } : intent.compose;
                // Keeps the pre-existing uncoded failure for a Compose-less source; a coded refusal needs its own decision.
                if (!compose) throw new TypeError('Definition review requires a Compose source');
                project = createNativeComposeLifecycle({ kind: 'environmentDefinition', phase: 'build',
                    exec: native.exec, io: native.nativeIo, settleNative: native.settleNative, source,
                    sourceKind: intent.kind, files: [compose.path],
                    profiles: compose.profiles, services: compose.services });
                const review = await project.reviewDefinition({ signal });
                const choices = createDeploymentLogicalBackupSourceChoicesV1(environment.content.template?.data,
                    review.services.map(service => service.name));
                const seen = new Set<string>();
                for (const service of review.services) for (const mount of service.mounts) {
                    if (mount.type !== 'volume' || !mount.source) continue;
                    const sourceId = createDeploymentVolumeBackupSourceIdV1(service.name, mount.source);
                    if (seen.has(sourceId)) continue;
                    seen.add(sourceId);
                    choices.push({ kind: 'volume', sourceId, service: service.name, volume: mount.source,
                        consistency: 'stopDuringCopy' });
                }
                return choices;
            } finally {
                try { await native?.settleNative(); }
                finally {
                    released = true;
                    try { await project?.dispose(); }
                    finally {
                        try { await source?.abort(); }
                        finally {
                            try { await capturedSource?.folderExport?.dispose(); }
                            finally { await rm(root, { recursive: true, force: true }); }
                        }
                    }
                }
            }
        },
        prepareDomainCaddy(request) {
            const telemetry = request.domain.target.kind === 'telemetry';
            const replicaNetworks = [...new Set(request.replicas.flatMap(replica => [...replica.networkNames]))];
            const routedNetworks = replicaNetworks.length ? replicaNetworks : telemetry
                ? request.retainedCaddy?.networkNames.length ? [...request.retainedCaddy.networkNames] : ['bridge'] : [];
            if (!telemetry && !request.replicas.length) return { status: 'unavailable', reason: 'required_fact_unavailable',
                details: { requiredFact: 'deployed_replicas' } };
            if (!routedNetworks.length) return { status: 'unavailable', reason: 'required_fact_unavailable',
                details: { requiredFact: 'replica_networks' } };
            // Workload exports select the private network, never Caddy's port.
            // No export is required for an unpublished container-network app.
            const networks = [...new Set((request.environment.ownServer?.serviceExports ?? []).filter(item =>
                item.service === request.domain.target.service && item.containerPort === request.domain.target.containerPort
                && item.exposure === 'privateNetwork').map(item => item.privateNetwork!))];
            if (networks.length > 1) return { status: 'unavailable', reason: 'private_scope_unenforceable' };
            const exposures: NativeCaddyFirewallExposure[] = [];
            // Caddy is shared: reconciling a Tunnel's network must retain the
            // public listeners/publications already serving sibling Domains.
            const publicIngress = !request.environment.ingress || request.environment.ingress.kind === 'edgeCaddy'
                && request.environment.ingress.edgeMachineId === host.machineId
                || request.retainedCaddy?.servers.some(server => server.tls && server.endpoints.length > 0) === true;
            if (publicIngress) exposures.push(...nativeCaddyProfile.publicPortRequirements.map(requirement => ({
                requirementId: requirement.id, exposure: requirement.exposure, protocol: requirement.protocol,
                containerPort: requirement.containerPort, hostPort: requirement.hostPort, hostAddress: '0.0.0.0',
            })));
            const candidates = request.privateNetworks.filter(network => network.state === 'ready'
                && network.interfaceName && network.networkIdentity && (!networks.length || network.networkIdentity === networks[0]));
            if (candidates.length > 1) return { status: 'unavailable', reason: 'private_scope_unenforceable' };
            if (candidates.length) {
                const network = candidates[0]!;
                if (!network.addresses.length) return { status: 'unavailable', reason: 'required_fact_unavailable',
                    details: { requiredFact: 'private_network_addresses' } };
                const requirement = nativeCaddyProfile.portRequirement;
                exposures.push({ requirementId: requirement.id, exposure: requirement.exposure, protocol: requirement.protocol,
                    hostPort: requirement.hostPort, containerPort: requirement.containerPort,
                    hostAddress: network.addresses[0]!, networkIdentity: network.networkIdentity!,
                    providerId: 'kind' in network.provider ? network.provider.id : buildQualifiedPluginContributionKey(network.provider) });
            }
            const bindings = createNativeCaddyBindings({ originPort: nativeCaddyProfile.portRequirement.containerPort,
                exposures, privateNetworks: request.privateNetworks });
            if (bindings.status !== 'ready') return bindings;
            const privateSeedInput = { adminSocket: '/run/happier-caddy/admin.sock',
                originListen: [`:${nativeCaddyProfile.portRequirement.containerPort}`] as const };
            const publicSeedInput = { ...privateSeedInput,
                publicListen: [`:${nativeCaddyProfile.publicPortRequirements[1].containerPort}`] as const,
                publicHttpListen: [`:${nativeCaddyProfile.publicPortRequirements[0].containerPort}`] as const };
            const input = createNativeCaddySetupInput({ daemonGroup: request.daemonGroup, daemonGroupId: request.daemonGroupId,
                routedNetworks, initialConfig: JSON.stringify(materializeCaddyInitialConfigV1(publicIngress ? publicSeedInput : privateSeedInput)),
                bindings: { privateBinding: bindings.privateBinding, publicBindings: bindings.publicBindings } });
            // Both owned startup seeds are exact known predecessors of each
            // other. The native file owner still rejects every other digest.
            // Live routes/certificates remain in Caddy's separate autosave state.
            const steps = createCaddyContainerSetupSteps(input, {
                previousInitialConfig: JSON.stringify(materializeCaddyInitialConfigV1(publicIngress ? privateSeedInput : publicSeedInput)),
            });
            return { status: 'ready', input, steps,
                async ensure({ setup, context, actionId, installationId, dockerEngineId, run, signal }) {
                    const operationId = context.operationAcceptance?.operationId ?? context.actionRequestId;
                    if (!operationId) return refuse('operation_unavailable');
                    const desired = await setup.readDesired();
                    if (desired.status !== 'ready') return refuse('required_fact_unavailable', { requiredFact: 'machine_setup_desired_state' });
                    const basis = { kind: 'setup' as const, machineId: host.machineId, desiredRevision: desired.policy.revision };
                    const elevation = { ...setup.elevation, installationId, ...resolveMachineEffectCli() };
                    return machineNativeEffectAdmission.run({ operation: { operationId, kind: actionId, signal },
                        keys: [{ kind: 'machineSetup' }, { kind: 'dockerEngine', dockerEndpoint: dockerEngineId }] }, async native => {
                        let applied: import('@happier-dev/cli-common/machineSetup').MachineSetupApplyResultV1 | undefined;
                        const elevated = await machineNativeEffectAdmission.runStage(native, () => runElevatedMachineSetupIntent({
                            machineId: host.machineId, operationId, signal, basis, steps,
                            onSetupApplied(result) { applied = result; },
                        }, { ...elevation, verifyCurrent: async () => !signal.aborted }));
                        if (elevated.outcome !== 'applied') return refuse('reasonCode' in elevated ? elevated.reasonCode : elevated.outcome, {
                            ...('recovery' in elevated && elevated.recovery ? { recovery: elevated.recovery } : {}),
                            ...('preauthorizationIssue' in elevated && elevated.preauthorizationIssue
                                ? { preauthorizationIssue: elevated.preauthorizationIssue } : {}),
                            ...('failure' in elevated && elevated.failure ? { failure: elevated.failure,
                                remedy: elevated.failure.remedy ?? (elevated.outcome === 'outcome_unknown'
                                    ? 'Inspect and reconcile Caddy setup on this Machine before retrying the Domain action.'
                                    : 'Check Caddy setup prerequisites on this Machine, including parent directories and the configured owner/group, then retry the Domain action.'),
                            } : {}),
                        });
                        if (!applied) return refuse('outcome_unknown');
                        if ((input.privateBinding || input.publicBindings?.length) && !setup.settleCaddyFirewall) return refuse('private_scope_unenforceable');
                        const setupResult = applied;
                        return machineNativeEffectAdmission.runStage(native, () => ensureNativeCaddyContainer(input, { run, signal, setupResult,
                            settleBindings: async () => {
                                if (input.privateBinding || input.publicBindings?.length) await setup.settleCaddyFirewall!({ machineId: host.machineId, installationId,
                                    operationId, basis, caddy: input, native, elevation, signal });
                            } }));
                    });
                } };

        },
        acquire,
        acquireRetention: acquireNative,
        acquireTeardown: acquireNative,
        acquireTeardownReview: acquireNative,
        acquireCandidate(request, environment) {
            return acquire({ actionId: 'deployments.deploy', context: request.context, executionRole: 'build',
                input: { serverId: host.serverId, environmentId: request.environmentId, targetLinkId: request.targetLinkId },
                ...(request.sourceIntent ? { sourceIntent: request.sourceIntent } : {}),
                ...(request.sha ? { sha: request.sha } : {}),
                stageContent: request.stageContent }, { environment, readReferenceEnvironment: request.readReferenceEnvironment,
                    readPreviewDomain: request.readPreviewDomain, readTelemetryCollectorDomain: request.readTelemetryCollectorDomain });
        },
    };
}
