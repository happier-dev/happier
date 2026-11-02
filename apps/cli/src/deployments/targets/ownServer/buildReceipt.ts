import { isDeepStrictEqual } from 'node:util';
import { configuration } from '@/configuration';
import { DeploymentOwnServerContentV1Schema, type DeploymentEnvironmentDetailV1, type DeploymentOwnServerContentV1, type DeploymentImageV1, type OwnServerDeploymentDetailsV1 } from '@happier-dev/deployment-protocol';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { normalizeNativeComposePlatform, resolveNativeComposeImageDistributionRegistry } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { isProjectNativeProcessUncertain } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { createDeploymentSourceMaterializationPort, readDeploymentSourceCommitSubjectForHost } from './exactCommitRelease';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createOwnServerNativeImageAcquisition } from './nativeImageAcquisition';
import { admitOwnServerDeploymentSource, admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';
import { adoptOwnServerImageArchives } from './releaseProvenance';
import { captureOwnServerDeploymentStageLog, openOwnServerDeploymentStageLog } from './stageLog';
import { recordDeploymentSourceProgress } from './sourceOperationLog';
import { captureOwnServerDeploymentSource, replaceOwnServerDeploymentSource } from './sourceProvenance';
import type { OwnServerDeploymentReceipt, OwnServerDeploymentRequest, OwnServerDeploymentResult, OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';

type BuildSecretRevision = NonNullable<OwnServerDeploymentDetailsV1['buildSecretRevisions']>[number];
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
const imageKey = (service: string, platform: string) => JSON.stringify([service, normalizeNativeComposePlatform(platform)]);
const orderBindings = (bindings: BuildSecretRevision['bindings']) => [...bindings].sort((a, b) =>
    a.ref.localeCompare(b.ref) || a.resourceRevision - b.resourceRevision);
const requiredServicePlatforms = (basis: OwnServerDeploymentDetailsV1['approvedInputBasis']) => [...new Map(
    (basis.runtimeProjections ?? []).flatMap(projection => projection.servicePlatforms
        ?? projection.services.map(service => ({ service, platform: projection.platform })))
        .map(pair => [imageKey(pair.service, pair.platform), pair] as const)).values()];
const imagesForArchiveDistribution = (images: readonly DeploymentImageV1[], basis: OwnServerDeploymentDetailsV1['approvedInputBasis']) => {
    const registries = basis.bindings.flatMap(binding => binding.purpose === 'registry' && binding.targetLinkId === basis.targetLinkId
        ? [{ origin: binding.registryOrigin, access: binding.access }] : []);
    return images.filter(image => !resolveNativeComposeImageDistributionRegistry(image, registries));
};

/** Reviewed pins identify bytes, not their presence in the runtime image store.
 * Every reviewed runtime uses the admitted preparation stage for image custody,
 * including a prebuilt image on the same Machine as its builder. */
export function requiresOwnServerBuildReceipt(content: DeploymentOwnServerContentV1): boolean {
    const basis = content.ownServer?.approvedInputBasis;
    return !!basis?.buildServices?.length || !!basis?.runtimeProjections?.length;
}

/** The signed builder stage requires exact reviewed images and archive custody
 * only for archive distribution. Controller ACK recovery uses this owner. */
export function isOwnServerBuildReceiptComplete(content: DeploymentOwnServerContentV1): boolean {
    const ownServer = content.ownServer;
    const basis = ownServer?.approvedInputBasis;
    if (!basis?.runtimeProjections?.length || !ownServer?.buildSecretRevisions) return false;
    const expected = new Set(requiredServicePlatforms(basis).map(pair => imageKey(pair.service, pair.platform)));
    if (content.images.length !== expected.size || content.images.some(image => !expected.delete(imageKey(image.service, image.platform)))
        || expected.size !== 0) return false;
    const revisions = ownServer.buildSecretRevisions;
    const buildServices = basis.buildServices ?? [];
    // The native build graph may also build cache-only dependencies. Preserve
    // their secret history without demanding an unrequested output archive.
    if ((!buildServices.length && revisions.length) || new Set(revisions.map(row => row.service)).size !== revisions.length
        || revisions.some(row => row.machineId !== content.buildMachineId || row.installationId !== revisions[0]?.installationId)
        || buildServices.some(service => !revisions.some(row => row.service === service))) return false;
    const archiveImages = imagesForArchiveDistribution(content.images, basis);
    if (!archiveImages.length) return true;
    // Older receipts may also retain registry image archives. Those are not
    // prerequisites for distribution and need not be re-exported or adopted.
    const archives = (ownServer.imageArchives ?? []).filter(archive => archiveImages.some(image =>
        imageKey(image.service, image.platform) === imageKey(archive.image.service, archive.image.platform)));
    const installationId = revisions[0]?.installationId ?? archives[0]?.holder.installationId;
    if (!installationId || revisions.some(row => row.installationId !== installationId)) return false;
    return archives.length === archiveImages.length && archiveImages.every(image => archives.filter(archive =>
        isDeepStrictEqual(archive.image, image) && archive.holder.machineId === content.buildMachineId
        && archive.holder.installationId === installationId).length === 1);
}

/** One admitted build leg of the existing receipt operation; no independent
 * receipt admission, image distribution policy or native execution owner. */
export async function buildOwnServerDeploymentReceipt(host: OwnServerDeploymentTargetHostInput,
    request: OwnServerDeploymentRequest, admitted?: Readonly<{
        environment: DeploymentEnvironmentDetailV1; receipt: OwnServerDeploymentReceipt;
    }>): Promise<OwnServerDeploymentResult> {
    const signal = host.signal && request.context.signal ? AbortSignal.any([host.signal, request.context.signal])
        : host.signal ?? request.context.signal ?? new AbortController().signal;
    try {
        const read = async () => {
            signal.throwIfAborted();
            if (request.input.serverId !== host.serverId || request.receipt.environmentId !== request.input.environmentId) refuse('target_mismatch');
            const [environment, receipt] = await Promise.all([
                admitted?.environment ?? host.readEnvironment({ environmentId: request.input.environmentId, context: request.context }),
                admitted?.receipt ?? host.readReceipt({ environmentId: request.input.environmentId, deploymentId: request.receipt.deploymentId, context: request.context }),
            ]);
            signal.throwIfAborted();
            const link = environment.targetLinks.find(item => item.targetLink.id === request.input.targetLinkId)?.targetLink;
            if (!link || environment.environment.id !== request.input.environmentId
                || link.revision !== request.input.expectedTargetLinkRevision) refuse('target_mismatch');
            if (request.context.operationAcceptance?.operationId !== receipt.deployment.actionOperationId) refuse('operation_unavailable');
            if (request.actionId === 'deployments.rollback') refuse('unsupported_action');
            admitOwnServerDeploymentTargetLink(link, host.machineId, host.machineId);
            const content = DeploymentOwnServerContentV1Schema.parse(receipt.content);
            admitOwnServerDeploymentSource(environment, content.sourceIntent);
            const basis = content.ownServer?.approvedInputBasis;
            if (!basis?.runtimeProjections?.length) refuse('invalid_parameters');
            return { environment, receipt, content, basis, link, deployment: receipt.deployment };
        };
        let initial = await read();
        const approvedInputBasis = initial.basis;
        const assertApprovedInput = (content: DeploymentOwnServerContentV1) => {
            const basis = content.ownServer?.approvedInputBasis;
            if (!basis || !isDeepStrictEqual(basis, approvedInputBasis)
                || basis.environmentId !== initial.environment.environment.id || basis.environmentRevision !== request.input.expectedRevision
                || basis.targetLinkId !== initial.link.id || basis.targetLinkRevision !== initial.link.revision
                || !isDeepStrictEqual(basis.bindings, initial.environment.content.bindings) || !isDeepStrictEqual(basis.sourceIntent, content.sourceIntent)
                || !isDeepStrictEqual(content.machines, initial.link.machines)
                || !isDeepStrictEqual(basis.members, initial.link.members.map(({ machineId, installationId }) => ({ machineId, installationId })))
                || !isDeepStrictEqual(basis.ownServer, initial.environment.content.ownServer)) refuse('deployment_conflict');
        };
        assertApprovedInput(initial.content);
        if (isOwnServerBuildReceiptComplete(initial.content)) return { ok: true, environmentId: initial.receipt.deployment.environmentId,
            revision: initial.environment.environment.revision, deploymentId: initial.receipt.deployment.id,
            deploymentRevision: initial.receipt.deployment.revision, state: 'running' };
        if (!isDeepStrictEqual(initial.content.images, initial.basis.images)) refuse('outcome_unknown');
        if (initial.basis.buildServices?.length && initial.content.sourceIntent.kind !== 'repository') refuse('needs_repository');
        const runtime = await host.runtime.acquire({ ...request, executionRole: 'build',
            materialization: { kind: 'deployment', deploymentId: initial.receipt.deployment.id } }, { ...initial, readReferenceEnvironment: host.readEnvironment });
        let stageOutput: Awaited<ReturnType<typeof openOwnServerDeploymentStageLog>> | undefined;
        try {
            const assertCurrent = async () => {
                signal.throwIfAborted();
                await runtime.assertCurrent();
                signal.throwIfAborted();
            };
            await assertCurrent();
            const expectedIdentity = await resolveOwnServerDeploymentIdentityForHost({
                happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: initial.environment.environment.id });
            if (!runtime.buildExecutionDirectory || runtime.source.environmentId !== initial.environment.environment.id
                || runtime.source.environmentInstanceId !== expectedIdentity.environmentInstanceId
                || runtime.source.deploymentId !== initial.receipt.deployment.id || runtime.source.machineId !== host.machineId
                || runtime.source.installationId !== initial.deployment.acceptedExecution?.builder?.installationId
                || (initial.content.sourceIntent.kind === 'repository'
                    ? runtime.source.definition !== undefined || runtime.source.commitSha !== initial.content.sourceIntent.sha
                    : !isDeepStrictEqual(runtime.source.definition, initial.content.sourceIntent))) refuse('target_mismatch');
            const previousLog = initial.content.ownServer?.stageLogs?.find(log => log.machineId === host.machineId
                && log.installationId === runtime.source.installationId);
            stageOutput = await openOwnServerDeploymentStageLog({ deploymentRoot: runtime.source.deploymentRoot,
                environmentInstanceId: runtime.source.environmentInstanceId, deploymentId: initial.receipt.deployment.id,
                machineId: host.machineId, installationId: runtime.source.installationId,
                ...(previousLog ? { expected: previousLog } : {}), async onProvenance(provenance) {
                    const content = captureOwnServerDeploymentStageLog(initial.content, { provenance });
                    const written = await host.writeTransition({ environmentId: initial.receipt.deployment.environmentId,
                        deploymentId: initial.receipt.deployment.id, receiptHeader: initial.deployment,
                        expectedRevision: initial.receipt.deployment.revision, state: 'running', content, context: request.context });
                    if (!written.ok) refuse(written.errorCode);
                    const deployment = { ...initial.deployment, revision: written.deploymentRevision };
                    initial = { ...initial, content, deployment, receipt: { ...initial.receipt, content, deployment } };
                } });
            const sourceOutput = stageOutput;
            const source = await createDeploymentSourceMaterializationPort({ admit: async () => ({ ...runtime.source,
                assertCurrent: runtime.assertSourceCurrent }),
                onProgress: phase => recordDeploymentSourceProgress(sourceOutput, request.context, phase) })
                .materialize({ environmentId: initial.environment.environment.id, deploymentId: initial.receipt.deployment.id,
                    expectedManifestFingerprint: initial.basis.manifestFingerprint }, { signal });
            let committed = false;
            try {
                const sourceProvenance = await captureOwnServerDeploymentSource({ source, admission: runtime.source });
                const commitSubject = readDeploymentSourceCommitSubjectForHost(source);
                const admittedContent = DeploymentOwnServerContentV1Schema.parse(captureOwnServerDeploymentStageLog({ ...initial.content,
                    ...(commitSubject === undefined ? {} : { commitSubject }), ownServer: {
                    ...initial.content.ownServer,
                    approvedInputBasis: initial.basis,
                    sources: replaceOwnServerDeploymentSource(initial.content.ownServer?.sources, sourceProvenance),
                } }, stageOutput));
                if (!isDeepStrictEqual(initial.content, admittedContent)) {
                    await assertCurrent();
                    const registered = await host.writeTransition({ environmentId: initial.environment.environment.id,
                        deploymentId: initial.receipt.deployment.id, expectedRevision: initial.receipt.deployment.revision,
                        receiptHeader: initial.deployment,
                        state: 'running', content: admittedContent, context: request.context });
                    if (!registered.ok) refuse(registered.errorCode);
                    const deployment = { ...initial.deployment, revision: registered.deploymentRevision };
                    initial = { ...initial, content: admittedContent, deployment,
                        receipt: { ...initial.receipt, content: admittedContent, deployment } };
                }
                const registryUses = initial.environment.content.bindings.flatMap(binding =>
                    binding.purpose === 'registry' && binding.targetLinkId === initial.link.id ? [binding] : []);
                const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'build',
                    signal, isCurrent: () => !signal.aborted,
                    prepare: ({ phase }: Readonly<{ phase: 'build' | 'runtime' }>) => prepareEnvironmentSecretBindingsForLaunch({ ...runtime.secrets,
                        environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                        phase, bindings: initial.environment.content.bindings, registryUses, assertCurrent }) });
                const compose = initial.content.sourceIntent.kind === 'repository' ? initial.content.sourceIntent.compose
                    : { ...initial.content.sourceIntent, path: 'compose.yaml' };
                await stageOutput.beginStep({ stepId: 'build' });
                const project = createNativeComposeLifecycle({ kind: 'environmentProject', phase: 'build',
                    executionDirectory: runtime.buildExecutionDirectory, exec: runtime.exec, envPort, source,
                    files: [compose.path], profiles: compose.profiles, services: initial.basis.services,
                    physicalProjectName: initial.basis.physicalProjectName, sourceKind: initial.content.sourceIntent.kind, images: initial.content.images,
                    imageAcquisition: createOwnServerNativeImageAcquisition({ runtime, source,
                        environment: initial.environment.content, targetLinkId: initial.link.id, operation: 'deploy', signal, assertCurrent }),
                    io: runtime.nativeIo, stageOutput, settleNative: runtime.settleNative });
                try {
                    const servicePlatforms = requiredServicePlatforms(initial.basis);
                    const described = await project.describeBuild({ servicePlatforms, signal });
                    if (!isDeepStrictEqual(described.basis, { manifestFingerprint: initial.basis.manifestFingerprint,
                        configInputDigests: initial.basis.configInputDigests, physicalProjectName: initial.basis.physicalProjectName,
                        toolVersion: initial.basis.toolVersion }) || !isDeepStrictEqual(described.services, initial.basis.services)
                        || !isDeepStrictEqual(described.buildServices, initial.basis.buildServices ?? [])) refuse('deployment_conflict');
                    const buildBindings = initial.environment.content.bindings.filter(binding =>
                        binding.purpose === 'variable' && binding.phase === 'build' && binding.source.kind === 'secret');
                    const revisions: BuildSecretRevision[] = described.buildSecretVariables.map(({ service, names }) => ({ service,
                        machineId: source.machineId, installationId: source.installationId,
                        bindings: orderBindings(buildBindings.flatMap(binding => binding.purpose === 'variable'
                            && binding.source.kind === 'secret' && names.includes(binding.name)
                            ? [{ ref: binding.source.ref, resourceRevision: binding.source.resourceRevision }] : []).filter((binding, index, all) =>
                            all.findIndex(other => isDeepStrictEqual(other, binding)) === index)) }));
                    const previous = new Map<string, BuildSecretRevision>();
                    if (revisions.length > 0 && !host.readBuildHistory) refuse('deployment_executor_unavailable');
                    if (revisions.length > 0) for await (const historical of host.readBuildHistory!({ environmentId: source.environmentId,
                        targetLinkId: initial.link.id, environment: initial.environment, context: request.context })) {
                        if (historical.deployment.id === initial.receipt.deployment.id) continue;
                        for (const row of historical.content.ownServer?.buildSecretRevisions ?? []) {
                            if (row.machineId === source.machineId && row.installationId === source.installationId
                                && revisions.some(current => current.service === row.service) && !previous.has(row.service)) previous.set(row.service, row);
                        }
                        if (previous.size === revisions.length) break;
                    }
                    const noCacheServices = revisions.filter(row => previous.has(row.service)
                        ? !isDeepStrictEqual(orderBindings(previous.get(row.service)!.bindings), row.bindings) : row.bindings.length > 0).map(row => row.service);
                    const { images, imageArchives } = await machineNativeEffectAdmission.run({
                        operation: { operationId: initial.receipt.deployment.actionOperationId, kind: request.actionId, signal },
                        keys: described.keys, settleNative: project.settleNative,
                    }, async context => {
                        const images = await project.prepareImages({ servicePlatforms,
                            build: { noCacheServices, secretVariableNames: buildBindings.flatMap(binding => binding.purpose === 'variable' ? [binding.name] : []) },
                            signal, context });
                        for (const image of images) {
                            if (described.buildServices.includes(image.service)) continue;
                            const approved = initial.basis.images.filter(value => value.service === image.service);
                            if (!approved.some(value => isDeepStrictEqual(value, image)
                                || value.indexDigest !== undefined && value.indexDigest === image.indexDigest)) refuse('deployment_conflict');
                        }
                        const archives = await project.exportImages({ images: imagesForArchiveDistribution(images, initial.basis), signal, context });
                        const imageArchives = await adoptOwnServerImageArchives({ archives, admission: runtime.source,
                            serverId: expectedIdentity.homeServerIdentityId, signal, assertCurrent });
                        return { images, imageArchives };
                    });
                    const content = DeploymentOwnServerContentV1Schema.parse({ ...initial.content, images, ownServer: {
                        ...initial.content.ownServer, imageArchives, buildSecretRevisions: revisions } });
                    if (!isOwnServerBuildReceiptComplete(content)) refuse('deployment_image_unavailable');
                    await assertCurrent();
                    const latest = await host.readReceipt({ environmentId: source.environmentId,
                        deploymentId: source.deploymentId, context: request.context });
                    signal.throwIfAborted();
                    assertApprovedInput(latest.content);
                    await source.commit(); committed = true;
                    return await host.writeTransition({ environmentId: source.environmentId, deploymentId: source.deploymentId,
                        receiptHeader: initial.deployment,
                        expectedRevision: initial.receipt.deployment.revision, state: 'running',
                        content: captureOwnServerDeploymentStageLog(content, stageOutput), context: request.context });
                } finally { await project.dispose(); }
            } finally { if (!committed) await source.abort(); }
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_failed';
            const captured = captureOwnServerDeploymentStageLog(initial.content, stageOutput);
            const written = await host.writeTransition({ environmentId: initial.receipt.deployment.environmentId,
                deploymentId: initial.receipt.deployment.id, receiptHeader: initial.deployment,
                expectedRevision: initial.receipt.deployment.revision, state: 'running',
                content: { ...captured, failure: { code, phase: 'build' } }, context: request.context });
            if (!written.ok) return written;
            throw error;
        } finally {
            try { await stageOutput?.close(); }
            finally { await runtime.release(); }
        }
    } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_failed';
        const errorCode = code === 'outcome_unknown' || isProjectNativeProcessUncertain(error) ? 'outcome_unknown'
            : signal.aborted ? 'cancelled' : code;
        return { ok: false, errorCode, error: errorCode };
    }
}
