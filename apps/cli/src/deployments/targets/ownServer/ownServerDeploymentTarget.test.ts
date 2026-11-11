import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema, DeploymentActionInputSchemasV1,
    DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentUpdateResultV1Schema, DeploymentBindingsSetResultV1Schema,
    DeploymentReceiptListResultV1Schema, DeploymentReceiptGetResultV1Schema,
    ProjectDeploymentDefaultsOutputV1Schema } from '@happier-dev/protocol';
import { DeploymentDeployAdmissionInputV1Schema, DeploymentBackupRestoreResultV1Schema,
    DeploymentTeardownNothingDeployedInputV1Schema, DeploymentTeardownResultV1Schema,
    DeploymentEnvironmentAccessInputV1Schema, DeploymentEnvironmentAccessResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { configuration } from '@/configuration';
import { prepareProjectOpenReceiptPersistence } from '@/daemon/actionOperations/projectOpenReceiptPersistence';
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
import type { RpcHandler } from '@/api/rpc/types';
import { createEncryptedTransferChunkEnvelope, TransferSessionStore } from '@happier-dev/transfers/node';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { acquireDeploymentRestoreUpload } from '@/transfers/targets/deploymentRestoreUpload';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createOwnServerDeploymentRuntimeForHost, type OwnServerDeploymentRuntimeHostInput } from './ownServerDeploymentHostRuntime';
import { privateServicePublicationBindings } from './privateServicePublication';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { archive, database, snapshot, sourceManifest, volumeTarFixture, installRestoreBoundary } from './nativeRestore.testkit';
import { RESTIC_RUNTIME_V1, runDeploymentBackupV1, prepareDeploymentTemplateInstantiationV1 } from '@happier-dev/deployments';
import { buildCatalogAppTemplateBindings } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { parseNativeComposeSource } from '@/workspaces/projectSetup/nativeComposeSource';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createNightlyBackupsWorkflowV1, createRestoreDrillWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { createDeploymentDataQueryActionForHost } from '../../actions/dataQuery';
import { createMachineServicesRuntime } from '@/daemon/local/services/launch/machineServices';
import { createCliMachineResourceActionDeps } from '@/session/actions/cliActionDeps/machineResources';
import { createCliProjectAdmission } from '@/session/actions/cliActionDeps/projectAdmission';
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
import { EnvironmentSecretLaunchAdmissionInputV1Schema, EnvironmentSecretLaunchAdmissionResultV1Schema, computeEnvironmentSecretLaunchAdmissionDigestV1,
    createDeploymentReceiptArtifactHeaderV1, readDeploymentReceiptArtifactV1 } from '@happier-dev/deployment-protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createDaemonDeploymentActionDeps } from '../../createDaemonDeploymentActionDeps';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveWorkflowActionFieldBinding, evaluateWorkflowCondition } from '@/daemon/workflows/input';
import { createOwnServerTeardownForHost } from './teardown';
import { DeploymentTeardownRequestInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';
import { DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentStateV1';
import { DeploymentBindingsSetStorageInputV1Schema, DeploymentEnvironmentUpdateStorageInputV1Schema,
    DeploymentOwnServerContentV1Schema, DeploymentTargetLinkContentV1Schema,
    DeploymentEnvironmentBackupSetInputV1Schema } from '@happier-dev/deployment-protocol';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { deploymentBackupPolicyV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { OwnServerRestorePreparationForHostSchema } from './restorePreparation';
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { prepareWorkflowDeploymentResultCapture } from '@/deployments/targets/workflowDeploymentResult';
import { resolveDeploymentPreviewWorkflowSourceForHost } from '../../previewWorkflowSourceForHost';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import { createWorkflowRunStorageClient, WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { createPlainWorkflowRunKeyCensusFixture } from '@/daemon/workflows/workflowRunStorage.testkit';
import { WorkflowActionInputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createDaemonDeploymentChildExecutor } from '../../deploymentChild';
import { createAccountArtifactStore, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
            deploymentId: receipt.deployment.id, source: { kind: 'repository' as const, snapshotId: 'a'.repeat(64) }, expectedRevision: environment.environment.revision };
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
    for (const { scenario, sourceKind } of [
        ...(['iroh_publication_refused', 'iroh_publication_loopback', 'iroh_publication_host_network', 'private_publication_matching_restore', 'private_publication_refused', 'private_publication_withdrawal_refused', 'private_publication_failed_attempt', 'private_publication_forward_withdrawal'] as const)
            .map(scenario => ({ scenario, sourceKind: 'stored' as const })),
        ...(['promote_archive_custody', 'promote_cleanup_refused', 'promote_build_refused', 'promote_source_demoted', 'promote_destination_demoted', 'admitted_placement_changed', 'adopted_origin', 'adopted_origin_changed', 'adopted_generation_changed', 'adopted_generation_admission_changed', 'adopted_installation_changed', 'routing_review', 'review_receipt_scope', 'runtime_reads', 'runtime_health', 'runtime_stage', 'cleanup_missing_generation', 'transition_provenance_reason', 'transition_log_reason', 'retained_health', 'retained_health_remote', 'retained_health_denied', 'member_cost', 'member_child_cost', 'member_health', 'member_health_changed', 'member_source_environment', 'joining_current', 'joining_current_successor', 'candidate_first_deploy', 'candidate_start_first', 'candidate_start_first_unknown', 'candidate_start_first_restore', 'candidate_start_first_restore_unknown', 'candidate_start_first_restore_candidate', 'candidate_start_first_restore_unhealthy', 'candidate_start_first_restore_join_recovery', 'candidate_pending_check_zero', 'candidate_direct_url', 'candidate_backup_required', 'candidate_backup_configured', 'candidate_backup_configured_failure', 'candidate_backup_configured_native_failure', 'candidate_check_nonzero', 'canonical_home_prepare', 'canonical_home_build', 'public_restore', 'standalone_public_restore', 'standalone_public_restore_upload', 'standalone_public_restore_volume_upload', 'standalone_public_restore_snapshot_confirmed', 'standalone_public_restore_stale_input', 'public_copy', 'public_restore_drill', 'public_preview_copy', 'public_preview_copy_failure', 'public_preview_configure_failure', 'public_preview_companion_copy', 'public_preview_companion_create_failure', 'public_preview_companion_main_deleted', 'public_preview_companion_connect_failure', 'native_preview_cleanup', 'native_preview_cleanup_failure', 'native_preview_cleanup_companion', 'native_preview_cleanup_companion_failure', 'public_backup', 'public_backup_restore', 'public_backup_restore_local', 'public_backup_restore_sftp', 'public_backup_retention', 'public_backup_recorded_health', 'public_backup_probe', 'required_project_secret'] as const).map(scenario => ({ scenario, sourceKind: 'repository' as const })),
    ]) it(
        `native deployment admission, finite execution and retained C1 observation: ${scenario}`, async () => {
        const startedAt = Date.now();
        // Native pushes and their HTTP work share the composed scenario's
        // integration budget, including setup; no shorter per-wait deadline.
        const waitForNativeRead = (assertion: () => unknown) => vi.waitFor(assertion,
            { timeout: 60_000 - (Date.now() - startedAt) });
        const previewCompanion = scenario.startsWith('public_preview_companion_');
        const previewCopy = previewCompanion || scenario === 'public_preview_copy' || scenario === 'public_preview_copy_failure'
            || scenario === 'public_preview_configure_failure';
        const publicCopy = scenario === 'public_copy' || scenario === 'public_restore_drill' || previewCopy;
        const uploadedVolume = scenario === 'standalone_public_restore_volume_upload';
        const retainedBackupTransport = scenario === 'public_backup_restore_local' ? 'local'
            : scenario === 'public_backup_restore_sftp' ? 'sftp' : undefined;
        const runtimeRead = scenario === 'runtime_reads' || scenario === 'runtime_health';
        const promotionScenario = scenario === 'promote_source_demoted' || scenario === 'promote_destination_demoted'
            || scenario === 'promote_build_refused' || scenario === 'promote_archive_custody' || scenario === 'promote_cleanup_refused';
        const startFirst = scenario.startsWith('candidate_start_first');
        const storedPrivatePublication = sourceKind === 'stored';
        const migrationBackup = scenario.startsWith('candidate_backup_configured') || scenario.startsWith('public_backup');
        const reverseStartFirst = scenario.startsWith('candidate_start_first_restore');
        const retainedHealth = scenario.startsWith('retained_health');
        const stagePhases: Array<{ phase: string; elapsedMs: number }> = [];
        const phase = (value: string) => { stagePhases.push({ phase: value, elapsedMs: Date.now() - startedAt }); };
        onTestFailed(() => { console.info('Native target phases', { scenario, phases: stagePhases,
            ...(previewCopy && vi.isMockFunction(axios.request) ? { recentHomeRequests: vi.mocked(axios.request).mock.calls.slice(-6)
                .map(([input]) => ({ method: input.method, path: new URL(input.url ?? serverHttpBaseUrl).pathname })) } : {}) }); });
        phase('fixture');
        const root = await mkdtemp(join(tmpdir(), 'happier-deployment-health-'));
        const nativeHttp = { get: axios.get.bind(axios), post: axios.post.bind(axios), request: axios.request.bind(axios) };
        const repository = join(root, 'repository');
        await mkdir(repository);
        const docker = await createOwnServerDockerBoundary(join(root, 'docker'), {
            operatingSystem: previewCompanion ? 'Ubuntu 24.04.3 LTS' : 'Docker Desktop' });
        vi.stubEnv('PATH', `${join(root, 'docker')}${delimiter}${process.env.PATH ?? ''}`);
        const registeredImage = await docker.registerImage('app', 'A');
        const image = scenario === 'joining_current_successor'
            ? { ...registeredImage, registryReference: `registry.example.test/app@${registeredImage.manifestDigest}` } : registeredImage;
        if (scenario === 'joining_current_successor') {
            execFileSync(process.execPath, [docker.executablePath, 'image', 'tag', registeredImage.registryReference!, image.registryReference!]);
        }
        await writeFile(join(repository, 'compose.yaml'), JSON.stringify({ services: { app: { image: image.registryReference,
            ...(scenario === 'iroh_publication_host_network' ? { network_mode: 'host' } : {}),
            privileged: true, restart: 'on-failure', deploy: { replicas: scenario === 'public_restore_drill' ? 1 : 2,
                resources: { limits: { cpus: '1.0', memory: '128M' } } },
            ...(startFirst || scenario.startsWith('joining_current') ? { healthcheck: { test: ['CMD', 'true'] }, stop_grace_period: '17s' } : scenario === 'routing_review' || previewCopy ? {} : {
                volumes: [{ type: 'volume', source: 'shared', target: '/data' }],
                ports: [{ target: 3000, published: '3000', protocol: 'tcp', host_ip: scenario === 'iroh_publication_loopback' || scenario === 'iroh_publication_host_network' ? '127.0.0.1' : scenario === 'private_publication_refused' || scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_matching_restore' || scenario === 'private_publication_forward_withdrawal' || scenario === 'runtime_stage' ? '100.81.1.12' : '0.0.0.0' }],
            }), environment: { PRIVATE_INPUT: 'sensitive-host-value',
                ...(previewCopy ? { DATABASE_URL: previewCompanion ? 'postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}'
                    : 'postgres://${DB_USER}:${DB_PASSWORD}@database:5432/${DB_NAME}' }
                    : { DEPLOY_PASSWORD: '${DEPLOY_PASSWORD:?required}' }) } },
                ...(previewCopy && !previewCompanion ? { database: { image: 'postgres:17', environment: {
                    POSTGRES_USER: '${DB_USER}', POSTGRES_PASSWORD: '${DB_PASSWORD}', POSTGRES_DB: '${DB_NAME}' },
                    volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql/data' }] } } : {}),
                ...(scenario.startsWith('native_preview_cleanup') ? { 'later-app': { image: image.registryReference,
                    ports: [{ target: 3000, published: '3000', protocol: 'tcp', host_ip: '127.0.0.1' }] } } : {}) },
            ...(previewCopy && !previewCompanion ? { volumes: { 'postgres-data': {} } } : previewCompanion || scenario === 'routing_review' ? {} : { volumes: { shared: scenario.startsWith('native_preview_cleanup')
                ? {} : { name: 'target-review-shared' } } }) }));
        const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
        if (scenario === 'required_project_secret') {
            await mkdir(join(repository, '.happier'));
            await writeFile(join(repository, '.happier', 'project.json'), JSON.stringify({ version: 1,
                environmentVariables: [{ name: 'UNBOUND_PROJECT_SECRET', kind: 'secret' }] }));
        }
        if (!storedPrivatePublication) {
            git('init', '--quiet'); git('config', 'user.name', 'Deployment Health Fixture');
            git('config', 'user.email', 'health@example.test'); git('add', 'compose.yaml');
            if (scenario === 'required_project_secret') git('add', '.happier/project.json');
            git('commit', '--quiet', '-m', 'A');
        }
        let environment = createDeploymentEnvironmentDetailV1();
        const previewEnvironments = new Map<string, typeof environment>();
        if (previewCopy) {
            environment.environment.createdByAccountId = 'account-cli-fixture';
            environment.environment.owner = { kind: 'account', accountId: 'account-cli-fixture' };
        }
        if (scenario.startsWith('joining_current')) environment.content.ownServer!.rollout = 'startFirst';
        if (storedPrivatePublication) {
            const document = await readFile(join(repository, 'compose.yaml'), 'utf8');
            environment.content.definition = { kind: 'stored', document, contentRevision: 1,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
        }
        if (scenario === 'private_publication_refused' || scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_forward_withdrawal') environment.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false,
            serviceExports: [{ key: 'application', service: 'app', containerPort: 3000, scheme: 'http',
                exposure: 'privateNetwork', privateNetwork: 'shop-net' }] };
        if (scenario.startsWith('iroh_publication_')) environment.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false,
            serviceExports: [{ key: 'application', service: 'app', containerPort: 3000, scheme: 'http',
                exposure: 'loopback', transport: { kind: 'iroh' } }] };
        if (scenario.startsWith('native_preview_cleanup')) {
            environment.environment.purpose = scenario.includes('_companion') ? 'standard' : 'preview';
            if (scenario.includes('_companion')) Object.assign(environment.environment, { previewCompanionOfEnvironmentId: 'main-preview' });
            environment.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false,
                serviceExports: [{ key: 'later-app', service: 'later-app', containerPort: 3000, scheme: 'http',
                    exposure: 'loopback', transport: { kind: 'iroh' } },
                { key: 'later-private', service: 'later-app', containerPort: 3000, scheme: 'http',
                    exposure: 'privateNetwork', privateNetwork: 'shop-net' }] };
            environment.content = DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
                template: { templateRef: { sourceId: 'apps', itemId: 'postgresql', version: '17',
                    ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['app'],
                    definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
                    data: { engine: 'postgres', service: 'app', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } },
                    volumes: [{ id: 'shared', service: 'app', target: '/data', persistent: true, backup: true, consistency: 'logicalDump' }] } });
        }
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
        let receipt = createDeploymentReceiptDetailV1();
        receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, acceptedExecution: { v: 1,
            controller: { machineId: environment.environment.controllerMachineId, installationId: 'installation-a' },
            builder: { machineId: environment.environment.buildMachineId!, installationId: 'installation-a' }} });
        receipt.deployment.state = 'queued';
        receipt.content.machineResults = [];
        receipt.content.images = [image];
        if (storedPrivatePublication) {
            if (environment.content.definition.kind !== 'stored') throw new Error('Stored fixture required');
            receipt.content.sourceIntent = environment.content.definition;
        } else {
            if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
            receipt.content.sourceIntent.sha = git('rev-parse', 'HEAD');
        }
        let serving = structuredClone(receipt);
        serving.deployment.id = 'serving-release';
        serving.deployment.state = 'succeeded';
        if (serving.content.sourceIntent.kind === 'repository') serving.content.sourceIntent.sha = 'b'.repeat(40);
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
        let runtimeGrants = [secretGrant];
        const previewNativeStates = new Map<string, Readonly<{ receipt: typeof receipt; serving: typeof serving;
            grants: typeof runtimeGrants }>>();
        const previewReceipts = new Map<string, typeof receipt>();
        const copySourceGrants: typeof runtimeGrants = [];
        let copySourceAdmissions = 0;
        if (scenario === 'joining_current_successor') {
            environment.content.bindings.push({ purpose: 'registry', targetLinkId: environment.targetLinks[0].targetLink.id,
                registryOrigin: 'https://registry.example.test', access: 'pushPull',
                source: { kind: 'secret', ref: 'happier:shared-secret:v1:registry', resourceRevision: 1 } });
            runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                installationId: 'installation-a', environmentId: environment.environment.id, resourceId: 'registry', resourceRevision: 1 },
                installationPublicKey, content: { kind: 'secret', value: JSON.stringify({ username: 'deploy', password: 'retained-registry-sentinel' }) } }));
        }
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
        const previewArtifactStore = previewCopy ? createCredentialedAccountArtifactStore(credentials) : undefined;
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
            if (publicCopy && httpRequest.method?.toUpperCase() === 'GET'
                && new URL(httpRequest.url ?? serverHttpBaseUrl).pathname === `/v1/deployments/environments/${promotionSource.environment.id}`) {
                return readAccessRevoked ? { status: 403, data: { error: 'forbidden' } }
                    : { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
                        environment: structuredClone(promotionSource.environment),
                        targetLinks: promotionSource.targetLinks.map(({ targetLink }) => structuredClone(targetLink)) }) };
            }
            if (httpRequest.method?.toUpperCase() === 'POST'
                && new URL(httpRequest.url ?? serverHttpBaseUrl).pathname === '/v1/deployments/environments/access') {
                const input = DeploymentEnvironmentAccessInputV1Schema.parse(httpRequest.data);
                return readAccessRevoked ? { status: 403, data: { error: 'forbidden' } }
                    : { status: 200, data: DeploymentEnvironmentAccessResultV1Schema.parse({ ok: true,
                        items: input.environmentIds.filter(id => id === environment.environment.id || id === promotionSource.environment.id)
                            .map(environmentId => ({ environmentId, read: true, deploy: true })) }) };
            }
            if ((scenario === 'routing_review' || scenario === 'public_restore_drill')
                && new URL(httpRequest.url ?? serverHttpBaseUrl).pathname.endsWith('/secret-launch-admission')) {
                const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(httpRequest.data);
                expect(verifyMachineInstallationProof({ proof, publicKey: installationPublicKey,
                    payload: { version: 1, machineId: body.machineId, installationId: body.installationId, accountId,
                        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } } })).toBe(true);
                if (scenario === 'public_restore_drill') expect(body.materialization).toMatchObject({ kind: 'dataRole', service: 'app' });
                return { status: 200, data: EnvironmentSecretLaunchAdmissionResultV1Schema.parse({ ok: true,
                    grants: runtimeGrants.filter(grant => grant.machineId === body.machineId
                        && grant.installationId === body.installationId && (scenario !== 'public_restore_drill'
                            || grant.kind === 'secret' && grant.resourceId === 'drill-read-only')) }) };
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
            if (runtimeRead || scenario === 'runtime_stage' || scenario === 'member_child_cost' || promotionScenario || scenario === 'public_backup') {
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
            if (new URL(url).pathname === '/v3/automations/query') {
                return { status: 200, data: { automations: [], nextCursor: null } };
            }
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
            controller: pluginReloadController, runtimeOptions: {
                pluginIds: [...(storedPrivatePublication ? [] : ['happier.scm.backend.git']),
                ...(migrationBackup || publicCopy || scenario === 'public_restore' || scenario.startsWith('standalone_public_restore')
                    ? ['happier.backup.destinations'] : [])] } });
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
        let settleBackupFixture = async () => {};
        onTestFinished(async () => { await settleBackupFixture(); });
        let retainedReads = 0;
        let healthAttachmentExpected = false;
        let environmentReads = 0;
        let memberEnvironmentReads = 0;
        let memberReceiptReads = 0;
        let recoveryCapture: OwnServerDeploymentReceipt | undefined;
        let earlierReceipt: OwnServerDeploymentReceipt | undefined;
        let retainedPrivateExports: string[] = [];
        let firewallElevationAvailable = true;
        let definitionEditedAfterAdmission = false;
        let transitionWrites = 0;
        let migrationBackupActivationCount: number | undefined;
        const previewForwardBindings: Array<{ environmentId: string; port: number }> = [];
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
                || scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_matching_restore' || scenario === 'private_publication_forward_withdrawal' || scenario === 'runtime_stage' ? { async settlePrivateWorkloadFirewall(
                ...[_request, input]: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['settlePrivateWorkloadFirewall']>>
            ) {
                // Elevation is the native boundary; real source/render/executor admission stay composed.
                if (!firewallElevationAvailable) throw Object.assign(new Error('Elevation unavailable'), { code: 'private_scope_unenforceable' });
                expect(input.docker.engineId).toBe(input.render.engineId);
                if (scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_matching_restore' || scenario === 'private_publication_forward_withdrawal' || scenario === 'runtime_stage') {
                    const bindings = privateServicePublicationBindings({ environmentId: input.environment.environment.id,
                        exports: input.environment.content.ownServer?.serviceExports ?? [], services: input.render.review.services,
                        privateNetworks: [{ provider: { kind: 'builtin', id: 'tailscale' },
                            networkIdentity: scenario === 'runtime_stage' ? 'application' : 'shop-net', displayName: null,
                            dnsName: null, magicDnsEnabled: false, addresses: ['100.81.1.12'], state: 'ready',
                            interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'] }] });
                    await writeFile(join(root, 'private-firewall-bindings.json'), JSON.stringify(bindings));
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
            async readEnvironmentMetadata({ environmentId }) {
                return structuredClone(previewEnvironments.get(environmentId)?.environment ?? promotionSource.environment);
            },
            async readEnvironment({ environmentId, context }) {
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
                return structuredClone(previewEnvironments.get(environmentId) ?? (publicCopy && environmentId === promotionSource.environment.id
                    ? promotionSource : environment));
            },
            async readReceipt({ deploymentId }) { memberReceiptReads++; return structuredClone(previewReceipts.get(deploymentId)
                ?? (deploymentId === serving.deployment.id ? serving : recoveryCapture?.deployment.id === deploymentId ? recoveryCapture : earlierReceipt?.deployment.id === deploymentId ? earlierReceipt : receipt)); },
            readBuildHistory() {
                // Home gives a review its exact receipt reads, never history admission.
                if (scenario === 'review_receipt_scope') throw Object.assign(new Error('Receipt history is not admitted'), { code: 'deployment_access_denied' });
                return (async function* () {
                    yield structuredClone(receipt);
                    if (recoveryCapture) yield structuredClone(recoveryCapture);
                    yield structuredClone(serving);
                    if (earlierReceipt) yield structuredClone(earlierReceipt);
                })();
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
                if (previewCopy) {
                    // Use the incumbent revision writer, including private provenance.
                    // Only committing its prepared mutation is the Home DB boundary.
                    const id = receipt.deployment.contentArtifactId;
                    const prior = stored.get(id);
                    if (!prior || !previewArtifactStore) throw new Error('An admitted preview receipt needs its prepared Artifact');
                    const resource = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => previewArtifactStore.readForUpdate(id,
                        { signal: input.context.signal, prepareRecipients: false, includeSharedAudience: false }));
                    if (!resource) throw new Error('An admitted preview receipt needs its current Artifact');
                    const prepared = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resource.prepareJsonUpdate({
                        header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, receipt.content),
                        body: JSON.stringify(receipt.content) }));
                    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
                    await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => prepared.assertCurrent());
                    const headerVersion = receipt.deployment.contentHeaderVersion + 1;
                    const bodyVersion = receipt.deployment.contentBodyVersion + 1;
                    stored.set(id, { ...prior, ...prepared.mutation,
                        headerVersion, bodyVersion });
                    await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => prepared.afterCommit());
                    Object.assign(receipt.deployment, { contentHeaderVersion: headerVersion, contentBodyVersion: bodyVersion });
                    previewReceipts.set(receipt.deployment.id, structuredClone(receipt));
                }
                if (previewCopy && input.state === 'succeeded' && receipt.deployment.operation !== 'teardown')
                    environment.targetLinks[0]!.targetLink.activeDeploymentId = receipt.deployment.id;
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
                if ((runtimeRead || scenario === 'runtime_stage' || previewCopy)
                    && receipt.deployment.operation !== 'teardown'
                    && (input.state === 'succeeded' || input.state === 'running_unverified')) {
                    environment.targetLinks[0].targetLink.activeDeploymentId = receipt.deployment.id;
                }
                return { ok: true, environmentId: input.environmentId,
                revision: environment.environment.revision, deploymentId: input.deploymentId,
                deploymentRevision: receipt.deployment.revision, state: input.state }; },
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl, machineId: 'machine-a',
                resolveRequesterIdentity,
                ...(previewCompanion ? { async acquireServiceExportForward(
                    input: Parameters<NonNullable<OwnServerDeploymentRuntimeHostInput['acquireServiceExportForward']>>[0],
                ) {
                    // Iroh transport is the boundary; native managed-service admission and address materialization remain real.
                    expect(input.targetMachineId).toBe('machine-a');
                    expect(input.serviceExport.destination.host).toBe('127.0.0.1');
                    previewForwardBindings.push({ environmentId: input.serviceExport.service.environmentId,
                        port: input.serviceExport.destination.port });
                    return { host: '127.0.0.1' as const, port: input.serviceExport.destination.port,
                        observedPath: 'relay' as const, async close() {} };
                } } : {}),
                async acquirePluginRuntimeRegistryLease() { return mounted.controller.tryAcquireRuntimeRegistry()!; },
                async readEnvironmentSecretLaunchAdmission(input) {
                    if (publicCopy && input.materialization.kind === 'copySourceRead') {
                        expect(input).toMatchObject({ environmentId: promotionSource.environment.id,
                            targetLinkId: promotionSource.targetLinks[0].targetLink.id,
                            materialization: { kind: 'copySourceRead', deploymentId: recoveryCapture!.deployment.id,
                                actionOperationId: recoveryCapture!.deployment.actionOperationId } });
                        copySourceAdmissions++;
                        return { grants: copySourceGrants, async assertCurrent() {} };
                    }
                    if ((scenario === 'public_restore' || scenario.startsWith('standalone_public_restore'))
                        && input.materialization.kind === 'deployment') {
                        const deploymentId = input.materialization.deploymentId;
                        const materialized = [receipt, serving, recoveryCapture].find(candidate => candidate?.deployment.id === deploymentId);
                        expect(input.actionOperationId ?? input.context.operationAcceptance?.operationId)
                            .toBe(materialized?.deployment.actionOperationId);
                    }
                    return { grants: publicCopy && input.environmentId === promotionSource.environment.id
                        ? copySourceGrants : runtimeGrants, async assertCurrent() {} };
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
            // Same-Machine transport forwards into the incumbent builder. Its
            // native images, archive custody and receipt transitions stay real.
            ...(previewCopy ? { dispatchBuild: input => buildOwnServerDeploymentReceipt(measuredHost, input) } : {}),
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
                    expect(receipt.content.failure).toMatchObject(expectedFailure);
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
                const roles = retainedBackupTransport === 'local' ? ['repositoryPassword'] as const
                    : retainedBackupTransport === 'sftp' ? ['repositoryPassword', 'sshPrivateKey'] as const
                    : ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
                if (retainedBackupTransport === 'local') await mkdir(join(root, 'retained-backup'), { recursive: true });
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
                phase('backup-initial-activation');
                const initialActivation = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(initialActivation, JSON.stringify({ initialActivation, failure: receipt.content.failure,
                    steps: receipt.content.steps })).toMatchObject({ ok: true });
                Object.assign(serving, structuredClone(receipt));
                serving.deployment.state = 'succeeded';
                environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                environment.content = DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
                    template: { templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['app'],
                        definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, data: {
                        engine: 'postgres', service: 'app', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } } },
                    backup: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.destinations', localId: retainedBackupTransport ?? 's3' },
                        occurrenceId: mounted.registry.readPluginOccurrenceId('happier.backup.destinations'),
                        config: retainedBackupTransport === 'local' ? { path: join(root, 'retained-backup') }
                            : retainedBackupTransport === 'sftp' ? { host: 'receiver', username: 'archive', path: '/recovery',
                                hostKey: 'receiver ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h' }
                            : { endpoint: 'https://fixture.invalid', bucket: 'backup', prefix: '' },
                        credentialBindings: roles.map(role => ({ purpose: 'backupDestination', configKey: 'destination', role })),
                        sources: [{ kind: 'dump', sourceId: 'database', service: 'app', consistency: 'logical' }],
                        ownership: { environmentId: environment.environment.id, prefix: environment.environment.id }, retention: { kind: 'keepEverything' } },
                    ownServer: { ...environment.content.ownServer, backupBeforeMigration: true, migrationFailurePolicy: 'ask',
                        migration: { service: 'app', argv: ['migrate', '--candidate-release'] } } });
                if (scenario.startsWith('public_backup')) {
                    await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
                    const boundary = await installRestoreBoundary(root, 'success',
                        { toolDirectory: join(root, 'docker'), environmentId: environment.environment.id });
                    const backupRuntimes: Array<ReturnType<typeof createHostActionOperationRuntime>> = [];
                    const backupEffects = new Set<Promise<unknown>>();
                    const startOperations = async () => {
                        const runtime = createHostActionOperationRuntime({ machineId: 'machine-a', serverId: 'home',
                        custodyBinding: { serverId: 'home', installationId: 'installation-a' }, resolveAccountId: async () => accountId,
                        projectOpenReceiptPersistence: await prepareProjectOpenReceiptPersistence({
                            directory: join(root, 'action-operations'), keyPath: join(root, 'device-local-key.json'),
                            accountId, machineId: 'machine-a',
                        }) });
                        backupRuntimes.push(runtime);
                        return runtime;
                    };
                    let operations = await startOperations();
                    settleBackupFixture = async () => {
                        caller.abort();
                        const scope = { accountId, machineId: 'machine-a' };
                        for (const runtime of backupRuntimes) {
                            for (const operation of runtime.store.list(scope).items) runtime.runner.cancel(scope, operation.operationId);
                        }
                        // A caller abort only ends observation. Wait for this fixture's
                        // actual admitted native effects before another case starts.
                        await Promise.allSettled([...backupEffects]);
                    };
                    const runBackupOperation: typeof operations.runActionOperation = value => operations.runActionOperation({ ...value,
                        execute: context => {
                            const effect = value.execute(context);
                            backupEffects.add(effect);
                            void effect.finally(() => backupEffects.delete(effect)).catch(() => undefined);
                            return effect;
                        } });
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
                    const actionsSettings = setScopedActionApprovalPreference({ settings: DEPLOYMENT_BACKUP_ACTION_IDS_V1.reduce((settings, actionId) => setScopedActionApprovalPreference({
                        settings, actionId, scope: { kind: 'environment', environmentId: environment.environment.id }, surface: 'ui', mode: 'waived',
                    }), ActionsSettingsV1Schema.parse({ v: 1 })), actionId: 'deployments.backups.restore',
                        scope: { kind: 'environment', environmentId: environment.environment.id }, surface: 'ui', mode: 'waived' });
                    const nativeActions = { deploymentBackupAction, deploymentRestore,
                        ...(scenario === 'public_backup' ? { deploymentAction:
                            createDaemonDeploymentActionDeps({ ...host, resolveRequesterIdentity }).deploymentAction } : {}) };
                    const executor = scenario === 'public_backup_restore' || scenario === 'public_backup'
                        ? createCliActionExecutorFromCredentials({ credentials, serverId: 'home', serverApiUrl: serverHttpBaseUrl,
                            serverIdentityId: 'srv_health_home', machineId: 'machine-a',
                            actionsSettingsProvider: { getActionsSettings: () => actionsSettings },
                            resolveEnvironmentApprovalScope: storage.resolveEnvironmentApprovalScope,
                            ...nativeActions, runActionOperation: runBackupOperation })
                        : createActionExecutor({ ...createUnavailableActionTransportDeps(), ...storage, serverId: 'home', machineId: 'machine-a',
                            ...nativeActions, runActionOperation: runBackupOperation });
                    const actionContext = { ...sourceContext, surface: 'ui' as const, actionCaller: { kind: 'host' as const },
                        serverId: 'home', runtimeAccountId: accountId, signal: caller.signal, actionsSettings };
                    const targetInput = { serverId: 'home', environmentId: environment.environment.id, machineId: 'machine-a',
                        installationId: 'installation-a', targetLinkId: environment.targetLinks[0].targetLink.id,
                        deploymentId: serving.deployment.id, expectedRevision: environment.environment.revision, configRevision: 1 };
                    if (scenario === 'public_backup_probe') {
                        const before = await readFile(boundary.eventsFile, 'utf8');
                        for (const surface of ['ui', 'agent'] as const) {
                            const probeContext = { ...actionContext, surface,
                                actionsSettings: setScopedActionApprovalPreference({ settings: actionsSettings,
                                    actionId: 'deployments.backups.test',
                                    scope: { kind: 'environment', environmentId: environment.environment.id }, surface, mode: 'waived' }) };
                            await boundary.setRepositoryConfigExitCode(0);
                            const probe = await executor.execute('deployments.backups.test',
                                buildDeploymentBackupActionInputV1('deployments.backups.test', targetInput),
                                { ...probeContext, actionRequestId: `probe-success-${surface}` });
                            expect(probe.ok ? probe.result : probe)
                                .toEqual({ kind: 'reachable', repositoryId: 'c'.repeat(64) });
                            await boundary.setRepositoryConfigExitCode(12);
                            expect(await executor.execute('deployments.backups.test',
                                buildDeploymentBackupActionInputV1('deployments.backups.test', targetInput),
                                { ...probeContext, actionRequestId: `probe-failed-${surface}` }))
                                .toMatchObject({ ok: true, result: { kind: 'failed', reason: 'repository_password_incorrect',
                                    step: 'repository', nativeExitCode: 12, remedy: 'review_credentials' } });
                        }
                        const events = (await readFile(boundary.eventsFile, 'utf8')).slice(before.length).trim().split('\n')
                            .filter(Boolean).map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                        const resticEvents = events.filter(event => event.kind === 'restic');
                        expect(resticEvents.filter(event => event.argv?.includes('config'))).toHaveLength(4);
                        expect(resticEvents.filter(event => event.argv?.includes('backup'))).toHaveLength(2);
                        expect(resticEvents.filter(event => event.argv?.includes('dump'))).toHaveLength(2);
                        expect(resticEvents.filter(event => event.argv?.includes('forget')).map(event => event.argv?.at(-1)))
                            .toEqual(['d'.repeat(64), 'd'.repeat(64)]);
                        expect(events.some(event => event.kind === 'postgres' || event.kind === 'nativeControl'
                            || event.kind === 'safetyBytes')).toBe(false);
                        expect(await docker.readOperationContainerIds()).toEqual([]);
                        return;
                    }
                    const backupConfiguration = environment.content.backup;
                    if (!backupConfiguration || 'notNeeded' in backupConfiguration) throw new Error('Expected configured backups');
                    const backupNotice = (check: 'run' | 'verify' | 'prune' | 'restore') => [...stored.values()].flatMap(row => {
                        const header = AccountNoticeArtifactHeaderV1Schema.safeParse(decodePlainArtifactStoredContent(String(row.header)));
                        return header.success ? [header.data] : [];
                    }).find(header => header.source.kind === 'host' && header.source.topic === 'service_health'
                        && header.source.subject.kind === 'backup' && header.source.subject.check === check);
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
                        inputs: { backupEnvironment: { serverId: targetInput.serverId, environmentId: targetInput.environmentId },
                            backupPolicy: deploymentBackupPolicyV1(backupConfiguration), verificationLevel: 'manifestReadBack' },
                    } : null;
                    if (savedNightly) {
                        // Nightly resolves the current target from the saved Environment
                        // and backup policy, including after an unrelated Environment edit.
                        environment.environment.revision++;
                        expect(targetInput.expectedRevision).toBe(environment.environment.revision - 1);
                    }
                    phase('backup-run');
                    const run = await executor.execute('deployments.backups.run', buildDeploymentBackupActionInputV1('deployments.backups.run', targetInput),
                        { ...actionContext, actionRequestId: 'public-backup-run' });
                    expect(run, JSON.stringify(run)).toMatchObject({ ok: true, result: { kind: 'verified' } });
                    if (!run.ok) throw new Error('Expected a retained backup operation');
                    const captured = DeploymentBackupRunResultV1Schema.parse(run.result);
                    const manifest = captured.manifests[0];
                    if (!manifest) throw new Error('Expected exact native snapshot evidence');
                    if (retainedBackupTransport) {
                        // Actual installed Open and P42 supplied the backup helper's transport.
                        // Inspect the OS boundary, then exercise the retained restore owner;
                        // no capture object or createInput operand is reconstructed here.
                        const assertTransport = (args: readonly string[]) => {
                            if (retainedBackupTransport === 'local') expect(args).toContain(
                                `type=bind,source=${join(root, 'retained-backup')},target=/run/happier/backup/repository`);
                            else {
                                expect(args).toContain('sftp.command=ssh -F /run/happier/backup/ssh-config -s backup sftp');
                                for (const file of ['ssh-key', 'ssh-config', 'known-hosts']) expect(args.some(
                                    arg => arg.includes(`target=/run/happier/backup/${file}`))).toBe(true);
                            }
                        };
                        const beforeRestore = await docker.readInvocations();
                        const backupRepositoryRead = beforeRestore.find(call => call.args[0] === 'create' && call.args.includes('config'));
                        expect(backupRepositoryRead).toBeDefined();
                        assertTransport(backupRepositoryRead!.args);
                        // Current policy may move after capture; historical access must
                        // reopen the captured provider configuration instead.
                        environment.content.backup = { ...backupConfiguration, config: { ...backupConfiguration.config,
                            path: retainedBackupTransport === 'local' ? join(root, 'new-backup-policy') : '/new-backup-policy' } };
                        const { configRevision: _configRevision, ...restoreTarget } = targetInput;
                        const preparation = await executor.execute('deployments.backups.restore', { ...restoreTarget,
                            mode: 'prepare', source: { kind: 'repository', backupOperationId: captured.operationId,
                                snapshotId: manifest.snapshot.snapshotId }, destination: { kind: 'database', service: 'app', database } },
                        { ...actionContext, actionRequestId: `retained-${retainedBackupTransport}-restore` });
                        expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                        const restoredRepositoryRead = (await docker.readInvocations()).slice(beforeRestore.length)
                            .find(call => call.args[0] === 'create' && call.args.includes('config'));
                        expect(restoredRepositoryRead).toBeDefined();
                        assertTransport(restoredRepositoryRead!.args);
                        const historicalCapture = captured.restoreCaptures[0];
                        if (!historicalCapture || historicalCapture.sourceFormat !== 'postgresCustom') throw new Error('Expected retained dump capture');
                        // A retained Home receipt is the storage boundary for backups made
                        // before destination ownership prefixes reached the native locator.
                        const recordedRoot = retainedBackupTransport === 'local' ? '/run/happier/backup/repository'
                            : 'sftp://archive@receiver//recovery';
                        expect(historicalCapture.configuration.ownership.prefix).not.toBe('');
                        serving.content.ownServer!.preMigrationBackup = { ...historicalCapture,
                            repository: { repository: recordedRoot } };
                        const beforeHistoricalRestore = await docker.readInvocations();
                        const historicalPreparation = await executor.execute('deployments.backups.restore', { ...restoreTarget,
                            mode: 'prepare', source: { kind: 'repository', snapshotId: manifest.snapshot.snapshotId },
                            destination: { kind: 'database', service: 'app', database } },
                        { ...actionContext, actionRequestId: `retained-${retainedBackupTransport}-root-restore` });
                        expect(historicalPreparation, JSON.stringify(historicalPreparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                        const historicalRepositoryRead = (await docker.readInvocations()).slice(beforeHistoricalRestore.length)
                            .find(call => call.args[0] === 'create' && call.args.includes('config'));
                        expect(historicalRepositoryRead).toBeDefined();
                        assertTransport(historicalRepositoryRead!.args);
                        const repositoryArgument = historicalRepositoryRead!.args.indexOf('--repo');
                        expect(repositoryArgument).toBeGreaterThanOrEqual(0);
                        expect(historicalRepositoryRead!.args[repositoryArgument + 1]).toBe(recordedRoot);
                        return;
                    }
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
                        expect(scheduled, JSON.stringify({ scheduled, invocations: store.list().map(({ blockId, lifecycle, result }) =>
                            ({ blockId, lifecycle, ...(blockId === 'current' && isRecord(result)
                                ? { resultKeys: Object.keys(result) } : {}) })) })).toMatchObject({ state: 'succeeded' });
                        for (const blockId of ['backup', 'verify', 'prune']) {
                            expect(store.list().find(row => row.blockId === blockId)).toMatchObject({ lifecycle: 'completed' });
                        }
                        expect(savedNightly.inputs.backupEnvironment.environmentId).toBe(environment.environment.id);
                        // A genuine dump-process failure must remain visible through
                        // the existing history producer used by the Backups notice.
                        const nativeState = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                        await writeFile(boundary.stateFile, JSON.stringify({ ...nativeState, mode: 'dumpFailure' }));
                        const failed = await executor.execute('deployments.backups.run',
                            buildDeploymentBackupActionInputV1('deployments.backups.run', targetInput),
                            { ...actionContext, actionRequestId: 'nightly-failed-dump' });
                        expect(failed.ok).toBe(false);
                        if (failed.ok) throw new Error('Expected the dump process failure');
                        expect(failed).toMatchObject({ details: { step: 'producer' },
                            failureCause: { phase: 'deployment.backup.native' } });
                        expect(backupNotice('run')).toMatchObject({ type: 'update', healthPhase: 'open', resolved: false,
                            source: { subject: { kind: 'backup', environmentId: environment.environment.id, check: 'run' } } });
                        expect(await docker.readOperationContainerIds(), 'native cleanup removed the exact restic helper before retry').toEqual([]);
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
                        expect(backupNotice('run')).toMatchObject({ healthPhase: 'open' });
                        await writeFile(boundary.stateFile, JSON.stringify({ ...nativeState, mode: 'success' }));
                        const nextBackup = await executor.execute('deployments.backups.run',
                            buildDeploymentBackupActionInputV1('deployments.backups.run', targetInput),
                            { ...actionContext, actionRequestId: 'nightly-recovered-dump' });
                        expect(nextBackup, JSON.stringify(nextBackup)).toMatchObject({ ok: true });
                        expect(backupNotice('run')).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
                        return;
                    }
                    // #111 → #112: the repository survives a cold operation owner.
                    if (scenario === 'public_backup_restore') operations = await startOperations();
                    const inventory = await executor.execute('deployments.backups.inventory',
                        buildDeploymentBackupActionInputV1('deployments.backups.inventory', targetInput),
                        { ...actionContext, actionRequestId: 'public-backup-inventory' });
                    expect(inventory, JSON.stringify(inventory)).toMatchObject({ ok: true, result: { kind: 'inventory' } });
                    if (!inventory.ok) throw new Error('Expected the selected repository inventory');
                    expect(DeploymentBackupInventoryResultV1Schema.parse(inventory.result).snapshots).toContainEqual({
                        snapshot: manifest.snapshot, source: { sourceId: 'database', kind: 'dump' }, totalBytesProcessed: manifest.totalBytesProcessed,
                        verification: { kind: 'verified', backupOperationId: captured.operationId, configRevision: manifest.configRevision } });
                    const beforeVerify = await readFile(boundary.eventsFile, 'utf8');
                    phase('backup-verify');
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
                        phase('backup-recorded-health');
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
                        expect(backupNotice('verify')).toMatchObject({ type: 'update', healthPhase: 'open', resolved: false });
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
                        expect(await executor.execute('deployments.backups.run',
                            buildDeploymentBackupActionInputV1('deployments.backups.run', targetInput),
                            { ...actionContext, actionRequestId: 'run-does-not-recover-verification' })).toMatchObject({ ok: true });
                        expect(backupNotice('verify')).toMatchObject({ healthPhase: 'open' });
                        expect(await executor.execute('deployments.backups.verify',
                            buildDeploymentBackupActionInputV1('deployments.backups.verify', { ...targetInput,
                                backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId, level: 'repositoryCheck' }),
                            { ...actionContext, actionRequestId: 'public-backup-verify-recovered' })).toMatchObject({ ok: true });
                        expect(backupNotice('verify')).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
                        return;
                    }
                    if (scenario === 'public_backup_restore') {
                        // #111: a real standalone dump exists and verifies, but the
                        // credentialed daemon factory dropped its restore handler.
                        const { configRevision: _configRevision, ...restoreTarget } = targetInput;
                        const prepareInput = { ...restoreTarget, mode: 'prepare' as const,
                            source: { kind: 'repository' as const, backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId } };
                        const preparation = await executor.execute('deployments.backups.restore', prepareInput,
                            { ...actionContext, actionRequestId: 'standalone-backup-check' });
                        expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                        if (!preparation.ok) throw new Error('Expected standalone backup preparation');
                        const prepared = DeploymentBackupRestoreResultV1Schema.parse(preparation.result);
                        if (prepared.kind !== 'prepared') throw new Error('Expected standalone backup preparation evidence');
                        operations = await startOperations();
                        const restoreState = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                        await writeFile(boundary.stateFile, JSON.stringify({ ...restoreState, mode: 'failure' }));
                        expect(await executor.execute('deployments.backups.restore', { ...prepareInput, mode: 'confirm',
                            prepareOperationId: prepared.operationId }, { ...actionContext, actionRequestId: 'standalone-backup-restore-failed' }))
                            .toMatchObject({ ok: true, result: { kind: 'recoveryRequired', verified: false } });
                        expect(backupNotice('restore')).toMatchObject({ type: 'update', healthPhase: 'open', resolved: false });
                        await writeFile(boundary.stateFile, JSON.stringify({ ...JSON.parse(await readFile(boundary.stateFile, 'utf8')), mode: 'success' }));
                        const nextPreparation = await executor.execute('deployments.backups.restore', prepareInput,
                            { ...actionContext, actionRequestId: 'standalone-backup-recheck' });
                        expect(nextPreparation, JSON.stringify(nextPreparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                        if (!nextPreparation.ok) throw new Error('Expected the next explicit restore preparation');
                        const nextPrepared = DeploymentBackupRestoreResultV1Schema.parse(nextPreparation.result);
                        if (nextPrepared.kind !== 'prepared') throw new Error('Expected the next restore preparation evidence');
                        expect(backupNotice('restore')).toMatchObject({ healthPhase: 'open' });
                        // The native destination changes after its admission read.
                        // An unknown result stays actionable and grants no replay.
                        if (!isRecord(nextPrepared.evidence)) throw new Error('Expected retained restore evidence');
                        const nextDestination = OwnServerRestorePreparationForHostSchema.parse(nextPrepared.evidence.native).prepared.destination;
                        if (nextDestination.adapter !== 'postgres-v1') throw new Error('Expected PostgreSQL fixture destination');
                        await boundary.setDatabaseNameObservations([JSON.parse(await readFile(boundary.stateFile, 'utf8')).names,
                            [database, nextDestination.stagingDatabase]]);
                        expect(await executor.execute('deployments.backups.restore', { ...prepareInput, mode: 'confirm',
                            prepareOperationId: nextPrepared.operationId }, { ...actionContext, actionRequestId: 'standalone-backup-restore-unknown' }))
                            .toMatchObject({ ok: true, result: { kind: 'outcome_unknown', verified: false } });
                        expect(backupNotice('restore')).toMatchObject({ type: 'update', healthPhase: 'open', resolved: false });
                        const finalPreparation = await executor.execute('deployments.backups.restore', prepareInput,
                            { ...actionContext, actionRequestId: 'standalone-backup-final-check' });
                        if (!finalPreparation.ok) throw new Error(JSON.stringify(finalPreparation));
                        const finalPrepared = DeploymentBackupRestoreResultV1Schema.parse(finalPreparation.result);
                        if (finalPrepared.kind !== 'prepared') throw new Error('Expected explicit preparation after unknown outcome');
                        expect(backupNotice('restore')).toMatchObject({ healthPhase: 'open' });
                        expect(await executor.execute('deployments.backups.restore', { ...prepareInput, mode: 'confirm',
                            prepareOperationId: finalPrepared.operationId }, { ...actionContext, actionRequestId: 'standalone-backup-restore' }))
                            .toMatchObject({ ok: true, result: { kind: 'restored', verified: true, nextAction: 'none' } });
                        expect(backupNotice('restore')).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
                        expect(await docker.readOperationContainerIds()).toEqual([]);
                        return;
                    }
                    if (scenario !== 'public_backup_retention') {
                        const beforePrune = await readFile(boundary.stateFile, 'utf8');
                        expect(await executor.execute('deployments.backups.prune', buildDeploymentBackupActionInputV1('deployments.backups.prune', {
                            ...targetInput, retention: { kind: 'keepEverything' },
                        }), { ...actionContext, actionRequestId: 'public-backup-prune' }))
                            .toMatchObject({ ok: true, result: { kind: 'noop', forgottenSnapshotIds: [] } });
                        expect(await readFile(boundary.stateFile, 'utf8')).toBe(beforePrune);
                    }
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
                            source: { kind: 'repository' as const, snapshotId: source.snapshot.snapshotId } };
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
                        await boundary.setRepositoryConfigExitCode(7);
                        expect(await executor.execute('deployments.backups.prune', pruneInput,
                            { ...actionContext, actionRequestId: 'retention-prune-failed' })).toMatchObject({ ok: false });
                        expect(backupNotice('prune')).toMatchObject({ type: 'update', healthPhase: 'open', resolved: false });
                        await boundary.setRepositoryConfigExitCode(0);
                        phase('retention-protected-prune');
                        expect(await executor.execute('deployments.backups.prune', pruneInput,
                            { ...actionContext, actionRequestId: 'retention-before-confirm' }))
                            .toMatchObject({ ok: true, result: { kind: 'noop', forgottenSnapshotIds: [] } });
                        expect(backupNotice('prune')).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
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
                const boundary = await installRestoreBoundary(root, scenario === 'candidate_backup_configured_native_failure' ? 'dumpFailure' : 'success', { toolDirectory: join(root, 'docker'),
                    environmentId: environment.environment.id });
                migrationBackupActivationCount = (await docker.readInvocations()).filter(call => call.args.includes('up')).length;
                const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                if (scenario === 'candidate_backup_configured_native_failure') {
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'backup_failed' });
                    const headers = [...stored.values()].map(row => decodePlainArtifactStoredContent(String(row.header)));
                    expect(headers).toContainEqual(expect.objectContaining({ type: 'update', healthPhase: 'open', source: {
                        kind: 'host', topic: 'service_health', subject: { kind: 'backup', environmentId: environment.environment.id, check: 'run' },
                    } }));
                    expect(receipt.content.ownServer?.preMigrationBackup).toBeUndefined();
                    return;
                }
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
            if (scenario.startsWith('native_preview_cleanup')) {
                const initial = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: initial.inputBasis };
                receipt.content.services = ['app'];
                receipt.content.onFailure = 'rollbackAll';
                await docker.seedVolume('template-postgres-data', 'template-project');
                if (scenario.endsWith('_failure')) await docker.failImageHealth(image.configDigest);
                const provision = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                const dataVolume = `${initial.inputBasis.physicalProjectName}_shared`;
                if (scenario.endsWith('_failure')) {
                    expect(provision, JSON.stringify({ provision, failure: receipt.content.failure })).toMatchObject({ ok: false });
                    expect((await docker.readInvocations()).some(call => call.args.includes('up')),
                        JSON.stringify({ provision, failure: receipt.content.failure })).toBe(true);
                    expect(await docker.readRunningImageConfig('app')).toBeNull();
                    expect(await docker.readVolumeNames()).toEqual(['template-postgres-data']);
                    return;
                }
                expect(provision, JSON.stringify({ provision, failure: receipt.content.failure })).toMatchObject({ ok: true });
                expect(receipt.content.ownServer?.previewCleanup).toEqual({ machines: ['machine-a'], volumes: [
                    { name: dataVolume, disposition: 'delete', confirmation: dataVolume },
                ] });
                expect(await docker.readVolumeNames()).toEqual([dataVolume, 'template-postgres-data'].sort());
                return;
            }
            if (scenario === 'public_restore' || scenario.startsWith('standalone_public_restore') || publicCopy) {
                phase('standalone-seed');
                const captureEnvironment = publicCopy ? promotionSource : environment;
                const destinationDatabase = 'copied-database';
                if (publicCopy) {
                    promotionSource.environment.id = 'copy-source-environment';
                    promotionSource.targetLinks[0].targetLink.id = 'copy-source-link';
                    promotionSource.targetLinks[0].targetLink.environmentId = promotionSource.environment.id;
                    promotionSource.targetLinks[0].targetLink.activeDeploymentId = 'source-current-release';
                    promotionSource.content.bindings = [];
                }
                const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
                for (const role of roles) {
                    captureEnvironment.content.bindings.push({ purpose: 'backupDestination', configKey: 'destination', role,
                        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 } });
                    (publicCopy ? copySourceGrants : runtimeGrants).push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                        installationId: 'installation-a', environmentId: captureEnvironment.environment.id, resourceId: role, resourceRevision: 1 },
                        installationPublicKey, content: { kind: 'secret', value: `private-${role}` } }));
                }
                if (publicCopy) {
                    if (scenario === 'public_restore_drill') {
                        environment.content.bindings.push({ purpose: 'dataRole', service: 'app', role: 'readOnlyPassword',
                            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('drill-read-only'), resourceRevision: 1 } });
                        runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                            installationId: 'installation-a', environmentId: environment.environment.id,
                            resourceId: 'drill-read-only', resourceRevision: 1 }, installationPublicKey,
                            content: { kind: 'secret', value: 'private-drill-read-only-password' } }));
                    }
                    for (const role of roles) {
                        const resourceId = `destination-${role}`;
                        environment.content.bindings.push({ purpose: 'backupDestination', configKey: 'destination', role,
                            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } });
                        runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                            installationId: 'installation-a', environmentId: environment.environment.id, resourceId, resourceRevision: 1 },
                            installationPublicKey, content: { kind: 'secret', value: `private-destination-${role}` } }));
                    }
                    if (previewCopy) {
                        const sourceValues = previewCompanion ? [{ name: 'DB_USER', value: 'source-database-user' },
                            { name: 'DB_HOST', value: 'source.invalid' }, { name: 'DB_PORT', value: '5432' }]
                            : [{ name: 'DB_USER', value: 'source-database-user' }];
                        environment.content.bindings.push(createDeploymentSecretVariableBindingV1({
                            name: 'DB_PASSWORD', phase: 'runtime', resourceId: 'review-secret', resourceRevision: 1 }));
                        for (const entry of sourceValues) {
                            const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: entry.name,
                                source: { kind: 'value' as const, value: entry.value } };
                            environment.content.bindings.push(binding);
                            runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues', machineId: 'machine-a',
                                installationId: 'installation-a', environmentId: environment.environment.id,
                                binding: { purpose: 'variable', phase: 'runtime', name: binding.name } }, installationPublicKey,
                                content: { kind: 'environmentValues', definition: binding.source } }));
                        }
                    }
                }
                if (scenario === 'standalone_public_restore_upload') {
                    environment.content = DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
                        template: { templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['app'],
                            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
                            data: { engine: 'postgres', service: 'app', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } } } });
                }
                if (publicCopy || scenario === 'standalone_public_restore_upload') {
                    const databaseBinding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'DB_NAME',
                        source: { kind: 'value' as const, value: publicCopy ? destinationDatabase : database } };
                    environment.content.bindings.push(databaseBinding);
                    runtimeGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues', machineId: 'machine-a',
                        installationId: 'installation-a', environmentId: environment.environment.id,
                        binding: { purpose: 'variable', phase: 'runtime', name: 'DB_NAME' } }, installationPublicKey,
                        content: { kind: 'environmentValues', definition: databaseBinding.source } }));
                }
                const activateDestination = async () => {
                    const initial = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: sourceContext });
                    receipt.deployment.state = 'running';
                    receipt.content.ownServer = { approvedInputBasis: initial.inputBasis };
                    const activation = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                    expect(activation, JSON.stringify(activation)).toMatchObject({ ok: true });
                    phase('standalone-seeded');
                    Object.assign(serving, structuredClone(receipt));
                    serving.deployment.state = 'succeeded';
                    environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                };
                if (!previewCopy) await activateDestination();
                else {
                    const sourceReview = await target.review({ actionId: request.actionId, input: request.input,
                        content: receipt.content, context: sourceContext });
                    serving.content.ownServer = { approvedInputBasis: sourceReview.inputBasis };
                }
                await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
                const boundary = await installRestoreBoundary(root, uploadedVolume ? 'volumeUpload' : scenario.startsWith('standalone_public_restore') ? 'safety' : 'success',
                    { toolDirectory: join(root, 'docker'), environmentId: captureEnvironment.environment.id });
                const capture = { source: { ...sourceManifest, environmentId: captureEnvironment.environment.id,
                    snapshot: { ...sourceManifest.snapshot, hostname: `happier-env-${captureEnvironment.environment.id}`,
                        tags: ['happier', `env:${captureEnvironment.environment.id}`, 'kind:dump', 'src:database'] } },
                    sourceFormat: 'postgresCustom' as const, target: { service: 'app', adapter: 'postgres-v1' as const, database },
                    configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.destinations', localId: 's3' },
                        occurrenceId: mounted.registry.readPluginOccurrenceId('happier.backup.destinations'), config: { endpoint: 'https://fixture.invalid', bucket: 'backup', prefix: '',
                            region: 'us-east-1', addressing: 'path' },
                        credentialBindings: roles.map(role => ({ purpose: 'backupDestination' as const, configKey: 'destination' as const, role })),
                        sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'app', consistency: 'logical' as const }],
                        ownership: { environmentId: captureEnvironment.environment.id, prefix: captureEnvironment.environment.id }, retention: { kind: 'keepEverything' as const } },
                    repository: { repository: 's3:https://fixture.invalid/backup',
                        s3: { region: 'us-east-1', addressing: 'path' as const } } };
                const originalRequest = request;
                if (publicCopy) {
                    const operations = createHostActionOperationRuntime({ machineId: 'machine-a', serverId: 'home',
                        custodyBinding: { serverId: 'home', installationId: 'installation-a' }, resolveAccountId: async () => accountId });
                    const copyEffects = new Set<Promise<unknown>>();
                    const trackCopyEffect = <T,>(effect: Promise<T>): Promise<T> => {
                        copyEffects.add(effect);
                        void effect.finally(() => copyEffects.delete(effect)).catch(() => undefined);
                        return effect;
                    };
                    settleBackupFixture = async () => {
                        caller.abort();
                        const scope = { accountId, machineId: 'machine-a' };
                        for (const operation of operations.store.list(scope).items)
                            operations.runner.cancel(scope, operation.operationId);
                        // Caller cancellation ends observation before admitted native effects.
                        // Settle this fixture's effects before another daemon lifetime starts.
                        await Promise.allSettled([...copyEffects]);
                    };
                    const runCopyOperation: typeof operations.runActionOperation = value => operations.runActionOperation({ ...value,
                        execute: context => trackCopyEffect(value.execute(context)) });
                    const backupTarget = { serverId: 'home', environmentId: promotionSource.environment.id,
                        targetLinkId: promotionSource.targetLinks[0].targetLink.id, machineId: 'machine-a',
                        installationId: 'installation-a', deploymentId: 'source-capture',
                        expectedRevision: promotionSource.environment.revision, configRevision: 1 };
                    const nativeSnapshot = { ...snapshot, hostname: `happier-env-${promotionSource.environment.id}`,
                        tags: ['happier', `env:${promotionSource.environment.id}`, 'kind:dump', 'src:database'] };
                    const checksumSha256 = createHash('sha256').update(archive).digest('hex');
                    const producedOperation = await runCopyOperation({ actionId: 'deployments.backups.run',
                        input: buildDeploymentBackupActionInputV1('deployments.backups.run', backupTarget),
                        context: { ...sourceContext, surface: 'ui', actionCaller: { kind: 'host' }, serverId: 'home',
                            runtimeAccountId: accountId, actionRequestId: 'public-copy-source-backup' },
                        async execute(context) {
                            const produced = await runDeploymentBackupV1({ environmentId: promotionSource.environment.id,
                                configuration: { ...capture.configuration, sources: [{ kind: 'dump', sourceId: 'database',
                                    service: 'database', consistency: 'logical' }] },
                                data: [{ engine: 'postgres', service: 'database', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } }],
                                restoreTargets: [{ service: 'database', adapter: 'postgres-v1', database }],
                                access: { ...capture.repository, passwordFilePath: '/run/secrets/repository-password',
                                    credentialFiles: [{ hostPath: '/private/source-password',
                                        containerPath: '/run/secrets/repository-password', readOnly: true }], environmentVariableNames: [] },
                                signal: caller.signal,
                                // Substitute only native process results. The real producer
                                // builds the manifest and capture after payload read-back.
                                async execute(nativeRequest) {
                                    const completed = { kind: 'completed' as const, exitCode: 0, stdoutTruncated: false };
                                    if (nativeRequest.argv.includes('config')) return { ...completed,
                                        stdout: JSON.stringify({ version: 2, id: 'c'.repeat(64) }) };
                                    if (nativeRequest.argv.includes('backup')) return { ...completed,
                                        stdout: JSON.stringify({ message_type: 'summary', snapshot_id: nativeSnapshot.id,
                                            total_bytes_processed: archive.length, total_files_processed: 1 }),
                                        producer: { exitCode: 0, checksumSha256 } };
                                    if (nativeRequest.argv.includes('snapshots')) return { ...completed, stdout: JSON.stringify([nativeSnapshot]) };
                                    if (nativeRequest.argv.includes('blob')) return { ...completed,
                                        stdout: JSON.stringify({ nodes: [{ name: 'database.dump', type: 'file', size: archive.length }] }) };
                                    if (nativeRequest.argv.includes('dump')) return { ...completed, stdout: '',
                                        stdoutChecksumSha256: checksumSha256, stdoutBytes: archive.length };
                                    throw new Error('Unexpected native source backup request');
                                } });
                            return { ok: true, result: { ...produced, operationId: context.operationAcceptance!.operationId } };
                        } });
                    expect(producedOperation, JSON.stringify(producedOperation)).toMatchObject({ ok: true, result: { kind: 'verified' } });
                    if (!producedOperation.ok) throw new Error('Expected a retained source backup operation');
                    const produced = DeploymentBackupRunResultV1Schema.parse(producedOperation.result);
                    const recordedCapture = produced.restoreCaptures?.[0];
                    if (!recordedCapture) throw new Error('Expected the real backup producer to retain its restore capture');
                    // The source's current configuration and generation advance
                    // after capture. Copy still consumes the original retained bytes.
                    recoveryCapture = structuredClone(serving);
                    recoveryCapture.deployment = { ...recoveryCapture.deployment, id: 'source-capture',
                        environmentId: promotionSource.environment.id,
                        targetLinkId: promotionSource.targetLinks[0].targetLink.id,
                        actionOperationId: 'original-source-capture-operation', state: 'failed' };
                    const capturedContent = { ...recoveryCapture.content, ownServer: { ...recoveryCapture.content.ownServer,
                        preMigrationBackup: recordedCapture } };
                    const opened = readDeploymentReceiptArtifactV1(recoveryCapture.deployment, {
                        artifactId: recoveryCapture.deployment.contentArtifactId,
                        revision: { headerVersion: recoveryCapture.deployment.contentHeaderVersion,
                            bodyVersion: recoveryCapture.deployment.contentBodyVersion },
                        header: createDeploymentReceiptArtifactHeaderV1('Recorded source capture', capturedContent),
                        body: JSON.stringify(capturedContent) });
                    if (!opened.ok) throw new Error(opened.error);
                    recoveryCapture.content = opened.content;
                    expect(recoveryCapture.content.ownServer?.preMigrationBackup).toEqual(recordedCapture);
                    promotionSource.content.backup = { ...recordedCapture.configuration, configRevision: 2,
                        config: { ...recordedCapture.configuration.config, endpoint: 'https://changed.invalid', bucket: 'changed' } };
                    if (previewCopy) {
                        const catalog: unknown = JSON.parse(await readFile(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
                        const registrySource: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
                            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
                        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [registrySource], http: {
                            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
                            getText: async () => { throw new Error('No text fetch'); }, getBytes: async () => { throw new Error('No binary fetch'); },
                        } });
                        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
                            sourceId: 'apps', kind: 'app', itemId: 'postgresql' })).item;
                        if (selected.payload.kind !== 'app') throw new Error('Expected bundled PostgreSQL');
                        const template = structuredClone(promotionSource);
                        template.environment.id = 'preview-template';
                        template.environment.purpose = 'standard';
                        template.environment.runtimeTargetLinkId = template.targetLinks[0]!.targetLink.id;
                        template.targetLinks[0]!.targetLink.environmentId = template.environment.id;
                        template.content.definition = { kind: 'repository', ref: 'main', compose: {
                            path: 'compose.yaml', profiles: [], services: previewCompanion ? ['app'] : ['app', 'database'], primaryService: 'app' } };
                        const templateRef = { sourceId: 'apps', itemId: 'postgresql', version: selected.summary.version!,
                            ref: selected.payload.ref };
                        const declaredData = prepareDeploymentTemplateInstantiationV1({ template: selected.payload.app, templateRef,
                            source: await parseNativeComposeSource(selected.payload.app.compose.document),
                            bindings: buildCatalogAppTemplateBindings(selected.payload.app).bindings });
                        if (previewCompanion) delete template.content.template;
                        else template.content.template = { ...declaredData.template, definition: template.content.definition };
                        const repositoryIdentity = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
                        const { ownership: _sourceOwnership, ...backupConfiguration } = recordedCapture.configuration;
                        const policy = { v: 1 as const, enabled: true, forkPreviews: 'off' as const, repository: repositoryIdentity,
                            runtimeTargetLinkId: template.environment.runtimeTargetLinkId, domain: null, bindingBlueprints: [], data: [{
                                kind: 'template' as const, templateRef,
                                dataExportNames: ['DATABASE_URL'], connectTo: { service: 'app' },
                                copyFrom: { environmentId: promotionSource.environment.id,
                                    targetLinkId: promotionSource.targetLinks[0]!.targetLink.id, deploymentId: 'source-capture',
                                    backupOperationId: produced.operationId, snapshotId: recordedCapture.source.snapshot.snapshotId },
                                destinationBackup: { prefix: 'previews',
                                    configuration: { ...backupConfiguration,
                                        destinationRef: { pluginId: 'happier.backup.destinations', localId: 's3' },
                                        occurrenceId: mounted.registry.readPluginOccurrenceId('happier.backup.destinations'),
                                        config: { endpoint: 'https://fixture.invalid', bucket: 'destination-safety', prefix: '' },
                                        sources: [{ kind: 'dump' as const, sourceId: 'destination-database', service: 'database', consistency: 'logical' as const }] },
                                    bindings: environment.content.bindings.filter(binding => binding.purpose === 'backupDestination') },
                            }] };
                        template.content.previewTemplate = policy;
                        const secretFixture = await createSavedSecretsCliHttpFixture();
                        try {
                            for (const role of roles) {
                                const resourceId = `destination-${role}`;
                                secretFixture.resources.set(resourceId, { resourceId, displayName: role, kind: 'token',
                                    encryptionMode: 'plain', revision: 1, storedContent: sealSavedSecretResourceStoredContentV1({
                                        resourceId, mode: 'plain', content: { v: 1, name: role, kind: 'token', value: `private-destination-${role}` } }) });
                            }
                            const { origin: _origin, removable: _removable, ...sourceRow } = registrySource;
                            const previousGet = axios.get.bind(axios);
                            const previousPost = axios.post.bind(axios);
                            const previousRequest = axios.request.bind(axios);
                            vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
                            vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
                                const path = new URL(url).pathname;
                                if (previewCompanion && path === '/v1/account/encryption-mode')
                                    return { status: 200, data: { mode: 'plain' } };
                                if (previewCompanion && path === '/v1/machines/machine-a')
                                    return { status: 200, data: { machine: { id: 'machine-a', kind: 'persistent', revokedAt: null,
                                        replacedByMachineId: null, seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
                                        metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'fixture',
                                            platform: 'linux', happyCliVersion: '0.0.0', homeDir: root, happyHomeDir: root })), metadataVersion: 1,
                                        daemonState: encodePlainMachineStoredContent({ status: 'running' }), daemonStateVersion: 1,
                                        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                                        installationId: 'installation-a' } } };
                                if (path.startsWith('/v1/account/saved-secrets/'))
                                    return nativeHttp.get(`${secretFixture.origin}${path}`, config);
                                if (path === '/v1/account/entity-rows/prompt-library') return { status: 200,
                                    data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
                                        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
                                            content: key === 'registry-sources' ? { t: 'plain', v: { key,
                                                value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) }) };
                                return previousGet(url, config);
                            });
                            vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) =>
                                new URL(url).pathname.startsWith('/v1/account/saved-secrets/')
                                    ? nativeHttp.post(`${secretFixture.origin}${new URL(url).pathname}`, body, config)
                                    : previousPost(url, body, config));
                            const readContent = (id: string) => {
                                const raw = stored.get(id)?.body;
                                if (typeof raw !== 'string') throw new Error(`Missing persisted Artifact ${id}`);
                                const opened: unknown = decodePlainArtifactStoredContent(raw);
                                if (!opened || typeof opened !== 'object' || !('body' in opened) || typeof opened.body !== 'string')
                                    throw new Error('Expected Artifact body');
                                return JSON.parse(opened.body) as unknown;
                            };
                            const adopt = (reference: Pick<typeof environment.environment,
                                'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>) => {
                                environment.content = DeploymentEnvironmentContentV1Schema.parse(readContent(reference.contentArtifactId));
                                Object.assign(environment.environment, { contentArtifactId: reference.contentArtifactId,
                                    contentHeaderVersion: reference.contentHeaderVersion, contentBodyVersion: reference.contentBodyVersion });
                            };
                            const selectChild = (environmentId: unknown) => {
                                if (typeof environmentId !== 'string') throw new Error('Expected an actual child Environment id');
                                const child = previewEnvironments.get(environmentId);
                                const native = previewNativeStates.get(environmentId);
                                if (!child || !native) throw new Error(`Missing persisted child ${environmentId}`);
                                environment = child;
                                receipt = native.receipt;
                                serving = native.serving;
                                runtimeGrants = native.grants;
                            };
                            vi.spyOn(axios, 'request').mockImplementation(async http => {
                                const path = new URL(http.url ?? serverHttpBaseUrl).pathname;
                                const method = http.method?.toUpperCase();
                                if (path.startsWith('/v1/account/saved-secrets/'))
                                    return nativeHttp.request({ ...http, url: `${secretFixture.origin}${path}` });
                                if (method === 'GET' && path.endsWith('/deployment-defaults')) return { status: 200, data: ProjectDeploymentDefaultsOutputV1Schema.parse({
                                    ok: true, projectSourceId: template.environment.projectSourceId, sourceRevision: 1, revision: 0, content: null }) };
                                if (method === 'GET' && path === `/v1/deployments/environments/${template.environment.id}`)
                                    return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: template.environment,
                                        targetLinks: template.targetLinks.map(row => row.targetLink) }) };
                                if (method === 'POST' && path === '/v1/deployments/environments/access') {
                                    const input = DeploymentEnvironmentAccessInputV1Schema.parse(http.data);
                                    const ids = new Set([template.environment.id, promotionSource.environment.id, ...previewEnvironments.keys()]);
                                    return { status: 200, data: DeploymentEnvironmentAccessResultV1Schema.parse({ ok: true,
                                        items: input.environmentIds.filter(id => ids.has(id))
                                            .map(environmentId => ({ environmentId, read: true, deploy: true })) }) };
                                }
                                if (method === 'GET' && path === '/v1/deployments/environments') {
                                    const parameters = new URL(http.url!).searchParams;
                                    const selector = parameters.get('previewCompanionOfEnvironmentId');
                                    const includeDeleted = parameters.get('includeDeleted') === 'true';
                                    if (!selector) expect(new URL(http.url!).searchParams.get('previewTemplateEnvironmentId'))
                                        .toBe(template.environment.id);
                                    return { status: 200, data: DeploymentEnvironmentListResultV1Schema.parse({ ok: true,
                                        items: [...previewEnvironments.values()].map(child => child.environment)
                                            .filter(header => includeDeleted || header.deletedAtMs === undefined)
                                            .filter(header => selector ? 'previewCompanionOfEnvironmentId' in header
                                                && header.previewCompanionOfEnvironmentId === selector
                                                : header.previewTemplateEnvironmentId === template.environment.id
                                                    && header.previewPullRequestId === '17'), nextCursor: null }) };
                                }
                                const childId = path.match(/^\/v1\/deployments\/environments\/([^/]+)$/)?.[1];
                                const child = childId ? previewEnvironments.get(childId) : undefined;
                                const receiptsEnvironmentId = path.match(/^\/v1\/deployments\/environments\/([^/]+)\/deployments$/)?.[1];
                                if (method === 'GET' && receiptsEnvironmentId) {
                                    const inProgressOnly = new URL(http.url!).searchParams.get('inProgressOnly') === 'true';
                                    const inProgress = new Set(deploymentInProgressStates());
                                    return { status: 200, data: DeploymentReceiptListResultV1Schema.parse({ ok: true,
                                        items: [...previewReceipts.values()].map(saved => saved.deployment)
                                            .filter(header => header.environmentId === receiptsEnvironmentId
                                                && (!inProgressOnly || inProgress.has(header.state))), nextCursor: null }) };
                                }
                                const receiptMatch = path.match(/^\/v1\/deployments\/environments\/([^/]+)\/receipts\/([^/]+)$/);
                                const globalReceiptId = path.match(/^\/v1\/deployments\/receipts\/([^/]+)$/)?.[1];
                                if (method === 'GET' && (receiptMatch || globalReceiptId)) {
                                    const id = globalReceiptId ?? receiptMatch![2]!;
                                    const selected = previewReceipts.get(id)
                                        ?? (id === receipt.deployment.id ? receipt
                                            : id === recoveryCapture?.deployment.id ? recoveryCapture : undefined);
                                    if (!selected || receiptMatch && selected.deployment.environmentId !== receiptMatch[1])
                                        return { status: 404, data: { ok: false, error: 'deployment_unavailable' } };
                                    return { status: 200, data: DeploymentReceiptGetResultV1Schema.parse({ ok: true,
                                        deployment: selected.deployment }) };
                                }
                                if (method === 'GET' && child) return { status: 200,
                                    data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: child.environment,
                                        targetLinks: child.targetLinks.map(row => row.targetLink) }) };
                                if (method === 'POST' && path === '/v1/deployments/environments') {
                                    const created = DeploymentEnvironmentCreateStorageInputV1Schema.parse(http.data);
                                    const companionOf = 'previewCompanionOfEnvironmentId' in created
                                        ? created.previewCompanionOfEnvironmentId : undefined;
                                    if (typeof companionOf === 'string') {
                                        if (scenario === 'public_preview_companion_create_failure')
                                            return { status: 409, data: { ok: false, error: 'deployment_conflict' } };
                                        const main = previewEnvironments.get(companionOf);
                                        if (!main) throw new Error('A companion needs its actual persisted main child');
                                        environment = structuredClone(main);
                                        environment.environment.id = 'preview-companion-environment';
                                        environment.environment.purpose = 'standard';
                                        Object.assign(environment.environment, { previewCompanionOfEnvironmentId: companionOf });
                                        delete environment.environment.previewRepositoryId;
                                        delete environment.environment.previewPullRequestId;
                                        delete environment.environment.previewTargetLinkId;
                                        environment.targetLinks[0]!.targetLink.id = 'preview-companion-runtime';
                                        environment.targetLinks[0]!.targetLink.environmentId = environment.environment.id;
                                        receipt = structuredClone(receipt);
                                        receipt.deployment.environmentId = environment.environment.id;
                                        receipt.deployment.targetLinkId = environment.targetLinks[0]!.targetLink.id;
                                        serving = structuredClone(receipt);
                                        runtimeGrants = [];
                                    }
                                    adopt(created);
                                    environment.environment.purpose = typeof companionOf === 'string' ? 'standard' : 'preview';
                                    environment.environment.protection = created.protection;
                                    environment.environment.revision = 1;
                                    environment.environment.runtimeTargetLinkId = environment.targetLinks[0]!.targetLink.id;
                                    environment.environment.controllerMachineId = created.controllerMachineId;
                                    environment.environment.buildMachineId = created.buildMachineId;
                                    if (!created.preview) throw new Error('Expected the saved preview relationship');
                                    if (typeof companionOf !== 'string') {
                                        environment.environment.previewTemplateEnvironmentId = created.preview.templateEnvironmentId;
                                        environment.environment.previewRepositoryId = 'preview-repository-row';
                                        environment.environment.previewPullRequestId = created.preview.pullRequestId;
                                        environment.environment.previewTargetLinkId = created.preview.runtimeTargetLinkId;
                                    }
                                    if (!created.firstTargetLink) throw new Error('Expected native runtime creation');
                                    const { machines, ...linkReference } = created.firstTargetLink;
                                    Object.assign(environment.targetLinks[0]!.targetLink, linkReference,
                                        { machines: machines.map(member => member.machineId),
                                            members: machines.map(member => ({ ...member, state: 'active' })) });
                                    environment.targetLinks[0]!.content = DeploymentTargetLinkContentV1Schema.parse(readContent(linkReference.contentArtifactId));
                                    delete environment.targetLinks[0]!.targetLink.activeDeploymentId;
                                    previewEnvironments.set(environment.environment.id, environment);
                                    previewNativeStates.set(environment.environment.id, { receipt, serving, grants: runtimeGrants });
                                    return { status: 200, data: DeploymentEnvironmentCreateResultV1Schema.parse({ ok: true, environmentId: environment.environment.id, revision: 1,
                                        runtimeTargetLinkId: environment.environment.runtimeTargetLinkId }) };
                                }
                                if (method === 'POST' && path.endsWith('/secret-launch-admission')) {
                                    const requested = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(http.data);
                                    const grants = previewNativeStates.get(requested.environmentId)?.grants
                                        ?? (requested.environmentId === promotionSource.environment.id ? copySourceGrants : undefined);
                                    if (!grants) throw new Error('Secret admission needs the actual stored Environment');
                                    const installation = { machineId: 'machine-a', installationId: 'installation-a',
                                        publicKey: Buffer.from(installationPublicKey).toString('base64url') };
                                    return { status: 200, data: EnvironmentSecretLaunchAdmissionResultV1Schema.parse({ ok: true, grants,
                                        bindingPreparation: { runtimeInstallations: [installation], buildInstallation: installation } }) };
                                }
                                if (method === 'POST' && path.endsWith('/bindings')) {
                                    const id = path.match(/\/environments\/([^/]+)\/bindings$/)?.[1];
                                    if (id && previewEnvironments.has(id)) selectChild(id);
                                    const bound = DeploymentBindingsSetStorageInputV1Schema.parse(http.data);
                                    if (scenario === 'public_preview_companion_connect_failure'
                                        && environment.environment.purpose === 'preview')
                                        return { status: 409, data: { ok: false, error: 'deployment_conflict' } };
                                    adopt(bound);
                                    runtimeGrants.splice(0, runtimeGrants.length, ...bound.grants);
                                    environment.environment.revision++;
                                    return { status: 200, data: DeploymentBindingsSetResultV1Schema.parse({ ok: true, environmentId: environment.environment.id,
                                        revision: environment.environment.revision }) };
                                }
                                if (method === 'POST' && path.endsWith('/backup')) {
                                    const saved = DeploymentEnvironmentBackupSetInputV1Schema.parse(http.data);
                                    selectChild(saved.environmentId);
                                    expect(saved.expectedRevision).toBe(environment.environment.revision);
                                    adopt(saved);
                                    environment.environment.revision++;
                                    return { status: 200, data: DeploymentEnvironmentUpdateResultV1Schema.parse({ ok: true,
                                        environmentId: environment.environment.id, revision: environment.environment.revision }) };
                                }
                                if (method === 'POST' && path.endsWith('/teardown')) {
                                    const empty = DeploymentTeardownNothingDeployedInputV1Schema.parse(http.data);
                                    selectChild(empty.environmentId);
                                    expect(empty.expectedRevision).toBe(environment.environment.revision);
                                    expect([...previewReceipts.values()].filter(saved => saved.deployment.environmentId === environment.environment.id)).toEqual([]);
                                    environment.environment.revision++;
                                    previewEnvironments.delete(environment.environment.id);
                                    return { status: 200, data: DeploymentTeardownResultV1Schema.parse({ ok: true,
                                        environmentId: environment.environment.id, revision: environment.environment.revision,
                                        nothingDeployed: true, environmentRemoved: true }) };
                                }
                                if (method === 'PATCH' && child) {
                                    selectChild(child.environment.id);
                                    const updated = DeploymentEnvironmentUpdateStorageInputV1Schema.parse(http.data);
                                    adopt(updated);
                                    environment.environment.revision++;
                                    return { status: 200, data: DeploymentEnvironmentUpdateResultV1Schema.parse({ ok: true, environmentId: environment.environment.id,
                                        revision: environment.environment.revision }) };
                                }
                                if (method === 'GET' && path === `/v1/projects/sources/${template.environment.projectSourceId}`)
                                    return previousRequest(http);
                                throw new Error(`Unrepresented preview Home request ${method} ${path}`);
                            });
                            async function readHomeBoundaryFailures() {
                                return (await Promise.all(vi.mocked(axios.request).mock.results.map(async (row, index) => {
                                    if (row.type !== 'return') return null;
                                    try { await row.value; return null; }
                                    catch (error) {
                                        const call = vi.mocked(axios.request).mock.calls[index]?.[0];
                                        const issues: unknown = error && typeof error === 'object' && 'issues' in error ? error.issues : undefined;
                                        return { method: call?.method, path: new URL(call?.url ?? serverHttpBaseUrl).pathname,
                                            errorClass: error instanceof Error ? error.name : 'unknown',
                                            message: error instanceof Error && error.name === 'Error' ? error.message : undefined,
                                            paths: Array.isArray(issues) ? issues.map(issue => issue && typeof issue === 'object'
                                                && 'path' in issue ? issue.path : null) : [] };
                                    }
                                }))).filter(Boolean);
                            }
                            // The template is stored content at the Home boundary; its reader
                            // opens those exact bytes during the ordinary create Action.
                            const parentArtifact = template.environment.contentArtifactId;
                            stored.set(parentArtifact, { id: parentArtifact, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
                                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                                header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Preview template' }),
                                body: encodePlainArtifactStoredContent({ body: JSON.stringify(template.content) }),
                                headerVersion: template.environment.contentHeaderVersion, bodyVersion: template.environment.contentBodyVersion,
                                seq: 1, createdAt: 1, updatedAt: 1 });
                            const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl,
                                snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                                    scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] }, isCurrent: async () => true });
                            const deps = createDaemonDeploymentActionDeps({ ...host, resolveRequesterIdentity, savedSecretOperationContext,
                                async acquirePluginRuntimeRegistryLease() { return mounted.controller.tryAcquireRuntimeRegistry()!; },
                                readBackupOperations: (input, context) => operations.readDeploymentBackupOperations({ target: input, context }),
                                runActionOperation: runCopyOperation });
                            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                                serverId: 'home', machineId: 'machine-a', runActionOperation: runCopyOperation });
                            const actionContext = { ...sourceContext, surface: 'ui' as const, actionCaller: { kind: 'host' as const },
                                machineAdmission: { ...sourceContext.machineAdmission, role: 'manage' as const },
                                serverId: 'home', runtimeAccountId: accountId, signal: caller.signal, executionRunWorkflowRunId: 'preview-copy-run',
                                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
                                    'deployments.environments.create': ['ui'], 'deployments.bindings.set': ['ui'],
                                    'deployments.environments.update': ['ui'], 'deployments.deploy': ['ui'], 'deployments.backups.restore': ['ui'],
                                    [DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1]: ['ui'],
                                } }) };
                            const composed = await resolveDeploymentPreviewWorkflowSourceForHost({
                                templateRef: { serverId: 'home', environmentId: template.environment.id },
                                occurrenceKey: 'preview-copy-open', executor, credentials, serverHttpBaseUrl,
                                contributes: mounted.registry.contributes, signal: caller.signal,
                                event: { id: '17', number: 17, action: 'opened', headSha: git('rev-parse', 'HEAD'),
                                    headRef: 'feature/postgres', baseRef: 'main', baseRepository: repositoryIdentity,
                                    headRepository: repositoryIdentity, author: { id: '19', login: 'contributor', kind: 'human' } },
                            });
                            expect(composed, JSON.stringify(composed)).toMatchObject({ kind: 'available' });
                            if (composed.kind !== 'available') throw new Error(composed.reason);
                            expect(composed.definition.blocks.filter(block => block.kind === 'action'
                                && block.actionId === 'deployments.backups.restore')).toHaveLength(2);
                            const outputs = new Map<string, ReturnType<typeof normalizeStrictJsonValue>>();
                            const values = { inputs: {}, resolveResult: async (producer: { blockId: string }) => {
                                const output = outputs.get(producer.blockId);
                                if (output === undefined) throw new Error(`Missing owner result ${producer.blockId}`);
                                return output;
                            }, resolveWorkspace: async () => { throw new Error('Native preview has no workspace references'); } };
                            const block = (id: string): WorkflowActionLeafV1 => {
                                const selected = composed.definition.blocks.find(block => block.id === id);
                                if (selected?.kind !== 'action') throw new Error(`Missing factory Action ${id}`);
                                return selected;
                            };
                            const operands = async (action: WorkflowActionLeafV1) => Object.fromEntries(await Promise.all(
                                Object.entries(action.input).map(async ([key, value]) => [key, await resolveWorkflowActionFieldBinding(value, values)])));
                            async function readPreviewSource(action: 'synchronize' | 'closed',
                                page: ReturnType<typeof WorkflowInvocationListResultV1Schema.parse>) {
                                const previousSourcePost = axios.post.bind(axios);
                                // Home stores opaque, sealed Run progress. The public reader opens
                                // the exact native outputs captured above through its ordinary codec.
                                vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
                                    if (new URL(url).pathname !== WORKFLOW_RUN_STORAGE_HTTP_PATH)
                                        return previousSourcePost(url, body, config);
                                    expect(body).toMatchObject({ operation: 'invocations.list', runId: 'preview-copy-run', progressEnvelopes: true });
                                    return { status: 200, data: { parentRevision: page.parentRevision, invocations: page.invocations,
                                        keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId: 'preview-copy-run', accountId }),
                                        progressEnvelopesByInvocationId: Object.fromEntries(page.invocationDetails!.map(row => [row.index.id,
                                            serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                                                binding: { v: 1, purpose: 'invocation_progress', accountId, runId: row.index.runId,
                                                    recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
                                                    memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt }, progress: row.progress }))])) } };
                                });
                                const workflowReads = createWorkflowRunActionOwner({
                                    storage: createWorkflowRunStorageClient({ token, serverHttpBaseUrl }), resolveAccountId: async () => accountId,
                                    definitions: { get: async () => { throw new Error('Preview readiness reads immutable Run captures only'); } },
                                    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
                                });
                                const sourceExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                                    serverId: 'home', machineId: 'machine-a', workflowAction: async request => {
                                        if (request.actionId !== 'workflow.run.invocations.list') throw new Error('Unexpected preview Run write');
                                        return workflowReads.execute({ actionId: request.actionId,
                                            input: WorkflowActionInputSchemasV1[request.actionId].parse(request.input), context: request.context });
                                    } });
                                return resolveDeploymentPreviewWorkflowSourceForHost({
                                    templateRef: { serverId: 'home', environmentId: template.environment.id },
                                    occurrenceKey: `preview-copy-source-${action}`, executor: sourceExecutor, credentials, serverHttpBaseUrl,
                                    contributes: mounted.registry.contributes, signal: caller.signal,
                                    event: { id: '17', number: 17, action, headSha: git('rev-parse', 'HEAD'),
                                        headRef: 'feature/postgres', baseRef: 'main', baseRepository: repositoryIdentity, headRepository: repositoryIdentity,
                                        author: { id: '19', login: 'contributor', kind: 'human' } },
                                });
                            }
                            async function closePreviewChildren(page: ReturnType<typeof WorkflowInvocationListResultV1Schema.parse>,
                                nativeReceipts: readonly OwnServerDeploymentReceipt[]) {
                                phase('preview-close-source');
                                const closing = await readPreviewSource('closed', page);
                                expect(closing, JSON.stringify(closing)).toMatchObject({ kind: 'available' });
                                if (closing.kind !== 'available') throw new Error(closing.reason);
                                const close = closing.definition;
                                const closedIds: string[] = [];
                                for (const closeAction of close?.blocks ?? []) {
                                    if (closeAction.kind !== 'action' || closeAction.actionId !== 'deployments.teardown')
                                        throw new Error('Expected ordinary native close Actions');
                                    const closeInput = DeploymentTeardownRequestInputV1Schema.parse(await operands(closeAction));
                                    phase(`preview-close-${closeInput.environmentId}-prepare`);
                                    selectChild(closeInput.environmentId);
                                    const deployed = nativeReceipts.find(saved => saved.deployment.environmentId === environment.environment.id
                                        && saved.content.ownServer?.previewCleanup)?.content.ownServer?.previewCleanup;
                                    expect(closeInput.volumes).toEqual(deployed?.volumes);
                                    let candidate: ReturnType<typeof DeploymentOwnServerContentV1Schema.parse> | undefined;
                                    const teardown = createOwnServerTeardownForHost({ ...host,
                                        readBuildHistory: () => (async function* () {
                                            for (const saved of [...nativeReceipts].reverse())
                                                if (saved.deployment.environmentId === environment.environment.id) yield saved;
                                        })(), findReceipt: async () => null,
                                        createCandidate: async (selectedEnvironment, content) => {
                                            candidate = DeploymentOwnServerContentV1Schema.parse(content);
                                            const id = `preview-teardown-${selectedEnvironment.environment.id}`;
                                            stored.set(id, { id, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
                                                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                                                header: encodePlainArtifactStoredContent(createDeploymentReceiptArtifactHeaderV1(
                                                    selectedEnvironment.content.name, candidate)),
                                                body: encodePlainArtifactStoredContent({ body: JSON.stringify(candidate) }),
                                                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                                            return { contentArtifactId: id,
                                                contentHeaderVersion: 1, contentBodyVersion: 1 };
                                        } });
                                    const prepared = await teardown.prepare({ input: closeInput, context: actionContext });
                                    expect(prepared, JSON.stringify(prepared)).not.toHaveProperty('errorCode');
                                    if ('input' in prepared && 'nothingDeployed' in prepared.input) {
                                        expect(nativeReceipts.filter(saved => saved.deployment.environmentId === environment.environment.id)).toEqual([]);
                                        const removed = await deps.deploymentAction!(closeAction.actionId, prepared.input, actionContext);
                                        expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true,
                                            nothingDeployed: true, environmentRemoved: true });
                                        outputs.set(closeAction.id, normalizeStrictJsonValue(removed));
                                        closedIds.push(environment.environment.id);
                                        continue;
                                    }
                                    if (!('input' in prepared) || !('contentArtifactId' in prepared.input) || !candidate)
                                        throw new Error('Expected canonical native teardown preparation');
                                    expect(await teardown.admit(environment, environment.targetLinks[0]!.targetLink.id,
                                        candidate, prepared.input, actionContext)).toBeNull();
                                    receipt.content = candidate;
                                    receipt.deployment = { ...receipt.deployment, id: `preview-close-${environment.environment.id}`,
                                        actionOperationId: `preview-close-operation-${environment.environment.id}`, operation: 'teardown',
                                        revision: 1, state: 'queued', contentArtifactId: prepared.input.contentArtifactId,
                                        contentHeaderVersion: 1, contentBodyVersion: 1 };
                                    phase(`preview-close-${environment.environment.id}-execute`);
                                    const closed = await trackCopyEffect(teardown.execute({ actionId: 'deployments.teardown', input: prepared.input,
                                        receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                                            deploymentId: receipt.deployment.id, deploymentRevision: 1, state: 'queued' },
                                        context: { ...actionContext, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } }));
                                    expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true, state: 'succeeded' });
                                    outputs.set(closeAction.id, normalizeStrictJsonValue(closed));
                                    closedIds.push(environment.environment.id);
                                    phase(`preview-close-${environment.environment.id}-succeeded`);
                                }
                                return closedIds;
                            }
                            const create = block('preview-create');
                            phase('preview-main-create');
                            if (scenario !== 'public_preview_configure_failure')
                                await boundary.setRepositoryMissing('s3:https://fixture.invalid/destination-safety');
                            if (scenario === 'public_preview_configure_failure') await boundary.setRepositoryConfigExitCode(12);
                            const created = await executor.execute(create.actionId, await operands(create),
                                { ...actionContext, actionRequestId: 'native-preview-create' });
                            // The exact PR repository owns both services. Catalog selection
                            // supplies fresh bindings and metadata without another Compose source.
                            if (!previewCompanion || created.ok) expect(environment.content.definition).toEqual({
                                ...template.content.definition, ref: git('rev-parse', 'HEAD') });
                            const mainEnvironmentId = environment.environment.id;
                            if (scenario === 'public_preview_configure_failure') {
                                expect(created, JSON.stringify(created)).toMatchObject({ ok: false, errorCode: 'backup_required', effectAttempted: true,
                                    details: { environmentId: environment.environment.id, configurationResult: { kind: 'tested', test: {
                                        kind: 'failed', reason: 'repository_password_incorrect', nativeExitCode: 12, remedy: 'review_credentials',
                                    } } } });
                                expect(environment.content.backup).toBeUndefined();
                                expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toEqual([]);
                                return;
                            }
                            expect(created, JSON.stringify({ created, generatedSecretCount: secretFixture.writes.length,
                                childPersisted: environment.environment.purpose === 'preview', revision: environment.environment.revision }))
                                .toMatchObject({ ok: true, result: previewCompanion ? { previewCompanionRequired: true }
                                    : { previewNativeData: [{ service: 'database', database: 'app' }] } });
                            if (!created.ok) throw new Error('Expected real preview child creation');
                            phase('preview-main-created');
                            outputs.set(create.id, normalizeStrictJsonValue(created.result));
                            const creationInvocations: ReturnType<typeof makeInvocation>[] = [];
                            if (previewCompanion) {
                                creationInvocations.push(makeInvocation(create, await operands(create), created.result, 0));
                                const companion = block('preview-data-create');
                                phase('preview-companion-create');
                                const companionInput = await operands(companion);
                                expect(companionInput).toMatchObject({ purpose: 'standard', protection: 'nonProduction',
                                    previewCompanionOfEnvironmentId: mainEnvironmentId });
                                const companionCreated = await executor.execute(companion.actionId, companionInput,
                                    { ...actionContext, actionRequestId: 'native-preview-companion-create' });
                                const boundaryFailures = await readHomeBoundaryFailures();
                                const companionDiagnostic = JSON.stringify({ result: companionCreated,
                                    boundaryFailures,
                                    main: previewEnvironments.get(mainEnvironmentId)?.environment,
                                    artifactVersions: [...stored].map(([id, row]) => ({ id,
                                        headerVersion: row.headerVersion, bodyVersion: row.bodyVersion })),
                                    readPaths: vi.mocked(axios.get).mock.calls.slice(-12).map(([url]) => new URL(String(url)).pathname) });
                                if (scenario === 'public_preview_companion_create_failure') {
                                    expect(companionCreated, companionDiagnostic).toMatchObject({ ok: false,
                                        errorCode: 'deployment_conflict' });
                                    expect([...previewEnvironments.keys()]).toEqual([mainEnvironmentId]);
                                    expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toEqual([]);
                                    await docker.seedVolume('template-postgres-data', 'template-project');
                                    const mainCreatedCapture = makeInvocation(create, await operands(create), created.result, 0);
                                    const page = WorkflowInvocationListResultV1Schema.parse({ parentRevision: 1,
                                        invocations: [mainCreatedCapture.index], invocationDetails: [mainCreatedCapture] });
                                    expect(await closePreviewChildren(page, [])).toEqual([mainEnvironmentId]);
                                    expect(await docker.readVolumeNames()).toEqual(['template-postgres-data']);
                                    expect(promotionSource.targetLinks[0]!.targetLink.activeDeploymentId).toBe('source-current-release');
                                    expect(recoveryCapture.content.ownServer?.preMigrationBackup).toEqual(recordedCapture);
                                    return;
                                }
                                expect(companionCreated, companionDiagnostic).toMatchObject({ ok: true,
                                    result: { previewNativeData: [{ service: 'database', database: 'app' }],
                                        previewNativeBindings: expect.arrayContaining(['DB_HOST', 'DB_PORT'].map(name =>
                                            expect.objectContaining({ purpose: 'variable', name,
                                                source: expect.objectContaining({ kind: 'reference', environmentId: environment.environment.id }) }))) } });
                                if (!companionCreated.ok) throw new Error('Expected real catalog companion creation');
                                phase('preview-companion-created');
                                outputs.set(companion.id, normalizeStrictJsonValue(companionCreated.result));
                                creationInvocations.push(makeInvocation(companion, companionInput,
                                    companionCreated.result, creationInvocations.length));
                                expect(environment.content.definition.kind).toBe('stored');
                                expect(previewEnvironments.get(mainEnvironmentId)?.content.definition).toEqual({
                                    ...template.content.definition, ref: git('rev-parse', 'HEAD') });
                            }
                            const initializedRepositories = (JSON.parse(await readFile(boundary.stateFile, 'utf8')) as {
                                initializedRepositories?: string[];
                            }).initializedRepositories;
                            expect(initializedRepositories).toHaveLength(1);
                            const expectedRepositoryPrefix = `previews/${environment.environment.id}`;
                            expect(initializedRepositories![0]).not.toBe(recordedCapture.repository.repository);
                            expect(secretFixture.writes).toHaveLength(1);
                            expect(environment.content.template?.data).toMatchObject([{ engine: 'postgres', service: 'database' }]);
                            expect(environment.content.definition.kind).toBe(previewCompanion ? 'stored' : 'repository');
                            expect(environment.content.previewCreationRunId).toBe('preview-copy-run');
                            const nativeSource = await parseNativeComposeSource(environment.content.definition.kind === 'stored'
                                ? environment.content.definition.document : await readFile(join(repository, 'compose.yaml'), 'utf8'));
                            const pgService = environment.content.template?.data?.[0]?.service;
                            const sourceService = pgService && isRecord(nativeSource.services) ? nativeSource.services[pgService] : undefined;
                            if (!isRecord(sourceService) || typeof sourceService.image !== 'string')
                                throw new Error('The actual generated PostgreSQL service needs its registry image');
                            await docker.registerImage(pgService!, 'postgres17', { registryReferences: [sourceService.image] });
                            const nativeReceipts: OwnServerDeploymentReceipt[] = [];
                            const executeNative = async (action: WorkflowActionLeafV1, deploymentId: string) => {
                                phase(`${deploymentId}-prepare`);
                                if (action.actionId !== 'deployments.deploy') throw new Error('Expected native deployment Action');
                                const authored = await operands(action);
                                selectChild(authored.environmentId);
                                const prepared = await deps.prepareDeploymentAction!({ actionId: action.actionId, input: authored, context: actionContext });
                                if ('errorCode' in prepared) throw new Error(JSON.stringify({ prepared,
                                    boundaryFailures: await readHomeBoundaryFailures(), nativeFailures: await docker.readFailures(),
                                    nativeCommands: (await docker.readInvocations()).slice(-8).map(call => ({ command: call.args[0],
                                        operation: call.args[0] === 'compose' ? ['config', 'create', 'up', 'start'].find(value => call.args.includes(value))
                                            : call.args[1] })) }));
                                const deployInput = DeploymentActionInputSchemasV1['deployments.deploy'].parse(prepared.input);
                                receipt.content = DeploymentOwnServerContentV1Schema.parse(readContent(deployInput.contentArtifactId));
                                receipt.deployment = { ...receipt.deployment, id: deploymentId, actionOperationId: `${deploymentId}-operation`,
                                    contentArtifactId: deployInput.contentArtifactId, contentHeaderVersion: deployInput.contentHeaderVersion,
                                    contentBodyVersion: deployInput.contentBodyVersion, revision: 1, state: 'queued' };
                                request = { ...request, input: deployInput,
                                    receipt: { ...request.receipt, environmentId: environment.environment.id,
                                        revision: environment.environment.revision, deploymentId, deploymentRevision: 1, state: 'queued' },
                                    context: { ...actionContext, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                                phase(`${deploymentId}-execute`);
                                const result = await trackCopyEffect(target.execute(request));
                                expect(result, JSON.stringify({ result, nativeFailures: await docker.readFailures(),
                                    boundaryFailures: await readHomeBoundaryFailures() })).toMatchObject({ ok: true, state: 'succeeded' });
                                if (!result.ok || !('state' in result) || result.state !== 'succeeded') throw new Error('Expected native deployment');
                                Object.assign(serving, structuredClone(receipt));
                                previewReceipts.set(receipt.deployment.id, structuredClone(receipt));
                                nativeReceipts.push(structuredClone(receipt));
                                outputs.set(action.id, normalizeStrictJsonValue(result));
                                phase(`${deploymentId}-succeeded`);
                                return { input: authored, result };
                            };
                            const provision = block(previewCompanion ? 'preview-data-companion-provision' : 'preview-data-provision');
                            expect((await operands(provision)).services).toEqual(['database']);
                            const provisioned = await executeNative(provision, 'preview-postgres-release');
                            expect(receipt.content.services).toEqual(['database']);
                            expect(receipt.content.ownServer?.previewCleanup?.volumes).toHaveLength(1);
                            expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
                            expect(execFileSync(process.execPath, [docker.executablePath, 'ps', '--filter',
                                'label=com.docker.compose.service=app'], { encoding: 'utf8' }).trim()).toBe('');
                            const currentAction = block('preview-data-current');
                            const current = await executor.execute(currentAction.actionId, await operands(currentAction),
                                { ...actionContext, actionRequestId: 'native-preview-current' });
                            expect(current, JSON.stringify(current)).toMatchObject({ ok: true });
                            if (!current.ok) throw new Error('Expected the public current Environment reader');
                            outputs.set(currentAction.id, normalizeStrictJsonValue(current.result));
                            const provisionedPostgres = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                            await writeFile(boundary.stateFile, JSON.stringify({ ...provisionedPostgres, names: ['app'] }));
                            let restoreFailure: unknown;
                            const restore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine-a',
                                async assertCurrent() { caller.signal.throwIfAborted(); },
                                // Transparent observation keeps the real native owner and its failure intact.
                                async restore(input) {
                                    try { return await target.restore(input); }
                                    catch (error) {
                                        const value = isRecord(error) ? error : {};
                                        const details = isRecord(value.details) ? value.details : {};
                                        restoreFailure = { errorClass: error instanceof Error ? error.name : 'unknown',
                                            code: value.code, reason: details.reason };
                                        throw error;
                                    }
                                },
                                readBackupOperations: (target, context) => operations.readDeploymentBackupOperations({ target, context }),
                                readPreparation: (operationId, context) => operations.readRestorePreparation({ operationId, context }) });
                            const restoreExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), serverId: 'home', machineId: 'machine-a',
                                resolveEnvironmentApprovalScope: deps.resolveEnvironmentApprovalScope,
                                deploymentRestore: restore, runActionOperation: runCopyOperation });
                            const prepareCopy = block('preview-copy-0-prepare');
                            const restoreInput = await operands(prepareCopy);
                            expect(restoreInput.source).toMatchObject({ kind: 'repository', origin: { environmentId: promotionSource.environment.id,
                                targetLinkId: promotionSource.targetLinks[0]!.targetLink.id } });
                            expect(restoreInput.destination).toEqual({ kind: 'database', service: 'database', database: 'app' });
                            phase('preview-copy-prepare');
                            const preparation = await restoreExecutor.execute(prepareCopy.actionId, restoreInput,
                                { ...actionContext, actionRequestId: 'native-preview-copy-prepare' });
                            const restoreEvents = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean)
                                .map(line => JSON.parse(line) as { kind: string; argv?: string[]; fixtureCode?: string });
                            expect(preparation, JSON.stringify({ preparation, restoreFailure,
                                boundaryFailures: await readHomeBoundaryFailures(), nativeFailures: await docker.readFailures(),
                                restoreEvents: restoreEvents.slice(-12).map(event => ({ kind: event.kind,
                                    command: event.argv?.[0], fixtureCode: event.fixtureCode })) }))
                                .toMatchObject({ ok: true, result: { kind: 'prepared' } });
                            if (!preparation.ok) throw new Error('Expected preview copy preparation');
                            phase('preview-copy-prepared');
                            outputs.set(prepareCopy.id, normalizeStrictJsonValue(preparation.result));
                            if (scenario === 'public_preview_copy_failure') {
                                const state = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                                await writeFile(boundary.stateFile, JSON.stringify({ ...state, mode: 'failure' }));
                            }
                            const confirm = block('preview-copy-0-confirm');
                            phase('preview-copy-confirm');
                            const restored = await restoreExecutor.execute(confirm.actionId, await operands(confirm),
                                { ...actionContext, actionRequestId: 'native-preview-copy-confirm' });
                            expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
                            if (!restored.ok) throw new Error('Expected typed native restore result');
                            phase('preview-copy-confirmed');
                            outputs.set(confirm.id, normalizeStrictJsonValue(restored.result));
                            const full = block('preview-deploy');
                            if (!full.onlyWhen) throw new Error('Factory must guard the app behind verified copy');
                            let mayDeployApp = await evaluateWorkflowCondition(full.onlyWhen, values);
                            expect(mayDeployApp).toBe(scenario !== 'public_preview_copy_failure');
                            let connectionInvocation: ReturnType<typeof makeInvocation> | undefined;
                            if (previewCompanion) {
                                const connectCurrent = block('preview-data-connect-current');
                                const currentMain = await executor.execute(connectCurrent.actionId, await operands(connectCurrent),
                                    { ...actionContext, actionRequestId: 'native-preview-connect-current' });
                                expect(currentMain, JSON.stringify(currentMain)).toMatchObject({ ok: true });
                                if (!currentMain.ok) throw new Error('Expected current main revision before companion connection');
                                outputs.set(connectCurrent.id, normalizeStrictJsonValue(currentMain.result));
                                const connect = block('preview-data-connect');
                                const connectInput = await operands(connect);
                                selectChild(connectInput.environmentId);
                                const connected = await executor.execute(connect.actionId, connectInput,
                                    { ...actionContext, actionRequestId: 'native-preview-connect' });
                                if (scenario === 'public_preview_companion_connect_failure') {
                                    expect(connected, JSON.stringify(connected)).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
                                    // A failed public Action stops this sequential invocation; later Source sync
                                    // must independently refuse the copied but unconnected child.
                                    mayDeployApp = false;
                                } else {
                                    expect(connected, JSON.stringify(connected)).toMatchObject({ ok: true });
                                    if (!connected.ok) throw new Error('Expected ordinary companion reference binding');
                                    outputs.set(connect.id, normalizeStrictJsonValue(connected.result));
                                    connectionInvocation = makeInvocation(connect, connectInput, connected.result, creationInvocations.length + 2);
                                    expect(environment.environment.id).toBe(mainEnvironmentId);
                                    expect(environment.content.bindings).toEqual(expect.arrayContaining(['DB_HOST', 'DB_PORT'].map(name =>
                                        expect.objectContaining({ purpose: 'variable', name, source: expect.objectContaining({ kind: 'reference',
                                            environmentId: 'preview-companion-environment' }) }))));
                                }
                            }
                            if (mayDeployApp) await executeNative(full, 'preview-app-release');
                            if (previewCompanion && mayDeployApp) {
                                expect(previewForwardBindings.length).toBeGreaterThan(0);
                                expect(previewForwardBindings.every(binding => binding.environmentId === 'preview-companion-environment'
                                    && binding.port > 0)).toBe(true);
                            }
                            const copiedDatabase = JSON.parse(await readFile(boundary.stateFile, 'utf8')) as {
                                names: string[]; importedBytes?: number;
                            };
                            expect(copiedDatabase.names).toContain('app');
                            expect(copiedDatabase.importedBytes).toBe(archive.length);
                            expect(await docker.readVolumeNames()).toEqual(provisioned.result.previewCleanup!.volumes.map(volume => volume.name));
                            const runningDatabaseIds = execFileSync(process.execPath, [docker.executablePath, 'ps', '--filter',
                                'label=com.docker.compose.service=database'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
                            const runningDatabases = JSON.parse(execFileSync(process.execPath, [docker.executablePath,
                                'inspect', '--type', 'container', ...runningDatabaseIds], { encoding: 'utf8' })) as Array<{
                                    Mounts: Array<{ Type: string; Name: string; Destination: string }>;
                                }>;
                            expect(runningDatabases).toHaveLength(1);
                            expect(runningDatabases[0]!.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name))
                                .toEqual(provisioned.result.previewCleanup!.volumes.map(volume => volume.name));
                            const activations = (await docker.readInvocations()).filter(call => call.args.includes('up'));
                            expect(activations).toHaveLength(mayDeployApp ? 2 : 1);
                            expect(promotionSource.targetLinks[0]!.targetLink.activeDeploymentId).toBe('source-current-release');
                            const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean)
                                .map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                            expect(events.filter(event => event.kind === 'safetyBytes')).toHaveLength(1);
                            expect(events.findIndex(event => event.kind === 'safetyBytes'))
                                .toBeLessThan(events.findIndex(event => event.kind === 'imported'));
                            expect(events.filter(event => event.kind === 'restic' && event.argv?.includes(recordedCapture.repository.repository))
                                .every(event => !event.argv?.includes('backup'))).toBe(true);
                            expect(recoveryCapture.content.ownServer?.preMigrationBackup).toEqual(recordedCapture);
                            expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).archive).toBe(archive.toString('base64'));
                            function makeInvocation(action: WorkflowActionLeafV1, input: unknown, result: unknown, ordinal: number) {
                                const captured = prepareWorkflowDeploymentResultCapture(action.actionId)?.(normalizeStrictJsonValue(result));
                                if (!captured) throw new Error('Expected the actual immutable Action capture');
                                const index = { id: `native-preview-invocation-${ordinal}`, runId: 'preview-copy-run', sequence: String(ordinal),
                                    parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'completed',
                                    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:01.000Z' };
                                return { index, parentRevision: 1, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action',
                                    invocationPath: { blockId: action.id, scope: [] }, attempt: '0', logicalInvocationRecordId: index.id,
                                    execution: { kind: 'action', actionId: action.actionId, actionRequestId: `${action.id}-request`,
                                        localInputId: action.id, input, output: captured } } };
                            }
                            const capturedInvocations = [...creationInvocations,
                                makeInvocation(provision, provisioned.input, provisioned.result, creationInvocations.length),
                                makeInvocation(confirm, await operands(confirm), restored.result, creationInvocations.length + 1),
                                ...(connectionInvocation ? [connectionInvocation] : [])];
                            const page = WorkflowInvocationListResultV1Schema.parse({ parentRevision: 1,
                                invocations: capturedInvocations.map(row => row.index), invocationDetails: capturedInvocations });
                            const synchronized = await readPreviewSource('synchronize', page);
                            phase('preview-synchronized');
                            expect(synchronized, JSON.stringify(synchronized)).toMatchObject(mayDeployApp
                                ? { kind: 'available' } : { kind: 'refused', reason: 'restore_prepare_required' });
                            const cleanup = provisioned.result.previewCleanup;
                            if (!cleanup || cleanup.volumes.length !== 1) throw new Error('Expected exact provisioned PostgreSQL volume');
                            const pgVolume = cleanup.volumes[0]!.name;
                            await docker.seedVolume('template-postgres-data', 'template-project');
                            if (scenario === 'public_preview_companion_main_deleted')
                                previewEnvironments.get(mainEnvironmentId)!.environment.deletedAtMs = Date.now();
                            expect(await closePreviewChildren(page, nativeReceipts)).toEqual(
                                scenario === 'public_preview_companion_main_deleted' ? ['preview-companion-environment']
                                    : previewCompanion ? ['preview-companion-environment', mainEnvironmentId] : [mainEnvironmentId]);
                            expect(await docker.readVolumeNames()).not.toContain(pgVolume);
                            expect(await docker.readVolumeNames()).toContain('template-postgres-data');
                            expect(promotionSource.targetLinks[0]!.targetLink.activeDeploymentId).toBe('source-current-release');
                            expect(initializedRepositories![0]).toContain(expectedRepositoryPrefix);
                            return;
                        } finally { await secretFixture.close(); }
                    }
                    const deploymentRestore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine-a',
                        async assertCurrent() { caller.signal.throwIfAborted(); }, restore: target.restore,
                        readBackupOperations: (target, context) => {
                            expect(target).toMatchObject({ environmentId: promotionSource.environment.id,
                                targetLinkId: promotionSource.targetLinks[0].targetLink.id, machineId: 'machine-a',
                                installationId: 'installation-a', deploymentId: 'source-capture' });
                            return operations.readDeploymentBackupOperations({ target, context });
                        },
                        readPreparation: (operationId, context) => operations.readRestorePreparation({ operationId, context }) });
                    const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: async () => null,
                        resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                        async dispatchReceipt() { throw new Error('Copy must not allocate a deployment receipt'); } });
                    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), serverId: 'home', machineId: 'machine-a',
                        resolveEnvironmentApprovalScope: storage.resolveEnvironmentApprovalScope,
                        deploymentRestore, runActionOperation: value => operations.runActionOperation(value) });
                    const actionContext = { ...sourceContext, surface: 'ui' as const, actionCaller: { kind: 'host' as const },
                        serverId: 'home', runtimeAccountId: accountId,
                        actionsSettings: setScopedActionApprovalPreference({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
                            actionId: 'deployments.backups.restore', scope: { kind: 'environment', environmentId: environment.environment.id },
                            surface: 'ui', mode: 'waived' }) };
                    const restoreInput = { mode: 'prepare' as const, serverId: 'home', environmentId: environment.environment.id,
                        machineId: 'machine-a', installationId: 'installation-a', targetLinkId: environment.targetLinks[0].targetLink.id,
                        deploymentId: recoveryCapture.deployment.id,
                        source: { kind: 'repository' as const, snapshotId: recordedCapture.source.snapshot.snapshotId,
                            backupOperationId: produced.operationId, origin: { environmentId: promotionSource.environment.id,
                                targetLinkId: promotionSource.targetLinks[0].targetLink.id } },
                        expectedRevision: environment.environment.revision,
                        destination: { kind: 'database' as const, service: 'app', database: destinationDatabase } };
                    const pointer = environment.targetLinks[0].targetLink.activeDeploymentId;
                    const beforeTransitions = transitionWrites;
                    const beforeDeploys = (await docker.readInvocations()).filter(call => call.args.includes('up')).length;
                    const destinationState = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                    await writeFile(boundary.stateFile, JSON.stringify({ ...destinationState, names: [destinationDatabase] }));
                    if (scenario !== 'public_restore_drill') {
                        const beforeUnconfigured = await readFile(boundary.eventsFile, 'utf8');
                        expect(await executor.execute('deployments.backups.restore', restoreInput,
                            { ...actionContext, actionRequestId: 'public-copy-unconfigured-prepare' }))
                            .toMatchObject({ ok: false, errorCode: 'backup_required' });
                        const unconfiguredEvents = (await readFile(boundary.eventsFile, 'utf8')).slice(beforeUnconfigured.length)
                            .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                        expect(unconfiguredEvents.filter(event => event.kind === 'safetyBytes'
                            || event.kind === 'restic' && event.argv?.includes('backup'))).toHaveLength(0);
                    }
                    environment.content = DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
                        template: { templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['app'],
                            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
                            data: { engine: 'postgres', service: 'app', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } } },
                        backup: { ...recordedCapture.configuration,
                            destinationRef: { pluginId: 'happier.backup.destinations', localId: 's3' },
                            occurrenceId: mounted.registry.readPluginOccurrenceId('happier.backup.destinations'),
                            config: { endpoint: 'https://fixture.invalid', bucket: 'destination-safety', prefix: '' },
                            sources: [{ kind: 'dump', sourceId: 'destination-database', service: 'app', consistency: 'logical' }],
                            ownership: { environmentId: environment.environment.id, prefix: environment.environment.id } } });
                    if (scenario !== 'public_restore_drill') {
                        const preparation = await executor.execute('deployments.backups.restore', restoreInput,
                            { ...actionContext, actionRequestId: 'public-copy-prepare' });
                        expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                        if (!preparation.ok) throw new Error('Expected public copy preparation');
                        const prepared = DeploymentBackupRestoreResultV1Schema.parse(preparation.result);
                        if (prepared.kind !== 'prepared') throw new Error('Expected public copy preparation evidence');
                        expect(prepared.evidence).toMatchObject({ native: { prepared: { source: recordedCapture.source,
                            repository: recordedCapture.repository, destination: { environmentId: environment.environment.id,
                                database: destinationDatabase, databaseExists: true, hasMeaningfulData: true },
                            safetyBackup: { kind: 'verified', manifests: [expect.objectContaining({ environmentId: environment.environment.id })] } },
                            configuration: recordedCapture.configuration } });
                        const result = await executor.execute('deployments.backups.restore', { ...restoreInput,
                            mode: 'confirm', prepareOperationId: prepared.operationId },
                            { ...actionContext, actionRequestId: 'public-copy-confirm' });
                        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'restored', verified: true } });
                        expect(copySourceAdmissions).toBeGreaterThan(0);
                        const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n')
                            .filter(Boolean).map(line => JSON.parse(line) as { kind: string; argv?: string[] });
                        expect(events.filter(event => event.kind === 'safetyBytes')).toHaveLength(1);
                        const repositoryReads = events.filter(event => event.kind === 'restic'
                            && event.argv?.includes(recordedCapture.repository.repository));
                        expect(repositoryReads.length).toBeGreaterThan(0);
                        for (const event of repositoryReads) {
                            expect(event.argv).toContain(recordedCapture.repository.repository);
                            expect(event.argv).not.toContain('backup');
                        }
                        const destinationRepository = 's3:https://fixture.invalid/destination-safety';
                        const destinationWrites = events.filter(event => event.kind === 'restic'
                            && event.argv?.includes(destinationRepository) && event.argv.includes('backup'));
                        expect(destinationWrites).toHaveLength(1);
                        expect(events.filter(event => event.kind === 'postgres' && event.argv?.[0] === 'pg_restore'
                            && !event.argv.includes('--version'))).toHaveLength(1);
                        expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).names).toContain(destinationDatabase);
                        expect(environment.targetLinks[0].targetLink.activeDeploymentId).toBe(pointer);
                        expect(promotionSource.targetLinks[0].targetLink.activeDeploymentId).toBe('source-current-release');
                        expect(transitionWrites).toBe(beforeTransitions);
                        expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(beforeDeploys);
                    }
                    if (scenario === 'public_restore_drill') {
                        phase('drill-source-current-start');
                        const destinationEnvironment = environment;
                        const destinationReceipt = receipt;
                        const sourceDocument = JSON.stringify({ services: { app: { image: image.registryReference,
                            environment: { DEPLOY_PASSWORD: '${DEPLOY_PASSWORD:?required}' } } } });
                        promotionSource.content.definition = { kind: 'stored', document: sourceDocument, contentRevision: 1,
                            composeDigest: `sha256:${createHash('sha256').update(sourceDocument).digest('hex')}`, profiles: [], services: ['app'] };
                        promotionSource.content.bindings.push(structuredClone(secretBinding));
                        copySourceGrants.push(sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: 'machine-a',
                            installationId: 'installation-a', environmentId: promotionSource.environment.id,
                            resourceId: 'review-secret', resourceRevision: 1 }, installationPublicKey,
                            content: { kind: 'secret', value: 'review-secret-value-sentinel' } }));
                        try {
                            environment = promotionSource;
                            receipt = structuredClone(serving);
                            receipt.deployment = { ...receipt.deployment, id: 'source-current-release',
                                environmentId: promotionSource.environment.id, targetLinkId: promotionSource.targetLinks[0].targetLink.id,
                                contentArtifactId: 'source-current-content', actionOperationId: 'source-current-operation', state: 'running' };
                            receipt.content = { ...receipt.content, sourceIntent: promotionSource.content.definition, ownServer: undefined };
                            previewReceipts.set(receipt.deployment.id, receipt);
                            const sourceRequest = { ...originalRequest, input: { ...originalRequest.input,
                                environmentId: promotionSource.environment.id, targetLinkId: promotionSource.targetLinks[0].targetLink.id,
                                deploymentId: receipt.deployment.id, contentArtifactId: receipt.deployment.contentArtifactId },
                                receipt: { ...originalRequest.receipt, deploymentId: receipt.deployment.id,
                                    contentArtifactId: receipt.deployment.contentArtifactId },
                                context: { ...originalRequest.context, operationAcceptance: {
                                    operationId: receipt.deployment.actionOperationId, accept() {} } } };
                            const sourceReview = await target.review({ actionId: sourceRequest.actionId, input: sourceRequest.input,
                                content: receipt.content, context: sourceContext });
                            phase('drill-source-current-reviewed');
                            receipt.content.ownServer = { approvedInputBasis: sourceReview.inputBasis };
                            const activatedSource = await target.executeMember({ request: sourceRequest, machineId: 'machine-a',
                                installationId: 'installation-a', phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                            expect(activatedSource, JSON.stringify(activatedSource)).toMatchObject({ ok: true });
                            phase('drill-source-current-activated');
                            previewReceipts.set(receipt.deployment.id, structuredClone(receipt));
                        } finally { environment = destinationEnvironment; receipt = destinationReceipt; }
                        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
                        const admission = createCliProjectAdmission({ credentials, serverId: 'home', serverHttpBaseUrl }, {
                            projectHomeId: 'home', actionHomeId: 'home', executionRunActionFailure: fail,
                        });
                        const serviceRuntime = createMachineServicesRuntime({ target: { serverId: 'home', machineId: 'machine-a' },
                            readMetadata() { throw new Error('An exact Environment list does not read Machine adoption intent'); },
                            captureMetadataPort() { throw new Error('Drills do not change Machine adoption intent'); } });
                        const machine = createCliMachineResourceActionDeps({ credentials, token, serverIdentityId: 'home', serverHttpBaseUrl,
                            machineActionDirectTargetTransport: { machineId: 'machine-a', machineServiceAction: value => serviceRuntime.execute(value),
                                async invoke() { throw new Error('The local drill must use the mounted native service owner'); } },
                        }, { ...admission, projectHomeId: 'home', readEnvironmentAccess: storage.readEnvironmentAccess,
                            observeEnvironmentAccessChanges: storage.observeEnvironmentAccessChanges,
                            async callMachineAction() { throw new Error('The retained drill never forwards to another Machine'); },
                            executionRunActionFailure: fail });
                        const backup = createDeploymentBackupActionForHost({ serverId: 'home', machineId: 'machine-a',
                            async assertCurrent() { caller.signal.throwIfAborted(); }, backup: target.backup,
                            readBackupOperations: (target, context) => operations.readDeploymentBackupOperations({ target, context }) });
                        const query = createDeploymentDataQueryActionForHost({ ...host, credentials, serverHttpBaseUrl,
                            async assertCurrent() { caller.signal.throwIfAborted(); } });
                        const drillExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...machine,
                            serverId: 'home', machineId: 'machine-a', resolveEnvironmentApprovalScope: storage.resolveEnvironmentApprovalScope,
                            deploymentRestore, deploymentBackupAction: backup,
                            deploymentAction: async (actionId, input, context) => {
                                if (actionId !== 'deployments.data.query') throw new Error('Drill must not create or deploy an Environment');
                                return query(DeploymentActionInputSchemasV1['deployments.data.query'].parse(input), context);
                            }, runActionOperation: operations.runActionOperation });
                        const scheduledRestoreSettings = setScopedActionApprovalPreference({ settings: actionContext.actionsSettings,
                            actionId: 'deployments.backups.restore', scope: { kind: 'environment', environmentId: environment.environment.id },
                            surface: 'agent', mode: 'waived' });
                        const drillContext = { ...actionContext, surface: 'agent' as const, authority: 'account_automation' as const,
                            actionsSettings: setScopedActionApprovalPreference({
                            settings: scheduledRestoreSettings, actionId: 'machines.services.control',
                            scope: { kind: 'environment', environmentId: environment.environment.id }, surface: 'agent', mode: 'waived',
                        }) };
                        const grantsBefore = structuredClone({ runtimeGrants, copySourceGrants });
                        const definition = createRestoreDrillWorkflowV1();
                        const inputs = { backupTarget, restoreSource: restoreInput.source,
                            drillTarget: { ...restoreInput, deploymentId: pointer }, restoreDestination: restoreInput.destination,
                            verificationLevel: 'manifestReadBack', dataCheck: { service: 'app', sql: 'SELECT COUNT(*) AS restored_rows FROM recovered_fixture', params: {} } };
                        expect(environment.environment.id).not.toBe(promotionSource.environment.id);
                        const currentVerification = await drillExecutor.execute('deployments.backups.verify', {
                            ...backupTarget, deploymentId: promotionSource.targetLinks[0].targetLink.activeDeploymentId,
                            backupOperationId: produced.operationId, snapshotId: recordedCapture.source.snapshot.snapshotId,
                            level: 'manifestReadBack',
                        }, { ...drillContext, actionRequestId: 'verify-retained-source-on-current-generation' });
                        phase('drill-source-retained-verified');
                        expect(currentVerification, JSON.stringify(currentVerification)).toMatchObject({ ok: true,
                            result: { kind: 'verified', snapshotId: recordedCapture.source.snapshot.snapshotId } });
                        try {
                            for (let iteration = 0; iteration < 3; iteration++) {
                                const unavailableSnapshot = iteration === 2;
                                const store = createInMemoryWorkflowCoordinatorStore();
                                const coordinator = createTestWorkflowCoordinator({ store,
                                    resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine-a', directory: root, checkoutRootPath: root } }),
                                    executeStep: async () => { throw new Error('Drills use native Actions and no agent Session'); },
                                    action: { executor: drillExecutor, buildContext: async () => drillContext,
                                        observeRun: async () => { throw new Error('Drills do not create agent Runs'); } } });
                                const drilled = await coordinator.run({ runId: `persistent-restore-drill-${iteration}`, definition,
                                    inputs: unavailableSnapshot ? { ...inputs, restoreSource: { ...inputs.restoreSource,
                                        snapshotId: 'b'.repeat(64) } } : inputs,
                                    executionTarget: { kind: 'detached_run' },
                                    authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
                                    automationCause: { kind: 'trigger', triggerId: 'restore-drill', triggerRevision: 1,
                                        triggerKind: 'schedule', occurrenceKey: String(iteration).repeat(43), occurredAt: iteration + 2,
                                        evidence: { scheduledFor: iteration + 2 } }, signal: caller.signal });
                                phase(`drill-iteration-${iteration}-settled`);
                                const diagnostics = { invocations: store.list().map(row => ({
                                    blockId: row.blockId, lifecycle: row.lifecycle, reason: row.reason,
                                    failureCause: row.failureCause,
                                })) };
                                expect(drilled, JSON.stringify(diagnostics)).toMatchObject({ state: 'succeeded' });
                                for (const blockId of unavailableSnapshot ? ['cleanupServices', 'stopService']
                                    : ['verify', 'prepareRestore', 'confirmRestore', 'checkData', 'stopService']) {
                                    expect(store.list().find(row => row.blockId === blockId), JSON.stringify(diagnostics))
                                        .toMatchObject({ lifecycle: 'completed' });
                                }
                                if (unavailableSnapshot) {
                                    expect(store.list().find(row => row.blockId === 'verify')).toMatchObject({
                                        lifecycle: 'failed', reason: 'backup_required',
                                    });
                                    expect(store.list().some(row => row.blockId === 'checkData')).toBe(false);
                                } else expect(store.list().find(row => row.blockId === 'checkData')).toMatchObject({
                                    result: { ok: true, columns: [{ name: 'restored_rows' }], rows: [['1']], complete: true },
                                });
                                expect(execFileSync(process.execPath, [docker.executablePath, 'ps', '--filter',
                                    `label=com.docker.compose.project=${serving.content.ownServer!.approvedInputBasis.physicalProjectName}`, '--filter',
                                    'label=com.docker.compose.service=app'], { encoding: 'utf8' }).trim()).toBe('');
                                expect({ runtimeGrants, copySourceGrants }).toEqual(grantsBefore);
                                expect(environment.targetLinks[0].targetLink.activeDeploymentId).toBe(pointer);
                                expect(promotionSource.targetLinks[0].targetLink.activeDeploymentId).toBe('source-current-release');
                            }
                        } finally { await serviceRuntime.dispose(); }
                    }
                    return;
                }
                if (scenario === 'public_restore') for (const mode of ['unknown', 'otherEnvironment', 'foreignSnapshot', 'noBackup', 'nativeFailure', 'recorded'] as const) {
                    recoveryCapture = structuredClone(serving);
                    recoveryCapture.deployment = { ...recoveryCapture.deployment, id: 'failed-migration', state: 'failed' };
                    recoveryCapture.content.ownServer!.preMigrationBackup = structuredClone(capture);
                    if (mode === 'otherEnvironment') recoveryCapture.deployment.environmentId = 'other-environment';
                    if (mode === 'foreignSnapshot') recoveryCapture.content.ownServer!.preMigrationBackup!.source.snapshot.tags = ['happier', 'env:foreign'];
                    if (mode === 'noBackup') delete recoveryCapture.content.ownServer!.preMigrationBackup;
                    receipt.deployment = { ...receipt.deployment, id: `recovery-${mode}`, actionOperationId: `recovery-${mode}`,
                        contentArtifactId: `content-${mode}`, revision: 1, state: 'running' };
                    receipt.content = structuredClone(serving.content);
                    receipt.content.ownServer = { approvedInputBasis: serving.content.ownServer!.approvedInputBasis };
                    receipt.content.steps = [];
                    request = { ...originalRequest, actionId: 'deployments.rollback', input: { ...originalRequest.input,
                        contentArtifactId: receipt.deployment.contentArtifactId, deploymentId: serving.deployment.id,
                        restoreBackupId: mode === 'unknown' ? 'f'.repeat(64) : capture.source.snapshot.snapshotId },
                        receipt: { ...originalRequest.receipt, deploymentId: receipt.deployment.id, state: 'running' },
                        context: { ...originalRequest.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                    if (mode === 'nativeFailure' || mode === 'recorded') {
                        const nativeState = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                        await writeFile(boundary.stateFile, JSON.stringify({ ...nativeState,
                            mode: mode === 'nativeFailure' ? 'failure' : 'success' }));
                    }
                    const before = (await docker.readInvocations()).filter(call => call.args.includes('up')).length;
                    const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                    expect(result).toMatchObject(mode === 'recorded' ? { ok: true } : mode === 'nativeFailure' ? { ok: false } : {
                        ok: false, errorCode: mode === 'otherEnvironment' ? 'stale_input' : 'backup_required' });
                    expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(before + (mode === 'recorded' ? 1 : 0));
                    if (mode === 'nativeFailure' || mode === 'recorded') {
                        const headers = [...stored.values()].map(row => decodePlainArtifactStoredContent(String(row.header)));
                        expect(headers).toContainEqual(expect.objectContaining({ type: 'update',
                            healthPhase: mode === 'nativeFailure' ? 'open' : 'recovered', source: {
                                kind: 'host', topic: 'service_health', subject: { kind: 'backup',
                                    environmentId: environment.environment.id, check: 'restore' },
                            } }));
                    }
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
                const nativeSnapshotOffer = {
                    managedId: 'managed-database', intentRevision: 1,
                    controller: { machineId: 'controller', installationId: 'controller-installation' },
                    resource: { contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'droplet' },
                        schemaVersion: 1, value: { id: 123 } },
                    contribution: { pluginId: 'happier.machine.digitalocean', localId: 'droplet' },
                    coverage: { rootDisk: true, attachedVolumes: false },
                    cost: { kind: 'billed' as const, source: 'https://docs.digitalocean.com/products/snapshots/details/pricing/' },
                    consistency: 'running' as const,
                };
                let nativeSnapshots = 0;
                if (scenario === 'standalone_public_restore_upload' || uploadedVolume) {
                    const sourceBytes = uploadedVolume ? volumeTarFixture : archive;
                    environment.content.backup = { ...capture.configuration,
                        ...(uploadedVolume ? { sources: [{ kind: 'volume', sourceId: capture.source.sourceId,
                            service: 'app', volume: 'shared', consistency: 'stopDuringCopy' }] } : {}) };
                    const uploads = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
                    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
                    registerTransferUploadRpcHandlers({ registerHandler(method, handler) {
                        handlers.set(method, handler as RpcHandler<unknown, unknown>);
                    } }, { workingDirectory: root, store: uploads });
                    const invoke = async (method: string, input: unknown) => {
                        const handler = handlers.get(method);
                        if (!handler) throw new Error('Missing upload transport handler');
                        return handler(input, { signal: caller.signal, machineAdmission: sourceContext.machineAdmission });
                    };
                    try {
                        const initialized = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                            { t: 'deployment_restore_upload_v1', environmentId: environment.environment.id, sizeBytes: sourceBytes.length });
                        if (!isRecord(initialized) || typeof initialized.uploadId !== 'string'
                            || typeof initialized.recipientPublicKeyBase64 !== 'string') throw new Error('Expected finite upload');
                        const chunk = createEncryptedTransferChunkEnvelope({ transferId: initialized.uploadId, sequence: 0,
                            payload: sourceBytes, recipientPublicKeyBase64: initialized.recipientPublicKeyBase64 });
                        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: initialized.uploadId,
                            index: 0, payloadBase64: chunk.payloadBase64,
                            encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 })).toMatchObject({ success: true });
                        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: initialized.uploadId }))
                            .toMatchObject({ success: true, transferId: initialized.uploadId });
                        const artifact = uploads.readCompletedUpload(initialized.uploadId);
                        if (!artifact) throw new Error('Expected retained upload');
                        const restore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine-a',
                            async assertCurrent() { caller.signal.throwIfAborted(); }, restore: target.restore,
                            async acquireUpload(input, context) {
                                if (!context.runtimeAccountId) throw new Error('Missing admitted Account');
                                return acquireDeploymentRestoreUpload(uploads, { ...input, accountId: context.runtimeAccountId });
                            },
                            nativeSnapshot: { async read() { return nativeSnapshotOffer; }, async execute() {
                                nativeSnapshots++;
                                return { kind: 'unknown', code: 'provider_outcome_unknown' };
                            } },
                            readPreparation: (operationId, context) => operations.readRestorePreparation({ operationId, context }) });
                        const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: async () => null,
                            resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                            async dispatchReceipt() { throw new Error('Upload restore must not allocate a deployment receipt'); } });
                        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), serverId: 'home', machineId: 'machine-a',
                            resolveEnvironmentApprovalScope: storage.resolveEnvironmentApprovalScope,
                            deploymentRestore: restore, prepareDeploymentRestore: restore.prepare,
                            runActionOperation: value => operations.runActionOperation(value) });
                        const context = { ...sourceContext, surface: 'agent' as const, actionCaller: { kind: 'host' as const },
                            serverId: 'home', runtimeAccountId: accountId,
                            actionsSettings: setScopedActionApprovalPreference({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
                                actionId: 'deployments.backups.restore', scope: { kind: 'environment', environmentId: environment.environment.id },
                                surface: 'agent', mode: 'waived' }) };
                        const input = { mode: 'prepare' as const, serverId: 'home', environmentId: environment.environment.id,
                            machineId: 'machine-a', installationId: 'installation-a', targetLinkId: environment.targetLinks[0].targetLink.id,
                            deploymentId: recoveryCapture.deployment.id, source: { kind: 'upload' as const, transferId: initialized.uploadId },
                            destination: uploadedVolume ? { kind: 'volume' as const, service: 'app', volume: 'shared' }
                                : { kind: 'database' as const, service: 'app', database }, expectedRevision: environment.environment.revision };
                        const beforeMissing = await readFile(boundary.eventsFile, 'utf8');
                        expect(await executor.execute('deployments.backups.restore', { ...input,
                            source: { kind: 'upload', transferId: 'expired-upload' } }, { ...context, actionRequestId: 'upload-missing' }))
                            .toMatchObject({ ok: false, errorCode: 'restore_upload_unavailable' });
                        expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeMissing);
                        const prepared = await executor.execute('deployments.backups.restore', input,
                            { ...context, actionRequestId: 'upload-prepare' });
                        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: { kind: 'prepared',
                            evidence: { native: { prepared: { source: { kind: 'upload', transferId: initialized.uploadId },
                                sourceFormat: uploadedVolume ? 'volumeTar' : 'postgresCustom' } }, snapshot: nativeSnapshotOffer } } });
                        if (!prepared.ok) throw new Error('Expected upload preparation');
                        const preparation = DeploymentBackupRestoreResultV1Schema.parse(prepared.result);
                        if (preparation.kind !== 'prepared') throw new Error('Expected retained upload preparation');
                        const confirm = { ...input, mode: 'confirm' as const, prepareOperationId: preparation.operationId };
                        const beforeHeld = await readFile(boundary.eventsFile, 'utf8');
                        expect(await executor.execute('deployments.backups.restore', confirm,
                            { ...context, actionRequestId: 'upload-held' }))
                            .toMatchObject({ ok: false, errorCode: 'restore_snapshot_not_confirmed' });
                        expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeHeld);
                        // A held snapshot releases read custody without consuming the
                        // finite source, so the newly reviewed continuation can reacquire it.
                        expect(await readFile(artifact.filePath)).toEqual(sourceBytes);
                        expect(await executor.execute('deployments.backups.restore', { ...confirm, snapshot: false },
                            { ...context, actionRequestId: 'upload-continue' }))
                            .toMatchObject({ ok: true, result: { kind: 'restored', verified: true } });
                        expect(nativeSnapshots).toBe(1);
                        // Every Action exit relinquishes custody; expiry now deletes bytes.
                        await uploads.cleanupExpired(Number.MAX_SAFE_INTEGER);
                        await expect(readFile(artifact.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
                    } finally { await uploads.dispose(); }
                    return;
                }
                const deploymentRestore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine-a',
                    async assertCurrent() { caller.signal.throwIfAborted(); }, restore: target.restore,
                    // The managed controller is a network boundary; the native restore beneath it stays real.
                    nativeSnapshot: { async read() { return nativeSnapshotOffer; }, async execute() {
                        nativeSnapshots++;
                        return scenario === 'standalone_public_restore_snapshot_confirmed'
                            ? { kind: 'confirmed' as const, snapshotId: 'native-snapshot-123',
                                coverage: nativeSnapshotOffer.coverage, consistency: nativeSnapshotOffer.consistency, cost: nativeSnapshotOffer.cost }
                            : { kind: 'unknown' as const, code: 'provider_outcome_unknown' };
                    } },
                    readPreparation: (operationId, context) => operations.readRestorePreparation({ operationId, context }) });
                const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: async () => null,
                    resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }),
                    async dispatchReceipt() { throw new Error('Standalone restore must not allocate a deployment receipt'); } });
                let approvalRequests = 0;
                let latestRestoreApproval: unknown;
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), serverId: 'home', machineId: 'machine-a',
                    resolveEnvironmentApprovalScope: storage.resolveEnvironmentApprovalScope,
                    // Approval persistence is an external storage boundary.
                    approvalsCreate: async input => { latestRestoreApproval = input;
                        return { artifactId: `import-restore-review-${++approvalRequests}` }; },
                    deploymentRestore, prepareDeploymentRestore: deploymentRestore.prepare,
                    runActionOperation: value => operations.runActionOperation(value) });
                const actionContext = { ...sourceContext, surface: 'ui' as const, actionCaller: { kind: 'host' as const },
                    serverId: 'home', runtimeAccountId: accountId,
                    actionsSettings: setScopedActionApprovalPreference({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
                        actionId: 'deployments.backups.restore', scope: { kind: 'environment', environmentId: environment.environment.id },
                        surface: 'ui', mode: 'waived' }) };
                const restoreInput = { mode: 'prepare' as const, serverId: 'home', environmentId: environment.environment.id,
                    machineId: 'machine-a', installationId: 'installation-a', targetLinkId: environment.targetLinks[0].targetLink.id,
                    deploymentId: recoveryCapture!.deployment.id, source: { kind: 'repository' as const, snapshotId: capture.source.snapshot.snapshotId },
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
                const beforeApprovedPrepare = await readFile(boundary.eventsFile, 'utf8');
                const discardedPreparation = await executor.execute('deployments.backups.restore', restoreInput,
                    { ...actionContext, actionRequestId: 'discarded-prepare' });
                expect(discardedPreparation, JSON.stringify(discardedPreparation)).toMatchObject({ ok: true, result: { kind: 'prepared',
                    evidence: { native: { prepared: { repository: capture.repository } } } } });
                expect(discardedPreparation).toMatchObject({ ok: true, result: { evidence: { snapshot: nativeSnapshotOffer } } });
                phase('standalone-discarded-prepared');
                if (!discardedPreparation.ok) throw new Error('Expected public restore preparation for stale input');
                const discarded = DeploymentBackupRestoreResultV1Schema.parse(discardedPreparation.result);
                if (discarded.kind !== 'prepared') throw new Error('Expected discarded restore preparation evidence');
                const before = await docker.readInvocations();
                const beforeTransitions = transitionWrites;
                const pointer = environment.targetLinks[0].targetLink.activeDeploymentId;
                const beforePrepare = await readFile(boundary.eventsFile, 'utf8');
                expect(await executor.execute('deployments.backups.restore', restoreInput,
                    { ...agentContext, actionRequestId: 'import-prepare-ask' }))
                    .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(approvalRequests).toBe(1);
                const requiredUiPreparation = await executor.execute('deployments.backups.restore', restoreInput,
                    { ...actionContext, actionsSettings: requiredUiSettings, actionRequestId: 'import-prepare-ui-ask' });
                // The canonical UI-review owner (02102e614e) cannot create an agent
                // approval Artifact when this headless fixture has no mounted presenter.
                expect(requiredUiPreparation, JSON.stringify(requiredUiPreparation))
                    .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                expect(approvalRequests).toBe(1);
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforePrepare);
                expect(await docker.readInvocations()).toHaveLength(before.length);
                const missingConfirmation = await executor.execute('deployments.backups.restore', { ...restoreInput,
                    mode: 'confirm', prepareOperationId: 'missing-prepare' }, { ...actionContext, actionRequestId: 'missing-confirm' });
                expect(missingConfirmation).toMatchObject({ ok: false, errorCode: 'restore_prepare_required' });
                expect(await docker.readInvocations()).toHaveLength(before.length);
                if (scenario === 'standalone_public_restore_stale_input') {
                    const beforeStale = await readFile(boundary.eventsFile, 'utf8');
                    expect(await executor.execute('deployments.backups.restore', { ...restoreInput, mode: 'confirm',
                        prepareOperationId: discarded.operationId, source: { ...restoreInput.source, snapshotId: 'f'.repeat(64) } },
                        { ...actionContext, actionRequestId: 'stale-confirm' }))
                        .toMatchObject({ ok: false, errorCode: 'stale_input' });
                    expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeStale);
                    return;
                }
                // The stale-input case has its own receipt; this preparation reaches the actual effect.
                const preparation = discardedPreparation;
                expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
                if (!preparation.ok) throw new Error('Expected retained public restore preparation');
                const preparedResult = DeploymentBackupRestoreResultV1Schema.parse(preparation.result);
                if (preparedResult.kind !== 'prepared') throw new Error('Expected public restore preparation evidence');
                phase('standalone-prepared');
                expect(preparedResult.steps).toEqual([{ id: 'safety', status: 'completed' }]);
                expect(preparedResult.evidence).toMatchObject({ native: { prepared: { source: capture.source,
                    repository: capture.repository, destination: { databaseExists: true, hasMeaningfulData: true, writerServices: [] },
                    safetyBackup: { kind: 'verified', manifests: [expect.any(Object)] } }, configuration: capture.configuration } });
                expect(preparedResult.evidence).toMatchObject({ snapshot: nativeSnapshotOffer });
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
                expect(approvalRequests).toBe(2);
                expect(latestRestoreApproval).toMatchObject({ request: { summary: expect.stringContaining(nativeSnapshotOffer.cost.source), actionArgs: {
                    snapshot: true, snapshotReview: nativeSnapshotOffer,
                } } });
                expect(await executor.execute('deployments.backups.restore', confirmInput,
                    { ...actionContext, actionsSettings: requiredUiSettings, actionRequestId: 'import-confirm-ui-ask' }))
                    .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                expect(approvalRequests).toBe(2);
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeConfirmation);
                phase('standalone-confirm');
                const stopped = await executor.execute('deployments.backups.restore', confirmInput,
                    { ...waivedAgentContext, actionRequestId: 'standalone-confirm' });
                let continuedInput: typeof confirmInput & { snapshot?: boolean } = confirmInput;
                let result = stopped;
                if (scenario === 'standalone_public_restore_snapshot_confirmed') {
                    expect(result).toMatchObject({ ok: true, result: { kind: 'restored', evidence: { snapshot: {
                        kind: 'confirmed', snapshotId: 'native-snapshot-123', coverage: nativeSnapshotOffer.coverage,
                    } } } });
                    expect(nativeSnapshots).toBe(1);
                } else {
                    expect(stopped).toMatchObject({ ok: false, errorCode: 'restore_snapshot_not_confirmed',
                        details: { snapshot: { kind: 'unknown', code: 'provider_outcome_unknown' } } });
                    expect(nativeSnapshots).toBe(1);
                    expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeConfirmation);
                    expect(await executor.execute('deployments.backups.restore', confirmInput,
                        { ...waivedAgentContext, actionRequestId: 'snapshot-replay' })).toEqual({ ...stopped, requestId: 'snapshot-replay' });
                    expect(nativeSnapshots).toBe(1);
                    continuedInput = { ...confirmInput, snapshot: false };
                    const continueInput = continuedInput;
                    expect(await executor.execute('deployments.backups.restore', { ...continueInput, source: { ...restoreInput.source, snapshotId: 'f'.repeat(64) } },
                        { ...waivedAgentContext, actionRequestId: 'snapshot-substitution' }))
                        .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
                    expect(await executor.execute('deployments.backups.restore', continueInput,
                        { ...agentContext, actionRequestId: 'snapshot-new-agent-review' }))
                        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                    expect(approvalRequests).toBe(3);
                    expect(latestRestoreApproval).toMatchObject({ request: { actionArgs: { snapshot: false, snapshotReview: nativeSnapshotOffer } } });
                    expect(nativeSnapshots).toBe(1);
                    expect(await executor.execute('deployments.backups.restore', continueInput,
                        { ...actionContext, actionsSettings: requiredUiSettings, actionRequestId: 'snapshot-new-review' }))
                        .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                    expect(await readFile(boundary.eventsFile, 'utf8')).toBe(beforeConfirmation);
                    result = await executor.execute('deployments.backups.restore', continueInput,
                        { ...waivedAgentContext, actionRequestId: 'snapshot-continue' });
                    expect(nativeSnapshots).toBe(1);
                }
                // This fixture has only PostgreSQL. The destination observer excludes
                // the database itself from writers; there is no application to stop/restart.
                expect(result).toMatchObject({ ok: true, result: { kind: 'restored', verified: true, steps: [
                    { id: 'safety', status: 'completed' }, { id: 'restore', status: 'completed' },
                    { id: 'stop', status: 'skipped' }, { id: 'start', status: 'skipped' }, { id: 'health', status: 'completed' },
                ] } });
                if (scenario !== 'standalone_public_restore_snapshot_confirmed') expect(result)
                    .toMatchObject({ ok: true, result: { evidence: { snapshot: {
                        kind: 'unknown', code: 'provider_outcome_unknown',
                    } } } });
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
                expect(await executor.execute('deployments.backups.restore', continuedInput,
                    { ...actionContext, actionRequestId: 'standalone-confirm-retry' })).toEqual(result);
                expect(await readFile(boundary.eventsFile, 'utf8')).toBe(completedEvents);
                expect(await executor.execute('deployments.backups.restore', { ...continuedInput, source: { ...restoreInput.source, snapshotId: 'f'.repeat(64) } },
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
            else if (!scenario.startsWith('adopted_') && scenario !== 'private_publication_failed_attempt' && scenario !== 'private_publication_matching_restore' && scenario !== 'private_publication_forward_withdrawal')
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
            if (scenario.startsWith('joining_current')) {
                // The joining installation has never hosted U or B. Restore
                // consumes U's immutable artifacts without expecting a B incumbent.
                serving.content = { ...structuredClone(receipt.content), ownServer: { approvedInputBasis: {
                    ...structuredClone(review.inputBasis), members: [{ machineId: 'machine-b', installationId: 'installation-b' }],
                } } };
                if (scenario === 'joining_current_successor') {
                    const predecessorTargetLinkId = 'prior-runtime-link';
                    environment.targetLinks[0].targetLink.predecessorTargetLinkId = predecessorTargetLinkId;
                    serving.deployment.targetLinkId = predecessorTargetLinkId;
                    serving.content.ownServer!.approvedInputBasis.targetLinkId = predecessorTargetLinkId;
                    serving.content.ownServer!.approvedInputBasis.bindings = serving.content.ownServer!.approvedInputBasis.bindings
                        .map(binding => binding.purpose === 'registry' ? { ...binding, targetLinkId: predecessorTargetLinkId } : binding);
                    // The Docker process is the external registry boundary.
                    // Model a cold joining engine while retaining registry
                    // image bytes in this process fixture for the later pull.
                    const executable = await readFile(docker.executablePath, 'utf8');
                    const firstLine = executable.indexOf('\n') + 1;
                    const requireRegistryAuth = String.raw`const fixtureFs = require('node:fs');
const fixturePath = require('node:path');
const fixturePulled = fixturePath.join(__dirname, 'retained-registry-pulled');
if (process.argv.includes('image') && process.argv.includes('inspect') && !fixtureFs.existsSync(fixturePulled)) process.exit(1);
if (process.argv.includes('image') && process.argv.includes('pull') && process.argv.some(arg => arg.startsWith('registry.example.test/'))) {
    const fixtureConfig = process.env.DOCKER_CONFIG && JSON.parse(fixtureFs.readFileSync(fixturePath.join(process.env.DOCKER_CONFIG, 'config.json'), 'utf8'));
    if (fixtureConfig?.auths?.['registry.example.test']?.auth !== Buffer.from('deploy:retained-registry-sentinel').toString('base64')) {
        process.stderr.write('fixture_registry_auth_required'); process.exit(1);
    }
    fixtureFs.writeFileSync(fixturePulled, 'pulled'); process.exit(0);
}
`;
                    await writeFile(docker.executablePath, executable.slice(0, firstLine) + requireRegistryAuth + executable.slice(firstLine));
                }
                const immutableUniform = structuredClone(serving);
                environment.targetLinks[0].targetLink.members[0].state = 'joining';
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                const before = (await docker.readInvocations()).length;
                if (scenario === 'joining_current_successor') {
                    expect(await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'restore', selectedDeploymentId: 'unrelated-environment-release' }))
                        .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                    expect((await docker.readInvocations()).length).toBe(before);
                }
                const joined = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'restore', selectedDeploymentId: serving.deployment.id });
                expect(joined, JSON.stringify(joined)).toMatchObject({ ok: true, state: 'running' });
                expect(receipt.content.machineResults).toEqual([expect.objectContaining({ currentDeploymentId: serving.deployment.id,
                    restoration: 'succeeded', health: 'healthy' })]);
                expect(await docker.readRunningImageConfig('app')).toBe(image.configDigest);
                if (scenario === 'joining_current_successor') {
                    expect(await readFile(join(root, 'docker', 'retained-registry-pulled'), 'utf8')).toBe('pulled');
                }
                const native = (await docker.readInvocations()).slice(before);
                expect(native.filter(call => call.args.includes('up'))).toHaveLength(1);
                expect(native.some(call => call.args.includes('build'))).toBe(false);
                expect(serving).toEqual(immutableUniform);
                return;
            }
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
            if (scenario === 'private_publication_failed_attempt' || scenario === 'private_publication_forward_withdrawal') {
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                if (scenario === 'private_publication_failed_attempt') await docker.failImageHealth(image.configDigest);
                const attempted = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(attempted).toMatchObject({ ok: scenario === 'private_publication_forward_withdrawal' });
                expect(retainedPrivateExports, JSON.stringify(attempted)).toEqual(['application']);
                expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(true);
                if (scenario === 'private_publication_failed_attempt') {
                    recoveryCapture = structuredClone(receipt);
                    recoveryCapture.deployment.state = 'failed';
                } else {
                    Object.assign(serving, structuredClone(receipt));
                    serving.deployment.state = 'succeeded';
                    environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                }
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
                const unsharedResult = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                expect(retainedPrivateExports).toEqual([]);
                if (scenario === 'private_publication_forward_withdrawal') {
                    expect(unsharedResult, JSON.stringify(unsharedResult)).toMatchObject({ ok: true });
                    earlierReceipt = structuredClone(serving);
                    Object.assign(serving, structuredClone(receipt));
                    serving.deployment.state = 'succeeded';
                    environment.targetLinks[0].targetLink.activeDeploymentId = serving.deployment.id;
                    // A successful unshared baseline already withdrew old permits.
                    // Ordinary unshared deploys must work without native elevation.
                    firewallElevationAvailable = false;
                    receipt.deployment = { ...receipt.deployment, id: 'ordinary-unshared', actionOperationId: 'ordinary-operation',
                        contentArtifactId: 'ordinary-content', revision: 1, state: 'queued' };
                    receipt.content = { ...receipt.content, ownServer: undefined, machineResults: [], steps: [] };
                    request = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                        receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1 },
                        context: { ...request.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                    const ordinary = await target.review({ actionId: request.actionId, input: request.input,
                        content: receipt.content, context: sourceContext });
                    receipt.deployment.state = 'running';
                    receipt.content.ownServer = { approvedInputBasis: ordinary.inputBasis };
                    const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                        phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                    expect(retainedPrivateExports).toEqual([]);
                }
                return;
            }
            if (scenario === 'iroh_publication_loopback' || scenario === 'iroh_publication_refused'
                || scenario === 'iroh_publication_host_network'
                || scenario === 'private_publication_refused' || scenario === 'private_publication_withdrawal_refused') {
                if (scenario === 'private_publication_withdrawal_refused') serving.content.ownServer = {
                    approvedInputBasis: { ...review.inputBasis, ownServer: { ...review.inputBasis.ownServer!,
                        serviceExports: [{ key: 'application', service: 'app', containerPort: 3000, scheme: 'http',
                            exposure: 'privateNetwork', privateNetwork: 'shop-net' }] } },
                };
                receipt.deployment.state = 'running';
                receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
                const result = await target.executeMember({ request, machineId: 'machine-a', installationId: 'installation-a',
                    phase: 'activate', selectedDeploymentId: receipt.deployment.id });
                if (scenario === 'iroh_publication_loopback') expect(result).toMatchObject({ ok: true });
                else {
                    expect(result).toMatchObject({ ok: false, errorCode: 'private_scope_unenforceable' });
                    expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                }
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
                    if (scenario === 'candidate_start_first_restore_join_recovery') {
                        // A prior B reached native success, but its Environment
                        // rollout failed before this joining member was committed.
                        earlierReceipt = structuredClone(receipt);
                        earlierReceipt.deployment.state = 'failed';
                        receipt.deployment = { ...receipt.deployment, id: 'join-recovery', actionOperationId: 'join-recovery-operation',
                            contentArtifactId: 'join-recovery-content', revision: 1 };
                        receipt.content = { ...receipt.content, ownServer: { approvedInputBasis: review.inputBasis }, steps: [],
                            machineResults: receipt.content.machineResults.map(({ machineId, installationId, currentDeploymentId }) => ({
                                machineId, installationId, currentDeploymentId, steps: [], activation: 'pending', health: 'unknown',
                            })) };
                        environment.targetLinks[0].targetLink.members[0].state = 'joining';
                        request = { ...request, input: { ...request.input, contentArtifactId: receipt.deployment.contentArtifactId },
                            receipt: { ...request.receipt, deploymentId: receipt.deployment.id, deploymentRevision: 1 },
                            context: { ...request.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
                    }
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
                    expect(result).toMatchObject({ ok: true, state: 'running' });
                    expect((await docker.readInvocations()).slice(nativeBefore).some(call => call.args.includes('up'))).toBe(true);
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
                // DJ28: the latest failed attempt remains the investigation log even
                // when release retention is zero and the incumbent serves again.
                receipt.deployment = { ...receipt.deployment, state: 'failed',
                    requestedAtMs: serving.deployment.requestedAtMs + 1 };
                environment.content.retainPreviousDeployments = 0;
                const retaining = createOwnServerDeploymentTargetForHost({ ...host,
                    async readRetentionHeaders() { return structuredClone({ environment: environment.environment,
                        deployment: receipt.deployment, link: environment.targetLinks[0]!.targetLink }); } });
                expect(await retaining.retain({ request: restoration, machineId: 'machine-a', installationId: 'installation-a',
                    settledTargetLinkRevision: environment.targetLinks[0]!.targetLink.revision,
                    settledDeploymentRevision: receipt.deployment.revision, activeDeploymentId: serving.deployment.id }))
                    .toMatchObject({ ok: true, state: 'failed' });
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
            await settleBackupFixture();
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
    }, scenario === 'public_backup_restore' ? 6 * 60_000
        : scenario === 'runtime_stage' || scenario === 'private_publication_forward_withdrawal' || scenario === 'public_restore' || scenario.startsWith('standalone_public_restore') || scenario === 'public_copy' || scenario === 'public_restore_drill' || scenario === 'public_preview_copy' || scenario === 'public_preview_copy_failure' || scenario === 'public_preview_configure_failure' || scenario.startsWith('public_preview_companion_') || scenario.startsWith('public_backup') || scenario.startsWith('candidate_start_first_restore') ? 3 * 60_000
        : scenario.startsWith('candidate_start_first') || scenario === 'member_health' || scenario.startsWith('candidate_backup_configured') ? 2 * 60_000 : scenario === 'runtime_reads' || scenario === 'runtime_health'
        || scenario.startsWith('retained_health') || scenario.startsWith('candidate_') || scenario.startsWith('native_preview_cleanup') ? 60_000 : undefined);
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
