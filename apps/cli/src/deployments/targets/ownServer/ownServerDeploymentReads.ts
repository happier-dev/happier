import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentDriftReadInputV1, DeploymentHealthReadInputV1, DeploymentLogsReadInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { configuration } from '@/configuration';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { readOwnServerDeploymentStageLogs } from './stageLog';
import { isDeploymentSourceUnchangedManifestInput } from './exactCommitRelease';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { withMachineServiceLogTarget } from '@/daemon/local/services/launch/machineServiceTarget';

type ReadInput = DeploymentHealthReadInputV1 | DeploymentDriftReadInputV1 | DeploymentLogsReadInputV1;
type Field = 'environmentRevision' | 'activeDeployment' | 'targetInstallation' | 'serviceIdentity'
    | 'composeDigest' | 'configDigest' | 'materializationReceipt' | 'ownerLabels';
const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Receipt-authorized reads; runtime logs can use read-only native discovery after memory loss. */
export function createOwnServerDeploymentReads(host: Pick<OwnServerDeploymentTargetHostInput,
    'serverId' | 'machineId' | 'readReceipt'> & Readonly<{
        readRetentionHeaders: NonNullable<OwnServerDeploymentTargetHostInput['readRetentionHeaders']>;
        readEnvironmentMetadata(request: Parameters<OwnServerDeploymentTargetHostInput['readEnvironment']>[0]): Promise<Readonly<{
            environment: DeploymentEnvironmentDetailV1['environment'];
            targetLinks: ReadonlyArray<DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink']>;
        }>>;
        assertCurrent(context: ActionExecutorContext): Promise<void>;
        ensureServiceObservations?(): Promise<void>;
    }>): NonNullable<ActionExecutorDeps['deploymentAction']> {
    return async (actionId, rawInput, context) => {
        if (actionId !== 'deployments.health.read' && actionId !== 'deployments.drift.read' && actionId !== 'deployments.logs.read') return failure('unsupported_action');
        let lease: ReturnType<typeof tryAcquireAuthoritativePluginRuntimeRegistryLease> = null;
        try {
            const input: ReadInput = DeploymentActionInputSchemasV1[actionId].parse(rawInput);
            await host.assertCurrent(context);
            const installation = readInstallationIdentityIfExistsSync();
            if (input.serverId !== host.serverId || input.machineId !== host.machineId
                || installation?.installationId !== input.installationId) return failure('target_mismatch');
            if (actionId === 'deployments.logs.read' && isRuntimeLogsInput(input)) {
                // Log access needs the receipt's public placement, not its private
                // content or a new secret acquisition from Home.
                const headers = await host.readRetentionHeaders({ environmentId: input.environmentId,
                    deploymentId: input.deploymentId, targetLinkId: input.targetLinkId, context });
                const { environment, deployment, link } = headers;
                if (environment.id !== input.environmentId || !environment.capabilities.read) return failure('action_forbidden');
                const nativeIdentity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                    serverId: host.serverId, environmentId: environment.id });
                if (link.id !== input.targetLinkId || link.targetKind !== 'ownServer'
                    || deployment.id !== input.deploymentId || deployment.environmentId !== environment.id
                    || deployment.targetLinkId !== link.id
                    || !link.members.some(member => member.machineId === input.machineId && member.installationId === input.installationId)
                    || input.service.environmentInstanceId !== nativeIdentity.environmentInstanceId) return failure('target_mismatch');
                return await withMachineServiceLogTarget({ request: { serverId: input.serverId, machineId: input.machineId,
                    serviceId: input.service.serviceId }, serverId: host.serverId, machineId: host.machineId,
                    approvalScope: { kind: 'environment', environmentId: environment.id },
                    ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => {
                        context.signal?.throwIfAborted();
                        if (readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) refuse('target_mismatch');
                    } }, async handle => {
                    if (handle.kind !== 'environment' || handle.environmentId !== environment.id
                        || handle.deploymentId !== input.deploymentId) return failure('service_unavailable');
                    const { canReadIncompleteSecretMaskingForHost } = await import('@/plugins/runtime/invocation/services/managedServiceNativeLogs');
                    const logs = handle.readLogs ? await handle.readLogs({ ...(input.cursor ? { cursor: input.cursor } : {}),
                        ...(context.signal ? { signal: context.signal } : {}),
                        ...(canReadIncompleteSecretMaskingForHost(context) ? { allowIncompleteSecretMasking: true as const } : {}) })
                        : { kind: 'unavailable' as const, reason: 'unsupported' as const };
                    return DeploymentActionOutputSchemasV1[actionId].parse({ ok: true, environmentId: input.environmentId,
                        deploymentId: input.deploymentId, targetLinkId: input.targetLinkId, machineId: input.machineId,
                        installationId: input.installationId, service: input.service, kind: 'runtime', logs });
                });
            }
            const environment = await host.readEnvironmentMetadata({ environmentId: input.environmentId, context });
            const receipt = await host.readReceipt({ environmentId: input.environmentId, deploymentId: input.deploymentId, context });
            const link = environment.targetLinks.find(item => item.id === input.targetLinkId);
            if (environment.environment.id !== input.environmentId || !environment.environment.capabilities.read) return failure('action_forbidden');
            if (!link || link.targetKind !== 'ownServer' || receipt.deployment.id !== input.deploymentId
                || receipt.deployment.environmentId !== input.environmentId || receipt.deployment.targetLinkId !== link.id) return failure('target_mismatch');
            // This finite page spends the Home admission above. The next page
            // admits again; completion retains only local cancellation/custody.
            const assertReadCurrent = async () => {
                await host.assertCurrent(context);
                context.signal?.throwIfAborted();
                if (readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) refuse('target_mismatch');
            };
            const placement = { environmentId: input.environmentId, deploymentId: input.deploymentId, targetLinkId: input.targetLinkId,
                machineId: input.machineId, installationId: input.installationId };
            if (!('service' in input)) {
                if (actionId !== 'deployments.logs.read' || !('kind' in input) || input.kind !== 'build') return failure('invalid_parameters');
                const nativeIdentity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                    serverId: host.serverId, environmentId: input.environmentId });
                const logs = await readOwnServerDeploymentStageLogs({ deploymentRoot: nativeIdentity.deploymentRoot,
                    serverId: nativeIdentity.homeServerIdentityId, machineId: host.machineId, installationId: input.installationId }, receipt,
                    { ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.ref ? { ref: input.ref } : {}),
                        ...(input.tail ? { tail: input.tail } : {}), ...(context.signal ? { signal: context.signal } : {}),
                        ...(context.machineServiceLogsResource?.sourceRevision ? { expectedSourceRevision: context.machineServiceLogsResource.sourceRevision } : {}),
                        ...(context.machineServiceLogsResource?.observation ? { observation: context.machineServiceLogsResource.observation } : {}) });
                context.signal?.throwIfAborted();
                return DeploymentActionOutputSchemasV1[actionId].parse({ ok: true, ...placement, kind: 'build', logs });
            }
            if (!link.members.some(member => member.machineId === input.machineId && member.installationId === input.installationId)) return failure('target_mismatch');
            await host.ensureServiceObservations?.();
            lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                serverId: host.serverId, environmentId: input.environmentId });
            const handle = lease?.registry.projectManagedServices.resolveEnvironmentService(identity.homeServerIdentityId, input.service);
            if (!handle) return failure('service_unavailable');
            const assertDisclosureCurrent = async () => {
                await assertReadCurrent();
                if (!handle.isCurrent() || handle.retirementSignal.aborted) refuse('service_unavailable');
                await handle.release.assertCurrent();
                context.signal?.throwIfAborted();
            };
            await assertDisclosureCurrent();
            const target = { ...placement, service: input.service };
            const facts = handle.readNativeRuntimeFacts?.();
            const freshness = facts?.freshness === 'current' ? 'current' as const : 'unavailable' as const;
            const observedAtMs = facts?.observedAt ?? null;
            if (actionId === 'deployments.health.read') {
                const snapshot = handle.snapshot();
                const native = { phase: snapshot.nativePhase ?? 'unknown', readiness: snapshot.readiness ?? 'not_reported' };
                const current = freshness === 'current' && handle.deploymentId === input.deploymentId;
                const health = !current || native.phase === 'unknown' ? 'unknown'
                    : native.phase === 'stopped' || native.readiness === 'not_ready' ? 'unhealthy'
                        : native.readiness === 'ready' ? 'healthy' : 'running_unverified';
                await assertDisclosureCurrent();
                return DeploymentActionOutputSchemasV1[actionId].parse({ ok: true, ...target,
                    freshness: current ? 'current' : 'unavailable', observedAtMs: current ? observedAtMs : null,
                    native: current ? native : null, health,
                    evidence: [{ source: 'receipt', observedAtMs: null, revision: String(receipt.deployment.revision) },
                        ...(current ? [{ source: 'native', observedAtMs }] : [])] });
            }
            if (!('expectedRevision' in input)) return failure('invalid_parameters');
            const differingFields: Field[] = [];
            const missingFields: Field[] = [];
            if (environment.environment.revision !== input.expectedRevision) differingFields.push('environmentRevision');
            if (handle.deploymentId !== input.deploymentId || link.activeDeploymentId !== input.deploymentId) differingFields.push('activeDeployment');
            const basis = receipt.content.ownServer?.approvedInputBasis;
            if (!basis) missingFields.push('composeDigest', 'materializationReceipt', 'ownerLabels');
            else {
                if (!isDeepStrictEqual(basis.sourceIntent, receipt.content.sourceIntent)) differingFields.push('composeDigest');
                if (!basis.configInputDigests.length) missingFields.push('composeDigest');
                else {
                    const unchanged = await Promise.all(basis.configInputDigests.map(file =>
                        isDeploymentSourceUnchangedManifestInput(handle.release, resolve(handle.release.rootPath, file.path))));
                    if (unchanged.some(value => !value) && !differingFields.includes('composeDigest')) differingFields.push('composeDigest');
                }
                if (handle.release.manifestFingerprint !== basis.manifestFingerprint
                    || handle.release.environmentId !== input.environmentId || handle.release.deploymentId !== input.deploymentId) differingFields.push('materializationReceipt');
            }
            const containers = freshness === 'current' ? handle.readNativeContainers?.() : null;
            if (!containers?.length) {
                missingFields.push('configDigest');
                if (basis) missingFields.push('ownerLabels');
            }
            else {
                if (basis && containers.some(row => row.composeProject !== basis.physicalProjectName || row.service !== input.service.composeService)) differingFields.push('ownerLabels');
                const expectedImages = receipt.content.images.filter(image => image.service === input.service.composeService);
                if (!expectedImages.length || containers.some(row => !row.imageConfigDigest || row.configurationMatches === undefined)) missingFields.push('configDigest');
                if (containers.some(row => row.configurationMatches === false
                    || row.imageConfigDigest && expectedImages.length && !expectedImages.some(image => image.configDigest === row.imageConfigDigest))) differingFields.push('configDigest');
            }
            await assertDisclosureCurrent();
            return DeploymentActionOutputSchemasV1[actionId].parse({ ok: true, ...target, revision: environment.environment.revision,
                freshness, observedAtMs, status: differingFields.length ? 'drifted' : missingFields.length ? 'unknown' : 'in_sync',
                differingFields, missingFields });
        } catch (error) {
            return failure(context.signal?.aborted ? 'cancelled' : error instanceof Error && 'code' in error
                && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable');
        } finally { await lease?.release(); }
    };
}

const isRuntimeLogsInput = (input: ReadInput): input is Extract<DeploymentLogsReadInputV1, { kind: 'runtime' }> =>
    'kind' in input && input.kind === 'runtime';
