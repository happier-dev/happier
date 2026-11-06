import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { isDeepStrictEqual } from 'node:util';
import type { DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { DeploymentOwnServerContentV1Schema, OwnServerDeploymentInputBasisV1Schema, getDeploymentTargetLinkLineageV1, environmentSecretBindingIdentityV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentEnvironmentDetailV1, OwnServerDeploymentInputBasisV1, OwnServerDeploymentRuntimeProjectionV1, DeploymentMachineResultV1 } from '@happier-dev/deployment-protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol';
import { type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { configuration } from '@/configuration';
import { createDeploymentExecEnvPortForHost, createDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { attachDeploymentServiceHealthNotices } from '@/deployments/deploymentServiceHealthNotices';
import { createDeploymentSettlementNotices } from '@/deployments/deploymentSettlementNotices';
import { createNativeComposeLifecycle, type NativeComposeActivatedProject, type NativeComposeEnvironmentProject, type NativeComposeProjectRender } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { normalizeNativeComposePlatform } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { produceEnvironmentProjectServices } from '@/daemon/local/services/launch/projectDeclarations';
import { machineNativeEffectAdmission, MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { isProjectNativeProcessUncertain } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { createDeploymentSourceMaterializationPort, readDeploymentSourceCommitSubjectForHost } from './exactCommitRelease';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createOwnServerNativeImageAcquisition } from './nativeImageAcquisition';
import { admitOwnServerDeploymentSource, admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';
import { isOwnServerBuildReceiptComplete } from './buildReceipt';
import { projectOwnServerDeploymentReview } from './ownServerDeploymentReview';
import { captureOwnServerDeploymentStageLog, openOwnServerDeploymentStageLog } from './stageLog';
import { recordDeploymentSourceProgress } from './sourceOperationLog';
import { createOwnServerSourceRetention } from './releaseRetention';
import { readDeploymentUniformTargetLinkRevisionV1 } from '@/deployments/deploymentUniformProof';
import { logger } from '@/ui/logger';
import { admitOwnServerMigration, executeOwnServerMigration, MIGRATION_STEP } from './migration';
import { captureOwnServerDeploymentSource, createOwnServerSourceCustodyReader, replaceOwnServerDeploymentSource } from './sourceProvenance';
import { executeOwnServerNativeRestore, observeOwnServerNativeRestoreDestination } from './nativeRestore';
export { admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';
import { executeOwnServerRollout, recordOwnServerCandidateCleanup, projectOwnServerCandidateCleanupFailure, OWN_SERVER_CANDIDATE_CLEANUP_STEP_ID } from './ownServerRollout';
import type { OwnServerDeploymentRequest, OwnServerDeploymentReviewRequest, OwnServerDeploymentRuntimeRequest, OwnServerDeploymentResult, OwnServerDeploymentReview,
    OwnServerDeploymentTargetForHost, OwnServerDeploymentTargetHostInput, OwnServerDeploymentMemberRequest,
    OwnServerDeploymentMemberReviewRequest, OwnServerDeploymentRuntimeAcquisition, OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';

function refuse(reason: string | ActionExecuteFailure): never {
    const code = typeof reason === 'string' ? reason : reason.errorCode;
    throw Object.assign(new Error(code, typeof reason === 'string' ? undefined : { cause: reason }), { code });
}
const failure = projectDeploymentFailure;
const codeOf = (error: unknown) => error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_failed';
const failureCode = (error: unknown, aborted: boolean) => {
    const code = codeOf(error);
    return code === 'outcome_unknown' || isProjectNativeProcessUncertain(error) ? code : aborted ? 'cancelled' : code;
};

/** The sole own-server effect executor, called by the existing Action dependency. */
export function createOwnServerDeploymentExecutor(host: OwnServerDeploymentTargetHostInput): OwnServerDeploymentTargetForHost {
    const publishSettlementNotice = createDeploymentSettlementNotices(host);
    const sourceRetention = createOwnServerSourceRetention(host);
    const retain: OwnServerDeploymentTargetForHost['retain'] = async input => {
        try { return await sourceRetention.retain(input); }
        catch (error) { return failure(failureCode(error, input.request.context.signal?.aborted === true), error); }
    };
    async function readEnvironment(request: Omit<OwnServerDeploymentRequest, 'receipt'>, revision: number | undefined,
        capturedControllerMachineId?: string, observedEnvironment?: DeploymentEnvironmentDetailV1) {
        const signal = host.signal && request.context.signal ? AbortSignal.any([host.signal, request.context.signal])
            : host.signal ?? request.context.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        if (request.input.serverId !== host.serverId) refuse('target_mismatch');
        const environment = observedEnvironment ?? await host.readEnvironment({ environmentId: request.input.environmentId, context: request.context });
        signal.throwIfAborted();
        const link = environment.targetLinks.find(item => item.targetLink.id === request.input.targetLinkId)?.targetLink;
        if (!link || revision !== undefined && (environment.environment.revision !== revision
            || link.revision !== request.input.expectedTargetLinkRevision)) {
            const conflict = failure('deployment_conflict', new Error('deployment_conflict'));
            // An explicit reviewed revision is checked before native preparation/dispatch.
            // Execution reads omit it, so they cannot prove that no effect started.
            refuse(revision === undefined ? conflict : { ...conflict, effectAttempted: false });
        }
        admitOwnServerDeploymentTargetLink(link, host.machineId,
            host.dispatchMember ? capturedControllerMachineId ?? environment.environment.controllerMachineId : undefined);
        return { environment, link, signal };
    }

    async function read(request: OwnServerDeploymentRequest, phase: OwnServerDeploymentMemberRequest['phase'] = 'activate',
        admitted?: OwnServerDeploymentMemberRequest['admitted']) {
        request.context.signal?.throwIfAborted();
        host.signal?.throwIfAborted();
        const [environment, receipt] = await Promise.all([
            admitted?.environment ?? host.readEnvironment({ environmentId: request.input.environmentId, context: request.context }),
            admitted?.receipt ?? host.readReceipt({ environmentId: request.input.environmentId,
                deploymentId: request.receipt.deploymentId, context: request.context }),
        ]);
        const accepted = receipt.deployment.acceptedExecution;
        if (!accepted || receipt.content.buildMachineId !== accepted.builder?.machineId) refuse('target_mismatch');
        const snapshot = await readEnvironment(request, undefined, accepted.controller.machineId, environment);
        snapshot.signal.throwIfAborted();
        // The admitted server reader binds receipt/header/slot identity. This
        // owner still validates the decrypted plan and derives local operation
        // custody before native work; it does not repeat that server verdict.
        if (!host.dispatchMember && (receipt.content.machines.length !== 1
            || receipt.content.machines[0] !== host.machineId || receipt.content.buildMachineId !== host.machineId)) refuse('unsupported');
        if (!isDeepStrictEqual(receipt.content.machines, snapshot.link.machines)) refuse('deployment_conflict');
        if (request.context.operationAcceptance?.operationId !== receipt.deployment.actionOperationId) refuse('operation_unavailable');
        if (phase === 'activate' && request.actionId !== 'deployments.rollback') admitOwnServerDeploymentSource(snapshot.environment, receipt.content.sourceIntent);
        const approved = receipt.content.ownServer?.approvedInputBasis;
        if (phase === 'activate' && approved && (!isDeepStrictEqual(approved.bindings, snapshot.environment.content.bindings)
            || !isDeepStrictEqual(approved.ownServer, snapshot.environment.content.ownServer)
            || request.actionId !== 'deployments.rollback'
                && !isDeepStrictEqual(approved.health, snapshot.environment.content.template?.health))) refuse('deployment_conflict');
        return { ...snapshot, receipt, content: receipt.content, deployment: receipt.deployment };
    }

    type Snapshot = Awaited<ReturnType<typeof readEnvironment>> & Readonly<{ content: OwnServerDeploymentReceipt['content'];
        deployment?: OwnServerDeploymentReceipt['deployment']; servingReceipt?: OwnServerDeploymentReceipt | null }>;
    type StageOutput = Awaited<ReturnType<typeof openOwnServerDeploymentStageLog>>;
    async function openMemberStageOutput(request: OwnServerDeploymentRequest, receipt: OwnServerDeploymentReceipt,
        runtime: OwnServerDeploymentRuntimeAcquisition, onProvenance: NonNullable<Parameters<typeof openOwnServerDeploymentStageLog>[0]['onProvenance']>) {
        if (!receipt.content.ownServer) refuse('invalid_parameters');
        const expected = receipt.content.ownServer.stageLogs?.find(log => log.machineId === host.machineId);
        const output = await openOwnServerDeploymentStageLog({ deploymentRoot: runtime.source.deploymentRoot,
            environmentInstanceId: runtime.source.environmentInstanceId, deploymentId: receipt.deployment.id,
            machineId: host.machineId, installationId: runtime.source.installationId, expected, onProvenance });
        try {
            if (expected) return { output, receipt };
            const content = DeploymentOwnServerContentV1Schema.parse({ ...receipt.content, ownServer: { ...receipt.content.ownServer,
                stageLogs: [...(receipt.content.ownServer.stageLogs ?? []), output.provenance] } });
            const written = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
                deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state: 'running',
                content, context: request.context });
            if (!written.ok) refuse(written);
            // Home's successful CAS is authoritative. Artifact versions remain
            // Home-owned; this invocation needs only its new receipt revision.
            return { output, receipt: { ...receipt, content,
                deployment: { ...receipt.deployment, revision: written.deploymentRevision } } };
        } catch (error) { await output.close(); throw error; }
    }
    async function prepare(request: OwnServerDeploymentRuntimeRequest, snapshot: Snapshot,
        captureOutput?: (runtime: OwnServerDeploymentRuntimeAcquisition) => Promise<StageOutput>) {
        const { environment, content, link, signal } = snapshot;
        const nativeOrigin = environment.targetLinks.find(row => row.targetLink.id === link.id)?.content?.nativeOrigin;
        if (nativeOrigin?.capture && !link.members.some(member => member.installationId === nativeOrigin.capture!.installationId)) refuse('target_mismatch');
        const sourceIntent = content.sourceIntent;
        let rollbackReceipt: OwnServerDeploymentReceipt | undefined;
        if (request.materialization.kind === 'restoration') {
            const retained = await host.readReceipt({ environmentId: environment.environment.id,
                deploymentId: request.materialization.sourceDeploymentId, context: request.context });
            if (!isDeepStrictEqual(retained.content.sourceIntent, sourceIntent)
                || !isDeepStrictEqual(retained.content.images, content.images)) refuse('target_mismatch');
        } else if (request.actionId === 'deployments.rollback') {
            if (!('deploymentId' in request.input)) refuse('invalid_parameters');
            const retained = await host.readReceipt({ environmentId: environment.environment.id,
                deploymentId: request.input.deploymentId, context: request.context });
            signal.throwIfAborted();
            if (retained.deployment.id !== request.input.deploymentId
                || retained.deployment.environmentId !== environment.environment.id
                || !isDeepStrictEqual(retained.content.sourceIntent, sourceIntent)
                || !isDeepStrictEqual(retained.content.images, content.images)) refuse('target_mismatch');
            rollbackReceipt = retained;
        } else if (sourceIntent.kind === 'stored') {
            if (request.actionId === 'deployments.deploy' || request.actionId === 'deployments.promote') {
                admitOwnServerDeploymentSource(environment, sourceIntent);
                if (request.actionId === 'deployments.promote') {
                    if (!('sourceDeploymentId' in request.input) || request.input.artifact !== 'image') refuse('unsupported');
                    const retained = await host.readReceipt({ environmentId: request.input.sourceEnvironmentId,
                        deploymentId: request.input.sourceDeploymentId, context: request.context });
                    if (retained.deployment.id !== request.input.sourceDeploymentId
                        || retained.deployment.environmentId !== request.input.sourceEnvironmentId
                        || !isDeepStrictEqual(retained.content.images, content.images)) refuse('target_mismatch');
                }
            }
        }
        const compose = sourceIntent.kind === 'repository' ? sourceIntent.compose : { path: 'compose.yaml', ...sourceIntent };
        const materializationId = request.materialization.kind === 'review' ? request.materialization.contentArtifactId
            : request.materialization.kind === 'restoration' ? request.materialization.sourceDeploymentId : request.materialization.deploymentId;
        const runtime = await host.runtime.acquire(request, { environment, content, readReferenceEnvironment: host.readEnvironment,
            ...(snapshot.deployment ? { deployment: snapshot.deployment } : {}) });
        let stageOutput: StageOutput | undefined;
        try {
            const assertCurrent = async () => {
                signal.throwIfAborted();
                await runtime.assertCurrent();
                signal.throwIfAborted();
            };
            await assertCurrent();
            const expectedIdentity = await resolveOwnServerDeploymentIdentityForHost({
                happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: environment.environment.id });
            if (runtime.source.environmentId !== environment.environment.id || runtime.source.environmentInstanceId
                !== expectedIdentity.environmentInstanceId
                || runtime.source.deploymentId !== materializationId || runtime.source.machineId !== host.machineId
                || (sourceIntent.kind === 'repository' ? runtime.source.definition !== undefined || runtime.source.commitSha !== sourceIntent.sha
                    : !isDeepStrictEqual(runtime.source.definition, sourceIntent))
                || !link.members.some(member => member.machineId === host.machineId && member.installationId === runtime.source.installationId)) refuse('target_mismatch');
            stageOutput = await captureOutput?.(runtime);
            const sourceOutput = stageOutput;
            const sourcePort = createDeploymentSourceMaterializationPort({ admit: async () => ({ ...runtime.source,
                ...(stageOutput && request.materialization.kind === 'deployment' ? { operationLog: true } : {}),
                assertCurrent: runtime.assertSourceCurrent }),
                ...(sourceOutput ? { onProgress: phase => recordDeploymentSourceProgress(sourceOutput, request.context, phase) } : {}),
            });
            const source = await sourcePort.materialize({ environmentId: environment.environment.id, deploymentId: materializationId,
                ...(request.materialization.kind === 'deployment' && content.ownServer
                    ? { expectedManifestFingerprint: content.ownServer.approvedInputBasis.manifestFingerprint } : {}) }, { signal });
            try {
                const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal,
                    isCurrent: () => !signal.aborted,
                    prepare: ({ phase }: Readonly<{ phase: 'build' | 'runtime' }>) => prepareEnvironmentSecretBindingsForLaunch({ ...runtime.secrets,
                        environmentId: environment.environment.id, machineId: host.machineId, installationId: source.installationId,
                        phase, bindings: environment.content.bindings, assertCurrent }),
                });
                const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec: runtime.exec, envPort, source,
                    files: [compose.path], profiles: compose.profiles, services: compose.services, sourceKind: sourceIntent.kind,
                    ...(nativeOrigin && (!nativeOrigin.capture || nativeOrigin.capture.installationId === runtime.source.installationId)
                        ? { physicalProjectName: nativeOrigin.projectName, expectedEngineId: nativeOrigin.dockerEndpoint } : {}),
                    // Review a new deployment's current policy. Execution and
                    // restoration consume only their exact captured receipt;
                    // an old absent policy never borrows today's template.
                    health: request.materialization.kind === 'review' && request.actionId !== 'deployments.rollback'
                        ? environment.content.template?.health : content.ownServer?.approvedInputBasis.health,
                    images: content.images, io: runtime.nativeIo, settleNative: runtime.settleNative,
                    ...(stageOutput ? { stageOutput } : {}),
                    storage: { runtimeMachineCount: link.machines.length,
                        ...(sourceIntent.kind === 'repository' ? { sharedData: {
                            environmentRoot: join(runtime.source.deploymentRoot, source.environmentInstanceId),
                            bindings: content.ownServer?.sources?.filter(value => value.role === 'runtime'
                                && value.machineId === host.machineId && value.installationId === source.installationId)
                                .flatMap(value => value.sharedBinds),
                            readSourceCustody: createOwnServerSourceCustodyReader({
                                deploymentRoot: runtime.source.deploymentRoot, environmentInstanceId: source.environmentInstanceId,
                                environmentId: environment.environment.id,
                                machineId: host.machineId, installationId: source.installationId, assertCurrent,
                                ...(request.materialization.kind === 'review' ? { readIncumbentReceipt: async (
                                    nativeIncumbentSource: NonNullable<DeploymentChildExecutionProofV1['nativeIncumbentSource']>,
                                ) => {
                                    await assertCurrent();
                                    return host.readReceipt({ environmentId: environment.environment.id,
                                        deploymentId: nativeIncumbentSource.restorationForDeploymentId ?? nativeIncumbentSource.sourceDeploymentId,
                                        nativeIncumbentSource, context: request.context });
                                } } : {}),
                                history: request.materialization.kind === 'review' ? (async function* () {
                                    if (rollbackReceipt) yield rollbackReceipt;
                                    if (snapshot.servingReceipt && snapshot.servingReceipt.deployment.id !== rollbackReceipt?.deployment.id) {
                                        yield snapshot.servingReceipt;
                                    }
                                })() : host.readBuildHistory?.({ environmentId: environment.environment.id,
                                    targetLinkId: link.id, context: request.context }) ?? (async function* () {})(),
                            }),
                        } } : {}) },
                    imageAcquisition: createOwnServerNativeImageAcquisition({ runtime, source, environment: environment.content,
                        imageArchives: content.ownServer?.imageArchives,
                        targetLinkId: link.id, operation: request.actionId === 'deployments.rollback'
                            || request.materialization.kind === 'restoration' ? 'rollback' : 'deploy',
                        signal, assertCurrent }) });
                return { runtime, source, project, assertCurrent, stageOutput,
                    homeServerIdentityId: expectedIdentity.homeServerIdentityId };
            } catch (error) { await source.abort(); throw error; }
        } catch (error) { try { await runtime.release(); } finally { await stageOutput?.close(); } throw error; }
    }

    function basis(request: Omit<OwnServerDeploymentRequest, 'receipt'>, snapshot: Snapshot, native: Readonly<{
        basis: Readonly<{ manifestFingerprint: string; configInputDigests: readonly Readonly<{ path: string; digest: string }>[];
            physicalProjectName: string; toolVersion: string; nativeGeneration?: OwnServerDeploymentInputBasisV1['nativeGeneration'] }>;
        services: readonly string[];
        platform: string;
        servicePlatforms: readonly Readonly<{ service: string; platform: string }>[];
        buildServices: readonly string[];
        health?: OwnServerDeploymentInputBasisV1['health'];
    }>): OwnServerDeploymentInputBasisV1 {
        return OwnServerDeploymentInputBasisV1Schema.parse({ v: 1, environmentId: snapshot.environment.environment.id,
            environmentRevision: request.input.expectedRevision, targetLinkId: snapshot.link.id, targetLinkRevision: snapshot.link.revision,
            sourceIntent: snapshot.content.sourceIntent, ...native.basis, services: native.services,
            servicePlatforms: native.servicePlatforms,
            ...(native.health ? { health: native.health } : {}),
            profiles: snapshot.content.sourceIntent.kind === 'repository' ? snapshot.content.sourceIntent.compose.profiles : snapshot.content.sourceIntent.profiles,
            members: snapshot.link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
            bindings: snapshot.environment.content.bindings, images: snapshot.content.images,
            ...(native.buildServices.length ? { buildServices: native.buildServices } : {}),
            ...(snapshot.environment.content.ownServer ? { ownServer: snapshot.environment.content.ownServer } : {}) });
    }

    async function reviewLocal(request: OwnServerDeploymentReviewRequest): Promise<OwnServerDeploymentReview> {
        const content = DeploymentOwnServerContentV1Schema.parse(request.content);
        if (!host.dispatchMember && (content.machines.length !== 1 || content.machines[0] !== host.machineId || content.buildMachineId !== host.machineId)) refuse('unsupported');
        const candidateEnvironmentContent = request.candidateEnvironmentContent;
        if (candidateEnvironmentContent && request.actionId !== 'deployments.promote') refuse('invalid_parameters');
        const current = await readEnvironment(request, request.input.expectedRevision, undefined, request.environment);
        const snapshot = { ...current, environment: candidateEnvironmentContent
            ? { ...current.environment, content: candidateEnvironmentContent } : current.environment, content };
        const servingReceipt = current.link.activeDeploymentId ? await host.readReceipt({
            environmentId: current.environment.environment.id, deploymentId: current.link.activeDeploymentId, context: request.context,
        }) : null;
        if (servingReceipt && (servingReceipt.deployment.id !== current.link.activeDeploymentId
            || servingReceipt.deployment.environmentId !== current.environment.environment.id
            || !getDeploymentTargetLinkLineageV1(current.link, current.environment.targetLinks.map(item => item.targetLink))
                .has(servingReceipt.deployment.targetLinkId))) refuse('target_mismatch');
        const prepared = await prepare({ ...request, materialization: { kind: 'review', contentArtifactId: request.input.contentArtifactId } },
            { ...snapshot, servingReceipt });
        try {
            const native = await prepared.project.render({ signal: snapshot.signal });
            await prepared.assertCurrent();
            // Publish basis and preview from the same captured render. The
            // later mutation CAS owns admission of an edited Environment.
            const commitSubject = readDeploymentSourceCommitSubjectForHost(prepared.source);
            const inputBasis = basis(request, snapshot, native);
            return { inputBasis, runtimePlatform: native.platform, reviewedEffect: projectNativeJsonValueForTransport(projectOwnServerDeploymentReview({
                machineId: host.machineId, environment: snapshot.environment, inputBasis, servingReceipt,
                ...(commitSubject === undefined ? {} : { commitSubject }),
                nativeReview: native.review, ...(native.storage ? { storage: native.storage } : {}),
                target: { engine: native.engine.kind, ...presentMachineAuthorityV1({ engine: native.engine.kind }).deployment },
            })) };
        } finally {
            try { await prepared.project.dispose(); } finally { try { await prepared.source.abort(); } finally { await prepared.runtime.release(); } }
        }
    }

    const projection = (machineId: string, installationId: string, value: OwnServerDeploymentInputBasisV1, platform: string): OwnServerDeploymentRuntimeProjectionV1 => ({
        machineId, installationId, manifestFingerprint: value.manifestFingerprint, configInputDigests: value.configInputDigests,
        physicalProjectName: value.physicalProjectName, toolVersion: value.toolVersion, services: value.services, profiles: value.profiles,
        ...(value.nativeGeneration === undefined ? {} : { nativeGeneration: value.nativeGeneration }),
        platform, ...(value.servicePlatforms ? { servicePlatforms: value.servicePlatforms } : {}),
    });
    async function reviewMember(input: OwnServerDeploymentMemberReviewRequest) {
        const current = await readEnvironment(input.request, input.request.input.expectedRevision, undefined, input.request.environment);
        if (input.machineId !== host.machineId || !current.link.members.some(member => member.machineId === host.machineId
            && member.installationId === input.installationId)) refuse('target_mismatch');
        return reviewLocal({ ...input.request, environment: current.environment });
    }
    async function review(request: OwnServerDeploymentReviewRequest): Promise<OwnServerDeploymentReview> {
        if (!host.reviewMember) return reviewLocal(request);
        const current = await readEnvironment(request, request.input.expectedRevision, undefined, request.environment);
        if (current.environment.environment.controllerMachineId !== host.machineId) refuse('target_mismatch');
        const reviews: OwnServerDeploymentReview[] = [];
        for (const member of current.link.members) reviews.push(await host.reviewMember({ request: { ...request, environment: current.environment },
            machineId: member.machineId, installationId: member.installationId }));
        if (!reviews.length) refuse('target_mismatch');
        const firstEffect = reviews[0].reviewedEffect;
        return { runtimePlatform: reviews[0].runtimePlatform, inputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ ...reviews[0].inputBasis,
            runtimeProjections: current.link.members.map((member, index) => projection(member.machineId, member.installationId, reviews[index].inputBasis, reviews[index].runtimePlatform)) }),
            reviewedEffect: projectNativeJsonValueForTransport({ ...(firstEffect !== null && typeof firstEffect === 'object'
                && !Array.isArray(firstEffect) ? firstEffect : {}),
                runtimeMachines: current.link.members.map((member, index) => ({ machineId: member.machineId, review: reviews[index].reviewedEffect })) }) };
    }
    async function stageMember(request: OwnServerDeploymentRequest, row: DeploymentMachineResultV1,
        output?: StageOutput, failureFact?: NonNullable<OwnServerDeploymentReceipt['content']['failure']>,
        commitSubject?: string): Promise<OwnServerDeploymentResult> {
        // Settlement does not launch another effect. The original signed
        // parent CAS still owns admission after finite caller cancellation.
        const receipt = await host.readReceipt({ environmentId: request.input.environmentId,
            deploymentId: request.receipt.deploymentId, context: request.context });
        if (receipt.deployment.state !== 'running') return failure('outcome_unknown');
        const captured = captureOwnServerDeploymentStageLog(receipt.content, output);
        const content = { ...captured, ...(failureFact && !captured.failure ? { failure: failureFact } : {}),
            ...(commitSubject === undefined ? {} : { commitSubject }),
            machineResults: captured.machineResults.some(value => value.machineId === host.machineId)
                ? captured.machineResults.map(value => value.machineId === host.machineId ? row : value) : [...captured.machineResults, row] };
        if (isDeepStrictEqual(receipt.content, content)) return {
            ok: true, environmentId: receipt.deployment.environmentId, revision: request.receipt.revision,
            deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' };
        return host.writeTransition({ environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id,
            receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state: 'running', context: request.context,
            content });
    }
    async function executeMember(input: OwnServerDeploymentMemberRequest): Promise<OwnServerDeploymentResult> {
        const { request } = input;
        try {
            const snapshot = await read(request, input.phase, input.admitted);
            let receipt = snapshot.receipt;
            const publishStageProvenance: NonNullable<Parameters<typeof openOwnServerDeploymentStageLog>[0]['onProvenance']> = async provenance => {
                // The phase writer advances its already-held receipt from the same authoritative CAS result.
                const content = captureOwnServerDeploymentStageLog(receipt.content, { provenance });
                const written = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
                    deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment,
                    expectedRevision: receipt.deployment.revision, state: 'running', content, context: request.context });
                if (!written.ok) refuse(written);
                receipt = { ...receipt, content, deployment: { ...receipt.deployment, revision: written.deploymentRevision } };
            };
            if (input.machineId !== host.machineId || !snapshot.link.members.some(member => member.machineId === host.machineId
                && member.installationId === input.installationId)) refuse('target_mismatch');
            if (receipt.deployment.state !== 'running') return failure('outcome_unknown');
            const migrationAdmitted = input.phase === 'activate' && request.actionId !== 'deployments.rollback'
                && snapshot.environment.content.ownServer?.migration && receipt.content.machines[0] === host.machineId
                ? admitOwnServerMigration(receipt.content.steps) : false;
            const parentApproval = receipt.content.ownServer?.approvedInputBasis;
            if (!parentApproval || snapshot.link.members.length > 1 && !parentApproval.runtimeProjections) refuse('invalid_parameters');
            const previous = receipt.content.machineResults.find(row => row.machineId === host.machineId);
            if (input.phase === 'cleanup') {
                if (input.selectedDeploymentId !== receipt.deployment.id || snapshot.link.activeDeploymentId
                    || receipt.content.onFailure !== 'rollbackAll' || !previous || previous.activation === 'outcome_unknown') refuse('target_mismatch');
                if (previous.steps.some(step => step.id === OWN_SERVER_CANDIDATE_CLEANUP_STEP_ID && step.state === 'succeeded')) return stageMember(request, previous);
                const runtime = await host.runtime.acquire({ ...request, materialization: { kind: 'deployment', deploymentId: receipt.deployment.id } }, { ...snapshot, readReferenceEnvironment: host.readEnvironment });
                let stageOutput: StageOutput | undefined;
                try {
                    await runtime.assertCurrent();
                    const capture = await openMemberStageOutput(request, receipt, runtime, publishStageProvenance);
                    receipt = capture.receipt; stageOutput = capture.output;
                    await stageOutput.beginStep({ stepId: OWN_SERVER_CANDIDATE_CLEANUP_STEP_ID });
                    const services = parentApproval.runtimeProjections?.find(value => value.machineId === host.machineId
                        && value.installationId === input.installationId)?.services ?? parentApproval.services;
                    const { homeServerIdentityId } = await resolveOwnServerDeploymentIdentityForHost({
                        happierHomeDir: configuration.happyHomeDir, serverId: host.serverId,
                        environmentId: receipt.deployment.environmentId });
                    const handles = services.map(composeService => {
                        const environmentInstanceId = runtime.source.environmentInstanceId;
                        const handle = runtime.projectManagedServices.resolveEnvironmentService(homeServerIdentityId, {
                            kind: 'deployment', machineId: host.machineId, environmentId: receipt.deployment.environmentId,
                            environmentInstanceId, composeService, serviceId: `${environmentInstanceId}/${composeService}`,
                        });
                        if (!handle || handle.deploymentId !== receipt.deployment.id
                            || handle.release.installationId !== input.installationId) return refuse('deployment_generation_required');
                        return handle;
                    });
                    if (!handles.length) refuse('deployment_generation_required');
                    for (const handle of handles) {
                        await runtime.assertCurrent();
                        if (!handle.removeNative) refuse('deployment_generation_required');
                        const removed = await handle.removeNative({ operation: { operationId: receipt.deployment.actionOperationId,
                            kind: request.actionId, signal: snapshot.signal }, signal: snapshot.signal, stageOutput });
                        if (removed.state !== 'stopped') refuse('native_service_control_unconfirmed');
                    }
                    return stageMember(request, recordOwnServerCandidateCleanup({ ...previous, currentDeploymentId: undefined, health: 'unknown' }, 'succeeded'));
                } catch (error) {
                    return projectOwnServerCandidateCleanupFailure(failure(failureCode(error, snapshot.signal.aborted), error),
                        message => stageOutput?.appendRedacted('stderr', Buffer.from(`${message}\n`)));
                } finally { try { await runtime.release(); } finally { await stageOutput?.close(); } }
            }
            const restored = input.phase !== 'activate';
            if (!restored && input.selectedDeploymentId !== receipt.deployment.id
                || restored && input.selectedDeploymentId !== snapshot.link.activeDeploymentId) refuse('target_mismatch');
            const selected = restored ? await host.readReceipt({ environmentId: receipt.deployment.environmentId,
                deploymentId: input.selectedDeploymentId, context: request.context }) : receipt;
            if (selected.deployment.environmentId !== receipt.deployment.environmentId
                || selected.deployment.targetLinkId !== receipt.deployment.targetLinkId) refuse('target_mismatch');
            if (restored && (!['succeeded', 'running_unverified'].includes(selected.deployment.state)
                || !selected.content.images.length || !selected.content.ownServer?.approvedInputBasis)) refuse('rollback_image_unavailable');
            // Recovery renders U with U's recorded inputs. An Environment edit
            // cannot substitute new bindings into the retained release.
            const selectedBasis = selected.content.ownServer?.approvedInputBasis;
            const selectedSnapshot = { ...snapshot,
                environment: restored && selectedBasis ? { ...snapshot.environment, content: { ...snapshot.environment.content,
                    bindings: selectedBasis.bindings, ownServer: selectedBasis.ownServer } } : snapshot.environment,
                content: { ...receipt.content, sourceIntent: selected.content.sourceIntent,
                images: selected.content.images, ownServer: selected.content.ownServer } };
            const prepared = await prepare({ ...request, materialization: restored ? { kind: 'restoration',
                deploymentId: receipt.deployment.id, sourceDeploymentId: selected.deployment.id }
                : { kind: 'deployment', deploymentId: receipt.deployment.id } }, selectedSnapshot,
            input.phase === 'observe' ? undefined : async runtime => {
                const capture = await openMemberStageOutput(request, receipt, runtime, publishStageProvenance);
                receipt = capture.receipt;
                return capture.output;
            });
            let committed = false;
            let activated = false;
            let candidate: NativeComposeEnvironmentProject | undefined;
            let retained: Awaited<ReturnType<typeof prepare>> | undefined;
            let retainedProject: NativeComposeEnvironmentProject | undefined;
            let incumbent: NativeComposeActivatedProject | undefined;
            const stage = (row: DeploymentMachineResultV1, failureFact?: NonNullable<OwnServerDeploymentReceipt['content']['failure']>) =>
                stageMember(request, row, prepared.stageOutput, failureFact, readDeploymentSourceCommitSubjectForHost(prepared.source));
            const row = (health: DeploymentMachineResultV1['health']): DeploymentMachineResultV1 => ({
                ...previous, machineId: host.machineId, installationId: input.installationId, steps: previous?.steps ?? [],
                actionOperationId: receipt.deployment.actionOperationId, activation: restored ? previous?.activation ?? 'pending' : 'succeeded',
                currentDeploymentId: restored ? selected.deployment.id : receipt.deployment.id, health,
                ...(input.phase === 'restore' ? { restoration: 'succeeded' as const } : { restoration: undefined }),
            });
            try {
                await prepared.stageOutput?.beginStep({ stepId: input.phase });
                const rendered = await prepared.project.render({ signal: snapshot.signal });
                const local = basis(request, selectedSnapshot, rendered);
                const expected = parentApproval.runtimeProjections?.find(value => value.machineId === host.machineId
                    && value.installationId === input.installationId);
                if (!restored) {
                    const { runtimeProjections: _projections, ...approvedRoot } = parentApproval;
                    const { nativeGeneration: _rootGeneration, ...memberIndependent } = approvedRoot;
                    const expectedRoot = expected ? { ...memberIndependent, manifestFingerprint: expected.manifestFingerprint,
                        configInputDigests: expected.configInputDigests, physicalProjectName: expected.physicalProjectName,
                        toolVersion: expected.toolVersion, services: expected.services, profiles: expected.profiles,
                        servicePlatforms: expected.servicePlatforms,
                        ...(expected.nativeGeneration === undefined ? {} : { nativeGeneration: expected.nativeGeneration }) } : approvedRoot;
                    if (expected && normalizeNativeComposePlatform(rendered.platform) !== normalizeNativeComposePlatform(expected.platform)) refuse('deployment_conflict');
                    const { servicePlatforms: approvedPlatforms, ...approvedBasis } = expectedRoot;
                    const { servicePlatforms: actualPlatforms, ...actualBasis } = local;
                    if (actualPlatforms?.some(value => normalizeNativeComposePlatform(value.platform) !== normalizeNativeComposePlatform(
                        approvedPlatforms?.find(approved => approved.service === value.service)?.platform ?? expected?.platform ?? rendered.platform))) refuse('deployment_conflict');
                    if (!isDeepStrictEqual(isOwnServerBuildReceiptComplete(receipt.content)
                        ? { ...actualBasis, images: parentApproval.images } : actualBasis, approvedBasis)) refuse('deployment_conflict');
                } else if (rendered.basis.manifestFingerprint !== selected.content.ownServer?.approvedInputBasis.manifestFingerprint
                    || expected && rendered.basis.toolVersion !== expected.toolVersion) refuse('deployment_conflict');
                const startFirst = parentApproval.ownServer?.rollout === 'startFirst';
                if (!restored && startFirst || restored && selectedBasis?.ownServer?.rollout === 'startFirst') {
                    candidate = prepared.project.createStartFirstCandidate();
                }
                // Review binds the stable logical project's native inputs.
                // Its review Artifact id is not a deployment generation id;
                // only the native owner derives the admitted physical candidate.
                const activationProject = candidate ?? prepared.project;
                const activationRender = candidate ? await candidate.render({ signal: snapshot.signal }) : rendered;
                const migrationConfiguration = !restored && request.actionId !== 'deployments.rollback'
                    ? selectedSnapshot.environment.content.ownServer : undefined;
                const migration = migrationConfiguration?.migration;
                const firstRuntime = receipt.content.machines[0] === host.machineId;
                // Native preflight is read-only and precedes publication/image
                // acquisition. Other members consume the first member's result.
                const migrationRender = migration && migrationAdmitted ? await prepared.project.render({ signal: snapshot.signal,
                    purpose: 'serviceCommand', service: migration.service }) : undefined;
                if (migration && !firstRuntime && !receipt.content.steps.some(step => step.id === MIGRATION_STEP
                    && (step.state === 'succeeded' || step.state === 'skipped'))) refuse('outcome_unknown');
                if (restored) {
                    if (rendered.servicePlatforms.some(value => !selected.content.images.some(image => image.service === value.service
                        && normalizeNativeComposePlatform(image.platform) === normalizeNativeComposePlatform(value.platform)))) {
                        if (input.phase === 'observe') return failure('rollback_image_unavailable');
                        refuse('rollback_image_unavailable');
                    }
                    const observed = await activationProject.observe({ render: activationRender, signal: snapshot.signal });
                    if (observed.status === 'unknown') return failure('outcome_unknown');
                    if (observed.status === 'matching' && previous?.currentDeploymentId === selected.deployment.id) {
                        await prepared.assertCurrent();
                        return stage(row(observed.health));
                    }
                    if (input.phase === 'observe') {
                        await prepared.assertCurrent();
                        return stage({ ...previous, machineId: host.machineId,
                            installationId: input.installationId, steps: previous?.steps ?? [],
                            activation: previous?.activation ?? 'pending', health: 'unknown' });
                    }
                }
                // Forward cutover observes retained U. Reverse cutover observes
                // the candidate B from this same receipt, never today's source.
                // Observe-only/already-restored paths above need neither effect.
                let incumbentReceipt: OwnServerDeploymentReceipt | undefined;
                if (startFirst) {
                    if (restored) incumbentReceipt = receipt;
                    else if (snapshot.link.activeDeploymentId) incumbentReceipt = await host.readReceipt({
                        environmentId: receipt.deployment.environmentId, deploymentId: snapshot.link.activeDeploymentId,
                        context: request.context });
                }
                let incumbentRender: NativeComposeProjectRender | undefined;
                const prepareIncumbent = async (current: OwnServerDeploymentReceipt) => {
                    const incumbentBasis = current.content.ownServer?.approvedInputBasis;
                    if (!incumbentBasis) refuse('rollback_image_unavailable');
                    retained = await prepare({ ...request, materialization: { kind: 'restoration', deploymentId: receipt.deployment.id,
                        sourceDeploymentId: current.deployment.id } }, { ...snapshot,
                        environment: { ...snapshot.environment, content: { ...snapshot.environment.content,
                            bindings: incumbentBasis.bindings, ownServer: incumbentBasis.ownServer } },
                        content: current.content });
                    retainedProject = incumbentBasis.ownServer?.rollout === 'startFirst'
                        ? retained.project.createStartFirstCandidate() : retained.project;
                    incumbentRender = await retainedProject.render({ signal: snapshot.signal });
                    const observed = await retainedProject.observeActivated({ render: incumbentRender, signal: snapshot.signal, purpose: 'retire' });
                    if (observed.kind !== 'active') refuse(observed.kind === 'unknown' ? 'outcome_unknown' : 'deployment_generation_required');
                    incumbent = observed.activation;
                };
                if (incumbentReceipt) await prepareIncumbent(incumbentReceipt);
                {
                    const source = await captureOwnServerDeploymentSource({ source: prepared.source,
                        admission: prepared.runtime.source, sharedBinds: rendered.sharedData?.bindings });
                    if (!receipt.content.ownServer) refuse('invalid_parameters');
                    const content = { ...receipt.content, ownServer: { ...receipt.content.ownServer,
                        sources: replaceOwnServerDeploymentSource(receipt.content.ownServer.sources, source) } };
                    const written = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
                        deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision,
                        state: 'running', context: request.context,
                        content });
                    if (!written.ok) return written;
                    receipt = { ...receipt, content,
                        deployment: { ...receipt.deployment, revision: written.deploymentRevision } };
                }
                await prepared.assertCurrent();
                return await machineNativeEffectAdmission.run({ operation: { operationId: receipt.deployment.actionOperationId,
                    kind: request.actionId, signal: snapshot.signal }, keys: activationRender.keys, settleNative: prepared.project.settleNative }, async context => {
                    if (!restored) await prepared.project.assertReviewedGeneration(rendered, snapshot.signal);
                    const restoreBackupId = !restored && request.actionId === 'deployments.rollback'
                        && 'restoreBackupId' in request.input ? request.input.restoreBackupId : undefined;
                    if (restoreBackupId !== undefined) {
                        const restoreStepId = 'own-server-database-restore';
                        const existing = receipt.content.steps.find(step => step.id === restoreStepId);
                        if (!firstRuntime) {
                            if (existing?.state !== 'succeeded') refuse('outcome_unknown');
                        } else {
                            // A running native phase is never replayed after a lost response.
                            if (existing) refuse('outcome_unknown');
                            if (!host.readBuildHistory) refuse('deployment_executor_unavailable');
                            let current: OwnServerDeploymentReceipt | undefined;
                            // Home's canonical history is newest-first. Select the
                            // Environment's current receipt before this recovery,
                            // never search history for a matching/latest backup.
                            for await (const value of host.readBuildHistory({ environmentId: receipt.deployment.environmentId,
                                targetLinkId: snapshot.link.id, environment: snapshot.environment, context: request.context })) {
                                if (value.deployment.id === receipt.deployment.id) continue;
                                current = value; break;
                            }
                            const backup = current?.content.ownServer?.preMigrationBackup;
                            if (!current || !backup) refuse('backup_required');
                            const generationId = previous?.currentDeploymentId ?? snapshot.link.activeDeploymentId;
                            if (!generationId) refuse('deployment_generation_required');
                            const generation = generationId === current.deployment.id ? current : await host.readReceipt({
                                environmentId: receipt.deployment.environmentId, deploymentId: generationId, context: request.context });
                            const generationBasis = generation.content.ownServer?.approvedInputBasis;
                            if (!generationBasis) refuse('deployment_generation_required');
                            const recovery = await prepare({ ...request, materialization: { kind: 'restoration',
                                deploymentId: receipt.deployment.id, sourceDeploymentId: generation.deployment.id } }, { ...snapshot,
                                environment: { ...snapshot.environment, content: { ...snapshot.environment.content,
                                    bindings: generationBasis.bindings, ownServer: generationBasis.ownServer } }, content: generation.content });
                            const recoveryProject = generationBasis.ownServer?.rollout === 'startFirst'
                                ? recovery.project.createStartFirstCandidate() : recovery.project;
                            let recoveryActivation: NativeComposeActivatedProject | undefined;
                            const writeRestoreStep = async (state: 'running' | 'succeeded' | 'failed' | 'outcome_unknown', code?: string) => {
                                const content = { ...receipt.content, steps: [...receipt.content.steps.filter(step => step.id !== restoreStepId),
                                    { id: restoreStepId, label: 'Restore recorded database backup', state }],
                                    ...(code ? { failure: { code, phase: 'restore' as const } } : {}) };
                                const written = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
                                    deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment,
                                    expectedRevision: receipt.deployment.revision, state: 'running', content, context: request.context });
                                if (!written.ok) refuse(written);
                                receipt = { ...receipt, content, deployment: { ...receipt.deployment, revision: written.deploymentRevision } };
                            };
                            try {
                                const recoveryRender = await recoveryProject.render({ signal: context.operation.signal });
                                const observed = await recoveryProject.observeActivated({ render: recoveryRender,
                                    signal: context.operation.signal, purpose: 'retire' });
                                if (observed.kind !== 'active') refuse(observed.kind === 'unknown' ? 'outcome_unknown' : 'deployment_generation_required');
                                recoveryActivation = observed.activation;
                                const native = { project: recoveryProject, render: recoveryRender, activation: recoveryActivation,
                                    context, io: recovery.runtime.nativeIo };
                                const destination = await observeOwnServerNativeRestoreDestination(native, {
                                    operationId: receipt.deployment.actionOperationId, environmentId: receipt.deployment.environmentId,
                                    revision: snapshot.environment.environment.revision, target: backup.target });
                                await writeRestoreStep('running');
                                await prepared.stageOutput?.beginStep({ stepId: restoreStepId });
                                await executeOwnServerNativeRestore(async capture => {
                                    const identities = new Set(capture.configuration.credentialBindings.map(environmentSecretBindingIdentityV1));
                                    const credentials = createDeploymentBackupEnvironmentForHost({ repository: capture.repository.repository,
                                        signal: context.operation.signal!, isCurrent: () => recoveryActivation!.isCurrent(), preparation: {
                                            ...recovery.runtime.secrets, environmentId: capture.destination.environmentId,
                                            machineId: host.machineId, installationId: input.installationId,
                                            bindings: snapshot.environment.content.bindings,
                                            backupDestinationUses: snapshot.environment.content.bindings.filter((binding): binding is Extract<typeof binding, { purpose: 'backupDestination' }> => binding.purpose === 'backupDestination'
                                                && identities.has(environmentSecretBindingIdentityV1(binding))), assertCurrent: recovery.assertCurrent } });
                                    return { ...native, ...credentials,
                                        runtimeImage: await recoveryProject.prepareResticRuntime({ render: recoveryRender, context }),
                                        onStopPending: () => prepared.stageOutput?.appendRedacted('stderr', Buffer.from('Database recovery: stop_pending\n')) };
                                }, { receipt: current, operationId: receipt.deployment.actionOperationId, restoreBackupId, destination,
                                    safetyBackup: { environmentId: destination.environmentId, configuration: backup.configuration,
                                        data: { engine: 'postgres', service: destination.service, logicalBackup: { adapter: 'postgres-v1' } } } });
                                await writeRestoreStep('succeeded');
                            } catch (error) {
                                const code = failureCode(error, snapshot.signal.aborted);
                                await writeRestoreStep(code === 'outcome_unknown' ? 'outcome_unknown' : 'failed', code);
                                throw error;
                            } finally {
                                try { await recoveryActivation?.dispose(); }
                                finally {
                                    try { if (recoveryProject !== recovery.project) await recoveryProject.dispose(); }
                                    finally {
                                        try { await recovery.project.dispose(); }
                                        finally { try { await recovery.source.abort(); } finally { await recovery.runtime.release(); } }
                                    }
                                }
                            }
                        }
                    }
                    if (migrationConfiguration && migrationRender) await executeOwnServerMigration({
                        configuration: migrationConfiguration, project: prepared.project, render: migrationRender,
                        context, signal: snapshot.signal,
                        directUrlBound: selectedSnapshot.environment.content.bindings.some(binding => binding.purpose === 'variable'
                            && binding.phase === 'runtime' && binding.name === 'DIRECT_URL'),
                        async prepareBackup() {
                            const operands = await prepared.runtime.preparePreMigrationBackupOperands?.();
                            if (!operands) return refuse('backup_required');
                            try {
                                // The candidate has not started. pg_dump belongs to
                                // the captured serving generation, under this job.
                                if (!incumbent) {
                                    if (!snapshot.link.activeDeploymentId) return refuse('backup_required');
                                    await prepareIncumbent(await host.readReceipt({ environmentId: receipt.deployment.environmentId,
                                        deploymentId: snapshot.link.activeDeploymentId, context: request.context }));
                                }
                                if (!retained || !retainedProject || !incumbentRender || !incumbent) return refuse('backup_required');
                                return { input: { ...operands, project: retainedProject, render: incumbentRender, activation: incumbent,
                                    context, io: retained.runtime.nativeIo,
                                    runtimeImage: await retainedProject.prepareResticRuntime({ render: incumbentRender, context }),
                                    onStopPending() { prepared.stageOutput?.appendRedacted('stderr', Buffer.from('Native backup stop is pending\n')); } },
                                    capture: { receipt, destination: operands.destination, context: request.context,
                                        backup: { environmentId: receipt.deployment.environmentId, configuration: operands.configuration, data: operands.data },
                                        async writeTransition(capture: Parameters<OwnServerDeploymentTargetHostInput['writeTransition']>[0]) {
                                            const written = await host.writeTransition(capture);
                                            if (written.ok) receipt = { ...receipt, content: capture.content,
                                                deployment: { ...receipt.deployment, revision: written.deploymentRevision } };
                                            return written;
                                        } }, dispose: operands.dispose };
                            } catch (error) { await operands.dispose(); throw error; }
                        },
                        async writeStep(step) {
                            if (step.state === 'running') await prepared.stageOutput?.beginStep({ stepId: step.id });
                            const content = { ...receipt.content, steps: [...receipt.content.steps.filter(value => value.id !== step.id), step] };
                            const written = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
                                deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment,
                                expectedRevision: receipt.deployment.revision, state: 'running', context: request.context, content });
                            if (!written.ok) refuse(written);
                            receipt = { ...receipt, content, deployment: { ...receipt.deployment, revision: written.deploymentRevision } };
                        },
                    });
                    const activate = async () => {
                        await prepared.stageOutput?.beginStep({ stepId: input.phase });
                        if (startFirst && incumbent) {
                            if (!host.readStartFirstRoutes) return refuse('native_route_unavailable');
                            const composeService = incumbent.services[0];
                            if (!composeService) return refuse('deployment_generation_required');
                            const observation = createNativeComposeLifecycle({ args: incumbent.composeArgs, io: prepared.runtime.nativeIo,
                                retainLaunch: () => incumbent!.authorizeServiceObserver(), engineId: activationRender.engineId,
                                environment: { composeService, containerIds: incumbent.nativeIdsForService(composeService),
                                    facts: incumbent.nativeFactsForService(composeService) } });
                            const launch = incumbent.authorizeServiceObserver();
                            try {
                                observation.bindLaunch(launch);
                                if (!observation.lifecycle.nativeDocker) return refuse('native_route_unavailable');
                                const docker = await observation.lifecycle.nativeDocker({ signal: snapshot.signal });
                                const routes = await host.readStartFirstRoutes(request, { docker, installationId: input.installationId,
                                    affectedServices: activationRender.services, context, signal: snapshot.signal });
                                activated = true;
                                let target: NativeComposeActivatedProject | undefined;
                                if (restored) {
                                    let observed = await activationProject.observeActivated({ render: activationRender, signal: snapshot.signal });
                                    if (observed.kind === 'absent') {
                                        await activationProject.activate({ render: activationRender, context, signal: snapshot.signal });
                                        observed = await activationProject.observeActivated({ render: activationRender, signal: snapshot.signal });
                                    }
                                    if (observed.kind !== 'active') return refuse('outcome_unknown');
                                    target = observed.activation;
                                }
                                const result = await activationProject.activateStartFirst({ render: activationRender, context, incumbent,
                                    ...(target ? { target } : {}), routes, signal: snapshot.signal });
                                if (result.kind !== 'activated') {
                                    await result.activation.dispose();
                                    return refuse('outcome_unknown');
                                }
                                return result.activation;
                            } finally { await launch.release(); }
                        }
                        activated = true;
                        return activationProject.activate({ render: activationRender, context, signal: snapshot.signal,
                            cleanupOnFailure: !snapshot.link.activeDeploymentId && receipt.content.onFailure === 'rollbackAll' });
                    };
                    const project = await activate().catch((error: unknown) => {
                        if (error instanceof MachineNativeEffectAdmissionError && error.code === 'plan_changed') activated = false;
                        throw error;
                    });
                    try {
                        const handles = await produceEnvironmentProjectServices({ owner: prepared.runtime.projectManagedServices,
                            serverId: prepared.homeServerIdentityId, release: prepared.source, specIdentity: selected.deployment.id,
                            signal: snapshot.signal, isCurrent: () => project.isCurrent(),
                            nativeEffects: { keys: activationRender.keys, settleNative: prepared.project.settleNative }, io: prepared.runtime.nativeIo, project });
                        await prepared.source.commit(); committed = true;
                        const staged = await stage(row(project.health));
                        if (!staged.ok) return staged;
                        attachDeploymentServiceHealthNotices({ credentials: host.credentials,
                            serverId: host.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId,
                            homeServerIdentityId: prepared.homeServerIdentityId,
                            environment: snapshot.environment, handles,
                            readEnvironment: signal => host.readEnvironment({ environmentId: snapshot.environment.environment.id, context: { signal } }),
                            nativeWorkload: { installationId: input.installationId, handles,
                                rows: prepared.runtime.projectManagedServices.machineServiceRows,
                                ...(prepared.runtime.currentDomainEdgeObservation
                                    ? { edge: prepared.runtime.currentDomainEdgeObservation } : {}),
                                async *receipts(environment, signal) {
                                    const context = { signal };
                                    if (host.readBuildHistory) yield* host.readBuildHistory({ environmentId: environment.environment.id,
                                        targetLinkId: environment.environment.runtimeTargetLinkId!, environment, context });
                                    else yield await host.readReceipt({ environmentId: environment.environment.id,
                                        deploymentId: selected.deployment.id, context });
                                },
                            },
                        });
                        return staged;
                    } finally { await project.dispose(); }
                });
            } catch (error) {
                if (activated && !committed) { await prepared.source.commit(); committed = true; }
                const code = failureCode(error, snapshot.signal.aborted);
                const uncertain = code === 'outcome_unknown' || isProjectNativeProcessUncertain(error) || activated && snapshot.signal.aborted;
                let failed: DeploymentMachineResultV1 = { ...previous, machineId: host.machineId, installationId: input.installationId,
                    steps: previous?.steps ?? [], actionOperationId: receipt.deployment.actionOperationId,
                    activation: restored ? previous?.activation ?? 'pending' : uncertain ? 'outcome_unknown' : code === 'cancelled' ? 'cancelled' : 'failed',
                    health: activated && !uncertain ? 'unhealthy' : previous?.health ?? 'unknown',
                    ...(restored ? { restoration: uncertain ? 'outcome_unknown' : 'failed' } : {}) };
                if (error instanceof PluginError && error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details)
                    && 'firstDeployCleanup' in error.details
                    && error.details.firstDeployCleanup === 'removed') failed = recordOwnServerCandidateCleanup({
                    ...failed, currentDeploymentId: undefined, health: 'unknown' }, 'succeeded');
                const written = await stage(failed, { code, phase: input.phase === 'restore' ? 'restore' : 'activate' });
                return written.ok ? failure(uncertain ? 'outcome_unknown' : code, error) : written;
            } finally {
                try {
                    try { await incumbent?.dispose(); }
                    finally {
                        try { if (retainedProject !== retained?.project) await retainedProject?.dispose(); }
                        finally {
                            try { await retained?.project.dispose(); }
                            finally { try { await retained?.source.abort(); } finally { await retained?.runtime.release(); } }
                        }
                    }
                } finally {
                    try { await candidate?.dispose(); }
                    finally {
                        try { await prepared.project.dispose(); }
                        finally {
                            try { if (!committed) await prepared.source.abort(); }
                            finally { try { await prepared.runtime.release(); } finally { await prepared.stageOutput?.close(); } }
                        }
                    }
                }
            }
        } catch (error) { return failure(failureCode(error, request.context.signal?.aborted === true), error); }
    }
    async function execute(request: OwnServerDeploymentRequest): Promise<OwnServerDeploymentResult> {
        try {
            const snapshot = await read(request);
            const result = await executeOwnServerRollout(host.dispatchMember ? host : { ...host, dispatchMember: executeMember }, request, snapshot);
            let settled: Parameters<typeof publishSettlementNotice>[2];
            // Local success cannot authorize retention. Reopen the settled
            // aggregate and its current uniform pointer before dispatching it.
            // Notice admission consumes this same fresh pair without reopening Source access.
            if (result.ok && ['succeeded', 'running_unverified', 'failed'].includes(result.state)) {
                try {
                    const [environment, receipt] = await Promise.all([
                        host.readEnvironment({ environmentId: request.input.environmentId, context: request.context }),
                        host.readReceipt({ environmentId: request.input.environmentId, deploymentId: request.receipt.deploymentId, context: request.context }),
                    ]);
                    settled = { environment, receipt };
                    const link = environment.targetLinks.find(value => value.targetLink.id === request.input.targetLinkId)?.targetLink;
                    if (link?.activeDeploymentId && readDeploymentUniformTargetLinkRevisionV1({ deploymentId: link.activeDeploymentId, targetLink: link, content: receipt.content }) !== null) {
                        const placements = new Map(link.members.map(member => [member.machineId, member]));
                        const builder = receipt.deployment.acceptedExecution?.builder;
                        if (builder && !placements.has(builder.machineId)) placements.set(builder.machineId, { ...builder, state: 'active' });
                        for (const member of placements.values()) {
                            const child = { request, machineId: member.machineId, installationId: member.installationId,
                                settledTargetLinkRevision: link.revision, settledDeploymentRevision: receipt.deployment.revision,
                                activeDeploymentId: link.activeDeploymentId };
                            const cleaned = host.dispatchRetention ? await host.dispatchRetention(child) : await retain(child);
                            if (!cleaned.ok) logger.infoFile('[Deployment] Source retention did not complete', { code: cleaned.errorCode });
                        }
                    }
                } catch (error) { logger.infoFile('[Deployment] Source retention did not complete', { code: codeOf(error) }); }
            }
            await publishSettlementNotice(request, snapshot, settled);
            return result;
        } catch (error) { return failure(failureCode(error, request.context.signal?.aborted === true), error); }
    }
    return Object.freeze({ review, execute, reviewMember, executeMember, retain });
}
