import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import axios from 'axios';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import { DeploymentDeployAdmissionInputV1Schema, DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { configuration } from '@/configuration';
import { projectDeploymentTransitionOutcomeUnknownForHost } from '@/deployments/deploymentTransitionResult';
import * as installationStore from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { PushNotificationClient } from '@/api/pushNotifications';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { registerDaemonCommittedServiceHealthDeliveryRpcHandler } from '@/notifications/activity/committedServiceHealthDelivery';
import { AccountNoticeArtifactHeaderV1Schema, CommittedServiceHealthDeliveryRequestV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { privateServicePublicationBindings } from './privateServicePublication';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { database, sourceManifest, installRestoreBoundary } from './nativeRestore.testkit';
import { RESTIC_RUNTIME_V1 } from '@happier-dev/deployments';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createNightlyBackupsWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from '@/daemon/workflows/workflowCoordinator.testkit';
import { createDeploymentRestoreActionForHost } from '../../actions/restore';
import { createDeploymentBackupActionForHost, createDeploymentBackupRecordedHealthForHost } from '../../actions/backups';
import { DeploymentBackupRecordedHealthV1Schema } from '@happier-dev/protocol/projects/readinessV1';
import { buildDeploymentBackupActionInputV1, DeploymentBackupRunResultV1Schema,
    DeploymentBackupInventoryResultV1Schema,
    DEPLOYMENT_BACKUP_ACTION_IDS_V1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { nativeRestic0191 } from '@/daemon/local/services/launch/nativeResticRegistry.testkit';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createNativeCaddyRoutes } from '@/machines/reachability/nativeCaddyRoutes';
import { createNativeCaddyStartFirstRoutes } from '@/machines/reachability/nativeCaddyStartFirst';
import type { NativeComposeStartFirstRoutes } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { materializeCaddyDomainRouteV1, type CaddyDomainRouteInput } from './caddyRouteMaterialization';
import { readOwnServerDeploymentStageLogs } from './stageLog';
import { buildOwnServerDeploymentReceipt, isOwnServerBuildReceiptComplete } from './buildReceipt';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost, resolveOwnServerDeploymentRootForHost } from './paths';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { sealMachineSecretGrant } from '../../secrets/machineSecretGrant';
import { createOwnServerDeploymentTargetForHost, type OwnServerDeploymentRequest, type OwnServerDeploymentTargetHostInput, type OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { prepareStoredPromotionCandidate, readStoredPromotionCandidateForHost } from '../../storedPromotionCandidate';
import { DeploymentApprovalReviewV1Schema, DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import { EnvironmentSecretLaunchAdmissionInputV1Schema, computeEnvironmentSecretLaunchAdmissionDigestV1 } from '@happier-dev/deployment-protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createDaemonDeploymentActionDeps } from '../../createDaemonDeploymentActionDeps';
import { createDaemonDeploymentChildExecutor } from '../../deploymentChild';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { createCliDeploymentActionDeps } from '../../createCliDeploymentActionDeps';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';

afterEach(() => {
    // Each fixture owns a different checkout, not a mutation of the preceding
    // fixture's same-revision Account row. End that projection's lifetime too.
    withdrawActiveProjectAccountRowsSnapshot();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function fixture(state: 'queued' | 'succeeded' | 'outcome_unknown' = 'queued', allowTransitions = false) {
    const environment = createDeploymentEnvironmentDetailV1();
    delete environment.targetLinks[0].targetLink.activeDeploymentId;
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, acceptedExecution: { v: 1,
        controller: { machineId: environment.environment.controllerMachineId, installationId: 'installation-a' },
        builder: { machineId: environment.environment.buildMachineId!, installationId: 'installation-a' }} });
    receipt.deployment.state = state;
    if (state === 'queued') receipt.content.machineResults = [];
    let runtimeAcquisitions = 0;
    let transitions = 0;
    let receiptReads = 0;
    // Opened Artifact/storage and installed-daemon acquisition are host boundaries;
    // the actual target admission and settlement logic are never substituted.
    const host: OwnServerDeploymentTargetHostInput = {
        credentials: { token: 'fixture-token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://127.0.0.1', machineId: 'machine-a',
        async readEnvironment() { return environment; }, async readReceipt() { receiptReads++; return receipt; },
        async writeTransition(input) {
            transitions++;
            if (!allowTransitions) throw new Error('Unexpected storage mutation');
            receipt.content = input.content;
            receipt.deployment = { ...receipt.deployment, revision: receipt.deployment.revision + 1, state: input.state };
            return { ok: true, environmentId: input.environmentId, revision: environment.environment.revision,
                deploymentId: input.deploymentId, deploymentRevision: receipt.deployment.revision, state: input.state };
        },
        runtime: { async acquire() { runtimeAcquisitions++; throw new Error('Unexpected native acquisition'); } },
    };
    const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
        input: { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
            targetLinkId: receipt.deployment.targetLinkId, expectedTargetLinkRevision: environment.targetLinks[0].targetLink.revision,
            requestKey: 'request-a', contentArtifactId: receipt.deployment.contentArtifactId,
            contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
        receipt: { ok: true, environmentId: receipt.deployment.environmentId, revision: environment.environment.revision,
            deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state },
        context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } },
    };
    return { target: createOwnServerDeploymentTargetForHost(host), request, environment, receipt,
        effects: () => ({ runtimeAcquisitions, transitions }), receiptReads: () => receiptReads };
}

describe('own-server target at the Action host boundary', () => {
    it('admits backup Actions against the exact serving generation before acquiring native custody', async () => {
        const { target, environment, receipt, effects } = fixture('succeeded');
        const input = { serverId: 'home', environmentId: environment.environment.id,
            machineId: 'machine-a', installationId: 'installation-a', targetLinkId: receipt.deployment.targetLinkId,
            deploymentId: receipt.deployment.id, expectedRevision: environment.environment.revision, configRevision: 1 };
        const context = { operationAcceptance: { operationId: 'backup-run', accept() {} } };
        await expect(target.backup({ actionId: 'deployments.backups.run', input, context }))
            .rejects.toMatchObject({ code: 'deployment_generation_required' });
        environment.targetLinks[0].targetLink.activeDeploymentId = receipt.deployment.id;
        await expect(target.backup({ actionId: 'deployments.backups.run', input: { ...input, installationId: 'foreign' }, context }))
            .rejects.toMatchObject({ code: 'target_mismatch' });
        expect(effects()).toEqual({ runtimeAcquisitions: 0, transitions: 0 });
    });
    it('admits standalone restore at the current own-server generation before native acquisition', async () => {
        const { target, environment, receipt, effects } = fixture('succeeded');
        const input = { mode: 'prepare' as const, serverId: 'home', environmentId: environment.environment.id,
            machineId: 'machine-a', installationId: 'installation-a', targetLinkId: receipt.deployment.targetLinkId,
            deploymentId: receipt.deployment.id, restoreBackupId: 'a'.repeat(64), expectedRevision: environment.environment.revision };
        const context = { operationAcceptance: { operationId: 'standalone-restore', accept() {} } };
        await expect(target.restore({ input, context })).rejects.toMatchObject({ code: 'deployment_generation_required' });
        environment.targetLinks[0].targetLink.activeDeploymentId = receipt.deployment.id;
        await expect(target.restore({ input: { ...input, installationId: 'another-installation' }, context }))
            .rejects.toMatchObject({ code: 'target_mismatch' });
        expect(effects()).toEqual({ runtimeAcquisitions: 0, transitions: 0 });
    });
    it('reads the serving revision across an admitted target-link replacement before native review', async () => {
        const { target, request, environment, receipt, effects } = fixture();
        const link = environment.targetLinks[0];
        link.targetLink.predecessorTargetLinkId = 'retained-target';
        link.targetLink.activeDeploymentId = receipt.deployment.id;
        environment.targetLinks.push({ ...structuredClone(link), targetLink: { ...link.targetLink,
            id: 'retained-target', predecessorTargetLinkId: undefined } });
        receipt.deployment.targetLinkId = 'retained-target';
        await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: {} }))
            .rejects.toThrow('Unexpected native acquisition');
        expect(effects()).toEqual({ runtimeAcquisitions: 1, transitions: 0 });
        receipt.deployment.targetLinkId = 'unrelated-target';
        await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: {} }))
            .rejects.toMatchObject({ code: 'target_mismatch' });
        expect(effects()).toEqual({ runtimeAcquisitions: 1, transitions: 0 });
    });
    it('reviews the destination candidate against the captured source image before acquiring native custody', async () => {
        const { target, request, environment, receipt, effects } = fixture('succeeded');
        const document = '{"services":{"app":{"image":"example/receipt-X"}}}';
        receipt.deployment.environmentId = 'source-environment';
        receipt.deployment.id = 'source-receipt';
        receipt.content.sourceIntent = { kind: 'stored', contentRevision: 19, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
        environment.content.definition = { ...receipt.content.sourceIntent, document: '{"services":{"app":{"image":"example/old"}}}',
            contentRevision: 3, composeDigest: `sha256:${'c'.repeat(64)}` };
        const candidateEnvironmentContent = prepareStoredPromotionCandidate(receipt, environment);
        const content = { ...receipt.content, sourceIntent: candidateEnvironmentContent.definition };
        const input = { ...request.input, sourceEnvironmentId: 'source-environment', sourceDeploymentId: 'source-receipt',
            artifact: 'image' as const, destinationContent: { contentArtifactId: 'destination-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } };
        await expect(target.review({ actionId: 'deployments.promote', input, content, candidateEnvironmentContent, context: {} }))
            .rejects.toThrow('Unexpected native acquisition');
        expect(effects().runtimeAcquisitions).toBe(1);
        const changed = { ...content, images: content.images.map(image => ({ ...image, configDigest: `sha256:${'d'.repeat(64)}` })) };
        await expect(target.review({ actionId: 'deployments.promote', input, content: changed, candidateEnvironmentContent, context: {} }))
            .rejects.toMatchObject({ code: 'target_mismatch' });
        expect(effects()).toEqual({ runtimeAcquisitions: 1, transitions: 0 });
        environment.content.ownServer = { ...environment.content.ownServer!, migration: { service: 'app', argv: ['migrate'] } };
        const migratingCandidate = prepareStoredPromotionCandidate(receipt, environment);
        await expect(target.review({ actionId: 'deployments.promote', input, content,
            candidateEnvironmentContent: migratingCandidate, context: {} })).rejects.toThrow('Unexpected native acquisition');
        expect(effects()).toEqual({ runtimeAcquisitions: 2, transitions: 0 });
    });
    it.each(['repository', 'stored'] as const)('binds %s rollback to the exact selected retained receipt before native custody', async kind => {
        const { target, request, environment, receipt, effects } = fixture();
        if (kind === 'stored') {
            const document = 'services: {app: {image: example/retained}}';
            const definition = { kind: 'stored' as const, document, contentRevision: 1,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
            environment.content.definition = definition;
            receipt.content.sourceIntent = definition;
        }
        // The opened reader returns the current receipt, not the selected retained one.
        await expect(target.review({ actionId: 'deployments.rollback', input: { ...request.input, deploymentId: 'retained-receipt' },
            content: receipt.content, context: {} })).rejects.toMatchObject({ code: 'target_mismatch' });
        expect(effects().runtimeAcquisitions).toBe(0);
    });
    it('binds stored deploy review to the sole Environment definition writer before acquiring native custody', async () => {
        const { target, request, environment, receipt, effects } = fixture();
        const document = 'services: {app: {image: example/app}}';
        const definition = { kind: 'stored' as const, document, contentRevision: 1,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
        receipt.content.sourceIntent = definition;
        await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: {} }))
            .rejects.toMatchObject({ code: 'deployment_conflict' });
        expect(effects().runtimeAcquisitions).toBe(0);
        environment.content.definition = definition;
        await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: {} }))
            .rejects.toThrow('Unexpected native acquisition');
        expect(effects().runtimeAcquisitions).toBe(1);
    });
    for (const scenario of ['private_publication_matching_restore', 'private_publication_refused', 'private_publication_withdrawal_refused', 'private_publication_failed_attempt', 'promote_archive_custody', 'promote_cleanup_refused', 'promote_build_refused', 'promote_source_demoted', 'promote_destination_demoted', 'admitted_placement_changed', 'adopted_origin', 'adopted_origin_changed', 'adopted_generation_changed', 'adopted_generation_admission_changed', 'adopted_installation_changed', 'routing_review', 'review_receipt_scope', 'runtime_reads', 'runtime_health', 'runtime_stage', 'cleanup_missing_generation', 'transition_provenance_reason', 'transition_log_reason', 'retained_health', 'retained_health_remote', 'retained_health_denied', 'member_cost', 'member_child_cost', 'member_health', 'member_health_changed', 'member_source_environment', 'candidate_first_deploy', 'candidate_start_first', 'candidate_start_first_unknown', 'candidate_start_first_restore', 'candidate_start_first_restore_unknown', 'candidate_start_first_restore_candidate', 'candidate_start_first_restore_unhealthy', 'candidate_pending_check_zero', 'candidate_direct_url', 'candidate_backup_required', 'candidate_backup_configured', 'candidate_backup_configured_failure', 'candidate_check_nonzero', 'canonical_home_prepare', 'canonical_home_build', 'public_restore', 'standalone_public_restore', 'public_backup', 'public_backup_retention', 'public_backup_recorded_health', 'public_backup_probe', 'required_project_secret'] as const) it(
        `native deployment admission, finite execution and retained C1 observation: ${scenario}`, async () => {
        const startedAt = Date.now();
        // Native pushes and their HTTP work share the composed scenario's
        // integration budget, including setup; no shorter per-wait deadline.
        const waitForNativeRead = (assertion: () => unknown) => vi.waitFor(assertion,
            { timeout: 60_000 - (Date.now() - startedAt) });
        const runtimeRead = scenario === 'runtime_reads' || scenario === 'runtime_health';
        const promotionScenario = scenario === 'promote_source_demoted' || scenario === 'promote_destination_demoted'
            || scenario === 'promote_build_refused' || scenario === 'promote_archive_custody' || scenario === 'promote_cleanup_refused';
        const startFirst = scenario.startsWith('candidate_start_first');
        const migrationBackup = scenario.startsWith('candidate_backup_configured') || scenario.startsWith('public_backup');
        const reverseStartFirst = scenario.startsWith('candidate_start_first_restore');
        const retainedHealth = scenario.startsWith('retained_health');
        const stagePhases: Array<{ phase: string; elapsedMs: number }> = [];
        const phase = (value: string) => { stagePhases.push({ phase: value, elapsedMs: Date.now() - startedAt }); };
        onTestFailed(() => { console.info('Native target phases', { scenario, phases: stagePhases }); });
        phase('fixture');
        const root = await mkdtemp(join(tmpdir(), 'happier-deployment-health-'));
        const repository = join(root, 'repository');
        await mkdir(repository);
        const docker = await createOwnServerDockerBoundary(join(root, 'docker'), { operatingSystem: 'Docker Desktop' });
        vi.stubEnv('PATH', `${join(root, 'docker')}${delimiter}${process.env.PATH ?? ''}`);
        const image = await docker.registerImage('app', 'A');
        await writeFile(join(repository, 'compose.yaml'), JSON.stringify({ services: { app: { image: image.registryReference,
            privileged: true, restart: 'on-failure', deploy: { replicas: 2, resources: { limits: { cpus: '1.0', memory: '128M' } } },
            ...(startFirst ? { healthcheck: { test: ['CMD', 'true'] }, stop_grace_period: '17s' } : scenario === 'routing_review' ? {} : {
                volumes: [{ type: 'volume', source: 'shared', target: '/data' }],
                ports: [{ target: 3000, published: '3000', host_ip: scenario === 'private_publication_refused' || scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_matching_restore' || scenario === 'runtime_stage' ? '100.81.1.12' : '0.0.0.0' }],
            }), environment: { PRIVATE_INPUT: 'sensitive-host-value',
                DEPLOY_PASSWORD: '${DEPLOY_PASSWORD:?required}' } } },
            ...(scenario === 'routing_review' ? {} : { volumes: { shared: { name: 'target-review-shared' } } }) }));
        const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
        if (scenario === 'required_project_secret') {
            await mkdir(join(repository, '.happier'));
            await writeFile(join(repository, '.happier', 'project.json'), JSON.stringify({ version: 1,
                environmentVariables: [{ name: 'UNBOUND_PROJECT_SECRET', kind: 'secret' }] }));
        }
        git('init', '--quiet'); git('config', 'user.name', 'Deployment Health Fixture');
        git('config', 'user.email', 'health@example.test'); git('add', 'compose.yaml');
        if (scenario === 'required_project_secret') git('add', '.happier/project.json');
        git('commit', '--quiet', '-m', 'A');
        const environment = createDeploymentEnvironmentDetailV1();
        if (scenario === 'private_publication_refused' || scenario === 'private_publication_failed_attempt') environment.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false,
            serviceExports: [{ key: 'application', service: 'app', containerPort: 3000, scheme: 'http',
                exposure: 'privateNetwork', privateNetwork: 'shop-net' }] };
        const promotionSource = structuredClone(environment);
        promotionSource.environment.id = 'promotion-source';
        let promotionDestinationContent: typeof environment.content | undefined;
        if (scenario === 'member_health' || scenario === 'member_health_changed') environment.content = DeploymentEnvironmentContentV1Schema.parse({
            ...environment.content, template: { templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['app'],
                definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
                health: [{ service: 'app', participates: false }] },
        });
        delete environment.targetLinks[0].targetLink.activeDeploymentId;
        if (scenario.startsWith('adopted_')) environment.targetLinks[0].content = { nativeOrigin: {
            projectName: 'preexisting-compose-project',
            dockerEndpoint: scenario === 'adopted_origin_changed' ? 'another-docker-engine' : 's0-docker-engine', workingDirectory: repository,
            capture: { installationId: scenario === 'adopted_installation_changed' ? 'retired-installation' : 'installation-a' },
        } };
        const receipt = createDeploymentReceiptDetailV1();
        receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, acceptedExecution: { v: 1,
            controller: { machineId: environment.environment.controllerMachineId, installationId: 'installation-a' },
            builder: { machineId: environment.environment.buildMachineId!, installationId: 'installation-a' }} });
        receipt.deployment.state = 'queued';
        receipt.content.machineResults = [];
        receipt.content.images = [image];
        if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
        receipt.content.sourceIntent.sha = git('rev-parse', 'HEAD');
        const serving = structuredClone(receipt);
        serving.deployment.id = 'serving-release';
        serving.deployment.state = 'succeeded';
        if (serving.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
        serving.content.sourceIntent.sha = 'b'.repeat(40);
        const accountId = environment.environment.createdByAccountId;
        const sourceContext = { authority: 'present_user' as const,
            machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId: 'machine-a',
                installationId: 'installation-a', role: 'use' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true };
        const sourceIdentityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            resolveHostIdentity: async () => ({ custodianAccountId: accountId, machineId: 'machine-a', installationId: 'installation-a' }) });
        const resolveRequesterIdentity: import('@/deployments/readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver = async context => {
            const requester = await sourceIdentityOwner.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        };
        const installationSeed = new Uint8Array(32).fill(7);
        const installationPublicKey = ed25519.getPublicKey(installationSeed);
        const secretBinding = createDeploymentSecretVariableBindingV1({ name: 'DEPLOY_PASSWORD', phase: 'runtime',
            resourceId: 'review-secret', resourceRevision: 1 });
        environment.content.bindings = [secretBinding];
        if (scenario === 'runtime_stage') {
            environment.content.bindings.push({ purpose: 'variable', phase: 'runtime', name: 'RUNNING_SERVICE_URL',
                source: { kind: 'reference', environmentId: environment.environment.id, export: 'application', via: 'auto' } });
            environment.content.ownServer = { ...environment.content.ownServer, rollout: 'recreate', autoRestorePreviousRelease: false,
                serviceExports: [{ key: 'application', service: 'app', containerPort: 3000, scheme: 'http',
                    exposure: 'privateNetwork', privateNetwork: 'application' }] };
        }
        const secretGrant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
            installationId: 'installation-a', environmentId: environment.environment.id, resourceId: 'review-secret', resourceRevision: 1 },
            installationPublicKey, content: { kind: 'secret', value: 'review-secret-value-sentinel' } });
        const runtimeGrants = [secretGrant];
        if (scenario === 'runtime_stage') runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1,
            kind: 'environmentValues', environmentId: environment.environment.id, machineId: 'machine-a', installationId: 'installation-a',
            binding: { purpose: 'variable', phase: 'runtime', name: 'RUNNING_SERVICE_URL' } }, installationPublicKey,
            content: { kind: 'environmentValues', definition: { kind: 'reference', environmentId: environment.environment.id,
                export: 'application', via: 'auto' } } }));
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const serverHttpBaseUrl = 'https://deployment-health.test';
        environment.environment.protection = 'production';
        environment.environment.controllerMachineId = scenario === 'retained_health_remote' ? 'other-controller' : 'machine-a';
        if (scenario === 'retained_health_remote') receipt.deployment.acceptedExecution!.controller = {
            machineId: 'other-controller', installationId: 'controller-installation',
        };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
            notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [
                NotificationChannelRecordV1Schema.parse({ v: 1, id: 'deployment-health-push', kind: 'expo_push', topics: { machines: true } }),
            ] } });
        // Native push is the outward system boundary; observation, C1 CAS and
        // the canonical attention/channel dispatcher remain real.
        let forwarding = false;
        let receiverCurrent = true;
        let receiverAdmissionReads = 0;
        let receiverEnvironmentReads = 0;
        const deliveries: string[] = [];
        const sendPush = vi.spyOn(PushNotificationClient.prototype, 'sendToAllDevicesAsync').mockImplementation(async () => {
            deliveries.push(forwarding ? 'controller' : 'target');
            return true;
        });
        const receiver = new RpcHandlerManager({ scopePrefix: 'other-controller', localMachineId: 'other-controller',
            encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'other-controller', resolveCustodianAccountId: async () => accountId,
                resolveInstallationId: () => 'controller-installation',
                // Current Home access is the network boundary. Machine policy,
                // admission matching, schemas, receiver and dispatcher stay real.
                verifyMachineAdmission: async () => { receiverAdmissionReads++; return receiverCurrent; },
            }) });
        registerDaemonCommittedServiceHealthDeliveryRpcHandler(receiver, {
            target: () => ({ serverId: 'home', machineId: 'other-controller', installationId: 'controller-installation', custodianAccountId: accountId }),
            // Stored credentials and the installed runtime lifetime are OS
            // boundaries; this lends no substitute Environment/notice decisions.
            resolveRuntime: async () => ({ credentials, accountId, serverId: 'home', serverHttpBaseUrl,
                machineId: 'other-controller', isCurrent: async () => receiverCurrent }),
        });
        const invokeReceiver = async (params: unknown, actorAccountId = accountId) => {
            forwarding = true;
            try { return await receiver.handleRequest({ method: `other-controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`,
                params, callerAuthority: 'account_automation', machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({
                    machineId: 'other-controller', installationId: 'controller-installation', actorAccountId,
                    custodianAccountId: accountId, role: 'manage', encryptionMode: 'plain',
                }) }); } finally { forwarding = false; }
        };
        // Only the actual Machine network hop is substituted: it enters the
        // real registered receiver under authenticated Machine admission.
        const forward = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async input => {
            const packet = CommittedServiceHealthDeliveryRequestV1Schema.parse(input.request);
            return invokeReceiver(packet);
        });
        const rows = [createPlainProjectAccountRefRow({ id: 'checkout', serverId: 'home', machineId: 'machine-a',
            rootPath: repository, source: { sourceId: environment.environment.projectSourceId, revision: 1 }, createdAtMs: 1 })];
        const stored = new Map<string, Record<string, unknown>>();
        let writes = 0;
        let artifactReads = 0;
        let controllerArtifactReads = 0;
        let artifactReadEffect: (() => void | Promise<void>) | undefined;
        let readAccessRevoked = false;
        let readPageAdmissions = 0;
        let readPageAuthorityChecks = 0;
        let privateEnvironmentBodyReads = 0;
        const deploymentAdmissionRevisions: number[] = [];
        let memberHeaderReads = 0;
        // Only installed-identity, Home HTTP/socket and the Docker executable are
        // substituted. Target review/execution, SCM, service owner and C1 are real.
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(installationPublicKey).toString('base64url'),
            privateKey: Buffer.concat([installationSeed, installationPublicKey]).toString('base64url') });
        vi.spyOn(axios, 'request').mockImplementation(async httpRequest => {
            if (scenario === 'routing_review' && new URL(httpRequest.url ?? serverHttpBaseUrl).pathname.endsWith('/secret-launch-admission')) {
                const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(httpRequest.data);
                expect(verifyMachineInstallationProof({ proof, publicKey: installationPublicKey,
                    payload: { version: 1, machineId: body.machineId, installationId: body.installationId, accountId,
                        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } } })).toBe(true);
                return { status: 200, data: { ok: true, grants: runtimeGrants.filter(grant => grant.machineId === body.machineId
                    && grant.installationId === body.installationId) } };
            }
            if (httpRequest.method?.toUpperCase() === 'POST'
                && new URL(httpRequest.url ?? serverHttpBaseUrl).pathname === `/v1/deployments/environments/${environment.environment.id}/deploy`) {
                // Home HTTP is the storage boundary. Mirror its revision CAS;
                // the real carrier must preserve the reviewed expected revision
                // and must not dispatch native work after the conflict.
                const admission = DeploymentDeployAdmissionInputV1Schema.parse(httpRequest.data);
                deploymentAdmissionRevisions.push(admission.expectedRevision);
                return admission.expectedRevision !== environment.environment.revision
                    ? { status: 409, data: { ok: false, error: 'deployment_conflict' } }
                    : { status: 200, data: structuredClone(request.receipt) };
            }
            return httpRequest.method?.toUpperCase() === 'GET'
            && new URL(httpRequest.url ?? serverHttpBaseUrl).pathname.endsWith(`/receipts/${receipt.deployment.id}`)
            ? (memberHeaderReads++, { status: 200, data: { ok: true, deployment: structuredClone(receipt.deployment) } })
            : httpRequest.method?.toUpperCase() === 'GET'
            && httpRequest.url?.includes(`/environments/${environment.environment.id}`)
            ? (readPageAdmissions++, forwarding && receiverEnvironmentReads++, readAccessRevoked) ? { status: 403, data: { error: 'forbidden' } }
                : { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: structuredClone(environment.environment),
                    targetLinks: environment.targetLinks.map(({ targetLink }) => structuredClone(targetLink)) }) }
            : { status: 200, data: { ok: true, canManage: true,
            source: { id: environment.environment.projectSourceId, revision: 1, name: 'Source', audience: [], createdByAccountId: accountId,
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/app', cloneUrl: 'https://github.com/owner/app.git' }, protocol: 'https' } } } };
        });
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...stored.values()]) };
            if (runtimeRead || scenario === 'runtime_stage' || scenario === 'member_child_cost' || promotionScenario) {
                const id = path.split('/')[3];
                const link = environment.targetLinks.find(item => item.targetLink.contentArtifactId === id);
                const content = id === environment.environment.contentArtifactId ? { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, value: environment.content }
                    : id === receipt.deployment.contentArtifactId ? { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, value: receipt.content }
                        : id === 'promotion-destination' ? { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, value: promotionDestinationContent }
                        : link ? { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, value: link.content } : null;
                if (content && (id === environment.environment.contentArtifactId || link)) privateEnvironmentBodyReads++;
                if (content) return { status: 200, data: { id, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
                    encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent({ kind: content.kind, title: 'Runtime read' }),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(content.value) }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
            }
            artifactReads++;
            if (forwarding && path.startsWith('/v1/artifacts/')) controllerArtifactReads++;
            const effect = artifactReadEffect;
            artifactReadEffect = undefined;
            await effect?.();
            const row = stored.get(path.split('/')[3]);
            return row ? { status: 200, data: row } : { status: 404, data: { error: 'not_found' } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url: string, input: unknown) => {
            if (url.endsWith('/execution-authorization/verify')) {
                readPageAuthorityChecks++;
                return { status: readAccessRevoked ? 403 : 200, data: { ok: !readAccessRevoked } };
            }
            if (url.endsWith('/list') || url.endsWith('/read')) return projectAccountRowsReadHttpResponse(rows, url, input);
            const mutation = readCarrierMutation(input);
            const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/')[3];
            const prior = stored.get(id);
            const version = Number(prior?.headerVersion ?? 0) + 1;
            stored.set(id, { ...prior, ...mutation, id, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                headerVersion: version, bodyVersion: version, seq: 1, createdAt: 1, updatedAt: version });
            writes++;
            return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
        });
        const previousHome = configuration.happyHomeDir;
        const previousSettingsFile = configuration.settingsFile;
        const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: root,
            controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.scm.backend.git',
                ...(migrationBackup ? ['happier.backup.destinations'] : [])] } });
        // Each scenario is a different installed daemon lifetime. Reusing its
        // Home would collide with the preceding committed immutable release.
        Reflect.set(configuration, 'happyHomeDir', root);
        Reflect.set(configuration, 'settingsFile', join(root, 'settings.json'));
        const profile = await addServerProfile({ name: 'home', serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl });
        const homeServerIdentityId = 'srv_deployment_health';
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId, canonicalServerUrl: serverHttpBaseUrl, revision: 1,
            endpoints: [{ kind: 'https', url: serverHttpBaseUrl }],
        }) });
        const incumbentServices = new Set(mounted.registry.projectManagedServices.listProjectServices());
        const caller = new AbortController();
        let retainedReads = 0;
        let healthAttachmentExpected = false;
        let environmentReads = 0;
        let memberEnvironmentReads = 0;
        let memberReceiptReads = 0;
        let recoveryCapture: OwnServerDeploymentReceipt | undefined;
        let retainedPrivateExports: string[] = [];
        let definitionEditedAfterAdmission = false;
        let transitionWrites = 0;
        let migrationBackupActivationCount: number | undefined;
        const routeWrites: number[] = [];
        let unhealthyCandidateConfig: string | undefined;
        let incumbentNativeIds: readonly string[] = [];
        let forwardNativeIds: readonly string[] = [];
        const routeGenerations: Array<Readonly<{ candidate: string; incumbent: string }>> = [];
        let caddyState: Readonly<{ route: CaddyDomainRouteInput; server: {
            routes: unknown[]; errors: { routes: unknown[] };
        } }> | undefined;
        const host: OwnServerDeploymentTargetHostInput = { credentials, serverId: 'home', serverHttpBaseUrl, machineId: 'machine-a',
            ...(scenario === 'private_publication_refused' || scenario === 'private_publication_withdrawal_refused'
                || scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_matching_restore' || scenario === 'runtime_stage' ? { async settlePrivateWorkloadFirewall(
                ...[_request, input]: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['settlePrivateWorkloadFirewall']>>
            ) {
                // Elevation is the native boundary; real source/render/executor admission stay composed.
                expect(input.docker.engineId).toBe(input.render.engineId);
                if (scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_matching_restore' || scenario === 'runtime_stage') {
                    const bindings = privateServicePublicationBindings({ environmentId: input.environment.environment.id,
                        exports: input.environment.content.ownServer?.serviceExports ?? [], services: input.render.review.services,
                        privateNetworks: [{ provider: { kind: 'builtin', id: 'tailscale' },
                            networkIdentity: scenario === 'runtime_stage' ? 'application' : 'shop-net', displayName: null,
                            dnsName: null, magicDnsEnabled: false, addresses: ['100.81.1.12'], state: 'ready',
                            interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'] }] });
                    retainedPrivateExports = bindings.bindings.map(entry => entry.exposure.requirementId);
                    if (scenario === 'private_publication_matching_restore' && retainedPrivateExports.length)
                        throw Object.assign(new Error('Native reply lost after permit application'), { code: 'outcome_unknown' });
                    return;
                }
                if (scenario === 'private_publication_refused') expect(input.render.review.services[0]?.ports).toContainEqual(expect.objectContaining({
                    target: 3000, published: '3000', bindAddress: '100.81.1.12' }));
                else expect(input.environment.content.ownServer?.serviceExports ?? []).toEqual([]);
                throw Object.assign(new Error('private_scope_unenforceable'), { code: 'private_scope_unenforceable' });
            } } : {}),
            ...(startFirst ? { async readStartFirstRoutes() {
                return { async switch(input: Parameters<NativeComposeStartFirstRoutes['switch']>[0]) {
                    incumbentNativeIds = input.incumbent.services.flatMap(service => service.replicas.map(replica => replica.id));
                    routeGenerations.push({ candidate: input.candidate.projectName, incumbent: input.incumbent.projectName });
                    if (routeGenerations.length === 1) forwardNativeIds = input.candidate.services.flatMap(service => service.replicas.map(replica => replica.id));
                    const names = input.incumbent.services.find(service => service.service === 'app')!.replicas.map(replica => replica.name);
                    const [first, ...rest] = names;
                    if (!first) throw new Error('Expected the actual incumbent replicas');
                    const initialRoute: CaddyDomainRouteInput = { domainId: 'start-first-domain', domain: { hostname: 'start-first.example.test',
                        target: { service: 'app', containerPort: 3000 }, healthCheck: { path: '/healthz', expectStatus: 200 } },
                        listener: 'privateOrigin', upstreams: { kind: 'replicas', containerNames: [first, ...rest] }, privateSourceRanges: [] };
                    if (!caddyState) {
                        const material = materializeCaddyDomainRouteV1(initialRoute);
                        caddyState = { route: initialRoute, server: { routes: [material.route], errors: { routes: [material.fallbackRoute] } } };
                    }
                    const { route, server } = caddyState;
                    const replace = (value: unknown, id: string, next: unknown): boolean => {
                        if (value === null || typeof value !== 'object') return false;
                        for (const [key, child] of Object.entries(value)) {
                            if (child && typeof child === 'object' && '@id' in child && child['@id'] === id) {
                                Reflect.set(value, key, structuredClone(next)); return true;
                            }
                            if (replace(child, id, next)) return true;
                        }
                        return false;
                    };
                    // Only native Caddy HTTP is substituted. Exact material,
                    // incumbent comparison, replica replacement and ACK are real.
                    const routes = createNativeCaddyRoutes({ machineId: 'machine-a', installationId: 'installation-a',
                        privateKey: new Uint8Array(64), async exchange(request) {
                            request.signal?.throwIfAborted();
                            const etag = JSON.stringify(server);
                            if (request.method === 'GET') return { status: 200, etag, value: structuredClone(server) };
                            if (request.method !== 'PATCH' || request.etag !== etag) return { status: 412 };
                            const before = await docker.readInvocations();
                            expect(before.filter(call => call.args[0] === 'container' && call.args[1] === 'stop')).toHaveLength(routeWrites.length);
                            expect(before.filter(call => call.args.includes('up'))).toHaveLength(2 + routeWrites.length);
                            if (!replace(server, decodeURIComponent(request.path.slice('/id/'.length)), request.value)) return { status: 404 };
                            routeWrites.push(before.length);
                            if (scenario === 'candidate_start_first_unknown'
                                || scenario === 'candidate_start_first_restore_unknown' && routeWrites.length === 2)
                                throw new Error('Native Caddy reply lost after write');
                            return { status: 200 };
                        } });
                    return createNativeCaddyStartFirstRoutes({ routes, legs: [{ route,
                        placement: { serverId: 'home', accountId, environmentId: environment.environment.id,
                            targetLinkId: receipt.deployment.targetLinkId, domainId: route.domainId,
                            machineId: 'machine-a', installationId: 'installation-a',
                            actionOperationId: receipt.deployment.actionOperationId, requestId: 'start-first-request', nativeServer: 'happier_private' } }] }).switch(input);
                } };
            } } : {}),
            ...(scenario === 'promote_build_refused' ? { async dispatchBuild() {
                // The remote builder transport refuses; receipt settlement and
                // caller-visible failure projection remain real owners.
                return { ok: false as const, errorCode: 'action_forbidden', error: 'action_forbidden' };
            } } : {}),
            ...(scenario === 'promote_cleanup_refused' ? { async dispatchMember(input) {
                // Receiving daemon transport refuses both activation and cleanup.
                const code = input.phase === 'cleanup' ? 'removal_unproved' : 'target_mismatch';
                return { ok: false as const, errorCode: code, error: code };
            } } : {}),
            async readEnvironmentMetadata() { return structuredClone(promotionSource.environment); },
            async readEnvironment({ context }) {
                environmentReads++;
                // Retained C1 observation is an independent live consumer with
                // its own context, not another snapshot in this invocation.
                if (context.operationAcceptance) memberEnvironmentReads++;
                if (healthAttachmentExpected && !context.operationAcceptance) {
                    expect(context.signal?.aborted).toBe(false);
                    expect(context.externalActionExecutionAuthorization).toBeUndefined();
                    expect(context.operationAcceptance).toBeUndefined();
                    retainedReads++;
                    // Withdrawal happens before the independent attachment
                    // read, not after an admitted observer has begun its work.
                    if (scenario === 'retained_health_denied') environment.environment.capabilities.read = false;
                }
                return structuredClone(environment);
            },
            async readReceipt({ deploymentId }) { memberReceiptReads++; return structuredClone(deploymentId === serving.deployment.id ? serving : recoveryCapture?.deployment.id === deploymentId ? recoveryCapture : receipt); },
            readBuildHistory() {
                // Home gives a review its exact receipt reads, never history admission.
                if (scenario === 'review_receipt_scope') throw Object.assign(new Error('Receipt history is not admitted'), { code: 'deployment_access_denied' });
                return (async function* () { yield structuredClone(receipt); if (recoveryCapture) yield structuredClone(recoveryCapture); yield structuredClone(serving); })();
            },
            async writeTransition(input) {
                transitionWrites++;
                // This host port is the persistence boundary. Only its typed
                // failure crosses back through real native stage callbacks.
                if (scenario === 'transition_provenance_reason' && transitionWrites === 1
                    || scenario === 'transition_log_reason' && transitionWrites === 2) {
                    return projectDeploymentTransitionOutcomeUnknownForHost({ response: { status: 503,
                        data: { error: 'database_transaction_conflict_exhausted' } } });
                }
                if (scenario === 'runtime_stage' || scenario === 'member_cost' || scenario === 'candidate_pending_check_zero'
                    || migrationBackup)
                    expect(input.expectedRevision, 'phase-index publication must advance the same held receipt CAS')
                        .toBe(receipt.deployment.revision);
                receipt.deployment = { ...receipt.deployment, state: input.state, revision: receipt.deployment.revision + 1 };
                if (migrationBackup && input.content.ownServer?.preMigrationBackup && migrationBackupActivationCount !== undefined) {
                    // Recovery custody must precede starting the candidate.
                    expect((await docker.readInvocations()).filter(call => call.args.includes('up')))
                        .toHaveLength(migrationBackupActivationCount);
                    migrationBackupActivationCount = undefined;
                }
                if (scenario === 'candidate_backup_configured_failure' && input.content.ownServer?.preMigrationBackup) {
                    await docker.setCommandOutcome({ exitCode: 7 });
                }
                // Home persists serialized bytes, not the sender's object.
                // Later boundary mutations must not rewrite its expected CAS.
                receipt.content = structuredClone(input.content);
                // An independent manager can edit the next desired definition
                // after this finite member invocation admitted its snapshot.
                if (input.content.ownServer?.sources?.length) {
                    if (scenario === 'adopted_generation_admission_changed') await docker.seedComposeGeneration('preexisting-compose-project');
                    if (scenario === 'member_source_environment' && !definitionEditedAfterAdmission) {
                        definitionEditedAfterAdmission = true;
                        if (environment.content.definition.kind !== 'repository') throw new Error('Repository fixture required');
                        environment.environment.revision++;
                        environment.content.definition = { ...environment.content.definition,
                            compose: { ...environment.content.definition.compose, path: 'changed-compose.yaml' } };
                    }
                }
                if ((runtimeRead || scenario === 'runtime_stage') && (input.state === 'succeeded' || input.state === 'running_unverified')) {
                    environment.targetLinks[0].targetLink.activeDeploymentId = receipt.deployment.id;
                }
                return { ok: true, environmentId: input.environmentId,
                revision: environment.environment.revision, deploymentId: input.deploymentId,
                deploymentRevision: receipt.deployment.revision, state: input.state }; },
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl, machineId: 'machine-a',
                resolveRequesterIdentity,
                async acquirePluginRuntimeRegistryLease() { return mounted.controller.tryAcquireRuntimeRegistry()!; },
                async readEnvironmentSecretLaunchAdmission(input) {
                    if ((scenario === 'public_restore' || scenario === 'standalone_public_restore')
                        && input.materialization.kind === 'deployment') {
                        const deploymentId = input.materialization.deploymentId;
                        const materialized = [receipt, serving, recoveryCapture].find(candidate => candidate?.deployment.id === deploymentId);
                        expect(input.actionOperationId ?? input.context.operationAcceptance?.operationId)
                            .toBe(materialized?.deployment.actionOperationId);
                    }
                    return { grants: runtimeGrants, async assertCurrent() {} };
                } }),
        };
        let nativeInventoryReads = 0;
        // Measurement forwards every operation into the real owner. Its public
        // object is frozen, so a spy cannot be installed on that object itself.
        const measuredHost: OwnServerDeploymentTargetHostInput = { ...host, runtime: {
            async acquire(request, admission) {
                const runtime = await host.runtime.acquire(request, admission);
                function listProjectServices(): readonly ProjectManagedServiceHandle[];
                function listProjectServices(options: Readonly<{ requireComplete: true; workspaceRoot?: string }>): Promise<readonly ProjectManagedServiceHandle[]>;
                function listProjectServices(options?: Readonly<{ requireComplete: true; workspaceRoot?: string }>) {
                    nativeInventoryReads++;
                    return options ? runtime.projectManagedServices.listProjectServices(options)
                        : runtime.projectManagedServices.listProjectServices();
                }
                return { ...runtime, projectManagedServices: { ...runtime.projectManagedServices, listProjectServices } };
            },
        } };
        const memberFailures: string[] = [];
        const target: ReturnType<typeof createOwnServerDeploymentTargetForHost> = createOwnServerDeploymentTargetForHost({
            ...measuredHost,
            ...(scenario === 'canonical_home_build' ? { reviewMember: input => target.reviewMember(input) } : {}),
            // Observe the member transport boundary while forwarding into the
            // real executor, so aggregate failure cannot hide its native cause.
            ...(runtimeRead ? { dispatchMember: async (input: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['dispatchMember']>>[0]) => {
                const result = await target.executeMember(input);
                if (!result.ok) memberFailures.push(result.errorCode);
                return result;
            } } : {}),
        });
        let request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
            input: { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                targetLinkId: receipt.deployment.targetLinkId, expectedTargetLinkRevision: environment.targetLinks[0].targetLink.revision,
                requestKey: 'request-a', contentArtifactId: receipt.deployment.contentArtifactId,
                contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
            receipt: { ok: true, environmentId: receipt.deployment.environmentId, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'queued' },
            context: { ...sourceContext, signal: caller.signal, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } },
        };
        const channel = await createRequesterCurrentnessSocketHarness();
        const currentness = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl: serverHttpBaseUrl });
        try {
            if (promotionScenario) {
                const document = await readFile(join(repository, 'compose.yaml'), 'utf8');
                const definition = { kind: 'stored' as const, document, contentRevision: 1,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, services: ['app'], profiles: [] };
                environment.content.definition = definition;
                receipt.content.sourceIntent = definition;
                receipt.deployment.operation = 'promote';
                serving.deployment.environmentId = promotionSource.environment.id;
                serving.content.sourceIntent = definition;
                promotionDestinationContent = prepareStoredPromotionCandidate(serving, environment);
                const input = { ...request.input, sourceEnvironmentId: promotionSource.environment.id,
                    sourceDeploymentId: serving.deployment.id, artifact: 'image' as const,
                    destinationContent: { contentArtifactId: 'promotion-destination', contentHeaderVersion: 1, contentBodyVersion: 1 } };
                request = { ...request, actionId: 'deployments.promote', input };
                const promotion = await readStoredPromotionCandidateForHost({ input, context: request.context }, measuredHost);
                const review = await target.review({ actionId: 'deployments.promote', input, content: receipt.content,
                    candidateEnvironmentContent: promotion.candidateEnvironmentContent, context: sourceContext });
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                receipt.deployment.state = 'running';
                if (scenario === 'promote_build_refused' || scenario === 'promote_cleanup_refused') {
                    receipt.deployment.state = 'queued';
                    if (scenario === 'promote_build_refused') receipt.content.ownServer.approvedInputBasis.runtimeProjections = [{
                        machineId: 'machine-a', installationId: 'installation-a', platform: 'linux/amd64',
                        manifestFingerprint: review.inputBasis.manifestFingerprint, configInputDigests: review.inputBasis.configInputDigests,
                        physicalProjectName: review.inputBasis.physicalProjectName, toolVersion: review.inputBasis.toolVersion,
                        services: review.inputBasis.services, profiles: review.inputBasis.profiles,
                    }];
                    const result = await target.execute(request);
                    const expectedFailure = scenario === 'promote_build_refused'
                        ? { code: 'action_forbidden', phase: 'build' } : { code: 'target_mismatch', phase: 'activate' };
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: expectedFailure.code,
                        error: `${expectedFailure.code} (${expectedFailure.phase})${scenario === 'promote_cleanup_refused' ? '; candidate cleanup failed' : ''}`, details: { deploymentId: receipt.deployment.id,
                            failure: expectedFailure } });
                    expect(receipt.content.failure).toEqual(expectedFailure);
                    if (scenario === 'promote_cleanup_refused') {
                        expect(result).toMatchObject({ details: { cleanupFailure: { code: 'removal_unproved', phase: 'cleanup' } } });
                        expect(receipt.content.machineResults).toEqual([expect.objectContaining({ steps: [expect.objectContaining({
                            id: 'own-server-candidate-cleanup', state: 'failed' })] })]);
                    }
                    expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                    return;
                }
                if (scenario === 'promote_source_demoted') promotionSource.environment.capabilities.deploy = false;
                else if (scenario === 'promote_destination_demoted') {
                    environment.environment.capabilities.manage = false;
                    environment.environment.capabilities.deploy = false;
                }
                // The same demotion denies a fresh admission, while the accepted
                // receipt must finish through real child review and native execution.
                if (scenario !== 'promote_archive_custody') await expect(readStoredPromotionCandidateForHost({ input, context: request.context }, measuredHost))
                    .rejects.toMatchObject({ code: 'deployment_access_denied' });
                const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: async () => null,
                    resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                    async dispatchReceipt() { throw new Error('Accepted member must not allocate a receipt'); } });
                const artifacts = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' });
                const child = createDaemonDeploymentChildExecutor(measuredHost, { target, storage: storage.deploymentAction!,
                    open: id => artifacts.read(id, { prepareRecipients: false, includeSharedAudience: false }),
                    async assertCurrent(context) { context.signal?.throwIfAborted(); },
                    async domainNative() { throw new Error('Unexpected Domain execution'); },
                    async prepareCandidate() { throw new Error('Unexpected candidate preparation'); } });
                if (scenario === 'promote_archive_custody') {
                    receipt.content.ownServer.approvedInputBasis.runtimeProjections = [{
                        machineId: 'machine-a', installationId: 'installation-a', platform: 'linux/amd64',
                        manifestFingerprint: review.inputBasis.manifestFingerprint, configInputDigests: review.inputBasis.configInputDigests,
                        physicalProjectName: review.inputBasis.physicalProjectName, toolVersion: review.inputBasis.toolVersion,
                        services: review.inputBasis.services, profiles: review.inputBasis.profiles,
                    }];
                    const built = await child(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build', actionId: 'deployments.promote',
                        input, machineId: 'machine-a', installationId: 'installation-a', deploymentId: receipt.deployment.id,
                        actionOperationId: receipt.deployment.actionOperationId }), request.context);
                    expect(built, JSON.stringify(built)).toMatchObject({ ok: true, state: 'running' });
                    expect(receipt.content.ownServer.imageArchives?.length).toBeGreaterThan(0);
                    expect(receipt.content.ownServer.imageArchives).not.toEqual(serving.content.ownServer?.imageArchives);
                    expect(receipt.content.images).toEqual(serving.content.images);
                    // New review still rejects a substituted candidate; the
                    // accepted member consumes custody authored by its builder.
                    await expect(child(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.promote',
                        input, machineId: 'machine-a', installationId: 'installation-a' }), sourceContext))
                        .resolves.toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                }
                const result = await child(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.promote',
                    input, machineId: 'machine-a', installationId: 'installation-a', phase: 'activate',
                    selectedDeploymentId: receipt.deployment.id, deploymentId: receipt.deployment.id,
                    actionOperationId: receipt.deployment.actionOperationId }), request.context);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: 'running' });
                expect(receipt.content.machineResults).toEqual(expect.arrayContaining([
                    expect.objectContaining({ machineId: 'machine-a', activation: 'succeeded' }),
                ]));
                expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(true);
                expect(await docker.readRunningImageConfig('app')).toBe(image.configDigest);
                return;
            }
            await currentness.read();
            await channel.settleTransport();
            Object.assign(environment.content.ownServer!, { backupBeforeMigration: false, migrationFailurePolicy: 'rollbackCodeOnly' });
            if (scenario === 'routing_review') {
                const member = createOwnServerDeploymentTargetForHost({ ...measuredHost,
                    dispatchMember: input => target.executeMember(input),
                    runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl,
                        machineId: 'machine-a', resolveRequesterIdentity,
                        async acquirePluginRuntimeRegistryLease() { return mounted.controller.tryAcquireRuntimeRegistry()!; },
                    }) });
                const nextIdentity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
                    resolveHostIdentity: async () => ({ custodianAccountId: accountId,
                        machineId: 'machine-b', installationId: 'installation-b' }) });
                const nextMember = createOwnServerDeploymentTargetForHost({ ...host, machineId: 'machine-b',
                    dispatchMember: input => target.executeMember(input),
                    runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl,
                        machineId: 'machine-b', async resolveRequesterIdentity(context) {
                            const requester = await nextIdentity.resolveActionRequester!(context);
                            try { return requester.identity; } finally { await requester.dispose(); }
                        },
                        async acquirePluginRuntimeRegistryLease() { return mounted.controller.tryAcquireRuntimeRegistry()!; },
                    }) });
                const routedMembers: string[] = [];
                const router = createOwnServerDeploymentTargetForHost({ ...host, machineId: 'publish-host',
                    // The Machine transport boundary forwards into each real
                    // receiving owner; no native review result is substituted.
                    reviewMember: async input => {
                        routedMembers.push(input.machineId);
                        const identity = installationStore.readInstallationIdentityIfExistsSync();
                        vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ ...identity!,
                            installationId: input.installationId });
                        const receivingContext = { ...input.request.context,
                            machineAdmission: { ...sourceContext.machineAdmission,
                                machineId: input.machineId, installationId: input.installationId } };
                        try {
                            return await (input.machineId === 'machine-a' ? member : nextMember).reviewMember({ ...input,
                                request: { ...input.request, context: receivingContext } });
                        } finally { vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue(identity); }
                    } });
                const reviewRequest = { actionId: request.actionId, input: request.input,
                    content: receipt.content, context: sourceContext };
                const reviewed = await router.review(reviewRequest);
                expect(reviewed.inputBasis.runtimeProjections?.map(value => value.machineId)).toEqual(['machine-a']);
                expect(routedMembers).toEqual(['machine-a']);
                const link = environment.targetLinks[0].targetLink;
                link.members.push({ machineId: 'machine-b', installationId: 'installation-b', state: 'active' });
                link.machines.push('machine-b');
                receipt.content.machines.push('machine-b');
                rows.push(createPlainProjectAccountRefRow({ id: 'checkout-b', serverId: 'home', machineId: 'machine-b',
                    rootPath: repository, source: { sourceId: environment.environment.projectSourceId, revision: 1 }, createdAtMs: 1 }));
                runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-b',
                    installationId: 'installation-b', environmentId: environment.environment.id,
                    resourceId: 'review-secret', resourceRevision: 1 }, installationPublicKey,
                    content: { kind: 'secret', value: 'review-secret-value-sentinel' } }));
                const multiReview = await router.review(reviewRequest);
                expect(multiReview.inputBasis.runtimeProjections?.map(value => value.machineId)).toEqual(['machine-a', 'machine-b']);
                expect(routedMembers).toEqual(['machine-a', 'machine-a', 'machine-b']);
                await expect(router.reviewMember({ request: reviewRequest, machineId: 'publish-host',
                    installationId: 'publish-installation' })).rejects.toMatchObject({ code: 'target_mismatch' });
                expect(transitionWrites).toBe(0);
                return;
            }
            if (scenario === 'transition_provenance_reason' || scenario === 'transition_log_reason') {
                const initial = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: initial.inputBasis };
                const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
                    error: expect.stringContaining('database_transaction_conflict_exhausted'), failureCause: {
                        phase: 'deployment.transition', errorCode: 'database_transaction_conflict_exhausted', httpStatus: 503,
                    } });
                return;
            }
            if (migrationBackup) {
                const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
                for (const role of roles) {
                    environment.content.bindings.push({ purpose: 'backupDestination', configKey: 'destination', role,
                        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 } });
                    runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                        installationId: 'installation-a', environmentId: environment.environment.id, resourceId: role, resourceRevision: 1 },
                        installationPublicKey, content: { kind: 'secret', value: `private-${role}` } }));
                }
                const databaseBinding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'DB_NAME',
                    source: { kind: 'value' as const, value: database } };
                environment.content.bindings.push(databaseBinding);
                runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues', machineId: 'machine-a',
                    installationId: 'installation-a', environmentId: environment.environment.id,
                    binding: { purpose: 'variable', phase: 'runtime', name: 'DB_NAME' } }, installationPublicKey,
                    content: { kind: 'environmentValues', definition: databaseBinding.source } }));
                const initial = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: initial.inputBasis };
                const initialActivation = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(initialActivation, initialActivation.ok ? undefined : initialActivation.errorCode).toMatchObject({ ok: true });
                Object.assign(serving, structuredClone(receipt));
                serving.deployment.state = 'succeeded';
                environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                environment.content = DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
                    template: { templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['app'],
                        definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, data: {
                        engine: 'postgres', service: 'app', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } } },
                    backup: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.destinations', localId: 's3' },
                        occurrenceId: mounted.registry.readPluginOccurrenceId('happier.backup.destinations'),
                        config: { endpoint: 'https://fixture.invalid', bucket: 'backup', prefix: '' },
                        credentialBindings: roles.map(role => ({ purpose: 'backupDestination', configKey: 'destination', role })),
                        sources: [{ kind: 'dump', sourceId: 'database', service: 'app', consistency: 'logical' }],
                        ownership: { environmentId: environment.environment.id, prefix: environment.environment.id }, retention: { kind: 'keepEverything' } },
                    ownServer: { ...environment.content.ownServer, backupBeforeMigration: true, migrationFailurePolicy: 'ask',
                        migration: { service: 'app', argv: ['migrate', '--candidate-release'] } } });
                if (scenario.startsWith('public_backup')) {
                    await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
                    const boundary = await installRestoreBoundary(root, 'success',
                        { toolDirectory: join(root, 'docker'), environmentId: environment.environment.id });
                    const operations = createHostActionOperationRuntime({ machineId: 'machine-a', serverId: 'home',
                        custodyBinding: { serverId: 'home', installationId: 'installation-a' }, resolveAccountId: async () => accountId });
                    const deploymentBackupAction = createDeploymentBackupActionForHost({ serverId: 'home', machineId: 'machine-a',
                        async assertCurrent() { caller.signal.throwIfAborted(); }, backup: target.backup,
                        readBackupOperations: (target, context) => operations.readDeploymentBackupOperations({ target, context }) });
                    const deploymentRestore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine-a',
                        async assertCurrent() { caller.signal.throwIfAborted(); }, restore: target.restore,
                        readBackupOperations: (target, context) => operations.readDeploymentBackupOperations({ target, context }),
                        readPreparation: (operationId, context) => operations.readRestorePreparation({ operationId, context }) });
                    const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: async () => null,
                        resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                        async dispatchReceipt() { throw new Error('Backup Actions must not allocate deployment receipts'); } });
                    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), serverId: 'home', machineId: 'machine-a',
                        resolveEnvironmentApprovalScope: storage.resolveEnvironmentApprovalScope,
                        deploymentBackupAction, deploymentRestore, runActionOperation: value => operations.runActionOperation(value) });
                    const actionsSettings = setScopedActionApprovalPreference({ settings: DEPLOYMENT_BACKUP_ACTION_IDS_V1.reduce((settings, actionId) => setScopedActionApprovalPreference({
                        settings, actionId, scope: { kind: 'environment', environmentId: environment.environment.id }, surface: 'ui', mode: 'waived',
                    }), ActionsSettingsV1Schema.parse({ v: 1 })), actionId: 'deployments.backups.restore',
                        scope: { kind: 'environment', environmentId: environment.environment.id }, surface: 'ui', mode: 'waived' });
                    const actionContext = { ...sourceContext, surface: 'ui' as const, actionCaller: { kind: 'host' as const },
                        serverId: 'home', runtimeAccountId: accountId, signal: caller.signal, actionsSettings };
                    const targetInput = { serverId: 'home', environmentId: environment.environment.id, machineId: 'machine-a',
                        installationId: 'installation-a', targetLinkId: environment.targetLinks[0].targetLink.id,
                        deploymentId: serving.deployment.id, expectedRevision: environment.environment.revision, configRevision: 1 };
                    if (scenario === 'public_backup_probe') {
                        const before = await readFile(boundary.eventsFile, 'utf8');
                        for (const surface of ['ui', 'agent'] as const) {
                            await boundary.setRepositoryConfigExitCode(0);
                            expect(await executor.execute('deployments.backups.test',
                                buildDeploymentBackupActionInputV1('deployments.backups.test', targetInput),
                                { ...actionContext, surface, actionRequestId: `probe-success-${surface}` }))
                                .toMatchObject({ ok: true, result: { kind: 'reachable', repositoryId: 'c'.repeat(64) } });
                            await boundary.setRepositoryConfigExitCode(12);
                            expect(await executor.execute('deployments.backups.test',
                                buildDeploymentBackupActionInputV1('deployments.backups.test', targetInput),
                                { ...actionContext, surface, actionRequestId: `probe-failed-${surface}` }))
                                .toMatchObject({ ok: true, result: { kind: 'failed', reason: 'repository_password_incorrect',
                                    step: 'repository', nativeExitCode: 12, remedy: 'review_credentials' } });
                        }
                        const events = (await readFile(boundary.eventsFile, 'utf8')).slice(before.length).trim().split('\n')
                            .filter(Boolean).map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                        expect(events.filter(event => event.kind === 'restic').map(event => event.argv))
                            .toEqual(Array.from({ length: 4 }, () => ['--repo', 's3:https://fixture.invalid/backup', '--json', 'cat', 'config']));
                        expect(events.some(event => event.kind === 'postgres' || event.kind === 'nativeControl'
                            || event.kind === 'safetyBytes' || event.argv?.includes('backup'))).toBe(false);
                        expect(await docker.readOperationContainerIds()).toEqual([]);
                        return;
                    }
                    const backupConfiguration = environment.content.backup;
                    if (!backupConfiguration || 'notNeeded' in backupConfiguration) throw new Error('Expected configured backups');
                    const recordedHealth = createDeploymentBackupRecordedHealthForHost({
                        machineId: targetInput.machineId,
                        readBackupOperations: (target, context) => operations.readDeploymentBackupOperations({ target, context }) });
                    const readRecordedHealth = async () => {
                        const beforeNative = await docker.readInvocations();
                        const beforeEvents = await readFile(boundary.eventsFile, 'utf8');
                        const beforeHomeRequests = [vi.mocked(axios.get).mock.calls.length,
                            vi.mocked(axios.post).mock.calls.length, vi.mocked(axios.request).mock.calls.length];
                        const result = DeploymentBackupRecordedHealthV1Schema.parse(await recordedHealth(
                            buildDeploymentBackupActionInputV1('deployments.backups.inventory', targetInput), backupConfiguration, actionContext));
                        expect(await docker.readInvocations()).toEqual(beforeNative);
                        expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeEvents);
                        expect([vi.mocked(axios.get).mock.calls.length, vi.mocked(axios.post).mock.calls.length,
                            vi.mocked(axios.request).mock.calls.length]).toEqual(beforeHomeRequests);
                        return result;
                    };
                    if (scenario === 'public_backup_recorded_health') {
                        expect(await readRecordedHealth()).toEqual({ status: 'actionNeeded', reason: 'no_verified_backup_yet',
                            backups: { history: { entries: [] } } });
                    }
                    const savedNightly = scenario === 'public_backup' ? {
                        definition: createNightlyBackupsWorkflowV1(),
                        inputs: { backupTarget: structuredClone(targetInput), verificationLevel: 'manifestReadBack',
                            retention: backupConfiguration.retention },
                    } : null;
                    if (savedNightly) {
                        // Nightly retains these operands at activation. An unrelated
                        // Environment edit must not invalidate that saved backup target.
                        environment.environment.revision++;
                        expect(targetInput.expectedRevision).toBe(environment.environment.revision - 1);
                    }
                    const run = await executor.execute('deployments.backups.run', buildDeploymentBackupActionInputV1('deployments.backups.run', targetInput),
                        { ...actionContext, actionRequestId: 'public-backup-run' });
                    expect(run, JSON.stringify(run)).toMatchObject({ ok: true, result: { kind: 'verified' } });
                    if (!run.ok) throw new Error('Expected a retained backup operation');
                    const captured = DeploymentBackupRunResultV1Schema.parse(run.result);
                    const manifest = captured.manifests[0];
                    if (!manifest) throw new Error('Expected exact native snapshot evidence');
                    if (scenario === 'public_backup') {
                        expect(captured.restoreCaptures).toEqual([expect.objectContaining({ source: manifest,
                            sourceFormat: 'postgresCustom', target: { service: 'app', adapter: 'postgres-v1', database },
                            configuration: backupConfiguration, repository: { repository: 's3:https://fixture.invalid/backup' } })]);
                    }
                    if (savedNightly) {
                        const store = createInMemoryWorkflowCoordinatorStore();
                        const coordinator = createTestWorkflowCoordinator({ store,
                            resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine-a',
                                directory: root, checkoutRootPath: root } }),
                            executeStep: async () => { throw new Error('Nightly only executes backup Actions'); },
                            action: { executor, buildContext: async () => actionContext,
                                observeRun: async () => { throw new Error('No agent Run expected for Nightly'); } },
                        });
                        const scheduled = await coordinator.run({ runId: 'nightly-after-environment-edit', ...savedNightly,
                            executionTarget: { kind: 'detached_run' },
                            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
                            automationCause: { kind: 'trigger', triggerId: 'nightly-backup', triggerRevision: 1,
                                triggerKind: 'schedule', occurrenceKey: 'A'.repeat(43), occurredAt: 2,
                                evidence: { scheduledFor: 2 } },
                            signal: caller.signal });
                        expect(scheduled, JSON.stringify(scheduled)).toMatchObject({ state: 'succeeded' });
                        for (const blockId of ['backup', 'verify', 'prune']) {
                            expect(store.list().find(row => row.blockId === blockId)).toMatchObject({ lifecycle: 'completed' });
                        }
                        expect(savedNightly.inputs.backupTarget.expectedRevision).toBe(environment.environment.revision - 1);
                        // A genuine dump-process failure must remain visible through
                        // the existing history producer used by the Backups notice.
                        const nativeState = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                        await writeFile(boundary.stateFile, JSON.stringify({ ...nativeState, mode: 'dumpFailure' }));
                        const failed = await executor.execute('deployments.backups.run',
                            buildDeploymentBackupActionInputV1('deployments.backups.run', targetInput),
                            { ...actionContext, actionRequestId: 'nightly-failed-dump' });
                        expect(failed.ok).toBe(false);
                        if (failed.ok) throw new Error('Expected the dump process failure');
                        const history = await executor.execute('deployments.backups.history',
                            buildDeploymentBackupActionInputV1('deployments.backups.history', targetInput), actionContext);
                        expect(history).toMatchObject({ ok: true, result: { history: { entries: expect.arrayContaining([
                            expect.objectContaining({ action: 'backup', state: 'failed', code: failed.errorCode }),
                        ]) } } });
                        // Failed streams retain native custody until a subsequent
                        // operation observes their settlement, before this fixture ends.
                        const recovered = await executor.execute('deployments.backups.inventory',
                            buildDeploymentBackupActionInputV1('deployments.backups.inventory', targetInput),
                            { ...actionContext, actionRequestId: 'nightly-after-failed-dump' });
                        expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true });
                        return;
                    }
                    const inventory = await executor.execute('deployments.backups.inventory',
                        buildDeploymentBackupActionInputV1('deployments.backups.inventory', targetInput),
                        { ...actionContext, actionRequestId: 'public-backup-inventory' });
                    expect(inventory, JSON.stringify(inventory)).toMatchObject({ ok: true, result: { kind: 'inventory' } });
                    if (!inventory.ok) throw new Error('Expected the selected repository inventory');
                    expect(DeploymentBackupInventoryResultV1Schema.parse(inventory.result).snapshots).toContainEqual({
                        snapshot: manifest.snapshot, source: { sourceId: 'database', kind: 'dump' }, totalBytesProcessed: manifest.totalBytesProcessed,
                        verification: { kind: 'verified', backupOperationId: captured.operationId, configRevision: manifest.configRevision } });
                    const beforeVerify = await readFile(boundary.eventsFile, 'utf8');
                    const verified = await executor.execute('deployments.backups.verify', buildDeploymentBackupActionInputV1('deployments.backups.verify', {
                        ...targetInput, backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId, level: 'manifestReadBack',
                    }), { ...actionContext, actionRequestId: 'public-backup-verify' });
                    expect(verified, JSON.stringify(verified)).toMatchObject({ ok: true, result: { kind: 'verified',
                        backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId, verified: true } });
                    const verifyEvents = (await readFile(boundary.eventsFile, 'utf8')).slice(beforeVerify.length).trim().split('\n').filter(Boolean)
                        .map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                    expect(verifyEvents.some(event => event.kind === 'postgres' || event.kind === 'nativeControl'
                        || event.kind === 'safetyBytes' || event.argv?.includes('backup'))).toBe(false);
                    if (scenario === 'public_backup_recorded_health') {
                        const retained = await operations.readDeploymentBackupOperations({ target: targetInput, context: actionContext });
                        const runReceipt = retained.find(row => row.snapshot.operationId === captured.operationId)?.snapshot;
                        const verificationReceipt = retained.find(row => row.snapshot.actionId === 'deployments.backups.verify')?.snapshot;
                        if (!runReceipt?.settledAt || !verificationReceipt?.settledAt) throw new Error('Expected recorded backup and verify times');
                        expect(await readRecordedHealth()).toMatchObject({ status: 'ready', backups: {
                            lastSuccessfulBackup: { operationId: captured.operationId, completedAt: runReceipt.settledAt,
                                configRevision: 1, snapshotIds: [manifest.snapshot.snapshotId] },
                            lastVerification: { operationId: verificationReceipt.operationId, completedAt: verificationReceipt.settledAt,
                                configRevision: 1, backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId,
                                level: 'manifestReadBack', result: 'verified' } } });
                        // Docker is the genuine native boundary; fail the next repository check container.
                        await boundary.setRepositoryCheckExitCode(7);
                        const failedVerification = await executor.execute('deployments.backups.verify',
                            buildDeploymentBackupActionInputV1('deployments.backups.verify', { ...targetInput,
                                backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId, level: 'repositoryCheck' }),
                            { ...actionContext, actionRequestId: 'public-backup-verify-failed' });
                        await boundary.setRepositoryCheckExitCode(0);
                        expect(failedVerification).toMatchObject({ ok: false, errorCode: 'backup_failed' });
                        const beforeFailedRejoin = await docker.readInvocations();
                        const beforeFailedRejoinEvents = await readFile(boundary.eventsFile, 'utf8');
                        expect(await executor.execute('deployments.backups.verify',
                            buildDeploymentBackupActionInputV1('deployments.backups.verify', { ...targetInput,
                                backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId, level: 'repositoryCheck' }),
                            { ...actionContext, actionRequestId: 'public-backup-verify-failed' }))
                            .toMatchObject({ ok: false, errorCode: 'backup_failed', details: { step: 'repositoryCheck', code: 'backup_failed' } });
                        expect(await docker.readInvocations()).toEqual(beforeFailedRejoin);
                        expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeFailedRejoinEvents);
                        const failedReceipt = (await operations.readDeploymentBackupOperations({ target: targetInput, context: actionContext }))
                            .find(row => row.snapshot.actionId === 'deployments.backups.verify' && row.snapshot.state === 'failed')?.snapshot;
                        if (!failedReceipt?.settledAt) throw new Error('Expected the failed verification receipt');
                        expect(await readRecordedHealth()).toMatchObject({ status: 'actionNeeded', backups: {
                            lastSuccessfulBackup: { operationId: captured.operationId, completedAt: runReceipt.settledAt },
                            lastVerification: { operationId: failedReceipt.operationId, completedAt: failedReceipt.settledAt,
                                configRevision: 1, backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId,
                                level: 'repositoryCheck', result: 'failed', code: 'backup_failed', step: 'repositoryCheck' } } });
                        const historyInput = buildDeploymentBackupActionInputV1('deployments.backups.history', targetInput);
                        const beforeHistory = await docker.readInvocations();
                        const beforeHistoryEvents = await readFile(boundary.eventsFile, 'utf8');
                        for (const surface of ['ui', 'agent'] as const) {
                            expect(await executor.execute('deployments.backups.history', historyInput,
                                { ...actionContext, surface, actionRequestId: `backup-history-${surface}` }))
                                .toMatchObject({ ok: true, result: { kind: 'history', history: { entries: expect.arrayContaining([
                                    expect.objectContaining({ action: 'verify', state: 'failed', code: 'backup_failed' }),
                                    expect.objectContaining({ action: 'backup', operationId: captured.operationId, state: 'succeeded' }),
                                ]) }, lastVerification: { operationId: failedReceipt.operationId, result: 'failed' } } });
                        }
                        expect(await docker.readInvocations()).toEqual(beforeHistory);
                        expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeHistoryEvents);
                        return;
                    }
                    const beforePrune = await readFile(boundary.stateFile, 'utf8');
                    expect(await executor.execute('deployments.backups.prune', buildDeploymentBackupActionInputV1('deployments.backups.prune', {
                        ...targetInput, retention: { kind: 'keepEverything' },
                    }), { ...actionContext, actionRequestId: 'public-backup-prune' }))
                        .toMatchObject({ ok: true, result: { kind: 'noop', forgottenSnapshotIds: [] } });
                    expect(await readFile(boundary.stateFile, 'utf8')).toBe(beforePrune);
                    if (scenario === 'public_backup_retention') {
                        const configuration = environment.content.backup;
                        if (!configuration || 'notNeeded' in configuration) throw new Error('Expected configured backups');
                        // The retained Home receipt and person-selected policy are storage-boundary inputs.
                        configuration.retention = { kind: 'keep', last: 1 };
                        receipt.deployment.state = 'succeeded';
                        const source = { ...sourceManifest, environmentId: environment.environment.id,
                            snapshot: { ...sourceManifest.snapshot, hostname: `happier-env-${environment.environment.id}`,
                                tags: ['happier', `env:${environment.environment.id}`, 'kind:dump', 'src:database'] } };
                        serving.content.ownServer!.preMigrationBackup = { source, sourceFormat: 'postgresCustom',
                            target: { service: 'app', adapter: 'postgres-v1', database }, configuration,
                            repository: { repository: 's3:https://fixture.invalid/backup' } };
                        const restoreInput = { ...targetInput, mode: 'prepare' as const,
                            restoreBackupId: source.snapshot.snapshotId };
                        const { configRevision: _configRevision, ...prepareInput } = restoreInput;
                        phase('retention-prepare');
                        const preparation = await executor.execute('deployments.backups.restore', prepareInput,
                            { ...actionContext, actionRequestId: 'retention-prepare' });
                        expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                        if (!preparation.ok) throw new Error('Expected retained restore preparation');
                        const prepared = DeploymentBackupRestoreResultV1Schema.parse(preparation.result);
                        if (prepared.kind !== 'prepared') throw new Error('Expected retained restore source');
                        const pruneInput = buildDeploymentBackupActionInputV1('deployments.backups.prune', {
                            ...targetInput, retention: configuration.retention });
                        phase('retention-protected-prune');
                        expect(await executor.execute('deployments.backups.prune', pruneInput,
                            { ...actionContext, actionRequestId: 'retention-before-confirm' }))
                            .toMatchObject({ ok: true, result: { kind: 'noop', forgottenSnapshotIds: [] } });
                        phase('retention-confirm');
                        expect(await executor.execute('deployments.backups.restore', { ...prepareInput, mode: 'confirm',
                            prepareOperationId: prepared.operationId }, { ...actionContext, actionRequestId: 'retention-confirm' }))
                            .toMatchObject({ ok: true, result: { kind: 'restored', verified: true, nextAction: 'none' } });
                        phase('retention-settled-prune');
                        expect(await executor.execute('deployments.backups.prune', pruneInput,
                            { ...actionContext, actionRequestId: 'retention-after-confirm' }))
                            .toMatchObject({ ok: true, result: { kind: 'pruned', forgottenSnapshotIds: [source.snapshot.snapshotId] } });
                        phase('retention-settled');
                        expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).forgottenSnapshotIds).toEqual([source.snapshot.snapshotId]);
                        expect(await executor.execute('deployments.backups.history',
                            buildDeploymentBackupActionInputV1('deployments.backups.history', targetInput),
                            { ...actionContext, actionRequestId: 'backup-history-after-prune' }))
                            .toMatchObject({ ok: true, result: { kind: 'history', history: { entries: expect.arrayContaining([
                                expect.objectContaining({ action: 'prune', state: 'succeeded', snapshotIds: [source.snapshot.snapshotId] }),
                            ]) } } });
                    }
                    expect(await docker.readOperationContainerIds()).toEqual([]);
                    return;
                }
                receipt.deployment = { ...receipt.deployment, id: 'migration-candidate', actionOperationId: 'migration-operation',
                    contentArtifactId: 'migration-content', revision: 1, state: 'running' };
                receipt.content = { ...receipt.content, ownServer: undefined, machineResults: [], steps: [] };
                request = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                    receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1 },
                    context: { ...request.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                const review = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
                const boundary = await installRestoreBoundary(root, 'success', { toolDirectory: join(root, 'docker'),
                    environmentId: environment.environment.id });
                migrationBackupActivationCount = (await docker.readInvocations()).filter(call => call.args.includes('up')).length;
                const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(result, JSON.stringify({ result, failure: receipt.content.failure, steps: receipt.content.steps }))
                    .toMatchObject(scenario === 'candidate_backup_configured_failure'
                        ? { ok: false, errorCode: 'deployment_failed' } : { ok: true, state: 'running' });
                expect(receipt.content.ownServer?.preMigrationBackup).toMatchObject({ target: { database },
                    repository: { repository: 's3:https://fixture.invalid/backup' } });
                expect(receipt.content.steps).toContainEqual(expect.objectContaining({ id: 'own-server-migration',
                    state: scenario === 'candidate_backup_configured_failure' ? 'failed' : 'succeeded' }));
                const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean)
                    .map(value => JSON.parse(value) as { kind: string });
                expect(events.some(event => event.kind === 'safetyBytes')).toBe(true);
                expect(await docker.readCompletedCommand(['migrate', '--candidate-release']))
                    .toBe(scenario === 'candidate_backup_configured_failure' ? 7 : 0);
                return;
            }
            if (scenario === 'public_restore' || scenario === 'standalone_public_restore') {
                phase('standalone-seed');
                const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
                for (const role of roles) {
                    environment.content.bindings.push({ purpose: 'backupDestination', configKey: 'destination', role,
                        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 } });
                    runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                        installationId: 'installation-a', environmentId: environment.environment.id, resourceId: role, resourceRevision: 1 },
                        installationPublicKey, content: { kind: 'secret', value: `private-${role}` } }));
                }
                const initial = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: initial.inputBasis };
                expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id })).toMatchObject({ ok: true });
                phase('standalone-seeded');
                Object.assign(serving, structuredClone(receipt));
                serving.deployment.state = 'succeeded';
                environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
                const boundary = await installRestoreBoundary(root, scenario === 'standalone_public_restore' ? 'safety' : 'success',
                    { toolDirectory: join(root, 'docker'), environmentId: environment.environment.id });
                const capture = { source: { ...sourceManifest, environmentId: environment.environment.id,
                    snapshot: { ...sourceManifest.snapshot, hostname: `happier-env-${environment.environment.id}`,
                        tags: ['happier', `env:${environment.environment.id}`, 'kind:dump', 'src:database'] } },
                    sourceFormat: 'postgresCustom' as const, target: { service: 'app', adapter: 'postgres-v1' as const, database },
                    configuration: { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 's3' },
                        occurrenceId: 'storage', config: { endpoint: 'https://fixture.invalid', bucket: 'backup',
                            region: 'us-east-1', addressing: 'path' },
                        credentialBindings: roles.map(role => ({ purpose: 'backupDestination' as const, configKey: 'destination' as const, role })),
                        sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'app', consistency: 'logical' as const }],
                        ownership: { environmentId: environment.environment.id, prefix: environment.environment.id }, retention: { kind: 'keepEverything' as const } },
                    repository: { repository: 's3:https://fixture.invalid/backup',
                        s3: { region: 'us-east-1', addressing: 'path' as const } } };
                const originalRequest = request;
                if (scenario === 'public_restore') for (const mode of ['unknown', 'otherEnvironment', 'foreignSnapshot', 'noBackup', 'recorded'] as const) {
                    recoveryCapture = structuredClone(serving);
                    recoveryCapture.deployment = { ...recoveryCapture.deployment, id: 'failed-migration', state: 'failed' };
                    recoveryCapture.content.ownServer!.preMigrationBackup = structuredClone(capture);
                    if (mode === 'otherEnvironment') recoveryCapture.deployment.environmentId = 'other-environment';
                    if (mode === 'foreignSnapshot') recoveryCapture.content.ownServer!.preMigrationBackup!.source.snapshot.tags = ['happier', 'env:foreign'];
                    if (mode === 'noBackup') delete recoveryCapture.content.ownServer!.preMigrationBackup;
                    receipt.deployment = { ...receipt.deployment, id: `recovery-${mode}`, actionOperationId: `recovery-${mode}`,
                        contentArtifactId: `content-${mode}`, revision: 1, state: 'running' };
                    receipt.content = structuredClone(serving.content);
                    receipt.content.ownServer = { approvedInputBasis: initial.inputBasis };
                    receipt.content.steps = [];
                    request = { ...originalRequest, actionId: 'deployments.rollback', input: { ...originalRequest.input,
                        contentArtifactId: receipt.deployment.contentArtifactId, deploymentId: serving.deployment.id,
                        restoreBackupId: mode === 'unknown' ? 'f'.repeat(64) : capture.source.snapshot.snapshotId },
                        receipt: { ...originalRequest.receipt, deploymentId: receipt.deployment.id, state: 'running' },
                        context: { ...originalRequest.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                    const before = (await docker.readInvocations()).filter(call => call.args.includes('up')).length;
                    const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                    expect(result).toMatchObject(mode === 'recorded' ? { ok: true } : {
                        ok: false, errorCode: mode === 'otherEnvironment' ? 'stale_input' : 'backup_required' });
                    expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(before + (mode === 'recorded' ? 1 : 0));
                    if (mode === 'recorded') {
                        expect(receipt.content.steps).toContainEqual({ id: 'own-server-database-restore', label: 'Restore recorded database backup', state: 'succeeded' });
                        expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).names).toContain(database);
                        const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
                        expect(events.some(value => value.kind === 'restic' && value.argv.includes(capture.source.snapshot.snapshotId))).toBe(true);
                        expect(events.filter(value => value.kind === 'runtimePull')).toHaveLength(1);
                    }
                }
                if (scenario === 'public_restore') return;
                recoveryCapture = structuredClone(serving);
                recoveryCapture.deployment = { ...recoveryCapture.deployment, id: 'failed-migration', state: 'failed' };
                recoveryCapture.content.ownServer!.preMigrationBackup = structuredClone(capture);
                const operations = createHostActionOperationRuntime({ machineId: 'machine-a', serverId: 'home',
                    custodyBinding: { serverId: 'home', installationId: 'installation-a' }, resolveAccountId: async () => accountId });
                const deploymentRestore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine-a',
                    async assertCurrent() { caller.signal.throwIfAborted(); }, restore: target.restore,
                    readPreparation: (operationId, context) => operations.readRestorePreparation({ operationId, context }) });
                const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: async () => null,
                    resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                    async dispatchReceipt() { throw new Error('Standalone restore must not allocate a deployment receipt'); } });
                let approvalRequests = 0;
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), serverId: 'home', machineId: 'machine-a',
                    resolveEnvironmentApprovalScope: storage.resolveEnvironmentApprovalScope,
                    // Approval persistence is an external storage boundary.
                    approvalsCreate: async () => ({ artifactId: `import-restore-review-${++approvalRequests}` }),
                    deploymentRestore, runActionOperation: value => operations.runActionOperation(value) });
                const actionContext = { ...sourceContext, surface: 'ui' as const, actionCaller: { kind: 'host' as const },
                    serverId: 'home', runtimeAccountId: accountId,
                    actionsSettings: setScopedActionApprovalPreference({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
                        actionId: 'deployments.backups.restore', scope: { kind: 'environment', environmentId: environment.environment.id },
                        surface: 'ui', mode: 'waived' }) };
                const restoreInput = { mode: 'prepare' as const, serverId: 'home', environmentId: environment.environment.id,
                    machineId: 'machine-a', installationId: 'installation-a', targetLinkId: environment.targetLinks[0].targetLink.id,
                    deploymentId: recoveryCapture!.deployment.id, restoreBackupId: capture.source.snapshot.snapshotId,
                    expectedRevision: environment.environment.revision };
                const defaultSettings = ActionsSettingsV1Schema.parse({ v: 1 });
                const requiredUiSettings = setScopedActionApprovalPreference({ settings: defaultSettings,
                    actionId: 'deployments.backups.restore', scope: { kind: 'environment', environmentId: environment.environment.id },
                    surface: 'ui', mode: 'required' });
                const agentContext = { ...actionContext, surface: 'agent' as const, authority: 'account_automation' as const,
                    actionCaller: { kind: 'host' as const }, actionsSettings: defaultSettings };
                const waivedAgentContext = { ...agentContext, actionsSettings: setScopedActionApprovalPreference({
                    settings: defaultSettings, actionId: 'deployments.backups.restore',
                    scope: { kind: 'environment', environmentId: environment.environment.id }, surface: 'agent', mode: 'waived' }) };
                const before = await docker.readInvocations();
                const beforeTransitions = transitionWrites;
                const pointer = environment.targetLinks[0].targetLink.activeDeploymentId;
                const beforePrepare = await readFile(boundary.eventsFile, 'utf8');
                expect(await executor.execute('deployments.backups.restore', restoreInput,
                    { ...agentContext, actionRequestId: 'import-prepare-ask' }))
                    .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(approvalRequests).toBe(1);
                expect(await executor.execute('deployments.backups.restore', restoreInput,
                    { ...actionContext, actionsSettings: requiredUiSettings, actionRequestId: 'import-prepare-ui-ask' }))
                    .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(approvalRequests).toBe(2);
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforePrepare);
                expect(await docker.readInvocations()).toHaveLength(before.length);
                const missingConfirmation = await executor.execute('deployments.backups.restore', { ...restoreInput,
                    mode: 'confirm', prepareOperationId: 'missing-prepare' }, { ...actionContext, actionRequestId: 'missing-confirm' });
                expect(missingConfirmation).toMatchObject({ ok: false, errorCode: 'restore_prepare_required' });
                expect(await docker.readInvocations()).toHaveLength(before.length);
                const discardedPreparation = await executor.execute('deployments.backups.restore', restoreInput,
                    { ...actionContext, actionRequestId: 'discarded-prepare' });
                expect(discardedPreparation).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                phase('standalone-discarded-prepared');
                if (!discardedPreparation.ok) throw new Error('Expected public restore preparation for stale input');
                const discarded = DeploymentBackupRestoreResultV1Schema.parse(discardedPreparation.result);
                if (discarded.kind !== 'prepared') throw new Error('Expected discarded restore preparation evidence');
                const beforeStale = await readFile(boundary.eventsFile, 'utf8');
                expect(await executor.execute('deployments.backups.restore', { ...restoreInput, mode: 'confirm',
                    prepareOperationId: discarded.operationId, restoreBackupId: 'f'.repeat(64) },
                    { ...actionContext, actionRequestId: 'stale-confirm' }))
                    .toMatchObject({ ok: false, errorCode: 'stale_input' });
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeStale);
                const beforeApprovedPrepare = await readFile(boundary.eventsFile, 'utf8');
                phase('standalone-prepare');
                const preparation = await executor.execute('deployments.backups.restore', restoreInput,
                    { ...actionContext, actionRequestId: 'standalone-prepare' });
                expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                if (!preparation.ok) throw new Error('Expected retained public restore preparation');
                const preparedResult = DeploymentBackupRestoreResultV1Schema.parse(preparation.result);
                if (preparedResult.kind !== 'prepared') throw new Error('Expected public restore preparation evidence');
                phase('standalone-prepared');
                expect(preparedResult.steps).toEqual([{ id: 'safety', status: 'completed' }]);
                expect(preparedResult.evidence).toMatchObject({ native: { prepared: { source: capture.source,
                    repository: capture.repository, destination: { databaseExists: true, hasMeaningfulData: true },
                    safetyBackup: { kind: 'verified', manifests: [expect.any(Object)] } }, configuration: capture.configuration } });
                const preparedEvents = await readFile(boundary.eventsFile, 'utf8');
                const safetyEvents = preparedEvents.slice(beforeApprovedPrepare.length).trim().split('\n')
                    .filter(Boolean).map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                expect(safetyEvents.filter(event => event.kind === 'safetyBytes')).toHaveLength(1);
                const preparedRestic = safetyEvents.filter(event => event.kind === 'restic');
                expect(preparedRestic.length).toBeGreaterThan(0);
                for (const event of preparedRestic) expect(event.argv).toEqual(expect.arrayContaining([
                    's3.region=us-east-1', 's3.bucket-lookup=path',
                ]));
                // Confirmation owns the retained capture, even if its source receipt changes later.
                delete recoveryCapture!.content.ownServer!.preMigrationBackup;
                const confirmInput = { ...restoreInput, mode: 'confirm' as const, prepareOperationId: preparedResult.operationId };
                expect(await executor.execute('deployments.backups.restore', confirmInput, { ...actionContext,
                    actionRequestId: 'foreign-confirm', machineAdmission: { ...sourceContext.machineAdmission,
                        actorAccountId: 'another-person', custodianAccountId: 'another-person' } }))
                    .toMatchObject({ ok: false, errorCode: 'restore_prepare_required' });
                const beforeConfirmation = await readFile(boundary.eventsFile, 'utf8');
                expect(await executor.execute('deployments.backups.restore', confirmInput,
                    { ...agentContext, actionRequestId: 'import-confirm-ask' }))
                    .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(approvalRequests).toBe(3);
                expect(await executor.execute('deployments.backups.restore', confirmInput,
                    { ...actionContext, actionsSettings: requiredUiSettings, actionRequestId: 'import-confirm-ui-ask' }))
                    .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(approvalRequests).toBe(4);
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeConfirmation);
                phase('standalone-confirm');
                const result = await executor.execute('deployments.backups.restore', confirmInput,
                    { ...waivedAgentContext, actionRequestId: 'standalone-confirm' });
                expect(result).toMatchObject({ ok: true, result: { kind: 'restored', verified: true, steps: [
                    { id: 'safety', status: 'completed' }, { id: 'restore', status: 'completed' },
                    { id: 'stop', status: 'completed' }, { id: 'start', status: 'completed' }, { id: 'health', status: 'completed' },
                ] } });
                phase('standalone-confirmed');
                const completedEvents = await readFile(boundary.eventsFile, 'utf8');
                const nativeEvents = completedEvents.trim().split('\n').map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                expect(nativeEvents.filter(event => event.kind === 'postgres' && event.argv?.[0] === 'pg_restore'
                    && !event.argv.includes('--version'))).toHaveLength(1);
                const confirmationEvents = completedEvents.slice(beforeConfirmation.length).trim().split('\n')
                    .map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                expect(confirmationEvents.filter(event => event.kind === 'safetyBytes')).toHaveLength(0);
                const restoredSources = confirmationEvents.filter(event => event.kind === 'restic' && event.argv?.includes('dump'));
                expect(restoredSources.length).toBeGreaterThan(0);
                for (const event of restoredSources) expect(event.argv).toEqual(expect.arrayContaining([
                    capture.source.snapshot.snapshotId, 's3.region=us-east-1', 's3.bucket-lookup=path',
                ]));
                expect(await executor.execute('deployments.backups.restore', confirmInput,
                    { ...actionContext, actionRequestId: 'standalone-confirm-retry' })).toEqual(result);
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(completedEvents);
                expect(await executor.execute('deployments.backups.restore', { ...confirmInput, restoreBackupId: 'f'.repeat(64) },
                    { ...actionContext, actionRequestId: 'standalone-confirm-substitution' }))
                    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(completedEvents);
                expect(environment.targetLinks[0].targetLink.activeDeploymentId).toBe(pointer);
                expect(transitionWrites).toBe(beforeTransitions);
                expect((await docker.readInvocations()).filter(call => call.args.includes('up')))
                    .toHaveLength(before.filter(call => call.args.includes('up')).length);
                expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).names).toContain(database);
                return;
            }
            if (startFirst) {
                phase('seed-incumbent');
                if (scenario === 'candidate_start_first_restore_candidate') environment.content.ownServer!.rollout = 'startFirst';
                const initial = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: initial.inputBasis };
                expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id })).toMatchObject({ ok: true, state: 'running' });
                Object.assign(serving, structuredClone(receipt));
                serving.deployment.state = 'succeeded';
                environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                receipt.deployment = { ...receipt.deployment, id: 'start-first-candidate', actionOperationId: 'start-first-operation',
                    contentArtifactId: 'start-first-content', revision: 1, state: 'queued' };
                receipt.content = { ...receipt.content, ownServer: undefined, machineResults: [], steps: [] };
                if (scenario === 'candidate_start_first_restore_unhealthy') {
                    // Health belongs to B's actual image/generation. A global
                    // service override would also poison the U being restored.
                    const candidateImage = await docker.registerImage('app', 'unhealthy-B');
                    receipt.content.images = [candidateImage];
                    unhealthyCandidateConfig = candidateImage.configDigest;
                }
                request = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                    receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1 },
                    context: { ...request.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                environment.content.ownServer!.rollout = 'startFirst';
                environmentReads = 0;
            }
            const candidateMigration = scenario.startsWith('candidate_') && !startFirst;
            if (candidateMigration) Object.assign(environment.content.ownServer!, {
                migration: { service: 'app', argv: ['migrate', '--candidate-release'] },
            });
            else if (!scenario.startsWith('adopted_') && scenario !== 'private_publication_failed_attempt' && scenario !== 'private_publication_matching_restore')
                environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
            if (scenario === 'candidate_pending_check_zero' || scenario === 'candidate_check_nonzero') {
                // The declared check's native exit zero proves no migration work.
                // Leave the create-default backup enabled: no backup parent may
                // be needed merely to discover that there is nothing to migrate.
                Object.assign(environment.content.ownServer!, { backupBeforeMigration: true,
                    migrationFailurePolicy: 'ask', migration: { service: 'app', argv: ['migrate', '--candidate-release'],
                        pendingCheck: { argv: ['pending', '--candidate-release'] } } });
            }
            if (scenario === 'candidate_check_nonzero') await docker.setCommandOutcome({ exitCode: 7 });
            if (scenario === 'candidate_backup_required') environment.content.ownServer!.backupBeforeMigration = true;
            if (scenario === 'candidate_direct_url') {
                for (const [name, resourceId, value] of [['DATABASE_URL', 'pooled', 'pooled-connection-fixture'],
                    ['DIRECT_URL', 'direct', 'direct-connection-fixture']]) {
                    const binding = createDeploymentSecretVariableBindingV1({ name, phase: 'runtime', resourceId, resourceRevision: 1 });
                    environment.content.bindings.push(binding);
                    runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                        installationId: 'installation-a', environmentId: environment.environment.id, resourceId, resourceRevision: 1 },
                        installationPublicKey, content: { kind: 'secret', value } }));
                }
                await docker.setCommandOutcome({ expectedServiceValues: { environment: { DATABASE_URL: 'direct-connection-fixture' } } });
            }
            phase('review');
            if (scenario === 'required_project_secret') {
                await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext }))
                    .rejects.toMatchObject({ data: { code: 'secret_missing', details: {
                        deployable: false, missingRequiredSecretNames: ['UNBOUND_PROJECT_SECRET'],
                    } } });
                expect((await docker.readInvocations()).some(call => call.args.some(arg => ['up', 'stop', 'down'].includes(arg)))).toBe(false);
                return;
            }
            if (scenario === 'adopted_installation_changed') {
                await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext }))
                    .rejects.toMatchObject({ code: 'target_mismatch' });
                expect((await docker.readInvocations()).some(call => call.args.some(arg => ['up', 'stop', 'down'].includes(arg)))).toBe(false);
                return;
            }
            if (scenario === 'adopted_origin_changed') {
                await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext }))
                    .rejects.toMatchObject({ code: 'native_failed', details: { reason: 'native_origin_changed' } });
                expect((await docker.readInvocations()).some(call => call.args.includes('up') || call.args.includes('stop') || call.args.includes('down'))).toBe(false);
                return;
            }
            const review = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
            // Preview and basis consume the same captured Environment; the
            // later mutation CAS admits edits without a second review read.
            if (scenario !== 'canonical_home_build') expect(environmentReads).toBe(1);
            if (scenario === 'runtime_stage') {
                serving.content.ownServer = { approvedInputBasis: { ...review.inputBasis, sourceIntent: serving.content.sourceIntent },
                    referenceAddresses: [{ machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'runtime', name: 'RUNNING_SERVICE_URL',
                        source: { kind: 'reference', environmentId: environment.environment.id, export: 'application', via: 'auto' },
                        address: 'http://app:2000' }] };
                const referenceReview = await target.review({ actionId: request.actionId, input: request.input,
                    content: receipt.content, context: sourceContext });
                expect(referenceReview.reviewedEffect).toMatchObject({
                    referenceChanges: [{ name: 'RUNNING_SERVICE_URL', phase: 'runtime' }],
                });
                expect(DeploymentApprovalReviewV1Schema.parse(referenceReview.reviewedEffect)).toEqual(referenceReview.reviewedEffect);
            }
            if (scenario === 'canonical_home_build') {
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                const built = await buildOwnServerDeploymentReceipt(host, request);
                expect(built, JSON.stringify(built)).toMatchObject({ ok: true, state: 'running' });
                expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
                expect(receipt.content.ownServer.imageArchives?.every(archive => archive.holder.serverId === homeServerIdentityId)).toBe(true);
                expect(receipt.content.ownServer.sources).toEqual(expect.arrayContaining([
                    expect.objectContaining({ role: 'build', machineId: host.machineId, installationId: 'installation-a' }),
                ]));
                const instanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerIdentityId, environment.environment.id);
                const expectedRoot = join(await resolveOwnServerDeploymentRootForHost(root, profile.id), instanceId,
                    'builds', receipt.deployment.id);
                expect((await docker.readInvocations()).some(call => call.args[call.args.indexOf('--project-directory') + 1] === expectedRoot)).toBe(true);
                return;
            }
            if (scenario === 'review_receipt_scope') {
                expect(review.inputBasis.sourceIntent).toEqual(receipt.content.sourceIntent);
                expect(memberReceiptReads).toBe(1);
                return;
            }
            if (scenario === 'private_publication_matching_restore') {
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id })).toMatchObject({ ok: true });
                Object.assign(serving, structuredClone(receipt));
                serving.deployment.state = 'succeeded';
                environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                receipt.deployment = { ...receipt.deployment, id: 'private-after-unshared', actionOperationId: 'private-operation',
                    contentArtifactId: 'private-content', revision: 1, state: 'queued' };
                receipt.content = { ...receipt.content, ownServer: undefined, steps: [] };
                environment.content.ownServer!.serviceExports = [{ key: 'application', service: 'app', containerPort: 3000,
                    scheme: 'http', exposure: 'privateNetwork', privateNetwork: 'shop-net' }];
                request = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                    receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1 },
                    context: { ...request.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                const candidateReview = await target.review({ actionId: request.actionId, input: request.input,
                    content: receipt.content, context: sourceContext });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: candidateReview.inputBasis };
                expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id })).toMatchObject({ ok: false });
                expect(retainedPrivateExports).toEqual(['application']);
                const activations = (await docker.readInvocations()).filter(call => call.args.includes('up')).length;
                expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'observe', selectedDeploymentId: serving.deployment.id })).toMatchObject({ ok: true });
                expect(retainedPrivateExports).toEqual(['application']);
                expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'restore', selectedDeploymentId: serving.deployment.id })).toMatchObject({ ok: true });
                expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(activations);
                expect(retainedPrivateExports).toEqual([]);
                return;
            }
            if (scenario === 'private_publication_failed_attempt') {
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                await docker.failImageHealth(image.configDigest);
                const attempted = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(attempted).toMatchObject({ ok: false });
                expect(retainedPrivateExports, JSON.stringify(attempted)).toEqual(['application']);
                expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(true);
                recoveryCapture = structuredClone(receipt);
                recoveryCapture.deployment.state = 'failed';
                receipt.deployment = { ...receipt.deployment, id: 'unshared-after-failure', actionOperationId: 'unshared-operation',
                    contentArtifactId: 'unshared-content', revision: 1, state: 'queued' };
                receipt.content = { ...receipt.content, ownServer: undefined, machineResults: [], steps: [] };
                environment.content.ownServer!.serviceExports = [];
                request = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                    receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1 },
                    context: { ...request.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                const unshared = await target.review({ actionId: request.actionId, input: request.input,
                    content: receipt.content, context: sourceContext });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: unshared.inputBasis };
                await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(retainedPrivateExports).toEqual([]);
                return;
            }
            if (scenario === 'private_publication_refused' || scenario === 'private_publication_withdrawal_refused') {
                if (scenario === 'private_publication_withdrawal_refused') serving.content.ownServer = {
                    approvedInputBasis: { ...review.inputBasis, ownServer: { ...review.inputBasis.ownServer!,
                        serviceExports: [{ key: 'application', service: 'app', containerPort: 3000, scheme: 'http',
                            exposure: 'privateNetwork', privateNetwork: 'shop-net' }] } },
                };
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(result).toMatchObject({ ok: false, errorCode: 'private_scope_unenforceable' });
                expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                return;
            }
            if (startFirst) {
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                const before = (await docker.readInvocations()).length;
                phase('start-first-member');
                const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                phase('start-first-settled');
                const native = (await docker.readInvocations()).slice(before);
                expect(routeWrites).toHaveLength(1);
                const stop = native.findIndex(call => call.args[0] === 'container' && call.args[1] === 'stop');
                const up = native.filter(call => call.args.includes('up'));
                expect(up).toHaveLength(1);
                expect(up[0]!.args).toContain('--wait');
                expect(up[0]!.args[up[0]!.args.indexOf('--project-name') + 1]).toMatch(/^happier-g-/u);
                if (scenario === 'candidate_start_first_unknown') {
                    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
                    expect(stop).toBe(-1);
                    expect(native.some(call => call.args[0] === 'container' && call.args[1] === 'rm')).toBe(false);
                } else {
                    expect(result, result.ok ? 'activated' : result.errorCode).toMatchObject({ ok: true, state: 'running' });
                    expect(stop).toBeGreaterThanOrEqual(0);
                    expect(before + stop).toBeGreaterThanOrEqual(routeWrites[0]!);
                    expect(native[stop]!.args).toEqual(['container', 'stop', ...incumbentNativeIds]);
                    expect(receipt.content.machineResults).toEqual([expect.objectContaining({ activation: 'succeeded', health: 'healthy' })]);
                }
                if (reverseStartFirst) {
                    if (unhealthyCandidateConfig) {
                        expect(unhealthyCandidateConfig).not.toBe(serving.content.images[0]!.configDigest);
                        await docker.failImageHealth(unhealthyCandidateConfig);
                        const nativeImage: unknown = JSON.parse(execFileSync(process.execPath,
                            [docker.executablePath, 'image', 'inspect', unhealthyCandidateConfig], { encoding: 'utf8' }));
                        if (!Array.isArray(nativeImage)) throw new Error('Expected native candidate image inspection');
                        const firstImage: unknown = nativeImage[0];
                        if (!firstImage || typeof firstImage !== 'object' || !('Id' in firstImage) || typeof firstImage.Id !== 'string')
                            throw new Error('Expected native candidate image identity');
                        const replicas: unknown = JSON.parse(execFileSync(process.execPath,
                            [docker.executablePath, 'inspect', '--type', 'container', ...forwardNativeIds], { encoding: 'utf8' }));
                        expect(replicas).toEqual(forwardNativeIds.map(id => expect.objectContaining({ Id: id, Image: firstImage.Id,
                            State: expect.objectContaining({ Status: 'running', Health: { Status: 'unhealthy' } }) })));
                        phase('confirmed-unhealthy-candidate');
                    }
                    const reverseBefore = (await docker.readInvocations()).length;
                    phase('reverse-start-first');
                    const restored = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'restore', selectedDeploymentId: serving.deployment.id });
                    phase('reverse-start-first-settled');
                    const reverse = (await docker.readInvocations()).slice(reverseBefore);
                    expect(restored, restored.ok ? 'restored' : restored.errorCode).toMatchObject(
                        scenario === 'candidate_start_first_restore_unknown'
                            ? { ok: false, errorCode: 'outcome_unknown' } : { ok: true, state: 'running' });
                    expect(routeWrites).toHaveLength(2);
                    expect(routeGenerations[1]).toEqual({ candidate: routeGenerations[0]!.incumbent,
                        incumbent: routeGenerations[0]!.candidate });
                    const reactivation = reverse.filter(call => call.args.includes('up'));
                    expect(reactivation).toHaveLength(1);
                    expect(reactivation[0]!.args).toContain('--wait');
                    expect(reactivation[0]!.args[reactivation[0]!.args.indexOf('--project-name') + 1]).toBe(routeGenerations[0]!.incumbent);
                    const stopForward = reverse.findIndex(call => call.args[0] === 'container' && call.args[1] === 'stop');
                    if (scenario === 'candidate_start_first_restore_unknown') {
                        expect(stopForward).toBe(-1);
                        expect(reverse.some(call => call.args[0] === 'container' && call.args[1] === 'rm')).toBe(false);
                    } else {
                        expect(stopForward).toBeGreaterThanOrEqual(0);
                        expect(reverseBefore + stopForward).toBeGreaterThanOrEqual(routeWrites[1]!);
                        expect(reverse[stopForward]!.args).toEqual(['container', 'stop', ...forwardNativeIds]);
                        expect(receipt.content.machineResults).toEqual([expect.objectContaining({ restoration: 'succeeded',
                            currentDeploymentId: serving.deployment.id, health: 'healthy' })]);
                    }
                }
                return;
            }
            if (scenario === 'member_health' || scenario === 'member_health_changed') {
                expect(review.inputBasis.health).toEqual([{ service: 'app', participates: false }]);
                expect(DeploymentApprovalReviewV1Schema.parse(review.reviewedEffect)).toMatchObject({
                    health: [{ service: 'app', participates: false }],
                });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                await docker.changeNativeHealth('app', 'unhealthy');
                if (scenario === 'member_health_changed') environment.content.template!.health = [{ service: 'app', participates: true }];
                const nativeBefore = (await docker.readInvocations()).length;
                const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                if (scenario === 'member_health_changed') {
                    expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
                    expect((await docker.readInvocations()).slice(nativeBefore).some(call => call.args.includes('up'))).toBe(false);
                } else {
                    expect(result).toMatchObject({ ok: true, state: 'running' });
                    expect(receipt.content.machineResults).toEqual([expect.objectContaining({ activation: 'succeeded', health: 'unverified' })]);
                    expect(mounted.registry.projectManagedServices.listProjectServices().find(handle => handle.kind === 'environment')?.snapshot().state)
                        .toBe('unhealthy');
                    // Automatic restoration consumes the original release's
                    // readiness policy even after the template's policy changes.
                    Object.assign(serving, structuredClone(receipt));
                    serving.deployment.state = 'running_unverified';
                    environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                    environment.content.template!.health = [{ service: 'app', participates: true }];
                    const changedReview = await target.review({ actionId: request.actionId, input: request.input,
                        content: receipt.content, context: sourceContext });
                    receipt.deployment = { ...receipt.deployment, id: 'restore-health-policy', actionOperationId: 'restore-health-policy-action',
                        contentArtifactId: 'restore-health-policy-content', revision: 1 };
                    receipt.content = { ...receipt.content, ownServer: { approvedInputBasis: changedReview.inputBasis },
                        machineResults: receipt.content.machineResults.map(row => ({ ...row, currentDeploymentId: 'candidate-b' })) };
                    const restoration = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                        receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1, state: 'running' as const },
                        context: { ...sourceContext, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                    expect(await target.executeMember({ request: restoration, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'restore', selectedDeploymentId: serving.deployment.id })).toMatchObject({ ok: true, state: 'running' });
                    expect(receipt.content.machineResults).toEqual([expect.objectContaining({ restoration: 'succeeded', health: 'unverified' })]);
                }
                return;
            }
            if (candidateMigration) {
                expect(environment.targetLinks[0].targetLink.activeDeploymentId).toBeUndefined();
                expect(mounted.registry.projectManagedServices.listProjectServices().filter(handle => !incumbentServices.has(handle))).toEqual([]);
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                const nativeBefore = (await docker.readInvocations()).length;
                const member = { machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate' as const, selectedDeploymentId: receipt.deployment.id };
                const result = await target.executeMember({ ...member, request });
                if (scenario === 'candidate_backup_required' || scenario === 'candidate_check_nonzero') {
                    // Pending work now reaches backup preparation. This fixture
                    // has no configured native destination; it must not migrate
                    // without the required recovery capture.
                    expect(result).toMatchObject({ ok: false, errorCode: 'backup_required' });
                    const native = (await docker.readInvocations()).slice(nativeBefore);
                    expect(native.some(call => call.args.includes('up') || call.args.includes('migrate') || call.args.includes('restic'))).toBe(false);
                    expect(native.filter(call => call.args.includes('run'))).toHaveLength(scenario === 'candidate_check_nonzero' ? 1 : 0);
                    expect(receipt.content.steps.some(step => step.id === 'own-server-migration')).toBe(false);
                    return;
                }
                expect(result, result.ok ? 'activated' : result.errorCode).toMatchObject({ ok: true, state: 'running' });
                const nativeAfter = (await docker.readInvocations()).length;
                const foreignParent = { ...request, context: { ...request.context,
                    operationAcceptance: { operationId: 'not-the-admitted-deployment', accept() {} } } };
                expect(await target.executeMember({ ...member, request: foreignParent }))
                    .toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
                expect(await target.executeMember({ ...member, request, installationId: 'replaced-installation' }))
                    .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                const cancelled = new AbortController(); cancelled.abort();
                expect(await target.executeMember({ ...member, request: { ...request,
                    context: { ...request.context, signal: cancelled.signal } } }))
                    .toMatchObject({ ok: false, errorCode: 'cancelled' });
                expect((await docker.readInvocations()).length).toBe(nativeAfter);
                const native = (await docker.readInvocations()).slice(nativeBefore);
                const commands = native.filter(call => call.args.includes('run'));
                expect(commands).toHaveLength(1);
                const migration = native.findIndex(call => call.args.includes('run'));
                const activation = native.findIndex(call => call.args.includes('up'));
                expect(migration).toBeGreaterThanOrEqual(0);
                expect(activation).toBeGreaterThan(migration);
                expect(native[migration].args.slice(native[migration].args.indexOf('run'))).toEqual([
                    'run', '--rm', '-T', '--no-build', '--pull', 'never', '--no-deps', 'app',
                    scenario === 'candidate_pending_check_zero' ? 'pending' : 'migrate', '--candidate-release',
                ]);
                if (scenario === 'candidate_pending_check_zero') {
                    expect(native.some(call => call.args.includes('migrate') || call.args.includes('backup') || call.args.includes('restic'))).toBe(false);
                    expect(receipt.content.steps).toEqual(expect.arrayContaining([
                        expect.objectContaining({ id: 'own-server-migration-pending-check', state: 'succeeded' }),
                        expect.objectContaining({ id: 'own-server-migration', state: 'skipped' }),
                    ]));
                    expect(receipt.content.ownServer?.stageLogs?.[0]?.steps)
                        .toEqual(expect.arrayContaining([expect.objectContaining({ ref: 'own-server-migration-pending-check' })]));
                }
                expect(native[migration].cwd).toContain(receipt.deployment.id);
                expect(native[migration].files).toHaveLength(1);
                // AM-9 sends private native stdin. Inspect only boundary-produced
                // facts, never retain or parse a secret-bearing rendered model.
                expect(await docker.readCommandConfigurations()).toEqual([{ imageConfigDigest: image.configDigest,
                    environmentMatchesExpected: true }]);
                expect(native.some(call => call.args.includes('exec') || call.args.includes('build') || call.args.includes('--service-ports'))).toBe(false);
                return;
            }
            if (scenario === 'cleanup_missing_generation') {
                delete environment.targetLinks[0].targetLink.activeDeploymentId;
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                receipt.deployment.state = 'running';
                receipt.content.machineResults = [{ machineId: 'machine-a', installationId: 'installation-a',
                    actionOperationId: receipt.deployment.actionOperationId, activation: 'failed', health: 'unknown', steps: [] }];
                const cleaned = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'cleanup', selectedDeploymentId: receipt.deployment.id });
                expect(cleaned).toMatchObject({ ok: false, errorCode: 'deployment_generation_required',
                    error: expect.stringMatching(/\s/) });
                const captured = await readOwnServerDeploymentStageLogs({ deploymentRoot: await resolveOwnServerDeploymentRootForHost(root, 'home'),
                    serverId: homeServerIdentityId, machineId: 'machine-a', installationId: 'installation-a' }, receipt);
                expect(captured).toMatchObject({ kind: 'page', page: { text: expect.stringContaining('deployment_generation_required') } });
                expect(JSON.stringify(captured)).not.toContain('review-secret-value-sentinel');
                return;
            }
            if (!retainedHealth && !runtimeRead && scenario !== 'runtime_stage') {
                delete environment.targetLinks[0].targetLink.activeDeploymentId;
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                const environmentsBefore = memberEnvironmentReads;
                const receiptsBefore = memberReceiptReads;
                const nativeBefore = (await docker.readInvocations()).length;
                phase('member');
                if (scenario === 'admitted_placement_changed') {
                    environment.environment.controllerMachineId = 'next-controller';
                    environment.environment.buildMachineId = 'next-builder';
                    const link = environment.targetLinks[0].targetLink;
                    link.machines = ['next-machine'];
                    link.members = [{ machineId: 'next-machine', installationId: 'next-installation', state: 'active' }];
                    link.revision++;
                }
                if (scenario === 'adopted_generation_changed') await docker.seedComposeGeneration('preexisting-compose-project');
                const member = { request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate' as const, selectedDeploymentId: receipt.deployment.id };
                const result = scenario === 'member_child_cost' ? await (async () => {
                    const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: async () => null,
                        resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                        async dispatchReceipt() { throw new Error('Member reads must not allocate a receipt'); } });
                    const artifacts = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' });
                    const child = createDaemonDeploymentChildExecutor(measuredHost, { target, storage: storage.deploymentAction!,
                        open: id => artifacts.read(id, { prepareRecipients: false, includeSharedAudience: false }),
                        async assertCurrent(context) { context.signal?.throwIfAborted(); },
                        async domainNative() { throw new Error('Member dispatch must not enter Domain execution'); },
                        async prepareCandidate() { throw new Error('Member dispatch must not author another candidate'); } });
                    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: request.actionId,
                        input: request.input, machineId: member.machineId, installationId: member.installationId,
                        phase: member.phase, selectedDeploymentId: member.selectedDeploymentId,
                        deploymentId: receipt.deployment.id, actionOperationId: receipt.deployment.actionOperationId });
                    const nativeBeforeRefusals = (await docker.readInvocations()).length;
                    expect(await child({ ...job, actionOperationId: 'another-operation' }, request.context))
                        .toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
                    expect(await child({ ...job, installationId: 'replaced-installation' }, request.context))
                        .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                    expect(await docker.readInvocations()).toHaveLength(nativeBeforeRefusals);
                    const headersBefore = memberHeaderReads;
                    const result = await child(job, request.context);
                    expect(memberHeaderReads - headersBefore).toBe(1);
                    return result;
                })() : await target.executeMember(member);
                phase('member-settled');
                const native = (await docker.readInvocations()).slice(nativeBefore);
                if (scenario === 'adopted_generation_changed' || scenario === 'adopted_generation_admission_changed') {
                    expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
                    expect(native.some(call => call.args.some(arg => ['up', 'stop', 'down'].includes(arg)))).toBe(false);
                    return;
                }
                expect(result, JSON.stringify({ code: result.ok ? 'none' : result.errorCode,
                    config: native.filter(call => call.args.includes('config')).length,
                    launches: native.length })).toMatchObject({ ok: true, state: 'running' });
                if (scenario === 'member_cost') {
                    // One admitted input snapshot; stage-log/source publication
                    // uses the authoritative CAS result, without echo reads.
                    // Member settlement reads its current row to preserve peers.
                    expect.soft(memberEnvironmentReads - environmentsBefore).toBe(1);
                    expect(memberReceiptReads - receiptsBefore).toBe(2);
                } else if (scenario === 'member_child_cost') {
                    // The receiving child opens one admitted snapshot. Native
                    // execution consumes it; settlement still reads current peers.
                    expect.soft(memberEnvironmentReads - environmentsBefore).toBe(1);
                    expect(memberReceiptReads - receiptsBefore).toBe(1);
                } else if (scenario === 'canonical_home_prepare') {
                    expect(host.serverId).not.toBe(homeServerIdentityId);
                    const instanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerIdentityId, environment.environment.id);
                    const expectedRoot = join(await resolveOwnServerDeploymentRootForHost(root, profile.id), instanceId,
                        'releases', receipt.deployment.id);
                    const service = mounted.registry.projectManagedServices.listProjectServices().find(handle => handle.kind === 'environment');
                    expect(service).toMatchObject({ environmentInstanceId: instanceId, release: { rootPath: expectedRoot } });
                    const activation = native.find(call => call.args.includes('up'));
                    expect(activation?.args[activation.args.indexOf('--project-directory') + 1]).toBe(expectedRoot);
                    expect(await docker.readRunningImageConfig('app')).toBe(image.configDigest);
                } else if (scenario === 'adopted_origin') {
                    const activation = native.find(call => call.args.includes('up'));
                    expect(activation?.args[activation.args.indexOf('--project-name') + 1]).toBe('preexisting-compose-project');
                    expect(review.inputBasis.physicalProjectName).toBe('preexisting-compose-project');
                    expect(receipt.content.ownServer?.approvedInputBasis.physicalProjectName).toBe('preexisting-compose-project');
                } else if (scenario === 'member_source_environment') {
                    expect(definitionEditedAfterAdmission).toBe(true);
                    expect(native.some(call => call.args.includes('up'))).toBe(true);
                    expect(await docker.readRunningImageConfig('app')).toBe(image.configDigest);
                    const nativeAfter = (await docker.readInvocations()).length;
                    expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'activate', selectedDeploymentId: receipt.deployment.id }))
                        .toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
                    expect(await docker.readInvocations()).toHaveLength(nativeAfter);
                }
                return;
            }
            if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Expected a repository receipt');
            expect(review.reviewedEffect).toMatchObject({
                machineId: 'machine-a', environment: { id: environment.environment.id, name: environment.content.name },
                revision: { kind: 'repository', sha: receipt.content.sourceIntent.sha },
                replaces: { deploymentId: serving.deployment.id, revision: { kind: 'repository', sha: 'b'.repeat(40) } },
                secretBindingNames: ['DEPLOY_PASSWORD'],
                downtime: 'stopThenStart',
                rollbackStorage: { keepPreviousDeployments: environment.content.retainPreviousDeployments },
            });
            expect(DeploymentApprovalReviewV1Schema.parse(review.reviewedEffect)).toEqual(review.reviewedEffect);
            delete environment.targetLinks[0].targetLink.activeDeploymentId;
            expect(review.inputBasis).toMatchObject({ ownServer: environment.content.ownServer });
            expect(review.reviewedEffect).toMatchObject({ ownServer: environment.content.ownServer });
            expect(review.reviewedEffect).toMatchObject({ storage: { warnings: [
                { kind: 'concurrent_writers', service: 'app', target: '/data', replicas: 2 },
            ] } });
            expect(review.reviewedEffect).toMatchObject({ inspection: 'complete', services: [{ name: 'app', replicas: 2,
                resources: { cpus: '1.0', memory: '128M' } }], risks: expect.arrayContaining([
                    { kind: 'privileged', service: 'app' }, { kind: 'non_loopback_publish', service: 'app' },
                    { kind: 'missing_reboot_restart_policy', service: 'app' },
                ]) });
            expect(JSON.stringify(review.reviewedEffect)).not.toContain('sensitive-host-value');
            expect(JSON.stringify(review.reviewedEffect)).not.toContain('review-secret-value-sentinel');
            expect(JSON.stringify(review.reviewedEffect)).not.toContain(secretBinding.source.ref);
            expect(JSON.stringify(review.reviewedEffect)).not.toContain('PRIVATE_INPUT');
            expect(review.reviewedEffect).toMatchObject({ target: {
                engine: 'dockerDesktop', requiresAwakeComputerAndDockerDesktop: true, domains: 'unavailableDockerDesktop',
            } });
            const reviewedRevision = environment.environment.revision;
            // Review consumes one captured render. A later Environment edit is
            // refused by the mutation CAS, not a second passive review read.
            if (scenario !== 'runtime_stage' && !runtimeRead) {
                const nativeBeforeConflict = (await docker.readInvocations()).length;
                let dispatchedAfterConflict = 0;
                const mutation = createCliDeploymentActionDeps({ serverHttpBaseUrl,
                    admitAccount: async () => null,
                    resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                    async dispatchReceipt(admitted) {
                        dispatchedAfterConflict++;
                        if (admitted.actionId !== 'deployments.deploy') throw new Error('Unexpected fixture mutation');
                        return target.execute(admitted);
                    },
                });
                environment.environment = { ...environment.environment, revision: reviewedRevision + 1 };
                try {
                    expect(await mutation.deploymentAction!('deployments.deploy', request.input, request.context))
                        .toMatchObject({ ok: false, error: 'deployment_conflict' });
                    expect(deploymentAdmissionRevisions).toEqual([reviewedRevision]);
                    expect(dispatchedAfterConflict).toBe(0);
                    expect((await docker.readInvocations()).length).toBe(nativeBeforeConflict);
                    expect(stored.size).toBe(0);
                } finally {
                    environment.environment = { ...environment.environment, revision: reviewedRevision };
                }
            }
            receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
            const sourceProgress: Array<{ label?: string; phase?: string }> = [];
            healthAttachmentExpected = retainedHealth;
            if (scenario === 'runtime_stage') await docker.setStageOutputEnvironmentKey('DEPLOY_PASSWORD');
            // Isolate the real member attachment from the controller's
            // separate deployment-settlement notice admission.
            if (scenario === 'runtime_stage' || retainedHealth) {
                phase('activation');
                receipt.deployment.state = 'running';
                expect(await target.executeMember({ request: { ...request, context: { ...request.context,
                    operationProgress: { update(value) { sourceProgress.push(value); } } } }, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id })).toMatchObject({ ok: true, state: 'running' });
            } else {
                const executed = await target.execute(request);
                expect(executed, JSON.stringify({ memberFailures, machineResults: receipt.content.machineResults }))
                    .toMatchObject({ ok: true, state: 'succeeded' });
            }
            expect(stored.size).toBe(0);
            if (scenario !== 'runtime_stage') caller.abort();
            const service = mounted.registry.projectManagedServices.listProjectServices().find(handle => handle.kind === 'environment');
            if (!service || service.kind !== 'environment') throw new Error('Real target must produce its Environment service');
            expect(incumbentServices.has(service)).toBe(false);
            if (scenario === 'runtime_stage') {
                phase('capture-read');
                expect(receipt.content.ownServer?.referenceAddresses).toEqual([{
                    machineId: 'machine-a', installationId: 'installation-a', phase: 'runtime', name: 'RUNNING_SERVICE_URL',
                    source: { kind: 'reference', environmentId: environment.environment.id, export: 'application', via: 'auto' },
                    address: 'http://app:3000',
                }]);
                expect(receipt.content.ownServer?.stageLogs?.[0]?.steps?.map(step => step.ref)).toEqual(['source', 'activate']);
                const captured = await readOwnServerDeploymentStageLogs({ deploymentRoot: await resolveOwnServerDeploymentRootForHost(root, 'home'),
                    serverId: homeServerIdentityId, machineId: 'machine-a', installationId: 'installation-a' }, receipt);
                expect(captured).toMatchObject({ kind: 'page', page: { text: expect.stringContaining('native rollout ') } });
                expect(sourceProgress).toEqual([{ phase: 'sync', label: expect.any(String) }, { phase: 'sync', label: expect.any(String) }]);
                if (captured.kind !== 'page') throw new Error('Expected admitted stage page');
                expect(captured.page.text.startsWith(sourceProgress.map(value => `${value.label}\n`).join(''))).toBe(true);
                expect(JSON.stringify(captured)).toContain('PORT=3000');
                expect(JSON.stringify(captured)).not.toContain('review-secret-value-sentinel');
                expect(JSON.stringify(captured)).not.toContain('PRIVATE_INPUT');
                phase('cleanup');
                const inventoryReadsBeforeCleanup = nativeInventoryReads;
                expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'cleanup', selectedDeploymentId: receipt.deployment.id })).toMatchObject({ ok: true, state: 'running' });
                expect(nativeInventoryReads - inventoryReadsBeforeCleanup, 'exact candidate cleanup never scans the retained service inventory').toBe(0);
                expect(receipt.content.ownServer?.stageLogs?.[0]?.steps?.map(step => step.ref))
                    .toEqual(['source', 'activate', 'own-server-candidate-cleanup']);
                const cleaned = await readOwnServerDeploymentStageLogs({ deploymentRoot: await resolveOwnServerDeploymentRootForHost(root, 'home'),
                    serverId: homeServerIdentityId, machineId: 'machine-a', installationId: 'installation-a' }, receipt);
                expect(cleaned).toMatchObject({ kind: 'page', page: { text: expect.stringContaining('native cleanup ') } });
                expect(JSON.stringify(cleaned)).not.toContain('review-secret-value-sentinel');
                // Restore reads the retained source, but writes this operation's
                // log. The selected successful receipt's file remains untouched.
                Object.assign(serving, structuredClone(receipt));
                serving.deployment.state = 'succeeded';
                environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                receipt.deployment = { ...receipt.deployment, id: 'restore-operation', actionOperationId: 'restore-operation-action',
                    contentArtifactId: 'restore-operation-content', revision: 1 };
                receipt.content = { ...receipt.content, ownServer: { ...receipt.content.ownServer!, stageLogs: [] },
                    machineResults: receipt.content.machineResults.map(row => ({ ...row, currentDeploymentId: 'candidate-b' })) };
                const restoration = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                    receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1, state: 'running' as const },
                    context: { ...sourceContext, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                phase('restore');
                expect(await target.executeMember({ request: restoration, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'restore', selectedDeploymentId: serving.deployment.id })).toMatchObject({ ok: true, state: 'running' });
                const restored = await readOwnServerDeploymentStageLogs({ deploymentRoot: await resolveOwnServerDeploymentRootForHost(root, 'home'),
                    serverId: homeServerIdentityId, machineId: 'machine-a', installationId: 'installation-a' }, receipt);
                expect(restored).toMatchObject({ kind: 'page', page: { text: expect.stringContaining('native rollout ') } });
                expect(JSON.stringify(restored)).toContain('PORT=3000');
                expect(JSON.stringify(restored)).not.toContain('review-secret-value-sentinel');
                expect(await readOwnServerDeploymentStageLogs({ deploymentRoot: await resolveOwnServerDeploymentRootForHost(root, 'home'),
                    serverId: homeServerIdentityId, machineId: 'machine-a', installationId: 'installation-a' }, serving)).toEqual(cleaned);
                phase('frontdoor-read');
                const deps = createDaemonDeploymentActionDeps({ ...host, resolveRequesterIdentity });
                const stage = await deps.deploymentAction('deployments.logs.read', { serverId: 'home', environmentId: environment.environment.id,
                    deploymentId: receipt.deployment.id, targetLinkId: receipt.deployment.targetLinkId, machineId: 'machine-a',
                    installationId: 'installation-a', kind: 'build', ref: 'restore', tail: true }, {});
                expect(stage).toMatchObject({ ok: true, kind: 'build', logs: { kind: 'page', page: { text: expect.stringContaining('native rollout ') } } });
                expect(JSON.stringify(stage)).toContain('PORT=3000');
                expect(JSON.stringify(stage)).not.toContain('review-secret-value-sentinel');
                expect(JSON.stringify(stage)).not.toContain('PRIVATE_INPUT');
                return;
            }
            if (runtimeRead) {
                // Native pushes may queue behind the preceding failure-log read.
                // These waits share this scenario's existing 60s outer budget;
                // Vitest's implicit 1s wait is not a product freshness deadline.
                const deps = createDaemonDeploymentActionDeps({ ...host, resolveRequesterIdentity });
                const bodyReadsBefore = privateEnvironmentBodyReads;
                const input = { serverId: 'home', environmentId: environment.environment.id, deploymentId: receipt.deployment.id,
                    targetLinkId: receipt.deployment.targetLinkId, machineId: 'machine-a', installationId: 'installation-a', service: service.identity! };
                const before = await docker.readInvocations();
                const initialHealth = await deps.deploymentAction('deployments.health.read', input, {});
                expect(initialHealth, JSON.stringify(initialHealth)).toMatchObject({
                    ok: true, health: 'healthy', freshness: 'current', service: input.service,
                    native: { phase: 'running', readiness: 'ready' },
                });
                await expect(deps.deploymentAction('deployments.drift.read', { ...input, expectedRevision: environment.environment.revision }, {}))
                    .resolves.toMatchObject({ ok: true, status: 'in_sync', differingFields: [], missingFields: [] });
                // These reads need only admitted metadata and the exact selected
                // receipt, never private bodies of current or historical links.
                expect(privateEnvironmentBodyReads).toBe(bodyReadsBefore);
                await expect(deps.deploymentAction('deployments.health.read', { ...input, installationId: 'replaced-installation' }, {}))
                    .resolves.toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                await expect(deps.deploymentAction('deployments.health.read', { ...input,
                    service: { ...input.service, environmentInstanceId: 'foreign-instance', serviceId: 'foreign-instance/app' } }, {}))
                    .resolves.toMatchObject({ ok: false, errorCode: 'service_unavailable' });
                expect((await docker.readInvocations()).slice(before.length)).toEqual([]);
                if (scenario === 'runtime_health') {
                await docker.changeNativeHealth('app', 'unhealthy');
                // An unavailable native observation can also present unhealthy.
                // Wait for the actual read contract, including fresh native facts.
                await waitForNativeRead(async () => expect(await deps.deploymentAction('deployments.health.read', input, {}))
                    .toMatchObject({ ok: true, health: 'unhealthy', freshness: 'current',
                        native: { phase: 'running', readiness: 'not_ready' } }));
                await docker.changeNativeHealth('app', 'not_reported');
                await waitForNativeRead(async () => expect(await deps.deploymentAction('deployments.health.read', input, {})).toMatchObject({
                    ok: true, health: 'running_unverified', native: { phase: 'running', readiness: 'not_reported' },
                }));
                const images = receipt.content.images;
                receipt.content.images = images.map(image => ({ ...image, configDigest: `sha256:${'d'.repeat(64)}` }));
                await expect(deps.deploymentAction('deployments.drift.read', { ...input, expectedRevision: environment.environment.revision }, {}))
                    .resolves.toMatchObject({ ok: true, status: 'drifted', differingFields: ['configDigest'], missingFields: [] });
                receipt.content.images = images;
                const composePath = join(service.release.rootPath, 'compose.yaml');
                const originalCompose = await readFile(composePath, 'utf8');
                try {
                    const changed = JSON.parse(originalCompose);
                    changed.services.app.environment.PRIVATE_INPUT = 'changed-after-activation';
                    await writeFile(composePath, JSON.stringify(changed));
                    await expect(deps.deploymentAction('deployments.drift.read', { ...input, expectedRevision: environment.environment.revision }, {}))
                        .resolves.toMatchObject({ ok: true, status: 'drifted', differingFields: expect.arrayContaining(['composeDigest']) });
                } finally { await writeFile(composePath, originalCompose); }
                return;
                }
                await docker.emitRuntimeLogFromEnvironment('app', 'DEPLOY_PASSWORD');
                const logs = await deps.deploymentAction('deployments.logs.read', { ...input, kind: 'runtime' }, {});
                expect(logs, JSON.stringify('errorCode' in logs ? { errorCode: logs.errorCode } : { ok: logs.ok }))
                    .toMatchObject({ ok: true, kind: 'runtime', logs: { kind: 'page' } });
                expect(JSON.stringify(logs)).toContain('PORT=3000');
                expect(JSON.stringify(logs)).not.toContain('review-secret-value-sentinel');
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'native-read-proof', binding: {
                    accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                    serverIdentityId: 'home', machineId: 'machine-a', installationId: 'installation-a', actionId: 'deployments.logs.read',
                    requestId: 'runtime-logs', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine-a' },
                    deploymentReadAdmission: projectDeploymentReadAdmissionV1('deployments.logs.read', { ...input, kind: 'runtime' }),
                } });
                const admitted = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                    machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: Buffer.concat([installationSeed, installationPublicKey]),
                    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl, ownCredentials: credentials,
                    // The real owner deliberately separates installed custody from the current Home root.
                    isCustodyCurrent: async () => true,
                    isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: 'deployments.logs.read',
                        target: authorization.binding.target, installationId: 'installation-a', privateKey: Buffer.concat([installationSeed, installationPublicKey]).toString('base64url'), serverHttpBaseUrl }),
                    createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
                });
                expect(admitted).not.toBeNull();
                try {
                    for (const context of [{ externalActionExecutionAuthorization: admitted!.authorization }, {}]) {
                        readAccessRevoked = false;
                        const logCalls = (await docker.readInvocations()).filter(call => call.args[0] === 'logs').length;
                        const pageAdmissions = readPageAdmissions;
                        const pageAuthorityChecks = readPageAuthorityChecks;
                        await docker.holdRuntimeLogReads(true);
                        const held = deps.deploymentAction('deployments.logs.read', { ...input, kind: 'runtime' }, context);
                        try {
                            await waitForNativeRead(async () => expect((await docker.readInvocations()).filter(call => call.args[0] === 'logs').length).toBeGreaterThan(logCalls));
                            readAccessRevoked = true;
                        } finally { await docker.holdRuntimeLogReads(false); }
                        // This bounded page was admitted before withdrawal.
                        // Revocation applies when the next page is requested.
                        await expect(held).resolves.toMatchObject({ ok: true, kind: 'runtime', logs: { kind: 'page' } });
                        expect(readPageAdmissions - pageAdmissions).toBe(1);
                        expect(readPageAuthorityChecks - pageAuthorityChecks).toBe(0);
                        await expect(deps.deploymentAction('deployments.logs.read', { ...input, kind: 'runtime' }, context))
                            .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
                    }
                } finally { await admitted?.dispose?.(); }
                return;
            }
            expect(retainedReads, 'the retained observer reads its Environment once at attachment').toBe(1);
            const healthAdmissionStart = retainedReads;
            await docker.changeNativeHealth('app', 'unhealthy');
            await service.inspectCurrentOccurrence();
            if (scenario === 'retained_health_denied') {
                await waitForNativeRead(() => expect(service.snapshot().state).toBe('unhealthy'));
                expect(retainedReads).toBe(healthAdmissionStart);
                expect(writes, 'an attachment denied Source access cannot publish').toBe(0);
                expect(sendPush).not.toHaveBeenCalled();
                expect(forward).not.toHaveBeenCalled();
                return;
            }
            // The controller owns the Environment aggregate; each Machine also
            // retains its distinct service condition. A remote service cannot
            // fabricate the controller's current Environment proof.
            const remoteController = scenario === 'retained_health_remote';
            const noticeCount = remoteController ? 1 : 2;
            await waitForNativeRead(() => expect(stored.size, 'one retained C1 item per observed condition').toBe(noticeCount));
            const readHeader = (id: string) => {
                const storedHeader = stored.get(id)?.header;
                if (typeof storedHeader !== 'string') throw new Error('Expected stored artifact header bytes');
                return AccountNoticeArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(storedHeader));
            };
            const subject = remoteController ? service.identity : { kind: 'environment' as const,
                environmentId: environment.environment.id, targetLinkId: environment.environment.runtimeTargetLinkId,
                condition: 'health' as const };
            const artifactId = [...stored.keys()].find(id => {
                const source = readHeader(id).source;
                return source.kind === 'host' && source.topic === 'service_health' && source.subject.kind === subject.kind;
            });
            if (!artifactId) throw new Error('Expected retained notice for the selected health condition');
            const header = () => readHeader(artifactId);
            const assertControllerDelivery = async (priorDeliveries: readonly string[]) => {
                const expectedDeliveries = [...priorDeliveries, 'controller'];
                await waitForNativeRead(() => expect(forward).toHaveBeenCalledTimes(1));
                await expect(forward.mock.results[0].value).resolves.toEqual({ kind: 'attempted' });
                expect(deliveries).toEqual(expectedDeliveries);
                expect(sendPush.mock.calls.at(-1)?.[2]).toMatchObject({ accountId, artifactId, serverId: 'home', serverUrl: serverHttpBaseUrl });
                const openingControllerReads = controllerArtifactReads;
                expect.soft(openingControllerReads, 'one admitted controller hop opens its committed notice once').toBe(1);
                expect.soft(receiverEnvironmentReads, 'the admitted hop consumes its committed notice without reopening the Environment').toBe(0);
                expect.soft(receiverAdmissionReads, 'HTTP calls inside one finite hop do not re-admit it').toBe(1);
                expect(forward.mock.calls[0][0]).toMatchObject({ machineId: 'other-controller', credentials,
                    method: 'daemon.serviceHealth.deliver.v1', requireCurrentMachine: true, requiredMachineKind: 'persistent',
                    authorityCeiling: 'account_automation', request: { machineId: 'other-controller', serverId: 'home',
                        artifactId, revision: { headerVersion: stored.get(artifactId)?.headerVersion,
                            bodyVersion: stored.get(artifactId)?.bodyVersion } } });
                const packet = CommittedServiceHealthDeliveryRequestV1Schema.parse(forward.mock.calls[0][0].request);
                expect.soft(Object.keys(packet).sort()).toEqual(['artifactId', 'machineId', 'revision', 'serverId']);
                const remoteWrites = writes;
                await service.inspectCurrentOccurrence();
                expect(writes).toBe(remoteWrites);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(controllerArtifactReads, 'equal native health does not reopen controller Artifacts').toBe(openingControllerReads);
                expect(deliveries).toEqual(expectedDeliveries);
                expect(await invokeReceiver({ ...packet, revision: { ...packet.revision, headerVersion: packet.revision.headerVersion + 1 } }))
                    .toEqual({ kind: 'suppressed' });
                const beforeDenied = artifactReads;
                receiverCurrent = false;
                expect(await invokeReceiver(packet)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
                expect(artifactReads).toBe(beforeDenied);
                receiverCurrent = true;
                expect(await invokeReceiver(packet, 'another-account')).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
                expect(artifactReads).toBe(beforeDenied);
                const ownRow = stored.get(artifactId)!;
                stored.set(artifactId, { ...ownRow, ownerAccountId: 'another-account', access: 'viewer' });
                expect(await invokeReceiver(packet)).toMatchObject({ error: expect.any(String) });
                stored.set(artifactId, ownRow);
                expect(deliveries).toEqual(expectedDeliveries);
                return packet;
            };
            expect(header()).toMatchObject({ source: { kind: 'host', topic: 'service_health', subject },
                page: remoteController ? { kind: 'host', page: 'machine_service', service: service.identity }
                    : { kind: 'host', page: 'environment', targetLinkId: environment.environment.runtimeTargetLinkId }, healthPhase: 'open' });
            await waitForNativeRead(() => expect(sendPush).toHaveBeenCalledTimes(noticeCount));
            expect(writes, 'one health transition commits each condition once').toBe(noticeCount);
            expect.soft(retainedReads - healthAdmissionStart, 'an admitted health transition does not reread its Environment').toBe(0);
            expect(sendPush.mock.calls.map(call => call[2])).toContainEqual(expect.objectContaining({ topic: 'account_notice', accountId, artifactId }));
            expect(retainedReads).toBe(1);
            const priorWrites = writes;
            await service.inspectCurrentOccurrence();
            expect(writes).toBe(priorWrites);
            expect(sendPush).toHaveBeenCalledTimes(noticeCount);
            if (scenario === 'retained_health_remote') {
                await assertControllerDelivery([]);
                return;
            }
            await docker.changeNativeHealth('app', 'healthy');
            await service.inspectCurrentOccurrence();
            await waitForNativeRead(() => expect(service.snapshot().state).toBe('healthy'));
            await waitForNativeRead(() => expect(header()).toMatchObject({ healthPhase: 'recovered', resolved: false }));
            expect(stored.size).toBe(noticeCount);
            expect(sendPush).toHaveBeenCalledTimes(noticeCount);
            await docker.changeNativeHealth('app', 'unhealthy');
            await service.inspectCurrentOccurrence();
            await waitForNativeRead(() => expect(header()).toMatchObject({ healthPhase: 'open' }));
            await waitForNativeRead(() => expect(sendPush).toHaveBeenCalledTimes(2 * noticeCount));
            expect(deliveries).toEqual(['target', 'target', 'target', 'target']);
            expect(forward).not.toHaveBeenCalled();
            const packet = CommittedServiceHealthDeliveryRequestV1Schema.parse({ serverId: 'home', machineId: 'other-controller',
                artifactId, revision: { headerVersion: stored.get(artifactId)?.headerVersion, bodyVersion: stored.get(artifactId)?.bodyVersion } });
            await docker.changeNativeHealth('app', 'healthy');
            await service.inspectCurrentOccurrence();
            await waitForNativeRead(() => expect(header()).toMatchObject({ healthPhase: 'recovered' }));
            expect(await invokeReceiver(packet)).toEqual({ kind: 'suppressed' });
            expect(deliveries).toEqual(['target', 'target', 'target', 'target']);
            // Recovery races the outward delivery's real Artifact read, not
            // an Environment read that transitions no longer perform.
            let recoveredRaceObservedUnhealthy = false;
            artifactReadEffect = async () => {
                recoveredRaceObservedUnhealthy = service.snapshot().state === 'unhealthy';
                await docker.changeNativeHealth('app', 'healthy');
                await service.inspectCurrentOccurrence();
                await waitForNativeRead(() => expect(service.snapshot().state).toBe('healthy'));
            };
            const beforeRecoveredRace = writes;
            await docker.changeNativeHealth('app', 'unhealthy');
            await service.inspectCurrentOccurrence();
            await waitForNativeRead(() => expect(writes).toBeGreaterThan(beforeRecoveredRace));
            await waitForNativeRead(() => expect(header()).toMatchObject({ healthPhase: 'recovered' }));
            expect(recoveredRaceObservedUnhealthy).toBe(true);
            expect(sendPush).toHaveBeenCalledTimes(2 * noticeCount);
            const beforeSourceWithdrawal = { reads: retainedReads, writes };
            environment.environment.capabilities.read = false;
            await docker.changeNativeHealth('app', 'unhealthy');
            await service.inspectCurrentOccurrence();
            await waitForNativeRead(() => expect(writes).toBeGreaterThan(beforeSourceWithdrawal.writes));
            await waitForNativeRead(() => expect(sendPush).toHaveBeenCalledTimes(3 * noticeCount));
            expect(retainedReads, 'withdrawal applies at the next attachment, not each admitted transition').toBe(beforeSourceWithdrawal.reads);
            expect(header()).toMatchObject({ healthPhase: 'open' });
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
            try {
                // Dispose only this fixture's exact observation handles; this
                // detaches C1/Engine IO, never stops native containers or ends
                // the shared SCM controller's retained-service owner.
                for (const handle of mounted.registry.projectManagedServices.listProjectServices()) {
                    if (!incumbentServices.has(handle)) await handle.dispose();
                }
            } finally {
                try { await mounted.dispose(); } finally {
                    Reflect.set(configuration, 'happyHomeDir', previousHome);
                    Reflect.set(configuration, 'settingsFile', previousSettingsFile);
                    await currentness.dispose(); await channel.close(); await rm(root, { recursive: true, force: true });
                }
            }
        }
    // These rows compose real process journeys and use the canonical CLI
    // integration budget. Single-effect neighbors retain the unit budget.
    // Member health activates then restores with the retained policy.
    // Start-first and backup cases seed U then activate B; reverse also restores U. Stage
    // executes activate, candidate cleanup and restore in sequence.
    // Give each native effect the existing 60s integration harness budget;
    // this is not a native process, Action or product freshness deadline.
    }, scenario === 'runtime_stage' || scenario === 'public_restore' || scenario === 'standalone_public_restore' || scenario.startsWith('public_backup') || scenario.startsWith('candidate_start_first_restore') ? 3 * 60_000
        : scenario.startsWith('candidate_start_first') || scenario === 'member_health' || scenario.startsWith('candidate_backup_configured') ? 2 * 60_000 : scenario === 'runtime_reads' || scenario === 'runtime_health'
        || scenario.startsWith('retained_health') || scenario.startsWith('candidate_') ? 60_000 : undefined);
    it('reviews the prepared candidate before receipt admission without requiring an accepted operation', async () => {
        const { target, request, receipt, receiptReads, effects } = fixture();
        await expect(target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: {} }))
            .rejects.toThrow('Unexpected native acquisition');
        expect(receiptReads()).toBe(0);
        expect(effects()).toEqual({ runtimeAcquisitions: 1, transitions: 0 });
    });
    it('refuses a receipt without the target-rendered exact approval basis before native effects', async () => {
        const { target, request, effects } = fixture();
        await expect(target.execute(request)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(effects()).toEqual({ runtimeAcquisitions: 0, transitions: 0 });
    });
    it('keeps captured execution after Environment revision and controller edits on first deploy', async () => {
        const { target, request, environment, receipt, effects } = fixture('queued', true);
        request.input.expectedRevision = environment.environment.revision;
        environment.environment.revision += 1;
        request.receipt.revision = environment.environment.revision;
        receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, acceptedExecution: {
            ...receipt.deployment.acceptedExecution!,
        } });
        // A new admission will use this placement. The already accepted job
        // still belongs to its captured controller, not the edited header.
        environment.environment.controllerMachineId = 'replacement-controller';
        environment.targetLinks[0].targetLink.members[0].state = 'joining';
        receipt.content.ownServer = { approvedInputBasis: { v: 1, environmentId: environment.environment.id,
            environmentRevision: request.input.expectedRevision, targetLinkId: request.input.targetLinkId,
            targetLinkRevision: request.input.expectedTargetLinkRevision, sourceIntent: receipt.content.sourceIntent,
            manifestFingerprint: 'fixture', configInputDigests: [], physicalProjectName: 'fixture', toolVersion: 'fixture',
            services: ['web'], profiles: [], members: environment.targetLinks[0].targetLink.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
            bindings: [], ownServer: structuredClone(environment.content.ownServer), images: [] } };
        const result = await target.execute(request);
        // Later placement edits do not invalidate this accepted execution.
        // The fixture's native acquisition failure settles as its typed refusal.
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'deployment_failed' });
        expect(effects().runtimeAcquisitions).toBeGreaterThan(0);
        expect(receipt.deployment.state).toBe('failed');
        expect(receipt.content.failure).toMatchObject({ code: 'deployment_failed', phase: 'activate' });
        expect(receipt.content.machineResults).toContainEqual(expect.objectContaining({ machineId: 'machine-a', activation: 'failed' }));
    });
    it('never replays an already settled or uncertain native receipt', async () => {
        for (const state of ['succeeded', 'outcome_unknown'] as const) {
            const { target, request, effects } = fixture(state);
            await expect(target.execute(request)).resolves.toMatchObject({ ok: true, deploymentId: request.receipt.deploymentId, state });
            expect(effects()).toEqual({ runtimeAcquisitions: 0, transitions: 0 });
        }
    });
    it('never redispatches an uncertain pending check from an active receipt', async () => {
        const { target, request, receipt, environment, effects } = fixture();
        environment.content.ownServer = { ...environment.content.ownServer!, migration: {
            service: 'web', argv: ['migrate'], pendingCheck: { argv: ['pending'] } } };
        receipt.deployment.state = 'running';
        receipt.content.ownServer = { approvedInputBasis: { v: 1, environmentId: environment.environment.id,
            environmentRevision: environment.environment.revision, targetLinkId: receipt.deployment.targetLinkId,
            targetLinkRevision: environment.targetLinks[0].targetLink.revision, sourceIntent: receipt.content.sourceIntent,
            manifestFingerprint: 'fixture', configInputDigests: [], physicalProjectName: 'fixture', toolVersion: 'fixture',
            services: ['web'], profiles: [], members: environment.targetLinks[0].targetLink.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
            bindings: environment.content.bindings, ownServer: environment.content.ownServer, images: receipt.content.images } };
        receipt.content.steps.push({ id: 'own-server-migration-pending-check', label: 'Check candidate migration', state: 'outcome_unknown' });
        expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
            phase: 'activate', selectedDeploymentId: receipt.deployment.id })).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
        expect(effects()).toEqual({ runtimeAcquisitions: 0, transitions: 0 });
    });
    it('does not borrow a receipt from another accepted Action operation', async () => {
        const { target, request, effects } = fixture();
        await expect(target.execute({ ...request, context: { operationAcceptance: { operationId: 'another-operation', accept() {} } } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
        expect(effects()).toEqual({ runtimeAcquisitions: 0, transitions: 0 });
    });
});
