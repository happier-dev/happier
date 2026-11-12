import { projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPrepareEnvironmentContentForHost } from '../../../../cli/src/deployments/prepareEnvironmentContentForHost';
import { createDaemonDeploymentActionDeps } from '../../../../cli/src/deployments/createDaemonDeploymentActionDeps';
import { createDaemonDeploymentNativeSnapshot } from '../../../../cli/src/deployments/daemonDeploymentNativeSnapshot';
import { createAdmittedPluginRuntimeFixture } from '../../../../cli/src/plugins/testkit/admittedRuntime';
import { createDaemonExternalActionContributedInvoker } from '../../../../cli/src/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { createUnavailableActionTransportDeps } from '../../../../cli/src/testkit/actionTransportDeps';
import { createActionSettingsProvider } from '../../../../cli/src/settings/actionsSettingsProvider';
import { withConfiguredDaemonTestHome } from '../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '../../../../cli/src/server/serverProfiles';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createFilesystemEffectAdmission } from '../../../../cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrepareDeploymentBindingsForHost } from '../../../../cli/src/deployments/secrets/prepareDeploymentBindingsForHost';
import { admitRequesterAccountActionContext } from '../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { readOrCreateInstallationIdentity } from '../../../../cli/src/daemon/identity/store';
import { openMachineSecretGrant, sealMachineSecretGrant } from '../../../../cli/src/deployments/secrets/machineSecretGrant';
import { prepareEnvironmentSecretBindingsForLaunch } from '../../../../cli/src/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { configuration, reloadConfiguration } from '../../../../cli/src/configuration';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountSettingsRoutes } from '@/app/api/routes/account/registerAccountSettingsRoutes';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { registerAutomationV3Routes } from '@/app/api/routes/automations/registerAutomationV3Routes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { readDeploymentSourceIntentForHost } from '../../../../cli/src/deployments/readDeploymentSourceIntentForHost';
import { symbols, type DestinationStream } from 'pino';
import { logger } from '@/utils/logging/log';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema,
    ProjectAccountRowReadResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectSourcesReadOutputV1Schema, ProjectSourcesUpdateInputV1Schema,
    ProjectSourceRepositorySelectorV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentBindingsSetStorageInputV1Schema, DeploymentDomainContentV1Schema, readDeploymentDomainArtifactV1,
    computeEnvironmentSecretLaunchAdmissionDigestV1, EnvironmentSecretLaunchAdmissionBodyV1Schema,
    EnvironmentSecretLaunchAdmissionInputV1Schema, EnvironmentSecretClientBindingsInputV1Schema,
    EnvironmentSecretLaunchAdmissionResultV1Schema, MachineConnectorSecretGrantInputV1Schema,
    readDeploymentEnvironmentArtifactV1, captureDeploymentBindingSavedSecretRevisionsV1,
    type EnvironmentSecretBindingV1, type MachineConnectorSecretGrantBodyV1 } from '@happier-dev/deployment-protocol';
import { API_TOKEN_FULL_GRANT_V1, ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, sealSavedSecretResourceStoredContentV1,
    encodePlainMachineStoredContent, encodePlainArtifactStoredContent, type DeploymentChildRpcV1, projectDeploymentChildRoutingV1,
    computeDeploymentTransitionRequestDigestV1, ArtifactJsonCreateHttpInputV1Schema, ArtifactJsonUpdateHttpInputV1Schema, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, DeploymentReceiptResultV1Schema, DeploymentReceiptListInputV1Schema,
    DeploymentChildRpcV1Schema, DeploymentTeardownReviewChildRpcV1Schema, DeploymentTransitionInputV1Schema, type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { DeploymentDomainMutationResultV1Schema, DeploymentDomainCapturedPlacementsV1Schema, deploymentDomainObservationProofPayloadV1 } from '@happier-dev/protocol';
import { sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0,
    openSessionDataKeyBundleV0, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, signExternalActionMachineRpcRequestV1,
    signExternalActionMachineRequestV1, verifyExternalActionMachineRpcRequestV1, encodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol/actions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { encodeDeploymentChildExecutionV1, decodeDeploymentChildExecutionV1, verifyExternalActionMachineRequestV1, createDeploymentChildExecutionProofV1, projectDeploymentChildExecutionProofV1,
    encodeReviewedActionChildHttpProofV1, type DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationRequestV1Schema, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
    EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, projectDeploymentPreparationAdmissionV1,
    projectExternalActionDeploymentNativeEnvelopeAdmissionV1, projectDeploymentNativeAdmissionV1, projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1, projectDeploymentReadAdmissionV1,
    projectRegistryAppUpdateAdmissionV1, createDeploymentDomainContentArtifactIdV1,
    createDeploymentEnvironmentContentArtifactIdV1, isDeploymentEnvironmentUpdateNativeAdmissionV1, isDeploymentDomainNativeAdmissionV1,
    type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createExternalActionDaemonDispatchResponse, prepareExternalActionResponseEnvelopeV1,
    prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import type { ExternalActionDaemonDispatchRequest, ExternalActionRequestEnvelope, ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { DeploymentBackupRestoreInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import type { DeploymentBackupConfigureInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { DEPLOYMENT_ACTION_IDS_V1, DEPLOYMENT_BACKUP_ACTION_IDS_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { buildDeploymentBackupActionInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { DirectRouteGrantRequestV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { DEPLOYMENT_ACTION_SPECS_V1 } from '@happier-dev/protocol/actions/specs/deployments';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionMachineRpcExecution, verifyExternalActionDomainExecutionRequest,
    isDeploymentNativeHttpPurpose, isDeploymentReadPreparation, readAdmittedFiniteOperationPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { isDeploymentPreparationHttpPurposeInTx, isDeploymentReadOperandInAdmittedScopeInTx,
    isDeploymentEnvironmentHttpReadInAdmittedScopeInTx, readDeploymentSourceReadOperands } from './deploymentPreparationAuthorization';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { removeTeamMemberForActorInTx } from '@/app/teams/memberships/memberAdministration';
import { createArtifact, updateArtifact } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { ArtifactHttpReadV1Schema, ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerMachineAdmissionRoutes } from '@/app/api/routes/machines/registerMachineAdmissionRoutes';
import { registerPeerMediationGrantRoutes } from '@/app/api/routes/machines/peer/mediation/registerPeerMediationGrantRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { sessionRoutes } from '@/app/api/routes/session/sessionRoutes';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { createExternalActionDaemonDispatcher, resolveCurrentSessionMachineFromServer } from '@/app/api/socket/externalActionDispatcher';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import type { Socket } from 'socket.io';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket, currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema,
    SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { createDeploymentInTx, transitionDeploymentInTx } from './deploymentService';
import { setDeploymentEnvironmentControllerInTx } from './deploymentControllerService';
import { readDeploymentMachineReferencesInTx, readDeploymentReceiptInTx } from './deploymentReadService';
import { createDeploymentEnvironmentInTx, updateDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { readDeploymentAcceptedExecution, hasAcceptedDeploymentReceiptInTx, readAcceptedDeploymentReceiptInTx } from './deploymentAcceptedExecution';
import { syncEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';
import { readEnvironmentSecretLaunchAdmissionInTx } from './environmentSecretLaunchAdmission';
import { readDeploymentReadAuthorizationInTx } from './deploymentReadAuthorization';
import { createDeploymentDomainInTx, removeDeploymentDomainInTx, prepareDeploymentDomainContentInTx } from './deploymentDomainService';
import { isCurrentDeploymentChildInTx, readDeploymentChildAdmissionInTx, readDeploymentChildMachineReadInTx } from './deploymentChildAuthorization';
import { isDeploymentPreparationAuthorizedInTx, readDeploymentBackupConfigureHttpPurpose } from './deploymentPreparationAuthorization';
import { isDeploymentChildHttpPurposeInTx } from '@/app/auth/deploymentChildHttpPurpose';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { managedQb56Input } from '@/app/api/routes/actions/managedQb56Input.testkit';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createExternalActionAuthorizedRequestHeaders, projectExternalActionRequesterHttpAuthorization } from '../../../../cli/src/api/externalActionExecutionAuthorization';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { admitWorkflowRun } from '@/app/workflows/workflowRunService';
import { claimAutomationRun } from '@/app/automations/automationClaimService';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '@/app/automations/automationAccountCurrentness';
import { hasCurrentDeploymentWorkflowOriginInTx } from '@/app/auth/deploymentWorkflowOrigin';
import { DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

describe('deployment children retain their controller Action authority', () => {
    const serverId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-child-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: 'true' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function expectHttpRefusalWarning(expected: Readonly<{ phase: string; method: string; path: string }>,
        run: () => Promise<unknown>, secrets: readonly string[] = []) {
        const records: Array<Record<string, unknown>> = [];
        // Only the log output boundary is replaced; signatures, admission and Pino filtering stay real.
        const stream = (logger as unknown as { [symbols.streamSym]: DestinationStream })[symbols.streamSym];
        const write = vi.spyOn(stream, 'write').mockImplementation(message => { records.push(JSON.parse(message)); });
        const level = logger.level;
        logger.level = 'warn';
        try {
            await run();
            const refusals = records.filter(record => record.module === 'external-action-authorization-refusal');
            expect(refusals).toHaveLength(1);
            expect(refusals[0]).toMatchObject({ level: 40, ...expected });
            const output = JSON.stringify(records);
            for (const secret of secrets) expect(output.includes(secret), 'refusal warning disclosed private request data').toBe(false);
        } finally { logger.level = level; write.mockRestore(); }
    }

    async function fixture(ownerKind: 'account' | 'team' = 'account', credential: 'account' | 'api' = 'account',
        options: Readonly<{ readableEnvironment?: boolean; separateMemberCustodian?: boolean; separateControllerCustodian?: boolean; separateContentOwner?: boolean;
            workflowOrigin?: boolean; templateRoot?: boolean; contentMode?: 'plain' | 'e2ee'; platformTarget?: 'vercel' | 'workers';
            persistedR76Placement?: boolean; sourceWithoutRepository?: boolean }> = {}) {
        const contentMode = options.contentMode ?? 'plain';
        const accountKeys = nacl.box.keyPair(), memberContentKeys = nacl.box.keyPair();
        const account = await db.account.create({ data: { encryptionMode: contentMode,
            ...(contentMode === 'e2ee' ? createSignedAccountContentBinding(accountKeys.publicKey) : {}) } });
        const team = ownerKind === 'team' ? await db.team.create({ data: { name: 'Child authority' } }) : null;
        if (team) await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'owner' } });
        const memberCustodian = options.separateMemberCustodian ? await db.account.create({ data: { encryptionMode: contentMode,
            ...(contentMode === 'e2ee' ? createSignedAccountContentBinding(memberContentKeys.publicKey) : {}) } }) : account;
        const controllerCustodian = options.separateControllerCustodian ? await db.account.create({ data: { encryptionMode: contentMode,
            ...(contentMode === 'e2ee' ? createSignedAccountContentBinding(memberContentKeys.publicKey) : {}) } }) : account;
        if (team && memberCustodian.id !== account.id) await db.teamMembership.create({ data: {
            teamId: team.id, accountId: memberCustodian.id, role: 'member',
        } });
        if (team && controllerCustodian.id !== account.id) await db.teamMembership.create({ data: {
            teamId: team.id, accountId: controllerCustodian.id, role: 'member',
        } });
        async function installed(accountId = account.id, id = crypto.randomUUID()) {
            const keys = nacl.sign.keyPair();
            const contentKey = nacl.randomBytes(32);
            const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'Child', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/child', happyHomeDir: '/home/child/.happier' });
            const row = await db.machine.create({ data: { id, accountId,
                metadata: contentMode === 'plain' ? encodePlainMachineStoredContent(metadata)
                    : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(metadata, contentKey))),
                dataEncryptionKey: contentMode === 'plain' ? privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
                    : sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey, recipientPublicKey: accountId === account.id
                        ? accountKeys.publicKey : memberContentKeys.publicKey, randomBytes: nacl.randomBytes }),
                active: true, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
            if (contentMode === 'e2ee' && accountId !== account.id && row.dataEncryptionKey) await db.machineKeyEnvelope.create({ data: {
                machineId: row.id, recipientAccountId: account.id,
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey,
                    recipientPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes }),
                machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(row.dataEncryptionKey),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(accountKeys.publicKey),
            } });
            return { ...row, installationId: row.installationId!, keys, contentKey };
        }
        const controller = await installed(controllerCustodian.id,
            options.persistedR76Placement ? '6b2f67f1-dc3d-40c7-9080-0ec6d4515822' : undefined),
            member = await installed(memberCustodian.id), builder = await installed(), outsider = await installed(account.id,
                options.persistedR76Placement ? 'eadc2422-b42b-478d-97b1-af9b530d5f08' : undefined);
        if (team) await db.machineTeamGrant.createMany({ data: [controller, member, builder].map(machine => ({
            machineId: machine.id, teamId: team.id, accessLevel: 'view', createdByAccountId: machine.accountId })) });
        const source = await inTx(tx => createProjectSourceInTx(tx, account.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Child deployment', audience: [], ...(team ? { owner: { kind: 'team' as const, teamId: team.id } } : {}), repository: options.sourceWithoutRepository ? undefined : { protocol: 'https',
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'child/app', cloneUrl: 'https://github.com/child/app.git' } } }));
        if (!source.ok) throw new Error(source.error);
        const artifactKeys = new Map<string, Uint8Array>();
        async function content(kind: string, storedBody?: unknown) {
            const contentKey = nacl.randomBytes(32);
            const header = { kind, title: 'Child' };
            const body = storedBody !== undefined ? { body: JSON.stringify(storedBody) }
                : options.readableEnvironment && kind === 'deployment-environment.v1'
                ? { body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) } : {};
            const seal = async (value: unknown) => contentMode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                : new Uint8Array(await sealSessionDataKeyBundleV0(value, contentKey));
            const result = await createArtifact({ actorUserId: options.separateContentOwner ? memberCustodian.id : account.id, artifactId: crypto.randomUUID(),
                kind: `v1:other:${kind}`,
                header: await seal(header), body: await seal(body),
                dataEncryptionKey: contentMode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey, recipientPublicKey: options.separateContentOwner
                        ? memberContentKeys.publicKey : accountKeys.publicKey, randomBytes: nacl.randomBytes }) });
            if (!result.ok) throw new Error(result.error);
            artifactKeys.set(result.artifact.id, contentKey);
            if (team) await db.artifactTeamGrant.create({ data: { artifactId: result.artifact.id,
                teamId: team.id, accessLevel: 'admin', createdByAccountId: account.id } });
            if (contentMode === 'e2ee' && options.separateContentOwner) await db.artifactKeyEnvelope.create({ data: {
                artifactId: result.artifact.id, recipientAccountId: account.id,
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(accountKeys.publicKey),
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey,
                    recipientPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes }),
            } });
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            ...(options.persistedR76Placement ? { id: 'cmw424voq00cbmcskx8q38dvv' } : {}),
            createdByAccountId: account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: controller.id, buildMachineId: builder.id, ...await content('deployment-environment.v1') } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id, createdByAccountId: account.id,
            ...(options.persistedR76Placement ? { id: 'cmw424vpr00cdmcsk85jcci67' } : {}),
            role: 'runtime', state: 'deployed', ...(options.platformTarget
                ? { sourceKind: 'plugin', pluginId: options.platformTarget === 'vercel' ? 'happier.deploy.vercel' : 'happier.deploy.cloudflare',
                    contributionLocalId: options.platformTarget === 'vercel' ? 'vercel' : 'workers', targetKind: 'platform' }
                : { sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', machines: { create: [
                    { machineId: member.id, installationId: member.installationId, position: 0, state: 'active' } ] } }),
            ...await content('deployment-target-link.v1') } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const receiptContent = await content('deployment-receipt.v1');
        const requestKey = crypto.randomUUID(), actionOperationId = crypto.randomUUID();
        const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision, targetLinkId: link.id,
            expectedTargetLinkRevision: link.revision, requestKey, ...receiptContent };
        const target = { kind: 'machine' as const, machineId: controller.id };
        const actionId = options.templateRoot ? 'deployments.templates.instantiate' as const : 'deployments.deploy' as const;
        const templateInput = { mode: 'apply' as const, serverId, machineId: member.id, projectSourceId: source.source.id,
            templateRef: { sourceId: 'catalog', itemId: 'app', version: '1', ref: { kind: 'version' as const, version: '1' } },
            environment: { kind: 'existing' as const, environmentId: environment.id, expectedRevision: environment.revision },
            target: { kind: 'existing' as const, targetLinkId: link.id, expectedRevision: link.revision, installationId: member.installationId },
            destination: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, bindings: [], deploy: { requestKey } };
        const originalActionEnvelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: options.templateRoot ? templateInput : input };
        const workflowActionOrigin = options.workflowOrigin ? { runId: crypto.randomUUID(), requestId: originalActionEnvelope.requestId } : undefined;
        if (workflowActionOrigin) {
            const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
                definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
                    document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
                context: { source: { kind: 'inline' }, inputs: {}, machineId: controller.id, executionTarget: { kind: 'session' },
                    workspaceTarget: { project: { machineId: controller.id, directory: '/repo', checkoutRootPath: '/repo' } },
                    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
            });
            const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
                where: { id: account.id }, select: automationAccountCurrentnessSelect }));
            if (!accountCurrentness) throw new Error('Expected current workflow Account');
            const runDataKey = nacl.randomBytes(32);
            await admitWorkflowRun({ accountId: account.id, machineId: controller.id, runId: workflowActionOrigin.runId,
                ...(contentMode === 'e2ee' ? { recipientKeyEnvelopes: [{ recipientAccountId: account.id,
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(accountKeys.publicKey),
                    encryptedDataKey: privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: runDataKey,
                        recipientPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes })) }] } : {}),
                accountCurrentness, origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
                    sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...(contentMode === 'plain' ? { mode: 'plain' as const }
                        : { mode: 'e2ee' as const, runDataKey, randomBytes: nacl.randomBytes }),
                        binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId: workflowActionOrigin.runId },
                        acceptedSnapshot: snapshot })) });
            const claimed = await claimAutomationRun({ accountId: account.id, machineId: controller.id, leaseDurationMs: 30_000, scope: 'workflow' });
            expect(claimed.run?.id).toBe(workflowActionOrigin.runId);
        }
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { ids: [actionId], families: [] },
            targets: { machines: options.templateRoot ? [controller.id] : [], sessions: [],
                environments: options.templateRoot ? [] : [environment.id] } };
        const api = credential === 'api' ? await auth.createApiToken({ accountId: account.id,
            tokenId: crypto.randomUUID(), label: 'Deployment', grant }) : null;
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: account.id, ...(api ? { principalId: account.id, credentialId: api.tokenId, grant }
                : { authentication: { kind: 'account' as const, tokenEpoch: account.tokenEpoch } }),
            actionId, machineId: controller.id, target, requestId: originalActionEnvelope.requestId,
            ...(options.templateRoot ? { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, templateInput) } : {}),
            ...(workflowActionOrigin ? { workflowActionOrigin } : {}),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope) }, { input: originalActionEnvelope.input });
        const admissionPath = `/v1/deployments/environments/${environment.id}/deploy`;
        const admissionInput = { ...input, actionOperationId };
        const reviewedChild = options.templateRoot ? { actionId: 'deployments.deploy', role: 'template.deploy',
            inputDigest: computeActionInputApprovalDigestV1('deployments.deploy', input) } : undefined;
        const admissionHeaders = {
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: 'deployments.deploy', target, installationId: controller.installationId,
                requestId: authorization.binding.requestId, method: 'POST', path: admissionPath, body: admissionInput,
                ...(reviewedChild ? { reviewedChild } : {}),
                privateKey: controller.keys.secretKey }),
        };
        const admissions: ReturnType<typeof DeploymentReceiptResultV1Schema.parse>[] = [];
        if (reviewedChild) {
            for (const { body, child } of [
                { body: { ...admissionInput, requestKey: crypto.randomUUID() }, child: reviewedChild },
                { body: { ...admissionInput, environmentId: crypto.randomUUID() }, child: reviewedChild },
                { body: { ...admissionInput, expectedRevision: admissionInput.expectedRevision + 1 }, child: reviewedChild },
                { body: admissionInput, child: { ...reviewedChild, role: 'template.bindings' } },
                { body: admissionInput, child: { ...reviewedChild, inputDigest:
                    computeActionInputApprovalDigestV1('deployments.deploy', { ...input, expectedRevision: input.expectedRevision + 1 }) } },
            ]) {
                const path = `/v1/deployments/environments/${body.environmentId}/deploy`;
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.deploy', encodedTarget: encodeExternalActionResolvedTargetV1(target),
                    method: 'POST', path, body, reviewedChild: child,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'deployments.deploy', target, installationId: controller.installationId,
                        requestId: authorization.binding.requestId, method: 'POST', path, body, reviewedChild: child,
                        privateKey: controller.keys.secretKey }) })).toBeNull();
            }
            expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(0);
        }
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: admissionPath, headers: admissionHeaders, payload: admissionInput });
            expect(response.statusCode, response.body).toBe(200);
            admissions.push(DeploymentReceiptResultV1Schema.parse(response.json()));
        }, { authentication: 'real' });
        const admittedReceipt = admissions[0];
        if (!admittedReceipt?.ok || !('deploymentId' in admittedReceipt)) throw new Error('Expected admitted receipt');
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admittedReceipt.deploymentId } });
        const job: DeploymentChildRpcV1 = { v: 1, actionId: 'deployments.deploy', kind: 'member', input,
            machineId: member.id, installationId: member.installationId, deploymentId: receipt.id, actionOperationId,
            phase: 'activate', selectedDeploymentId: receipt.id};
        const rpc = (params: DeploymentChildRpcV1 = job, privateKey = controller.keys.secretKey) => {
            const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            const externalActionExecution = { v: 1 as const, authorization, effectActionId: 'deployments.deploy', target,
                installationId: controller.installationId, deploymentChildRouting, ...(reviewedChild ? { reviewedChild } : {}), machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target,
                    ...(reviewedChild ? { reviewedChild } : {}),
                    installationId: controller.installationId, method, requestId, params, deploymentChildRouting,
                    event: SOCKET_RPC_EVENTS.CALL, privateKey }) };
            return { method, requestId, params, externalActionExecution, originalActionEnvelope };
        };
        const verify = (params: DeploymentChildRpcV1 = job, privateKey = controller.keys.secretKey) => {
            const request = rpc(params, privateKey);
            return verifyExternalActionMachineRpcExecution(request.externalActionExecution, request);
        };
        return { account, team, controller, member, builder, outsider, environment, link, receipt, input, job, authorization,
            environmentRevision: admittedReceipt.revision,
            originalActionEnvelope, templateInput, rpc, verify, content, admissionInput, admissionHeaders, admissionPath, reviewedChild, workflowActionOrigin,
            accountKeys, memberContentKeys, artifactKeys };
    }

    it.each(['deployments.domains.dns.create', 'deployments.domains.dns.verify'] as const)('retains DNS root %s Environment admission for signed content reads', async actionId => {
        const f = await fixture('team', 'account', { readableEnvironment: true });
        const foreign = await fixture('team', 'account', { readableEnvironment: true });
        const domain = await db.deploymentDomain.create({ data: { environmentId: f.environment.id,
            targetLinkId: f.link.id, createdByAccountId: f.account.id, state: 'pending',
            ...await f.content('deployment-domain.v1') } });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { serverId, environmentId: f.environment.id, domainId: domain.id,
            expectedRevision: f.environmentRevision, expectedDomainRevision: domain.revision, requestKey: crypto.randomUUID(),
            dns: { action: { pluginId: 'happier.dns.route53', localId: 'records-create' },
                credentialRef: { service: { pluginId: 'happier.dns.route53', localId: 'aws' }, accountId: 'selected' }, zoneId: 'selected', ttl: 300 } };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const mint = (environmentId = f.environment.id) => auth.mintExternalActionExecutionAuthorization({
            accountId: f.account.id, serverIdentityId: serverId,
            authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
            machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        }, { input: { ...input, environmentId } });
        const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding: { serverIdentityId: serverId, accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId, requestId: envelope.requestId, target },
            input, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: nacl.randomBytes });
        expect(projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1({ actionId, envelope: sealed })).toBe(f.environment.id);
        const authorization = await mint();
        expect(authorization.binding.environmentId).toBe(f.environment.id);
        await expect(mint(foreign.environment.id)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        const verify = (path: string, routeInput?: unknown, effectActionId: string = actionId) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: authorization.token, effectActionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path, body: undefined, routeInput,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target, installationId: f.controller.installationId,
                requestId: envelope.requestId, method: 'GET', path, privateKey: f.controller.keys.secretKey }),
        });
        for (const [effect, selected] of [['deployments.environments.get', { serverId, environmentId: f.environment.id }],
            ['deployments.domains.get', { serverId, environmentId: f.environment.id, domainId: domain.id }]] as const) {
            const spec = getActionSpec(effect);
            if (!spec.serverTransport) throw new Error('Declared metadata transport required');
            const read = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: selected });
            expect(await verify(read.path, selected, effect)).toMatchObject({
                acceptedDeploymentReceipt: { read: { environmentId: f.environment.id } },
            });
        }
        const foreignRead = { serverId, environmentId: foreign.environment.id };
        const environmentSpec = getActionSpec('deployments.environments.get');
        if (!environmentSpec.serverTransport) throw new Error('Environment transport required');
        const foreignPath = bindHomeDomainHttpRequestV1({ transport: environmentSpec.serverTransport,
            inputSchema: environmentSpec.inputSchema, input: foreignRead }).path;
        expect(await verify(foreignPath, foreignRead, 'deployments.environments.get')).toBeNull();
        const verifyBatch = (artifactIds: string[]) => {
            const body = { artifactIds }, path = '/v1/artifacts/read';
            return verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId: actionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'POST', path, body, routeInput: body,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'POST', path, body, privateKey: f.controller.keys.secretKey }) });
        };
        expect(await verifyBatch([f.environment.contentArtifactId, domain.contentArtifactId])).not.toBeNull();
        expect(await verifyBatch([domain.contentArtifactId, foreign.environment.contentArtifactId])).toBeNull();
        for (const artifactId of [f.environment.contentArtifactId, domain.contentArtifactId])
            expect(await verify('/v1/artifacts/' + encodeURIComponent(artifactId), { id: artifactId })).not.toBeNull();
        const foreignId = foreign.environment.contentArtifactId;
        expect(await verify('/v1/artifacts/' + encodeURIComponent(foreignId), { id: foreignId })).toBeNull();
        // Existing admitted work retains its scope after membership withdrawal; mint is the authority boundary.
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
        expect(await verify('/v1/artifacts/' + encodeURIComponent(domain.contentArtifactId), { id: domain.contentArtifactId })).not.toBeNull();
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it('classifies every deployment root and admits its generated declared read demands only inside its scope', async () => {
        expect([...DEPLOYMENT_ACTION_IDS_V1].sort()).toEqual(DEPLOYMENT_ACTION_SPECS_V1.map(spec => spec.id).sort());
        const f = await fixture('account', 'account', { templateRoot: true });
        const foreign = await fixture();
        const source = await db.projectSource.findUniqueOrThrow({ where: { id: f.environment.projectSourceId } });
        const domain = await db.deploymentDomain.create({ data: { environmentId: f.environment.id,
            targetLinkId: f.link.id, createdByAccountId: f.account.id, state: 'pending', ...await f.content('deployment-domain.v1') } });
        const foreignDomain = await db.deploymentDomain.create({ data: { environmentId: foreign.environment.id,
            targetLinkId: foreign.link.id, createdByAccountId: foreign.account.id, state: 'pending', ...await foreign.content('deployment-domain.v1') } });
        const reads = DEPLOYMENT_ACTION_IDS_V1.map(getActionSpec)
            .filter(spec => spec.sideEffectClass === 'read' && spec.serverTransport !== undefined);
        expect(reads.length).toBeGreaterThan(0);
        // These are generated declared demands at the admission owner, not an
        // execution trace of every daemon branch. Root-specific preparation has
        // its real projection; direct Account reads carry no auxiliary scope.
        const { deploymentPreparationAdmission: _preparation, deploymentChildRoot: _child,
            environmentId: _environment, ...base } = f.authorization.binding;
        const workspace = { kind: 'workspace-ref', serverId, id: 'catalog-coverage-checkout' } as const;
        const sourceInput = { projectSourceId: source.id, sourceRevision: source.revision };
        const demands = [
            { actionId: 'deployments.environments.get', own: { environmentId: f.environment.id }, foreign: { environmentId: foreign.environment.id } },
            { actionId: 'deployments.receipts.get', own: { environmentId: f.environment.id, deploymentId: f.receipt.id },
                foreign: { environmentId: f.environment.id, deploymentId: foreign.receipt.id } },
            { actionId: 'deployments.receipts.list', own: { environmentId: f.environment.id }, foreign: { environmentId: foreign.environment.id } },
            { actionId: 'deployments.domains.get', own: { environmentId: f.environment.id, domainId: domain.id },
                foreign: { environmentId: f.environment.id, domainId: foreignDomain.id } },
            { actionId: 'deployments.domains.list', own: { environmentId: f.environment.id }, foreign: { environmentId: foreign.environment.id } },
        ] as const;
        for (const actionId of DEPLOYMENT_ACTION_IDS_V1) {
            const root = getActionSpec(actionId);
            if (root.sideEffectClass === 'read' && root.serverTransport === undefined) {
                expect(isDeploymentReadPreparation({ ...f.authorization.binding, actionId }, actionId),
                    `${actionId} must retain its native purpose for non-storage preparation`).toBe(false);
            }
            for (const read of reads) {
                expect(isDeploymentReadPreparation({ ...f.authorization.binding, actionId }, read.id),
                    `${actionId} must send sibling ${read.id} to the scope owner and retain its own transport`).toBe(actionId !== read.id);
            }
            const preparation = projectDeploymentPreparationAdmissionV1(actionId,
                actionId === 'deployments.templates.instantiate' ? { ...f.templateInput, deploy: undefined,
                    destination: { kind: 'repositoryPullRequest', workspace } }
                : actionId === 'deployments.environments.create' ? { ...sourceInput, mode: 'preview', requestKey: crypto.randomUUID(),
                    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', definition: { from: 'compose' } }
                : { ...sourceInput, environmentId: f.environment.id, workspace,
                    machineId: f.controller.id, installationId: f.controller.installationId });
            const directRead = actionId === 'deployments.environments.get' || actionId === 'deployments.environments.list';
            const sourceOnly = actionId === 'deployments.publish.prepare' || actionId === 'deployments.environments.create';
            const binding = { ...base, actionId,
                ...(!preparation && !directRead ? { environmentId: f.environment.id } : {}),
                ...(preparation ? { deploymentPreparationAdmission: preparation } : {}),
                ...(actionId === 'deployments.targets.link' ? { deploymentLinkAdmission: {
                    environmentId: f.environment.id, owner: { kind: 'account' as const, accountId: f.account.id } } } : {}) };
            const expected = directRead ? null : !sourceOnly;
            for (const [sourceId, admitted] of [[source.id, directRead ? null : actionId !== 'deployments.teardown'],
                [foreign.environment.projectSourceId, directRead ? null : false]] as const) {
                const proof = { method: 'GET',
                    path: `/v1/projects/sources/${encodeURIComponent(sourceId)}?serverId=${encodeURIComponent(serverId)}`,
                    routeInput: { serverId, id: sourceId } };
                const operands = readDeploymentSourceReadOperands(serverId, proof);
                expect(operands, `${actionId} must decode its exact Source HTTP demand`).not.toBeNull();
                expect(await inTx(tx => isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, operands,
                    undefined, undefined, 'projects.sources.read')), `${actionId} Source read: ${sourceId}`).toBe(admitted);
                expect(readDeploymentSourceReadOperands(serverId, { ...proof,
                    path: `/v1/projects/sources/${encodeURIComponent(sourceId)}?serverId=foreign-home` })).toBeNull();
            }
            for (const demand of demands) {
                const spec = getActionSpec(demand.actionId);
                if (!spec.serverTransport) throw new Error(`${demand.actionId} has no declared transport`);
                for (const [input, admitted] of [
                    [{ serverId, ...demand.own }, expected],
                    [{ serverId, ...demand.foreign }, directRead ? null : false],
                    [{ serverId: 'foreign-home', ...demand.own }, false],
                ] as const) {
                    const parsed = spec.inputSchema.parse(input);
                    const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: parsed });
                    const proof = { ...request, routeInput: parsed };
                    expect(await inTx(tx => isDeploymentReadOperandInAdmittedScopeInTx(tx, binding, parsed,
                        undefined, undefined, demand.actionId)), `${actionId} → ${demand.actionId}: ${request.path}`).toBe(admitted);
                    if (demand.actionId === 'deployments.environments.get') {
                        expect(await inTx(tx => isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding, proof)),
                            `${actionId} exact Environment HTTP purpose: ${request.path}`).toBe(admitted === true);
                        expect(await inTx(tx => isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(tx, binding,
                            { ...proof, path: `${request.path}&unexpected=operand` })), `${actionId} must bind the declared HTTP path`).toBe(false);
                    }
                }
            }
            // An unfiltered Environment inventory is not a substitute for the
            // exact selected-row reads above. Only the existing preview/update
            // projection owns a positive list demand (covered by its scenarios).
            expect(await inTx(tx => isDeploymentReadOperandInAdmittedScopeInTx(tx, binding,
                { serverId }, undefined, undefined, 'deployments.environments.list'))).toBe(false);
            if (preparation?.operation === 'template' || preparation?.operation === 'prepare') {
                const body = { key: workspace };
                const proof = { method: 'POST', path: '/v1/account/project-rows/read', body, routeInput: body };
                expect(await inTx(tx => isDeploymentPreparationHttpPurposeInTx(tx, binding, actionId, proof, {})),
                    `${actionId} must reopen its projected workspace`).toBe(true);
                const wrongHome = { key: { ...workspace, serverId: 'foreign-home' } };
                expect(await inTx(tx => isDeploymentPreparationHttpPurposeInTx(tx, binding, actionId,
                    { ...proof, body: wrongHome, routeInput: wrongHome }, {}))).toBe(false);
            }
        }
    });

    it.each([['plain', 'attach'], ['e2ee', 'attach'], ['plain', 'create'], ['e2ee', 'create']] as const)(
        'admits Move on its selected workspace without a runtime Link and scopes signed reads (%s, %s)', async (contentMode, repositoryIntent) => {
        const f = await fixture('account', 'account', { readableEnvironment: true, workflowOrigin: true, contentMode,
            sourceWithoutRepository: true });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { runtimeTargetLinkId: null } });
        const actionId = DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1;
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'child/app' };
        const sourceRepository = ProjectSourceRepositorySelectorV1Schema.parse({
            protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'child/app', cloneUrl: 'https://github.com/child/app.git' },
        });
        const input = getActionSpec(actionId).inputSchema.parse({ mode: 'apply', serverId, environmentId: f.environment.id,
            definition: { contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, path: 'compose.yaml',
            workspace: { kind: 'workspace-ref', serverId, id: 'selected-workspace' },
            ...(repositoryIntent === 'create' ? { createRepository: {
                providerKind: 'github', owner: 'child', repositoryName: 'app', visibility: 'private',
            } } : { repository, sourceRepository, baseBranch: 'main', baseCommit: 'a'.repeat(40) }) });
        const requestId = crypto.randomUUID();
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const envelope = contentMode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding: { serverIdentityId: serverId, accountId: f.account.id, authentication, actionId, requestId, target }, input,
            material: { type: 'dataKey', machineKey: f.member.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input };
        const environmentId = projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, machineId: f.member.id, target, requestId,
            workflowActionOrigin: { ...f.workflowActionOrigin!, requestId },
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, {
            input: envelope.v === 1 ? input : { environmentId },
        });
        expect(authorization.binding.environmentId).toBe(f.environment.id);
        const headers = (effectActionId: string, path: string, method = 'GET', body?: unknown) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target, installationId: f.member.installationId, requestId,
                method, path, body, privateKey: f.member.keys.secretKey }),
        });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const path = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`;
            const response = await app.inject({ method: 'GET', url: path, headers: headers('deployments.environments.get', path) });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, environment: { id: f.environment.id } });
            const other = `/v1/deployments/environments/${crypto.randomUUID()}?serverId=${serverId}`;
            expect((await app.inject({ method: 'GET', url: other, headers: headers('deployments.environments.get', other) })).statusCode).toBe(401);
        }, { authentication: 'real' });
        const verify = (effectActionId: string, method: string, path: string, body?: unknown,
            reviewedChild?: ReviewedActionChildHttpProofV1) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: authorization.token, effectActionId, encodedTarget: encodeExternalActionResolvedTargetV1(target),
            method, path, body, reviewedChild,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target, installationId: f.member.installationId, requestId,
                method, path, body, reviewedChild, privateKey: f.member.keys.secretKey }),
        });
        const sourcePath = `/v1/projects/sources/${f.environment.projectSourceId}?serverId=${serverId}`;
        expect(await verify('projects.sources.read', 'GET', sourcePath)).not.toBeNull();
        expect(await verify('projects.sources.read', 'GET', `/v1/projects/sources/unrelated?serverId=${serverId}`)).toBeNull();
        const sourceUpdate = ProjectSourcesUpdateInputV1Schema.parse({ serverId, sourceId: f.environment.projectSourceId,
            expectedRevision: 1, patch: { repository: sourceRepository } });
        const sourceUpdatePath = `/v1/projects/sources/${f.environment.projectSourceId}`;
        expect(await verify('projects.sources.update', 'PATCH', sourceUpdatePath, sourceUpdate)).not.toBeNull();
        expect(await verify('projects.sources.update', 'PATCH', sourceUpdatePath, {
            ...sourceUpdate, patch: { name: 'unreviewed rename' },
        })).toBeNull();
        const currentContent = `/v1/artifacts/${f.environment.contentArtifactId}`;
        expect(await verify(actionId, 'GET', currentContent)).not.toBeNull();
        expect(await verify(actionId, 'GET', `/v1/artifacts/${f.receipt.contentArtifactId}`)).toBeNull();
        const stored = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: f.account.id,
            artifactId: f.environment.contentArtifactId }));
        if (!stored.ok) throw new Error(stored.error);
        if (!stored.artifact.dataEncryptionKey) throw new Error('Environment fixture requires its content key envelope');
        const artifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding, environmentId: f.environment.id });
        const publication = ArtifactJsonCreateHttpInputV1Schema.parse({ id: artifactId,
            kind: 'v1:other:deployment-environment.v1', header: privacyKit.encodeBase64(new Uint8Array(stored.artifact.header)),
            body: privacyKit.encodeBase64(new Uint8Array(stored.artifact.body)),
            dataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(stored.artifact.dataEncryptionKey)) });
        expect(await verify(actionId, 'POST', '/v1/artifacts', publication)).not.toBeNull();
        expect(await verify(actionId, 'POST', '/v1/artifacts', { ...publication, id: crypto.randomUUID() })).toBeNull();
        const workspaceRead = { key: { kind: 'workspace-ref' as const, serverId, id: 'selected-workspace' } };
        expect(await verify(actionId, 'POST', '/v1/account/project-rows/read', workspaceRead)).not.toBeNull();
        expect(await verify(actionId, 'POST', '/v1/account/project-rows/read', {
            key: { kind: 'project-organization', serverId, projectKey: 'unrelated' },
        })).toBeNull();
        expect(await verify(actionId, 'POST', '/v1/account/project-rows/list', {
            kinds: ['workspace-ref', 'relationship-graph'],
        })).not.toBeNull();
        expect(await verify(actionId, 'POST', '/v1/account/project-rows/list', {
            kinds: ['project-organization'],
        })).toBeNull();
        const rowCipher = createProjectAccountRowCipherV1({ mode: contentMode,
            material: contentMode === 'plain' ? null : { type: 'dataKey', machineKey: f.accountKeys.secretKey },
            randomBytes: nacl.randomBytes });
        const workspaceValue = { id: 'selected-workspace', serverId, rootPath: '/repo', machineId: f.member.id, createdAtMs: 1 };
        const workspaceContent = rowCipher.seal({ key: workspaceRead.key, value: workspaceValue });
        const workspaceMutation = ProjectAccountRowMutationRequestV1Schema.parse({
            mutations: [{ key: workspaceRead.key, expectedRevision: 'absent', content: workspaceContent }],
            expectedRefs: [], topologyChange: false });
        expect(await verify(actionId, 'POST', '/v1/account/project-rows/mutate', workspaceMutation)).not.toBeNull();
        expect(await verify(actionId, 'POST', '/v1/account/project-rows/mutate', {
            ...workspaceMutation, mutations: [{ ...workspaceMutation.mutations[0], content: null }],
        })).toBeNull();
        await withAuthenticatedTestApp(app => { projectSourceRoutes(app); registerProjectAccountRowRoutes(app); }, async app => {
            const before = await app.inject({ method: 'GET', url: sourcePath, headers: headers('projects.sources.read', sourcePath) });
            expect(before.statusCode, before.body).toBe(200);
            expect(before.json()).toMatchObject({ ok: true, source: { id: f.environment.projectSourceId, revision: 1 } });
            expect(before.json().source.repository).toBeUndefined();
            const attached = await app.inject({ method: 'PATCH', url: sourceUpdatePath, payload: sourceUpdate,
                headers: headers('projects.sources.update', sourceUpdatePath, 'PATCH', sourceUpdate) });
            expect(attached.statusCode, attached.body).toBe(200);
            const attachedSource = ProjectSourcesReadOutputV1Schema.parse(attached.json());
            expect(attachedSource).toMatchObject({ ok: true, source: { id: f.environment.projectSourceId,
                name: 'Child deployment', revision: 2, repository: sourceUpdate.patch.repository } });
            if (!attachedSource.ok) throw new Error(attachedSource.error);
            const staleSource = await app.inject({ method: 'PATCH', url: sourceUpdatePath, payload: sourceUpdate,
                headers: headers('projects.sources.update', sourceUpdatePath, 'PATCH', sourceUpdate) });
            expect(staleSource.statusCode, staleSource.body).toBe(409);
            expect(staleSource.json()).toMatchObject({ ok: false, error: 'source_conflict' });

            const graphKey = { kind: 'relationship-graph' } as const;
            const initialRows = ProjectAccountRowMutationRequestV1Schema.parse({ ...workspaceMutation, topologyChange: true,
                mutations: [...workspaceMutation.mutations, { key: graphKey, expectedRevision: 'absent',
                    content: rowCipher.seal({ key: graphKey, value: { relationships: [] } }) }] });
            const accountToken = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const seed = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', payload: initialRows,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${accountToken}` } });
            expect(seed.statusCode, seed.body).toBe(200);
            const seeded = ProjectAccountRowMutationResponseV1Schema.parse(seed.json());
            expect(seeded.status).toBe('updated');
            if (seeded.status !== 'updated') throw new Error(seeded.status);
            const workspace = seeded.rows.find(row => row.key.kind === 'workspace-ref' && row.key.id === workspaceRead.key.id);
            if (!workspace) throw new Error('Workspace row missing from canonical seed response');
            const acceptedValue = { ...workspaceValue, repositoryIdentity: repository,
                source: { sourceId: attachedSource.source.id, revision: attachedSource.source.revision } };
            const acceptance = ProjectAccountRowMutationRequestV1Schema.parse({ mutations: [{ key: workspaceRead.key,
                expectedRevision: workspace.revision, content: rowCipher.seal({ key: workspaceRead.key, value: acceptedValue }) }],
                expectedRefs: [], topologyChange: false });
            const mutationPath = '/v1/account/project-rows/mutate';
            const accepted = await app.inject({ method: 'POST', url: mutationPath, payload: acceptance,
                headers: headers(actionId, mutationPath, 'POST', acceptance) });
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toMatchObject({ status: 'updated' });
            const staleWorkspace = await app.inject({ method: 'POST', url: mutationPath, payload: acceptance,
                headers: headers(actionId, mutationPath, 'POST', acceptance) });
            expect(staleWorkspace.statusCode, staleWorkspace.body).toBe(200);
            expect(staleWorkspace.json()).toMatchObject({ status: 'conflict', key: workspaceRead.key });
            const readPath = '/v1/account/project-rows/read';
            const read = await app.inject({ method: 'POST', url: readPath, payload: workspaceRead,
                headers: headers(actionId, readPath, 'POST', workspaceRead) });
            expect(read.statusCode, read.body).toBe(200);
            const acceptedRow = ProjectAccountRowReadResponseV1Schema.parse(read.json());
            expect(acceptedRow.status).toBe('present');
            if (acceptedRow.status !== 'present' || !acceptedRow.row.content) throw new Error('Accepted Workspace row is unavailable');
            expect(rowCipher.open(workspaceRead.key, acceptedRow.row.content)).toMatchObject({ key: workspaceRead.key, value: acceptedValue });
        }, { authentication: 'real' });
        const update = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const child = { actionId: 'deployments.environments.update' as const, role: 'move.definition',
            inputDigest: computeActionInputApprovalDigestV1('deployments.environments.update', update) };
        const updatePath = `/v1/deployments/environments/${f.environment.id}`;
        expect(await verify(child.actionId, 'PATCH', updatePath, update, child)).not.toBeNull();
        expect(await verify(child.actionId, 'PATCH', updatePath, update)).toBeNull();
        expect(await verify(child.actionId, 'PATCH', updatePath, update, { ...child, role: 'template.bindings' })).toBeNull();
        expect(await verify(child.actionId, 'PATCH', updatePath, { ...update, expectedRevision: update.expectedRevision + 1 }, child)).toBeNull();
        for (const substituted of [
            { ...update, environmentId: crypto.randomUUID() },
            { ...update, contentArtifactId: f.environment.contentArtifactId },
            { ...update, patch: { protection: 'production' } },
        ]) {
            const substitutedChild = { ...child, inputDigest: computeActionInputApprovalDigestV1(child.actionId, substituted) };
            expect(await verify(child.actionId, 'PATCH', updatePath, substituted, substitutedChild)).toBeNull();
        }
        expect(await verify(child.actionId, 'PATCH', `${updatePath}/unrelated`, update, child)).toBeNull();
        const candidate = await createArtifact({ actorUserId: f.account.id, artifactId,
            kind: publication.kind, header: new Uint8Array(stored.artifact.header), body: new Uint8Array(stored.artifact.body),
            dataEncryptionKey: new Uint8Array(stored.artifact.dataEncryptionKey) });
        if (!candidate.ok) throw new Error(candidate.error);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const signedHeaders = { ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: child.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(child),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: child.actionId, target, installationId: f.member.installationId, requestId,
                    method: 'PATCH', path: updatePath, body: update, reviewedChild: child, privateKey: f.member.keys.secretKey }),
            };
            const response = await app.inject({ method: 'PATCH', url: updatePath, headers: signedHeaders, payload: update });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, environmentId: f.environment.id, revision: f.environmentRevision + 1 });
            expect((await app.inject({ method: 'PATCH', url: updatePath, headers: signedHeaders, payload: update })).statusCode).toBe(409);
            expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } })).toMatchObject({
                contentArtifactId: artifactId, controllerMachineId: f.controller.id, runtimeTargetLinkId: null,
            });
        }, { authentication: 'real' });
        await db.automationRun.update({ where: { id: f.workflowActionOrigin!.runId }, data: { state: 'cancelled' } });
        expect(await hasCurrentDeploymentWorkflowOriginInTx(db, authorization.binding, undefined, 'execution')).toBe(false);
    });

    it('requires definition Manage for Move even when the requester can deploy', async () => {
        const f = await fixture('team');
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
            data: { role: 'member' } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { deployerMode: 'members' } });
        const actionId = DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1;
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const input = getActionSpec(actionId).inputSchema.parse({ mode: 'preview', serverId, environmentId: f.environment.id,
            definition: { contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, path: 'compose.yaml',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'child/app' },
            workspace: { kind: 'workspace-ref', serverId, id: 'selected-workspace' }, baseBranch: 'main', baseCommit: 'a'.repeat(40) });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        await expect(auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId, accountId: f.account.id,
            authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId, machineId: f.member.id, target,
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        }, { input })).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it('admits reviewed remote read-role setup only on the current serving member and limits child reads', async () => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true });
        await db.machineTeamGrant.updateMany({ where: { machineId: f.member.id, teamId: f.team!.id }, data: { accessLevel: 'admin' } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
        const use = { purpose: 'dataRole' as const, service: 'database', role: 'readOnlyPassword' as const,
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('read-role-resource'), resourceRevision: 1 } };
        const input = getActionSpec('deployments.bindings.set').inputSchema.parse({ serverId,
            environmentId: f.environment.id, expectedRevision: f.environmentRevision, set: [use], remove: [] });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.bindings.set', machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', machineId: f.member.id,
            installationId: f.member.installationId, environmentId: f.environment.id,
            resourceId: 'read-role-resource', resourceRevision: 1 }, installationPublicKey: f.member.keys.publicKey,
            content: { kind: 'secret', value: 'private-read-password' } });
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'dataRole', actionId: 'deployments.bindings.set',
            machineId: f.member.id, installationId: f.member.installationId, input, targetLinkId: f.link.id,
            deploymentId: f.receipt.id, service: 'database', use, grant });
        const routing = projectDeploymentChildRoutingV1(job);
        if (routing.kind !== 'dataRole') throw new Error('Read-role child required');
        const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
        const packet = { v: 1 as const, authorization, effectActionId: job.actionId, target,
            installationId: f.controller.installationId, deploymentChildRouting: routing,
            machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                effectActionId: job.actionId, target, installationId: f.controller.installationId,
                method, requestId, params: job, deploymentChildRouting: routing,
                event: SOCKET_RPC_EVENTS.CALL, privateKey: f.controller.keys.secretKey }) };
        expect(await verifyExternalActionMachineRpcExecution(packet, { method, requestId, params: job,
            originalActionEnvelope: envelope })).toMatchObject({ effectActionId: job.actionId });
        expect(await readDeploymentChildAdmissionInTx(db, authorization.binding, routing)).toMatchObject({ routing });
        expect(await readDeploymentChildAdmissionInTx(db, authorization.binding,
            { ...routing, installationId: f.outsider.installationId })).toBeNull();
        expect(await readDeploymentChildAdmissionInTx(db, authorization.binding,
            { ...routing, input: { ...routing.input, expectedRevision: f.environmentRevision + 1 } })).toBeNull();
        const receiptInput = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id };
        const spec = getActionSpec('deployments.receipts.get');
        if (!spec.serverTransport) throw new Error('Receipt transport required');
        const path = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema,
            input: receiptInput }).path;
        const prepareRead = (readPath: string, routeInput: unknown) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: authorization.token, effectActionId: 'deployments.receipts.get',
            encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path: readPath,
            routeInput, body: undefined, machineSignature: signExternalActionMachineRequestV1({
                authorizationToken: authorization.token, effectActionId: 'deployments.receipts.get', target,
                installationId: f.controller.installationId, requestId: authorization.binding.requestId,
                method: 'GET', path: readPath, privateKey: f.controller.keys.secretKey }) });
        expect.soft(await prepareRead(path, receiptInput)).not.toBeNull();
        expect(await prepareRead(path, { ...receiptInput, environmentId: crypto.randomUUID() })).toBeNull();
        expect(await isDeploymentChildHttpPurposeInTx(db, routing, { method: 'GET', path,
            body: undefined, routeInput: receiptInput })).toBe(true);
        expect(await isDeploymentChildHttpPurposeInTx(db, routing, { method: 'POST',
            path: `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`,
            body: { ...receiptInput, materialization: { kind: 'dataRole' } } })).toBe(false);
        const child = { method, requestId, params: job, originalActionEnvelope: envelope, externalActionExecution: packet };
        const read = (readPath: string, routeInput?: unknown, effectActionId: string = job.actionId) =>
            verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path: readPath,
                routeInput, body: undefined, deploymentChildExecution: createDeploymentChildExecutionProofV1(child),
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId: f.member.installationId,
                    requestId: authorization.binding.requestId, method: 'GET', path: readPath,
                    deploymentChildExecution: child, privateKey: f.member.keys.secretKey }) });
        expect.soft(await read(path, receiptInput, 'deployments.receipts.get')).not.toBeNull();
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
        const reads: { model?: string; action: string }[] = [];
        const stopReads = observeSqliteRequests({ before: request => { reads.push({ model: request.model, action: request.action }); } });
        try {
            expect.soft(await read(path, receiptInput, 'deployments.receipts.get')).not.toBeNull();
            expect.soft(await read(`/v1/artifacts/${f.receipt.contentArtifactId}`, { id: f.receipt.contentArtifactId })).not.toBeNull();
        } finally { stopReads(); }
        expect.soft(reads.filter(row => ['Account', 'TeamMembership', 'ProjectSource', 'ApiToken'].includes(row.model ?? ''))).toEqual([]);
        expect(await verifyExternalActionMachineRpcExecution(packet, { method, requestId, params: job,
            originalActionEnvelope: envelope })).toBeNull();
        expect(await read(`/v1/artifacts/${crypto.randomUUID()}`)).toBeNull();
        expect(await read(path, { ...receiptInput, environmentId: crypto.randomUUID() })).toBeNull();
        expect(await read(path, receiptInput, 'deployments.deploy')).toBeNull();
        const receiverHeaders = (readPath: string) => ({ ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: job.actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(child),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                authorizationToken: authorization.token, effectActionId: job.actionId, target,
                installationId: f.member.installationId, requestId: authorization.binding.requestId,
                method: 'GET', path: readPath, deploymentChildExecution: child, privateKey: f.member.keys.secretKey }) });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: path, headers: receiverHeaders(path) });
            expect.soft(response.statusCode, response.body).toBe(200);
            expect.soft(response.json()).toMatchObject({ ok: true, deployment: { id: f.receipt.id } });
        }, { authentication: 'real' });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const artifactPath = `/v1/artifacts/${f.receipt.contentArtifactId}`;
            const response = await app.inject({ method: 'GET', url: artifactPath, headers: receiverHeaders(artifactPath) });
            expect.soft(response.statusCode, response.body).toBe(200);
        }, { authentication: 'real' });
    });

    it('opens only the persisted preview parent Domain under an ordinary signed Deploy root', async () => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        const template = await db.deploymentEnvironment.create({ data: {
            projectSourceId: f.environment.projectSourceId, createdByAccountId: f.account.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.controller.id, buildMachineId: f.builder.id,
            ...await f.content('deployment-environment.v1'),
        } });
        const runtime = await db.deploymentTargetLink.create({ data: { environmentId: template.id,
            createdByAccountId: f.account.id, role: 'runtime', state: 'configured',
            sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
            ...await f.content('deployment-target-link.v1'),
            machines: { create: [{ machineId: f.member.id, installationId: f.member.installationId,
                position: 0, state: 'active' }] },
        } });
        await db.deploymentEnvironment.update({ where: { id: template.id }, data: { runtimeTargetLinkId: runtime.id } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: {
            purpose: 'preview', previewTemplateEnvironmentId: template.id,
            previewRepositoryId: f.environment.projectSourceId, previewPullRequestId: '17', previewTargetLinkId: runtime.id,
        } });
        const domain = await db.deploymentDomain.create({ data: { environmentId: template.id,
            targetLinkId: runtime.id, createdByAccountId: f.account.id, state: 'pending',
            ...await f.content('deployment-domain.v1'),
        } });
        const childDomain = await db.deploymentDomain.create({ data: { environmentId: f.environment.id,
            targetLinkId: f.link.id, createdByAccountId: f.account.id, state: 'pending',
            ...await f.content('deployment-domain.v1'),
        } });
        const foreign = await fixture();
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = (environmentId: string, domainId: string, root = f, key = root.controller.keys.secretKey) => {
                const path = `/v1/deployments/environments/${environmentId}/domains/${domainId}?serverId=${serverId}`;
                const effectActionId = 'deployments.domains.get';
                return app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: root.authorization.token, effectActionId, target: root.authorization.binding.target,
                        installationId: root.controller.installationId, requestId: root.authorization.binding.requestId,
                        method: 'GET', path, privateKey: key }),
                } });
            };
            const selected = await read(template.id, domain.id);
            expect(selected.statusCode, selected.body).toBe(200);
            expect(selected.json()).toMatchObject({ ok: true, domain: { id: domain.id, environmentId: template.id } });
            const own = await read(f.environment.id, childDomain.id);
            expect(own.statusCode, own.body).toBe(200);
            for (const request of [() => read(foreign.environment.id, domain.id),
                () => read(template.id, domain.id, foreign),
                () => read(template.id, domain.id, f, foreign.controller.keys.secretKey)]) {
                const refused = await request();
                expect(refused.statusCode, refused.body).toBe(401);
            }
            // A Domain locator cannot borrow the parent relation for a different row.
            const wrongRow = await read(template.id, childDomain.id);
            expect(wrongRow.statusCode, wrongRow.body).toBe(404);
            for (const data of [
                { purpose: 'standard', previewTemplateEnvironmentId: null, previewRepositoryId: null,
                    previewPullRequestId: null, previewTargetLinkId: null },
                { purpose: 'preview', previewTemplateEnvironmentId: foreign.environment.id,
                    previewRepositoryId: f.environment.projectSourceId, previewPullRequestId: '17', previewTargetLinkId: runtime.id },
            ] as const) {
                await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data });
                const staleParent = await read(template.id, domain.id);
                expect(staleParent.statusCode, staleParent.body).toBe(401);
                expect(staleParent.json()).toMatchObject({ authorizationRefusal: 'deployment_metadata_environment' });
            }
        }, { authentication: 'real' });
    });

    it('reconciles joining membership under an accepted existing-Environment template Deploy root', async () => {
        const f = await fixture('account', 'account', { templateRoot: true });
        await db.deploymentTargetLinkMachine.updateMany({ where: { targetLinkId: f.link.id }, data: { state: 'joining' } });
        const domainInput = { serverId, environmentId: f.environment.id, domainId: crypto.randomUUID(),
            expectedRevision: f.environmentRevision, targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
            ...await f.content('deployment-domain.v1'), placements: [{ machineId: f.member.id,
                installationId: f.member.installationId, nativeServer: 'private' as const,
                listener: 'privateOrigin' as const, dockerEngineId: 'membership-engine' }] };
        const created = await inTx(tx => createDeploymentDomainInTx(tx, f.account.id, domainInput));
        if (!created.ok) throw new Error(created.error);
        const prepared = { serverId, environmentId: f.environment.id, domainId: domainInput.domainId,
            expectedRevision: created.revision, expectedDomainRevision: created.domain.revision,
            targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
            contentArtifactId: created.domain.contentArtifactId, contentHeaderVersion: created.domain.contentHeaderVersion,
            contentBodyVersion: created.domain.contentBodyVersion, requestKey: crypto.randomUUID(),
            membershipDeploymentId: f.receipt.id,
            membershipMachines: [{ machineId: f.member.id, installationId: f.member.installationId }] };
        const target = f.originalActionEnvelope.target;
        const verifyChild = (params: DeploymentChildRpcV1) => {
            const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            const externalActionExecution = { v: 1 as const, authorization: f.authorization,
                effectActionId: 'deployments.domains.add', target, installationId: f.controller.installationId,
                deploymentChildRouting, machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: f.authorization.token, effectActionId: 'deployments.domains.add', target,
                    installationId: f.controller.installationId, method, requestId, params, deploymentChildRouting,
                    privateKey: f.controller.keys.secretKey }) };
            return verifyExternalActionMachineRpcExecution(externalActionExecution,
                { method, requestId, params, originalActionEnvelope: f.originalActionEnvelope });
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const path = `/v1/deployments/environments/${f.environment.id}/domains`;
            const payload = { ...prepared, requestId: f.authorization.binding.requestId,
                actionOperationId: f.receipt.actionOperationId!, placements: domainInput.placements };
            const request = (body = payload) => app.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: f.authorization.token, effectActionId: 'deployments.domains.add', target,
                    installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                    method: 'POST', path, body, privateKey: f.controller.keys.secretKey }),
            } });
            const response = await request();
            expect(response.statusCode, response.body).toBe(200);
            expect((await request({ ...payload, membershipDeploymentId: 'foreign-receipt' })).statusCode).toBe(403);
            const added = DeploymentDomainMutationResultV1Schema.parse(response.json());
            if (!added.ok) throw new Error(added.error);
            const capture = added.domain.placements![0]!;
            expect(capture.placement.requestId).toBe(f.authorization.binding.requestId);
            const native = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.add',
                input: { serverId, environmentId: f.environment.id, domainId: domainInput.domainId },
                machineId: f.member.id, installationId: f.member.installationId, expectedDomainRevision: added.domain.revision,
                actionOperationId: f.receipt.actionOperationId!, capture });
            expect(await verifyChild(native)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domain' } } });
        }, { authentication: 'real' });
        const discovery = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add',
            input: prepared, machineId: f.member.id, installationId: f.member.installationId });
        expect(await verifyChild(discovery)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domainDiscover' } } });
        expect(await verifyChild({ ...discovery, installationId: 'wrong-installation' })).toBeNull();
    });

    it('explains the persisted #76 controller mismatch for teardown and Domain Remove without substituting Machines', async () => {
        // Persisted QA-DOMAIN-1104 persisted-g-{preread,teardown,domain-remove}-r76 fixtures.
        // Keys are freshly generated at the installation boundary; placement and CAS facts retain the captured values.
        const f = await fixture('account', 'account', { persistedR76Placement: true });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { revision: 5 } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { revision: 2 } });
        await db.deploymentTargetLinkMachine.deleteMany({ where: { targetLinkId: f.link.id } });
        await db.deploymentTargetLinkMachine.create({ data: { targetLinkId: f.link.id, machineId: f.controller.id,
            installationId: f.controller.installationId, position: 0, state: 'active' } });
        const content = await f.content('deployment-domain.v1');
        const removeInput = { serverId, environmentId: f.environment.id, expectedRevision: 5,
            domainId: 'qa-domain-1104-r73-g-domain', expectedDomainRevision: 1,
            requestKey: 'qa-domain-1104-r76-persisted-g-remove' };
        await db.deploymentDomain.create({ data: { id: removeInput.domainId, environmentId: f.environment.id,
            targetLinkId: f.link.id, state: 'pending', createdByAccountId: f.account.id, ...content } });
        const details = { reason: 'controller_placement_mismatch', requiredFact: `controllerMachineId=${f.controller.id}`,
            remedy: `Run this action on Machine ${f.controller.id}, or make that controller reachable, then retry` };
        const failureCause = { phase: 'deployment.controller.placement', errorCode: 'credential_scope_denied' };
        const target = { kind: 'machine' as const, machineId: f.outsider.id };
        const teardown = { v: 1 as const, requestId: 'qa-domain-1104-persisted-g-teardown-r76', target,
            input: { serverId, environmentId: f.environment.id, targetLinkId: f.link.id,
                requestKey: 'qa-domain-1104-r76-retained-g-teardown', reason: 'decommission' } };
        await withAuthenticatedTestApp(registerExternalActionRoutes, async app => {
            const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const response = await app.inject({ method: 'POST',
                url: '/v1/actions/deployments.teardown/execution-authorization',
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: f.outsider.id, envelope: teardown } });
            expect(response.statusCode, response.body).toBe(403);
            expect.soft(response.json()).toMatchObject({ error: 'credential_scope_denied', details, failureCause });
        }, { authentication: 'real' });
        const requestId = 'qa-domain-1104-persisted-g-domain-remove-r76';
        const envelope = { v: 1 as const, requestId, target, input: removeInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.domains.remove', machineId: f.outsider.id, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: removeInput });
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.remove',
            input: { ...removeInput, ...content, targetLinkId: f.link.id, expectedTargetLinkRevision: 2 },
            machineId: f.controller.id, installationId: f.controller.installationId });
        const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
        const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
        const source = { method, requestId, params: job, originalActionEnvelope: envelope, externalActionExecution: {
            v: 1 as const, authorization, effectActionId: job.actionId, target,
            installationId: f.outsider.installationId, deploymentChildRouting,
            machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                effectActionId: job.actionId, target, installationId: f.outsider.installationId,
                method, requestId, params: job, deploymentChildRouting, privateKey: f.outsider.keys.secretKey }) } };
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const path = `/v1/machines/${f.controller.id}`;
            const response = await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: job.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: job.actionId, target, installationId: f.outsider.installationId,
                    requestId, method: 'GET', path, body: undefined, deploymentChildExecution: source,
                    privateKey: f.outsider.keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(401);
            expect(response.json()).toMatchObject({ error: 'invalid_token', details, failureCause });
            expect(response.json()).not.toHaveProperty('machine');
        }, { authentication: 'real' });
        expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } }))
            .toMatchObject({ revision: 5, controllerMachineId: f.controller.id });
        expect(await db.deploymentDomain.findUnique({ where: { id: removeInput.domainId } }))
            .toMatchObject({ revision: 1, state: 'pending', deletedAt: null });
    });

    it.each(['vercel', 'workers'] as const)('admits the accepted %s root Environment and Source reads without borrowing a native review child', async platformTarget => {
        const f = await fixture('account', 'account', { platformTarget });
        const effectActionId = 'deployments.deploy' as const;
        const target = f.authorization.binding.target;
        const path = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`;
        const review = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: effectActionId,
            input: f.input, machineId: f.builder.id, installationId: f.builder.installationId });
        const packet = f.rpc(review);
        const sibling = await db.deploymentEnvironment.create({ data: { projectSourceId: f.environment.projectSourceId,
            createdByAccountId: f.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.controller.id, ...await f.content('deployment-environment.v1') } });
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); projectSourceRoutes(app); }, async app => {
            const sourcePath = `/v1/projects/sources/${f.environment.projectSourceId}?serverId=${serverId}`;
            const sourceEffect = 'projects.sources.read';
            const sourceRead = await app.inject({ method: 'GET', url: sourcePath, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: sourceEffect,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: f.authorization.token, effectActionId: sourceEffect, target,
                    installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                    method: 'GET', path: sourcePath, privateKey: f.controller.keys.secretKey }),
            } });
            expect(sourceRead.statusCode, sourceRead.body).toBe(200);
            expect(sourceRead.json()).toMatchObject({ ok: true, source: { id: f.environment.projectSourceId } });
            for (const nativeChild of [false, true]) {
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    ...(nativeChild ? { [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet) } : {}),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: f.authorization.token, effectActionId, target,
                        installationId: nativeChild ? f.builder.installationId : f.controller.installationId,
                        requestId: f.authorization.binding.requestId, method: 'GET', path,
                        ...(nativeChild ? { deploymentChildExecution: packet } : {}),
                        privateKey: nativeChild ? f.builder.keys.secretKey : f.controller.keys.secretKey }),
                } });
                // A platform continuation spends its accepted root. The native
                // review carrier never grants a platform target native custody.
                expect(response.statusCode, response.body).toBe(nativeChild ? 401 : 200);
            }
            const siblingPath = `/v1/deployments/environments/${sibling.id}?serverId=${serverId}`;
            const bearer = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await app.inject({ method: 'GET', url: siblingPath,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${bearer}` } })).statusCode).toBe(200);
            const unrelated = await app.inject({ method: 'GET', url: siblingPath, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: f.authorization.token, effectActionId, target,
                    installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                    method: 'GET', path: siblingPath, privateKey: f.controller.keys.secretKey }),
            } });
            expect(unrelated.statusCode).toBe(401);
            await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
            const settled = await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: f.authorization.token, effectActionId, target,
                    installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                    method: 'GET', path, privateKey: f.controller.keys.secretKey }),
            } });
            expect(settled.statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('retains the deployment Source-read purpose inside a reviewed Cloudflare Upload child', async () => {
        const f = await fixture('account', 'account', { platformTarget: 'workers' });
        const target = f.authorization.binding.target;
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: f.authorization,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://home.test', target,
            installationId: f.controller.installationId, privateKey: f.controller.keys.secretKey, rootAdmitted: true });
        if (!authorization) throw new Error('Expected admitted root HTTP projection');
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.id = f.environment.id;
        environment.environment.projectSourceId = f.environment.projectSourceId;
        if (environment.content.definition.kind !== 'repository') throw new Error('Repository fixture required');
        const sourceIntent = { kind: 'repository' as const, projectSourceId: f.environment.projectSourceId,
            sourceRevision: 1, sha: 'a'.repeat(40), compose: environment.content.definition.compose };
        const action = { pluginId: 'happier.deploy.cloudflare', localId: 'pages-upload' };
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await inTx(tx => createProjectSourceInTx(tx, other.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Private foreign Source', audience: [] }));
        if (!foreign.ok) throw new Error('Expected private foreign Source fixture');
        const responses: Array<{ status: number; body: unknown }> = [];
        await withAuthenticatedTestApp(projectSourceRoutes, async app => {
            // Replace HTTP transport only: the reviewed issuer, Source reader, signer and Home authorization remain real.
            const transport = vi.spyOn(axios, 'request').mockImplementation(async config => {
                const response = await app.inject({ method: 'GET', url: new URL(config.url!).pathname + new URL(config.url!).search,
                    headers: Object.fromEntries(Object.entries(config.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
                expect(config.headers?.Authorization).toBeUndefined();
                const data: unknown = response.json();
                responses.push({ status: response.statusCode, body: data });
                return { status: response.statusCode, statusText: '', data, headers: {}, config: { headers: new AxiosHeaders() } };
            });
            let selected: unknown;
            let refusal: unknown;
            try {
                selected = await invokeHostReviewedChildV1({ parent: { actionId: 'deployments.deploy', input: f.input },
                    context: { runtimeAccountId: f.account.id, externalActionTarget: target,
                        externalActionExecutionAuthorization: authorization, surface: 'cli' },
                    child: { action, role: 'deploy', input: { environmentId: f.environment.id } },
                    admittedReview: { action, role: 'deploy', surface: 'cli' }, environmentId: f.environment.id,
                    execute: async (_input, context) => {
                        const host = { credentials: { token: 'unused-host-bearer', encryption: null }, serverId,
                            serverHttpBaseUrl: 'http://home.test', machineId: f.controller.id, async assertAuthority() {},
                            async resolveRequesterIdentity() { throw new Error('Source metadata does not acquire a workspace'); } };
                        const selected = await readDeploymentSourceIntentForHost({ request: {
                            environment, sourceIntent, requireWorkspace: false, context }, host });
                        const foreignEnvironment = structuredClone(environment);
                        foreignEnvironment.environment.projectSourceId = foreign.source.id;
                        await expect(readDeploymentSourceIntentForHost({ request: { environment: foreignEnvironment,
                            sourceIntent: { ...sourceIntent, projectSourceId: foreign.source.id }, requireWorkspace: false, context }, host }))
                            .rejects.toBeInstanceOf(Error);
                        return selected;
                    },
                });
            } catch (error) { refusal = error; }
            finally { transport.mockRestore(); }
            expect(refusal).toBeUndefined();
            expect(responses).toHaveLength(2);
            expect(responses[0]).toMatchObject({ status: 200, body: { ok: true, source: { id: f.environment.projectSourceId } } });
            expect(responses[1].status).toBeGreaterThanOrEqual(400);
            expect(responses[1].body).not.toHaveProperty('source');
            expect(selected).toMatchObject({ sourceIntent });
        }, { authentication: 'real' });
    });

    it('names malformed forwarded Environment-read carriers before signature verification', async () => {
        const f = await fixture();
        const effectActionId = 'deployments.deploy' as const;
        const target = f.authorization.binding.target;
        const path = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`;
        const headers = {
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                authorizationToken: f.authorization.token, effectActionId, target,
                installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                method: 'GET', path, privateKey: f.controller.keys.secretKey }),
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const [invalidHeaders, phase] of [
                [{ ...headers, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: '' }, 'proof_shape'],
                [{ ...headers, [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: 'invalid-carrier' }, 'deployment_child_http'],
                [{ ...headers, [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: 'invalid-carrier' }, 'reviewed_child'],
            ] as const) {
                await expectHttpRefusalWarning({ phase, method: 'GET', path: path.split('?')[0] }, async () => {
                    const response = await app.inject({ method: 'GET', url: path, headers: invalidHeaders });
                    expect(response.statusCode).toBe(401);
                    expect(response.json()).toEqual({ error: 'invalid_token', authorizationRefusal: phase });
                }, [f.authorization.token, headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]]);
            }
        }, { authentication: 'real' });
    });

    it('keeps accepted controller HTTP reads available after its requester leaves the Source Team', async () => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, readableEnvironment: true });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.member.accountId } },
            data: { role: 'owner' } });
        expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
            .toMatchObject({ ok: true });
        const reads = [
            { actionId: 'deployments.environments.get', path: `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}` },
            { actionId: 'deployments.receipts.get', path: `/v1/deployments/receipts/${f.receipt.id}?serverId=${serverId}` },
            { actionId: 'deployments.receipts.list', path: `/v1/deployments/environments/${f.environment.id}/deployments?serverId=${serverId}` },
        ];
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const bearer = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
            for (const read of reads) {
                const signed = await app.inject({ method: 'GET', url: read.path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: read.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                        effectActionId: read.actionId, target: f.authorization.binding.target,
                        installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                        method: 'GET', path: read.path, privateKey: f.controller.keys.secretKey }),
                } });
                expect.soft(signed.statusCode, `${read.actionId}: ${signed.body}`).toBe(200);
                const ordinary = await app.inject({ method: 'GET', url: read.path, headers: { authorization: `Bearer ${bearer}` } });
                expect(ordinary.statusCode, ordinary.body).toBe(404);
            }
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('ends accepted receipt history reads at settlement after requester withdrawal (%s)', async contentMode => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, readableEnvironment: true, contentMode });
        const path = `/v1/deployments/environments/${f.environment.id}/deployments?serverId=${serverId}`;
        const headers = {
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.receipts.list',
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                effectActionId: 'deployments.receipts.list', target: f.authorization.binding.target,
                installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                method: 'GET', path, privateKey: f.controller.keys.secretKey }),
        };
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.member.accountId } },
            data: { role: 'owner' } });
        expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
            .toMatchObject({ ok: true });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const active = await app.inject({ method: 'GET', url: path, headers });
            expect(active.statusCode, active.body).toBe(200);
            expect(active.json().items.map((item: { id: string }) => item.id)).toContain(f.receipt.id);

            await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
            const settled = await app.inject({ method: 'GET', url: path, headers });
            expect(settled.statusCode, settled.body).toBe(404);
            expect(settled.json()).toEqual({ ok: false, error: 'deployment_unavailable' });

            const bearer = await auth.createToken(f.member.accountId, undefined, { kind: 'account', authority: 'present_user' });
            const member = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${bearer}` } });
            expect(member.statusCode, member.body).toBe(200);
            expect(member.json().items.map((item: { id: string }) => item.id)).toContain(f.receipt.id);
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('retains current %s Artifact custody checks during accepted controller HTTP reads', async contentMode => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, separateContentOwner: true,
            readableEnvironment: true, contentMode });
        const history = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: f.account.id,
            actionOperationId: crypto.randomUUID(), ...await f.content('deployment-receipt.v1') } });
        const reads = [
            { actionId: 'deployments.environments.get', path: `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}` },
            { actionId: 'deployments.receipts.get', path: `/v1/deployments/receipts/${f.receipt.id}?serverId=${serverId}` },
        ];
        const request = (read: { actionId: string; path: string }) => ({ method: 'GET' as const, url: read.path, headers: {
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: read.actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                effectActionId: read.actionId, target: f.authorization.binding.target,
                installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                method: 'GET', path: read.path, privateKey: f.controller.keys.secretKey }),
        } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const read of reads) {
                const before = await app.inject(request(read));
                expect(before.statusCode, before.body).toBe(200);
            }
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.member.accountId } },
                data: { role: 'owner' } });
            expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
                .toMatchObject({ ok: true });
            for (const read of reads) {
                const after = await app.inject(request(read));
                expect(after.statusCode, after.body).toBe(409);
                expect(after.json()).toEqual({ ok: false, error: 'deployment_content_unavailable' });
            }
            const listing = await app.inject(request({ actionId: 'deployments.receipts.list',
                path: `/v1/deployments/environments/${f.environment.id}/deployments?serverId=${serverId}` }));
            expect(listing.statusCode, listing.body).toBe(200);
            expect(listing.json().items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([f.receipt.id, history.id]));
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('returns a terminal refusal for a %s Store proposal naming a Machine as its installation', async contentMode => {
        const f = await fixture('account', 'account', { templateRoot: true, readableEnvironment: true, contentMode });
        const actionId = 'deployments.templates.instantiate';
        const input = { ...f.templateInput, machineId: f.controller.id,
            environment: { kind: 'create', requestKey: crypto.randomUUID(), name: 'Agent Store app',
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: f.controller.id },
            target: { kind: 'new', installationId: f.controller.id }, destination: { kind: 'stored' } };
        const token = await auth.createToken(f.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        await withAuthenticatedTestApp(registerExternalActionRoutes, async app => {
            const mint = (installationId: string) => {
                const requestId = crypto.randomUUID();
                const target = { kind: 'machine' as const, machineId: f.controller.id };
                const operand = { ...input, target: { ...input.target, installationId } };
                const envelope = contentMode === 'plain' ? { v: 1 as const, requestId, target, input: operand }
                    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                        binding: { serverIdentityId: serverId, accountId: f.account.id,
                            authentication: { kind: 'terminal', tokenEpoch: f.account.tokenEpoch }, actionId, requestId, target },
                        input: operand, material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes });
                return app.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: f.controller.id, envelope } });
            };
            const malformed = await mint(f.controller.id);
            expect(malformed.statusCode, malformed.body).toBe(403);
            expect(malformed.json()).toMatchObject({ error: 'credential_scope_denied' });
            // A real installation still reaches admission; no template policy waiver is needed.
            const admitted = await mint(f.controller.installationId);
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json().binding).toMatchObject({ authentication: { kind: 'terminal' },
                deploymentPreparationAdmission: { target: { installationId: f.controller.installationId } } });
        }, { authentication: 'real' });
    });

    it('binds template receipt history to the deploy intent present at Home mint', async () => {
        const f = await fixture('account', 'account', { templateRoot: true, readableEnvironment: true });
        const foreign = await fixture('account', 'account', { readableEnvironment: true });
        const { deploy, ...unprepared } = f.templateInput;
        const actionId = 'deployments.templates.instantiate';
        const effectActionId = 'deployments.receipts.list';
        const spec = getActionSpec(effectActionId);
        const transport = spec.serverTransport;
        if (!transport) throw new Error('Receipt history requires its canonical transport');
        const requestKey = crypto.randomUUID();
        const createdContent = await f.content('deployment-environment.v1');
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.account.id, { serverId, requestKey,
            projectSourceId: f.environment.projectSourceId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.controller.id, ...createdContent }));
        if (!created.ok) throw new Error(created.error);
        const selectedDomainInput = { ...unprepared,
            environment: { kind: 'create' as const, requestKey, name: 'Store app', protection: 'nonProduction' as const,
                purpose: 'standard' as const, deployerMode: 'managers' as const, controllerMachineId: f.controller.id },
            target: { kind: 'new' as const, installationId: f.member.installationId }, destination: { kind: 'stored' as const },
            domainBindings: [{ templateDomainId: 'web', hostname: 'web.example.test' }] };
        const cases = [{ templateInput: unprepared, environmentId: f.environment.id, admitted: false },
            { templateInput: { ...unprepared, deploy }, environmentId: f.environment.id, admitted: true },
            { templateInput: selectedDomainInput, environmentId: created.environmentId, admitted: true },
            { templateInput: { ...unprepared, deploy }, environmentId: foreign.environment.id, admitted: false }];
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const { templateInput, environmentId, admitted } of cases) {
                const input = spec.inputSchema.parse({ serverId, environmentId });
                const path = bindHomeDomainHttpRequestV1({ transport, inputSchema: spec.inputSchema, input }).path;
                const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID(), input: templateInput };
                const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                    accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
                    actionId, machineId: f.controller.id, target: envelope.target, requestId: envelope.requestId,
                    deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, templateInput),
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: templateInput });
                const read = () => app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId, target: envelope.target,
                        installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'GET', path, privateKey: f.controller.keys.secretKey }),
                } });
                if (admitted) {
                    const response = await read();
                    expect(response.statusCode, response.body).toBe(200);
                } else if (environmentId === foreign.environment.id) {
                    const response = await read();
                    expect(response.statusCode, response.body).toBe(401);
                } else {
                    // The refusal names its public catalog root and effect so a live 401 can be attributed.
                    await expectHttpRefusalWarning({ phase: 'effect_family', method: 'GET', path: path.split('?')[0],
                        rootActionId: actionId, effectActionId }, async () => {
                        const response = await read();
                        expect(response.statusCode, response.body).toBe(401);
                        expect(response.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'effect_family' });
                    }, [authorization.token]);
                }
            }
        }, { authentication: 'real' });
    });

    it.each([{ workflowOrigin: false, templateRoot: false, membershipWithdrawal: false },
        { workflowOrigin: true, templateRoot: false, membershipWithdrawal: false },
        { workflowOrigin: false, templateRoot: true, membershipWithdrawal: false },
        { workflowOrigin: false, templateRoot: false, membershipWithdrawal: true }])('uses only accepted-job and installation reads for controller calls after credential withdrawal (%j)', async options => {
        const f = await fixture(options.membershipWithdrawal ? 'team' : 'account', 'account', { ...options,
            separateMemberCustodian: options.membershipWithdrawal });
        const receiptSpec = getActionSpec('deployments.receipts.get');
        if (!receiptSpec.serverTransport) throw new Error('Receipt reads need their canonical transport');
        const receiptInput = { serverId, deploymentId: f.receipt.id };
        const receiptRead = bindHomeDomainHttpRequestV1({ transport: receiptSpec.serverTransport,
            inputSchema: receiptSpec.inputSchema, input: receiptInput });
        const baseReads = [
            { effectActionId: 'deployments.environments.get', path: `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`,
                routeInput: { serverId, environmentId: f.environment.id } },
            { effectActionId: 'deployments.receipts.get', path: receiptRead.path, routeInput: receiptInput },
            { effectActionId: f.authorization.binding.actionId, path: '/v1/features/authenticated', routeInput: undefined },
        ];
        const reads = [...baseReads, ...(options.templateRoot
            ? baseReads.slice(0, 2).map(read => ({ ...read, effectActionId: 'deployments.deploy' })) : [])];
        const verify = (read: typeof reads[number], privateKey = f.controller.keys.secretKey) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: f.authorization.token, effectActionId: read.effectActionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target), method: 'GET', path: read.path, body: undefined, routeInput: read.routeInput,
            ...(read.effectActionId === 'deployments.deploy' && f.reviewedChild ? { reviewedChild: f.reviewedChild } : {}),
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                effectActionId: read.effectActionId, target: f.authorization.binding.target,
                installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                method: 'GET', path: read.path, privateKey,
                ...(read.effectActionId === 'deployments.deploy' && f.reviewedChild ? { reviewedChild: f.reviewedChild } : {}) }),
        });
        for (const read of reads) {
            const queries: string[] = [];
            const stop = observeSqliteRequests({ before: query => { queries.push(query.model ?? query.action); } });
            try { expect.soft(await verify(read), read.path).not.toBeNull(); } finally { stop(); }
            expect.soft(queries.filter(model => ['Account', 'ApiToken', 'TeamMembership', 'ProjectSource', 'SimpleCache'].includes(model))).toEqual([]);
            expect.soft(queries.length, `${read.path}: ${queries.join(', ')}`).toBeLessThanOrEqual(2);
        }
        const forwardAdmittedMember = async () => {
            const request = f.rpc();
            const receiver = { id: 'withdrawal-deployment-receiver', data: { clientType: 'machine-scoped',
                machineId: f.member.id, verifiedMachineInstallationId: f.member.installationId },
                timeout: () => ({ emitWithAck: async () => ({ accepted: true }) }) };
            qualifyCurrentAccountStoredContentSocket(receiver);
            const io = createSocketRoomDiscoveryHarness(async room =>
                room === `rpc:${f.member.accountId}:${request.method}` || room === receiver.id ? [receiver] : []);
            const token = await auth.createToken(f.controller.accountId, undefined, { kind: 'account', authority: 'present_user' });
            const socket = Object.assign(createAuthenticatedFakeSocket({ id: 'withdrawal-deployment-controller', data: {
                userId: f.controller.accountId, clientType: 'machine-scoped', machineId: f.controller.id,
                verifiedMachineInstallationId: f.controller.installationId, authTokenKind: 'account' } }),
                { handshake: { auth: { token } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: f.controller.accountId, socket: socket as unknown as Socket, io });
            let response: unknown;
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, request, (value: unknown) => { response = value; });
            expect(response, 'admitted member activation reaches the receiver after withdrawal')
                .toMatchObject({ ok: true, result: { accepted: true } });
        };
        if (options.membershipWithdrawal) {
            await db.machineTeamGrant.updateMany({ where: { machineId: f.member.id, teamId: f.team!.id },
                data: { accessLevel: 'admin' } });
            await forwardAdmittedMember();
        }
        await db.account.update({ where: { id: f.account.id }, data: { tokenEpoch: { increment: 1 } } });
        if (options.membershipWithdrawal) {
            await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
            const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID() };
            await expect(auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch + 1 },
                actionId: f.authorization.binding.actionId, machineId: f.controller.id, target: envelope.target,
                requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
            { input: envelope.input })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        }
        for (const read of reads) expect.soft(await verify(read), read.path).not.toBeNull();
        if (options.membershipWithdrawal) await forwardAdmittedMember();
        expect(await verify(reads[0], f.outsider.keys.secretKey)).toBeNull();
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            let revision = f.receipt.revision;
            for (const state of ['running', 'succeeded'] as const) {
                const body = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
                    actionOperationId: f.receipt.actionOperationId, expectedRevision: revision,
                    machineId: f.controller.id, installationId: f.controller.installationId,
                    kind: state === 'running' ? 'stage' as const : 'settle' as const, state,
                    ...(state === 'succeeded' ? { expectedTargetLinkRevision: f.link.revision } : {}) };
                const payload = { ...body, proof: signMachineInstallationProof({ payload: { version: 1,
                    accountId: f.account.id, machineId: f.controller.id, installationId: f.controller.installationId,
                    deploymentTransition: { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
                        actionOperationId: f.receipt.actionOperationId, expectedRevision: revision,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: f.controller.keys.secretKey }) };
                const path = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
                const response = await app.inject({ method: 'POST', url: path, payload, headers: {
                    ...f.admissionHeaders, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy', target: f.authorization.binding.target,
                        installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                        method: 'POST', path, body: payload, ...(f.reviewedChild ? { reviewedChild: f.reviewedChild } : {}),
                        privateKey: f.controller.keys.secretKey }),
                } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ ok: true, state });
                const changed = DeploymentReceiptResultV1Schema.parse(response.json());
                if (!changed.ok || !('deploymentRevision' in changed)) throw new Error('Accepted deployment transition has no receipt revision');
                revision = changed.deploymentRevision;
            }
            expect(await f.verify(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'retention', actionId: 'deployments.deploy', input: f.input,
                machineId: f.member.id, installationId: f.member.installationId, deploymentId: f.receipt.id,
                actionOperationId: f.receipt.actionOperationId, settledTargetLinkRevision: f.link.revision + 1,
                settledDeploymentRevision: revision, activeDeploymentId: f.receipt.id }))).not.toBeNull();
        }, { authentication: 'real' });
        // The retained root cannot manufacture accepted custody for a different request.
        await db.deployment.update({ where: { id: f.receipt.id }, data: { acceptedRequestEnvelopeDigest: null } });
        if (f.workflowActionOrigin) {
            // A Workflow root's principal is its active Run, not accepted custody:
            // its own Environment stays readable until that Run ends.
            expect(await verify(reads[0])).not.toBeNull();
            await db.automationRun.update({ where: { id: f.workflowActionOrigin.runId }, data: { state: 'cancelled' } });
        }
        expect(await verify(reads[0])).toBeNull();
    });

    it('K2 finishes admitted deployment hops and finite health reads after withdrawal, refusing new work', async () => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true });
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id, machineId: f.controller.id };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const mint = () => {
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            return auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
                serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
                actionId: 'deployments.health.current', machineId: f.controller.id, target,
                requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentReadAdmission: projectDeploymentReadAdmissionV1('deployments.health.current', input) });
        };
        const health = await mint();
        const read = (authorization: typeof health) => {
            const path = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`;
            return verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                effectActionId: 'deployments.environments.get', encodedTarget: encodeExternalActionResolvedTargetV1(target),
                method: 'GET', path, body: undefined, routeInput: { serverId, environmentId: f.environment.id },
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.environments.get', target, installationId: f.controller.installationId,
                    requestId: authorization.binding.requestId, method: 'GET', path, privateKey: f.controller.keys.secretKey }) });
        };
        expect(await read(health), 'finite read must first reach real admission').not.toBeNull();
        expect(await read(f.authorization), 'accepted deploy metadata hop').not.toBeNull();
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.member.accountId } },
            data: { role: 'owner' } });
        expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
            .toMatchObject({ ok: true });
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        const queries: string[] = [];
        const stop = observeSqliteRequests({ before: query => { queries.push(query.model ?? query.action); } });
        try {
            expect.soft(await read(f.authorization), 'accepted deployment keeps its admitted scope').not.toBeNull();
            expect.soft(await read(health), 'finite health continuation keeps its admitted scope').not.toBeNull();
        } finally { stop(); }
        expect(queries.filter(model => ['Account', 'ApiToken', 'TeamMembership', 'ProjectSource'].includes(model)),
            'no authority re-evaluation on either admitted hop').toEqual([]);
    });

    it('retains finite health read custody through the resource route after Team withdrawal', async () => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true });
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id, machineId: f.controller.id };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
            serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.health.current', machineId: f.controller.id, target,
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1('deployments.health.current', input) });
        const path = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = () => app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.environments.get',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.environments.get', target,
                    installationId: f.controller.installationId, requestId: envelope.requestId, method: 'GET', path,
                    privateKey: f.controller.keys.secretKey }),
            } });
            const before = await read();
            expect(before.statusCode, before.body).toBe(200);
            await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
            const after = await read();
            expect(after.statusCode, after.body).toBe(200);
            expect(after.json()).toMatchObject({ ok: true });
        }, { authentication: 'real' });
    });

    it.each([false, true])('scopes own-server teardown history and candidate publication to its signed controller root (Workflow: %s)', async workflowOrigin => {
        const f = await fixture('account', 'account', { workflowOrigin });
        const actionId = 'deployments.teardown' as const;
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id,
            expectedRevision: f.environmentRevision, expectedTargetLinkRevision: f.link.revision,
            requestKey: crypto.randomUUID(), reason: 'manual' as const };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const mint = () => auth.mintExternalActionExecutionAuthorization({
            accountId: f.account.id, serverIdentityId: serverId,
            authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
            machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            ...(f.workflowActionOrigin ? { workflowActionOrigin: { ...f.workflowActionOrigin, requestId: envelope.requestId } } : {}),
        }, { input });
        const authorization = await mint();
        expect(authorization.binding.deploymentCandidatePublication).toMatchObject({
            environmentId: f.environment.id,
            source: { id: f.environment.projectSourceId },
        });
        const candidate = authorization.binding.deploymentCandidatePublication!;
        const verify = (path: string, routeInput?: unknown, effectActionId: string = actionId) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: authorization.token, effectActionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path, body: undefined, routeInput,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target, installationId: f.controller.installationId,
                requestId: envelope.requestId, method: 'GET', path, privateKey: f.controller.keys.secretKey }),
        });
        const list = getActionSpec('deployments.receipts.list');
        if (!list.serverTransport) throw new Error('Receipt history needs its canonical transport');
        const listInput = DeploymentReceiptListInputV1Schema.parse({ serverId, environmentId: f.environment.id });
        const listPath = bindHomeDomainHttpRequestV1({ transport: list.serverTransport,
            inputSchema: list.inputSchema, input: listInput }).path;
        expect(await verify(listPath, listInput, 'deployments.receipts.list')).not.toBeNull();
        expect(await verify(listPath, { ...listInput, environmentId: 'another-environment' }, 'deployments.receipts.list')).toBeNull();
        expect(await verify(`/v1/artifacts/${candidate.contentArtifactId}/access/recipients`)).not.toBeNull();
        const forbiddenPublication = `/v1/artifacts/${crypto.randomUUID()}/access/recipients`;
        await expectHttpRefusalWarning({ phase: 'deployment_publication_purpose', method: 'GET', path: forbiddenPublication },
            async () => { expect(await verify(forbiddenPublication)).toBeNull(); }, [authorization.token]);
        if (f.workflowActionOrigin) {
            await db.automationRun.update({ where: { id: f.workflowActionOrigin.runId }, data: { state: 'paused' } });
            // Approval spends the already issued finite root, without admitting new work.
            expect(await verify(listPath, listInput, 'deployments.receipts.list')).not.toBeNull();
            await expect(mint()).rejects.toThrow();
            await db.automationRun.update({ where: { id: f.workflowActionOrigin.runId }, data: { state: 'cancelled' } });
            expect(await verify(listPath, listInput, 'deployments.receipts.list')).toBeNull();
        }
    });

    it('allows signed teardown Environment metadata without spending its captured Source as a read purpose', async () => {
        const f = await fixture();
        const foreign = await fixture();
        const actionId = 'deployments.teardown';
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = getActionSpec(actionId).inputSchema.parse({ serverId, environmentId: f.environment.id,
            targetLinkId: f.link.id, expectedRevision: f.environmentRevision,
            expectedTargetLinkRevision: f.link.revision, requestKey: crypto.randomUUID(), reason: 'manual' });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input, deploymentNativeAdmission });
        expect(authorization.binding.deploymentCandidatePublication?.source.id).toBe(f.environment.projectSourceId);
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); projectSourceRoutes(app); }, async app => {
            for (const [effectActionId, operand, statusCode] of [
                ['deployments.environments.get', { serverId, environmentId: f.environment.id }, 200],
                ['projects.sources.read', { serverId, id: f.environment.projectSourceId }, 401],
                ['projects.sources.read', { serverId, id: foreign.environment.projectSourceId }, 401],
            ] as const) {
                const spec = getActionSpec(effectActionId);
                // Source reads use the native Source client route rather than a
                // Home-domain ActionSpec transport (the source Action is a CLI composition).
                const bound = effectActionId === 'projects.sources.read'
                    ? { path: `/v1/projects/sources/${encodeURIComponent(operand.id)}?serverId=${encodeURIComponent(serverId)}` }
                    : bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!,
                        inputSchema: spec.inputSchema, input: spec.inputSchema.parse(operand) });
                const response = await app.inject({ method: 'GET', url: bound.path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId, target,
                        installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'GET', path: bound.path, privateKey: f.controller.keys.secretKey }),
                } });
                expect(response.statusCode, `${effectActionId}: ${response.body}`).toBe(statusCode);
                if (statusCode === 401) expect(response.json()).toMatchObject({ error: 'invalid_token' });
            }
        }, { authentication: 'real' });
    });

    it.each([
        { origin: 'session', contentMode: 'plain', placement: 'same', active: true },
        { origin: 'session', contentMode: 'e2ee', placement: 'same', active: true },
        { origin: 'workflow', contentMode: 'plain', placement: 'same', active: true },
        { origin: 'workflow', contentMode: 'e2ee', placement: 'same', active: true },
        { origin: 'session', contentMode: 'plain', placement: 'distinct', active: true },
        { origin: 'workflow', contentMode: 'e2ee', placement: 'distinct', active: true },
        { origin: 'session', contentMode: 'e2ee', placement: 'distinct', active: false },
        { origin: 'workflow', contentMode: 'plain', placement: 'distinct', active: false },
    ] as const)('admits the reviewed Prepare Session handoff through real Session routes ($origin, $contentMode, $placement, active=$active)', async ({ origin, contentMode, placement, active }) => {
        const storagePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
        try {
        const f = await fixture('account', 'account', { workflowOrigin: origin === 'workflow', contentMode });
        const foreign = await fixture('account', 'account', { contentMode });
        const runtimeMachine = placement === 'same' ? f.controller : f.member;
        expect(runtimeMachine.id === f.controller.id).toBe(placement === 'same');
        const sourceSession = await db.session.create({ data: { accountId: f.account.id, tag: crypto.randomUUID(),
            metadata: contentMode === 'plain' ? '{}' : 'opaque-encrypted-session-metadata', encryptionMode: contentMode } });
        const destination = await db.session.create({ data: { accountId: f.account.id, tag: crypto.randomUUID(),
            metadata: contentMode === 'plain' ? '{}' : 'opaque-encrypted-session-metadata', encryptionMode: contentMode, active } });
        const inaccessible = await db.session.create({ data: { accountId: foreign.account.id, tag: crypto.randomUUID(),
            metadata: contentMode === 'plain' ? '{}' : 'opaque-encrypted-session-metadata', encryptionMode: contentMode } });
        for (const [sessionId, machineId] of [[sourceSession.id, f.controller.id], [destination.id, runtimeMachine.id]]) await db.accessKey.create({ data: {
            accountId: f.account.id, machineId, sessionId, data: 'opaque-session-access-key' } });
        await db.machine.updateMany({ where: { id: { in: [f.controller.id, runtimeMachine.id] } }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
            homeId: serverId, accountId: f.account.id, sessionId: destination.id,
            machineId: runtimeMachine.id, installationId: runtimeMachine.installationId } } });
        const publisher = createAuthenticatedFakeSocket({ data: { clientType: 'session-scoped',
            userId: f.account.id, sessionId: sourceSession.id } });
        const presence = createSessionPublisherPresence();
        expect((await presence.registerPublisher({ socket: publisher as unknown as Socket,
            binding: { accountId: f.account.id, machineId: f.controller.id, sessionId: sourceSession.id },
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).status).toBe('registered');
        const publisherIo = createSocketRoomDiscoveryHarness(async () => [publisher]);
        const resolveCurrentSessionMachine = (operand: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionMachineFromServer({ io: publisherIo, presence, ...operand });
        const actionId = 'deployments.prepare' as const;
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const baseInput = { projectSourceId: f.environment.projectSourceId, sourceRevision: 1,
            repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'child/app' },
            baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref' as const, serverId, id: 'prepare-workspace' } };
        const mint = async (existing: boolean) => {
            const input = getActionSpec(actionId).inputSchema.parse({ ...baseInput,
                ...(existing ? { sessionRef: { serverId, sessionId: destination.id } } : {}) });
            const requestId = crypto.randomUUID(), envelope = { v: 1 as const, requestId, target, input };
            return auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id, serverIdentityId: serverId,
                authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
                machineId: f.controller.id, target, requestId, admittedMachineRole: 'use',
                ...(origin === 'workflow' ? { workflowActionOrigin: { ...f.workflowActionOrigin!, requestId } }
                    : { sessionActionOrigin: { v: 1 as const, caller: { kind: 'session' as const, sessionId: sourceSession.id,
                        starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'prepare-turn', callerPermissionMode: null, requestId },
                        sessionActionSource: { machineId: f.controller.id, installationId: f.controller.installationId } }),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) }, {
                input, resolveCurrentSessionMachine });
        };
        const sendAuthorization = await mint(true), spawnAuthorization = await mint(false);
        const sendChild = { actionId: 'session.message.send', role: 'prepare-session',
            inputDigest: computeActionInputApprovalDigestV1('session.message.send', {
                sessionId: destination.id, message: 'Prepare the reviewed repository', reply: 'none' }) };
        const spawnChild = { actionId: 'session.spawn_new', role: 'prepare-session',
            inputDigest: computeActionInputApprovalDigestV1('session.spawn_new', {
                executionTarget: { serverId, machineId: f.controller.id }, directory: { kind: 'path', path: '/repo' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }) };
        const resolvedSession = { kind: 'session' as const, sessionId: destination.id };
        const headers = (authorization: ExternalActionExecutionAuthorizationV1, child: ReviewedActionChildHttpProofV1,
            path: string, method = 'GET', body?: unknown,
            resolved: ExternalActionExecutionAuthorizationV1['binding']['target'] = resolvedSession, effectActionId = child.actionId) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(resolved),
            [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(child),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target: resolved, reviewedChild: child, installationId: f.controller.installationId,
                requestId: authorization.binding.requestId, method, path, body, privateKey: f.controller.keys.secretKey }) });
        await withAuthenticatedTestApp(app => { app.decorate('resolveCurrentSessionMachine', resolveCurrentSessionMachine);
            registerAccountEncryptionRoutes(app); registerAccountProfileRoute(app); sessionRoutes(app); sessionPendingRoutes(app); }, async app => {
            const currentness = '/v1/account/encryption/currentness';
            for (const [authorization, child, resolved] of [[sendAuthorization, sendChild, resolvedSession]] as const) {
                const read = await app.inject({ method: 'GET', url: currentness,
                    headers: headers(authorization, child, currentness, 'GET', undefined, resolved) });
                expect.soft(read.statusCode, read.body).toBe(200);
                expect((await app.inject({ method: 'GET', url: currentness,
                    headers: headers(authorization, { ...child, role: 'foreign-role' }, currentness, 'GET', undefined, resolved) })).statusCode).toBe(401);
                expect((await app.inject({ method: 'GET', url: currentness,
                    headers: headers(authorization, child, currentness, 'GET', undefined, resolved, 'session.transcript.get') })).statusCode).toBe(401);
                expect((await app.inject({ method: 'GET', url: currentness, headers: headers(authorization, child, currentness,
                    'GET', undefined, { kind: 'machine', machineId: f.outsider.id }) })).statusCode).toBe(401);
            }
            // Prepare retains captured Account currentness through its reviewed
            // spawn child; its optional uncaptured-currentness fallback is unreachable.
            expect((await app.inject({ method: 'GET', url: currentness,
                headers: headers(spawnAuthorization, spawnChild, currentness, 'GET', undefined, target) })).statusCode).toBe(401);
            expect((await app.inject({ method: 'GET', url: '/v1/account/profile',
                headers: headers(sendAuthorization, sendChild, '/v1/account/profile') })).statusCode).toBe(401);
            const sessionPath = `/v2/sessions/${destination.id}`;
            const read = await app.inject({ method: 'GET', url: sessionPath, headers: headers(sendAuthorization, sendChild, sessionPath) });
            expect.soft(read.statusCode, read.body).toBe(200);
            if (origin === 'session') {
                const mutePath = `${sessionPath}/delivery-mutes`;
                const mutes = await app.inject({ method: 'GET', url: mutePath, headers: headers(sendAuthorization, sendChild, mutePath) });
                expect.soft(mutes.statusCode, mutes.body).toBe(200);
            }
            const pendingPath = `${sessionPath}/pending`;
            // Protected Prepare input always uses the installed Machine socket.
            // Substitute only that network edge; verification and Pending custody stay real.
            const socket = createAuthenticatedFakeSocket({ nsp: { server: createSocketRoomDiscoveryHarness(async () => []) }, data: {
                clientType: 'machine-scoped', machineId: f.controller.id,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: f.controller.installationId } });
            qualifyCurrentAccountStoredContentSocket(socket);
            machineUpdateHandler(f.account.id, socket as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
                resolveCurrentSessionMachine });
            const enqueue = async (sessionId = destination.id, resolved = { kind: 'session' as const, sessionId },
                targetMachineId = runtimeMachine.id, effectActionId = 'session.message.send') => {
                const body = SessionPendingEnqueueByMachineRequestV1Schema.parse({ v: 1, sessionId, targetMachineId,
                    localId: crypto.randomUUID(), content: contentMode === 'plain'
                        ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Prepare the reviewed repository' } } }
                        : { t: 'encrypted', c: 'opaque-encrypted-preparation-brief' },
                    requestedAction: { v: 1, kind: !active ? 'send_now' : origin === 'session' ? 'enqueue' : 'steer_if_active' } });
                const event = SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
                let response: unknown;
                const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({ ...body, externalAction: { v: 1, authorization: sendAuthorization,
                    effectActionId, target: resolved, installationId: f.controller.installationId,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: sendAuthorization.token,
                        effectActionId, target: resolved, installationId: f.controller.installationId,
                        event, method: event, requestId: sendAuthorization.binding.requestId, params: body,
                        privateKey: f.controller.keys.secretKey }) } });
                expect(request.externalAction, 'signed Machine input must retain its authorization at the network boundary').toBeDefined();
                await triggerSocketHandler(socket, event, request, (value: unknown) => { response = value; });
                return { localId: body.localId, result: SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result };
            };
            const sent = await enqueue();
            expect.soft(sent.result).toEqual({ status: 'accepted', localId: sent.localId });
            expect.soft(await db.sessionPendingMessage.count({ where: { sessionId: destination.id, localId: sent.localId } })).toBe(1);
            const foreignInput = await enqueue(inaccessible.id);
            expect.soft(foreignInput.result, 'inaccessible resolved Session').toMatchObject({ status: 'rejected' });
            const refused = [foreignInput, await enqueue(destination.id, { kind: 'session', sessionId: inaccessible.id }),
                await enqueue(destination.id, resolvedSession, runtimeMachine.id, 'session.transcript.get')];
            for (const result of refused.slice(1)) expect.soft(result.result, 'mismatched Session or effect').toMatchObject({
                status: 'rejected', code: 'session_input_unauthorized' });
            const wrongRuntime = await enqueue(destination.id, resolvedSession, f.outsider.id);
            expect.soft(wrongRuntime.result, 'runtime Machine differs from the committed Session target').toMatchObject({
                status: 'rejected', code: 'session_input_target_unavailable' });
            expect(await db.sessionPendingMessage.count({ where: { localId: wrongRuntime.localId } })).toBe(0);
            expect(await db.sessionPendingMessage.count({ where: { localId: { in: refused.map(result => result.localId) } } })).toBe(0);
            // AlreadyAccepted retries read this exact status route before settling delivery.
            const statuses = await app.inject({ method: 'GET', url: pendingPath, headers: headers(sendAuthorization, sendChild, pendingPath) });
            expect.soft(statuses.statusCode, statuses.body).toBe(200);
            const directBody = { localId: crypto.randomUUID(), content: contentMode === 'plain'
                ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'unused direct delivery' } } }
                : { t: 'encrypted', c: 'opaque-encrypted-preparation-brief' }, requestedAction: { v: 1, kind: 'enqueue' } };
            expect((await app.inject({ method: 'POST', url: pendingPath, payload: directBody,
                headers: headers(sendAuthorization, sendChild, pendingPath, 'POST', directBody) })).statusCode).toBe(401);
            const foreignPath = `/v2/sessions/${inaccessible.id}`;
            expect((await app.inject({ method: 'GET', url: foreignPath,
                headers: headers(sendAuthorization, sendChild, foreignPath, 'GET', undefined,
                    { kind: 'session', sessionId: inaccessible.id }) })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: foreignPath,
                headers: headers(sendAuthorization, sendChild, foreignPath) })).statusCode).toBe(401);
        }, { authentication: 'real' });
        } finally {
            if (storagePolicy === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = storagePolicy;
        }
    });

    it.each(['plain', 'e2ee'] as const)('admits only the paired stored-app reads signed by a remote Setup receiver (%s)', async contentMode => {
        const f = await fixture('team', 'account', { contentMode, separateMemberCustodian: true });
        await db.machineTeamGrant.updateMany({ where: { machineId: f.member.id, teamId: f.team!.id }, data: { accessLevel: 'admin' } });
        const actionId = 'machines.setup.plan';
        const input = getActionSpec(actionId).inputSchema.parse({ homeId: serverId, machineId: f.outsider.id, targets: [{
            homeId: serverId, machineId: f.member.id, sources: [{ kind: 'direct', setup: { items: [{ kind: 'app',
                authoredKey: crypto.randomUUID(), definition: { name: 'Stored app',
                    project: { kind: 'existing', projectSourceId: f.environment.projectSourceId },
                    definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] }, bindings: [] } }] } }],
            appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy',
                input: { ...f.input, expectedRevision: f.environmentRevision } }],
        }] });
        const target = { kind: 'machine' as const, machineId: f.outsider.id };
        const mint = () => {
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            return auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
                actionId, machineId: f.outsider.id, target, requestId: envelope.requestId,
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        };
        const authorization = await mint();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const get = (artifactId: string, signer = f.member) => {
                const path = `/v1/artifacts/${artifactId}`;
                return app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: actionId, target,
                        installationId: signer.installationId, requestId: authorization.binding.requestId,
                        method: 'GET', path, privateKey: signer.keys.secretKey }),
                } });
            };
            expect((await get(f.input.contentArtifactId)).statusCode).toBe(200);
            expect((await get(f.environment.contentArtifactId)).statusCode).toBe(200);
            await expectHttpRefusalWarning({ phase: 'deployment_setup_receiver_purpose', method: 'GET', path: `/v1/artifacts/${f.link.contentArtifactId}` },
                async () => { expect((await get(f.link.contentArtifactId)).statusCode).toBe(401); }, [authorization.token]);
            expect((await get(f.input.contentArtifactId, f.builder)).statusCode).toBe(401);
            await db.machineTeamGrant.updateMany({ where: { machineId: f.member.id, teamId: f.team!.id }, data: { accessLevel: 'view' } });
            // Mint admitted the receiver's Manage once. A downgrade takes effect at
            // the next admission; the already admitted finite Setup finishes.
            expect((await get(f.input.contentArtifactId)).statusCode).toBe(200);
            await expect(mint()).rejects.toThrow();
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('settles an interrupted running receipt under the next rollback root (%s)', async contentMode => {
        const f = await fixture('account', 'account', { contentMode });
        const retained = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'succeeded' } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'running', revision: 2,
            operation: 'rollback', rollbackOfDeploymentId: retained.id } });
        const actionId = 'deployments.rollback' as const;
        const target = f.authorization.binding.target;
        const input = { ...f.input, deploymentId: retained.id, requestKey: crypto.randomUUID(), expectedRevision: f.environmentRevision };
        const compactInput = { serverId, environmentId: input.environmentId, deploymentId: input.deploymentId, requestKey: input.requestKey };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: compactInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, compactInput),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: compactInput });
        const body = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId, expectedRevision: 2, machineId: f.controller.id,
            installationId: f.controller.installationId, kind: 'settle' as const, state: 'outcome_unknown' as const };
        const signTransition = (body: Omit<DeploymentTransitionInputV1, 'proof'>) => ({ ...body, proof: signMachineInstallationProof({ payload: { version: 1,
            machineId: f.controller.id, installationId: f.controller.installationId, accountId: f.account.id,
            deploymentTransition: { serverId, environmentId: body.environmentId, deploymentId: body.deploymentId,
                actionOperationId: body.actionOperationId, expectedRevision: body.expectedRevision,
                requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: f.controller.keys.secretKey }) });
        const reason = { failure: { code: 'deployment_activation_not_observed', phase: 'observe' } };
        const reasonBody = { body: JSON.stringify(reason) };
        const storedReason = contentMode === 'plain' ? encodePlainArtifactStoredContent(reasonBody)
            : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(reasonBody,
                f.artifactKeys.get(f.receipt.contentArtifactId)!)));
        const wire = signTransition({ ...body, contentUpdate: ArtifactJsonUpdateHttpInputV1Schema.parse({
            expectedBodyVersion: f.receipt.contentBodyVersion, body: storedReason }) });
        const path = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
        const headers = (path: string, body: unknown, method: 'GET' | 'POST' = 'POST') => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: actionId, target, installationId: f.controller.installationId,
                requestId: authorization.binding.requestId, method, path, body, privateKey: f.controller.keys.secretKey }),
        });
        await withAuthenticatedTestApp(async app => { await registerDeploymentRoutes(app); await artifactsRoutes(app); }, async app => {
            const admissionPath = `/v1/deployments/environments/${f.environment.id}/rollback`;
            const admission = { ...input, actionOperationId: crypto.randomUUID() };
            const busy = await app.inject({ method: 'POST', url: admissionPath, payload: admission, headers: headers(admissionPath, admission) });
            expect(busy.json()).toMatchObject({ ok: false, error: 'deployment_in_progress', deploymentId: f.receipt.id });
            const artifactPath = `/v1/artifacts/${f.receipt.contentArtifactId}`;
            const opened = await app.inject({ method: 'GET', url: artifactPath, headers: headers(artifactPath, undefined, 'GET') });
            expect(opened.statusCode, opened.body).toBe(200);
            const otherAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
            for (const substituted of [{ requestedByAccountId: otherAccount.id },
                { acceptedControllerInstallationId: crypto.randomUUID() }]) {
                await db.deployment.update({ where: { id: f.receipt.id }, data: substituted });
                const refused = await app.inject({ method: 'POST', url: path, payload: wire, headers: headers(path, wire) });
                expect(refused.statusCode, refused.body).toBe(401);
                await db.deployment.update({ where: { id: f.receipt.id }, data: {
                    requestedByAccountId: f.account.id, acceptedControllerInstallationId: f.controller.installationId } });
            }
            // A new root may release only the captured controller's interrupted slot.
            // It can record the reason atomically, but cannot stage, activate,
            // replace the receipt Artifact, or settle another requester's slot.
            for (const invalid of [signTransition({ ...body, state: 'succeeded' }), signTransition({ ...body, kind: 'stage', state: 'running' }),
                signTransition({ ...body, state: 'failed', contentUpdate: wire.contentUpdate }),
                signTransition({ ...body, state: 'cancelled', contentUpdate: wire.contentUpdate }),
                signTransition({ ...body, actionOperationId: 'different-operation' }),
                signTransition({ ...body, contentArtifactId: f.receipt.contentArtifactId,
                    contentHeaderVersion: f.receipt.contentHeaderVersion, contentBodyVersion: f.receipt.contentBodyVersion })]) {
                const refused = await app.inject({ method: 'POST', url: path, payload: invalid, headers: headers(path, invalid) });
                expect(refused.statusCode, refused.body).toBe(401);
            }
            const settled = await app.inject({ method: 'POST', url: path, payload: wire, headers: headers(path, wire) });
            expect(settled.statusCode, settled.body).toBe(200);
            expect(settled.json()).toMatchObject({ ok: true, deploymentId: f.receipt.id, state: 'outcome_unknown', deploymentRevision: 3 });
            expect(await db.deployment.findUnique({ where: { id: f.receipt.id } })).toMatchObject({
                contentArtifactId: f.receipt.contentArtifactId, contentHeaderVersion: f.receipt.contentHeaderVersion,
                contentBodyVersion: f.receipt.contentBodyVersion + 1 });
            const artifact = await inTx(tx => readArtifactForCallerInTx(tx, {
                actorAccountId: f.account.id, artifactId: f.receipt.contentArtifactId }));
            if (!artifact.ok) throw new Error(artifact.error);
            if (contentMode === 'plain') expect(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.artifact.body))).toEqual(reasonBody);
            else {
                const opened = await openSessionDataKeyBundleV0(artifact.artifact.body, f.artifactKeys.get(f.receipt.contentArtifactId)!);
                expect(opened).toMatchObject({ status: 'authenticated', value: reasonBody });
            }
            const freshAdmission = { ...admission, contentBodyVersion: f.receipt.contentBodyVersion + 1 };
            const fresh = await app.inject({ method: 'POST', url: admissionPath, payload: freshAdmission, headers: headers(admissionPath, freshAdmission) });
            expect(fresh.statusCode, fresh.body).toBe(200);
            expect(fresh.json()).toMatchObject({ ok: true, state: 'queued' });
            expect(fresh.json().deploymentId).not.toBe(f.receipt.id);
            expect(await db.deployment.findUnique({ where: { id: fresh.json().deploymentId } }))
                .toMatchObject({ actionOperationId: admission.actionOperationId, requestKey: input.requestKey });
        }, { authentication: 'real' });
    });

    it('admits the compact UI Account rollback through the accepted child read owner', async () => {
        const f = await fixture();
        const retained = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'succeeded' } });
        const actionId = 'deployments.rollback' as const;
        const target = f.authorization.binding.target;
        const input = { serverId, environmentId: f.environment.id, deploymentId: retained.id, requestKey: crypto.randomUUID() };
        const originalActionEnvelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const preparation = projectDeploymentPreparationAdmissionV1(actionId, input);
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: originalActionEnvelope.requestId,
            ...(preparation ? { deploymentPreparationAdmission: preparation } : {}),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope) }, { input });
        // Persistence is the boundary: retain exactly the receipt's accepted root.
        await db.deployment.update({ where: { id: f.receipt.id }, data: { operation: 'rollback',
            rollbackOfDeploymentId: retained.id, requestKey: input.requestKey,
            acceptedRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest } });
        const job = DeploymentChildRpcV1Schema.parse({ ...f.job, actionId,
            input: { ...f.input, deploymentId: retained.id, requestKey: input.requestKey } });
        const method = `${f.member.id}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
        const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
        const packet = { method, requestId, params: job, originalActionEnvelope,
            externalActionExecution: { v: 1 as const, authorization, effectActionId: actionId, target,
                installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId,
                    method, requestId, params: job, deploymentChildRouting, event: SOCKET_RPC_EVENTS.CALL,
                    privateKey: f.controller.keys.secretKey }) } };
        expect(await verifyExternalActionMachineRpcExecution(packet.externalActionExecution, packet)).not.toBeNull();
        const reads = [
            { actionId: 'deployments.receipts.get' as const, value: { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id } },
            { actionId: 'deployments.environments.get' as const, value: { serverId, environmentId: f.environment.id } },
        ];
        const paths = reads.map(({ actionId, value }) => {
            const spec = getActionSpec(actionId);
            if (!spec.serverTransport) throw new Error('Native child metadata requires its canonical transport');
            const routeInput = spec.inputSchema.parse(value);
            return { path: bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
                inputSchema: spec.inputSchema, input: routeInput }).path, routeInput };
        });
        for (const proof of [...paths, { path: `/v1/artifacts/${f.receipt.contentArtifactId}` },
            { path: `/v1/artifacts/${f.environment.contentArtifactId}` },
            { path: `/v1/artifacts/${f.link.contentArtifactId}` }, { path: '/v1/account/encryption/currentness' }]) {
            expect(await verifyExternalActionDomainExecutionRequest({ ...proof, authorizationToken: authorization.token,
                effectActionId: actionId, encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', body: undefined,
                deploymentChildExecution: createDeploymentChildExecutionProofV1(packet),
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.member.installationId,
                    requestId: authorization.binding.requestId, method: 'GET', path: proof.path,
                    deploymentChildExecution: packet, privateKey: f.member.keys.secretKey }) }), proof.path).not.toBeNull();
        }
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            for (const path of [...paths.map(value => value.path), `/v1/artifacts/${f.receipt.contentArtifactId}`,
                `/v1/artifacts/${f.environment.contentArtifactId}`, `/v1/artifacts/${f.link.contentArtifactId}`]) {
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: actionId, target,
                        installationId: f.member.installationId, requestId: authorization.binding.requestId,
                        method: 'GET', path, deploymentChildExecution: packet, privateKey: f.member.keys.secretKey }),
                } });
                expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
            }
        }, { authentication: 'real' });
    });

    it('admits backup inventory for an Environment viewer while preserving write and foreign-target refusals', async () => {
        const f = await fixture('team', 'account');
        const foreign = await fixture();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
            data: { role: 'member' } });
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const input = buildDeploymentBackupActionInputV1('deployments.backups.inventory', { serverId,
            environmentId: f.environment.id, deploymentId: f.receipt.id, targetLinkId: f.link.id,
            machineId: f.member.id, installationId: f.member.installationId,
            expectedRevision: f.environmentRevision, configRevision: 1 });
        const mint = async (actionId: (typeof DEPLOYMENT_BACKUP_ACTION_IDS_V1)[number], value = input, accountId = f.account.id) => {
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: value };
            return auth.mintExternalActionExecutionAuthorization({ accountId, serverIdentityId: serverId,
                authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
                machineId: f.member.id, target, requestId: envelope.requestId, admittedMachineRole: 'use',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: value });
        };
        const authorization = await mint('deployments.backups.inventory');
        expect(authorization.binding.deploymentNativeAdmission).toMatchObject({ kind: 'backup',
            actionId: 'deployments.backups.inventory', environmentId: f.environment.id, deploymentId: f.receipt.id });
        await expect(mint('deployments.backups.run')).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint('deployments.backups.inventory', input, foreign.account.id)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint('deployments.backups.inventory', { ...input, deploymentId: foreign.receipt.id }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it.each(['plain', 'e2ee'] as const)('spends configured backup admission in %s on the exact serving receipt', async contentMode => {
        const f = await fixture('team', 'account', { contentMode });
        const other = await fixture();
        const historical = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'failed',
            ...await f.content('deployment-receipt.v1') } });
        const predecessorLink = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            ...await f.content('deployment-target-link.v1') } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { predecessorTargetLinkId: predecessorLink.id } });
        const predecessorReceipt = await db.deployment.create({ data: { ...historical, id: crypto.randomUUID(),
            targetLinkId: predecessorLink.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
            ...await f.content('deployment-receipt.v1') } });
        const unrelatedLink = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            ...await f.content('deployment-target-link.v1') } });
        const unrelatedReceipt = await db.deployment.create({ data: { ...historical, id: crypto.randomUUID(),
            targetLinkId: unrelatedLink.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
            ...await f.content('deployment-receipt.v1') } });
        const domainContent = await f.content('deployment-domain.v1');
        const retainedDomainContent = await f.content('deployment-domain.v1');
        const unrelatedDomainContent = await f.content('deployment-domain.v1');
        const capturedDomainId = crypto.randomUUID();
        const domainCapture = { desired: true, content: retainedDomainContent, listener: 'privateOrigin', dockerEngineId: 'member-engine',
            installationPublicKey: privacyKit.encodeBase64(new Uint8Array(f.member.keys.publicKey), 'base64url'),
            placement: { serverId, accountId: f.account.id, environmentId: f.environment.id, targetLinkId: f.link.id,
                machineId: f.member.id, installationId: f.member.installationId, nativeServer: 'private',
                domainId: capturedDomainId, requestId: crypto.randomUUID(), actionOperationId: crypto.randomUUID() } };
        await db.deploymentDomain.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            id: capturedDomainId, createdByAccountId: f.account.id, state: 'active', ...domainContent,
            capturedPlacements: [domainCapture, { ...domainCapture, content: unrelatedDomainContent,
                placement: { ...domainCapture.placement, targetLinkId: unrelatedLink.id } }] } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
        const grant = { v: 1 as const, kind: 'environmentValues' as const, environmentId: f.environment.id,
            machineId: f.member.id, installationId: f.member.installationId,
            binding: { purpose: 'variable' as const, phase: 'runtime' as const, name: 'BACKUP_DATABASE' },
            sealedContent: 'opaque-installation-encrypted-environment-values' };
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: f.environment.id, grants: [grant] }));
        for (const actionId of DEPLOYMENT_BACKUP_ACTION_IDS_V1) {
            const input = buildDeploymentBackupActionInputV1(actionId, { serverId, environmentId: f.environment.id,
                deploymentId: f.receipt.id, targetLinkId: f.link.id, machineId: f.member.id,
                installationId: f.member.installationId, expectedRevision: f.environmentRevision, configRevision: 1,
                ...(actionId === 'deployments.backups.verify' ? { backupOperationId: crypto.randomUUID(),
                    snapshotId: 'a'.repeat(64), level: 'manifestReadBack' as const } : {}),
                ...(actionId === 'deployments.backups.prune' ? { retention: { kind: 'keepEverything' as const } } : {}) });
            const target = { kind: 'machine' as const, machineId: f.member.id };
            const requestId = crypto.randomUUID();
            const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
            const mint = async (value = input, accountId = f.account.id) => {
                const wire = contentMode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
                    accountId, authentication, actionId, requestId, target }, input: value,
                    material: { type: 'dataKey', machineKey: f.member.contentKey }, randomBytes: nacl.randomBytes })
                    : { v: 1 as const, requestId, target, input: value };
                const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: wire });
                return auth.mintExternalActionExecutionAuthorization({ accountId, serverIdentityId: serverId,
                    authentication, actionId, machineId: f.member.id, target, requestId, admittedMachineRole: 'use',
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(wire) }, {
                    input: wire.v === 1 ? value : deploymentNativeAdmission, deploymentNativeAdmission });
            };
            const authorization = await mint();
            expect(authorization.binding).toMatchObject({ environmentId: f.environment.id,
                deploymentNativeAdmission: { kind: 'backup', actionId, deploymentId: f.receipt.id, configRevision: 1 } });
            expect(authorization.binding.deploymentCandidatePublication).toBeUndefined();
            await expect(mint(input, other.account.id)).rejects.toMatchObject({ code: 'credential_scope_denied' });
            await expect(mint({ ...input, deploymentId: other.receipt.id })).rejects.toMatchObject({ code: 'credential_scope_denied' });
            await expect(mint({ ...input, expectedRevision: f.environmentRevision - 1 })).rejects.toMatchObject({ code: 'credential_scope_denied' });
            const headers = (method: string, path: string, body?: unknown, effectActionId: string = actionId) => ({
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId: f.member.installationId, requestId,
                    method, path, body, privateKey: f.member.keys.secretKey }),
            });
            await withAuthenticatedTestApp(app => { registerExternalActionRoutes(app); registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
                const verificationPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
                const verificationBody = { v: 1, admittedMachineRole: 'use' };
                const queries: string[] = [];
                const stop = observeSqliteRequests({ before: query => { if (query.model) queries.push(query.model); } });
                const verified = await app.inject({ method: 'POST', url: verificationPath, payload: verificationBody,
                    headers: headers('POST', verificationPath, verificationBody) }).finally(stop);
                expect(verified.statusCode, verified.body).toBe(200);
                expect(queries.filter(model => ['ProjectSource', 'Team', 'TeamMembership', 'MachineTeamGrant', 'MachineAccountGrant', 'Session', 'AccessKey'].includes(model))).toEqual([]);
                // Quiescing capture publishes expected-down evidence from this Environment's Domains.
                if (actionId === 'deployments.backups.run') {
                    const read = (environmentId: string) => {
                        const spec = getActionSpec('deployments.domains.list');
                        if (!spec.serverTransport) throw new Error('Domain list transport missing');
                        const bound = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema,
                            input: { serverId, environmentId } });
                        return app.inject({ method: 'GET', url: bound.path,
                            headers: headers('GET', bound.path, undefined, 'deployments.domains.list') });
                    };
                    const own = await read(f.environment.id);
                    expect(own.statusCode, own.body).toBe(200);
                    expect((await read(other.environment.id)).statusCode).toBe(401);
                    const artifactPath = `/v1/artifacts/${retainedDomainContent.contentArtifactId}`;
                    const artifact = await app.inject({ method: 'GET', url: artifactPath,
                        headers: headers('GET', artifactPath) });
                    expect(artifact.statusCode, `backup expected-down Domain Artifact: ${artifact.body}`).toBe(200);
                    for (const content of [unrelatedDomainContent, unrelatedLink, other.receipt]) {
                        const foreignArtifactPath = `/v1/artifacts/${content.contentArtifactId}`;
                        const foreignArtifact = await app.inject({ method: 'GET', url: foreignArtifactPath,
                            headers: headers('GET', foreignArtifactPath) });
                        expect(foreignArtifact.statusCode, foreignArtifact.body).toBe(401);
                    }
                }
                const path = `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`;
                const body = EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ serverId, environmentId: f.environment.id,
                    targetLinkId: f.link.id, machineId: f.member.id, installationId: f.member.installationId,
                    materialization: { kind: 'deployment', deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId } });
                const value = { ...body, proof: signMachineInstallationProof({ payload: { version: 1,
                    accountId: f.account.id, machineId: f.member.id, installationId: f.member.installationId,
                    deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                    privateKey: f.member.keys.secretKey }) };
                const secrets = await app.inject({ method: 'POST', url: path, payload: value, headers: headers('POST', path, value) });
                expect(secrets.statusCode, secrets.body).toBe(200);
                expect(secrets.json()).toEqual({ ok: true, grants: [grant] });
                if (actionId === 'deployments.backups.prune') {
                    // Prune protects unsettled pre-migration captures, so it reads its own Environment's receipt history.
                    const listSpec = getActionSpec('deployments.receipts.list');
                    if (!listSpec.serverTransport) throw new Error('Receipt list transport unavailable');
                    const listPath = (environmentId: string) => bindHomeDomainHttpRequestV1({ transport: listSpec.serverTransport!,
                        inputSchema: listSpec.inputSchema, input: { serverId, environmentId } }).path;
                    const history = await app.inject({ method: 'GET', url: listPath(f.environment.id),
                        headers: headers('GET', listPath(f.environment.id), undefined, 'deployments.receipts.list') });
                    expect(history.statusCode, history.body).toBe(200);
                    expect((await app.inject({ method: 'GET', url: listPath(other.environment.id),
                        headers: headers('GET', listPath(other.environment.id), undefined, 'deployments.receipts.list') })).statusCode).toBe(401);
                    // Prune opens history to protect snapshots referenced by unsettled migration captures.
                    for (const receipt of [historical, predecessorReceipt, unrelatedReceipt, other.receipt]) {
                        const readSpec = getActionSpec('deployments.receipts.get');
                        if (!readSpec.serverTransport) throw new Error('Receipt read transport unavailable');
                        const readPath = bindHomeDomainHttpRequestV1({ transport: readSpec.serverTransport,
                            inputSchema: readSpec.inputSchema, input: { serverId, environmentId: receipt.environmentId,
                                deploymentId: receipt.id } }).path;
                        const expected = receipt.id === historical.id || receipt.id === predecessorReceipt.id ? 200 : 401;
                        const metadata = await app.inject({ method: 'GET', url: readPath,
                            headers: headers('GET', readPath, undefined, 'deployments.receipts.get') });
                        expect(metadata.statusCode, metadata.body).toBe(expected);
                        const artifactPath = `/v1/artifacts/${receipt.contentArtifactId}`;
                        const artifact = await app.inject({ method: 'GET', url: artifactPath,
                            headers: headers('GET', artifactPath) });
                        expect(artifact.statusCode, artifact.body).toBe(expected);
                    }
                }
                const foreignPath = `/v1/artifacts/${other.receipt.contentArtifactId}`;
                expect((await app.inject({ method: 'GET', url: foreignPath, headers: headers('GET', foreignPath) })).statusCode).toBe(401);
            }, { authentication: 'real' });
        }
        expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } })).activeDeploymentId).toBe(f.receipt.id);
    });

    it.each(['plain', 'e2ee'] as const)('admits copy source read only for the exact source-member restore in %s', async contentMode => {
        const f = await fixture('team', 'account', { contentMode, separateContentOwner: true, separateMemberCustodian: true });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { revision: f.environment.revision + 1 } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'failed' } });
        const sourceActive = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'succeeded',
            ...await f.content('deployment-receipt.v1') } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: sourceActive.id } });
        const destinationSource = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Copy destination', audience: [], owner: { kind: 'team', teamId: f.team!.id }, repository: { protocol: 'https',
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'copy/destination', cloneUrl: 'https://github.com/copy/destination.git' } } }));
        if (!destinationSource.ok) throw new Error(destinationSource.error);
        const destination = await db.deploymentEnvironment.create({ data: { projectSourceId: destinationSource.source.id,
            createdByAccountId: f.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.controller.id, ...await f.content('deployment-environment.v1') } });
        const destinationLink = await db.deploymentTargetLink.create({ data: { environmentId: destination.id,
            createdByAccountId: f.account.id, role: 'runtime', state: 'deployed', sourceKind: 'host',
            hostTargetId: 'own-server', targetKind: 'ownServer', ...await f.content('deployment-target-link.v1'),
            machines: { create: [{ machineId: f.controller.id, installationId: f.controller.installationId, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: destination.id }, data: { runtimeTargetLinkId: destinationLink.id } });
        const activeDestination = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            environmentId: destination.id, targetLinkId: destinationLink.id, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), state: 'succeeded', ...await f.content('deployment-receipt.v1') } });
        await db.deploymentTargetLink.update({ where: { id: destinationLink.id }, data: { activeDeploymentId: activeDestination.id } });
        const resourceId = crypto.randomUUID();
        const resourceContent = { v: 1 as const, name: 'Copy repository password', kind: 'password' as const,
            value: 'private-copy-repository-password' };
        await db.savedSecretResource.create({ data: { id: resourceId, ownerAccountId: f.account.id,
            displayName: resourceContent.name, kind: resourceContent.kind, encryptionMode: contentMode,
            storedContent: JSON.stringify(sealSavedSecretResourceStoredContentV1(contentMode === 'plain'
                ? { resourceId, mode: contentMode, content: resourceContent }
                : { resourceId, mode: contentMode, content: resourceContent,
                    resourceDataKey: nacl.randomBytes(32), randomBytes: nacl.randomBytes })) } });
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: f.environment.id,
            machineId: f.member.id, installationId: f.member.installationId,
            resourceId, resourceRevision: 1 }, installationPublicKey: f.member.keys.publicKey,
            content: { kind: 'secret', value: 'private-copy-repository-password' } });
        const sourceUses = (['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const).map(role => ({
            purpose: 'backupDestination' as const, configKey: 'destination' as const, role,
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 },
        }));
        const unusedResourceId = crypto.randomUUID();
        const unusedContent = { ...resourceContent, name: 'Unused runtime secret', value: 'unused-source-sentinel' };
        await db.savedSecretResource.create({ data: { id: unusedResourceId, ownerAccountId: f.account.id,
            displayName: unusedContent.name, kind: unusedContent.kind, encryptionMode: contentMode,
            storedContent: JSON.stringify(sealSavedSecretResourceStoredContentV1(contentMode === 'plain'
                ? { resourceId: unusedResourceId, mode: contentMode, content: unusedContent }
                : { resourceId: unusedResourceId, mode: contentMode, content: unusedContent,
                    resourceDataKey: nacl.randomBytes(32), randomBytes: nacl.randomBytes })) } });
        const unusedBinding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'UNUSED_SOURCE_VALUE',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(unusedResourceId), resourceRevision: 1 } };
        const sourceContent = { ...createDeploymentEnvironmentDetailV1().content, bindings: [...sourceUses, unusedBinding] };
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: {
            ...await f.content('deployment-environment.v1', sourceContent),
            referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(sourceContent.bindings),
        } });
        // This other SavedSecret is source-bound, but it is never a backup credential.
        const unused = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: f.environment.id,
            machineId: f.member.id, installationId: f.member.installationId,
            resourceId: unusedResourceId, resourceRevision: 1 },
            installationPublicKey: f.member.keys.publicKey,
            content: { kind: 'secret', value: unusedContent.value } });
        const destinationGrant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: destination.id,
            machineId: f.member.id, installationId: f.member.installationId, resourceId, resourceRevision: 1 },
            installationPublicKey: f.member.keys.publicKey, content: { kind: 'secret', value: 'destination-sentinel' } });
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: f.environment.id, grants: [grant, unused] }));
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: destination.id, grants: [destinationGrant] }));
        const actionId = 'deployments.backups.restore' as const;
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const input = { mode: 'prepare' as const, serverId, environmentId: destination.id,
            targetLinkId: destinationLink.id, deploymentId: f.receipt.id, machineId: f.member.id,
            installationId: f.member.installationId, expectedRevision: destination.revision,
            source: { kind: 'repository' as const, snapshotId: 'source-snapshot',
                origin: { environmentId: f.environment.id, targetLinkId: f.link.id } },
            destination: { kind: 'database' as const, service: 'database', database: 'copied_database' } };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const mint = (value: DeploymentBackupRestoreInputV1 = input, accountId = f.account.id) => {
            const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
            const executionTarget = { kind: 'machine' as const, machineId: value.machineId };
            const wire = contentMode === 'e2ee' ? sealExternalActionRequestV2({
                projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding: { serverIdentityId: serverId, accountId, authentication, actionId,
                    requestId: envelope.requestId, target: executionTarget }, input: value,
                material: { type: 'dataKey', machineKey: f.member.contentKey }, randomBytes: nacl.randomBytes })
                : { ...envelope, target: executionTarget, input: value };
            const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: wire });
            return auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId, accountId, authentication,
                actionId, machineId: value.machineId, target: executionTarget,
                requestId: envelope.requestId, admittedMachineRole: 'use',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(wire) },
            { input: wire.v === 1 ? value : deploymentNativeAdmission, deploymentNativeAdmission });
        };
        const authorization = await mint();
        const confirmed = await mint({ ...input, mode: 'confirm', prepareOperationId: crypto.randomUUID() });
        expect(confirmed.binding.deploymentNativeAdmission).toMatchObject({
            mode: 'confirm', source: input.source, destination: input.destination,
        });
        await expect(mint({ ...input, source: { kind: 'repository', snapshotId: input.source.snapshotId } }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint({ ...input, machineId: f.outsider.id, installationId: f.outsider.installationId }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        const otherAccount = await db.account.create({ data: { encryptionMode: contentMode } });
        await expect(mint(input, otherAccount.id)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        // Keep caller, source Manage and Machine authority fixed; withdraw only destination Manage.
        await db.projectSource.update({ where: { id: destinationSource.source.id }, data: { owner: { kind: 'account', accountId: otherAccount.id } } });
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.projectSource.update({ where: { id: destinationSource.source.id }, data: { owner: { kind: 'team', teamId: f.team!.id } } });
        // Destination Manage alone cannot admit a source read.
        await db.projectSource.update({ where: { id: f.environment.projectSourceId }, data: { owner: { kind: 'account', accountId: otherAccount.id } } });
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.projectSource.update({ where: { id: f.environment.projectSourceId }, data: { owner: { kind: 'team', teamId: f.team!.id } } });
        await expect(mint({ ...input, deploymentId: activeDestination.id })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
        // Withdrawal applies to the next admission; the already admitted finite copy retains its source custody.
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        const headers = (path: string, body: unknown, method = 'POST', effectActionId: string = actionId) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target, installationId: f.member.installationId,
                requestId: authorization.binding.requestId, method, path, body, privateKey: f.member.keys.secretKey }),
        });
        const secretBody = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id,
            machineId: f.member.id, installationId: f.member.installationId,
            materialization: { kind: 'copySourceRead', deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId } };
        const signed = (value: unknown) => {
            const body = EnvironmentSecretLaunchAdmissionBodyV1Schema.parse(value);
            return { ...body, proof: signMachineInstallationProof({ payload: { version: 1,
                accountId: f.account.id, machineId: body.machineId, installationId: body.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(
                    body) } }, privateKey: f.member.keys.secretKey }) };
        };
        const admittedRestore = authorization.binding.deploymentNativeAdmission;
        if (!admittedRestore || !('kind' in admittedRestore) || admittedRestore.kind !== 'restore'
            || admittedRestore.source.kind !== 'repository' || !admittedRestore.source.origin) {
            throw new Error('Expected admitted copy restore');
        }
        // Home owns these identities. The private delivery owner consumes its admission,
        // while the HTTP controls below prove substitutions cannot cross that boundary.
        const delivery = await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, f.account.id, signed(secretBody), {}, undefined, {
            ...admittedRestore, machineId: f.outsider.id, installationId: f.outsider.installationId,
            source: { ...admittedRestore.source, origin: { environmentId: destination.id, targetLinkId: destinationLink.id } },
        }));
        expect(delivery).toEqual({ ok: true, grants: [grant] });
        for (const admission of [undefined, { ...admittedRestore, source: { ...admittedRestore.source, origin: undefined } }]) {
            expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, f.account.id, signed(secretBody), {}, undefined,
                admission))).toEqual({ ok: false, error: 'deployment_access_denied' });
        }
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); projectSourceRoutes(app); }, async app => {
            const path = `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`;
            const body = signed(secretBody);
            const models: string[] = [];
            const stop = observeSqliteRequests({ before: query => { if (query.model) models.push(query.model); } });
            const response = await app.inject({ method: 'POST', url: path, payload: body, headers: headers(path, body) }).finally(stop);
            expect(response.statusCode, response.body).toBe(200);
            const delivered = EnvironmentSecretLaunchAdmissionResultV1Schema.parse(response.json());
            expect(delivered).toMatchObject({ ok: true });
            if (!delivered.ok) throw new Error(delivered.error);
            expect(delivered.grants).toEqual([grant]);
            expect(openMachineSecretGrant({ grant: delivered.grants.find(value => value.kind === 'secret')!, machineId: f.member.id,
                installationId: f.member.installationId, installationPrivateSeed: f.member.keys.secretKey.slice(0, 32) }))
                .toEqual({ kind: 'secret', value: 'private-copy-repository-password' });
            expect(openMachineSecretGrant({ grant, machineId: f.outsider.id, installationId: f.outsider.installationId,
                installationPrivateSeed: f.outsider.keys.secretKey.slice(0, 32) })).toBeNull();
            const destinationSecretBody = { serverId, environmentId: destination.id, targetLinkId: destinationLink.id,
                machineId: f.member.id, installationId: f.member.installationId,
                materialization: { kind: 'deployment', deploymentId: activeDestination.id,
                    actionOperationId: activeDestination.actionOperationId } };
            const destinationPath = `/v1/deployments/environments/${destination.id}/secret-launch-admission`;
            const destinationBody = signed(destinationSecretBody);
            const destinationResponse = await app.inject({ method: 'POST', url: destinationPath, payload: destinationBody,
                headers: headers(destinationPath, destinationBody) });
            expect(destinationResponse.statusCode, destinationResponse.body).toBe(200);
            expect(EnvironmentSecretLaunchAdmissionResultV1Schema.parse(destinationResponse.json()))
                .toEqual({ ok: true, grants: [destinationGrant] });
            for (const materialization of [
                { ...destinationSecretBody.materialization, deploymentId: f.receipt.id },
                { ...destinationSecretBody.materialization, actionOperationId: f.receipt.actionOperationId },
            ]) {
                const substituted = signed({ ...destinationSecretBody, materialization });
                const denied = await app.inject({ method: 'POST', url: destinationPath, payload: substituted,
                    headers: headers(destinationPath, substituted) });
                expect(denied.statusCode).toBe(401);
                expect(denied.json()).not.toHaveProperty('grants');
            }
            let deliveredSourceBindings: readonly EnvironmentSecretBindingV1[] | undefined;
            const sourceEnvironment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
            const receiptSpec = getActionSpec('deployments.receipts.get');
            if (!receiptSpec.serverTransport) throw new Error('Receipt transport unavailable');
            const receiptTransport = receiptSpec.serverTransport;
            const receiptPath = (environmentId: string, deploymentId: string) => bindHomeDomainHttpRequestV1({ transport: receiptTransport,
                inputSchema: receiptSpec.inputSchema, input: { serverId, environmentId, deploymentId } }).path;
            for (const [readPath, effect] of [
                [`/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`, 'deployments.environments.get'],
                [receiptPath(f.environment.id, f.receipt.id), 'deployments.receipts.get'],
                [`/v1/projects/sources/${f.environment.projectSourceId}?serverId=${serverId}`, 'projects.sources.read'],
                [`/v1/artifacts/${sourceEnvironment.contentArtifactId}`, actionId],
                [`/v1/deployments/environments/${destination.id}?serverId=${serverId}`, 'deployments.environments.get'],
                [receiptPath(destination.id, activeDestination.id), 'deployments.receipts.get'],
                [`/v1/artifacts/${destination.contentArtifactId}`, actionId],
            ]) {
                const stopRead = observeSqliteRequests({ before: query => { if (query.model) models.push(query.model); } });
                const read = await app.inject({ method: 'GET', url: readPath, headers: headers(readPath, undefined, 'GET', effect) }).finally(stopRead);
                expect(read.statusCode, `${readPath}: ${read.body}`).toBe(200);
                if (readPath === `/v1/artifacts/${sourceEnvironment.contentArtifactId}`) {
                    const artifact = ArtifactHttpReadV1Schema.parse(read.json());
                    const key = contentMode === 'e2ee' ? openEncryptedDataKeyEnvelopeV1({
                        envelope: privacyKit.decodeBase64(artifact.dataEncryptionKey), recipientSecretKeyOrSeed: f.accountKeys.secretKey }) : null;
                    const decode = async (value: string) => {
                        if (contentMode === 'plain') return decodePlainArtifactStoredContent(value);
                        if (!key) throw new Error('Original requester envelope unavailable');
                        const opened = await openSessionDataKeyBundleV0(privacyKit.decodeBase64(value), key);
                        if (opened.status !== 'authenticated') throw new Error('Source content did not authenticate');
                        return opened.value;
                    };
                    const opened = readDeploymentEnvironmentArtifactV1(sourceEnvironment, { artifactId: artifact.id,
                        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
                        header: ArtifactHeaderMetadataV1Schema.parse(await decode(artifact.header)),
                        body: ArtifactBodyEnvelopeV1Schema.parse(await decode(artifact.body)).body });
                    if (!opened.ok) throw new Error(opened.error);
                    deliveredSourceBindings = opened.content.bindings;
                }
            }
            expect(models.filter(model => ['Team', 'TeamMembership', 'MachineTeamGrant', 'MachineAccountGrant', 'AccessKey'].includes(model))).toEqual([]);
            if (!deliveredSourceBindings) throw new Error('Source binding capture was not delivered');
            const scratch = await mkdtemp(join(tmpdir(), 'happier-copy-source-'));
            try {
                const materialized = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: f.environment.id,
                    machineId: f.member.id, installationId: f.member.installationId,
                    installationPrivateSeed: f.member.keys.secretKey.slice(0, 32), bindings: deliveredSourceBindings,
                    backupDestinationUses: deliveredSourceBindings.filter((binding): binding is Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> => binding.purpose === 'backupDestination'),
                    grants: delivered.grants, backupConfigBaseDir: scratch,
                    assertCurrent: async () => {} });
                try {
                    expect(materialized.refs).toEqual([{ resourceId, resourceRevision: 1 }]);
                    expect(materialized.secretValues).toEqual(['private-copy-repository-password']);
                    expect(materialized.env).not.toHaveProperty('UNUSED_SOURCE_VALUE');
                    expect(JSON.stringify(materialized)).not.toContain('destination-sentinel');
                } finally { materialized.dispose(); }
                await expect(prepareEnvironmentSecretBindingsForLaunch({ environmentId: f.environment.id,
                    machineId: f.member.id, installationId: f.member.installationId,
                    installationPrivateSeed: f.member.keys.secretKey.slice(0, 32), bindings: [],
                    backupDestinationUses: sourceUses, grants: delivered.grants, backupConfigBaseDir: scratch,
                    assertCurrent: async () => {} })).rejects.toMatchObject({ code: 'secret_missing' });
            } finally { await rm(scratch, { recursive: true, force: true }); }
            const staleArtifactPath = `/v1/artifacts/${f.environment.contentArtifactId}`;
            expect((await app.inject({ method: 'GET', url: staleArtifactPath,
                headers: headers(staleArtifactPath, undefined, 'GET') })).statusCode).toBe(401);
            for (const wrong of [
                { ...secretBody, environmentId: destination.id, targetLinkId: destinationLink.id },
                { ...secretBody, machineId: f.outsider.id, installationId: f.outsider.installationId },
                { ...secretBody, materialization: { ...secretBody.materialization, actionOperationId: crypto.randomUUID() } },
                { ...secretBody, materialization: { ...secretBody.materialization,
                    deploymentId: sourceActive.id, actionOperationId: sourceActive.actionOperationId } },
            ]) {
                const refusedBody = signed(wrong);
                const refusedPath = `/v1/deployments/environments/${wrong.environmentId}/secret-launch-admission`;
                const denied = await app.inject({ method: 'POST', url: refusedPath, payload: refusedBody,
                    headers: headers(refusedPath, refusedBody) });
                expect(denied.statusCode).toBe(401);
                expect(denied.json()).not.toHaveProperty('grants');
            }
            await db.deploymentEnvironment.update({ where: { id: f.environment.id },
                data: { referencedSavedSecretRevisions: [{ resourceId, revision: 1 }] } });
            const incomplete = await app.inject({ method: 'POST', url: path, payload: body, headers: headers(path, body) });
            expect(incomplete.json()).toEqual({ ok: false, error: 'secret_missing' });
            expect(incomplete.json()).not.toHaveProperty('grants');
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('admits standalone restore of a failed capture in %s without changing the code receipt', async contentMode => {
        const f = await fixture('team', 'account', { contentMode, separateControllerCustodian: true });
        const credentials = [{ purpose: { consumer: managedQb56Input.selection.launch.provider, purpose: 'provider' },
            account: { service: { pluginId: 'test.machine.provider', localId: 'provider' }, accountId: 'custodian-provider-account' } }];
        const managed = await db.managedMachine.create({ data: { homeId: serverId,
            custodianAccountId: f.controller.accountId, controllerMachineId: f.controller.id,
            controllerInstallationId: f.controller.installationId, enrolledMachineId: f.member.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, launch: { ...managedQb56Input.selection.launch, credentials },
            allocation: 'bound', creationState: 'active', resource: { contributionRef: managedQb56Input.selection.launch.provider,
                schemaVersion: 1, value: { instance: 'restore-snapshot-target' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', power: 'running', storage: 'retained', observedAt: 10 } } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
        const capture = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'failed',
            ...await f.content('deployment-receipt.v1') } });
        const other = await fixture();
        // The private storage boundary retains installation ciphertext; this server never opens it.
        const grant = { v: 1 as const, kind: 'environmentValues' as const, environmentId: f.environment.id,
            machineId: f.member.id, installationId: f.member.installationId,
            binding: { purpose: 'variable' as const, phase: 'runtime' as const, name: 'RESTORE_DATABASE' },
            sealedContent: 'opaque-installation-encrypted-environment-values' };
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: f.environment.id, grants: [grant] }));
        const actionId = 'deployments.backups.restore' as const;
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const input = { mode: 'prepare' as const, serverId, environmentId: f.environment.id,
            deploymentId: capture.id, targetLinkId: f.link.id, machineId: f.member.id,
            installationId: f.member.installationId, source: { kind: 'repository' as const, snapshotId: 'pre-migration' },
            expectedRevision: f.environmentRevision };
        const sourceSession = await db.session.create({ data: { accountId: f.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: contentMode } });
        await db.accessKey.create({ data: { accountId: f.account.id, machineId: f.controller.id,
            sessionId: sourceSession.id, data: 'admitted-session-source' } });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const sessionActionOrigin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: sourceSession.id,
            starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'restore-turn', callerPermissionMode: null, requestId: envelope.requestId };
        const mintRequest = async (value: DeploymentBackupRestoreInputV1 = input, accountId = f.account.id, fromSession = false) => {
            const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
            const wire = contentMode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
                accountId, authentication, actionId, requestId: envelope.requestId, target }, input: value,
                material: { type: 'dataKey', machineKey: f.member.contentKey }, randomBytes: nacl.randomBytes })
                : { ...envelope, input: value };
            const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: wire });
            const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId, serverIdentityId: serverId, authentication, actionId,
                machineId: f.member.id, target, requestId: envelope.requestId, admittedMachineRole: 'use',
                ...(fromSession ? { sessionActionOrigin,
                    sessionActionSource: { machineId: f.controller.id, installationId: f.controller.installationId } } : {}),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(wire) }, {
                input: wire.v === 1 ? value : deploymentNativeAdmission, deploymentNativeAdmission,
                resolveCurrentSessionMachine: async () => f.controller.id });
            return { authorization, wire };
        };
        const mint = async (value: DeploymentBackupRestoreInputV1 = input, accountId = f.account.id, fromSession = false) =>
            (await mintRequest(value, accountId, fromSession)).authorization;
        const authorization = await mint();
        expect(authorization.binding).toMatchObject({ environmentId: f.environment.id,
            deploymentNativeAdmission: { kind: 'restore', mode: 'prepare', deploymentId: capture.id } });
        expect(authorization.binding.deploymentCandidatePublication).toBeUndefined();
        expect((await mint({ ...input, mode: 'confirm', prepareOperationId: crypto.randomUUID() })).binding)
            .toMatchObject({ deploymentNativeAdmission: { kind: 'restore', mode: 'confirm', deploymentId: capture.id } });
        await expect(mint(input, other.account.id)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint({ ...input, deploymentId: other.receipt.id })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint({ ...input, expectedRevision: input.expectedRevision - 1 })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint({ ...input, machineId: f.outsider.id })).rejects.toBeDefined();
        const sessionAuthorization = await mint(input, f.account.id, true);
        // A finite root retains its admitted requester after the originating Session stops publishing.
        await db.accessKey.deleteMany({ where: { accountId: f.account.id, sessionId: sourceSession.id } });
        const headers = (method: string, path: string, body?: unknown, effectActionId: string = actionId, token = authorization.token) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: token,
                effectActionId, target, installationId: f.member.installationId, requestId: authorization.binding.requestId,
                method, path, body, privateKey: f.member.keys.secretKey }),
        });
        const receiptSpec = getActionSpec('deployments.receipts.get');
        if (!receiptSpec.serverTransport) throw new Error('Receipt Action transport unavailable');
        const receiptTransport = receiptSpec.serverTransport;
        const receiptPath = (deploymentId: string, environmentId = f.environment.id) => bindHomeDomainHttpRequestV1({
            transport: receiptTransport, inputSchema: receiptSpec.inputSchema, input: { serverId, environmentId, deploymentId } }).path;
        await withAuthenticatedTestApp(app => { registerExternalActionRoutes(app); registerDeploymentRoutes(app); registerManagedMachineRoutes(app); artifactsRoutes(app); projectSourceRoutes(app); registerProjectAccountRowRoutes(app); }, async app => {
            const managedPath = managedMachineActionEndpointPathV1('machines.managed.list');
            const managedInput = { homeId: serverId, enrolledMachineId: f.member.id };
            const managedRead = await app.inject({ method: 'POST', url: managedPath, payload: managedInput,
                headers: headers('POST', managedPath, managedInput, 'machines.managed.list') });
            expect(managedRead.statusCode, managedRead.body).toBe(200);
            expect(managedRead.json().machines.map((row: { id: string }) => row.id)).toEqual([managed.id]);
            expect(managedRead.json().machines[0].launch).not.toHaveProperty('credentials');
            const otherManagedInput = { ...managedInput, enrolledMachineId: f.outsider.id };
            expect((await app.inject({ method: 'POST', url: managedPath, payload: otherManagedInput,
                headers: headers('POST', managedPath, otherManagedInput, 'machines.managed.list') })).statusCode).toBe(401);
            // The installed prepare reader signs its offer read itself; Home must admit exactly what it sends.
            const offerReader = createDaemonDeploymentNativeSnapshot({ serverHttpBaseUrl: await app.listen({ host: '127.0.0.1', port: 0 }) }, {
                headers: async (_context, effectActionId, request) => headers(request.method, request.path, request.body, effectActionId),
                sendChild: async () => { throw new Error('Restore prepare dispatches no child'); } });
            await expect(offerReader.read(input, {})).resolves.toBeNull();
            const offer = { managedId: managed.id, intentRevision: managed.intentRevision,
                controller: { machineId: f.controller.id, installationId: f.controller.installationId },
                resource: { contributionRef: managedQb56Input.selection.launch.provider,
                    schemaVersion: 1, value: { instance: 'restore-snapshot-target' } },
                contribution: managedQb56Input.selection.launch.provider,
                coverage: { rootDisk: true, attachedVolumes: false },
                cost: { kind: 'billed' as const, source: 'provider' }, consistency: 'running' as const };
            const confirm = { ...input, mode: 'confirm' as const, prepareOperationId: crypto.randomUUID(), snapshotReview: offer };
            const issued = await mintRequest(confirm);
            const snapshot = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'snapshot', actionId,
                ...offer.controller, offer, input: confirm, actionOperationId: crypto.randomUUID(),
                label: 'Before restore', reason: 'Restore pre-risk snapshot' });
            const packetFor = (job: DeploymentChildRpcV1 = snapshot) => {
                const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
                const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
                return { method, requestId, params: job, originalActionEnvelope: issued.wire,
                    externalActionExecution: { v: 1 as const, authorization: issued.authorization, effectActionId: actionId,
                        target, installationId: f.member.installationId, deploymentChildRouting,
                        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: issued.authorization.token,
                            effectActionId: actionId, target, installationId: f.member.installationId,
                            method, requestId, params: job, deploymentChildRouting, event: SOCKET_RPC_EVENTS.CALL,
                            privateKey: f.member.keys.secretKey }) } };
            };
            const snapshotHeaders = (method: string, path: string, body: unknown, packet = packetFor(), signer = f.controller) => ({
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: issued.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: issued.authorization.token,
                    effectActionId: actionId, target, installationId: signer.installationId,
                    requestId: issued.authorization.binding.requestId, method, path, body,
                    deploymentChildExecution: packet, privateKey: signer.keys.secretKey }),
            });
            const getPath = managedMachineActionEndpointPathV1('machines.managed.get');
            const getBody = { homeId: serverId, managedId: managed.id };
            const read = await app.inject({ method: 'POST', url: getPath, payload: getBody,
                headers: snapshotHeaders('POST', getPath, getBody) });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ id: managed.id, intentRevision: managed.intentRevision,
                resource: offer.resource, launch: { credentials } });
            const wrongGetBody = { ...getBody, managedId: crypto.randomUUID() };
            expect((await app.inject({ method: 'POST', url: getPath, payload: wrongGetBody,
                headers: snapshotHeaders('POST', getPath, wrongGetBody) })).statusCode).toBe(401);
            if (snapshot.kind !== 'snapshot') throw new Error('Expected snapshot child');
            for (const substituted of [
                { ...snapshot.input, machineId: f.outsider.id },
                { ...snapshot.input, installationId: f.outsider.installationId },
                { ...snapshot.input, prepareOperationId: crypto.randomUUID() },
            ]) {
                const packet = packetFor({ ...snapshot, input: substituted });
                expect((await app.inject({ method: 'POST', url: getPath, payload: getBody,
                    headers: snapshotHeaders('POST', getPath, getBody, packet) })).statusCode).toBe(401);
            }
            const codecPath = `/v1/machines/${encodeURIComponent(f.controller.id)}`;
            const codecPacket = packetFor();
            expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: issued.authorization.token,
                effectActionId: actionId, encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path: codecPath,
                deploymentChildExecution: createDeploymentChildExecutionProofV1(codecPacket),
                machineSignature: snapshotHeaders('GET', codecPath, undefined, codecPacket, f.member)[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
            })).not.toBeNull();
            await db.managedMachine.update({ where: { id: managed.id }, data: { intentRevision: managed.intentRevision + 1 } });
            expect((await app.inject({ method: 'POST', url: getPath, payload: getBody,
                headers: snapshotHeaders('POST', getPath, getBody) })).statusCode).toBe(401);
            const verificationPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const verificationBody = { v: 1, admittedMachineRole: 'use' };
            const verificationQueries: string[] = [];
            const stopVerification = observeSqliteRequests({ before: query => { if (query.model) verificationQueries.push(query.model); } });
            const verification = await app.inject({ method: 'POST', url: verificationPath, payload: verificationBody,
                headers: headers('POST', verificationPath, verificationBody) }).finally(stopVerification);
            expect(verification.statusCode, verification.body).toBe(200);
            expect(verificationQueries.filter(model => ['ProjectSource', 'Team', 'TeamMembership', 'MachineTeamGrant', 'MachineAccountGrant', 'Session', 'AccessKey'].includes(model))).toEqual([]);
            for (const [url, effect] of [
                [`/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`, 'deployments.environments.get'],
                [`/v1/projects/sources/${f.environment.projectSourceId}?serverId=${serverId}`, 'projects.sources.read'],
                ...[capture.id, f.receipt.id].map(id => [receiptPath(id), 'deployments.receipts.get']),
                ...[f.environment.contentArtifactId, f.link.contentArtifactId, capture.contentArtifactId, f.receipt.contentArtifactId]
                    .map(id => [`/v1/artifacts/${id}`, actionId]),
            ]) {
                const response = await app.inject({ method: 'GET', url, headers: headers('GET', url, undefined, effect) });
                expect(response.statusCode, `${url} ${response.body}`).toBe(200);
            }
            const rowsPath = '/v1/account/project-rows/list';
            // Workspace row keys carry the Home server identity (O-DEPLOY ruling 2026-11-12); no alias form.
            const workspaceSelection = { kinds: ['workspace-ref'], serverId };
            const workspaces = await app.inject({ method: 'POST', url: rowsPath, payload: workspaceSelection,
                headers: headers('POST', rowsPath, workspaceSelection) });
            expect(workspaces.statusCode, workspaces.body).toBe(200);
            expect(workspaces.json()).toMatchObject({ status: 'listed', rows: [] });
            for (const otherRows of [{ ...workspaceSelection, kinds: ['relationship-graph'] },
                { ...workspaceSelection, serverId: 'requester-local-home-profile' }, { kinds: ['workspace-ref'] }]) {
                await expectHttpRefusalWarning({ phase: 'deployment_restore_purpose', method: 'POST', path: rowsPath },
                    async () => { expect((await app.inject({ method: 'POST', url: rowsPath, payload: otherRows,
                        headers: headers('POST', rowsPath, otherRows) })).statusCode, JSON.stringify(otherRows)).toBe(401); }, [authorization.token]);
            }
            const secretPath = `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`;
            const secretBody = EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ serverId, environmentId: f.environment.id,
                targetLinkId: f.link.id, machineId: f.member.id, installationId: f.member.installationId,
                materialization: { kind: 'deployment', deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId } });
            const secretInput = { ...secretBody, proof: signMachineInstallationProof({ payload: { version: 1,
                accountId: f.account.id, machineId: f.member.id, installationId: f.member.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(secretBody) } },
                privateKey: f.member.keys.secretKey }) };
            const secrets = await app.inject({ method: 'POST', url: secretPath, payload: secretInput,
                headers: headers('POST', secretPath, secretInput) });
            expect(secrets.statusCode, secrets.body).toBe(200);
            expect(secrets.json()).toEqual({ ok: true, grants: [grant] });
            const strangerBody = { ...secretBody, machineId: other.member.id, installationId: other.member.installationId };
            const strangerInput = { ...strangerBody, proof: signMachineInstallationProof({ payload: { version: 1,
                accountId: other.account.id, machineId: other.member.id, installationId: other.member.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(strangerBody) } },
                privateKey: other.member.keys.secretKey }) };
            const deniedQueries: string[] = [];
            const strangerToken = await auth.createToken(other.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const stopDenied = observeSqliteRequests({ before: query => { if (query.model) deniedQueries.push(query.model); } });
            const denied = await app.inject({ method: 'POST', url: secretPath, payload: strangerInput,
                headers: { authorization: `Bearer ${strangerToken}` } }).finally(stopDenied);
            expect(denied.statusCode, denied.body).toBe(404);
            expect(denied.json()).toMatchObject({ ok: false, error: 'machine_unavailable' });
            expect(denied.json()).not.toHaveProperty('grants');
            expect(deniedQueries.filter(model => model === 'MachineSecretGrant')).toEqual([]);
            const wrongSecret = { ...secretInput, materialization: { ...secretInput.materialization, deploymentId: capture.id } };
            expect((await app.inject({ method: 'POST', url: secretPath, payload: wrongSecret,
                headers: headers('POST', secretPath, wrongSecret) })).statusCode).toBe(401);
            for (const [url, effect] of [
                [`/v1/deployments/environments/${other.environment.id}?serverId=${serverId}`, 'deployments.environments.get'],
                [`/v1/projects/sources/${other.environment.projectSourceId}?serverId=${serverId}`, 'projects.sources.read'],
                [receiptPath(other.receipt.id), 'deployments.receipts.get'],
                [receiptPath(capture.id, other.environment.id), 'deployments.receipts.get'],
                [`/v1/artifacts/${other.receipt.contentArtifactId}`, actionId],
            ]) expect((await app.inject({ method: 'GET', url, headers: headers('GET', url, undefined, effect) })).statusCode).toBe(401);
            const sourceQueries: string[] = [];
            const stopSource = observeSqliteRequests({ before: query => { if (query.model) sourceQueries.push(query.model); } });
            const continued = await app.inject({ method: 'POST', url: verificationPath, payload: verificationBody,
                headers: headers('POST', verificationPath, verificationBody, actionId, sessionAuthorization.token) }).finally(stopSource);
            expect(continued.statusCode, continued.body).toBe(200);
            expect(sourceQueries.filter(model => ['Session', 'AccessKey', 'ProjectSource', 'Team', 'TeamMembership'].includes(model))).toEqual([]);
        }, { authentication: 'real' });
        expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(2);
        expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } })).activeDeploymentId).toBe(f.receipt.id);
    });

    it.each(['deployments.environments.controller.set', 'deployments.cancel'] as const)(
        'retains %s for its exact approval metadata without granting sibling reads', async actionId => {
            const f = await fixture('team');
            const target = { kind: 'machine' as const, machineId: f.controller.id };
            const input = actionId === 'deployments.cancel'
                ? { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id, expectedReceiptRevision: 1 }
                : { serverId, environmentId: f.environment.id, expectedRevision: 1, controllerMachineId: f.controller.id };
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
                serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
                machineId: f.controller.id, target, requestId: envelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
            expect(authorization.binding.environmentId).toBe(f.environment.id);
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
                data: { status: 'suspended' } });
            const headers = (path: string, effectActionId: string = actionId) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target,
                    installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'GET', path, privateKey: f.controller.keys.secretKey }),
            });
            await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
                const path = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}&projection=approvalScope`;
                const queries: string[] = [];
                const stop = observeSqliteRequests({ before: query => { if (query.model) queries.push(query.model); } });
                const read = await app.inject({ method: 'GET', url: path, headers: headers(path) }).finally(stop);
                expect(read.statusCode, read.body).toBe(200);
                expect(read.json()).toEqual({ ok: true, environment: { id: f.environment.id,
                    projectSourceId: f.environment.projectSourceId, purpose: 'standard' } });
                expect(queries.filter(model => ['ProjectSource', 'Team', 'TeamMembership', 'Artifact', 'SavedSecretResource'].includes(model))).toEqual([]);
                expect(queries.filter(model => model === 'DeploymentEnvironment')).toHaveLength(1);
                for (const url of [
                    `/v1/deployments/environments/${f.environment.id}?serverId=foreign-home&projection=approvalScope`,
                    `/v1/deployments/environments/foreign-environment?serverId=${serverId}&projection=approvalScope`,
                    `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`,
                ]) expect((await app.inject({ method: 'GET', url, headers: headers(url) })).statusCode).toBe(401);
                expect((await app.inject({ method: 'GET', url: path,
                    headers: headers(path, 'deployments.environments.get') })).statusCode).toBe(401);
            }, { authentication: 'real' });
        });

    it('admits approval metadata at Manage or Deploy, without turning Environment read into mutation authority', async () => {
        const f = await fixture('team');
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
            data: { role: 'member' } });
        const mint = (actionId: 'deployments.cancel' | 'deployments.environments.controller.set', environmentId = f.environment.id,
            boundEnvironmentId?: string) => {
            const input = { serverId, environmentId, ...(actionId === 'deployments.cancel'
                ? { deploymentId: f.receipt.id, expectedReceiptRevision: 1 }
                : { expectedRevision: 1, controllerMachineId: f.controller.id }) };
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            return auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id, serverIdentityId: serverId,
                authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId, machineId: f.controller.id,
                target, requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                ...(boundEnvironmentId ? { environmentId: boundEnvironmentId } : {}) }, { input });
        };
        const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}&projection=approvalScope`,
                headers: { authorization: `Bearer ${token}` } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, environment: { id: f.environment.id,
                projectSourceId: f.environment.projectSourceId, purpose: 'standard' } });
            const ordinary = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`,
                headers: { authorization: `Bearer ${token}` } });
            expect(ordinary.statusCode, ordinary.body).toBe(200);
            expect(ordinary.json()).toMatchObject({ ok: true, environment: { contentArtifactId: f.environment.contentArtifactId },
                targetLinks: [{ id: f.link.id }] });
        }, { authentication: 'real' });
        await expect(mint('deployments.cancel')).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint('deployments.environments.controller.set')).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { deployerMode: 'members' } });
        await expect(mint('deployments.cancel')).resolves.toMatchObject({ binding: { environmentId: f.environment.id } });
        await expect(mint('deployments.environments.controller.set')).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint('deployments.cancel', 'foreign-environment')).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint('deployments.cancel', f.environment.id, 'foreign-environment')).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it('refuses a re-presented restart root after withdrawal while its in-operation steps need no permission reads', async () => {
        const f = await fixture('team');
        const actionId = 'deployments.restart' as const;
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const input = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            targetLinkId: f.link.id, machineId: f.member.id, installationId: f.member.installationId,
            service: { kind: 'deployment' as const, machineId: f.member.id, environmentId: f.environment.id,
                environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' }, expectedGeneration: 'generation' };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const mint = (metadataEnvironmentId?: string) => {
            return auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id, serverIdentityId: serverId,
                authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
                machineId: f.member.id, target, requestId: envelope.requestId, admittedMachineRole: 'use',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, metadataEnvironmentId === undefined
                ? { input } : { input: { environmentId: metadataEnvironmentId },
                    deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope }) });
        };
        // The native target must be active when the root is admitted.
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
        const authorization = await mint();
        await expect(mint('foreign-environment')).rejects.toMatchObject({ code: 'credential_scope_denied' });
        const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
        const body = { v: 1, admittedMachineRole: 'use' };
        const headers = (method: string, path: string, body?: unknown, effectActionId: string = actionId,
            privateKey = f.member.keys.secretKey, token = authorization.token) => ({
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: token,
                effectActionId, target, installationId: f.member.installationId, requestId: authorization.binding.requestId,
                method, path, body, privateKey }),
        });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
            data: { status: 'suspended' } });
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.machine.update({ where: { id: f.member.id }, data: { operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        let roomDiscoveries = 0;
        const dispatch = createExternalActionDaemonDispatcher({ io: createSocketRoomDiscoveryHarness(async () => {
            roomDiscoveries += 1;
            return [];
        }) });
        await expect(dispatch({ actionId, envelope,
            principal: { accountId: f.account.id, authority: 'present_user',
                authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch } },
            executionAuthorization: { ...authorization, token: `${authorization.token}forged` },
        })).resolves.toMatchObject({ kind: 'placement_error', code: 'credential_scope_denied' });
        await withAuthenticatedTestApp(app => { registerExternalActionRoutes(app, { dispatch }); registerDeploymentRoutes(app); artifactsRoutes(app); machinesRoutes(app); }, async app => {
            const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`;
            const relayBody = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1,
                machineId: f.member.id, envelope, executionAuthorization: authorization });
            // Presenting the root to the Home again, even daemon-signed, is new work:
            // full admission refuses the suspended member and nothing is dispatched.
            const relay = await app.inject({ method: 'POST', url: relayPath, payload: relayBody,
                headers: headers('POST', relayPath, relayBody) });
            expect(relay.statusCode, relay.body).not.toBe(200);
            expect(roomDiscoveries).toBe(0);
            const substituted = { ...relayBody, envelope: { ...envelope, input: { ...input, deploymentId: crypto.randomUUID() } } };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: substituted,
                headers: headers('POST', relayPath, substituted) })).statusCode).toBe(401);
            const codecQueries: string[] = [];
            const stopCodec = observeSqliteRequests({ before: query => { if (query.model) codecQueries.push(query.model); } });
            const codecPath = `/v1/machines/${f.member.id}`;
            const codec = await app.inject({ method: 'GET', url: codecPath,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, ...headers('GET', codecPath) } }).finally(stopCodec);
            expect(codecQueries.filter(model => ['ProjectSource', 'Team', 'TeamMembership', 'MachineTeamGrant', 'MachineAccountGrant'].includes(model))).toEqual([]);
            expect(codec.statusCode, codec.body).toBe(200);
            const queries: string[] = [];
            const stop = observeSqliteRequests({ before: query => { if (query.model) queries.push(query.model); } });
            const verified = await app.inject({ method: 'POST', url: path, payload: body,
                headers: headers('POST', path, body) }).finally(stop);
            expect(queries.filter(model => ['ProjectSource', 'Team', 'TeamMembership', 'MachineTeamGrant', 'MachineAccountGrant'].includes(model))).toEqual([]);
            // The sole Machine read verifies this exact installation's signature; it does not re-admit Use.
            expect(queries.filter(model => model === 'Machine')).toHaveLength(1);
            expect(verified.statusCode, verified.body).toBe(200);
            const approvalPath = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}&projection=approvalScope`;
            const approvalQueries: string[] = [];
            const stopApproval = observeSqliteRequests({ before: query => { if (query.model) approvalQueries.push(query.model); } });
            const approval = await app.inject({ method: 'GET', url: approvalPath,
                headers: headers('GET', approvalPath) }).finally(stopApproval);
            expect(approval.statusCode, approval.body).toBe(200);
            expect(approval.json()).toEqual({ ok: true, environment: { id: f.environment.id,
                projectSourceId: f.environment.projectSourceId, purpose: 'standard' } });
            expect(approvalQueries.filter(model => ['ProjectSource', 'Team', 'TeamMembership', 'Artifact', 'SavedSecretResource'].includes(model))).toEqual([]);
            expect(approvalQueries.filter(model => model === 'DeploymentEnvironment')).toHaveLength(1);
            for (const url of [
                `/v1/deployments/environments/${f.environment.id}?serverId=foreign-home&projection=approvalScope`,
                `/v1/deployments/environments/foreign-environment?serverId=${serverId}&projection=approvalScope`,
                `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`,
            ]) expect((await app.inject({ method: 'GET', url, headers: headers('GET', url) })).statusCode).toBe(401);
            for (const [url, effect] of [
                [`/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`, 'deployments.environments.get'],
                [`/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}?serverId=${serverId}`, 'deployments.receipts.get'],
                [`/v1/artifacts/${f.environment.contentArtifactId}`, actionId],
                [`/v1/artifacts/${f.receipt.contentArtifactId}`, actionId],
                [`/v1/machines/${f.outsider.id}`, actionId],
            ]) await expectHttpRefusalWarning({ phase: 'deployment_restart_purpose', method: 'GET', path: url.split('?')[0] },
                async () => { expect((await app.inject({ method: 'GET', url, headers: headers('GET', url, undefined, effect) })).statusCode).toBe(401); },
                [authorization.token]);
            expect((await app.inject({ method: 'POST', url: path, payload: body,
                headers: headers('POST', path, body, actionId, f.outsider.keys.secretKey) })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: path, payload: body,
                headers: headers('POST', path, body, actionId, f.member.keys.secretKey, `${authorization.token}forged`) })).statusCode).toBe(401);
            await db.machine.update({ where: { id: f.member.id }, data: { installationId: crypto.randomUUID() } });
            expect((await app.inject({ method: 'POST', url: path, payload: body,
                headers: headers('POST', path, body) })).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('re-admits every re-presented restart root as new work while in-operation steps stay bound to their Machine', async () => {
        const f = await fixture('team');
        const other = await fixture('team');
        const actionId = 'deployments.restart' as const;
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const input = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            targetLinkId: f.link.id, machineId: f.member.id, installationId: f.member.installationId,
            service: { kind: 'deployment' as const, machineId: f.member.id, environmentId: f.environment.id,
                environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' }, expectedGeneration: 'generation' };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id, serverIdentityId: serverId,
            authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
            machineId: f.member.id, target, requestId: envelope.requestId, admittedMachineRole: 'use',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        await db.machine.update({ where: { id: f.member.id }, data: { operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        let forwarded = 0;
        const dispatch = createExternalActionDaemonDispatcher({ io: createSocketRoomDiscoveryHarness(async () => {
            forwarded += 1;
            return [];
        }) });
        const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`;
        const relayBody = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1,
            machineId: f.member.id, envelope, executionAuthorization: authorization });
        const signed = (method: string, path: string, body: unknown, signer: { installationId: string; keys: { secretKey: Uint8Array } } = f.member,
            resolvedTarget: typeof target = target) => ({
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(resolvedTarget),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: actionId, target: resolvedTarget, installationId: signer.installationId,
                requestId: authorization.binding.requestId, method, path, body, privateKey: signer.keys.secretKey }),
        });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
            data: { status: 'suspended' } });
        const bearer = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(app => { registerExternalActionRoutes(app, { dispatch }); }, async app => {
            // The revoked member presenting the old root starts new work: full admission refuses it.
            const replay = await app.inject({ method: 'POST', url: relayPath, payload: relayBody,
                headers: { authorization: `Bearer ${bearer}` } });
            expect(replay.statusCode, replay.body).not.toBe(200);
            expect(forwarded).toBe(0);
            // A daemon-signed re-presentation is new work too.
            const daemonReplay = await app.inject({ method: 'POST', url: relayPath, payload: relayBody,
                headers: signed('POST', relayPath, relayBody) });
            expect(daemonReplay.statusCode, daemonReplay.body).not.toBe(200);
            expect(forwarded).toBe(0);
            // A step inside the running operation still verifies without re-admission.
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const verifyBody = { v: 1, admittedMachineRole: 'use' };
            const step = await app.inject({ method: 'POST', url: verifyPath, payload: verifyBody,
                headers: signed('POST', verifyPath, verifyBody) });
            expect(step.statusCode, step.body).toBe(200);
            // No presentation can move to another Machine, installation or Environment.
            const elsewhere = { ...relayBody, machineId: other.member.id };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: elsewhere,
                headers: signed('POST', relayPath, elsewhere) })).statusCode).not.toBe(200);
            expect((await app.inject({ method: 'POST', url: relayPath, payload: relayBody,
                headers: signed('POST', relayPath, relayBody, other.member) })).statusCode).toBe(401);
            const redirected = { kind: 'machine' as const, machineId: other.member.id };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: relayBody,
                headers: signed('POST', relayPath, relayBody, f.member, redirected) })).statusCode).toBe(401);
            const otherEnvironment = { ...relayBody, envelope: { ...envelope, input: { ...input, environmentId: other.environment.id } } };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: otherEnvironment,
                headers: signed('POST', relayPath, otherEnvironment) })).statusCode).not.toBe(200);
        }, { authentication: 'real' });
    });

    it('admits readiness reads only for the signed Project and selected Environments', async () => {
        const f = await fixture();
        const actionId = 'projects.readiness.read' as const;
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { serverId, machineId: f.controller.id, projectId: f.environment.projectSourceId,
            environments: [{ environmentId: f.environment.id, expectedRevision: f.environmentRevision }] };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const mint = (selectedInput = input) => auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
            serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ ...envelope, input: selectedInput }),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, selectedInput) }, { input: selectedInput });
        const authorization = await mint();
        await expect(mint({ ...input, environments: [] })).resolves.toMatchObject({ binding: { deploymentReadAdmission: {
            actionId, projectId: input.projectId, environments: [],
        } } });
        const otherSource = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Other readiness Project', audience: [] }));
        if (!otherSource.ok) throw new Error(otherSource.error);
        await expect(mint({ ...input, projectId: otherSource.source.id })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint({ ...input, projectId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint({ ...input, environments: [{ ...input.environments[0], expectedRevision: f.environmentRevision + 1 }] }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        const request = (effectActionId: 'projects.sources.read' | 'deployments.environments.get' | 'deployments.domains.list' | typeof actionId, id: string) => {
            const path = effectActionId === 'projects.sources.read'
                ? `/v1/projects/sources/${encodeURIComponent(id)}?serverId=${encodeURIComponent(serverId)}`
                : effectActionId === actionId ? `/v1/artifacts/${encodeURIComponent(id)}`
                    : `/v1/deployments/environments/${encodeURIComponent(id)}${effectActionId === 'deployments.domains.list' ? '/domains' : ''}?serverId=${encodeURIComponent(serverId)}`;
            return { method: 'GET' as const, url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target,
                    installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'GET', path, privateKey: f.controller.keys.secretKey }),
            } };
        };
        await withAuthenticatedTestApp(app => { projectSourceRoutes(app); registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const source = await app.inject(request('projects.sources.read', input.projectId));
            expect(source.statusCode, source.body).toBe(200);
            expect(source.json()).toMatchObject({ ok: true, source: { id: input.projectId } });
            const environment = await app.inject(request('deployments.environments.get', f.environment.id));
            expect(environment.statusCode, environment.body).toBe(200);
            expect(environment.json()).toMatchObject({ ok: true, environment: { id: f.environment.id } });
            const domains = await app.inject(request('deployments.domains.list', f.environment.id));
            expect(domains.statusCode, domains.body).toBe(200);
            const artifact = await app.inject(request(actionId, f.environment.contentArtifactId));
            expect(artifact.statusCode, artifact.body).toBe(200);
            for (const rejected of [request('projects.sources.read', crypto.randomUUID()),
                request('deployments.environments.get', crypto.randomUUID()), request('deployments.domains.list', crypto.randomUUID()),
                request(actionId, f.receipt.contentArtifactId)]) {
                await expectHttpRefusalWarning({ phase: 'deployment_native_read_purpose', method: 'GET', path: rejected.url.split('?')[0] },
                    async () => { const response = await app.inject(rejected); expect(response.statusCode, response.body).toBe(401); },
                    [authorization.token]);
            }
        }, { authentication: 'real' });
    });

    it('admits current edge reads only for the readable Environment controller', async () => {
        const f = await fixture();
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { edgeMachineId: f.member.id } });
        const admission = projectDeploymentReadAdmissionV1('deployments.health.current', { serverId,
            environmentId: f.environment.id, targetLinkId: f.link.id, machineId: f.controller.id });
        if (!admission) throw new Error('Current read admission missing');
        const binding = { ...f.authorization.binding, actionId: 'deployments.health.current' as const,
            deploymentReadAdmission: admission };
        expect(await readDeploymentReadAuthorizationInTx(db, binding, admission)).toEqual({ artifactIds: [] });
        expect(await readDeploymentReadAuthorizationInTx(db, binding, { ...admission, machineId: f.outsider.id })).toBeNull();
        const mint = async (targetLinkId: string) => {
            const input = { serverId, environmentId: f.environment.id, targetLinkId, machineId: f.controller.id };
            const target = { kind: 'machine' as const, machineId: f.controller.id };
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            return auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
                serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
                actionId: 'deployments.health.current', machineId: f.controller.id, target,
                requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentReadAdmission: projectDeploymentReadAdmissionV1('deployments.health.current', input) });
        };
        await expect(mint(f.link.id)).resolves.toMatchObject({ binding: { actionId: 'deployments.health.current' } });
        // QA #73 paired a current Environment with another Environment's stale target-link id.
        await expect(mint(crypto.randomUUID())).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { controllerMachineId: f.outsider.id } });
        expect(await readDeploymentReadAuthorizationInTx(db, binding, admission)).toBeNull();
    });

    it('admits the Environment-qualified receipt read made by retained build logs', async () => {
        const f = await fixture();
        const actionId = 'deployments.logs.read' as const;
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            targetLinkId: f.link.id, machineId: f.controller.id, installationId: f.controller.installationId,
            kind: 'build' as const };
        const admission = projectDeploymentReadAdmissionV1(actionId, input);
        if (!admission) throw new Error('Build log read admission missing');
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
            serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), deploymentReadAdmission: admission });
        const spec = getActionSpec('deployments.receipts.get');
        if (!spec.serverTransport) throw new Error('Receipt transport missing');
        const request = (environmentId?: string, deploymentId = f.receipt.id, home = serverId) => {
            const bound = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema,
                input: { serverId: home, deploymentId, ...(environmentId ? { environmentId } : {}) } });
            return { method: 'GET' as const, url: bound.path, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.receipts.get',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.receipts.get', target,
                    installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'GET', path: bound.path, privateKey: f.controller.keys.secretKey }),
            } };
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const unqualified = await app.inject(request());
            expect(unqualified.statusCode, unqualified.body).toBe(200);
            const qualified = await app.inject(request(f.environment.id));
            expect(qualified.statusCode, qualified.body).toBe(200);
            expect(qualified.json()).toMatchObject({ ok: true, deployment: { id: f.receipt.id } });
            for (const rejected of [request('foreign-environment'), request(f.environment.id, crypto.randomUUID()),
                request(f.environment.id, f.receipt.id, `srv_${'f'.repeat(32)}`)]) {
                await expectHttpRefusalWarning({ phase: 'deployment_native_read_purpose', method: 'GET', path: rejected.url.split('?')[0] },
                    async () => {
                        const response = await app.inject(rejected);
                        expect(response.statusCode, response.body).toBe(401);
                    }, [authorization.token]);
            }
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('opens captured %s Domain inventory only for the admitted member job', async contentMode => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, separateContentOwner: true, contentMode });
        const domainContent = await f.content('deployment-domain.v1');
        const capture = { desired: true, content: domainContent, listener: 'privateOrigin', dockerEngineId: 'member-engine',
            installationPublicKey: privacyKit.encodeBase64(new Uint8Array(f.member.keys.publicKey), 'base64url'),
            placement: { serverId, accountId: f.account.id, environmentId: f.environment.id, targetLinkId: f.link.id,
                machineId: f.member.id, installationId: f.member.installationId, nativeServer: 'private',
                domainId: crypto.randomUUID(), requestId: crypto.randomUUID(), actionOperationId: crypto.randomUUID() } };
        await db.deploymentDomain.create({ data: { id: capture.placement.domainId, environmentId: f.environment.id,
            targetLinkId: f.link.id, createdByAccountId: f.account.id, state: 'active', ...domainContent,
            capturedPlacements: [capture] } });
        const foreign = await fixture('account', 'account', { contentMode });
        const unrelated = await f.content('deployment-domain.v1');
        const retained = await f.content('deployment-domain.v1');
        const foreignMemberContent = await f.content('deployment-domain.v1');
        await db.deploymentDomain.update({ where: { id: capture.placement.domainId }, data: { capturedPlacements: [
            capture, { ...capture, desired: false, content: retained },
            { ...capture, content: foreignMemberContent, placement: { ...capture.placement,
                machineId: f.outsider.id, installationId: f.outsider.installationId } },
        ] } });
        const siblingEnvironment = await db.deploymentEnvironment.create({ data: { projectSourceId: f.environment.projectSourceId,
            createdByAccountId: f.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.controller.id, ...await f.content('deployment-environment.v1') } });
        const packet = f.rpc();
        const request = (path: string, source = packet) => ({ method: 'GET' as const, url: path, headers: {
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: f.job.actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
            [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                effectActionId: f.job.actionId, target: f.authorization.binding.target, installationId: f.member.installationId,
                requestId: f.authorization.binding.requestId, method: 'GET', path, body: undefined,
                deploymentChildExecution: source, privateKey: f.member.keys.secretKey }),
        } });
        const listPath = `/v1/deployments/environments/${f.environment.id}/domains?serverId=${serverId}`;
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.member.accountId } },
            data: { role: 'owner' } });
        expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
            .toMatchObject({ ok: true });
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const queries: string[] = [];
            const stop = observeSqliteRequests({ before: query => { if (query.model) queries.push(query.model); } });
            const listing = await app.inject(request(listPath)).finally(stop);
            expect(listing.statusCode, listing.body).toBe(200);
            expect(queries.filter(model => ['ProjectSource', 'TeamMembership', 'ApiToken'].includes(model))).toEqual([]);
            expect(listing.json()).toMatchObject({ ok: true, domains: [{ id: capture.placement.domainId,
                placements: expect.arrayContaining([expect.objectContaining({ desired: true, content: domainContent })]) }] });
            const opened = await app.inject(request(`/v1/artifacts/${domainContent.contentArtifactId}`));
            expect(opened.statusCode, opened.body).toBe(200);
            expect(ArtifactHttpReadV1Schema.parse(opened.json())).toMatchObject({ id: domainContent.contentArtifactId,
                headerVersion: 1, bodyVersion: 1 });
            if (contentMode === 'e2ee') {
                const document = ArtifactHttpReadV1Schema.parse(opened.json());
                expect(openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(document.dataEncryptionKey),
                    recipientSecretKeyOrSeed: f.accountKeys.secretKey })).toEqual(f.artifactKeys.get(domainContent.contentArtifactId));
                expect(openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(document.dataEncryptionKey),
                    recipientSecretKeyOrSeed: f.memberContentKeys.secretKey })).toBeNull();
            }
            const retainedRead = await app.inject(request(`/v1/artifacts/${retained.contentArtifactId}`));
            expect(retainedRead.statusCode, retainedRead.body).toBe(200);
            for (const path of [`/v1/deployments/environments/${foreign.environment.id}/domains?serverId=${serverId}`,
                `/v1/deployments/environments/${siblingEnvironment.id}/domains?serverId=${serverId}`,
                `/v1/artifacts/${siblingEnvironment.contentArtifactId}`, `/v1/artifacts/${foreignMemberContent.contentArtifactId}`,
                `/v1/artifacts/${unrelated.contentArtifactId}`, `/v1/artifacts/${foreign.environment.contentArtifactId}`]) {
                expect((await app.inject(request(path))).statusCode).toBe(401);
            }
            const substituted = f.rpc(DeploymentChildRpcV1Schema.parse({ ...f.job, actionOperationId: crypto.randomUUID() }));
            expect((await app.inject(request(listPath, substituted))).statusCode).toBe(401);
            expect((await app.inject(request(`/v1/artifacts/${domainContent.contentArtifactId}`, substituted))).statusCode).toBe(401);
            const siblingReceipt = f.rpc(DeploymentChildRpcV1Schema.parse({ ...f.job, deploymentId: foreign.receipt.id }));
            expect((await app.inject(request(listPath, siblingReceipt))).statusCode).toBe(401);
            expect((await app.inject(request(`/v1/artifacts/${domainContent.contentArtifactId}`, siblingReceipt))).statusCode).toBe(401);
            await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
            expect((await app.inject(request(listPath))).statusCode).toBe(401);
            expect((await app.inject(request(`/v1/artifacts/${domainContent.contentArtifactId}`))).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('dispatches a %s own-Machine Domain root through the real authorization mint', async contentMode => {
        const f = await fixture('account', 'account', { contentMode });
        await db.machine.update({ where: { id: f.controller.id }, data: { operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const actionId = 'deployments.domains.add' as const;
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const binding = { serverIdentityId: serverId, accountId: f.account.id, authentication, actionId,
            requestId: crypto.randomUUID(), target };
        const input = { serverId, environmentId: f.environment.id, domainId: crypto.randomUUID(),
            expectedRevision: f.environmentRevision, targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
            requestKey: crypto.randomUUID(), ...await f.content('deployment-domain.v1') };
        const material = { type: 'dataKey' as const, machineKey: f.controller.contentKey };
        const envelope = contentMode === 'e2ee'
            ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId: binding.requestId, target, input };
        const dispatch = createExternalActionDaemonDispatcher({ io: createSocketRoomDiscoveryHarness(async () => []),
            forwardRpc: async ({ callParams }) => {
                // Only the daemon transport is substituted; admission and signed authorization remain real.
                const request = callParams as ExternalActionDaemonDispatchRequest;
                if (!request.executionAuthorization) throw new Error('Expected signed deployment authorization');
                expect(request.executionAuthorization.binding).toMatchObject({ environmentId: input.environmentId, deploymentChildRoot: true,
                    deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope }) });
                const execution = { ok: true as const, result: { accepted: true } };
                const prepared = envelope.v === 2
                    ? prepareExternalActionResponseV2({ binding, request: envelope, executedMachineId: f.controller.id,
                        execution, material, randomBytes: nacl.randomBytes })
                    : prepareExternalActionResponseEnvelopeV1({ v: 1, actionId, requestId: binding.requestId, execution });
                return { ok: true, result: createExternalActionDaemonDispatchResponse(prepared) };
            } });
        await expect(dispatch({ actionId, envelope, principal: { accountId: f.account.id, authentication,
            authority: 'present_user' } })).resolves.toMatchObject({ kind: 'response' });
    });

    it.each(['plain', 'e2ee'] as const)('previews Environment alert defaults from an admitted %s health setup Action', async contentMode => {
        const f = await fixture('account', 'account', { readableEnvironment: true, contentMode });
        const foreign = await fixture('account', 'account', { readableEnvironment: true, contentMode });
        const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: contentMode === 'plain' ? null : {
            type: 'dataKey' as const, machineKey: f.accountKeys.secretKey, publicKey: f.accountKeys.publicKey,
        } };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { action: { pluginId: 'happier.machine.services', localId: 'health/setup' },
            input: { v: 1, mode: 'preview', subject: { kind: 'environment', environmentId: f.environment.id } } };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const root = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'action.invoke', machineId: f.controller.id, target, requestId: envelope.requestId,
            admittedMachineRole: 'manage',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const exchanges: Array<{ method: string; path: string; status: number }> = [];
        await withAuthenticatedTestApp(app => {
            registerAccountProfileRoute(app);
            registerAccountSettingsRoutes(app);
            changesRoutes(app);
            registerAutomationV3Routes(app);
            featuresRoutes(app);
            registerAccountEncryptionRoutes(app);
            artifactsRoutes(app);
            projectSourceRoutes(app);
            registerDeploymentRoutes(app);
            app.addHook('onResponse', async (request, reply) => {
                exchanges.push({ method: request.method, path: request.url.split('?')[0]!, status: reply.statusCode });
            });
        }, async app => {
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            await withConfiguredDaemonTestHome({ prefix: 'health-sdk-signed-home-',
                env: { HAPPIER_SERVER_URL: origin, HAPPIER_ACTIVE_SERVER_ID: serverId } }, async () => {
                const profile = await addServerProfile({ name: 'health-sdk', serverUrl: origin, webappUrl: origin });
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
                    descriptor: { v: 1, homeServerIdentityId: serverId, canonicalServerUrl: origin,
                        revision: 1, endpoints: [{ kind: 'https', url: origin }] } });
                const channel = await createRequesterCurrentnessSocketHarness();
                let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
                try {
                    requester = await admitRequesterAccountActionContext({ authorization: root, credentials,
                        serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, isCurrent: async () => true });
                    if (!requester) throw new Error(`Expected admitted requester: ${JSON.stringify(exchanges)}`);
                    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                        serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, target,
                        installationId: f.controller.installationId, privateKey: f.controller.keys.secretKey, rootAdmitted: true });
                    if (!authorization) throw new Error('Expected requester HTTP projection');
                    // The native host and actual Home routes reproduce the SDK health/setup
                    // reader's Environment get followed by its read-only update preview.
                    const native = createDaemonDeploymentActionDeps({ credentials, serverId, serverHttpBaseUrl: origin,
                        machineId: f.controller.id,
                        runtime: { async acquire() { throw new Error('Preview must not acquire native deployment'); } } });
                    const context = { surface: 'plugin' as const, authority: 'account_automation' as const,
                        externalActionExecutionAuthorization: authorization, externalActionTarget: target };
                    const read = await native.deploymentAction!('deployments.environments.get',
                        { serverId, environmentId: f.environment.id }, context);
                    expect(read, JSON.stringify(exchanges)).toMatchObject({ ok: true, environment: { id: f.environment.id } });
                    const preview = await native.deploymentAction!('deployments.environments.update',
                        { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
                            contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: f.environment.contentHeaderVersion,
                            contentBodyVersion: f.environment.contentBodyVersion, mode: 'preview', defaultsFor: 'alerts' }, context);
                    expect(preview, JSON.stringify({ exchanges, preview })).toMatchObject({ ok: true,
                        environmentId: f.environment.id, revision: f.environmentRevision });
                    const nativeExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...native });
                    const sdkAuthorization = Object.defineProperties({ ...authorization }, Object.getOwnPropertyDescriptors(authorization));
                    Object.defineProperty(sdkAuthorization, 'requesterAccountExecutor', { value: nativeExecutor, enumerable: false });
                    const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
                        pluginIds: ['happier.machine.services'], resolveCurrentMachineId: () => f.controller.id,
                        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId: f.controller.id }),
                        externalActionHomeBinding: { serverId, serverIdentityId: serverId,
                            externalActionMachineInstallationId: f.controller.installationId,
                            externalActionMachineRequestPrivateKey: f.controller.keys.secretKey },
                        scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({
                            getAccountSettings: () => null, allowEnvironmentOverride: false }) },
                    } });
                    try {
                        expect(runtime.registry.contributes.actionsById.has('happier.machine.services/health/setup')).toBe(true);
                        const sdk = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                            invokeContributedAction: createDaemonExternalActionContributedInvoker({
                                acquireRuntimeRegistryLease: () => runtime.controller.acquireRuntimeRegistry(),
                            }) });
                        const result = await sdk.execute('action.invoke', input, { surface: 'api', authority: 'present_user',
                            serverId, serverIdentityId: serverId, runtimeAccountId: f.account.id,
                            actionRequestId: envelope.requestId, actionCaller: { kind: 'host' },
                            signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ ...request,
                                authorizationToken: authorization.token, privateKey: f.controller.keys.secretKey }),
                            externalActionExecutionAuthorization: sdkAuthorization, externalActionTarget: target });
                        expect(result, JSON.stringify({ result, exchanges })).toMatchObject({ ok: true, result: {
                            mode: 'preview', sourceConfig: { subject: input.input.subject },
                            destinationSelectionContext: { serverId, machineId: f.controller.id },
                        } });
                    } finally { await runtime.dispose(); }
                    expect(await native.deploymentAction!('deployments.environments.get',
                        { serverId, environmentId: foreign.environment.id }, context)).toMatchObject({ ok: false });
                    expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision)
                        .toBe(f.environmentRevision);
                } finally { await requester?.dispose(); await channel.close(); }
            });
        }, { authentication: 'real' });
    });

    it('reads backup setup defaults only in the preview child for a reviewed Configure preparation (C7)', async () => {
        const f = await fixture();
        const foreign = await fixture();
        const parent = await db.deploymentEnvironment.create({ data: { ...f.environment, id: crypto.randomUUID(),
            ...await f.content('deployment-environment.v1') } });
        const preview = { templateEnvironmentId: parent.id, expectedTemplateRevision: parent.revision,
            pullRequestId: crypto.randomUUID(), runtimeTargetLinkId: f.link.id };
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { purpose: 'preview',
            previewTemplateEnvironmentId: parent.id, previewRepositoryId: f.environment.projectSourceId,
            previewPullRequestId: preview.pullRequestId, previewTargetLinkId: f.link.id } });
        const actionId = 'deployments.backups.configure';
        const input = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            intent: 'markNotNeeded' as const };
        const reviewedChild = { actionId, role: 'preview.backup', inputDigest: computeActionInputApprovalDigestV1(actionId, input),
            deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, input) };
        const binding = { ...f.authorization.binding, actionId: 'deployments.environments.create', environmentId: parent.id,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.environments.create', {
                mode: 'apply', projectSourceId: f.environment.projectSourceId, requestKey: crypto.randomUUID(), preview,
                protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
            }) };
        const read = (environmentId: string, home = serverId) => readDeploymentBackupConfigureHttpPurpose(db, binding, actionId,
            { method: 'GET', path: `/v1/deployments/environments/${environmentId}?serverId=${encodeURIComponent(home)}`,
                routeInput: { serverId: home, environmentId }, reviewedChild }, f.environment.id);
        expect(await read(f.environment.id)).toBe(true);
        expect(await read(parent.id), 'Configure preparation must not borrow its root parent Environment').toBe(false);
        expect(await read(foreign.environment.id)).toBe(false);
        expect(await read(f.environment.id, `srv_${'f'.repeat(32)}`)).toBe(false);
    });

    it('reads backup setup defaults under its exact signed Environment preview root', async () => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        const foreign = await fixture('account', 'account', { readableEnvironment: true });
        const unrelated = await f.content('deployment-environment.v1');
        const actionId = 'deployments.environments.update';
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: f.environment.contentHeaderVersion,
            contentBodyVersion: f.environment.contentBodyVersion, mode: 'preview', defaultsFor: 'backups' };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
            machineId: f.controller.id, target, requestId: envelope.requestId,
            deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope }),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const headers = (path: string, effectActionId: string) => createExternalActionAuthorizedRequestHeaders({
            authorization, effectActionId, target, installationId: f.controller.installationId,
            privateKey: f.controller.keys.secretKey, method: 'GET', path,
        });
        await withAuthenticatedTestApp(app => {
            artifactsRoutes(app);
            projectSourceRoutes(app);
            registerDeploymentRoutes(app);
            registerProjectAccountRowRoutes(app);
        }, async app => {
            // DeploymentBackupSetup prepares defaults before any destination
            // mutation or native source review. These are its real Home reads.
            for (const [path, effect] of [
                [`/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`, actionId],
                [`/v1/projects/sources/${f.environment.projectSourceId}?serverId=${serverId}`, 'projects.sources.read'],
                [`/v1/projects/${f.environment.projectSourceId}/deployment-defaults?serverId=${serverId}`, actionId],
                [`/v1/artifacts/${f.environment.contentArtifactId}`, actionId],
            ] as const) {
                const read = await app.inject({ method: 'GET', url: path, headers: headers(path, effect) });
                expect(read.statusCode, read.body).toBe(200);
            }
            const otherEnvironment = `/v1/deployments/environments/${foreign.environment.id}?serverId=${serverId}`;
            expect((await app.inject({ method: 'GET', url: otherEnvironment, headers: headers(otherEnvironment, actionId) })).statusCode)
                .toBe(401);
            const other = `/v1/projects/sources/${foreign.environment.projectSourceId}?serverId=${serverId}`;
            expect((await app.inject({ method: 'GET', url: other, headers: headers(other, 'projects.sources.read') })).statusCode)
                .toBe(401);
            const otherContent = `/v1/artifacts/${foreign.environment.contentArtifactId}`;
            expect((await app.inject({ method: 'GET', url: otherContent, headers: headers(otherContent, actionId) })).statusCode)
                .toBe(401);
            const unrelatedContent = `/v1/artifacts/${unrelated.contentArtifactId}`;
            expect((await app.inject({ method: 'GET', url: unrelatedContent, headers: headers(unrelatedContent, actionId) })).statusCode)
                .toBe(401);
            // Backup source choices read the definition's workspace (J29, #130): only the requester's own
            // workspace references on this Home; the row owner keeps Account isolation.
            const rowsPath = '/v1/account/project-rows/list';
            const list = (body: unknown) => app.inject({ method: 'POST', url: rowsPath, payload: body as object,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId, target,
                    installationId: f.controller.installationId, privateKey: f.controller.keys.secretKey,
                    method: 'POST', path: rowsPath, body }) });
            const workspaces = await list({ kinds: ['workspace-ref'], serverId });
            expect(workspaces.statusCode, workspaces.body).toBe(200);
            expect(workspaces.json()).toMatchObject({ status: 'listed', rows: [] });
            for (const body of [{ kinds: ['relationship-graph'], serverId }, { kinds: ['workspace-ref', 'relationship-graph'], serverId }, {},
                { kinds: ['workspace-ref'], serverId: 'requester-local-home-profile' }, { kinds: ['workspace-ref'] }]) {
                expect((await list(body)).statusCode, JSON.stringify(body)).toBe(401);
            }
        }, { authentication: 'real' });
    });

    it.each((['plain', 'e2ee'] as const).flatMap(contentMode => [false, true].map(existing => ({ contentMode, existing }))))
    ('persists incomplete template captures through signed storage HTTP ($contentMode; existing=$existing)', async ({ contentMode, existing }) => {
        const f = await fixture('account', 'account', { templateRoot: true, readableEnvironment: true, contentMode });
        const resourceId = crypto.randomUUID(), resourceKey = nacl.randomBytes(32);
        const resourceContent = { v: 1 as const, name: 'Template key', kind: 'password' as const, value: 'private-test-boundary' };
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: f.account.id, resourceId,
            displayName: resourceContent.name, kind: resourceContent.kind, encryptionMode: contentMode,
            storedContent: sealSavedSecretResourceStoredContentV1(contentMode === 'plain'
                ? { resourceId, mode: contentMode, content: resourceContent }
                : { resourceId, mode: contentMode, content: resourceContent, resourceDataKey: resourceKey, randomBytes: nacl.randomBytes }),
            ...(contentMode === 'e2ee' ? { keyEnvelopes: [{ recipientAccountId: f.account.id,
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey, recipientPublicKey: f.accountKeys.publicKey,
                    randomBytes: nacl.randomBytes }), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(f.accountKeys.publicKey) }] } : {}) })))
            .toMatchObject({ ok: true });
        const requestKey = crypto.randomUUID();
        const input = existing ? { ...f.templateInput, environment: { ...f.templateInput.environment, expectedRevision: f.environmentRevision } } : { ...f.templateInput,
            environment: { kind: 'create' as const, requestKey, name: 'Store secret preparation', protection: 'nonProduction' as const,
                purpose: 'standard' as const, deployerMode: 'managers' as const, controllerMachineId: f.controller.id },
            target: { kind: 'new' as const, installationId: f.member.installationId }, destination: { kind: 'stored' as const } };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const root = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.templates.instantiate', machineId: f.controller.id, target, requestId: envelope.requestId,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const content = await f.content('deployment-environment.v1');
        const body = existing ? { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision, ...content,
            referencedSavedSecretRevisions: [{ resourceId, revision: 1 }] } : { serverId, projectSourceId: f.environment.projectSourceId, requestKey,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: f.controller.id,
            buildMachineId: f.member.id, ...content, referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
            firstTargetLink: { ...await f.content('deployment-target-link.v1'),
                machines: [{ machineId: f.member.id, installationId: f.member.installationId }] } };
        const method = existing ? 'PATCH' as const : 'POST' as const;
        const path = `/v1/deployments/environments${existing ? `/${f.environment.id}` : ''}`;
        const effectActionId = existing ? 'deployments.environments.update' : 'deployments.environments.create';
        const headers = (payload: unknown) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                method, path, body: payload, privateKey: f.controller.keys.secretKey }),
        });
        const { referencedSavedSecretRevisions: _pending, ...publicBody } = body;
        // Control: the same signed template scope accepts its ordinary public storage operand.
        expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token,
            effectActionId, encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body: publicBody,
            routeInput: publicBody, machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                method, path, body: publicBody, privateKey: f.controller.keys.secretKey }) })).not.toBeNull();
        const unrelatedStorageOperands = existing
            ? [{ ...body, preparedBindings: { grants: [], referencedSavedSecretRevisions: [] } },
                { ...body, authoredInputDigest: 'a'.repeat(43) }]
            : [{ ...body, copyFrom: { environmentId: f.environment.id, expectedRevision: f.environmentRevision },
                copyIntentCommitment: 'a'.repeat(43) }];
        for (const payload of unrelatedStorageOperands) {
            expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token,
                effectActionId, encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body: payload,
                routeInput: payload, machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                    method, path, body: payload, privateKey: f.controller.keys.secretKey }) })).toBeNull();
        }
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const substituted = existing ? { ...body, expectedRevision: f.environmentRevision + 1 }
                : { ...body, requestKey: crypto.randomUUID() };
            expect((await app.inject({ method, url: path, payload: substituted, headers: headers(substituted) })).statusCode).toBe(401);
            if (existing) {
                // This broad fixture retains a legacy null capture column. Unknown references cannot be discarded.
                const legacy = await app.inject({ method, url: path, payload: body, headers: headers(body) });
                expect(legacy.statusCode, legacy.body).toBe(409);
                expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }))
                    .referencedSavedSecretRevisions).toBeNull();
                // Ordinary binding-free creation writes a complete empty array.
                await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { referencedSavedSecretRevisions: [] } });
            }
            const result = await app.inject({ method, url: path, payload: body, headers: headers(body) });
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ ok: true });
            const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: result.json().environmentId } });
            expect(row.referencedSavedSecretRevisions).toEqual([{ resourceId, revision: 1 }]);
            expect(row.contentArtifactId).toBe(content.contentArtifactId);
        }, { authentication: 'real' });
    });

    // A template root's bindings child reads back the Environment that root created (Store install, J35)
    // or selected (Add database, DJ12), signed as the child effect, with or without a deploy intent (#130).
    it.each((['plain', 'e2ee'] as const).flatMap(contentMode => (['create', 'createNewProject', 'existing'] as const)
        .flatMap(shape => [false, true].map(deploy => ({ contentMode, shape, deploy })))))
    ('admits a template root and its bindings child reading its own Environment ($contentMode; $shape; deploy=$deploy), never a foreign one', async ({ contentMode, shape, deploy }) => {
        const f = await fixture('account', 'account', { templateRoot: true, readableEnvironment: true, contentMode });
        const foreign = await fixture('account', 'account', { contentMode });
        const resourceId = crypto.randomUUID(), resourceKey = nacl.randomBytes(32);
        const resourceContent = { v: 1 as const, name: 'Template key', kind: 'password' as const, value: 'template-test-boundary' };
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: f.account.id, resourceId,
            displayName: resourceContent.name, kind: resourceContent.kind, encryptionMode: contentMode,
            storedContent: sealSavedSecretResourceStoredContentV1(contentMode === 'plain'
                ? { resourceId, mode: contentMode, content: resourceContent }
                : { resourceId, mode: contentMode, content: resourceContent, resourceDataKey: resourceKey, randomBytes: nacl.randomBytes }),
            ...(contentMode === 'e2ee' ? { keyEnvelopes: [{ recipientAccountId: f.account.id,
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey, recipientPublicKey: f.accountKeys.publicKey,
                    randomBytes: nacl.randomBytes }), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(f.accountKeys.publicKey) }] } : {}) })))
            .toMatchObject({ ok: true });
        const requestKey = crypto.randomUUID();
        const { projectSourceId: _source, deploy: deployIntent, ...withoutSource } = f.templateInput;
        const project = shape === 'createNewProject' ? { newProject: { requestKey: crypto.randomUUID(), name: 'Template project',
            owner: { kind: 'account' as const, accountId: f.account.id } } } : { projectSourceId: f.environment.projectSourceId };
        const input = { ...withoutSource, ...project, ...(deploy ? { deploy: deployIntent } : {}),
            ...(shape === 'existing' ? {} : {
                environment: { kind: 'create' as const, requestKey, name: 'Template', protection: 'nonProduction' as const,
                    purpose: 'standard' as const, deployerMode: 'managers' as const, controllerMachineId: f.controller.id },
                target: { kind: 'new' as const, installationId: f.member.installationId }, destination: { kind: 'stored' as const } }) };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const root = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.templates.instantiate', machineId: f.controller.id, target, requestId: envelope.requestId,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const sign = (effectActionId: string, method: string, path: string, payload?: unknown, reviewedChild?: ReviewedActionChildHttpProofV1) =>
            signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId, target,
                installationId: f.controller.installationId, requestId: envelope.requestId, method, path, body: payload,
                ...(reviewedChild ? { reviewedChild } : {}), privateKey: f.controller.keys.secretKey });
        const headers = (effectActionId: string, method: string, path: string, payload?: unknown, reviewedChild?: ReviewedActionChildHttpProofV1) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: sign(effectActionId, method, path, payload, reviewedChild),
        });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            let environmentId = f.environment.id;
            if (shape !== 'existing') {
                const content = await f.content('deployment-environment.v1');
                const body = { serverId, ...project, requestKey,
                    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: f.controller.id,
                    buildMachineId: f.member.id, ...content, referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
                    firstTargetLink: { ...await f.content('deployment-target-link.v1'),
                        machines: [{ machineId: f.member.id, installationId: f.member.installationId }] } };
                const created = await app.inject({ method: 'POST', url: '/v1/deployments/environments', payload: body,
                    headers: headers('deployments.environments.create', 'POST', '/v1/deployments/environments', body) });
                expect(created.statusCode, created.body).toBe(200);
                environmentId = created.json().environmentId;
            }
            const revision = (await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } })).revision;
            const child: ReviewedActionChildHttpProofV1 = { actionId: 'deployments.bindings.set', role: 'template.bindings',
                inputDigest: computeActionInputApprovalDigestV1('deployments.bindings.set', { serverId, environmentId,
                    expectedRevision: revision, set: [], remove: [] }) };
            const read = async (id: string, effectActionId: string, reviewedChild?: ReviewedActionChildHttpProofV1) => {
                const path = `/v1/deployments/environments/${id}?serverId=${encodeURIComponent(serverId)}`;
                return (await app.inject({ method: 'GET', url: path, headers: headers(effectActionId, 'GET', path, undefined, reviewedChild) })).statusCode;
            };
            // Each read the root and its bindings child make is admitted for the owner and refused for a foreign Environment.
            for (const [effectActionId, reviewedChild] of [['deployments.environments.get', undefined],
                ['deployments.bindings.set', undefined], ['deployments.bindings.set', child]] as const) {
                expect(await read(environmentId, effectActionId, reviewedChild), `${effectActionId} own`).toBe(200);
                expect(await read(foreign.environment.id, effectActionId, reviewedChild), `${effectActionId} foreign`).toBe(401);
            }
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('prepares a template addition to an existing %s Environment through signed Home HTTP', async contentMode => {
        const f = await fixture('account', 'account', { readableEnvironment: true, contentMode });
        const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: contentMode === 'plain' ? null : {
            type: 'dataKey' as const, machineKey: f.accountKeys.secretKey, publicKey: f.accountKeys.publicKey,
        } };
        const publish = async (addDatabase: boolean) => {
            const document = JSON.stringify({ services: { app: { image: 'example/app:1' },
                ...(addDatabase ? { postgres: { image: 'postgres:17' } } : {}) } });
            const content = { ...createDeploymentEnvironmentDetailV1().content, definition: { kind: 'stored', document,
                contentRevision: addDatabase ? 2 : 1, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                profiles: [], services: addDatabase ? ['app', 'postgres'] : ['app'] } };
            const key = nacl.randomBytes(32);
            const seal = async (value: unknown) => contentMode === 'plain'
                ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                : new Uint8Array(await sealSessionDataKeyBundleV0(value, key));
            const created = await createArtifact({ actorUserId: f.account.id, artifactId: crypto.randomUUID(),
                kind: 'v1:other:deployment-environment.v1',
                header: await seal({ kind: 'deployment-environment.v1', title: content.name }),
                body: await seal({ body: JSON.stringify(content) }),
                dataEncryptionKey: contentMode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: f.accountKeys.publicKey, randomBytes: nacl.randomBytes }) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: await publish(false) });
        const candidate = await publish(true);
        const input = { ...f.templateInput, environment: { ...f.templateInput.environment, expectedRevision: f.environmentRevision } };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const root = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.templates.instantiate', machineId: f.controller.id, target, requestId: envelope.requestId,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const exchanges: Array<{ method: string; path: string; status: number }> = [];
        await withAuthenticatedTestApp(app => {
            registerAccountProfileRoute(app);
            registerAccountSettingsRoutes(app);
            featuresRoutes(app);
            registerAccountEncryptionRoutes(app);
            artifactsRoutes(app);
            registerDeploymentRoutes(app);
            app.addHook('onResponse', async (request, reply) => {
                exchanges.push({ method: request.method, path: request.url.split('?')[0]!, status: reply.statusCode });
            });
        }, async app => {
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            const channel = await createRequesterCurrentnessSocketHarness();
            let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
            try {
                requester = await admitRequesterAccountActionContext({ authorization: root, credentials,
                    serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, isCurrent: async () => true });
                if (!requester) throw new Error(`Expected admitted requester: ${JSON.stringify(exchanges)}`);
                const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                    serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, target,
                    installationId: f.controller.installationId, privateKey: f.controller.keys.secretKey, rootAdmitted: true });
                if (!authorization?.requesterHttpProjection) throw new Error('Expected signed requester HTTP projection');
                // Real requester custody, signer, Home policy, Artifact codecs and content admission run together.
                const prepare = createPrepareEnvironmentContentForHost({ credentials, serverHttpBaseUrl: origin,
                    resolveRequestHeaders: (_context, effectActionId, request) =>
                        authorization.requesterHttpProjection!.createRequestHeaders({ ...request, effectActionId }) });
                const result = await prepare({ actionId: 'deployments.environments.update',
                    input: { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision, ...candidate },
                    context: { externalActionExecutionAuthorization: authorization } });
                expect(result, JSON.stringify(exchanges)).toBeNull();
                expect(exchanges).toContainEqual({ method: 'GET', path: `/v1/deployments/environments/${f.environment.id}`, status: 200 });
                expect(exchanges).toContainEqual({ method: 'GET', path: `/v1/artifacts/${candidate.contentArtifactId}`, status: 200 });
            } finally { await requester?.dispose(); await channel.close(); }
        }, { authentication: 'real' });
    });

    it('saves an authored variable binding through signed requester preparation and real Home HTTP', async () => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        const home = await mkdtemp(join(tmpdir(), 'happier-binding-author-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const exchanges: Array<{ method: string; path: string; status: number }> = [];
        let publication: unknown;
        const channel = await createRequesterCurrentnessSocketHarness();
        try {
            process.env.HAPPIER_HOME_DIR = home;
            reloadConfiguration();
            const identity = await readOrCreateInstallationIdentity(configuration.installationIdentityFile);
            await db.machine.update({ where: { id: f.controller.id }, data: {
                installationId: identity.installationId,
                installationPublicKey: privacyKit.decodeBase64(identity.publicKey, 'base64url'),
            } });
            const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const credentials = { token, encryption: null };
            const target = { kind: 'machine' as const, machineId: f.controller.id };
            const binding = { purpose: 'variable', name: 'PUBLIC_LABEL', phase: 'runtime', source: { kind: 'value', value: 'authored' } } as const;
            const input = getActionSpec('deployments.bindings.set').inputSchema.parse({ serverId,
                environmentId: f.environment.id, expectedRevision: f.environmentRevision,
                set: [binding],
                remove: [],
            });
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            const root = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
                actionId: 'deployments.bindings.set', machineId: f.controller.id, target, requestId: envelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
            await withAuthenticatedTestApp(async app => {
                registerAccountProfileRoute(app);
                registerAccountEncryptionRoutes(app);
                registerAccountSettingsRoutes(app);
                featuresRoutes(app);
                artifactsRoutes(app);
                registerDeploymentRoutes(app);
                app.addHook('onResponse', async (request, reply) => {
                    exchanges.push({ method: request.method, path: request.url.split('?')[0]!, status: reply.statusCode });
                    if (request.method === 'POST' && request.url === '/v1/artifacts' && reply.statusCode === 200) publication = request.body;
                });
            }, async app => {
                // Both Axios authoring and the fetch-based feature probe reach the same real Home routes.
                const origin = await app.listen({ host: '127.0.0.1', port: 0 });
                let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
                try {
                    requester = await admitRequesterAccountActionContext({ authorization: root, credentials,
                        serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, isCurrent: async () => true });
                    expect(requester, JSON.stringify(exchanges)).not.toBeNull();
                    if (!requester) throw new Error('Expected admitted requester');
                    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                        serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, target,
                        installationId: identity.installationId, privateKey: identity.privateKey, rootAdmitted: true });
                    if (!authorization?.requesterHttpProjection) throw new Error('Expected signed requester HTTP projection');
                    const prepare = createPrepareDeploymentBindingsForHost({ credentials, serverId,
                        serverHttpBaseUrl: origin, machineId: f.controller.id,
                        resolveRequestHeaders: (_context, effectActionId, request) =>
                            authorization.requesterHttpProjection!.createRequestHeaders({ ...request, effectActionId }) });
                    const prepared = await prepare({ input, context: { externalActionExecutionAuthorization: authorization,
                        signal: new AbortController().signal } });
                    expect(exchanges).toContainEqual({ method: 'GET', path: `/v1/deployments/environments/${f.environment.id}`, status: 200 });
                    expect(exchanges).toContainEqual({ method: 'GET', path: `/v1/artifacts/${f.environment.contentArtifactId}`, status: 200 });
                    expect(exchanges).toContainEqual({ method: 'POST', path: `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`, status: 200 });
                    expect(prepared, JSON.stringify(exchanges)).toMatchObject({ environmentId: f.environment.id,
                        expectedRevision: input.expectedRevision });
                    if ('ok' in prepared) throw new Error('Expected prepared authored bindings');
                    const candidate = ArtifactJsonCreateHttpInputV1Schema.parse(publication);
                    for (const refused of [{ ...candidate, id: crypto.randomUUID() },
                        { ...candidate, kind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 }]) {
                        const headers = await authorization.requesterHttpProjection.createRequestHeaders({ method: 'POST',
                            path: '/v1/artifacts', body: refused, effectActionId: 'deployments.bindings.set' });
                        const rejected = await app.inject({ method: 'POST', url: '/v1/artifacts', headers: {
                            ...currentAccountStoredContentCompatibilityHeaders, ...headers }, payload: refused });
                        expect(rejected.statusCode, rejected.body).toBe(401);
                    }
                    const path = `/v1/deployments/environments/${f.environment.id}/bindings`;
                    const body = DeploymentBindingsSetStorageInputV1Schema.parse(prepared);
                    const sibling = await db.deploymentEnvironment.create({ data: { projectSourceId: f.environment.projectSourceId,
                        createdByAccountId: f.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                        controllerMachineId: f.controller.id, buildMachineId: f.builder.id, revision: input.expectedRevision,
                        contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: f.environment.contentHeaderVersion,
                        contentBodyVersion: f.environment.contentBodyVersion } });
                    const siblingPath = `/v1/deployments/environments/${sibling.id}/bindings`;
                    const siblingBody = { ...body, environmentId: sibling.id, grants: [] };
                    const siblingHeaders = await authorization.requesterHttpProjection.createRequestHeaders({ method: 'POST',
                        path: siblingPath, body: siblingBody, effectActionId: 'deployments.bindings.set' });
                    const siblingSave = await app.inject({ method: 'POST', url: siblingPath, headers: {
                        ...currentAccountStoredContentCompatibilityHeaders, ...siblingHeaders }, payload: siblingBody });
                    expect(siblingSave.statusCode, siblingSave.body).toBe(401);
                    expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: sibling.id } }))
                        .toMatchObject({ revision: sibling.revision, contentArtifactId: sibling.contentArtifactId });
                    const headers = await authorization.requesterHttpProjection.createRequestHeaders({ method: 'POST', path,
                        body, effectActionId: 'deployments.bindings.set' });
                    const saved = await app.inject({ method: 'POST', url: path, headers: {
                        ...currentAccountStoredContentCompatibilityHeaders, ...headers }, payload: body });
                    expect(saved.statusCode, saved.body).toBe(200);
                    const stored = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
                    expect(stored.contentArtifactId).toBe(prepared.contentArtifactId);
                    expect(stored.revision).toBe(input.expectedRevision + 1);
                    const artifact = await readArtifactForCallerInTx(db, { actorAccountId: f.account.id,
                        artifactId: stored.contentArtifactId });
                    if (!artifact.ok) throw new Error(artifact.error);
                    const content = ArtifactBodyEnvelopeV1Schema.parse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.artifact.body)));
                    if (typeof content.body !== 'string') throw new Error('Expected authored Environment text');
                    expect(JSON.parse(content.body)).toMatchObject({ bindings: [binding] });
                } finally {
                    await requester?.dispose();
                }
            }, { authentication: 'real' });
        } finally {
            await channel.close();
            if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            reloadConfiguration();
            await rm(home, { recursive: true, force: true });
        }
    });

    it.each(['deployments.bindings.set', 'deployments.templates.instantiate'] as const)(
        'prepares client-side binding secrets for %s only on the signed Home and Environment', async actionId => {
        const f = await fixture();
        const foreign = await fixture();
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = actionId === 'deployments.templates.instantiate' ? { ...f.templateInput,
            environment: { ...f.templateInput.environment, expectedRevision: f.environmentRevision } } : getActionSpec(actionId).inputSchema.parse({ serverId, environmentId: f.environment.id,
            expectedRevision: f.environmentRevision, referencedSavedSecretRevisions: [],
            ...await f.content('deployment-environment.v1') });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            ...(actionId === 'deployments.templates.instantiate' ? {
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input),
            } : {}),
        }, { input });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const preparation = EnvironmentSecretClientBindingsInputV1Schema.parse({ kind: 'clientBindings', serverId,
                environmentId: f.environment.id, expectedRevision: f.environmentRevision });
            const effectActionId = 'deployments.bindings.set';
            const reviewedChild: ReviewedActionChildHttpProofV1 | undefined = actionId === 'deployments.templates.instantiate' ? {
                actionId: effectActionId, role: 'template.bindings',
                inputDigest: computeActionInputApprovalDigestV1(effectActionId, { serverId,
                    environmentId: f.environment.id, expectedRevision: f.environmentRevision, set: [], remove: [] }),
            } : undefined;
            const prepare = (body: typeof preparation) => {
                const path = `/v1/deployments/environments/${body.environmentId}/secret-launch-admission`;
                return app.inject({ method: 'POST', url: path, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId, target,
                        installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'POST', path, body, ...(reviewedChild ? { reviewedChild } : {}),
                        privateKey: f.controller.keys.secretKey }),
                } });
            };
            for (const body of [{ ...preparation, serverId: 'another-home' },
                { ...preparation, environmentId: foreign.environment.id }]) {
                expect((await prepare(body)).statusCode).toBe(401);
            }
            if (actionId === 'deployments.bindings.set') {
                expect((await prepare({ ...preparation, buildMachineId: f.controller.id })).statusCode).toBe(401);
            }
            for (const [environmentId, expectedStatus] of [[f.environment.id, 200], [foreign.environment.id, 401]] as const) {
                const path = `/v1/deployments/environments/${environmentId}?serverId=${encodeURIComponent(serverId)}`;
                const metadata = await app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId, target,
                        installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'GET', path, body: undefined, ...(reviewedChild ? { reviewedChild } : {}),
                        privateKey: f.controller.keys.secretKey }),
                } });
                expect(metadata.statusCode).toBe(expectedStatus);
            }
            const prepared = await prepare(preparation);
            expect(prepared.statusCode, prepared.body).toBe(200);
            expect(prepared.json()).toMatchObject({ ok: true, bindingPreparation: {} });
        }, { authentication: 'real' });
        // Authored binding changes publish one private candidate under the bindings
        // child's deterministic id, then commit it through the bindings CAS.
        const verify = (method: string, path: string, body: unknown) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: authorization.token, effectActionId: 'deployments.bindings.set',
            encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body, routeInput: body,
            ...(reviewedChild ? { reviewedChild } : {}),
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: 'deployments.bindings.set', target, installationId: f.controller.installationId,
                requestId: envelope.requestId, method, path, body, ...(reviewedChild ? { reviewedChild } : {}),
                privateKey: f.controller.keys.secretKey }) });
        const reviewedChild: ReviewedActionChildHttpProofV1 | undefined = actionId === 'deployments.templates.instantiate' ? {
            actionId: 'deployments.bindings.set', role: 'template.bindings',
            inputDigest: computeActionInputApprovalDigestV1('deployments.bindings.set', { serverId,
                environmentId: f.environment.id, expectedRevision: f.environmentRevision, set: [], remove: [] }),
        } : undefined;
        const candidateId = createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding,
            actionId: 'deployments.bindings.set', environmentId: f.environment.id });
        const candidate = (id: string) => ArtifactJsonCreateHttpInputV1Schema.parse({ id, kind: 'v1:other:deployment-environment.v1',
            header: encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Bindings' }),
            body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
        expect(await verify('POST', '/v1/artifacts', candidate(candidateId))).not.toBeNull();
        expect(await verify('POST', '/v1/artifacts', candidate(crypto.randomUUID()))).toBeNull();
        const storage = DeploymentBindingsSetStorageInputV1Schema.parse({ serverId, environmentId: f.environment.id,
            expectedRevision: f.environmentRevision, contentArtifactId: candidateId, contentHeaderVersion: 1,
            contentBodyVersion: 1, referencedSavedSecretRevisions: [], grants: [] });
        expect(await verify('POST', `/v1/deployments/environments/${f.environment.id}/bindings`, storage)).not.toBeNull();
    });

    it.each(['deployments.targets.link', 'deployments.bindings.set'] as const)(
        'allows signed %s preparation to read an accessible Environment without granting foreign resources or writes', async actionId => {
        const f = await fixture();
        const foreign = await fixture();
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = getActionSpec(actionId).inputSchema.parse({ serverId, environmentId: f.environment.id,
            expectedRevision: f.environmentRevision,
            ...(actionId === 'deployments.targets.link'
                ? { requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
                    machines: [{ machineId: f.member.id, installationId: f.member.installationId }],
                    ...await f.content('deployment-target-link.v1') }
                : { referencedSavedSecretRevisions: [], ...await f.content('deployment-environment.v1') }) });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const [environmentId, statusCode] of [[f.environment.id, 200],
                [foreign.environment.id, 401]] as const) {
                const path = `/v1/deployments/environments/${environmentId}?serverId=${serverId}`;
                const effectActionId = 'deployments.environments.get';
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'GET', path, body: undefined, privateKey: f.controller.keys.secretKey }),
                } });
                expect(response.statusCode, response.body).toBe(statusCode);
                if (statusCode === 401) expect(response.json()).toMatchObject({ error: 'invalid_token' });
            }
            if (actionId === 'deployments.bindings.set') {
                const body = DeploymentBindingsSetStorageInputV1Schema.parse({ ...input, grants: [] });
                const path = `/v1/deployments/environments/${f.environment.id}/bindings`;
                const admitted = await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                    effectActionId: actionId, encodedTarget: encodeExternalActionResolvedTargetV1(target),
                    method: 'POST', path, body, routeInput: body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'POST', path, body, privateKey: f.controller.keys.secretKey }),
                });
                expect(admitted, 'the signed binding root must admit its existing prepared storage body').not.toBeNull();
            }
            const path = `/v1/deployments/environments/${f.environment.id}`;
            const body = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision, patch: { protection: 'production' } };
            const effectActionId = 'deployments.environments.update';
            const denied = await app.inject({ method: 'PATCH', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'PATCH', path, body, privateKey: f.controller.keys.secretKey }),
            } });
            expect(denied.statusCode, denied.body).toBe(401);
        }, { authentication: 'real' });
    });

    it.each([
        'deployments.environments.delete',
        'deployments.targets.unlink',
        'happier.machine.services/actions/deployment-failed/setup',
        'happier.machine.services/actions/deployment-succeeded/setup',
    ] as const)('carries admitted %s context into its Environment read', async actionId => {
        const f = await fixture();
        const foreign = await fixture();
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const cleanup = actionId === 'deployments.environments.delete' || actionId === 'deployments.targets.unlink';
        const rootActionId = cleanup ? actionId : 'action.invoke';
        const input = StrictJsonValueSchema.parse(cleanup
            ? { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision, requestKey: crypto.randomUUID(),
                ...(actionId === 'deployments.targets.unlink' ? { targetLinkId: f.link.id, targetLinkRevision: f.link.revision } : {}) }
            : { action: { pluginId: 'happier.machine.services', localId: actionId.endsWith('deployment-failed/setup')
                ? 'deployment-failed/setup' : 'deployment-succeeded/setup' },
                input: { v: 1, serverId, environmentId: f.environment.id } });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: rootActionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        // A cleanup root reads only its own Environment, even one its Account can read.
        const sibling = cleanup ? await db.deploymentEnvironment.create({ data: { projectSourceId: f.environment.projectSourceId,
            createdByAccountId: f.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.controller.id, ...await f.content('deployment-environment.v1') } }) : null;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const [environmentId, statusCode] of [[f.environment.id, 200], ...(sibling ? [[sibling.id, 401] as const] : []),
                [foreign.environment.id, cleanup ? 401 : 404]] as const) {
                const path = `/v1/deployments/environments/${environmentId}?serverId=${serverId}`;
                const effectActionId = 'deployments.environments.get';
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'GET', path, body: undefined, privateKey: f.controller.keys.secretKey }),
                } });
                expect(response.statusCode, response.body).toBe(statusCode);
            }
        }, { authentication: 'real' });
    });

    it.each(['action.invoke', 'deployments.environments.get'] as const)(
        'keeps the admitted %s child relationship and Account isolation during a mutation', async actionId => {
        const f = await fixture();
        const foreign = await fixture();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded', settledAt: new Date() } });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const contributes = actionId === 'action.invoke';
        const input = StrictJsonValueSchema.parse(contributes ? { action: { pluginId: 'happier.machine.services', localId: 'cleanup' }, input: {} }
            : { serverId, environmentId: f.environment.id });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const [subject, statusCode] of [[foreign, 404], [f, 200]] as const) {
                const path = `/v1/deployments/environments/${subject.environment.id}/delete`;
                const effectActionId = 'deployments.environments.delete';
                const body = { serverId, environmentId: subject.environment.id, expectedRevision: subject.environmentRevision,
                    requestKey: crypto.randomUUID(), detachKeepRunning: true };
                const response = await app.inject({ method: 'POST', url: path, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                        method: 'POST', path, body, privateKey: f.controller.keys.secretKey }),
                } });
                expect(response.statusCode, response.body).toBe(contributes ? statusCode : 401);
            }
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).deletedAt !== null).toBe(contributes);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: foreign.environment.id } })).deletedAt).toBeNull();
        }, { authentication: 'real' });
    });

    async function domainRootFixture(contentMode: 'plain' | 'e2ee' = 'plain', encryptedRoot = false, separateControllerCustodian = false) {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, separateControllerCustodian,
            separateContentOwner: true, contentMode });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { serverId, environmentId: f.environment.id, domainId: crypto.randomUUID(),
            expectedRevision: f.environmentRevision, targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
            requestKey: crypto.randomUUID(), ...await f.content('deployment-domain.v1'),
            placements: [{ machineId: f.member.id, installationId: f.member.installationId, nativeServer: 'private', listener: 'privateOrigin' as const,
                dockerEngineId: 'domain-engine' }] };
        const requestId = crypto.randomUUID();
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const { placements: _derivedPlacements, ...withoutPlacements } = input;
        const rootInput = encryptedRoot ? withoutPlacements : input;
        const envelope = encryptedRoot ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId: 'deployments.domains.add', requestId, target },
            input: rootInput, material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input: rootInput };
        const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({
            actionId: 'deployments.domains.add', envelope });
        const mintQueries: { model?: string; action: string }[] = [];
        const stopMintQueries = observeSqliteRequests({ before: request => { mintQueries.push({ model: request.model, action: request.action }); } });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication,
            actionId: 'deployments.domains.add', machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, {
                input: encryptedRoot ? deploymentNativeAdmission : input, deploymentNativeAdmission }).finally(stopMintQueries);
        return { f, target, input, envelope, authorization, mintQueries };
    }

    it.each(['plain', 'e2ee'] as const)('reads the incumbent receipt only inside the signed %s Domain Environment', async mode => {
        const { f, target, authorization } = await domainRootFixture(mode, mode === 'e2ee');
        const foreign = await fixture();
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            for (const [environment, receipt, status] of [
                [f.environment, f.receipt, 200],
                [foreign.environment, foreign.receipt, 401],
            ] as const) {
                const spec = getActionSpec('deployments.receipts.get');
                if (!spec.serverTransport) throw new Error('Expected receipt HTTP transport');
                const path = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema,
                    input: { serverId, environmentId: environment.id, deploymentId: receipt.id } }).path;
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.receipts.get',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: 'deployments.receipts.get', target,
                        installationId: f.controller.installationId, requestId: authorization.binding.requestId,
                        method: 'GET', path, privateKey: f.controller.keys.secretKey,
                    }),
                } });
                expect(response.statusCode, response.body).toBe(status);
                if (status === 200) expect(response.json()).toMatchObject({ ok: true, deployment: { id: receipt.id } });
            }
            for (const [receipt, status] of [[f.receipt, 200], [foreign.receipt, 404]] as const) {
                const path = `/v1/artifacts/${receipt.contentArtifactId}`;
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: 'deployments.domains.add', target,
                        installationId: f.controller.installationId, requestId: authorization.binding.requestId,
                        method: 'GET', path, privateKey: f.controller.keys.secretKey,
                    }),
                } });
                expect(response.statusCode, response.body).toBe(status);
            }
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('admits a signed %s Domain admission and retained settlement through its real controller HTTP transport', async mode => {
        const { f, input, envelope, target, authorization, mintQueries } = await domainRootFixture(mode, mode === 'e2ee');
        expect(mintQueries.filter(query => query.model === 'ProjectSource')).toEqual([]);
        expect.soft(authorization.binding.environmentId).toBe(input.environmentId);
        const body = { ...input, actionOperationId: crypto.randomUUID(), requestId: envelope.requestId };
        const path = `/v1/deployments/environments/${input.environmentId}/domains`;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const substitution of [{ domainId: crypto.randomUUID() }, await f.content('deployment-domain.v1')]) {
                const foreignBody = { ...body, ...substitution };
                const foreign = await app.inject({ method: 'POST', url: path, payload: foreignBody, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'deployments.domains.add', target, installationId: f.controller.installationId,
                        requestId: authorization.binding.requestId, method: 'POST', path, body: foreignBody,
                        privateKey: f.controller.keys.secretKey }),
                } });
                expect(foreign.statusCode, foreign.body).toBe(401);
            }
            const admissionQueries: { model?: string; action: string }[] = [];
            const stopAdmissionQueries = observeSqliteRequests({ before: request => { admissionQueries.push({ model: request.model, action: request.action }); } });
            const response = await app.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.domains.add', target, installationId: f.controller.installationId,
                    requestId: authorization.binding.requestId, method: 'POST', path, body, privateKey: f.controller.keys.secretKey }),
            } }).finally(stopAdmissionQueries);
            expect(response.statusCode, response.body).toBe(200);
            expect(admissionQueries.filter(query => query.model === 'ProjectSource')).toHaveLength(1);
            const created = DeploymentDomainMutationResultV1Schema.parse(response.json());
            expect(created).toMatchObject({ ok: true, domain: { state: 'pending' } });
            if (!created.ok || !created.domain.placements?.length) throw new Error('Expected captured Domain placement');
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.member.accountId } },
                data: { role: 'owner' } });
            expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
                .toMatchObject({ ok: true });
            await db.account.update({ where: { id: f.account.id }, data: { tokenEpoch: { increment: 1 } } });
            const observations = created.domain.placements.map(capture => {
                // A desired placement settles active only with matched DNS; otherwise it is a warning.
                const observation = { capture, state: 'active' as const, dnsHealth: { status: 'up' as const,
                    evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'dns' },
                        author: { kind: 'process' as const }, text: JSON.stringify({ reason: 'dns_matched' }) }] } } };
                return { ...observation, proof: signMachineInstallationProof({ payload: deploymentDomainObservationProofPayloadV1({
                    expectedDomainRevision: created.domain.revision, observation }), privateKey: f.member.keys.secretKey }) };
            });
            const transition = { serverId, environmentId: input.environmentId, domainId: input.domainId,
                expectedDomainRevision: created.domain.revision, observations };
            const transitionPath = `${path}/${input.domainId}/transitions`;
            const settled = await app.inject({ method: 'POST', url: transitionPath, payload: transition, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.domains.add', target, installationId: f.controller.installationId,
                    requestId: authorization.binding.requestId, method: 'POST', path: transitionPath, body: transition,
                    privateKey: f.controller.keys.secretKey }),
            } });
            expect(settled.statusCode, settled.body).toBe(200);
            expect(settled.json()).toMatchObject({ ok: true, domain: { state: 'active' } });
        }, { authentication: 'real' });
    });


    it.each(['save', 'initializeAndSave'] as const)('publishes backup bindings after an unchanged %s configuration save', async intent => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        const actionId = 'deployments.backups.configure';
        const native = projectDeploymentNativeAdmissionV1(actionId, { serverId,
            environmentId: f.environment.id, expectedRevision: f.environmentRevision, intent: 'markNotNeeded' });
        if (!native || !('kind' in native) || native.kind !== 'backupConfigure') throw new Error('Expected configure admission');
        const binding = { ...f.authorization.binding, actionId, environmentId: f.environment.id,
            deploymentNativeAdmission: { ...native, intent } };
        const bindingAction = 'deployments.bindings.set';
        const artifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...binding,
            actionId: bindingAction, environmentId: f.environment.id });
        for (const delta of [0, 1, 2]) {
            const expectedRevision = f.environmentRevision + delta;
            const reviewedChild = { actionId: bindingAction, role: 'backup.bindings' as const,
                inputDigest: computeActionInputApprovalDigestV1(bindingAction, { serverId, environmentId: f.environment.id,
                    expectedRevision, set: [], remove: [] }) };
            const storage = DeploymentBindingsSetStorageInputV1Schema.parse({ serverId, environmentId: f.environment.id,
                expectedRevision, contentArtifactId: artifactId,
                contentHeaderVersion: 1, contentBodyVersion: 1, referencedSavedSecretRevisions: [], grants: [] });
            const permitted = delta === 0 || delta === 1;
            expect(await readDeploymentBackupConfigureHttpPurpose(db, binding, bindingAction,
                { method: 'POST', path: `/v1/deployments/environments/${f.environment.id}/bindings`,
                    body: storage, routeInput: storage, reviewedChild })).toBe(permitted);
            const preparation = { kind: 'clientBindings', serverId, environmentId: f.environment.id, expectedRevision };
            expect(await readDeploymentBackupConfigureHttpPurpose(db, binding, bindingAction,
                { method: 'POST', path: `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`,
                    body: preparation, routeInput: preparation, reviewedChild })).toBe(permitted);
        }
    });

    it('publishes only the re-key password binding at the reviewed Environment revision', async () => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        const actionId = 'deployments.backups.configure';
        const native = projectDeploymentNativeAdmissionV1(actionId, { serverId,
            environmentId: f.environment.id, expectedRevision: f.environmentRevision, intent: 'markNotNeeded' });
        if (!native || !('kind' in native) || native.kind !== 'backupConfigure') throw new Error('Expected configure admission');
        const binding = { ...f.authorization.binding, actionId, environmentId: f.environment.id,
            deploymentNativeAdmission: { ...native, intent: 'rekeyAndSave' as const } };
        const bindingAction = 'deployments.bindings.set';
        const reviewedChild = { actionId: bindingAction, role: 'backup.bindings' as const,
            inputDigest: computeActionInputApprovalDigestV1(bindingAction, { serverId, environmentId: f.environment.id,
                expectedRevision: f.environmentRevision, set: [], remove: [] }) };
        const artifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...binding,
            actionId: bindingAction, environmentId: f.environment.id });
        const storage = DeploymentBindingsSetStorageInputV1Schema.parse({ serverId, environmentId: f.environment.id,
            expectedRevision: f.environmentRevision, contentArtifactId: artifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1, referencedSavedSecretRevisions: [], grants: [] });
        const path = `/v1/deployments/environments/${f.environment.id}/bindings`;
        expect(await readDeploymentBackupConfigureHttpPurpose(db, binding, bindingAction,
            { method: 'POST', path, body: storage, routeInput: storage, reviewedChild })).toBe(true);
        const stale = { ...storage, expectedRevision: storage.expectedRevision + 1 };
        expect(await readDeploymentBackupConfigureHttpPurpose(db, binding, bindingAction,
            { method: 'POST', path, body: stale, routeInput: stale, reviewedChild })).toBe(false);
        const configArtifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...binding, environmentId: f.environment.id });
        const backup = { ...storage, contentArtifactId: configArtifactId };
        expect(await readDeploymentBackupConfigureHttpPurpose(db, binding, actionId, { method: 'POST',
            path: `/v1/deployments/environments/${f.environment.id}/backup`, body: backup, routeInput: backup })).toBe(false);
        const preparation = { kind: 'clientBindings', serverId, environmentId: f.environment.id,
            expectedRevision: f.environmentRevision };
        expect(await readDeploymentBackupConfigureHttpPurpose(db, binding, bindingAction, { method: 'POST',
            path: `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`,
            body: preparation, routeInput: preparation, reviewedChild })).toBe(true);
    });

    it.each(['plain', 'e2ee'] as const)('admits backup configure on the exact %s Environment controller and reviewed revision', async mode => {
        const f = await fixture('account', 'account', { contentMode: mode, readableEnvironment: true });
        const foreign = await fixture();
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { runtimeTargetLinkId: null } });
        const actionId = 'deployments.backups.configure';
        const original = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            intent: 'save' as const, destinationSetup: { kind: 'anotherMachine' as const, machineId: f.outsider.id,
                expectedInstallationId: f.outsider.installationId, receiverInputs: {} }, configuration: { configRevision: 1,
                destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
                config: { path: '/private/repository' }, credentialBindings: [],
                sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
                ownership: { environmentId: f.environment.id, prefix: 'private-owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
        const mint = async (input: DeploymentBackupConfigureInputV1 = original, machine = f.controller, account = f.account) => {
            const target = { kind: 'machine' as const, machineId: machine.id };
            const requestId = crypto.randomUUID();
            const authentication = { kind: 'account' as const, tokenEpoch: account.tokenEpoch };
            const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding: { serverIdentityId: serverId, accountId: account.id, authentication, actionId, requestId, target }, input,
                material: { type: 'dataKey', machineKey: machine.contentKey }, randomBytes: nacl.randomBytes })
                : { v: 1 as const, requestId, target, input };
            const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
            return auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId, accountId: account.id,
                authentication, actionId, machineId: machine.id, target, requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
                { input: mode === 'e2ee' ? native : input, deploymentNativeAdmission: native });
        };
        const authorization = await mint();
        expect(authorization.binding.deploymentNativeAdmission).toMatchObject({ kind: 'backupConfigure',
            actionId, environmentId: f.environment.id, expectedRevision: f.environmentRevision, intent: 'save',
            receiverMachineId: f.outsider.id });
        expect(authorization.binding.deploymentCandidatePublication).toBeUndefined();
        await expect(mint({ ...original, expectedRevision: original.expectedRevision + 1 }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint(original, f.member)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint(original, foreign.controller, foreign.account)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const artifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding, environmentId: f.environment.id });
        const storage = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const path = `/v1/deployments/environments/${f.environment.id}/backup`;
        const verify = (method: string, path: string, body?: unknown, routeInput?: unknown, effectActionId = actionId,
            active = authorization, reviewedChild?: ReviewedActionChildHttpProofV1) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: active.token, effectActionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body, routeInput,
            ...(reviewedChild ? { reviewedChild } : {}),
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: active.token,
                effectActionId, target, installationId: f.controller.installationId,
                requestId: active.binding.requestId, method, path, body,
                ...(reviewedChild ? { reviewedChild } : {}), privateKey: f.controller.keys.secretKey }),
        });
        expect(await verify('GET', `/v1/machines/${f.outsider.id}`, undefined, { id: f.outsider.id })).not.toBeNull();
        expect(await verify('GET', `/v1/machines/${foreign.outsider.id}`, undefined, { id: foreign.outsider.id })).toBeNull();
        await expect(mint({ ...original, destinationSetup: { ...original.destinationSetup,
            machineId: foreign.outsider.id, expectedInstallationId: foreign.outsider.installationId } }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        expect(await verify('POST', path, storage, storage)).not.toBeNull();
        for (const change of [{ expectedRevision: storage.expectedRevision + 1 }, { contentArtifactId: crypto.randomUUID() },
            { environmentId: foreign.environment.id }]) {
            const substituted = { ...storage, ...change };
            expect(await verify('POST', path, substituted, substituted)).toBeNull();
        }
        const readPath = `/v1/deployments/environments/${f.environment.id}?serverId=${encodeURIComponent(serverId)}`;
        expect(await verify('GET', readPath, undefined, { serverId, environmentId: f.environment.id })).not.toBeNull();
        const sourceId = f.environment.projectSourceId;
        const sourcePath = `/v1/projects/sources/${sourceId}?serverId=${encodeURIComponent(serverId)}`;
        expect(await verify('GET', sourcePath, undefined, { serverId, id: sourceId }, 'projects.sources.read')).not.toBeNull();
        const defaultsPath = `/v1/projects/${sourceId}/deployment-defaults?serverId=${encodeURIComponent(serverId)}`;
        expect(await verify('GET', defaultsPath, undefined, { serverId, id: sourceId })).not.toBeNull();
        const foreignSource = foreign.environment.projectSourceId;
        expect(await verify('GET', `/v1/projects/sources/${foreignSource}?serverId=${encodeURIComponent(serverId)}`,
            undefined, { serverId, id: foreignSource }, 'projects.sources.read')).toBeNull();
        const currentContentPath = `/v1/artifacts/${f.environment.contentArtifactId}`;
        expect(await verify('GET', currentContentPath, undefined, { id: f.environment.contentArtifactId })).not.toBeNull();
        expect(await verify('GET', `/v1/artifacts/${foreign.environment.contentArtifactId}`,
            undefined, { id: foreign.environment.contentArtifactId })).toBeNull();
        const dataKey = nacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, dataKey)));
        const candidate = ArtifactJsonCreateHttpInputV1Schema.parse({ id: artifactId, kind: 'v1:other:deployment-environment.v1',
            header: await seal({ kind: 'deployment-environment.v1', title: 'Configured' }),
            body: await seal({ body: '{}' }), dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
                : privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                    recipientPublicKey: f.accountKeys.publicKey, randomBytes: nacl.randomBytes })) });
        expect(await verify('POST', '/v1/artifacts', candidate, candidate)).not.toBeNull();
        const substitutedCandidate = { ...candidate, id: crypto.randomUUID() };
        expect(await verify('POST', '/v1/artifacts', substitutedCandidate, substitutedCandidate)).toBeNull();
        const testOnly = await mint({ ...original, intent: 'test' });
        const testArtifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...testOnly.binding, environmentId: f.environment.id });
        const testStorage = { ...storage, contentArtifactId: testArtifactId };
        expect(await verify('POST', path, testStorage, testStorage, actionId, testOnly)).toBeNull();
        const testCandidate = { ...candidate, id: testArtifactId };
        expect(await verify('POST', '/v1/artifacts', testCandidate, testCandidate, actionId, testOnly)).toBeNull();
        const bindingAction = 'deployments.bindings.set';
        const bindingInput = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision + 1, set: [], remove: [] };
        const reviewedChild = { actionId: bindingAction, role: 'backup.bindings',
            inputDigest: computeActionInputApprovalDigestV1(bindingAction, bindingInput) };
        const preparationPath = `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`;
        const clientPreparation = EnvironmentSecretClientBindingsInputV1Schema.parse({ kind: 'clientBindings', serverId,
            environmentId: f.environment.id, expectedRevision: bindingInput.expectedRevision });
        const prepareBindings = (body: typeof clientPreparation) => verify('POST', preparationPath, body, body,
            bindingAction, authorization, reviewedChild);
        expect(await prepareBindings({ ...clientPreparation, expectedRevision: clientPreparation.expectedRevision + 1 })).toBeNull();
        expect(await prepareBindings({ ...clientPreparation, buildMachineId: f.controller.id })).toBeNull();
        expect(await prepareBindings(clientPreparation)).not.toBeNull();
        // The ordinary bindings preparer first reads its own Environment, then the
        // incumbent content, before publishing its binding-only successor under this child purpose.
        expect(await verify('GET', readPath, undefined, { serverId, environmentId: f.environment.id },
            bindingAction, authorization, reviewedChild)).not.toBeNull();
        expect(await verify('GET', `/v1/deployments/environments/${foreign.environment.id}?serverId=${encodeURIComponent(serverId)}`,
            undefined, { serverId, environmentId: foreign.environment.id }, bindingAction, authorization, reviewedChild)).toBeNull();
        expect(await verify('GET', currentContentPath, undefined, { id: f.environment.contentArtifactId },
            bindingAction, authorization, reviewedChild)).not.toBeNull();
        expect(await verify('GET', `/v1/artifacts/${foreign.environment.contentArtifactId}`,
            undefined, { id: foreign.environment.contentArtifactId }, bindingAction, authorization, reviewedChild)).toBeNull();
        const bindingArtifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding,
            actionId: bindingAction, environmentId: f.environment.id });
        const bindingStorage = DeploymentBindingsSetStorageInputV1Schema.parse({ serverId, environmentId: f.environment.id,
            expectedRevision: bindingInput.expectedRevision, contentArtifactId: bindingArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1, referencedSavedSecretRevisions: [], grants: [] });
        const bindingPath = `/v1/deployments/environments/${f.environment.id}/bindings`;
        expect(await verify('POST', bindingPath, bindingStorage, bindingStorage, bindingAction, authorization, reviewedChild)).not.toBeNull();
        expect(await verify('POST', bindingPath, bindingStorage, bindingStorage, bindingAction, testOnly, reviewedChild)).toBeNull();
        expect(await verify('POST', bindingPath, bindingStorage, bindingStorage, bindingAction, authorization,
            { ...reviewedChild, role: 'preview.bindings' })).toBeNull();
        for (const change of [{ environmentId: foreign.environment.id }, { expectedRevision: f.environmentRevision + 2 },
            { contentArtifactId: artifactId }]) {
            const substituted = { ...bindingStorage, ...change };
            expect(await verify('POST', bindingPath, substituted, substituted, bindingAction, authorization, reviewedChild)).toBeNull();
        }
        const bindingCandidate = { ...candidate, id: bindingArtifactId };
        expect(await verify('POST', '/v1/artifacts', bindingCandidate, bindingCandidate, bindingAction, authorization, reviewedChild)).not.toBeNull();
        expect(await verify('POST', '/v1/artifacts', candidate, candidate, bindingAction, authorization, reviewedChild)).toBeNull();
    });

    it('refuses backup configure outside the Environment owner domain and after the receiver grant is revoked', async () => {
        const f = await fixture('team', 'account', { readableEnvironment: true });
        const actionId = 'deployments.backups.configure';
        const input: DeploymentBackupConfigureInputV1 = { serverId, environmentId: f.environment.id,
            expectedRevision: f.environmentRevision, intent: 'test',
            destinationSetup: { kind: 'anotherMachine', machineId: f.outsider.id,
                expectedInstallationId: f.outsider.installationId, receiverInputs: {} },
            configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' },
                occurrenceId: 'destination', config: { path: '/repository' }, credentialBindings: [],
                sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }],
                ownership: { environmentId: f.environment.id, prefix: 'repository' }, retention: { kind: 'keepEverything' } } };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const mint = () => auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId, accountId: f.account.id,
            authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId, machineId: f.controller.id,
            target, requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
            { input, deploymentNativeAdmission: native });
        // The requester owns this receiver, but the Environment's Team cannot use it.
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.machineTeamGrant.create({ data: { machineId: f.outsider.id, teamId: f.team!.id,
            accessLevel: 'view', createdByAccountId: f.account.id } });
        const root = await mint();
        await db.machine.update({ where: { id: f.controller.id }, data: { operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        let forwarded = 0;
        const dispatch = createExternalActionDaemonDispatcher({ io: createSocketRoomDiscoveryHarness(async () => []),
            forwardRpc: async () => { forwarded += 1; return { ok: false, error: 'daemon_boundary', errorCode: 'daemon_boundary' }; } });
        const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(app => registerExternalActionRoutes(app, { dispatch }), async app => {
            const execute = () => app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: f.controller.id, envelope, executionAuthorization: root } });
            await execute();
            expect(forwarded).toBe(1);
            await db.machineTeamGrant.deleteMany({ where: { machineId: f.outsider.id, teamId: f.team!.id } });
            const refused = await execute();
            expect(refused.json()).toMatchObject({ error: 'credential_scope_denied' });
            expect(forwarded).toBe(1);
        }, { authentication: 'real' });
    });

    it('updates loopback exports on a fresh Environment through signed CLI preparation and Home storage', async () => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: f.environment.projectSourceId, createdByAccountId: f.account.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.controller.id, buildMachineId: f.builder.id,
            contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
        } });
        expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(0);
        const actionId = 'deployments.environments.update';
        const input = getActionSpec(actionId).inputSchema.parse({ serverId, environmentId: environment.id,
            expectedRevision: environment.revision, contentArtifactId: f.environment.contentArtifactId,
            contentHeaderVersion: f.environment.contentHeaderVersion, contentBodyVersion: f.environment.contentBodyVersion,
            patch: { ownServer: { serviceExports: [{ key: 'http', service: 'app', containerPort: 3000,
                scheme: 'http', exposure: 'loopback', transport: { kind: 'iroh' } }] } } });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        await db.machine.update({ where: { id: f.controller.id }, data: { operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const dispatched: { authorization?: ExternalActionExecutionAuthorizationV1 } = {};
        const dispatch = createExternalActionDaemonDispatcher({ io: createSocketRoomDiscoveryHarness(async () => []),
            forwardRpc: async ({ callParams }) => {
                const request = callParams as ExternalActionDaemonDispatchRequest;
                dispatched.authorization = request.executionAuthorization;
                return { ok: true, result: createExternalActionDaemonDispatchResponse(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: { accepted: true } } })) };
            } });
        expect(await dispatch({ actionId, envelope, principal: { accountId: f.account.id,
            authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, authority: 'present_user' } })).toMatchObject({ kind: 'response' });
        const dispatchedRoot = dispatched.authorization;
        if (!dispatchedRoot) throw new Error('Expected public dispatch authorization');
        const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: null };
        const channel = await createRequesterCurrentnessSocketHarness();
        const exchanges: Array<{ method: string; path: string; status: number }> = [];
        try {
            await withAuthenticatedTestApp(app => {
                registerAccountProfileRoute(app); registerAccountSettingsRoutes(app); featuresRoutes(app);
                registerAccountEncryptionRoutes(app); artifactsRoutes(app); registerDeploymentRoutes(app);
                app.addHook('onResponse', async (request, reply) => {
                    exchanges.push({ method: request.method, path: request.url.split('?')[0]!, status: reply.statusCode });
                });
            }, async app => {
                const origin = await app.listen({ host: '127.0.0.1', port: 0 });
                const requester = await admitRequesterAccountActionContext({ authorization: dispatchedRoot, credentials,
                    serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, isCurrent: async () => true });
                if (!requester) throw new Error('Expected admitted requester');
                try {
                    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                        serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin, target,
                        installationId: f.controller.installationId, privateKey: f.controller.keys.secretKey, rootAdmitted: true });
                    if (!authorization?.requesterHttpProjection) throw new Error('Expected signed requester HTTP projection');
                    const native = authorization.binding.deploymentNativeAdmission;
                    if (!isDeploymentEnvironmentUpdateNativeAdmissionV1(native)) throw new Error('Expected admitted update');
                    const body = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
                        contentArtifactId: createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding, environmentId: environment.id }),
                        contentHeaderVersion: 1, contentBodyVersion: 1, patch: {}, authoredInputDigest: native.inputDigest };
                    for (const change of [{ environmentId: f.environment.id }, { expectedRevision: environment.revision + 1 },
                        { patch: { protection: 'production' } }]) {
                        const substituted = { ...body, ...change };
                        const path = `/v1/deployments/environments/${substituted.environmentId}`;
                        const denied = await app.inject({ method: 'PATCH', url: path, payload: substituted,
                            headers: { ...currentAccountStoredContentCompatibilityHeaders,
                                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                                    authorizationToken: authorization.token, effectActionId: actionId, target,
                                    installationId: f.controller.installationId, requestId: authorization.binding.requestId,
                                    method: 'PATCH', path, body: substituted, privateKey: f.controller.keys.secretKey }) } });
                        expect(denied.statusCode, denied.body).toBe(401);
                    }
                    const foreign = await fixture();
                    await expect(auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                        accountId: foreign.account.id, authentication: { kind: 'account', tokenEpoch: foreign.account.tokenEpoch },
                        actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input }))
                        .rejects.toMatchObject({ code: 'credential_scope_denied' });
                    const deps = createDaemonDeploymentActionDeps({ credentials, serverId, serverHttpBaseUrl: origin,
                        machineId: f.controller.id,
                        resolveRequesterIdentity: async context => {
                            const owner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => serverId,
                                resolveHostIdentity: async () => ({ machineId: f.controller.id,
                                    installationId: f.controller.installationId, custodianAccountId: f.account.id }) });
                            const requester = await owner.resolveActionRequester!(context);
                            try { return requester.identity; } finally { await requester.dispose(); }
                        },
                        runtime: { acquire: async () => { throw new Error('Update cannot acquire a deployment'); } } });
                    const result = await deps.deploymentAction!(actionId, input, { authority: 'present_user', externalActionExecutionAuthorization: authorization });
                    expect(result, JSON.stringify({ exchanges, result, role: dispatchedRoot.binding.admittedMachineRole })).toMatchObject({ ok: true, revision: environment.revision + 1 });
                    const stored = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } });
                    expect(stored.contentArtifactId).not.toBe(input.contentArtifactId);
                } finally { await requester.dispose(); }
            }, { authentication: 'real' });
        } finally { await channel.close(); }
    });

    it.each((['plain', 'e2ee'] as const).flatMap(mode => [
        { mode, policy: 'ingress', patch: { ingress: { kind: 'cloudflareTunnel' as const } } },
        { mode, policy: 'release', patch: { ownServer: { rollout: 'startFirst' as const,
            autoRestorePreviousRelease: false }, retainPreviousDeployments: 0 } },
    ]))('publishes only the signed $mode $policy candidate and retains the reviewed update CAS through real HTTP', async ({ mode, patch }) => {
        const f = await fixture('team', 'account', { contentMode: mode, readableEnvironment: true, separateControllerCustodian: true });
        // Environment content edits retain the definition writer's existing
        // Machine Manage requirement, including on a separate custodian host.
        await db.machineTeamGrant.updateMany({ where: { machineId: f.controller.id, teamId: f.team!.id },
            data: { accessLevel: 'admin' } });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const actionId = 'deployments.environments.update';
        const input = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: f.environment.contentHeaderVersion,
            contentBodyVersion: f.environment.contentBodyVersion, patch };
        const requestId = crypto.randomUUID();
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, requestId, target }, input,
            material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input };
        const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
            { input: mode === 'e2ee' ? native : input, deploymentNativeAdmission: native });
        expect(authorization.binding.deploymentCandidatePublication).toBeUndefined();
        const admitted = authorization.binding.deploymentNativeAdmission;
        if (!isDeploymentEnvironmentUpdateNativeAdmissionV1(admitted)) throw new Error('Ingress admission missing');
        const artifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding, environmentId: admitted.environmentId });
        const dataKey = nacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, dataKey)));
        const content = { ...createDeploymentEnvironmentDetailV1().content, ...patch };
        const createBody = ArtifactJsonCreateHttpInputV1Schema.parse({ id: artifactId, kind: 'v1:other:deployment-environment.v1',
            header: await seal({ kind: 'deployment-environment.v1', title: content.name }), body: await seal({ body: JSON.stringify(content) }),
            dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
                : privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                    recipientPublicKey: f.accountKeys.publicKey, randomBytes: nacl.randomBytes })) });
        const headers = (method: string, path: string, body?: unknown, active = authorization) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: active.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: active.token,
                effectActionId: actionId, target, installationId: f.controller.installationId, requestId: active.binding.requestId,
                method, path, body, privateKey: f.controller.keys.secretKey }),
        });
        await withAuthenticatedTestApp(async app => { artifactsRoutes(app); registerDeploymentRoutes(app); }, async app => {
            for (const change of [{ id: crypto.randomUUID() }, { kind: 'v1:other:deployment-domain.v1' }, { approvalState: 'open' }]) {
                const body = ArtifactJsonCreateHttpInputV1Schema.parse({ ...createBody, ...change });
                const denied = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: body,
                    headers: headers('POST', '/v1/artifacts', body) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: createBody,
                headers: headers('POST', '/v1/artifacts', createBody) });
            expect(created.statusCode, created.body).toBe(200);
            const grant = { artifactId, principal: { kind: 'team' as const, teamId: f.team!.id }, accessLevel: 'admin' };
            const grantPath = `/v1/artifacts/${artifactId}/access/grants`;
            expect((await app.inject({ method: 'PUT', url: grantPath, payload: grant,
                headers: headers('PUT', grantPath, grant) })).statusCode).toBe(200);
            const body = { ...input, contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
                authoredInputDigest: admitted.inputDigest };
            const path = `/v1/deployments/environments/${input.environmentId}`;
            for (const change of [{ expectedRevision: input.expectedRevision + 1 }, { patch: { ingress: null } },
                { contentArtifactId: crypto.randomUUID() }, { authoredInputDigest: 'z'.repeat(43) }]) {
                const substituted = { ...body, ...change };
                const denied = await app.inject({ method: 'PATCH', url: path, payload: substituted,
                    headers: headers('PATCH', path, substituted) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            const result = await app.inject({ method: 'PATCH', url: path, payload: body, headers: headers('PATCH', path, body) });
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ ok: true, revision: input.expectedRevision + 1 });
            const preparedInput = { ...input, expectedRevision: input.expectedRevision + 1,
                contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
            const preparedRequestId = crypto.randomUUID();
            const preparedEnvelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
                accountId: f.account.id, authentication, actionId, requestId: preparedRequestId, target }, input: preparedInput,
                material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
                : { v: 1 as const, requestId: preparedRequestId, target, input: preparedInput };
            const preparedNative = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: preparedEnvelope });
            const preparedAuthorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId: preparedRequestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(preparedEnvelope) },
                { input: mode === 'e2ee' ? preparedNative : preparedInput, deploymentNativeAdmission: preparedNative });
            const changedPatch = { ...preparedInput, patch: { ingress: null } };
            expect((await app.inject({ method: 'PATCH', url: path, payload: changedPatch,
                headers: headers('PATCH', path, changedPatch, preparedAuthorization) })).statusCode).toBe(401);
            const preparedResult = await app.inject({ method: 'PATCH', url: path, payload: preparedInput,
                headers: headers('PATCH', path, preparedInput, preparedAuthorization) });
            expect(preparedResult.statusCode, preparedResult.body).toBe(200);
            const { patch: _ingress, ...ordinaryInput } = { ...preparedInput, expectedRevision: input.expectedRevision + 2 };
            const ordinaryRequestId = crypto.randomUUID();
            const ordinaryEnvelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
                accountId: f.account.id, authentication, actionId, requestId: ordinaryRequestId, target }, input: ordinaryInput,
                material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
                : { v: 1 as const, requestId: ordinaryRequestId, target, input: ordinaryInput };
            const ordinaryAuthorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId: ordinaryRequestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ordinaryEnvelope) }, { input: ordinaryInput });
            const unreviewedIngress = { ...ordinaryInput, patch };
            const unreviewed = await app.inject({ method: 'PATCH', url: path, payload: unreviewedIngress,
                headers: headers('PATCH', path, unreviewedIngress, ordinaryAuthorization) });
            expect(unreviewed.statusCode, unreviewed.body).toBe(401);
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('publishes and admits only the signed %s authored Domain candidate through real HTTP', async mode => {
        const f = await fixture('team', 'account', { contentMode: mode, separateControllerCustodian: true });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const actionId = 'deployments.domains.add';
        const content = DeploymentDomainContentV1Schema.parse({ hostname: 'authored.example.test',
            target: { service: 'app', containerPort: 3000 }, healthCheck: { path: '/', expectStatus: 200 } });
        const input = { serverId, environmentId: f.environment.id, domainId: crypto.randomUUID(),
            expectedRevision: f.environmentRevision, targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
            requestKey: crypto.randomUUID(), content };
        const requestId = crypto.randomUUID();
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, requestId, target }, input,
            material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input };
        const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
            { input: mode === 'e2ee' ? native : input, deploymentNativeAdmission: native });
        const admitted = authorization.binding.deploymentNativeAdmission;
        if (!admitted || !('kind' in admitted) || admitted.kind !== 'domain') throw new Error('Domain admission missing');
        const artifactId = createDeploymentDomainContentArtifactIdV1({ ...authorization.binding, deploymentNativeAdmission: admitted });
        const dataKey = nacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, dataKey)));
        const createBody = ArtifactJsonCreateHttpInputV1Schema.parse({ id: artifactId, kind: 'v1:other:deployment-domain.v1',
            header: await seal({ kind: 'deployment-domain.v1', title: '' }), body: await seal({ body: JSON.stringify(content) }),
            dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
                : privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                    recipientPublicKey: f.accountKeys.publicKey, randomBytes: nacl.randomBytes })) });
        const headers = (method: string, path: string, body?: unknown) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: actionId, target, installationId: f.controller.installationId, requestId,
                method, path, body, privateKey: f.controller.keys.secretKey }),
        });
        await withAuthenticatedTestApp(async app => { artifactsRoutes(app); registerDeploymentRoutes(app); machinesRoutes(app); }, async app => {
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: createBody,
                headers: headers('POST', '/v1/artifacts', createBody) });
            expect(created.statusCode, created.body).toBe(200);
            for (const change of [{ id: crypto.randomUUID() }, { kind: 'v1:other:deployment-environment.v1' }, { approvalState: 'open' }]) {
                const body = ArtifactJsonCreateHttpInputV1Schema.parse({ ...createBody, ...change });
                const denied = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: body,
                    headers: headers('POST', '/v1/artifacts', body) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            const grant = { artifactId, principal: { kind: 'team' as const, teamId: f.team!.id }, accessLevel: 'admin' };
            const grantPath = `/v1/artifacts/${artifactId}/access/grants`;
            const granted = await app.inject({ method: 'PUT', url: grantPath, payload: grant,
                headers: headers('PUT', grantPath, grant) });
            expect(granted.statusCode, granted.body).toBe(200);
            const wrongGrant = { ...grant, principal: { kind: 'account', accountId: f.member.accountId } };
            const deniedGrant = await app.inject({ method: 'PUT', url: grantPath, payload: wrongGrant,
                headers: headers('PUT', grantPath, wrongGrant) });
            expect(deniedGrant.statusCode, deniedGrant.body).toBe(401);
            const readPath = `/v1/artifacts/${artifactId}`;
            const read = await app.inject({ method: 'GET', url: readPath, headers: headers('GET', readPath) });
            expect(read.statusCode, read.body).toBe(200);
            expect(ArtifactHttpReadV1Schema.parse(read.json())).toMatchObject({ ownerAccountId: f.account.id,
                encryptionMode: mode, body: createBody.body });
            const update = ArtifactJsonUpdateHttpInputV1Schema.parse({ expectedBodyVersion: 1, body: createBody.body });
            const deniedUpdate = await app.inject({ method: 'POST', url: readPath, payload: update,
                headers: headers('POST', readPath, update) });
            expect(deniedUpdate.statusCode, deniedUpdate.body).toBe(401);
            const { content: _privateContent, ...metadata } = input;
            const discovery = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId,
                input: { ...metadata, contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                machineId: f.member.id, installationId: f.member.installationId });
            const rpcMethod = `${f.member.id}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
            const rpcRequestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(discovery);
            const packet = { method: rpcMethod, requestId: rpcRequestId, params: discovery, originalActionEnvelope: envelope,
                externalActionExecution: { v: 1 as const, authorization, effectActionId: actionId, target,
                    installationId: f.controller.installationId, deploymentChildRouting,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: f.controller.installationId,
                        method: rpcMethod, requestId: rpcRequestId, params: discovery, deploymentChildRouting,
                        privateKey: f.controller.keys.secretKey }) } };
            const machinePath = `/v1/machines/${f.member.id}`;
            const machineRead = await app.inject({ method: 'GET', url: machinePath, headers: {
                ...headers('GET', machinePath),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.member.installationId, requestId,
                    deploymentChildExecution: packet, method: 'GET', path: machinePath, body: undefined,
                    privateKey: f.member.keys.secretKey }),
            } });
            expect(machineRead.statusCode, machineRead.body).toBe(200);
            const body = { ...metadata, contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
                authoredInputDigest: admitted.inputDigest, requestId, actionOperationId: crypto.randomUUID(),
                placements: [{ machineId: f.member.id, installationId: f.member.installationId,
                    nativeServer: 'private', dockerEngineId: 'domain-engine', listener: 'privateOrigin' }] };
            const path = `/v1/deployments/environments/${input.environmentId}/domains`;
            for (const change of [{ authoredInputDigest: 'z'.repeat(43) }, { contentArtifactId: crypto.randomUUID() },
                { requestKey: crypto.randomUUID() }, { expectedRevision: input.expectedRevision + 1 }, { domainId: crypto.randomUUID() }]) {
                const substituted = { ...body, ...change };
                const denied = await app.inject({ method: 'POST', url: path, payload: substituted,
                    headers: headers('POST', path, substituted) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            const result = await app.inject({ method: 'POST', url: path, payload: body, headers: headers('POST', path, body) });
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ ok: true, domain: { id: input.domainId, contentArtifactId: artifactId } });
            // Native preparation reopens the captured Environment's existing
            // content; publication of this root's Domain candidate is complete.
            const environmentContent = `/v1/artifacts/${f.environment.contentArtifactId}`;
            const reopened = await app.inject({ method: 'GET', url: environmentContent,
                headers: headers('GET', environmentContent) });
            expect(reopened.statusCode, reopened.body).toBe(200);
            const environmentGrants = `${environmentContent}/access/grants`;
            const foreignGrant = { ...grant, artifactId: f.environment.contentArtifactId };
            const foreignWrite = await app.inject({ method: 'PUT', url: environmentGrants, payload: foreignGrant,
                headers: headers('PUT', environmentGrants, foreignGrant) });
            expect(foreignWrite.statusCode, foreignWrite.body).toBe(401);
            const unrelatedAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
            const unrelated = await createArtifact({ actorUserId: unrelatedAccount.id, artifactId: crypto.randomUUID(),
                kind: 'v1:other:deployment-domain.v1',
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-domain.v1', title: 'Private' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!unrelated.ok) throw new Error(unrelated.error);
            const unrelatedContent = `/v1/artifacts/${unrelated.artifact.id}`;
            const unreadable = await app.inject({ method: 'GET', url: unrelatedContent,
                headers: headers('GET', unrelatedContent) });
            expect(unreadable.statusCode, unreadable.body).toBe(404);
            expect(unreadable.json()).toMatchObject({ error: 'Artifact not found' });
        }, { authentication: 'real' });
    });

    it.each(['account', 'api'] as const)('publishes a reviewed authored Domain after the template Deploy receipt without reopening deploy preparation with the %s credential', async credential => {
        const f = await fixture('account', credential, { templateRoot: true });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded' } });
        const actionId = 'deployments.domains.add';
        const target = f.originalActionEnvelope.target;
        const content = DeploymentDomainContentV1Schema.parse({ hostname: 'template.example.test',
            target: { service: 'app', containerPort: 3000 } });
        const input = { serverId, environmentId: f.environment.id, domainId: crypto.randomUUID(),
            expectedRevision: f.environmentRevision, targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
            requestKey: crypto.randomUUID(), content };
        const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId,
            envelope: { v: 1, requestId: f.authorization.binding.requestId, target, input } });
        if (!isDeploymentDomainNativeAdmissionV1(native)) throw new Error('Domain projection missing');
        const reviewedChild = { actionId, role: 'template.domain:web',
            inputDigest: computeActionInputApprovalDigestV1(actionId, input), deploymentNativeAdmission: native };
        const artifactId = createDeploymentDomainContentArtifactIdV1({ ...f.authorization.binding,
            deploymentNativeAdmission: native, reviewedChild });
        const body = ArtifactJsonCreateHttpInputV1Schema.parse({ id: artifactId, kind: 'v1:other:deployment-domain.v1',
            header: encodePlainArtifactStoredContent({ kind: 'deployment-domain.v1', title: content.hostname }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
        const headers = (method: string, path: string, value?: unknown, child: ReviewedActionChildHttpProofV1 | null = reviewedChild) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            ...createExternalActionAuthorizedRequestHeaders({ authorization: f.authorization,
                effectActionId: child?.actionId ?? f.authorization.binding.actionId, target,
                installationId: f.controller.installationId, method, path, body: value,
                ...(child ? { reviewedChild: child } : {}), privateKey: f.controller.keys.secretKey }),
        });
        await withAuthenticatedTestApp(async app => { await artifactsRoutes(app); await registerDeploymentRoutes(app);
            await registerAccountEncryptionRoutes(app); await machinesRoutes(app); }, async app => {
            // Domain add reads its Environment and private input before publishing the authored content.
            // The reviewed port retains the Domain effect on these reads under the settled template receipt.
            const environmentPath = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`;
            const environmentHeaders = headers('GET', environmentPath);
            const permissionReads: string[] = [];
            const stopReads = observeSqliteRequests({ before: query => {
                if (query.model && ['TeamMembership', 'ProjectSource', 'ApiToken', 'MachineTeamGrant', 'MachineAccountGrant'].includes(query.model))
                    permissionReads.push(query.model);
            } });
            try {
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: f.authorization.token,
                    effectActionId: actionId, encodedTarget: environmentHeaders[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER],
                    machineSignature: environmentHeaders[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], reviewedChild,
                    method: 'GET', path: environmentPath, body: undefined, routeInput: { serverId, environmentId: f.environment.id } })).not.toBeNull();
            } finally { stopReads(); }
            expect(permissionReads).toEqual([]);
            const environment = await app.inject({ method: 'GET', url: environmentPath, headers: environmentHeaders });
            expect(environment.statusCode, environment.body).toBe(200);
            const currentnessPath = '/v1/account/encryption/currentness';
            const currentness = await app.inject({ method: 'GET', url: currentnessPath,
                headers: headers('GET', currentnessPath) });
            expect(currentness.statusCode, currentness.body).toBe(200);
            for (const reference of [f.environment, f.link]) {
                const path = `/v1/artifacts/${reference.contentArtifactId}`;
                const opened = await app.inject({ method: 'GET', url: path, headers: headers('GET', path) });
                expect(opened.statusCode, opened.body).toBe(200);
            }
            const foreignEnvironmentPath = `/v1/deployments/environments/${crypto.randomUUID()}?serverId=${serverId}`;
            const foreignEnvironment = await app.inject({ method: 'GET', url: foreignEnvironmentPath,
                headers: headers('GET', foreignEnvironmentPath) });
            expect(foreignEnvironment.statusCode, foreignEnvironment.body).toBe(401);
            const substitutedInput = { ...input, environmentId: crypto.randomUUID() };
            const substitutedNative = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId,
                envelope: { v: 1, requestId: f.authorization.binding.requestId, target, input: substitutedInput } });
            if (!isDeploymentDomainNativeAdmissionV1(substitutedNative)) throw new Error('Domain projection missing');
            const substitutedPath = `/v1/deployments/environments/${substitutedInput.environmentId}?serverId=${serverId}`;
            const substitutedEnvironment = await app.inject({ method: 'GET', url: substitutedPath,
                headers: headers('GET', substitutedPath, undefined, { ...reviewedChild,
                    inputDigest: computeActionInputApprovalDigestV1(actionId, substitutedInput), deploymentNativeAdmission: substitutedNative }) });
            expect(substitutedEnvironment.statusCode, substitutedEnvironment.body).toBe(401);
            const wrongRole = await app.inject({ method: 'GET', url: environmentPath,
                headers: headers('GET', environmentPath, undefined, { ...reviewedChild, role: 'template.deploy' }) });
            expect(wrongRole.statusCode, wrongRole.body).toBe(401);
            const changedQueryPath = `${environmentPath}&unreviewed=true`;
            const changedQuery = await app.inject({ method: 'GET', url: changedQueryPath,
                headers: headers('GET', changedQueryPath) });
            expect(changedQuery.statusCode, changedQuery.body).toBe(401);
            const unrelatedAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
            const unrelated = await createArtifact({ actorUserId: unrelatedAccount.id, artifactId: crypto.randomUUID(),
                kind: 'v1:other:deployment-domain.v1',
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-domain.v1', title: 'Private' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!unrelated.ok) throw new Error(unrelated.error);
            const unrelatedPath = `/v1/artifacts/${unrelated.artifact.id}`;
            const unreadable = await app.inject({ method: 'GET', url: unrelatedPath, headers: headers('GET', unrelatedPath) });
            expect(unreadable.statusCode, unreadable.body).toBe(404);
            const rootWrite = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: body,
                headers: headers('POST', '/v1/artifacts', body, null) });
            expect(rootWrite.statusCode, rootWrite.body).toBe(401);
            for (const child of [{ ...reviewedChild, inputDigest: 'z'.repeat(43) },
                { ...reviewedChild, deploymentNativeAdmission: { ...native, inputDigest: 'z'.repeat(43) } },
                { ...reviewedChild, deploymentNativeAdmission: { ...native, environmentId: crypto.randomUUID() } }]) {
                const denied = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: body,
                    headers: headers('POST', '/v1/artifacts', body, child) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: body,
                headers: headers('POST', '/v1/artifacts', body) });
            expect(created.statusCode, created.body).toBe(200);
            const candidatePath = `/v1/artifacts/${artifactId}`;
            const candidate = await app.inject({ method: 'GET', url: candidatePath, headers: headers('GET', candidatePath) });
            expect(candidate.statusCode, candidate.body).toBe(200);
            for (const changed of [{ id: crypto.randomUUID() }, { kind: 'v1:other:deployment-receipt.v1' }]) {
                const rejected = { ...body, ...changed };
                const denied = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: rejected,
                    headers: headers('POST', '/v1/artifacts', rejected) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            const { content: _content, ...metadata } = input;
            const contentReference = { contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
            const childPacket = (params: DeploymentChildRpcV1) => {
                const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
                const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
                const externalActionExecution = { v: 1 as const, authorization: f.authorization, effectActionId: actionId, target,
                    installationId: f.controller.installationId, deploymentChildRouting, reviewedChild,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: f.authorization.token,
                        effectActionId: actionId, target, installationId: f.controller.installationId,
                        method, requestId, params, deploymentChildRouting, reviewedChild, privateKey: f.controller.keys.secretKey }) };
                return { method, requestId, params, originalActionEnvelope: f.originalActionEnvelope, externalActionExecution };
            };
            const verifyChild = (params: DeploymentChildRpcV1) => {
                const packet = childPacket(params);
                return verifyExternalActionMachineRpcExecution(packet.externalActionExecution, packet);
            };
            const discovery = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId,
                input: { ...metadata, ...contentReference }, machineId: f.member.id, installationId: f.member.installationId });
            expect(await verifyChild(discovery)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domainDiscover' } } });
            const admission = { ...metadata, contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
                authoredInputDigest: native.inputDigest, requestId: f.authorization.binding.requestId,
                actionOperationId: crypto.randomUUID(), placements: [{ machineId: f.member.id,
                    installationId: f.member.installationId, nativeServer: 'private', dockerEngineId: 'domain-engine', listener: 'privateOrigin' }] };
            const path = `/v1/deployments/environments/${input.environmentId}/domains`;
            for (const child of [{ ...reviewedChild, role: 'template.deploy' },
                { actionId, role: reviewedChild.role, inputDigest: reviewedChild.inputDigest },
                { ...reviewedChild, deploymentNativeAdmission: { ...native, authoredMetadataDigest: reviewedChild.inputDigest } },
                { ...reviewedChild, deploymentNativeAdmission: { ...native, domainId: crypto.randomUUID() } }]) {
                const denied = await app.inject({ method: 'POST', url: path, payload: admission,
                    headers: headers('POST', path, admission, child) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            for (const change of [{ authoredInputDigest: 'z'.repeat(43) }, { contentArtifactId: crypto.randomUUID() },
                { environmentId: crypto.randomUUID() }, { domainId: crypto.randomUUID() },
                { expectedRevision: input.expectedRevision + 1 }, { requestKey: crypto.randomUUID() }]) {
                const value = { ...admission, ...change };
                const denied = await app.inject({ method: 'POST', url: path, payload: value, headers: headers('POST', path, value) });
                expect(denied.statusCode, denied.body).toBe(401);
            }
            const admitted = await app.inject({ method: 'POST', url: path, payload: admission, headers: headers('POST', path, admission) });
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toMatchObject({ ok: true, domain: { id: input.domainId, contentArtifactId: artifactId } });
            const domain = DeploymentDomainMutationResultV1Schema.parse(admitted.json());
            if (!domain.ok || !domain.domain.placements?.[0]) throw new Error('Expected accepted template Domain capture');
            const nativeJob = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId,
                input: { serverId, environmentId: input.environmentId, domainId: input.domainId },
                machineId: f.member.id, installationId: f.member.installationId,
                expectedDomainRevision: domain.domain.revision, capture: domain.domain.placements[0],
                actionOperationId: admission.actionOperationId });
            expect(await verifyChild(nativeJob)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domain' } } });
            // Store retains the reviewed template child on its requester port.
            // Its signed RPC packet already carries that review for the admitted Domain job.
            const forwardedPacket = childPacket(nativeJob);
            const forwarded = await projectExternalActionRequesterHttpAuthorization({ authorization: f.authorization,
                serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://home.test', target,
                installationId: f.controller.installationId, privateKey: f.controller.keys.secretKey,
                rootAdmitted: true, forwardedDeploymentChild: nativeJob, deploymentChildExecution: forwardedPacket });
            const machinePath = `/v1/machines/${f.member.id}`;
            const forwardedHeaders = await forwarded?.requesterHttpProjection?.createRequestHeaders({
                effectActionId: actionId, method: 'GET', path: machinePath, body: undefined, reviewedChild });
            expect(forwardedHeaders).toBeTruthy();
            const machineRead = await app.inject({ method: 'GET', url: machinePath,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, ...forwardedHeaders } });
            expect(machineRead.statusCode, machineRead.body).toBe(200);
            const childReads: string[] = [];
            const stopChildReads = observeSqliteRequests({ before: query => { if (query.model) childReads.push(query.model); } });
            try {
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: f.authorization.token,
                    effectActionId: actionId, encodedTarget: forwardedHeaders![EXTERNAL_ACTION_RESOLVED_TARGET_HEADER],
                    machineSignature: forwardedHeaders![EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
                    deploymentChildExecution: createDeploymentChildExecutionProofV1(forwardedPacket),
                    method: 'GET', path: machinePath, body: undefined, routeInput: { id: f.member.id } })).not.toBeNull();
            } finally { stopChildReads(); }
            expect(childReads.filter(model => ['Account', 'TeamMembership', 'ProjectSource', 'ApiToken',
                'MachineTeamGrant', 'MachineAccountGrant'].includes(model))).toEqual([]);
            expect(childReads.filter(model => model === 'DeploymentDomain')).toHaveLength(1);
            const unrelatedMachinePath = `/v1/machines/${f.outsider.id}`;
            const unrelatedMachineHeaders = await forwarded?.requesterHttpProjection?.createRequestHeaders({
                effectActionId: actionId, method: 'GET', path: unrelatedMachinePath, body: undefined, reviewedChild });
            const unrelatedMachine = await app.inject({ method: 'GET', url: unrelatedMachinePath,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, ...unrelatedMachineHeaders } });
            expect(unrelatedMachine.statusCode, unrelatedMachine.body).toBe(401);
            const factsPath = `/v1/deployments/environments/${input.environmentId}/secret-launch-admission`;
            const factsBody = { serverId, environmentId: input.environmentId, targetLinkId: input.targetLinkId,
                machineId: f.controller.id, installationId: f.controller.installationId,
                materialization: { kind: 'domain' as const, domainId: input.domainId,
                    expectedDomainRevision: domain.domain.revision, actionOperationId: admission.actionOperationId,
                    capture: domain.domain.placements[0] } };
            const facts = { ...factsBody, proof: signMachineInstallationProof({ privateKey: f.controller.keys.secretKey,
                payload: { version: 1, accountId: f.account.id, machineId: f.controller.id,
                    installationId: f.controller.installationId, deploymentSecretLaunch: {
                        requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(factsBody) } } }) };
            const projected = await app.inject({ method: 'POST', url: factsPath, payload: facts,
                headers: headers('POST', factsPath, facts) });
            expect(projected.statusCode, projected.body).toBe(200);
            expect(EnvironmentSecretLaunchAdmissionResultV1Schema.parse(projected.json())).toMatchObject({ ok: true, grants: [],
                domainAdmission: { actionOperationId: admission.actionOperationId,
                    controller: { machineId: f.controller.id, installationId: f.controller.installationId },
                    target: { machineId: f.member.id, installationId: f.member.installationId } } });

        }, { authentication: 'real' });
    });

    async function admittedDomainChildFixture(mode: 'plain' | 'e2ee') {
        const { f, input, envelope, target, authorization } = await domainRootFixture(mode, false, true);
        const actionOperationId = crypto.randomUUID();
        const created = await inTx(tx => createDeploymentDomainInTx(tx, f.account.id,
            { ...input, actionOperationId, requestId: envelope.requestId }, {}, authorization.binding));
        if (!created.ok || !created.domain.placements?.length) throw new Error('Expected real admitted Domain capture');
        const capture = created.domain.placements[0];
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.add',
            input: { serverId, environmentId: input.environmentId, domainId: input.domainId },
            machineId: f.member.id, installationId: f.member.installationId,
            expectedDomainRevision: created.domain.revision, capture, actionOperationId });
        const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
        const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
        const child = { method, requestId, params: job, originalActionEnvelope: envelope,
            externalActionExecution: { v: 1 as const, authorization, effectActionId: job.actionId, target,
                installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: job.actionId, target, installationId: f.controller.installationId,
                    method, requestId, params: job, deploymentChildRouting, privateKey: f.controller.keys.secretKey }) } };
        expect(await verifyExternalActionMachineRpcExecution(child.externalActionExecution, child))
            .toMatchObject({ binding: { deploymentChildRoot: true }, deploymentChildAdmission: {
                routing: { kind: 'domain' }, domainAdmission: { controller: { machineId: f.controller.id, installationId: f.controller.installationId } },
            } });
        expect(f.member.accountId).not.toBe(f.account.id);
        expect(f.controller.accountId).not.toBe(f.account.id);
        expect(f.controller.id).not.toBe(f.member.id);
        return { f, input, envelope, target, authorization, actionOperationId, created, capture, job, child };
    }

    it.each(['plain', 'e2ee'] as const)('atomically prepares %s Domain content before native dispatch and retains it after failure', async mode => {
        const { f, input, envelope, target, authorization, actionOperationId, created, capture, child } = await admittedDomainChildFixture(mode);
        const original = await readArtifactForCallerInTx(db, { actorAccountId: f.account.id, artifactId: input.contentArtifactId });
        if (!original.ok) throw new Error(original.error);
        const preparedContent = DeploymentDomainContentV1Schema.parse({ hostname: 'app.example.com',
            target: { service: 'app', containerPort: 3000 }, healthCheck: { path: '/health', expectStatus: 200 },
            ingress: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
                credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount',
                    account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'cloudflare-account' } } }],
                config: { hostname: 'app.example.com', controller: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32),
                    tunnel: { kind: 'adopt', tunnelId: '61bc2c65-9253-4917-8f74-05587547bfa2', name: 'created-tunnel' },
                    owned: [{ hostname: 'app.example.com', expectedService: 'http://app:3000' }],
                    dnsOwnership: [{ hostname: 'app.example.com', recordId: 'c'.repeat(32) }],
                    connector: { imageRef: 'docker.io/cloudflare/cloudflared:2025.4.0', version: '2025.4.0' },
                } } } });
        const prepared = { body: JSON.stringify(preparedContent) };
        const bytes = mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(prepared))
            : new Uint8Array(await sealSessionDataKeyBundleV0(prepared, f.artifactKeys.get(input.contentArtifactId)!));
        const payload = { serverId, environmentId: input.environmentId, domainId: input.domainId,
            expectedDomainRevision: created.domain.revision, actionOperationId, capture,
            contentUpdate: { body: privacyKit.encodeBase64(bytes), expectedBodyVersion: capture.content.contentBodyVersion } };
        const path = `/v1/deployments/environments/${input.environmentId}/domains/${input.domainId}/prepared-content`;
        const open = async (value: Uint8Array) => {
            if (mode === 'plain') return decodePlainArtifactStoredContent(privacyKit.encodeBase64(new Uint8Array(value)));
            const opened = await openSessionDataKeyBundleV0(value, f.artifactKeys.get(input.contentArtifactId)!);
            if (opened.status !== 'authenticated') throw new Error(opened.status);
            return opened.value;
        };
        const acquire = async (reference: typeof capture.content) => {
            const read = await readArtifactForCallerInTx(db, { actorAccountId: f.account.id, artifactId: reference.contentArtifactId,
                admittedContent: { requesterAccountId: f.account.id, content: reference } });
            if (!read.ok) throw new Error(read.error);
            if (!read.artifact.body) throw new Error('Expected prepared Domain body');
            const artifact = read.artifact;
            const opened = readDeploymentDomainArtifactV1(reference, { artifactId: artifact.id,
                revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
                header: ArtifactHeaderMetadataV1Schema.parse(await open(artifact.header)),
                body: ArtifactBodyEnvelopeV1Schema.parse(await open(read.artifact.body)).body });
            if (!opened.ok) throw new Error(opened.error);
            return opened.content;
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = (body: Record<string, unknown> = payload, privateKey = f.controller.keys.secretKey) => app.inject({ method: 'POST', url: path,
                payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'deployments.domains.add', target, installationId: f.controller.installationId,
                        requestId: authorization.binding.requestId, method: 'POST', path, body, privateKey }),
                } });
            const staleRevision = await send({ ...payload, expectedDomainRevision: payload.expectedDomainRevision + 1 });
            expect(staleRevision.statusCode).toBe(409);
            expect(staleRevision.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            expect((await send(payload, f.outsider.keys.secretKey)).statusCode).toBe(401);
            expect((await send({ ...payload, contentUpdate: { ...payload.contentUpdate, header: payload.contentUpdate.body } })).statusCode).toBe(401);
            const bearer = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await app.inject({ method: 'POST', url: path, payload, headers: { authorization: `Bearer ${bearer}` } })).statusCode).toBe(403);
            expect((await send({ ...payload, contentUpdate: { ...payload.contentUpdate, expectedBodyVersion: 999 } })).statusCode).toBe(409);
            expect((await db.artifact.findUniqueOrThrow({ where: { id: input.contentArtifactId } })).bodyVersion).toBe(1);
            const preparedQueries: { model?: string; action: string }[] = [];
            const stopPreparedQueries = observeSqliteRequests({ before: request => {
                preparedQueries.push({ model: request.model, action: request.action });
            } });
            const response = await send().finally(stopPreparedQueries);
            expect(response.statusCode, response.body).toBe(200);
            expect(preparedQueries.filter(query => query.model === 'DeploymentDomain' && query.action === 'findFirst')).toHaveLength(1);
            const result = DeploymentDomainMutationResultV1Schema.parse(response.json());
            if (!result.ok || !result.domain.placements?.length) throw new Error('Expected prepared Domain capture');
            const refreshed = result.domain.placements[0]!;
            expect(result).toMatchObject({ ok: true, revision: created.revision, domain: {
                revision: created.domain.revision, state: 'pending', contentArtifactId: input.contentArtifactId, contentBodyVersion: 2 } });
            expect(refreshed).toEqual({ ...capture, content: { ...capture.content, contentBodyVersion: 2 } });
            expect(capture.content.contentBodyVersion).toBe(1);
            const artifact = await db.artifact.findUniqueOrThrow({ where: { id: input.contentArtifactId } });
            expect(artifact.bodyVersion).toBe(2);
            expect(artifact.headerVersion).toBe(capture.content.contentHeaderVersion);
            const current = await readArtifactForCallerInTx(db, { actorAccountId: f.account.id, artifactId: input.contentArtifactId });
            if (!current.ok) throw new Error(current.error);
            expect(current.artifact.body).toEqual(bytes);
            const retained = await readArtifactForCallerInTx(db, { actorAccountId: f.account.id, artifactId: input.contentArtifactId,
                admittedContent: { requesterAccountId: f.account.id, content: capture.content } });
            if (!retained.ok) throw new Error(retained.error);
            expect(retained.artifact.bodyVersion).toBe(capture.content.contentBodyVersion);
            expect(retained.artifact.body).toEqual(original.artifact.body);
            const staleCapture = await send();
            expect(staleCapture.statusCode).toBe(409);
            expect(staleCapture.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            expect((await db.artifact.findUniqueOrThrow({ where: { id: input.contentArtifactId } })).bodyVersion).toBe(2);
            expect(await verifyExternalActionMachineRpcExecution(child.externalActionExecution, child)).toBeNull();
            const refreshedJob = { ...child.params, capture: refreshed };
            const refreshedRouting = projectDeploymentChildRoutingV1(refreshedJob);
            const refreshedChild = { ...child, params: refreshedJob, externalActionExecution: { ...child.externalActionExecution,
                deploymentChildRouting: refreshedRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.domains.add', target, installationId: f.controller.installationId,
                    method: child.method, requestId: child.requestId, params: refreshedJob, deploymentChildRouting: refreshedRouting,
                    privateKey: f.controller.keys.secretKey }),
            } };
            expect(await verifyExternalActionMachineRpcExecution(refreshedChild.externalActionExecution, refreshedChild))
                .toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domain' } } });
            const replay = await inTx(tx => createDeploymentDomainInTx(tx, f.account.id,
                { ...input, actionOperationId, requestId: envelope.requestId }, {}, authorization.binding));
            expect(replay).toEqual(result);
            const observation = { capture: refreshed, state: 'failed' as const };
            const transition = { serverId, environmentId: input.environmentId, domainId: input.domainId,
                expectedDomainRevision: result.domain.revision, observations: [{ ...observation,
                    proof: signMachineInstallationProof({ privateKey: f.member.keys.secretKey,
                        payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: result.domain.revision, observation }) }) }] };
            const transitionPath = path.replace('/prepared-content', '/transitions');
            const failed = await app.inject({ method: 'POST', url: transitionPath, payload: transition, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.domains.add', target, installationId: f.controller.installationId,
                    requestId: authorization.binding.requestId, method: 'POST', path: transitionPath, body: transition,
                    privateKey: f.controller.keys.secretKey }),
            } });
            expect(failed.statusCode, failed.body).toBe(200);
            const settled = DeploymentDomainMutationResultV1Schema.parse(failed.json());
            if (!settled.ok) throw new Error(settled.error);
            expect(settled.domain).toMatchObject({ state: 'failed', contentBodyVersion: 2 });
            const retry = await inTx(tx => createDeploymentDomainInTx(tx, f.account.id,
                { ...input, actionOperationId, requestId: envelope.requestId }, {}, authorization.binding));
            expect(retry).toEqual(settled);
            if (!retry.ok) throw new Error(retry.error);
            const retryBody = await readArtifactForCallerInTx(db, { actorAccountId: f.account.id, artifactId: retry.domain.contentArtifactId,
                admittedContent: { requesterAccountId: f.account.id, content: retry.domain } });
            if (!retryBody.ok) throw new Error(retryBody.error);
            expect(retryBody.artifact.body).toEqual(bytes);
            expect(await acquire(retry.domain)).toEqual(preparedContent);
            const removing = await inTx(tx => removeDeploymentDomainInTx(tx, f.account.id, {
                serverId, environmentId: input.environmentId, domainId: input.domainId, expectedRevision: settled.revision,
                expectedDomainRevision: settled.domain.revision, requestKey: crypto.randomUUID(), requestId: crypto.randomUUID(),
                actionOperationId: crypto.randomUUID(),
            }));
            expect(removing).toMatchObject({ ok: true, domain: { contentBodyVersion: 2,
                placements: [{ desired: false, content: refreshed.content }] } });
            if (!removing.ok) throw new Error(removing.error);
            const removeBody = await readArtifactForCallerInTx(db, { actorAccountId: f.account.id, artifactId: removing.domain.contentArtifactId,
                admittedContent: { requesterAccountId: f.account.id, content: removing.domain } });
            if (!removeBody.ok) throw new Error(removeBody.error);
            expect(removeBody.artifact.body).toEqual(bytes);
            expect(await acquire(removing.domain)).toEqual(preparedContent);
        }, { authentication: 'real' });
    });

    it('refuses a removal-job binding for prepared Domain content without mutating custody', async () => {
        const { f, input, target, created } = await admittedDomainChildFixture('plain');
        const removeInput = { serverId, environmentId: input.environmentId, domainId: input.domainId,
            expectedRevision: created.revision, expectedDomainRevision: created.domain.revision, requestKey: crypto.randomUUID() };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: removeInput };
        const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({
            actionId: 'deployments.domains.remove', envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.domains.remove', machineId: f.controller.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: removeInput, deploymentNativeAdmission });
        const actionOperationId = crypto.randomUUID();
        const removing = await inTx(tx => removeDeploymentDomainInTx(tx, f.account.id,
            { ...removeInput, requestId: envelope.requestId, actionOperationId }, {}, authorization.binding));
        if (!removing.ok || !removing.domain.placements?.length) throw new Error('Expected admitted removing Domain');
        expect(removing.domain.state).toBe('removing');
        const payload = { serverId, environmentId: input.environmentId, domainId: input.domainId,
            expectedDomainRevision: removing.domain.revision, actionOperationId, capture: removing.domain.placements[0]!,
            contentUpdate: { expectedBodyVersion: removing.domain.contentBodyVersion,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ tunnelId: 'must-not-write' }) }) } };
        const before = await db.artifact.findUniqueOrThrow({ where: { id: input.contentArtifactId } });
        expect(await inTx(tx => prepareDeploymentDomainContentInTx(tx, f.account.id, payload, authorization.binding)))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        const path = `/v1/deployments/environments/${input.environmentId}/domains/${input.domainId}/prepared-content`;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: path, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.remove',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.domains.remove', target, installationId: f.controller.installationId,
                    requestId: envelope.requestId, method: 'POST', path, body: payload, privateKey: f.controller.keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(401);
        }, { authentication: 'real' });
        expect(await db.artifact.findUniqueOrThrow({ where: { id: input.contentArtifactId } })).toEqual(before);
        expect((await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } })).contentBodyVersion)
            .toBe(removing.domain.contentBodyVersion);
    });

    it('refreshes every desired prepared operand without rewriting predecessor custody', async () => {
        const { f, input, authorization, actionOperationId, created, capture } = await admittedDomainChildFixture('plain');
        const row = await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } });
        const stored = DeploymentDomainCapturedPlacementsV1Schema.parse(row.capturedPlacements)[0]!;
        const sibling = { ...stored, placement: { ...stored.placement, nativeServer: 'sibling-private' } };
        const predecessor = { ...stored, desired: false, placement: { ...stored.placement, nativeServer: 'predecessor-private' } };
        await db.deploymentDomain.update({ where: { id: row.id }, data: { capturedPlacements: [stored, sibling, predecessor] } });
        const result = await inTx(tx => prepareDeploymentDomainContentInTx(tx, f.account.id, {
            serverId, environmentId: input.environmentId, domainId: input.domainId, expectedDomainRevision: created.domain.revision,
            actionOperationId, capture, contentUpdate: { expectedBodyVersion: 1,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ tunnelId: 'prepared-tunnel' }) }) },
        }, authorization.binding));
        expect(result).toMatchObject({ ok: true, domain: { placements: [
            { desired: true, content: { contentHeaderVersion: 1, contentBodyVersion: 2 } },
            { desired: true, content: { contentHeaderVersion: 1, contentBodyVersion: 2 } },
            { desired: false, content: { contentHeaderVersion: 1, contentBodyVersion: 1 } },
        ] } });
        const changed = await db.deploymentDomain.findUniqueOrThrow({ where: { id: row.id } });
        const captures = DeploymentDomainCapturedPlacementsV1Schema.parse(changed.capturedPlacements);
        expect(captures[2]).toEqual(predecessor);
        expect(captures.slice(0, 2)).toEqual([stored, sibling].map(item => ({ ...item, content: { ...item.content, contentBodyVersion: 2 } })));
    });

    it.each([['plain', 'controller'], ['e2ee', 'controller'], ['plain', 'child'], ['e2ee', 'child']] as const)('projects exact admitted %s Domain controller and target facts through the %s signature without a credential use', async (mode, carrier) => {
        const { f, input, target, authorization, actionOperationId, created, capture, job, child } = await admittedDomainChildFixture(mode);
        const path = `/v1/deployments/environments/${input.environmentId}/secret-launch-admission`;
        const body = { serverId, environmentId: input.environmentId, targetLinkId: input.targetLinkId,
            machineId: f.controller.id, installationId: f.controller.installationId,
            materialization: { kind: 'domain' as const, domainId: input.domainId,
                expectedDomainRevision: created.domain.revision, actionOperationId, capture } };
        const signed = (unsigned = body) => ({ ...unsigned,
            proof: signMachineInstallationProof({ privateKey: f.controller.keys.secretKey, payload: { version: 1,
                accountId: f.account.id, machineId: unsigned.machineId, installationId: unsigned.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(unsigned) } } }) });
        const decodedChild = carrier === 'child' ? decodeDeploymentChildExecutionV1(encodeDeploymentChildExecutionV1(child), authorization.token) : null;
        if (carrier === 'child') {
            if (!decodedChild) throw new Error('Expected canonical compact Domain child');
            expect(await verifyExternalActionMachineRpcExecution(decodedChild.externalActionExecution, {
                method: decodedChild.method, requestId: decodedChild.requestId,
                paramsPresent: decodedChild.paramsPresent, paramsDigest: decodedChild.paramsDigest,
            })).toMatchObject({ binding: { deploymentChildRoot: true }, deploymentChildAdmission: {
                domainAdmission: { controller: { machineId: f.controller.id, installationId: f.controller.installationId } },
            } });
        }
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = (unsigned = body, privateKey = f.controller.keys.secretKey) => {
                const payload = signed(unsigned);
                const signature = signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: job.actionId, target, installationId: f.controller.installationId,
                    requestId: authorization.binding.requestId, method: 'POST', path, body: payload,
                    ...(carrier === 'child' ? { deploymentChildExecution: child } : {}), privateKey });
                if (decodedChild && unsigned === body && privateKey === f.controller.keys.secretKey) {
                    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: job.actionId, target, installationId: f.controller.installationId,
                        requestId: authorization.binding.requestId, method: 'POST', path, body: payload,
                        deploymentChildExecution: decodedChild, publicKey: f.controller.keys.publicKey, signature })).toBe(true);
                }
                return app.inject({ method: 'POST', url: path, payload, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: job.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    ...(carrier === 'child' ? { [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(child) } : {}),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signature,
                } });
            };
            const requests: string[] = [];
            let controllerKeyReads = 0;
            const stop = observeSqliteRequests({ before: query => {
                if (query.model) requests.push(query.model);
                if (query.model !== 'Machine' || !query.args || typeof query.args !== 'object') return;
                const where: unknown = Reflect.get(query.args, 'where');
                if (where && typeof where === 'object' && Reflect.get(where, 'id') === f.controller.id) controllerKeyReads += 1;
            } });
            const response = await send().finally(stop);
            expect(response.statusCode, response.body).toBe(200);
            expect(EnvironmentSecretLaunchAdmissionResultV1Schema.parse(response.json())).toEqual({ ok: true, grants: [],
                domainAdmission: { actionOperationId,
                    controller: { machineId: f.controller.id, installationId: f.controller.installationId,
                        publicKey: encodeBase64(f.controller.keys.publicKey, 'base64url') },
                    target: { machineId: f.member.id, installationId: f.member.installationId,
                        publicKey: encodeBase64(f.member.keys.publicKey, 'base64url') } } });
            expect(requests.filter(model => model === 'DeploymentDomain')).toHaveLength(1);
            expect(controllerKeyReads).toBe(1);
            expect(requests.filter(model => ['ProjectSource', 'TeamMembership', 'MachineAccessGrant', 'MachineTeamGrant'].includes(model)))
                .toEqual([]);
            expect((await send(body, f.outsider.keys.secretKey)).statusCode).toBe(401);
            expect((await send({ ...body, materialization: { ...body.materialization, domainId: crypto.randomUUID() } })).statusCode).toBe(401);
            expect((await send({ ...body, materialization: { ...body.materialization, capture: { ...capture,
                placement: { ...capture.placement, machineId: f.outsider.id } } } })).statusCode).toBe(401);
            expect((await send({ ...body, materialization: { ...body.materialization, actionOperationId: crypto.randomUUID() } })).statusCode).toBe(401);
            expect((await send({ ...body, materialization: { ...body.materialization,
                expectedDomainRevision: body.materialization.expectedDomainRevision + 1 } })).statusCode).toBe(401);
            expect((await send({ ...body, machineId: f.outsider.id, installationId: f.outsider.installationId })).statusCode).toBe(401);
            await db.deploymentDomain.update({ where: { id: input.domainId }, data: { state: 'active' } });
            expect((await send()).statusCode).toBe(401);
            await db.deploymentDomain.update({ where: { id: input.domainId }, data: { state: 'pending', deletedAt: new Date() } });
            expect((await send()).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('writes only the admitted %s Domain connector destination without re-admitting target Manage', async mode => {
        const { f, input, target, authorization, job, child, created } = await admittedDomainChildFixture(mode);
        const grant = { v: 1 as const, kind: 'connectorToken' as const, machineId: f.member.id,
            installationId: f.member.installationId, provider: { kind: 'builtin' as const, id: 'cloudflareNamed' },
            connectorId: crypto.randomUUID(), sealedContent: 'target-installation-ciphertext-not-a-plaintext-token' };
        const { sealedContent: _sealedContent, ...subject } = grant;
        const signed = (destination = subject, signerAccountId = f.account.id, operation: 'set' | 'read' | 'remove' = 'set',
            signer = operation === 'read' ? f.member : f.controller) => {
            const common = { serverId, hostMachineId: signer.id,
                hostInstallationId: signer.installationId, subject: destination };
            const body: MachineConnectorSecretGrantBodyV1 = operation === 'set'
                ? { ...common, operation, grant: { ...grant, ...destination } } : { ...common, operation };
            return MachineConnectorSecretGrantInputV1Schema.parse({ ...body,
                proof: signMachineInstallationProof({ payload: { version: 1, accountId: signerAccountId,
                    machineId: signer.id, installationId: signer.installationId,
                    deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                    privateKey: signer.keys.secretKey }) });
        };
        const path = (machineId: string) => `/v1/deployments/machines/${machineId}/connector-secret-grant`;
        // Direct callers still need Manage even when their installed signature is valid.
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const denied = await app.inject({ method: 'POST', url: path(subject.machineId), payload: signed(subject, f.controller.accountId),
                headers: { 'x-test-user-id': f.controller.accountId } });
            expect(denied.statusCode, denied.body).toBe(403);
            expect(await db.machineSecretGrant.count({ where: { machineId: f.member.id, environmentId: null } })).toBe(0);
        });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = async (destination = subject, operation: 'set' | 'read' | 'remove' = 'set',
                execution: Readonly<{ target: typeof target; authorization: typeof authorization;
                    job: DeploymentChildRpcV1; child: Parameters<typeof encodeDeploymentChildExecutionV1>[0] }> = { target, authorization, job, child }, includeChild = true,
                signer = operation === 'read' ? f.member : f.controller) => {
                const payload = signed(destination, f.account.id, operation, signer), url = path(destination.machineId);
                return app.inject({ method: 'POST', url, payload, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: execution.authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: execution.job.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(execution.target),
                    ...(includeChild ? { [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(execution.child) } : {}),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: execution.authorization.token,
                        effectActionId: execution.job.actionId, target: execution.target, installationId: signer.installationId,
                        requestId: execution.authorization.binding.requestId, method: 'POST', path: url, body: payload,
                        ...(includeChild ? { deploymentChildExecution: execution.child } : {}), privateKey: signer.keys.secretKey }),
                } });
            };
            const foreign = await send({ ...subject, machineId: f.outsider.id, installationId: f.outsider.installationId });
            expect(foreign.statusCode, foreign.body).toBe(401);
            expect(foreign.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'deployment_child_http' });
            expect(await db.machineSecretGrant.count({ where: { machineId: f.outsider.id, environmentId: null } })).toBe(0);
            expect((await send(subject, 'remove')).statusCode).toBe(401);
            expect((await send(subject, 'read', undefined, true, f.controller)).statusCode).toBe(401);
            expect((await send(subject, 'set', undefined, false)).statusCode).toBe(401);
            const requests: string[] = [];
            const stop = observeSqliteRequests({ before: query => { if (query.model) requests.push(query.model); } });
            const written = await send().finally(stop);
            expect.soft(written.statusCode, written.body).toBe(200);
            expect.soft(written.json()).toEqual({ ok: true, grant });
            expect.soft(await db.machineSecretGrant.count({ where: { machineId: f.member.id, environmentId: null } })).toBe(1);
            expect.soft(requests.filter(model => model === 'DeploymentDomain')).toHaveLength(1);
            expect.soft(requests.filter(model => ['ProjectSource', 'TeamMembership', 'MachineAccessGrant', 'MachineTeamGrant'].includes(model)))
                .toEqual([]);
            const readAdded = await send(subject, 'read');
            expect.soft(readAdded.statusCode, readAdded.body).toBe(200);
            expect.soft(readAdded.json()).toEqual({ ok: true, grant });
            const removalInput = { serverId, environmentId: input.environmentId, domainId: input.domainId,
                expectedRevision: created.revision, expectedDomainRevision: created.domain.revision, requestKey: crypto.randomUUID() };
            const removalRequestId = crypto.randomUUID(), removalOperationId = crypto.randomUUID();
            const removalEnvelope = { v: 1 as const, requestId: removalRequestId, target, input: removalInput };
            const removalAuthorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
                actionId: 'deployments.domains.remove', machineId: f.controller.id, target, requestId: removalRequestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(removalEnvelope) }, { input: removalInput });
            const removing = await inTx(tx => removeDeploymentDomainInTx(tx, f.account.id,
                { ...removalInput, requestId: removalRequestId, actionOperationId: removalOperationId }, {}, removalAuthorization.binding));
            expect(removing).toMatchObject({ ok: true, domain: { state: 'removing' } });
            if (!removing.ok || !removing.domain.placements?.length) throw new Error('Expected real admitted Domain removal');
            const removalJob = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.remove',
                input: { serverId, environmentId: input.environmentId, domainId: input.domainId },
                machineId: f.member.id, installationId: f.member.installationId, expectedDomainRevision: removing.domain.revision,
                capture: removing.domain.placements[0], actionOperationId: removalOperationId });
            const removalRouting = projectDeploymentChildRoutingV1(removalJob);
            const method = `${removalJob.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const removalChild = { method, requestId, params: removalJob, originalActionEnvelope: removalEnvelope,
                externalActionExecution: { v: 1 as const, authorization: removalAuthorization, effectActionId: removalJob.actionId, target,
                    installationId: f.controller.installationId, deploymentChildRouting: removalRouting,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: removalAuthorization.token,
                        effectActionId: removalJob.actionId, target, installationId: f.controller.installationId,
                        method, requestId, params: removalJob, deploymentChildRouting: removalRouting, privateKey: f.controller.keys.secretKey }) } };
            expect(await verifyExternalActionMachineRpcExecution(removalChild.externalActionExecution, removalChild))
                .toMatchObject({ deploymentChildAdmission: { domainJob: { execution: { actionId: 'deployments.domains.remove' } } } });
            const removal = { target, authorization: removalAuthorization, job: removalJob, child: removalChild };
            const factsBody = { serverId, environmentId: input.environmentId, targetLinkId: input.targetLinkId,
                machineId: f.controller.id, installationId: f.controller.installationId,
                materialization: { kind: 'domain' as const, domainId: input.domainId,
                    expectedDomainRevision: removing.domain.revision, actionOperationId: removalOperationId,
                    capture: removing.domain.placements[0] } };
            const factsPayload = { ...factsBody, proof: signMachineInstallationProof({ privateKey: f.controller.keys.secretKey,
                payload: { version: 1, accountId: f.account.id, machineId: f.controller.id, installationId: f.controller.installationId,
                    deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(factsBody) } } }) };
            const factsPath = `/v1/deployments/environments/${input.environmentId}/secret-launch-admission`;
            let factsControllerKeyReads = 0, factsDomainReads = 0;
            const stopFacts = observeSqliteRequests({ before: query => {
                if (query.model === 'DeploymentDomain') factsDomainReads += 1;
                if (query.model !== 'Machine' || !query.args || typeof query.args !== 'object') return;
                const where: unknown = Reflect.get(query.args, 'where');
                if (where && typeof where === 'object' && Reflect.get(where, 'id') === f.controller.id) factsControllerKeyReads += 1;
            } });
            const facts = await app.inject({ method: 'POST', url: factsPath, payload: factsPayload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: removalAuthorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: removalJob.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(removalChild),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: removalAuthorization.token,
                    effectActionId: removalJob.actionId, target, installationId: f.controller.installationId,
                    requestId: removalAuthorization.binding.requestId, method: 'POST', path: factsPath, body: factsPayload,
                    deploymentChildExecution: removalChild, privateKey: f.controller.keys.secretKey }),
            } }).finally(stopFacts);
            expect.soft(facts.statusCode, facts.body).toBe(200);
            expect.soft(facts.json()).toEqual({ ok: true, grants: [], domainAdmission: { actionOperationId: removalOperationId,
                controller: { machineId: f.controller.id, installationId: f.controller.installationId,
                    publicKey: encodeBase64(f.controller.keys.publicKey, 'base64url') },
                target: { machineId: f.member.id, installationId: f.member.installationId,
                    publicKey: encodeBase64(f.member.keys.publicKey, 'base64url') } } });
            expect(factsControllerKeyReads).toBe(1);
            expect(factsDomainReads).toBe(1);
            expect((await send(subject, 'set', removal)).statusCode).toBe(401);
            expect((await send(subject, 'remove', removal, false)).statusCode).toBe(401);
            expect((await send({ ...subject, machineId: f.outsider.id, installationId: f.outsider.installationId }, 'remove', removal)).statusCode).toBe(401);
            const readRemoving = await send(subject, 'read', removal);
            expect.soft(readRemoving.statusCode, readRemoving.body).toBe(200);
            expect.soft(readRemoving.json()).toEqual({ ok: true, grant });
            const removed = await send(subject, 'remove', removal);
            expect.soft(removed.statusCode, removed.body).toBe(200);
            expect.soft(removed.json()).toEqual({ ok: true });
            expect.soft(await db.machineSecretGrant.count({ where: { machineId: f.member.id, environmentId: null } })).toBe(0);
            // Completion/withdrawal expires the admitted job at the NEXT request, not during its write.
            await db.deploymentDomain.update({ where: { id: input.domainId }, data: { state: 'active' } });
            const completed = await send(subject, 'remove', removal);
            expect(completed.statusCode, completed.body).toBe(401);
            await db.deploymentDomain.update({ where: { id: input.domainId }, data: { state: 'pending', deletedAt: new Date() } });
            const withdrawn = await send(subject, 'remove', removal);
            expect(withdrawn.statusCode, withdrawn.body).toBe(401);
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('admits draft DNS %s only for the selected Link installation without retained Domain writes', async mode => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, separateContentOwner: true, contentMode: mode });
        const actionId = 'deployments.domains.verify';
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { mode: 'preview' as const, serverId, environmentId: f.environment.id,
            targetLinkId: f.link.id, expectedRevision: f.environmentRevision, expectedTargetLinkRevision: f.link.revision,
            requestKey: crypto.randomUUID(), content: { hostname: 'private-preview.test', target: { service: 'web', containerPort: 8080 } } };
        const requestId = crypto.randomUUID();
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding: { serverIdentityId: serverId, accountId: f.account.id, authentication, actionId, requestId, target }, input,
            material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input };
        const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, {
                input: mode === 'e2ee' ? deploymentNativeAdmission : input, deploymentNativeAdmission });
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDns', actionId, input,
            machineId: f.member.id, installationId: f.member.installationId });
        const packet = (params: DeploymentChildRpcV1 = job) => {
            const method = params.machineId + ':' + RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, childRequestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            return { method, requestId: childRequestId, params, originalActionEnvelope: envelope, externalActionExecution: {
                v: 1 as const, authorization, effectActionId: actionId, target, installationId: f.controller.installationId,
                deploymentChildRouting, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId, method, requestId: childRequestId,
                    params, deploymentChildRouting, privateKey: f.controller.keys.secretKey }) } };
        };
        const verify = async (params = job) => { const p = packet(params); return verifyExternalActionMachineRpcExecution(p.externalActionExecution, p); };
        const writes: string[] = [];
        const stop = observeSqliteRequests({ before: event => {
            if ((event.model === 'DeploymentDomain' || event.model === 'Artifact') && event.action !== 'findUnique'
                && event.action !== 'findFirst' && event.action !== 'findMany' && event.action !== 'count') writes.push(event.action);
        } });
        try {
            expect(await verify()).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domainDns' } } });
            expect(await verify({ ...job, machineId: f.outsider.id, installationId: f.outsider.installationId })).toBeNull();
            expect(await verify({ ...job, installationId: crypto.randomUUID() })).toBeNull();
            expect(await verify(DeploymentChildRpcV1Schema.parse({ ...job, input: { ...input, requestKey: 'another-preview' } }))).toBeNull();
            expect(await verify(DeploymentChildRpcV1Schema.parse({ ...job, input: { ...input, expectedTargetLinkRevision: input.expectedTargetLinkRevision + 1 } }))).toBeNull();
            const projected = projectDeploymentChildRoutingV1(job);
            expect(JSON.stringify(projected)).not.toContain('private-preview.test');
            const source = packet();
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const path = '/v1/machines/' + f.member.id;
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: f.controller.installationId, requestId,
                        method: 'GET', path, body: undefined, deploymentChildExecution: source, privateKey: f.controller.keys.secretKey }),
                } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ machine: { id: f.member.id, installationId: f.member.installationId } });
                await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
                    data: { status: 'suspended' } });
                const continuation = await app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: f.member.installationId, requestId,
                        method: 'GET', path, body: undefined, deploymentChildExecution: source, privateKey: f.member.keys.secretKey }),
                } });
                expect(continuation.statusCode, continuation.body).toBe(200);
                expect(await verify()).toBeNull();
            }, { authentication: 'real' });
        } finally { stop(); }
        expect(writes).toEqual([]);
    });

    it.each([
        ['plain', 'domainDiscover'], ['e2ee', 'domainDiscover'],
        ['plain', 'domain'], ['e2ee', 'domain'],
    ] as const)('reads the prepared %s %s Machine through real HTTP authentication', async (mode, kind) => {
        const { f, input, envelope, target, authorization } = await domainRootFixture(mode);
        const actionOperationId = crypto.randomUUID();
        const created = kind === 'domain' ? await inTx(tx => createDeploymentDomainInTx(tx, f.account.id,
            { ...input, actionOperationId, requestId: envelope.requestId }, {}, authorization.binding)) : null;
        if (created && !created.ok) throw new Error(created.error);
        const job = DeploymentChildRpcV1Schema.parse(kind === 'domainDiscover'
            ? { v: 1, kind, actionId: 'deployments.domains.add', input,
                machineId: f.member.id, installationId: f.member.installationId }
            : { v: 1, kind, actionId: 'deployments.domains.add',
                input: { serverId, environmentId: input.environmentId, domainId: input.domainId },
                machineId: f.member.id, installationId: f.member.installationId,
                expectedDomainRevision: created?.ok ? created.domain.revision : undefined,
                capture: created?.ok ? created.domain.placements?.[0] : undefined, actionOperationId });
        const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
        const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
        const source = { method, requestId, params: job, originalActionEnvelope: envelope, externalActionExecution: {
            v: 1 as const, authorization, effectActionId: job.actionId, target,
            installationId: f.controller.installationId, deploymentChildRouting,
            machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                effectActionId: job.actionId, target, installationId: f.controller.installationId,
                method, requestId, params: job, deploymentChildRouting, privateKey: f.controller.keys.secretKey }),
        } };
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const path = `/v1/machines/${f.member.id}`;
            const requester = kind === 'domain' ? f.member : f.controller;
            const response = await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: job.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: job.actionId, target, installationId: requester.installationId,
                    requestId: authorization.binding.requestId, method: 'GET', path, body: undefined,
                    deploymentChildExecution: source, privateKey: requester.keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ machine: { id: f.member.id, installationId: f.member.installationId } });
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('admits exact retained %s Domain remove discovery through real Home authentication', async mode => {
        const { f, input, target, created } = await admittedDomainChildFixture(mode);
        const actionId = 'deployments.domains.remove';
        const rootInput = { serverId, environmentId: input.environmentId, domainId: input.domainId,
            expectedRevision: created.revision, expectedDomainRevision: created.domain.revision, requestKey: crypto.randomUUID() };
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const requestId = crypto.randomUUID();
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, requestId, target }, input: rootInput,
            material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input: rootInput };
        const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, {
                input: mode === 'e2ee' ? deploymentNativeAdmission : rootInput, deploymentNativeAdmission });
        const operand = { ...rootInput, contentArtifactId: created.domain.contentArtifactId,
            contentHeaderVersion: created.domain.contentHeaderVersion, contentBodyVersion: created.domain.contentBodyVersion,
            targetLinkId: input.targetLinkId, expectedTargetLinkRevision: input.expectedTargetLinkRevision };
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId, input: operand,
            machineId: f.member.id, installationId: f.member.installationId });
        const packet = (params: DeploymentChildRpcV1 = job) => {
            const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, childRequestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            return { method, requestId: childRequestId, params, originalActionEnvelope: envelope, externalActionExecution: {
                v: 1 as const, authorization, effectActionId: actionId, target,
                installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId, method,
                    requestId: childRequestId, params, deploymentChildRouting, privateKey: f.controller.keys.secretKey }) } };
        };
        const verify = async (params = job) => { const p = packet(params); return verifyExternalActionMachineRpcExecution(p.externalActionExecution, p); };
        expect(await verify()).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domainDiscover', actionId } } });
        const foreignContent = await f.content('deployment-domain.v1');
        for (const changed of [{ ...operand, ...foreignContent }, { ...operand, contentBodyVersion: operand.contentBodyVersion + 1 },
            { ...operand, expectedDomainRevision: operand.expectedDomainRevision + 1 },
            { ...operand, targetLinkId: crypto.randomUUID() }, { ...operand, environmentId: crypto.randomUUID() }]) {
            expect(await verify(DeploymentChildRpcV1Schema.parse({ ...job, input: changed }))).toBeNull();
        }
        expect(await verify({ ...job, machineId: f.outsider.id, installationId: f.outsider.installationId })).toBeNull();
        const source = packet();
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const path = `/v1/machines/${f.member.id}`;
            const response = await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId,
                    requestId, method: 'GET', path, body: undefined, deploymentChildExecution: source,
                    privateKey: f.controller.keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ machine: { id: f.member.id, installationId: f.member.installationId } });
        }, { authentication: 'real' });
        await db.deploymentDomain.update({ where: { id: input.domainId }, data: { deletedAt: new Date() } });
        expect(await verify()).toBeNull();
    });

    it.each(['plain', 'e2ee'] as const)('continues only the captured %s Domain job through Home and target installation admission after requester departure', async mode => {
        const { f, input, envelope, target, authorization } = await domainRootFixture(mode);
        const actionOperationId = crypto.randomUUID();
        const discovery = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add',
            input, machineId: f.member.id, installationId: f.member.installationId });
        expect(await isCurrentDeploymentChildInTx(db, authorization.binding, projectDeploymentChildRoutingV1(discovery))).toBe(true);
        expect(await isCurrentDeploymentChildInTx(db, authorization.binding, projectDeploymentChildRoutingV1({ ...discovery,
            machineId: f.outsider.id, installationId: f.outsider.installationId }))).toBe(false);
        const created = await inTx(tx => createDeploymentDomainInTx(tx, f.account.id,
            { ...input, actionOperationId, requestId: envelope.requestId }, {}, authorization.binding));
        if (!created.ok) throw new Error(created.error);
        const capture = created.domain.placements?.[0];
        if (!capture) throw new Error('Expected native Domain capture');
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.add',
            input: { serverId, environmentId: input.environmentId, domainId: input.domainId }, machineId: f.member.id,
            installationId: f.member.installationId, expectedDomainRevision: created.domain.revision, capture, actionOperationId });
        const packet = (params: DeploymentChildRpcV1 = job, root = authorization, originalActionEnvelope: ExternalActionRequestEnvelope = envelope) => {
            const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            return { method, requestId, params, originalActionEnvelope, externalActionExecution: {
                v: 1 as const, authorization: root, effectActionId: params.actionId, target,
                installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                    effectActionId: params.actionId, target, installationId: f.controller.installationId,
                    method, requestId, params, deploymentChildRouting, privateKey: f.controller.keys.secretKey }) } };
        };
        const verify = async (params: DeploymentChildRpcV1 = job) => { const p = packet(params);
            return verifyExternalActionMachineRpcExecution(p.externalActionExecution, p); };
        expect(await verify()).toMatchObject({ effectActionId: 'deployments.domains.add' });
        if (job.kind !== 'domain') throw new Error('Expected Domain child');
        const secretBody = EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ serverId, environmentId: input.environmentId,
            targetLinkId: input.targetLinkId, machineId: f.member.id, installationId: f.member.installationId,
            materialization: { kind: 'domain', domainId: input.domainId, expectedDomainRevision: job.expectedDomainRevision,
                actionOperationId, capture, use: { purpose: 'domainCredential', domainId: input.domainId, role: 'basicAuth',
                    source: { kind: 'secret', ref: 'happier:shared-secret:v1:domain-secret', resourceRevision: 1 } } } });
        const secretInput = { ...secretBody, proof: signMachineInstallationProof({ payload: { version: 1,
            accountId: f.account.id, machineId: f.member.id, installationId: f.member.installationId,
            deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(secretBody) } },
            privateKey: f.member.keys.secretKey }) };
        const secretPurpose = { method: 'POST', path: `/v1/deployments/environments/${input.environmentId}/secret-launch-admission`, body: secretInput };
        expect(await isDeploymentChildHttpPurposeInTx(db, projectDeploymentChildRoutingV1(job), secretPurpose)).toBe(true);
        for (const actionId of ['deployments.domains.remove', 'deployments.domains.verify'] as const) {
            expect(await isDeploymentChildHttpPurposeInTx(db, projectDeploymentChildRoutingV1({ ...job, actionId }), secretPurpose)).toBe(false);
        }
        expect(await isDeploymentChildHttpPurposeInTx(db, projectDeploymentChildRoutingV1({ ...job,
            capture: { ...capture, desired: false } }), secretPurpose)).toBe(false);
        expect(await isDeploymentChildHttpPurposeInTx(db, projectDeploymentChildRoutingV1(job), { ...secretPurpose,
            body: { ...secretInput, installationId: f.outsider.installationId } })).toBe(false);
        expect(await isDeploymentChildHttpPurposeInTx(db, projectDeploymentChildRoutingV1(job), { ...secretPurpose,
            body: { ...secretInput, materialization: { ...secretBody.materialization, expectedDomainRevision: job.expectedDomainRevision + 1 } } })).toBe(false);
        const secretPacket = packet();
        const secretChildProof = projectDeploymentChildExecutionProofV1(secretPacket);
        expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
            effectActionId: job.actionId, encodedTarget: encodeExternalActionResolvedTargetV1(target), ...secretPurpose,
            deploymentChildExecution: secretChildProof,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: job.actionId, target, installationId: f.member.installationId, requestId: authorization.binding.requestId,
                ...secretPurpose, deploymentChildExecution: secretPacket, privateKey: f.member.keys.secretKey }) }))
            .toMatchObject({ deploymentChildRouting: { kind: 'domain' } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const queries: { model?: string; action: string }[] = [];
            const stop = observeSqliteRequests({ before: request => { queries.push({ model: request.model, action: request.action }); } });
            try {
                const response = await app.inject({ method: 'POST', url: secretPurpose.path, payload: secretInput, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: job.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(secretPacket),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: job.actionId, target, installationId: f.member.installationId, requestId: authorization.binding.requestId,
                        ...secretPurpose, deploymentChildExecution: secretPacket, privateKey: f.member.keys.secretKey }),
                } });
                // This fixture has no credential grant; the real secret owner must
                // settle its typed missing result after one admitted-job read.
                expect(response.statusCode, response.body).toBe(404);
                expect(response.json()).toMatchObject({ ok: false, error: 'secret_missing' });
            } finally { stop(); }
            expect(queries.filter(query => query.model === 'DeploymentDomain')).toEqual([{ model: 'DeploymentDomain', action: 'findFirst' }]);
        }, { authentication: 'real' });
        expect(await verify({ ...job, expectedDomainRevision: job.expectedDomainRevision + 1 })).toBeNull();
        const foreignCapture = { ...capture, placement: { ...capture.placement, nativeServer: 'foreign' } };
        expect(await verify({ ...job, capture: foreignCapture })).toBeNull();
        const foreignEnvelope = { ...envelope, requestId: crypto.randomUUID() };
        const foreignRoot = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.domains.add', machineId: f.controller.id, target, requestId: foreignEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(foreignEnvelope) }, { input });
        const foreignPacket = packet(job, foreignRoot, foreignEnvelope);
        expect(await verifyExternalActionMachineRpcExecution(foreignPacket.externalActionExecution, foreignPacket)).toBeNull();
        const changedEnvelope = { ...envelope, input: { ...input, requestKey: crypto.randomUUID() } };
        const changedRoot = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.domains.add', machineId: f.controller.id, target, requestId: changedEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(changedEnvelope) }, { input: changedEnvelope.input });
        const changedPacket = packet(job, changedRoot, changedEnvelope);
        expect(await verifyExternalActionMachineRpcExecution(changedPacket.externalActionExecution, changedPacket)).toBeNull();
        const verifyInput = { serverId, environmentId: input.environmentId, domainId: input.domainId,
            expectedRevision: created.revision, expectedDomainRevision: created.domain.revision, requestKey: crypto.randomUUID() };
        const verifyEnvelope = { ...envelope, requestId: crypto.randomUUID(), input: verifyInput };
        const verifyRoot = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.domains.verify', machineId: f.controller.id, target, requestId: verifyEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(verifyEnvelope) }, { input: verifyInput });
        const { actionOperationId: _acceptedOperation, ...readJob } = job;
        const verifyJob = DeploymentChildRpcV1Schema.parse({ ...readJob, actionId: 'deployments.domains.verify' });
        const verification = packet(verifyJob, verifyRoot, verifyEnvelope);
        expect(await verifyExternalActionMachineRpcExecution(verification.externalActionExecution, verification))
            .toMatchObject({ effectActionId: 'deployments.domains.verify' });
        const metadataInput = { serverId, environmentId: input.environmentId, domainId: input.domainId };
        const metadataSpec = getActionSpec('deployments.domains.get');
        if (!metadataSpec.serverTransport) throw new Error('Expected Domain metadata transport');
        const metadataTransport = bindHomeDomainHttpRequestV1({ transport: metadataSpec.serverTransport,
            inputSchema: metadataSpec.inputSchema, input: metadataInput });
        const verifyChildProof = projectDeploymentChildExecutionProofV1(verification);
        expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: verifyRoot.token,
            effectActionId: 'deployments.domains.get', encodedTarget: encodeExternalActionResolvedTargetV1(target),
            method: 'GET', path: metadataTransport.path, body: undefined, routeInput: metadataInput,
            deploymentChildExecution: verifyChildProof,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: verifyRoot.token,
                effectActionId: 'deployments.domains.get', target, installationId: f.member.installationId,
                requestId: verifyRoot.binding.requestId, method: 'GET', path: metadataTransport.path, body: undefined,
                deploymentChildExecution: verification, privateKey: f.member.keys.secretKey }) }))
            .toMatchObject({ effectActionId: 'deployments.domains.get' });
        const artifactRequest = (artifactId: string) => {
            const source = packet();
            const path = `/v1/artifacts/${artifactId}`;
            return { method: 'GET' as const, url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: job.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: job.actionId, target, installationId: f.member.installationId, requestId: authorization.binding.requestId,
                    method: 'GET', path, body: undefined, deploymentChildExecution: source, privateKey: f.member.keys.secretKey }),
            } };
        };
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject(artifactRequest(capture.content.contentArtifactId));
            expect(response.statusCode, response.body).toBe(200);
        }, { authentication: 'real' });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.member.accountId } },
            data: { role: 'owner' } });
        expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
            .toMatchObject({ ok: true });
        await db.account.update({ where: { id: f.account.id }, data: { tokenEpoch: { increment: 1 } } });
        const queries: { model?: string; action: string }[] = [];
        const stop = observeSqliteRequests({ before: request => { queries.push({ model: request.model, action: request.action }); } });
        try { expect(await verify()).toMatchObject({ effectActionId: 'deployments.domains.add' }); } finally { stop(); }
        expect(queries.filter(query => query.model === 'DeploymentDomain')).toEqual([{ model: 'DeploymentDomain', action: 'findFirst' }]);
        expect(queries.filter(query => ['Account', 'TeamMembership', 'ProjectSource', 'ApiToken'].includes(query.model ?? ''))).toEqual([]);
        expect(await verifyExternalActionMachineRpcExecution(verification.externalActionExecution, verification)).toBeNull();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject(artifactRequest(capture.content.contentArtifactId));
            expect(response.statusCode, response.body).toBe(200);
            const opened = ArtifactHttpReadV1Schema.parse(response.json());
            expect(opened).toMatchObject({ id: capture.content.contentArtifactId });
            for (const reference of [capture.environmentContent, capture.targetLinkContent]) {
                if (!reference) throw new Error('New Domain admission must pin its private context');
                const context = await app.inject(artifactRequest(reference.contentArtifactId));
                expect(context.statusCode, context.body).toBe(200);
                expect(ArtifactHttpReadV1Schema.parse(context.json())).toMatchObject({ id: reference.contentArtifactId,
                    headerVersion: reference.contentHeaderVersion, bodyVersion: reference.contentBodyVersion });
            }
            if (mode === 'e2ee') {
                const envelope = privacyKit.decodeBase64(opened.dataEncryptionKey);
                expect(openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed: f.accountKeys.secretKey }))
                    .toEqual(f.artifactKeys.get(capture.content.contentArtifactId));
                expect(openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed: f.memberContentKeys.secretKey })).toBeNull();
            }
            const unrelated = await f.content('deployment-domain.v1');
            const denied = await app.inject(artifactRequest(unrelated.contentArtifactId));
            expect(denied.statusCode, denied.body).toBe(401);
            expect(denied.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'deployment_child_http' });
            const encode = async (value: unknown) => mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                : new Uint8Array(await sealSessionDataKeyBundleV0(value, f.artifactKeys.get(capture.content.contentArtifactId)!));
            expect(await updateArtifact({ actorUserId: f.member.accountId, artifactId: capture.content.contentArtifactId,
                expectedHeaderVersion: 1, memoryDecisionSource: undefined,
                body: { bytes: await encode({ body: 'newer private body' }), expectedVersion: 1 } }))
                .toMatchObject({ ok: true });
            const retained = await app.inject(artifactRequest(capture.content.contentArtifactId));
            expect(retained.statusCode, retained.body).toBe(200);
            expect(ArtifactHttpReadV1Schema.parse(retained.json())).toMatchObject({ headerVersion: 1, bodyVersion: 1, body: opened.body });
            expect(await updateArtifact({ actorUserId: f.member.accountId, artifactId: capture.content.contentArtifactId,
                expectedHeaderVersion: 1, memoryDecisionSource: undefined,
                header: { bytes: await encode({ kind: 'deployment-domain.v1', title: 'New header' }), expectedVersion: 1 } }))
                .toMatchObject({ ok: true });
            const missingHeader = await app.inject(artifactRequest(capture.content.contentArtifactId));
            expect(missingHeader.statusCode, missingHeader.body).toBe(409);
            expect(missingHeader.json()).toEqual({ error: 'artifact_content_unavailable' });
        }, { authentication: 'real' });
        await withAuthenticatedTestApp(registerMachineAdmissionRoutes, async app => {
            const source = packet();
            const context = { actorAccountId: f.account.id, machineId: f.member.id, installationId: f.member.installationId,
                custodianAccountId: f.member.accountId, role: 'use' as const, encryptionMode: mode };
            const body = { v: 1 as const, context, method: source.method, callerInputAuthorization: authorization,
                workspaceSyncSourceExecution: source };
            const proof = signMachineInstallationProof({ payload: { version: 1, accountId: f.member.accountId,
                machineId: f.member.id, installationId: f.member.installationId, rpcAdmission: {
                    context, method: source.method, callerInputAuthorization: authorization, workspaceSyncSourceExecution: source } },
                privateKey: f.member.keys.secretKey });
            const response = await app.inject({ method: 'POST', url: `/v1/machines/${f.member.id}/admission/verify`,
                headers: { 'x-test-user-id': f.member.accountId }, payload: { ...body, proof } });
            expect(response.statusCode, response.body).toBe(200);
        });
    });

    it.each(['plain', 'e2ee'] as const)('prepares %s first-configuration defaults only from the admitted Environment Source through HTTP', async mode => {
        const f = await fixture('account', 'account', { contentMode: mode, readableEnvironment: true });
        const source = await db.projectSource.findUniqueOrThrow({ where: { id: f.environment.projectSourceId } });
        const content = await f.content('project-deployment-defaults.v1');
        await db.projectDeploymentDefaults.create({ data: { projectSourceId: source.id, revision: 1, ...content } });
        const actionId = 'deployments.environments.update';
        const input = { serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: f.environment.contentHeaderVersion,
            contentBodyVersion: f.environment.contentBodyVersion,
            mode: 'preview' as const, defaultsFor: 'backups' as const };
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const requestId = crypto.randomUUID();
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding: { serverIdentityId: serverId, accountId: f.account.id, authentication, actionId, requestId, target }, input,
            material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input };
        const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
            { input: mode === 'e2ee' ? native : input, deploymentNativeAdmission: native });
        await withAuthenticatedTestApp(app => { projectSourceRoutes(app); artifactsRoutes(app); }, async app => {
            const get = (path: string, effectActionId: string = actionId) => app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId: f.controller.installationId,
                    requestId, method: 'GET', path, privateKey: f.controller.keys.secretKey }),
            } });
            const sourceRead = await get(`/v1/projects/sources/${source.id}?serverId=${serverId}`, 'projects.sources.read');
            expect(sourceRead.statusCode, sourceRead.body).toBe(200);
            const defaults = await get(`/v1/projects/${source.id}/deployment-defaults?serverId=${serverId}`);
            expect(defaults.statusCode, defaults.body).toBe(200);
            expect(defaults.json()).toMatchObject({ ok: true, projectSourceId: source.id, content });
            expect((await get(`/v1/artifacts/${content.contentArtifactId}`)).statusCode).toBe(200);
            // Backup defaults inspect the admitted Environment's own stored definition (6e0d00f1f0a).
            expect((await get(`/v1/artifacts/${f.environment.contentArtifactId}`)).statusCode).toBe(200);
            const foreign = await fixture('account', 'account', { contentMode: mode, readableEnvironment: true });
            expect((await get(`/v1/projects/sources/${foreign.environment.projectSourceId}?serverId=${serverId}`, 'projects.sources.read')).statusCode).toBe(401);
            expect((await get(`/v1/projects/${foreign.environment.projectSourceId}/deployment-defaults?serverId=${serverId}`)).statusCode).toBe(401);
            expect((await get(`/v1/artifacts/${foreign.environment.contentArtifactId}`)).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it.each(['deployments.publish.prepare', 'machines.setup.plan'] as const)(
        'retains admitted defaults reads after Source withdrawal for %s without lending content or unrelated Sources', async actionId => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, separateContentOwner: true });
        const [owner, outsider] = await Promise.all(Array.from({ length: 2 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
        await db.teamMembership.create({ data: { teamId: f.team!.id, accountId: owner.id, role: 'owner' } });
        const source = await db.projectSource.findUniqueOrThrow({ where: { id: f.environment.projectSourceId } });
        const content = await f.content('project-deployment-defaults.v1');
        const artifact = await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: f.account.id,
            accessLevel: 'view', createdByAccountId: artifact.accountId } });
        await db.projectDeploymentDefaults.create({ data: { projectSourceId: source.id, revision: 1, ...content } });
        const input = getActionSpec(actionId).inputSchema.parse(actionId === 'deployments.publish.prepare'
            ? { serverId, machineId: f.controller.id, installationId: f.controller.installationId,
                projectSourceId: source.id, sourceRevision: source.revision, templateRef: f.templateInput.templateRef }
            : { homeId: serverId, machineId: f.controller.id, targets: [{ homeId: serverId, machineId: f.controller.id,
                sources: [{ kind: 'direct', setup: { items: [{ kind: 'app', authoredKey: crypto.randomUUID(),
                    definition: { name: 'Catalog app', project: { kind: 'existing', projectSourceId: source.id },
                        definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] }, bindings: [] } }] } }],
                appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.templates.instantiate', input: f.templateInput }],
            }] });
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target, requestId: envelope.requestId,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const tokens = await Promise.all([owner, f.account, outsider].map(account =>
            auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' })));
        await withAuthenticatedTestApp(app => { projectSourceRoutes(app); artifactsRoutes(app); }, async app => {
            const defaultsPath = `/v1/projects/${source.id}/deployment-defaults?serverId=${serverId}`;
            const artifactPath = `/v1/artifacts/${artifact.id}`;
            const signedGet = (path: string) => app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId,
                    requestId: envelope.requestId, method: 'GET', path, privateKey: f.controller.keys.secretKey }),
            } });
            const ordinaryGet = (token: string) => app.inject({ method: 'GET', url: defaultsPath,
                headers: { authorization: `Bearer ${token}` } });
            expect((await ordinaryGet(tokens[0]!)).statusCode).toBe(200);
            expect((await ordinaryGet(tokens[1]!)).statusCode).toBe(200);
            expect((await ordinaryGet(tokens[2]!)).statusCode).toBe(404);
            expect((await signedGet(defaultsPath)).statusCode).toBe(200);
            expect((await signedGet(artifactPath)).statusCode).toBe(200);
            // Source membership ends for new requests; independent Artifact custody survives this finite admission.
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } },
                data: { status: 'suspended' } });
            expect((await ordinaryGet(tokens[0]!)).statusCode).toBe(200);
            expect((await ordinaryGet(tokens[1]!)).statusCode).toBe(404);
            expect((await ordinaryGet(tokens[2]!)).statusCode).toBe(404);
            expect(await readArtifactForCallerInTx(db, { actorAccountId: f.account.id, artifactId: artifact.id })).toMatchObject({ ok: true });
            const defaults = await signedGet(defaultsPath);
            expect.soft(defaults.statusCode, defaults.body).toBe(200);
            expect.soft(defaults.json()).toMatchObject({ ok: true, projectSourceId: source.id, revision: 1, content });
            const opened = await signedGet(artifactPath);
            expect.soft(opened.statusCode, opened.body).toBe(200);
            const unrelated = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Unrelated defaults', audience: [], repository: { protocol: 'https',
                    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'other/app', cloneUrl: 'https://github.com/other/app.git' } } }));
            if (!unrelated.ok) throw new Error(unrelated.error);
            const unrelatedPath = `/v1/projects/${unrelated.source.id}/deployment-defaults?serverId=${serverId}`;
            expect((await app.inject({ method: 'GET', url: unrelatedPath,
                headers: { authorization: `Bearer ${tokens[1]!}` } })).statusCode).toBe(200);
            expect((await signedGet(unrelatedPath)).statusCode).toBe(401);
            await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: artifact.id, accountId: f.account.id } } });
            expect((await signedGet(artifactPath)).statusCode).toBe(401);
            const unavailable = await signedGet(defaultsPath);
            expect(unavailable.statusCode, unavailable.body).toBe(409);
            expect(unavailable.json()).toEqual({ ok: false, error: 'project_defaults_content_unavailable' });
        }, { authentication: 'real' });
    });

    it('admits only the signed template repository workspace at its own Home', async () => {
        const f = await fixture('account', 'account', { templateRoot: true });
        const actionId = 'deployments.templates.instantiate';
        const { deploy: _deploy, ...templateInput } = f.templateInput;
        const input = getActionSpec(actionId).inputSchema.parse({ ...templateInput, mode: 'preview',
            destination: { kind: 'repositoryPullRequest', workspace: { kind: 'workspace-ref', serverId, id: 'checkout' },
                sourceRevision: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
                baseCommit: 'a'.repeat(40), baseBranch: 'main', branchName: 'add-database', composePath: 'compose.yaml', title: 'Add database' } });
        const binding = { ...f.authorization.binding,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) };
        const key = { kind: 'workspace-ref', serverId, id: 'checkout' } as const;
        const purpose = (body: unknown, routeInput: unknown = body) => inTx(tx => isDeploymentPreparationHttpPurposeInTx(
            tx, binding, actionId, { method: 'POST', path: '/v1/account/project-rows/read', body, routeInput }, {}));
        expect(await purpose({ key })).toBe(true);
        expect(await purpose({ key: { ...key, id: 'foreign-checkout' } })).toBe(false);
        expect(await purpose({ key: { ...key, serverId: 'foreign-home' } })).toBe(false);
        expect(await purpose({ key }, { key: { ...key, id: 'foreign-checkout' } })).toBe(false);
        const stored = { ...binding, deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId,
            { ...input, destination: { kind: 'stored' } }) };
        expect(await inTx(tx => isDeploymentPreparationHttpPurposeInTx(tx, stored, actionId,
            { method: 'POST', path: '/v1/account/project-rows/read', body: { key }, routeInput: { key } }, {}))).toBe(false);
    });

    it.each([
        { withdrawal: 'machine', workflowOrigin: false, templateRoot: true }, { withdrawal: 'team', workflowOrigin: false, templateRoot: true },
        { withdrawal: 'machine', workflowOrigin: true, templateRoot: true }, { withdrawal: 'team', workflowOrigin: true, templateRoot: true },
        { withdrawal: 'team', workflowOrigin: true, templateRoot: false },
    ] as const)('continues admitted preparation after $withdrawal withdrawal before a receipt (Workflow: $workflowOrigin, template: $templateRoot)', async ({ withdrawal, workflowOrigin, templateRoot }) => {
        const f = await fixture('team', 'account', { templateRoot, workflowOrigin });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: f.member.id }, data: { accountId: custodian.id } });
        await db.machineTeamGrant.updateMany({ where: { machineId: f.member.id, teamId: f.team!.id }, data: { accessLevel: 'admin' } });
        const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
        const input = templateRoot ? { ...f.templateInput,
            environment: { ...f.templateInput.environment, expectedRevision: environment.revision }, deploy: { requestKey: crypto.randomUUID() } }
            : { ...f.input, expectedRevision: environment.revision, requestKey: crypto.randomUUID() };
        const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID(), input };
        const actionId = templateRoot ? 'deployments.templates.instantiate' : 'deployments.deploy';
        const mintInput = { serverIdentityId: serverId, accountId: f.account.id,
            authentication: { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target: envelope.target,
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            ...(f.workflowActionOrigin ? { workflowActionOrigin: { ...f.workflowActionOrigin, requestId: envelope.requestId } } : {}),
            ...(templateRoot ? { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) } : {}) };
        const authorization = await auth.mintExternalActionExecutionAuthorization(mintInput, { input });
        expect(await inTx(tx => hasAcceptedDeploymentReceiptInTx(tx, authorization.binding))).toBe(false);
        const proof = { method: 'GET', path: '/v1/account/encryption', routeInput: {} };
        const purpose = () => inTx(tx => isDeploymentPreparationHttpPurposeInTx(tx, authorization.binding,
            mintInput.actionId, proof, {}));
        const relay = { method: 'POST', path: `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${encodeURIComponent(mintInput.actionId)}`,
            body: ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: f.controller.id, envelope,
                executionAuthorization: authorization }) };
        const verify = (request: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>) =>
            verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                effectActionId: mintInput.actionId, encodedTarget: encodeExternalActionResolvedTargetV1(envelope.target), ...request,
                body: request.body,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: mintInput.actionId, target: envelope.target, installationId: f.controller.installationId,
                    requestId: envelope.requestId, method: request.method, path: request.path, body: request.body,
                    privateKey: f.controller.keys.secretKey }) });
        if (templateRoot) expect(await purpose()).toBe(true);
        expect(await verify(relay)).toMatchObject({ binding: { accountId: f.account.id } });
        if (withdrawal === 'machine') await db.machineTeamGrant.deleteMany({
            where: { machineId: f.member.id, teamId: f.team!.id } });
        else await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } }, data: { role: 'member' } });
        await expect(auth.mintExternalActionExecutionAuthorization(mintInput, { input })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        if (templateRoot) {
            // Future controller/link edits have their own revision CAS; the
            // signed preparation keeps its admitted operands until its effect.
            await db.deploymentEnvironment.update({ where: { id: f.environment.id },
                data: { controllerMachineId: f.member.id, revision: { increment: 1 } } });
            await db.deploymentTargetLink.update({ where: { id: f.input.targetLinkId },
                data: { revision: { increment: 1 }, detachedAt: new Date() } });
        }
        if (templateRoot) expect.soft(await purpose()).toBe(true);
        for (const request of templateRoot ? [proof, relay] : [relay]) expect.soft(await verify(request), request.path)
            .toMatchObject({ binding: { accountId: f.account.id, actionId: mintInput.actionId } });
        if (workflowOrigin) {
            const current = () => inTx(tx => hasCurrentDeploymentWorkflowOriginInTx(tx, authorization.binding, undefined, 'execution'));
            expect.soft(await current()).toBe(true);
            for (const state of ['cancelled', 'succeeded'] as const) {
                await db.automationRun.update({ where: { id: f.workflowActionOrigin!.runId }, data: { state } });
                expect(await current(), state).toBe(false);
                expect(await verify(relay), state).toBeNull();
            }
        }
    });

    it.each([false, true])('retains the signed template root for its admitted deploy and native continuation (Workflow: %s)', async workflowOrigin => {
        const f = await fixture('team', 'account', { templateRoot: true, workflowOrigin });
        expect(f.authorization.binding.actionId).toBe('deployments.templates.instantiate');
        expect(f.receipt.operation).toBe('deploy');
        expect(f.receipt.acceptedRequestEnvelopeDigest).toBe(f.authorization.binding.requestEnvelopeDigest);
        expect(await f.verify()).toMatchObject({ binding: { actionId: 'deployments.templates.instantiate' }, effectActionId: 'deployments.deploy' });
        const reviewedChild = f.reviewedChild;
        if (!reviewedChild) throw new Error('Expected the template deploy reviewed child');
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const body = ArtifactReadBatchHttpInputV1Schema.parse({ artifactIds: [f.input.contentArtifactId] });
            const path = '/v1/artifacts/read';
            const machineSignature = signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.controller.installationId,
                requestId: f.authorization.binding.requestId, method: 'POST', path, body, reviewedChild, privateKey: f.controller.keys.secretKey });
            const proof = { authorizationToken: f.authorization.token,
                effectActionId: 'deployments.deploy', encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                method: 'POST', path, body, reviewedChild, machineSignature };
            expect(await inTx(tx => isDeploymentPreparationHttpPurposeInTx(tx, f.authorization.binding,
                proof.effectActionId, proof, {}, undefined, nativeProof => isDeploymentNativeHttpPurpose({
                    binding: f.authorization.binding, effectActionId: proof.effectActionId }, { ...proof, ...nativeProof })))).toBe(false);
            const response = await app.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: machineSignature,
            } });
            expect(response.statusCode, response.body).toBe(401);
            expect(response.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'deployment_publication_purpose' });
        }, { authentication: 'real' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const actionId of ['deployments.receipts.list', 'deployments.environments.get'] as const) {
                const spec = getActionSpec(actionId);
                if (!spec.serverTransport) throw new Error('Deployment preparation reads require their canonical transport');
                for (const [environmentId, status] of [[f.environment.id, 200], [crypto.randomUUID(), 401]] as const) {
                    const input = spec.inputSchema.parse({ serverId, environmentId,
                        ...(actionId === 'deployments.receipts.list' ? { inProgressOnly: true } : {}) });
                    const transport = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input });
                    const response = await app.inject({ method: 'GET', url: transport.path, headers: {
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                        [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                            effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.controller.installationId,
                            requestId: f.authorization.binding.requestId, method: 'GET', path: transport.path, body: undefined,
                            reviewedChild, privateKey: f.controller.keys.secretKey }),
                    } });
                    expect(response.statusCode, `${transport.path}: ${response.body}`).toBe(status);
                }
            }
            for (const actionId of ['deployments.receipts.list', 'deployments.receipts.get'] as const) {
                const spec = getActionSpec(actionId);
                if (!spec.serverTransport) throw new Error('Receipt reads require their canonical transport');
                const input = spec.inputSchema.parse({ serverId,
                    ...(actionId === 'deployments.receipts.get' ? { deploymentId: f.receipt.id } : { environmentId: f.environment.id }) });
                const transport = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input });
                const signature = (path: string) => signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                    effectActionId: actionId, target: f.authorization.binding.target, installationId: f.controller.installationId,
                    requestId: f.authorization.binding.requestId, method: 'GET', path, body: undefined, privateKey: f.controller.keys.secretKey });
                const response = await app.inject({ method: 'GET', url: transport.path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signature(transport.path),
                } });
                expect(response.statusCode, response.body).toBe(200);
                const foreign = { ...input, environmentId: crypto.randomUUID() };
                const foreignTransport = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: foreign });
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: f.authorization.token, effectActionId: actionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target), method: 'GET',
                    path: foreignTransport.path, routeInput: foreign, body: undefined, machineSignature: signature(foreignTransport.path) })).toBeNull();
            }
        }, { authentication: 'real' });
        const current = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
        const prepare: DeploymentChildRpcV1 = { v: 1, kind: 'prepare', actionId: 'deployments.deploy',
            input: { serverId, environmentId: f.environment.id, targetLinkId: f.link.id, requestKey: f.input.requestKey },
            machineId: f.builder.id, installationId: f.builder.installationId,
            expectedRevision: current.revision, expectedTargetLinkRevision: f.link.revision };
        expect(await f.verify(prepare)).not.toBeNull();
        expect(await f.verify({ ...prepare, input: { ...prepare.input, environmentId: crypto.randomUUID() } })).toBeNull();
        await db.teamMembership.deleteMany({ where: { teamId: f.team!.id, accountId: f.account.id } });
        const permissionReads: string[] = [];
        const stop = observeSqliteRequests({ before: request => {
            if (['TeamMembership', 'ProjectSource', 'ApiToken'].includes(request.model ?? '')) permissionReads.push(request.model!);
        } });
        try {
            expect(await f.verify()).toMatchObject({ binding: { actionId: 'deployments.templates.instantiate' } });
            expect(permissionReads).toEqual([]);
        } finally { stop(); }
        expect(await f.verify({ ...f.job, input: { ...f.input, environmentId: crypto.randomUUID() } })).toBeNull();
        expect(await f.verify({ ...f.job, input: { ...f.input, requestKey: crypto.randomUUID() } })).toBeNull();
        const packet = f.rpc();
        const deploymentChildExecution = createDeploymentChildExecutionProofV1(packet);
        for (const path of ['/v1/account/encryption/currentness', `/v1/machines/${f.builder.id}`]) {
            expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: f.authorization.token,
                effectActionId: 'deployments.deploy', encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                method: 'GET', path, body: undefined, deploymentChildExecution,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                    effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.member.installationId,
                    requestId: f.authorization.binding.requestId, method: 'GET', path, body: undefined,
                    deploymentChildExecution: packet, privateKey: f.member.keys.secretKey }) })).not.toBeNull();
        }
        const body = signedStage(f, f.controller, 'running', f.receipt.revision);
        const path = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                    effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.controller.installationId,
                    requestId: f.authorization.binding.requestId, method: 'POST', path, body, privateKey: f.controller.keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
        }, { authentication: 'real' });
    });

    it('logs refused template HTTP and child RPC purposes at warn without request secrets', async () => {
        const f = await fixture('account', 'account', { templateRoot: true });
        const records: Array<Record<string, unknown>> = [];
        // Capture only the output boundary; real Pino filtering and the signed verifier run.
        const stream = (logger as unknown as { [symbols.streamSym]: DestinationStream })[symbols.streamSym];
        const write = vi.spyOn(stream, 'write').mockImplementation(message => { records.push(JSON.parse(message)); });
        const level = logger.level;
        logger.level = 'warn';
        try {
            const path = '/v1/artifacts/read?private=query-secret#fragment-secret';
            const body = { private: 'body-secret' };
            const proof = { authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy',
                encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                method: 'POST', path, body, reviewedChild: f.reviewedChild,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                    effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.controller.installationId,
                    requestId: f.authorization.binding.requestId, method: 'POST', path, body,
                    reviewedChild: f.reviewedChild, privateKey: f.controller.keys.secretKey }) };
            expect(await verifyExternalActionDomainExecutionRequest({ ...proof, machineSignature: 'signature-secret' })).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
            expect(await f.verify({ ...f.job, input: { ...f.input, requestKey: crypto.randomUUID() } })).toBeNull();
            expect(records.filter(record => record.module === 'external-action-authorization-refusal')).toMatchObject([
                { level: 40, phase: 'machine_signature', method: 'POST', path: '/v1/artifacts/read' },
                { level: 40, phase: 'deployment_preparation', method: 'POST', path: '/v1/artifacts/read' },
                { level: 40, phase: 'deployment_child_root_input', rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD },
            ]);
            const output = JSON.stringify(records);
            for (const secret of [f.authorization.token, proof.machineSignature, 'signature-secret', 'query-secret', 'fragment-secret', 'body-secret']) {
                expect(output).not.toContain(secret);
            }
        } finally { logger.level = level; write.mockRestore(); }
    });

    it.each((['plain', 'e2ee'] as const).flatMap(contentMode =>
        (['revision', 'source access'] as const).map(change => ({ contentMode, change }))))(
        'keeps admitted registry reads scoped after selected $change changes ($contentMode)', async ({ change, contentMode }) => {
        const f = await fixture('team', 'account', { contentMode, separateMemberCustodian: true, separateContentOwner: true });
        const sibling = await db.deploymentEnvironment.create({ data: { ...f.environment,
            id: crypto.randomUUID(), ...await f.content('deployment-environment.v1') } });
        const actionId = 'registries.updates.check';
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { kind: 'app', environments: [
            { environmentId: f.environment.id, expectedRevision: f.environmentRevision },
            { environmentId: sibling.id, expectedRevision: sibling.revision },
        ] };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const mint = () => auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
            serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
            machineId: f.controller.id, target, requestId: envelope.requestId,
            registryAppUpdateAdmission: projectRegistryAppUpdateAdmissionV1(actionId, input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const authorization = await mint();
        const read = (artifactId: string) => {
            const path = `/v1/artifacts/${artifactId}`;
            return verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId: actionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path, body: undefined,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'GET', path, privateKey: f.controller.keys.secretKey }) });
        };
        expect(await read(f.environment.contentArtifactId)).not.toBeNull();
        if (change === 'revision') await db.deploymentEnvironment.update({ where: { id: sibling.id },
            data: { revision: { increment: 1 } } });
        else await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
        const queries: string[] = [];
        const stop = observeSqliteRequests({ before: request => { if (request.model) queries.push(request.model); } });
        try {
            expect(await read(f.environment.contentArtifactId)).not.toBeNull();
            expect(await read(sibling.contentArtifactId)).not.toBeNull();
            expect(await read(f.receipt.contentArtifactId)).toBeNull();
        } finally { stop(); }
        expect(queries.filter(model => model === 'ProjectSource')).toEqual([]);
        await withAuthenticatedTestApp(async app => { await registerDeploymentRoutes(app); await artifactsRoutes(app); }, async app => {
            const get = (path: string, effectActionId = actionId) => app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'GET', path, privateKey: f.controller.keys.secretKey }),
            } });
            for (const environment of [f.environment, sibling]) {
                const metadata = await get(`/v1/deployments/environments/${environment.id}?serverId=${serverId}`, 'deployments.environments.get');
                expect(metadata.statusCode, metadata.body).toBe(200);
                const content = await get(`/v1/artifacts/${environment.contentArtifactId}`);
                expect(content.statusCode, content.body).toBe(200);
            }
            expect((await get(`/v1/artifacts/${f.receipt.contentArtifactId}`)).statusCode).toBe(401);
            expect((await get(`/v1/deployments/environments/${crypto.randomUUID()}?serverId=${serverId}`, 'deployments.environments.get')).statusCode).toBe(401);
        }, { authentication: 'real' });
        await expect(mint()).rejects.toThrow();
    });

    it('logs one private HTTP warning for a registry Artifact outside the admitted Environments', async () => {
            const f = await fixture();
            const actionId = 'registries.updates.check';
            const target = { kind: 'machine' as const, machineId: f.controller.id };
            const input = { kind: 'app', environments: [{ environmentId: f.environment.id, expectedRevision: f.environmentRevision }] };
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.account.id,
                serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, actionId,
                machineId: f.controller.id, target, requestId: envelope.requestId,
                registryAppUpdateAdmission: projectRegistryAppUpdateAdmissionV1(actionId, input),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
            expect(authorization.binding.registryAppUpdateAdmission).toEqual({ environments: input.environments });
            const signedRead = (path: string) => ({ authorizationToken: authorization.token, effectActionId: actionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path, body: undefined,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: f.controller.installationId, requestId: envelope.requestId,
                    method: 'GET', path, privateKey: f.controller.keys.secretKey }) });
            expect(await verifyExternalActionDomainExecutionRequest(signedRead(`/v1/artifacts/${f.environment.contentArtifactId}`))).not.toBeNull();
            const path = `/v1/artifacts/${f.receipt.contentArtifactId}`;
            const proof = signedRead(path);
            await expectHttpRefusalWarning({ phase: 'deployment_registry_purpose', method: 'GET', path },
                async () => { expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull(); },
                [authorization.token, proof.machineSignature]);
        });

    it.each(['deployment_publication_child_kind', 'deployment_child_machine_path', 'deployment_child_machine_request',
        'deployment_child_machine_read', 'deployment_child_peer_proof', 'deployment_child_peer_read',
        'deployment_child_archive_purpose', 'deployment_child_http'] as const)(
        'logs one private HTTP warning for the refused %s branch', async phase => {
            const f = await fixture('account', 'account', { templateRoot: true });
            const packet = f.rpc();
            const archiveOrigin = { environmentId: f.environment.id, deploymentId: f.receipt.id,
                holderMachineId: f.builder.id, holderInstallationId: f.builder.installationId };
            const peerBody = DirectRouteGrantRequestV2Schema.parse({ v: 2, kind: 'ephemeral_ed25519', machineId: f.outsider.id,
                ephemeralPublicKeyBase64Url: encodeBase64(nacl.sign.keyPair().publicKey, 'base64url'),
                flowKind: 'bounded_transfer', routeKind: 'iroh_peer', endpointFingerprint: 'a'.repeat(64),
                ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier, scope: { kind: 'bounded_transfer', mode: 'carrier' },
                iroh: { initiator: { kind: 'account_client', endpointId: 'b'.repeat(64) },
                    target: { machineId: f.outsider.id, endpointId: 'a'.repeat(64) }, operationKind: 'finite_transfer' } });
            const request: { method: string; path: string; body: unknown; routeInput?: unknown } = {
                method: 'GET', path: `/v1/machines/${f.member.id}`, body: undefined,
            };
            if (phase === 'deployment_publication_child_kind') Object.assign(request, { method: 'POST', path: '/v1/artifacts', body: { private: 'body-secret' } });
            if (phase === 'deployment_child_machine_path') request.path = '/v1/machines/%';
            if (phase === 'deployment_child_machine_request') request.routeInput = { id: f.outsider.id, private: 'route-secret' };
            if (phase === 'deployment_child_machine_read') request.path = `/v1/machines/${f.outsider.id}`;
            if (phase === 'deployment_child_peer_proof' || phase === 'deployment_child_peer_read') {
                Object.assign(request, { method: 'POST', path: '/v1/machines/peer/mediation/route-grants', body: peerBody });
            }
            if (phase === 'deployment_child_archive_purpose') request.path = '/v1/features/authenticated';
            if (phase === 'deployment_child_http') request.path = '/v1/artifacts/read?private=query-secret#fragment-secret';
            const origin = phase === 'deployment_child_peer_read' || phase === 'deployment_child_archive_purpose' ? archiveOrigin : undefined;
            const proof = { ...request, authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy',
                encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                deploymentChildExecution: createDeploymentChildExecutionProofV1(packet, origin),
                machineSignature: signExternalActionMachineRequestV1({ ...request, authorizationToken: f.authorization.token,
                    effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.member.installationId,
                    requestId: f.authorization.binding.requestId, deploymentChildExecution: packet, deploymentArchiveOrigin: origin,
                    privateKey: f.member.keys.secretKey }) };
            await expectHttpRefusalWarning({ phase, method: request.method, path: request.path.split(/[?#]/u)[0] },
                async () => { expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull(); },
                [f.authorization.token, proof.machineSignature, peerBody.ephemeralPublicKeyBase64Url,
                    'body-secret', 'route-secret', 'query-secret', 'fragment-secret']);
        });

    it('keeps template preparation requestKey exact and admits its controller receiver codec', async () => {
        const f = await fixture('team', 'account', { templateRoot: true });
        const current = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
        const prepare: DeploymentChildRpcV1 = { v: 1, kind: 'prepare', actionId: 'deployments.deploy',
            input: { serverId, environmentId: f.environment.id, targetLinkId: f.link.id },
            machineId: f.builder.id, installationId: f.builder.installationId,
            expectedRevision: current.revision, expectedTargetLinkRevision: f.link.revision };
        expect.soft(await f.verify(prepare)).toBeNull();
        const build: DeploymentChildRpcV1 = { v: 1, kind: 'build', actionId: 'deployments.deploy', input: f.input,
            machineId: f.builder.id, installationId: f.builder.installationId, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId };
        for (const job of [f.job, build]) {
            const packet = f.rpc(job);
            const deploymentChildExecution = createDeploymentChildExecutionProofV1(packet);
            const codec = (machineId: string) => {
                const path = `/v1/machines/${machineId}`;
                return verifyExternalActionDomainExecutionRequest({ authorizationToken: f.authorization.token,
                    effectActionId: 'deployments.deploy', encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                    method: 'GET', path, body: undefined, deploymentChildExecution,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                        effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.controller.installationId,
                        requestId: f.authorization.binding.requestId, method: 'GET', path, body: undefined,
                        deploymentChildExecution: packet, privateKey: f.controller.keys.secretKey }) });
            };
            expect.soft(await codec(job.machineId)).not.toBeNull();
            expect(await codec(f.outsider.id)).toBeNull();
        }
    });

    it('refuses a template preview or missing deploy intent before native receipt admission', async () => {
        const f = await fixture('account', 'account', { templateRoot: true });
        const { deploy: _deploy, ...withoutDeploy } = f.templateInput;
        for (const input of [{ ...f.templateInput, mode: 'preview' as const }, withoutDeploy]) {
            const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID(), input };
            const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
                actionId: 'deployments.templates.instantiate', machineId: f.controller.id, target: envelope.target, requestId: envelope.requestId,
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
            expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                effectActionId: 'deployments.deploy', encodedTarget: encodeExternalActionResolvedTargetV1(envelope.target),
                method: 'POST', path: f.admissionPath, body: f.admissionInput, reviewedChild: f.reviewedChild,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.deploy', target: envelope.target, installationId: f.controller.installationId,
                    requestId: envelope.requestId, method: 'POST', path: f.admissionPath, body: f.admissionInput, reviewedChild: f.reviewedChild,
                    privateKey: f.controller.keys.secretKey }) })).toBeNull();
        }
        expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(1);
    });

    it.each(['plain', 'e2ee'] as const)('spends configured backup admission / standalone restore admission: persists only admitted restore content on its serving generation without changing lifecycle (%s)', async contentMode => {
        const f = await fixture('account', 'account', { contentMode });
        const settledAt = new Date('2026-11-12T12:00:00.000Z');
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded', settledAt } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
        const previous = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'succeeded',
            ...await f.content('deployment-receipt.v1') } });
        const otherLink = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            ...await f.content('deployment-target-link.v1'), machines: { create: [{ machineId: f.member.id,
                installationId: f.member.installationId, position: 0, state: 'active' }] } } });
        const otherTarget = await db.deployment.create({ data: { ...previous, id: crypto.randomUUID(),
            targetLinkId: otherLink.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
            ...await f.content('deployment-receipt.v1') } });
        await db.deploymentTargetLink.update({ where: { id: otherLink.id }, data: { activeDeploymentId: otherTarget.id } });
        const foreign = await fixture();
        const actionId = 'deployments.backups.restore' as const;
        const target = { kind: 'machine' as const, machineId: f.member.id };
        const input: DeploymentBackupRestoreInputV1 = { mode: 'confirm', serverId, environmentId: f.environment.id,
            targetLinkId: f.link.id, deploymentId: previous.id, machineId: f.member.id,
            installationId: f.member.installationId, expectedRevision: f.environmentRevision,
            source: { kind: 'repository', snapshotId: 'volume-snapshot' }, prepareOperationId: crypto.randomUUID() };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.member.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input, deploymentNativeAdmission });
        const updatedContent = { ownServer: { sources: [{ environmentInstanceId: 'restored-volume',
            namedVolumes: [{ volume: 'data', physicalName: 'restore-stage-data' }] }] } };
        const updatedBody = { body: JSON.stringify(updatedContent) };
        const body = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId, expectedRevision: f.receipt.revision,
            machineId: f.member.id, installationId: f.member.installationId, kind: 'settle' as const, state: 'succeeded' as const,
            contentArtifactId: f.receipt.contentArtifactId, contentHeaderVersion: f.receipt.contentHeaderVersion,
            contentBodyVersion: f.receipt.contentBodyVersion,
            contentUpdate: ArtifactJsonUpdateHttpInputV1Schema.parse({ expectedBodyVersion: f.receipt.contentBodyVersion,
                body: contentMode === 'plain' ? encodePlainArtifactStoredContent(updatedBody)
                    : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(updatedBody,
                        f.artifactKeys.get(f.receipt.contentArtifactId)!))) }) };
        const sign = (body: Omit<DeploymentTransitionInputV1, 'proof'>) => DeploymentTransitionInputV1Schema.parse({ ...body,
            proof: signMachineInstallationProof({ payload: { version: 1, accountId: f.account.id,
                machineId: f.member.id, installationId: f.member.installationId,
                deploymentTransition: { serverId: body.serverId, environmentId: body.environmentId, deploymentId: body.deploymentId,
                    actionOperationId: body.actionOperationId, expectedRevision: body.expectedRevision,
                    requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: f.member.keys.secretKey }) });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = async (body: Omit<DeploymentTransitionInputV1, 'proof'>, effectActionId: string = actionId) => {
                const wire = sign(body);
                const path = `/v1/deployments/environments/${body.environmentId}/deployments/${body.deploymentId}/transitions`;
                return app.inject({ method: 'POST', url: path, payload: wire, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target, installationId: f.member.installationId, requestId: authorization.binding.requestId,
                        method: 'POST', path, body: wire, privateKey: f.member.keys.secretKey }),
                } });
            };
            // These signatures remain valid: purpose, generation custody and lifecycle must reject them.
            for (const invalid of [{ ...body, serverId: 'another-home' }, { ...body, environmentId: foreign.environment.id },
                { ...body, state: 'failed' as const },
                { ...body, kind: 'stage' as const, state: 'running' as const },
                { ...body, expectedTargetLinkRevision: f.link.revision }]) {
                const denied = await send(invalid);
                expect(denied.statusCode, denied.body).toBe(401);
            }
            expect((await send(body, 'deployments.deploy')).statusCode).toBe(401);
            for (const unselected of [previous, otherTarget]) {
                const denied = await send({ ...body, deploymentId: unselected.id, actionOperationId: unselected.actionOperationId,
                    contentArtifactId: unselected.contentArtifactId });
                expect(denied.statusCode, denied.body).toBe(409);
            }
            await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: previous.id } });
            const superseded = await send(body);
            expect(superseded.statusCode, superseded.body).toBe(409);
            await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id } });
            for (const invalid of [{ ...body, contentArtifactId: previous.contentArtifactId },
                { ...body, contentHeaderVersion: body.contentHeaderVersion + 1 },
                { ...body, contentBodyVersion: body.contentBodyVersion + 1 }]) {
                const denied = await send(invalid);
                expect(denied.statusCode, denied.body).toBe(409);
            }
            const changed = await send(body);
            expect(changed.statusCode, changed.body).toBe(200);
            expect(changed.json()).toMatchObject({ ok: true, state: 'succeeded', deploymentRevision: f.receipt.revision + 1 });
            const stored = await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.id } });
            expect(stored).toMatchObject({ state: 'succeeded', settledAt, revision: f.receipt.revision + 1,
                actionOperationId: f.receipt.actionOperationId, contentArtifactId: f.receipt.contentArtifactId,
                contentBodyVersion: f.receipt.contentBodyVersion + 1 });
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } }))
                .toMatchObject({ activeDeploymentId: f.receipt.id, revision: f.link.revision, state: f.link.state });
            const artifact = await inTx(tx => readArtifactForCallerInTx(tx, {
                actorAccountId: f.account.id, artifactId: stored.contentArtifactId }));
            if (!artifact.ok) throw new Error(artifact.error);
            if (contentMode === 'plain') expect(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.artifact.body))).toEqual(updatedBody);
            else expect(await openSessionDataKeyBundleV0(artifact.artifact.body, f.artifactKeys.get(stored.contentArtifactId)!))
                .toMatchObject({ status: 'authenticated', value: updatedBody });
            const stale = await send(body);
            expect(stale.statusCode, stale.body).toBe(409);
            expect((await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.id } })).revision).toBe(stored.revision);
        }, { authentication: 'real' });
    });

    function signedStage(f: Awaited<ReturnType<typeof fixture>>, machine: Awaited<ReturnType<typeof fixture>>['controller'],
        state: 'running' | 'failed', expectedRevision: number) {
        const body = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId, expectedRevision, machineId: machine.id,
            installationId: machine.installationId, kind: state === 'running' ? 'stage' as const : 'settle' as const, state };
        return DeploymentTransitionInputV1Schema.parse({ ...body, proof: signMachineInstallationProof({ payload: { version: 1,
            accountId: f.account.id, machineId: machine.id, installationId: machine.installationId,
            deploymentTransition: { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
                actionOperationId: f.receipt.actionOperationId, expectedRevision,
                requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: machine.keys.secretKey }) });
    }

    it('admits native volume inventory only on the selected target Machine', async () => {
        const f = await fixture();
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id, reason: 'manual', mode: 'preview' };
        const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID(), input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.teardown', machineId: f.controller.id, target: envelope.target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const job = DeploymentTeardownReviewChildRpcV1Schema.parse({ v: 1, kind: 'prepare', actionId: 'deployments.teardown',
            input: { serverId, environmentId: f.environment.id, targetLinkId: f.link.id, reason: 'manual' },
            machineId: f.member.id, installationId: f.member.installationId,
            expectedRevision: f.environmentRevision, expectedTargetLinkRevision: f.link.revision });
        expect(await isCurrentDeploymentChildInTx(db, authorization.binding, projectDeploymentChildRoutingV1(job))).toBe(true);
        expect(await isCurrentDeploymentChildInTx(db, authorization.binding, projectDeploymentChildRoutingV1({
            ...job, machineId: f.outsider.id, installationId: f.outsider.installationId }))).toBe(false);
        expect(await isCurrentDeploymentChildInTx(db, authorization.binding, projectDeploymentChildRoutingV1({
            ...job, input: { ...job.input, environmentId: f.outsider.id } }))).toBe(false);
    });

    it.each(['teardown', 'prepare'] as const)('limits a remote teardown %s child to native history reads without aggregate writes or new secret custody', async kind => {
        const f = await fixture();
        const routing = projectDeploymentChildRoutingV1(DeploymentChildRpcV1Schema.parse(kind === 'prepare' ? {
            v: 1, kind, actionId: 'deployments.teardown', input: { serverId, environmentId: f.environment.id,
                targetLinkId: f.link.id, reason: 'manual' }, machineId: f.member.id, installationId: f.member.installationId,
            expectedRevision: f.environmentRevision, expectedTargetLinkRevision: f.link.revision,
        } : { v: 1, kind, actionId: 'deployments.teardown',
            input: { ...f.input, reason: 'manual' }, machineId: f.member.id, installationId: f.member.installationId,
            deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId, step: 'removeTarget', mode: 'observe' }));
        const listInput = { serverId, environmentId: f.environment.id };
        const spec = getActionSpec('deployments.receipts.list');
        if (!spec.serverTransport) throw new Error('Receipt history transport required');
        const listAddress = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: listInput });
        expect(await isDeploymentChildHttpPurposeInTx(db, routing, { method: 'GET', path: listAddress.path,
            body: undefined, routeInput: listInput })).toBe(true);
        const foreign = { ...listInput, environmentId: f.outsider.id };
        const foreignAddress = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: foreign });
        expect(await isDeploymentChildHttpPurposeInTx(db, routing, { method: 'GET', path: foreignAddress.path,
            body: undefined, routeInput: foreign })).toBe(false);
        for (const path of [
            `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`,
            `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`,
        ]) expect(await isDeploymentChildHttpPurposeInTx(db, routing, { method: 'POST', path,
            body: { ...f.input, deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId } })).toBe(false);
    });

    it('admits only exact controller-signed work for a current member or selected builder and stops on cancellation', async () => {
        const f = await fixture();
        let artifactReads = 0;
        const stop = observeSqliteRequests({ before: request => { if (request.model === 'Artifact') artifactReads++; } });
        try {
            expect(await f.verify()).toMatchObject({ binding: { machineId: f.controller.id }, effectActionId: 'deployments.deploy' });
            expect(artifactReads).toBe(0);
        } finally { stop(); }
        const stage = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId, expectedRevision: f.receipt.revision, machineId: f.controller.id,
            installationId: f.controller.installationId, kind: 'stage' as const, state: 'running' as const,
            contentUpdate: ArtifactJsonUpdateHttpInputV1Schema.parse({ expectedBodyVersion: 1, body: encodePlainArtifactStoredContent({ stage: 'started' }) }) };
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.account.id, { ...stage, proof: signMachineInstallationProof({
            payload: { version: 1, accountId: f.account.id, machineId: f.controller.id, installationId: f.controller.installationId,
                deploymentTransition: { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
                    actionOperationId: f.receipt.actionOperationId, expectedRevision: f.receipt.revision,
                    requestBodyDigest: computeDeploymentTransitionRequestDigestV1(stage) } }, privateKey: f.controller.keys.secretKey }) }))).toMatchObject({ ok: true });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.id } })).toMatchObject({
            contentArtifactId: f.input.contentArtifactId, contentBodyVersion: 2 });
        // A stage advances the same Artifact head, not the admitted candidate identity.
        expect(await f.verify()).not.toBeNull();
        expect(await f.verify({ v: 1, kind: 'build', actionId: 'deployments.deploy', input: f.input,
            machineId: f.builder.id, installationId: f.builder.installationId, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId})).not.toBeNull();
        expect(await f.verify({ ...f.job, machineId: f.outsider.id, installationId: f.outsider.installationId })).toBeNull();
        expect(await f.verify(f.job, f.member.keys.secretKey)).toBeNull();
        expect(await f.verify({ ...f.job, input: { ...f.input, requestKey: 'another-intent' } })).toBeNull();
        expect(await f.verify({ ...f.job, actionOperationId: 'another-operation' })).toBeNull();
        expect(await f.verify({ ...f.job, installationId: 'retired-installation' })).toBeNull();
        expect(await f.verify({ ...f.job, selectedDeploymentId: 'another-receipt' })).toBeNull();
        await db.machine.update({ where: { id: f.member.id }, data: { revokedAt: new Date() } });
        expect(await f.verify()).toBeNull();
        await db.machine.update({ where: { id: f.member.id }, data: { revokedAt: null } });
        expect(await f.verify()).not.toBeNull();
        const membership = await db.deploymentTargetLinkMachine.findUniqueOrThrow({ where: {
            targetLinkId_machineId: { targetLinkId: f.link.id, machineId: f.member.id },
        } });
        await db.deploymentTargetLinkMachine.delete({ where: { targetLinkId_machineId: { targetLinkId: f.link.id, machineId: f.member.id } } });
        expect(await f.verify()).toBeNull();
        await db.deploymentTargetLinkMachine.create({ data: membership });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { detachedAt: new Date() } });
        expect(await f.verify()).toBeNull();
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { detachedAt: null } });
        expect(await f.verify()).not.toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await f.verify()).toBeNull();
    });

    it('retains admitted receipt custody while its Workflow is paused for approval, excluding cancellation', async () => {
        const f = await fixture('account', 'account', { workflowOrigin: true });
        const continuation = { deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId,
            environmentId: f.environment.id, installationId: f.controller.installationId };
        const runId = f.workflowActionOrigin!.runId;
        await db.automationRun.update({ where: { id: runId }, data: { state: 'paused' } });
        expect(await hasAcceptedDeploymentReceiptInTx(db, f.authorization.binding, continuation)).toBe(true);
        await db.automationRun.update({ where: { id: runId }, data: { state: 'cancelled' } });
        expect(await hasAcceptedDeploymentReceiptInTx(db, f.authorization.binding, continuation)).toBe(false);
    });

    it.each([false, true])('finishes accepted restore, codec reads, cleanup and settlement after Team departure and token rotation (Workflow origin: %s)', async workflowOrigin => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, workflowOrigin });
        expect(await f.verify()).not.toBeNull();
        const running = await inTx(tx => transitionDeploymentInTx(tx, f.account.id,
            signedStage(f, f.controller, 'running', f.receipt.revision)));
        expect(running).toMatchObject({ ok: true, state: 'running' });
        if (!running.ok || !('deploymentRevision' in running)) throw new Error('Expected running admitted deployment');
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
        await db.account.update({ where: { id: f.account.id }, data: { tokenEpoch: { increment: 1 } } });
        expect.soft(await f.verify()).not.toBeNull();
        const baseline = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(), state: 'succeeded',
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: baseline.id } });
        const restore = { ...f.job, phase: 'restore' as const, selectedDeploymentId: baseline.id };
        const reads: { model?: string; action: string }[] = [];
        const stopReads = observeSqliteRequests({ before: request => { reads.push({ model: request.model, action: request.action }); } });
        try { expect.soft(await f.verify(restore)).not.toBeNull(); } finally { stopReads(); }
        expect.soft(reads.filter(read => ['Account', 'TeamMembership', 'ProjectSource', 'ApiToken'].includes(read.model ?? ''))).toEqual([]);
        expect.soft(reads.filter(read => read.model === 'Deployment')).toEqual([{ model: 'Deployment', action: 'findFirst' }]);
        const source = f.rpc(restore);
        const packet = { method: source.method, requestId: source.requestId, params: source.params,
            originalActionEnvelope: source.originalActionEnvelope, externalActionExecution: source.externalActionExecution };
        const context = { actorAccountId: f.account.id, custodianAccountId: f.member.accountId,
            machineId: f.member.id, installationId: f.member.installationId, role: 'use' as const, encryptionMode: 'plain' as const };
        const currentnessBody = { v: 1 as const, context, method: source.method, callerInputAuthorization: f.authorization,
            workspaceSyncSourceExecution: packet };
        const currentnessProof = signMachineInstallationProof({ payload: { version: 1, accountId: f.member.accountId,
            machineId: f.member.id, installationId: f.member.installationId, rpcAdmission: {
                context, method: source.method, callerInputAuthorization: f.authorization, workspaceSyncSourceExecution: packet,
            } }, privateKey: f.member.keys.secretKey });
        await withAuthenticatedTestApp(registerMachineAdmissionRoutes, async app => {
            const token = await auth.createToken(f.member.accountId, undefined, { kind: 'terminal', authority: 'account_automation' });
            const response = await app.inject({ method: 'POST', url: `/v1/machines/${f.member.id}/admission/verify`,
                headers: { authorization: `Bearer ${token}` }, payload: { ...currentnessBody, proof: currentnessProof } });
            expect.soft(response.statusCode, response.body).toBe(200);
        }, { authentication: 'real' });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const path = `/v1/machines/${f.member.id}`;
            const response = await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                    effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.member.installationId,
                    requestId: f.authorization.binding.requestId, deploymentChildExecution: packet, method: 'GET', path,
                    body: undefined, privateKey: f.member.keys.secretKey }),
            } });
            expect.soft(response.statusCode, response.body).toBe(200);
        }, { authentication: 'real' });
        if (f.workflowActionOrigin) {
            await db.automationRun.update({ where: { id: f.workflowActionOrigin.runId }, data: { state: 'cancelled' } });
            expect.soft(await f.verify(restore)).toBeNull();
            await db.automationRun.update({ where: { id: f.workflowActionOrigin.runId }, data: { state: 'claimed' } });
        }
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: null } });
        expect.soft(await f.verify({ ...f.job, phase: 'cleanup' })).not.toBeNull();
        const settlement = signedStage(f, f.controller, 'failed', running.deploymentRevision);
        const path = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: path, payload: settlement, headers: {
                ...f.admissionHeaders, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy', target: f.authorization.binding.target,
                    installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                    method: 'POST', path, body: settlement, privateKey: f.controller.keys.secretKey,
                }),
            } });
            expect.soft(response.statusCode, response.body).toBe(200);
            expect.soft(response.json()).toMatchObject({ ok: true, state: 'failed' });
        }, { authentication: 'real' });
        expect(await inTx(tx => createDeploymentInTx(tx, f.account.id, { ...f.admissionInput,
            expectedRevision: f.environmentRevision, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
        }, 'deploy', {}, f.authorization.binding))).toMatchObject({ ok: false, error: 'deployment_unavailable' });
    });

    it.each(['member', 'build'] as const)('checks an accepted %s child with one job lookup and no requester or Team evaluation', async kind => {
        const f = await fixture('team');
        const job = kind === 'member' ? f.job : DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build', actionId: 'deployments.deploy',
            input: f.input, machineId: f.builder.id, installationId: f.builder.installationId, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId});
        const queries: { model?: string; action: string }[] = [];
        const stop = observeSqliteRequests({ before: request => { queries.push({ model: request.model, action: request.action }); } });
        try {
            expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, projectDeploymentChildRoutingV1(job))).toBe(true);
        } finally { stop(); }
        // Shape of one admitted-job check, not an invented numeric call budget.
        expect(queries).toEqual([{ model: 'Deployment', action: 'findFirst' }]);
    });

    it('retains only the accepted builder installation after a real future-placement CAS', async () => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        // The signed HTTP admission above, not this test, captures the installed roles.
        expect(readDeploymentAcceptedExecution(f.receipt)).toEqual({ v: 1,
            controller: { machineId: f.controller.id, installationId: f.controller.installationId },
            builder: { machineId: f.builder.id, installationId: f.builder.installationId } });
        const build = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build', actionId: 'deployments.deploy', input: f.input,
            machineId: f.builder.id, installationId: f.builder.installationId, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId});
        if (build.kind !== 'build') throw new Error('Expected a build fixture');
        expect(await f.verify(build)).not.toBeNull();
        const changed = await inTx(tx => updateDeploymentEnvironmentInTx(tx, f.account.id, {
            serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: f.environment.contentHeaderVersion,
            contentBodyVersion: f.environment.contentBodyVersion, patch: { buildMachineId: f.outsider.id },
        }));
        expect(changed).toMatchObject({ ok: true, revision: f.environmentRevision + 1 });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }))
            .toMatchObject({ buildMachineId: f.outsider.id, revision: f.environmentRevision + 1 });
        expect(await readDeploymentMachineReferencesInTx(db, f.account.id, { homeId: serverId, machineId: f.builder.id }))
            .toMatchObject({ coverage: 'complete', references: [{ id: f.environment.id, deploymentRoles: ['build'] }] });
        expect.soft(await f.verify(build)).not.toBeNull();
        expect(await f.verify({ ...build, machineId: f.outsider.id, installationId: f.outsider.installationId })).toBeNull();
        expect(await f.verify({ ...build, installationId: 'replacement-installation' })).toBeNull();
        expect(await f.verify({ ...build, actionOperationId: crypto.randomUUID() })).toBeNull();
        const copied = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() } });
        expect(await f.verify({ ...build, deploymentId: copied.id })).toBeNull();
        await db.machine.update({ where: { id: f.builder.id }, data: { installationId: crypto.randomUUID() } });
        expect(await f.verify(build)).toBeNull();
        await db.machine.update({ where: { id: f.builder.id }, data: { installationId: f.builder.installationId } });
        await db.machine.update({ where: { id: f.builder.id }, data: { revokedAt: new Date() } });
        expect(await f.verify(build)).toBeNull();
        await db.machine.update({ where: { id: f.builder.id }, data: { revokedAt: null } });
        expect.soft(await f.verify(build)).not.toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await f.verify(build)).toBeNull();
    });

    it('admits terminal retention only for the exact uniformly settled receipt and refuses unsettled or superseded custody', async () => {
        const f = await fixture('team');
        const raw = { v: 1, kind: 'retention', actionId: 'deployments.deploy', input: f.input,
            machineId: f.member.id, installationId: f.member.installationId, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId,
            settledTargetLinkRevision: f.link.revision + 1, settledDeploymentRevision: f.receipt.revision + 1,
            activeDeploymentId: f.receipt.id };
        const job = DeploymentChildRpcV1Schema.parse(raw);
        expect(await f.verify(job)).toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'running' } });
        expect(await f.verify(job)).toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'outcome_unknown' } });
        expect(await f.verify(job)).toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded', revision: { increment: 1 } } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: f.receipt.id, revision: { increment: 1 } } });
        expect(await f.verify(job)).not.toBeNull();
        const sibling = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'queued',
            acceptedRequestEnvelopeDigest: null } });
        expect(await f.verify(job)).toBeNull();
        await db.deployment.update({ where: { id: sibling.id }, data: { state: 'cancelled' } });
        expect(await f.verify(job)).not.toBeNull();
        expect(await f.verify(DeploymentChildRpcV1Schema.parse({ ...raw,
            machineId: f.builder.id, installationId: f.builder.installationId }))).not.toBeNull();
        expect(await f.verify(DeploymentChildRpcV1Schema.parse({ ...raw,
            machineId: f.outsider.id, installationId: f.outsider.installationId }))).toBeNull();
        expect(await f.verify(job, f.member.keys.secretKey)).toBeNull();
        expect(await f.verify(DeploymentChildRpcV1Schema.parse({ ...raw, settledDeploymentRevision: f.receipt.revision }))).toBeNull();
        expect(await f.verify({ ...f.job, phase: 'activate' })).toBeNull();
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { revision: { increment: 1 } } });
        expect(await f.verify(job)).toBeNull();
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { revision: f.link.revision + 1 } });
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.member.id, teamId: f.team!.id } });
        expect(await f.verify(job)).not.toBeNull();

        const restored = await fixture('team');
        const uniform = await db.deployment.create({ data: { ...restored.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: restored.link.id }, data: { activeDeploymentId: uniform.id } });
        await db.deployment.update({ where: { id: restored.receipt.id }, data: { state: 'failed', revision: { increment: 1 } } });
        // Header admission alone cannot inspect encrypted restoration evidence;
        // the receiving content owner proves every current member before effects.
        const recoveryJob = DeploymentChildRpcV1Schema.parse({ ...raw, input: restored.input,
            machineId: restored.member.id, installationId: restored.member.installationId,
            deploymentId: restored.receipt.id, actionOperationId: restored.receipt.actionOperationId, settledTargetLinkRevision: restored.link.revision,
            settledDeploymentRevision: restored.receipt.revision + 1, activeDeploymentId: uniform.id });
        expect(await restored.verify(recoveryJob)).not.toBeNull();
        await db.deployment.update({ where: { id: restored.receipt.id }, data: { state: 'outcome_unknown' } });
        expect(await restored.verify(recoveryJob)).toBeNull();
    });

    it('admits signed observation of only the current eligible uniform baseline', async () => {
        const f = await fixture('team');
        const uniform = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: uniform.id } });
        const observe = DeploymentChildRpcV1Schema.parse({ ...f.job, phase: 'observe', selectedDeploymentId: uniform.id });
        expect(await f.verify(observe)).not.toBeNull();
        expect(await f.verify(DeploymentChildRpcV1Schema.parse({ ...observe, selectedDeploymentId: f.receipt.id }))).toBeNull();
        expect(await f.verify(DeploymentChildRpcV1Schema.parse({ ...observe, selectedDeploymentId: crypto.randomUUID() }))).toBeNull();
        await db.deployment.update({ where: { id: uniform.id }, data: { state: 'failed' } });
        expect(await f.verify(observe)).toBeNull();
        await db.deployment.update({ where: { id: uniform.id }, data: { state: 'outcome_unknown' } });
        expect(await f.verify(observe)).toBeNull();
        await db.deployment.update({ where: { id: uniform.id }, data: { state: 'running_unverified' } });
        expect(await f.verify(observe)).not.toBeNull();
    });

    it('opens only selected and serving receipt content for a current signed rollback review', async () => {
        const f = await fixture('team');
        const predecessor = await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id,
            createdByAccountId: f.account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'prior-runtime',
            targetKind: 'ownServer', state: 'configured', ...await f.content('deployment-target-link.v1') } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { predecessorTargetLinkId: predecessor.id } });
        async function retained(targetLinkId = predecessor.id, environmentId = f.environment.id) {
            return db.deployment.create({ data: { environmentId, targetLinkId, operation: 'deploy', state: 'succeeded',
                requestKey: crypto.randomUUID(), requestedByAccountId: f.account.id, actionOperationId: crypto.randomUUID(),
                ...await f.content('deployment-receipt.v1') } });
        }
        const selected = await retained(), serving = await retained(), unrelated = await retained();
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: serving.id } });
        const input = { ...f.input, expectedRevision: f.environmentRevision, deploymentId: selected.id,
            ...await f.content('deployment-receipt.v1') };
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.rollback', input,
            machineId: f.member.id, installationId: f.member.installationId });
        const target = f.authorization.binding.target;
        const originalActionEnvelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.rollback', machineId: f.controller.id, target, requestId: originalActionEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope) }, { input });
        const method = `${f.member.id}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
        const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
        const packet = { method, requestId, params: job, originalActionEnvelope,
            externalActionExecution: { v: 1 as const, authorization, effectActionId: 'deployments.rollback', target,
                installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.rollback', target, installationId: f.controller.installationId,
                    method, requestId, params: job, deploymentChildRouting, event: SOCKET_RPC_EVENTS.CALL,
                    privateKey: f.controller.keys.secretKey }) } };
        const verify = (path: string, routeInput?: unknown,
            nativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource']) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: authorization.token, effectActionId: 'deployments.rollback',
            encodedTarget: encodeExternalActionResolvedTargetV1(target), method: 'GET', path, routeInput, body: undefined,
            deploymentChildExecution: createDeploymentChildExecutionProofV1(packet, undefined, nativeIncumbentSource),
            machineSignature: signExternalActionMachineRequestV1({
                authorizationToken: authorization.token, effectActionId: 'deployments.rollback', target,
                installationId: f.member.installationId, requestId: authorization.binding.requestId,
                method: 'GET', path, deploymentChildExecution: packet,
                ...(nativeIncumbentSource ? { deploymentNativeIncumbentSource: nativeIncumbentSource } : {}), privateKey: f.member.keys.secretKey }),
        });
        const get = getActionSpec('deployments.receipts.get'), list = getActionSpec('deployments.receipts.list');
        if (!get.serverTransport || !list.serverTransport) throw new Error('Receipts require their canonical transport');
        const getReceipt = (deploymentId: string, environmentId = f.environment.id) => {
            const routeInput = get.inputSchema.parse({ serverId, environmentId, deploymentId });
            return verify(bindHomeDomainHttpRequestV1({ transport: get.serverTransport!, inputSchema: get.inputSchema, input: routeInput }).path, routeInput);
        };
        expect(await getReceipt(selected.id)).not.toBeNull();
        expect(await getReceipt(serving.id)).not.toBeNull();
        expect(await verify(`/v1/artifacts/${selected.contentArtifactId}`)).not.toBeNull();
        expect(await verify(`/v1/artifacts/${serving.contentArtifactId}`)).not.toBeNull();
        expect(await getReceipt(unrelated.id)).toBeNull();
        expect(await verify(`/v1/artifacts/${unrelated.contentArtifactId}`)).toBeNull();
        expect(await getReceipt(selected.id, 'foreign-environment')).toBeNull();
        const listInput = DeploymentReceiptListInputV1Schema.parse({ serverId, environmentId: f.environment.id });
        expect(await verify(bindHomeDomainHttpRequestV1({ transport: list.serverTransport, inputSchema: list.inputSchema, input: listInput }).path, listInput)).toBeNull();
        const nativeIncumbentSource = { environmentId: f.environment.id, sourceDeploymentId: unrelated.id, rootFingerprint: 'a'.repeat(64) };
        const nativeInput = get.inputSchema.parse({ serverId, environmentId: f.environment.id, deploymentId: unrelated.id });
        const nativePath = bindHomeDomainHttpRequestV1({ transport: get.serverTransport, inputSchema: get.inputSchema, input: nativeInput }).path;
        expect(await verify(nativePath, nativeInput, nativeIncumbentSource)).not.toBeNull();
        expect(await verify(`/v1/artifacts/${unrelated.contentArtifactId}`, undefined, nativeIncumbentSource)).not.toBeNull();
        expect(await verify(`/v1/artifacts/${selected.contentArtifactId}`, undefined, nativeIncumbentSource)).toBeNull();
        expect(await verify(nativePath, nativeInput, { ...nativeIncumbentSource, restorationForDeploymentId: selected.id })).toBeNull();
        const foreignEnvironment = await db.deploymentEnvironment.create({ data: { ...f.environment, id: crypto.randomUUID(),
            runtimeTargetLinkId: null, ...await f.content('deployment-environment.v1') } });
        const foreignLink = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            environmentId: foreignEnvironment.id, ...await f.content('deployment-target-link.v1') } });
        const foreignReceipt = await retained(foreignLink.id, foreignEnvironment.id);
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: foreignReceipt.id } });
        expect(await getReceipt(foreignReceipt.id)).toBeNull();
        expect(await verify(`/v1/artifacts/${foreignReceipt.contentArtifactId}`)).toBeNull();
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: serving.id } });
        const sibling = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            ...await f.content('deployment-target-link.v1') } });
        await db.deployment.update({ where: { id: unrelated.id }, data: { targetLinkId: sibling.id } });
        expect(await verify(nativePath, nativeInput, nativeIncumbentSource)).toBeNull();
        await db.deployment.update({ where: { id: unrelated.id }, data: { targetLinkId: predecessor.id } });
        await db.deployment.update({ where: { id: selected.id }, data: { targetLinkId: sibling.id } });
        expect(await verify(`/v1/artifacts/${selected.contentArtifactId}`)).toBeNull();
        await db.deployment.update({ where: { id: selected.id }, data: { targetLinkId: predecessor.id } });
        let receiptReads = 0;
        const stop = observeSqliteRequests({ before: request => { if (request.model === 'Deployment') receiptReads++; } });
        try {
            for (const deploymentId of [unrelated.id, selected.id]) {
                const routeInput = get.inputSchema.parse({ serverId, environmentId: f.environment.id, deploymentId });
                const path = bindHomeDomainHttpRequestV1({ transport: get.serverTransport, inputSchema: get.inputSchema, input: routeInput }).path;
                expect(await isDeploymentChildHttpPurposeInTx(db, deploymentChildRouting,
                    { method: 'GET', path, routeInput, body: undefined })).toBe(deploymentId === selected.id);
                // An unselected id reads no receipts; the exact selected id needs one row, never history.
                expect(receiptReads).toBe(deploymentId === selected.id ? 1 : 0);
            }
        } finally { stop(); }
        await db.deployment.update({ where: { id: selected.id }, data: { state: 'failed' } });
        expect(await getReceipt(selected.id)).toBeNull();
        await db.deployment.update({ where: { id: selected.id }, data: { state: 'succeeded' } });
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.member.id, teamId: f.team!.id } });
        expect(await verify(`/v1/artifacts/${selected.contentArtifactId}`)).toBeNull();
    });

    it('opens only the current exact promotion source during parentless review', async () => {
        const f = await fixture('team');
        const sourceEnvironment = await db.deploymentEnvironment.create({ data: { ...f.environment, id: crypto.randomUUID(),
            runtimeTargetLinkId: null, ...await f.content('deployment-environment.v1') } });
        const sourceLink = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            environmentId: sourceEnvironment.id, ...await f.content('deployment-target-link.v1') } });
        const sourceReceipt = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(),
            environmentId: sourceEnvironment.id, targetLinkId: sourceLink.id, state: 'succeeded',
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await f.content('deployment-receipt.v1') } });
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.promote',
            machineId: f.member.id, installationId: f.member.installationId, input: { ...f.input,
                expectedRevision: f.environmentRevision, sourceEnvironmentId: sourceEnvironment.id,
                sourceDeploymentId: sourceReceipt.id, artifact: 'image',
                destinationContent: await f.content('deployment-environment.v1') } });
        const routing = projectDeploymentChildRoutingV1(job);
        const binding = { ...f.authorization.binding, actionId: 'deployments.promote' };
        const current = () => isCurrentDeploymentChildInTx(db, binding, routing);
        const get = getActionSpec('deployments.receipts.get');
        if (!get.serverTransport) throw new Error('Receipt needs canonical transport');
        const routeInput = get.inputSchema.parse({ serverId, environmentId: sourceEnvironment.id, deploymentId: sourceReceipt.id });
        const path = bindHomeDomainHttpRequestV1({ transport: get.serverTransport, inputSchema: get.inputSchema, input: routeInput }).path;
        const purpose = (path: string, routeInput?: unknown) => isDeploymentChildHttpPurposeInTx(db, routing,
            { method: 'GET', path, routeInput, body: undefined });
        expect(await current()).toBe(true);
        expect(await purpose(path, routeInput)).toBe(true);
        expect(await purpose(`/v1/artifacts/${sourceReceipt.contentArtifactId}`)).toBe(true);
        const unrelated = await db.deployment.create({ data: { ...sourceReceipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await f.content('deployment-receipt.v1') } });
        expect(await purpose(`/v1/artifacts/${unrelated.contentArtifactId}`)).toBe(false);
        await db.deployment.update({ where: { id: sourceReceipt.id }, data: { state: 'failed' } });
        expect(await current()).toBe(false);
        expect(await purpose(`/v1/artifacts/${sourceReceipt.contentArtifactId}`)).toBe(false);
    });

    it.each(['member', 'build'] as const)('reads only its Account workspace selection through an admitted signed %s child', async kind => {
        const f = await fixture();
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = kind === 'member' ? f.member : f.builder;
        const job = kind === 'member' ? f.job : DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build',
            actionId: 'deployments.deploy', input: f.input, machineId: machine.id, installationId: machine.installationId,
            deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId });
        const packet = f.rpc(job);
        const headers = (path: string, body: unknown, privateKey = machine.keys.secretKey) => ({
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
            [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: machine.installationId,
                requestId: f.authorization.binding.requestId, method: 'POST', path, body, deploymentChildExecution: packet, privateKey }),
        });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const key = { kind: 'workspace-ref', serverId, id: 'checkout' } as const;
            const graphKey = { kind: 'relationship-graph' } as const;
            for (const account of [f.account, other]) {
                const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
                const written = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                    headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` }, payload: {
                        mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: {
                            id: key.id, serverId, machineId: machine.id, rootPath: '/checkout', label: account.id, createdAtMs: 1,
                        } } } }, { key: graphKey, expectedRevision: 'absent', content: {
                            t: 'plain', v: { key: graphKey, value: { relationships: [] } },
                        } }], expectedRefs: [], topologyChange: true,
                    } });
                expect(written.statusCode, written.body).toBe(200);
                expect(written.json()).toMatchObject({ status: 'updated' });
            }
            const path = '/v1/account/project-rows/list';
            const selection = { kinds: ['workspace-ref'], serverId };
            const response = await app.inject({ method: 'POST', url: path, payload: selection, headers: headers(path, selection) });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ status: 'listed', rows: [{ key, content: {
                t: 'plain', v: { key, value: { label: f.account.id } },
            } }] });
            expect(response.json().rows).toHaveLength(1);
            for (const body of [{ ...selection, serverId: 'another-home' }, { kinds: ['workspace-ref'] },
                { ...selection, kinds: ['workspace-ref', 'relationship-graph'] }]) {
                const refused = await app.inject({ method: 'POST', url: path, payload: body, headers: headers(path, body) });
                expect(refused.statusCode, refused.body).toBe(401);
            }
            const foreignAccountSelection = { ...selection, accountId: other.id };
            const malformed = await app.inject({ method: 'POST', url: path, payload: foreignAccountSelection,
                headers: headers(path, foreignAccountSelection) });
            expect(malformed.statusCode, malformed.body).toBe(400);
            expect(malformed.json()).toEqual({ error: 'invalid-params' });
            for (const [url, body] of [
                ['/v1/account/project-rows/read', { key }],
                ['/v1/account/project-rows/mutate', { mutations: [{ key, expectedRevision: 0, content: null }],
                    expectedRefs: [], topologyChange: true }],
            ] as const) expect((await app.inject({ method: 'POST', url, payload: body, headers: headers(url, body) })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: path, payload: selection,
                headers: headers(path, selection, f.outsider.keys.secretKey) })).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('opens only scoped source-custody receipt history for a current signed member child', async () => {
        const f = await fixture('team');
        expect(await f.verify()).not.toBeNull();
        const retained = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: f.account.id,
            actionOperationId: crypto.randomUUID(), ...await f.content('deployment-receipt.v1') } });
        const packet = f.rpc();
        const deploymentChildExecution = createDeploymentChildExecutionProofV1(packet);
        const verify = (effectActionId: string, method: string, path: string, routeInput?: unknown,
            body?: unknown, privateKey = f.member.keys.secretKey) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: f.authorization.token, effectActionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
            method, path, routeInput, body, deploymentChildExecution,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token, effectActionId,
                target: f.authorization.binding.target, installationId: f.member.installationId,
                requestId: f.authorization.binding.requestId, method, path, body, deploymentChildExecution: packet, privateKey }),
        });
        const list = getActionSpec('deployments.receipts.list');
        if (!list.serverTransport) throw new Error('Receipt history needs its canonical transport');
        const listInput = DeploymentReceiptListInputV1Schema.parse({ serverId, environmentId: f.environment.id });
        const listPath = bindHomeDomainHttpRequestV1({ transport: list.serverTransport, inputSchema: list.inputSchema, input: listInput }).path;
        // createDaemonDeploymentActionDeps keeps the original child root as
        // the effect header for these private storage reads.
        expect(await verify('deployments.deploy', 'GET', listPath, listInput)).not.toBeNull();
        expect(await verify('deployments.deploy', 'GET', listPath, listInput, undefined, f.outsider.keys.secretKey)).toBeNull();
        expect(await verify('deployments.deploy', 'GET', listPath, { ...listInput, environmentId: 'another-environment' })).toBeNull();
        const get = getActionSpec('deployments.receipts.get');
        if (!get.serverTransport) throw new Error('Receipt history needs its canonical transport');
        const getInput = get.inputSchema.parse({ serverId, environmentId: f.environment.id, deploymentId: retained.id });
        const getPath = bindHomeDomainHttpRequestV1({ transport: get.serverTransport, inputSchema: get.inputSchema, input: getInput }).path;
        expect(await verify('deployments.deploy', 'GET', getPath, getInput)).not.toBeNull();
        expect(await verify('deployments.deploy', 'GET', `/v1/artifacts/${retained.contentArtifactId}`)).not.toBeNull();
        expect(await verify('deployments.deploy', 'GET', `/v1/artifacts/${crypto.randomUUID()}`)).toBeNull();
        expect(await verify('deployments.deploy', 'POST', listPath, listInput, listInput)).toBeNull();
        // The installed child port signs any address it is given. These are
        // refused here even though a current member signed them.
        for (const [method, path, body] of [['GET', '/v2/account/settings'], ['GET', '/v1/account/encryption'],
            ['GET', `/v1/deployments/environments/${crypto.randomUUID()}?serverId=${serverId}`],
            ['GET', `/v1/machines/${f.outsider.id}`], ['POST', '/v1/artifacts/read-batch', { ids: [retained.contentArtifactId] }],
            ['POST', '/v1/account/project-rows/read', {}], ['POST', '/v1/artifacts', {}]] as const) {
            expect(await verify('deployments.deploy', method, path, undefined, body), `${method} ${path}`).toBeNull();
        }
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.member.id, teamId: f.team!.id } });
        expect(await verify('deployments.deploy', 'GET', listPath, listInput)).not.toBeNull();
    });

    it('keeps source-history purposes within runtime lineage while preserving exact Promote source metadata and Artifact', async () => {
        const f = await fixture('team');
        const retained = await db.deployment.create({ data: { ...f.receipt, id: crypto.randomUUID(), requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), state: 'succeeded', ...await f.content('deployment-receipt.v1') } });
        const sibling = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            ...await f.content('deployment-target-link.v1') } });
        const unrelated = await db.deployment.create({ data: { ...retained, id: crypto.randomUUID(), targetLinkId: sibling.id,
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await f.content('deployment-receipt.v1') } });
        const sourceEnvironment = await db.deploymentEnvironment.create({ data: { ...f.environment, id: crypto.randomUUID(),
            runtimeTargetLinkId: null, ...await f.content('deployment-environment.v1') } });
        const sourceLink = await db.deploymentTargetLink.create({ data: { ...f.link, id: crypto.randomUUID(),
            environmentId: sourceEnvironment.id, ...await f.content('deployment-target-link.v1') } });
        const promoted = await db.deployment.create({ data: { ...retained, id: crypto.randomUUID(), environmentId: sourceEnvironment.id,
            targetLinkId: sourceLink.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
            ...await f.content('deployment-receipt.v1') } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { promotedFromDeploymentId: promoted.id } });
        const list = getActionSpec('deployments.receipts.list');
        if (!list.serverTransport) throw new Error('History requires its canonical transport');
        const listInput = list.inputSchema.parse({ serverId, environmentId: f.environment.id });
        const listPath = bindHomeDomainHttpRequestV1({ transport: list.serverTransport, inputSchema: list.inputSchema, input: listInput }).path;
        for (const kind of ['build', 'member', 'retention'] as const) {
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind, actionId: 'deployments.deploy', input: f.input,
                machineId: f.member.id, installationId: f.member.installationId,
                deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId,
                ...(kind === 'member' ? { phase: 'activate', selectedDeploymentId: f.receipt.id } : {}),
                ...(kind === 'retention' ? { settledTargetLinkRevision: f.link.revision,
                    settledDeploymentRevision: f.receipt.revision, activeDeploymentId: retained.id } : {}) });
            const routing = projectDeploymentChildRoutingV1(job);
            const purpose = (path: string, routeInput?: unknown) => inTx(tx => isDeploymentChildHttpPurposeInTx(tx, routing,
                { method: 'GET', path, body: undefined, routeInput }));
            expect(await purpose(listPath, listInput), kind).toBe(true);
            expect(await purpose(`/v1/artifacts/${retained.contentArtifactId}`), kind).toBe(true);
            expect(await purpose(`/v1/artifacts/${unrelated.contentArtifactId}`), kind).toBe(false);
            // Issued work retains the exact immutable promotion-source
            // reference from its parent, even outside destination history.
            expect(await purpose(`/v1/artifacts/${promoted.contentArtifactId}`), kind).toBe(true);
            expect(await purpose(`/v1/artifacts/${crypto.randomUUID()}`), kind).toBe(false);
            const promotion = { ...f.input, sourceEnvironmentId: sourceEnvironment.id, sourceDeploymentId: promoted.id,
                artifact: 'image' as const, destinationContent: await f.content('deployment-environment.v1') };
            const promotionRouting = projectDeploymentChildRoutingV1(DeploymentChildRpcV1Schema.parse({ ...job,
                actionId: 'deployments.promote', input: promotion }));
            if (!('promotion' in promotionRouting) || !promotionRouting.promotion) throw new Error('Expected Promote routing');
            const admittedPromotion = promotionRouting.promotion;
            const get = getActionSpec('deployments.environments.get');
            if (!get.serverTransport) throw new Error('Environment metadata needs its canonical transport');
            const sourceInput = get.inputSchema.parse({ serverId, environmentId: sourceEnvironment.id });
            const sourcePath = bindHomeDomainHttpRequestV1({ transport: get.serverTransport,
                inputSchema: get.inputSchema, input: sourceInput }).path;
            const promotionPurpose = (path: string, routeInput: unknown) => inTx(tx => isDeploymentChildHttpPurposeInTx(tx,
                promotionRouting, { method: 'GET', path, body: undefined, routeInput }));
            expect(await promotionPurpose(sourcePath, sourceInput), kind).toBe(true);
            expect(await promotionPurpose(`${sourcePath}/other`, sourceInput), kind).toBe(false);
            expect(await promotionPurpose(sourcePath, { ...sourceInput, environmentId: f.environment.id }), kind).toBe(false);
            expect(await promotionPurpose(sourcePath, { ...sourceInput, serverId: 'foreign-home' }), kind).toBe(false);
            // A caller-supplied source tuple cannot replace the accepted parent's source.
            const foreignRouting = { ...promotionRouting, promotion: { ...promotionRouting.promotion,
                sourceDeploymentId: unrelated.id } };
            expect(await inTx(tx => isDeploymentChildHttpPurposeInTx(tx, foreignRouting,
                { method: 'GET', path: sourcePath, body: undefined, routeInput: sourceInput })), kind).toBe(false);
            expect(await inTx(tx => isDeploymentChildHttpPurposeInTx(tx, { ...promotionRouting,
                promotion: { ...admittedPromotion, sourceEnvironmentId: f.environment.id } },
                { method: 'GET', path: sourcePath, body: undefined, routeInput: sourceInput })), kind).toBe(false);
            expect(await inTx(tx => isDeploymentChildHttpPurposeInTx(tx, promotionRouting,
                { method: 'POST', path: sourcePath, body: undefined, routeInput: sourceInput })), kind).toBe(false);
        }
    });

    it('continues accepted child machine reads after membership withdrawal while refusing new admission', async () => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true });
        const accepted = await readAcceptedDeploymentReceiptInTx(db, f.authorization.binding);
        if (!accepted) throw new Error('Expected accepted deployment');
        expect(readAdmittedFiniteOperationPrincipal(f.authorization.binding)).toBeNull();
        expect(readAdmittedFiniteOperationPrincipal(f.authorization.binding, undefined, accepted))
            .toMatchObject({ accountId: f.account.id, authority: 'present_user' });
        const read = async () => {
            const verified = await f.verify();
            expect(verified?.deploymentChildAdmission).toBeDefined();
            if (!verified?.deploymentChildAdmission) throw new Error('Expected accepted child');
            return readDeploymentChildMachineReadInTx(db, verified.deploymentChildAdmission, f.controller.id);
        };
        const mint = (account = f.account) => {
            const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID() };
            return auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: account.id, authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
                actionId: f.authorization.binding.actionId, machineId: f.controller.id, target: envelope.target,
                requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
            { input: envelope.input });
        };
        expect(await read()).toMatchObject({ machineId: f.controller.id });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.controller.id, teamId: f.team!.id } });
        const membershipReads: string[] = [];
        const stop = observeSqliteRequests({ before: query => {
            if (query.model === 'TeamMembership' || query.model === 'MachineTeamGrant'
                || query.model === 'Machine' && /"teamGrants"/u.test(JSON.stringify(query.args))) membershipReads.push(query.model);
        } });
        try {
            expect(await read()).toMatchObject({ machineId: f.controller.id,
                codecAdmission: { actorAccountId: f.account.id } });
        } finally { stop(); }
        expect(membershipReads).toEqual([]);
        const review = projectDeploymentChildRoutingV1(DeploymentChildRpcV1Schema.parse({ v: 1, actionId: 'deployments.deploy', kind: 'review',
            input: { ...f.input, expectedRevision: f.environmentRevision }, machineId: f.member.id, installationId: f.member.installationId }));
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, review)).toBe(false);
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint(outsider)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        expect(await isCurrentDeploymentChildInTx(db, { ...f.authorization.binding, accountId: outsider.id }, review)).toBe(false);
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await f.verify()).toBeNull();
    });

    it('rechecks the Source Team grant for a new review, not for an already accepted child', async () => {
        const f = await fixture('team');
        expect(await f.verify()).not.toBeNull();
        const review = projectDeploymentChildRoutingV1(DeploymentChildRpcV1Schema.parse({ v: 1, actionId: 'deployments.deploy', kind: 'review',
            input: { ...f.input, expectedRevision: f.environmentRevision }, machineId: f.member.id, installationId: f.member.installationId }));
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, review)).toBe(true);
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.member.id, teamId: f.team!.id } });
        expect(await f.verify()).not.toBeNull();
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, review)).toBe(false);
    });

    it('rejoins an accepted receipt after an unrelated Environment edit without a captured revision tag', async () => {
        const f = await fixture('account', 'account', { readableEnvironment: true });
        const edited = await inTx(tx => updateDeploymentEnvironmentInTx(tx, f.account.id, {
            serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision,
            contentArtifactId: f.environment.contentArtifactId,
            contentHeaderVersion: f.environment.contentHeaderVersion, contentBodyVersion: f.environment.contentBodyVersion,
            patch: { protection: 'production' },
        }));
        expect(edited).toMatchObject({ ok: true, revision: f.environmentRevision + 1 });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const replay = await app.inject({ method: 'POST', url: f.admissionPath,
                headers: f.admissionHeaders, payload: f.admissionInput });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toMatchObject({ ok: true, deploymentId: f.receipt.id,
                revision: f.environmentRevision + 1 });
        }, { authentication: 'real' });
        const retained = await readDeploymentReceiptInTx(db, f.account.id, { serverId, deploymentId: f.receipt.id });
        if (!retained.ok) throw new Error(retained.error);
        expect(retained.deployment.acceptedExecution).toEqual({ v: 1,
            controller: { machineId: f.controller.id, installationId: f.controller.installationId },
            builder: { machineId: f.builder.id, installationId: f.builder.installationId } });
        const routing = projectDeploymentChildRoutingV1(f.job);
        if (routing.kind !== 'member') throw new Error('Expected a member fixture');
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(true);
    });

    it.each(['plain', 'e2ee'] as const)('settles an accepted receipt under a fresh observer root only from its retained controller (%s envelope)', async mode => {
        const f = await fixture('account', 'account', { contentMode: mode });
        const actionId = 'deployments.receipts.observe' as const;
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const input = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id };
        const requestId = crypto.randomUUID();
        const authentication = { kind: 'account' as const, tokenEpoch: f.account.tokenEpoch };
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, requestId, target }, input,
            material: { type: 'dataKey', machineKey: f.controller.contentKey }, randomBytes: nacl.randomBytes })
            : { v: 1 as const, requestId, target, input };
        const metadataEnvironmentId = projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1({ actionId, envelope });
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication, actionId, machineId: f.controller.id, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, {
                input: envelope.v === 1 ? input : { environmentId: metadataEnvironmentId },
            });
        expect(authorization.binding.environmentId).toBe(f.environment.id);
        expect(authorization.binding.requestEnvelopeDigest).not.toBe(f.authorization.binding.requestEnvelopeDigest);
        const path = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const readEnvironment = (environmentId = f.environment.id, effectActionId: string = actionId) => {
                const get = getActionSpec('deployments.environments.get');
                if (!get.serverTransport) throw new Error('Environment metadata needs its canonical transport');
                const readPath = bindHomeDomainHttpRequestV1({ transport: get.serverTransport,
                    inputSchema: get.inputSchema, input: { serverId, environmentId } }).path;
                return app.inject({ method: 'GET', url: readPath, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target, installationId: f.controller.installationId, requestId,
                        method: 'GET', path: readPath, privateKey: f.controller.keys.secretKey }),
                } });
            };
            const metadata = await readEnvironment();
            expect(metadata.statusCode, metadata.body).toBe(200);
            expect(metadata.json()).toMatchObject({ ok: true, environment: { id: f.environment.id } });
            expect((await readEnvironment(f.environment.id, 'deployments.environments.get')).statusCode).toBe(200);
            expect((await readEnvironment(crypto.randomUUID())).statusCode).toBe(401);
            const settle = async (machine = f.controller, deploymentId = f.receipt.id) => {
                const body = signedStage(f, machine, 'failed', f.receipt.revision);
                return app.inject({ method: 'POST', url: path, payload: { ...body, deploymentId }, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: machine.installationId, requestId,
                        method: 'POST', path, body: { ...body, deploymentId }, privateKey: machine.keys.secretKey }),
                } });
            };
            expect((await settle(f.builder)).statusCode).toBe(401);
            expect((await settle(f.controller, crypto.randomUUID())).statusCode).toBe(401);
            const response = await settle();
            expect(response.statusCode, response.body).toBe(200);
            expect(DeploymentReceiptResultV1Schema.parse(response.json())).toMatchObject({ ok: true, state: 'failed' });
            expect((await settle()).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('retains the accepted host after canonical future-controller reassignment', async () => {
        const f = await fixture('team');
        const routing = projectDeploymentChildRoutingV1(f.job);
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(true);
        const changed = await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, f.account.id, {
            serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision, controllerMachineId: f.builder.id,
        }));
        expect(changed).toEqual({ ok: true, environmentId: f.environment.id, revision: f.environmentRevision + 1 });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.id } })).toEqual(f.receipt);
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(true);
        expect(await f.verify()).not.toBeNull();
        expect(await readDeploymentMachineReferencesInTx(db, f.account.id, { homeId: serverId, machineId: f.controller.id }))
            .toMatchObject({ coverage: 'complete', references: [{ id: f.environment.id, deploymentRoles: ['controller'] }] });
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.account.id,
            signedStage(f, f.builder, 'failed', f.receipt.revision)))).toMatchObject({ ok: false, error: 'deployment_access_denied' });
        const stageBody = signedStage(f, f.controller, 'running', f.receipt.revision);
        const stagePath = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
        const stages: ReturnType<typeof DeploymentReceiptResultV1Schema.parse>[] = [];
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: stagePath, payload: stageBody,
                headers: { ...f.admissionHeaders,
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy',
                        target: f.authorization.binding.target, installationId: f.controller.installationId,
                        requestId: f.authorization.binding.requestId, method: 'POST', path: stagePath,
                        body: stageBody, privateKey: f.controller.keys.secretKey }) } });
            expect(response.statusCode, response.body).toBe(200);
            stages.push(DeploymentReceiptResultV1Schema.parse(response.json()));
        }, { authentication: 'real' });
        const started = stages[0];
        expect(started).toMatchObject({ ok: true, state: 'running' });
        if (!started?.ok || !('deploymentRevision' in started)) throw new Error('Expected accepted host stage');
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.account.id,
            signedStage(f, f.controller, 'failed', started.deploymentRevision)))).toMatchObject({ ok: true, state: 'failed' });
        expect(await readDeploymentMachineReferencesInTx(db, f.account.id, { homeId: serverId, machineId: f.controller.id }))
            .toMatchObject({ coverage: 'complete', references: [] });
    });

    it('retains accepted custody across a Source grant change while transport still proves the host installation', async () => {
        const f = await fixture('team');
        const routing = projectDeploymentChildRoutingV1(f.job);
        await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, f.account.id, {
            serverId, environmentId: f.environment.id, expectedRevision: f.environmentRevision, controllerMachineId: f.builder.id,
        }));
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(true);
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.controller.id, teamId: f.team!.id } });
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(true);
        await db.machineTeamGrant.create({ data: { machineId: f.controller.id, teamId: f.team!.id,
            accessLevel: 'view', createdByAccountId: f.account.id } });
        await db.machine.update({ where: { id: f.controller.id }, data: { installationId: crypto.randomUUID() } });
        expect(await f.verify()).toBeNull();
        await db.machine.update({ where: { id: f.controller.id }, data: { installationId: f.controller.installationId } });
        expect(await f.verify()).not.toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(false);
    });

    it('keeps unsigned receipt storage uncaptured and rejects a changed signed operation body', async () => {
        const f = await fixture();
        const before = await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.id } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const tampered = await app.inject({ method: 'POST', url: f.admissionPath, headers: f.admissionHeaders,
                payload: { ...f.admissionInput, actionOperationId: 'forged-operation' } });
            expect(tampered.statusCode).toBe(401);
            expect(await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.id } })).toEqual(before);
            await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'failed' } });
            const bearer = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const unsignedInput = { ...f.admissionInput, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() };
            const unsigned = await app.inject({ method: 'POST', url: f.admissionPath,
                headers: { authorization: `Bearer ${bearer}` }, payload: { ...unsignedInput,
                    expectedRevision: f.environmentRevision } });
            expect(unsigned.statusCode, unsigned.body).toBe(200);
            const result = DeploymentReceiptResultV1Schema.parse(unsigned.json());
            if (!result.ok || !('deploymentId' in result)) throw new Error('Expected unsigned storage receipt');
            const routing = projectDeploymentChildRoutingV1({ ...f.job, input: unsignedInput,
                deploymentId: result.deploymentId, selectedDeploymentId: result.deploymentId,
                actionOperationId: unsignedInput.actionOperationId});
            expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(false);
            const stored = await db.deployment.findUniqueOrThrow({ where: { id: result.deploymentId } });
            const readable = await readDeploymentReceiptInTx(db, f.account.id, { serverId, deploymentId: stored.id });
            expect(readable).toMatchObject({ ok: true });
            if (!readable.ok) throw new Error('Uncaptured storage history must remain readable');
            expect(readable.deployment).not.toHaveProperty('acceptedExecution');
            expect(await inTx(tx => transitionDeploymentInTx(tx, f.account.id,
                signedStage({ ...f, receipt: stored }, f.controller, 'failed', stored.revision))))
                .toMatchObject({ ok: false, error: 'deployment_access_denied' });
        }, { authentication: 'real' });
    });

    it.each([
        { contentMode: 'plain', templateRoot: false }, { contentMode: 'e2ee', templateRoot: false },
        { contentMode: 'plain', templateRoot: true }, { contentMode: 'e2ee', templateRoot: true },
    ] as const)('reads only admitted Environment Machines before child routing exists ($contentMode, template: $templateRoot)', async ({ contentMode, templateRoot }) => {
        const f = await fixture('team', 'account', { separateControllerCustodian: !templateRoot, contentMode, templateRoot });
        const actionId = templateRoot ? 'deployments.templates.instantiate' : 'deployments.deploy';
        const input = templateRoot ? f.templateInput : { serverId, environmentId: f.environment.id, targetLinkId: f.link.id };
        const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID(), input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId, machineId: f.controller.id, target: envelope.target, requestId: envelope.requestId,
            ...(templateRoot ? { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) } : {}),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        if (!templateRoot) expect(authorization.binding.environmentId).toBe(f.environment.id);
        if (templateRoot) {
            const admission = authorization.binding.deploymentPreparationAdmission;
            if (admission?.operation !== 'template') throw new Error('Expected template admission');
            expect(await isDeploymentPreparationAuthorizedInTx(db, authorization.binding, admission)).toBe(true);
            expect(await isDeploymentPreparationAuthorizedInTx(db, { ...authorization.binding, machineId: f.member.id }, admission)).toBe(false);
            expect(await isDeploymentPreparationAuthorizedInTx(db, authorization.binding,
                { ...admission, machineId: f.outsider.id })).toBe(false);
            expect(await isDeploymentPreparationAuthorizedInTx(db, authorization.binding,
                { ...admission, target: { ...admission.target, installationId: f.outsider.installationId } })).toBe(false);
        }
        const sourceReads: string[] = [];
        const stop = observeSqliteRequests({ before: query => {
            if (query.model === 'ProjectSource') sourceReads.push(query.action);
        } });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const send = (machineId = f.builder.id, privateKey = f.controller.keys.secretKey) => {
                    const path = `/v1/machines/${machineId}`;
                    return app.inject({ method: 'GET', url: path, headers: {
                        ...currentAccountStoredContentCompatibilityHeaders,
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                            authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target: envelope.target,
                            installationId: f.controller.installationId, requestId: envelope.requestId,
                            method: 'GET', path, body: undefined, privateKey }),
                    } });
                };
                const current = await send();
                expect(current.statusCode, current.body).toBe(200);
                expect(current.json()).toMatchObject({ machine: { id: f.builder.id, installationId: f.builder.installationId } });
                await db.machine.update({ where: { id: f.builder.id }, data: { active: false } });
                const offline = await send();
                expect(offline.statusCode, offline.body).toBe(200);
                expect(offline.json()).toMatchObject({ machine: { installationId: f.builder.installationId, active: false } });
                // The admitted Environment's own link members are in its read scope (760d535a21); others are not.
                expect((await send(f.member.id)).statusCode).toBe(200);
                expect((await send(f.outsider.id)).statusCode).toBe(401);
                expect((await send(f.builder.id, f.builder.keys.secretKey)).statusCode).toBe(401);
            }, { authentication: 'real' });
        } finally { stop(); }
        expect(sourceReads).toEqual([]);
    });

    it.each([
        { contentMode: 'plain', change: 'withdrawal' }, { contentMode: 'e2ee', change: 'withdrawal' },
        { contentMode: 'plain', change: 'source edit' }, { contentMode: 'e2ee', change: 'source edit' },
    ] as const)('finishes only its admitted candidate publication after $change ($contentMode)', async ({ contentMode, change }) => {
        const f = await fixture('team', 'account', { separateMemberCustodian: true, separateContentOwner: true, contentMode });
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id };
        const mint = (requestId: string) => auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.deploy', machineId: f.controller.id, target: f.originalActionEnvelope.target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ ...f.originalActionEnvelope, requestId, input }) }, { input });
        const authorization = await mint(crypto.randomUUID()), otherPreparation = await mint(crypto.randomUUID());
        const candidate = authorization.binding.deploymentCandidatePublication;
        const otherCandidate = otherPreparation.binding.deploymentCandidatePublication;
        if (!candidate || !otherCandidate) throw new Error('Each admitted preparation requires its own candidate');
        const stored = await inTx(tx => readArtifactForCallerInTx(tx, {
            actorAccountId: f.account.id, artifactId: f.receipt.contentArtifactId }));
        if (!stored.ok) throw new Error(stored.error);
        const contentKey = f.artifactKeys.get(f.receipt.contentArtifactId);
        if (!contentKey) throw new Error('Receipt fixture requires its content key');
        const body = ArtifactJsonCreateHttpInputV1Schema.parse({ id: candidate.contentArtifactId,
            kind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, header: privacyKit.encodeBase64(new Uint8Array(stored.artifact.header)),
            body: privacyKit.encodeBase64(new Uint8Array(stored.artifact.body)),
            dataEncryptionKey: contentMode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
                : privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey,
                    recipientPublicKey: f.accountKeys.publicKey, randomBytes: nacl.randomBytes })) });
        if (change === 'withdrawal') {
            if (!f.team) throw new Error('Withdrawal requires a Source Team');
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.member.accountId } },
                data: { role: 'owner' } });
            expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: f.team!.id, actorAccountId: f.account.id })))
                .toMatchObject({ ok: true });
            await expect(mint(crypto.randomUUID())).rejects.toMatchObject({ code: 'credential_scope_denied' });
        } else {
            await db.projectSource.update({ where: { id: f.environment.projectSourceId }, data: { revision: { increment: 1 } } });
        }
        const proof = (payload: typeof body, routeInput: unknown = payload) => ({
            authorizationToken: authorization.token, effectActionId: 'deployments.deploy',
            encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target),
            method: 'POST', path: '/v1/artifacts', body: payload, routeInput,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: 'deployments.deploy', target: authorization.binding.target,
                installationId: f.controller.installationId, requestId: authorization.binding.requestId,
                method: 'POST', path: '/v1/artifacts', body: payload, privateKey: f.controller.keys.secretKey }),
        });
        for (const denied of [
            { ...body, id: otherCandidate.contentArtifactId }, { ...body, id: crypto.randomUUID() },
            { ...body, kind: 'v1:other:deployment-environment.v1' },
        ]) expect(await verifyExternalActionDomainExecutionRequest(proof(denied))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(body, { ...body, id: otherCandidate.contentArtifactId }))).toBeNull();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const signed = proof(body);
            const published = await app.inject({ method: 'POST', url: signed.path, payload: body, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: signed.authorizationToken,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: signed.effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: signed.encodedTarget,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signed.machineSignature,
            } });
            expect(published.statusCode, published.body).toBe(200);
            expect(published.json()).toMatchObject({ id: candidate.contentArtifactId });
        }, { authentication: 'real' });
        expect(await db.artifact.findUnique({ where: { id: otherCandidate.contentArtifactId } })).toBeNull();
    });

    it.each(['plain', 'e2ee'] as const)('opens only admitted runtime history and candidate during %s builder preparation', async contentMode => {
        const f = await fixture('team', 'account', { separateControllerCustodian: true, contentMode });
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id };
        const envelope = { ...f.originalActionEnvelope, requestId: crypto.randomUUID(), input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.deploy', machineId: f.controller.id, target: envelope.target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare', actionId: 'deployments.deploy', input,
            machineId: f.builder.id, installationId: f.builder.installationId,
            expectedRevision: f.environmentRevision, expectedTargetLinkRevision: f.link.revision });
        const method = `${f.builder.id}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
        const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
        const packet = { method, requestId, params: job, originalActionEnvelope: envelope,
            externalActionExecution: { v: 1 as const, authorization, effectActionId: 'deployments.deploy', target: envelope.target,
                installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.deploy', target: envelope.target, installationId: f.controller.installationId,
                    method, requestId, params: job, deploymentChildRouting, event: SOCKET_RPC_EVENTS.CALL,
                    privateKey: f.controller.keys.secretKey }) } };
        expect(await verifyExternalActionMachineRpcExecution(packet.externalActionExecution, packet)).not.toBeNull();
        const verifyRead = (path: string, routeInput?: unknown) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: authorization.token, effectActionId: 'deployments.deploy',
            encodedTarget: encodeExternalActionResolvedTargetV1(envelope.target), method: 'GET', path, routeInput, body: undefined,
            deploymentChildExecution: createDeploymentChildExecutionProofV1(packet),
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: 'deployments.deploy', target: envelope.target, installationId: f.builder.installationId,
                requestId: authorization.binding.requestId, method: 'GET', path, deploymentChildExecution: packet,
                privateKey: f.builder.keys.secretKey }),
        });
        const candidate = authorization.binding.deploymentCandidatePublication;
        if (!candidate) throw new Error('Preparation requires its minted candidate identity');
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const read = (id: string) => {
                const path = `/v1/artifacts/${id}`;
                return app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target),
                    [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target: envelope.target,
                        installationId: f.builder.installationId, requestId: authorization.binding.requestId,
                        method: 'GET', path, deploymentChildExecution: packet, privateKey: f.builder.keys.secretKey }),
                } });
            };
            // Candidate publication probes its exact issued identity before create,
            // then reopens the same head for CAS on a retained invocation.
            expect((await read(candidate.contentArtifactId)).statusCode).toBe(404);
            const source = await inTx(tx => readArtifactForCallerInTx(tx, {
                actorAccountId: f.account.id, artifactId: f.receipt.contentArtifactId }));
            if (!source.ok) throw new Error(source.error);
            const stored = source.artifact;
            const created = await createArtifact({ actorUserId: f.account.id, artifactId: candidate.contentArtifactId,
                kind: stored.kind ?? undefined, header: stored.header, body: stored.body,
                dataEncryptionKey: stored.dataEncryptionKey });
            if (!created.ok) throw new Error(created.error);
            const opened = await read(candidate.contentArtifactId);
            expect(opened.statusCode, opened.body).toBe(200);
            expect(opened.json()).toMatchObject({ id: candidate.contentArtifactId });
            expect((await read(crypto.randomUUID())).statusCode).toBe(401);
        }, { authentication: 'real' });
        const list = getActionSpec('deployments.receipts.list'), get = getActionSpec('deployments.receipts.get');
        if (!list.serverTransport || !get.serverTransport) throw new Error('Receipts require their canonical transports');
        for (const listInput of [{ serverId, environmentId: f.environment.id },
            { serverId, environmentId: f.environment.id, inProgressOnly: true }]) {
            const parsed = list.inputSchema.parse(listInput);
            const path = bindHomeDomainHttpRequestV1({ transport: list.serverTransport, inputSchema: list.inputSchema, input: parsed }).path;
            expect(await verifyRead(path, parsed)).not.toBeNull();
            expect(await verifyRead(path, { ...parsed, environmentId: crypto.randomUUID() })).toBeNull();
        }
        const receiptInput = get.inputSchema.parse({ serverId, environmentId: f.environment.id, deploymentId: f.receipt.id });
        const receiptPath = bindHomeDomainHttpRequestV1({ transport: get.serverTransport, inputSchema: get.inputSchema, input: receiptInput }).path;
        expect(await verifyRead(receiptPath, receiptInput)).not.toBeNull();
        expect(await verifyRead(`/v1/artifacts/${f.receipt.contentArtifactId}`)).not.toBeNull();
        expect(await verifyRead(`/v1/artifacts/${crypto.randomUUID()}`)).toBeNull();
    });

    it('admits semantic preparation only on the current selected builder without borrowing a receipt', async () => {
        const f = await fixture('team');
        const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id };
        const envelope = { ...f.originalActionEnvelope, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.deploy', machineId: f.controller.id, target: envelope.target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const job: DeploymentChildRpcV1 = { v: 1, kind: 'prepare', actionId: 'deployments.deploy', input,
            machineId: f.builder.id, installationId: f.builder.installationId,
            expectedRevision: environment.revision, expectedTargetLinkRevision: f.link.revision };
        const verify = (params: DeploymentChildRpcV1 = job) => {
            const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            return verifyExternalActionMachineRpcExecution({ v: 1, authorization, target: envelope.target,
                effectActionId: 'deployments.deploy', installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    target: envelope.target, effectActionId: 'deployments.deploy', installationId: f.controller.installationId,
                    method, requestId, params, deploymentChildRouting, privateKey: f.controller.keys.secretKey }) },
            { method, requestId, params, originalActionEnvelope: envelope });
        };
        const rootAdmissionReads: string[] = [];
        const destinationAdmissionReads: string[] = [];
        const stop = observeSqliteRequests({ before: query => {
            if (query.model && ['ApiToken', 'Session', 'AccessKey'].includes(query.model)) rootAdmissionReads.push(query.model);
            // Source status/Team checks remain destination authority; the root's Account currentness does not.
            if (query.model === 'Account' && /"(?:tokenEpoch|encryptionMode)"/u.test(JSON.stringify(query.args))) rootAdmissionReads.push(query.model);
            if (query.model === 'Machine' && /"operationProtocolCapabilities"/u.test(JSON.stringify(query.args))) {
                const args = query.args as { where?: { id?: { in?: string[] } } };
                if (args.where?.id?.in?.includes(f.controller.id)) rootAdmissionReads.push('controller-use');
                if (args.where?.id?.in?.includes(f.builder.id)) destinationAdmissionReads.push(query.action);
            }
        } });
        try {
            const verified = await verify();
            expect(verified?.deploymentChildAdmission).toBeDefined();
            if (!verified?.deploymentChildAdmission) throw new Error('Expected preparation child admission');
            expect(await readDeploymentChildMachineReadInTx(db, verified.deploymentChildAdmission, f.builder.id))
                .toMatchObject({ machineId: f.builder.id, installationId: f.builder.installationId,
                    codecAdmission: { actorAccountId: f.account.id, encryptionMode: 'plain' } });
        } finally { stop(); }
        // Root facts were admitted at mint; only the destination needs one requester Use/codec admission.
        expect.soft(rootAdmissionReads).toEqual([]);
        expect.soft(destinationAdmissionReads).toHaveLength(1);
        expect(await verify({ ...job, machineId: f.member.id, installationId: f.member.installationId })).toBeNull();
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: f.outsider.id }, data: { accountId: foreign.id } });
        expect(await resolveMachineAdmission({ actorAccountId: f.account.id, machineId: f.outsider.id, requiredRole: 'use' }))
            .toMatchObject({ kind: 'denied' });
        expect(await verify({ ...job, machineId: f.outsider.id, installationId: f.outsider.installationId })).toBeNull();
        expect(await verify({ ...job, expectedRevision: environment.revision + 1 })).toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await verify()).not.toBeNull();
        // Source custody can outlive the requester's Team membership. It does not grant requester Use of a foreign builder.
        await db.projectSource.update({ where: { id: f.environment.projectSourceId }, data: {
            audience: [{ principal: { kind: 'account', accountId: f.account.id }, level: 'view' }] } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { deployerMode: 'members' } });
        await db.machine.update({ where: { id: f.builder.id }, data: { accountId: foreign.id } });
        await db.teamMembership.create({ data: { teamId: f.team!.id, accountId: foreign.id, role: 'owner' } });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.account.id } } });
        expect(await resolveMachineAdmission({ actorAccountId: f.account.id, machineId: f.builder.id, requiredRole: 'use' }))
            .toMatchObject({ kind: 'denied' });
        expect(await verify()).toBeNull();
        await db.machineAccountGrant.create({ data: { machineId: f.builder.id, accountId: f.account.id,
            accessLevel: 'view', createdByAccountId: foreign.id } });
        expect(await verify()).not.toBeNull();
        // Credential withdrawal applies to the next mint, while the admitted finite child keeps its signed binding.
        await db.account.update({ where: { id: f.account.id }, data: { tokenEpoch: { increment: 1 } } });
        expect(await verify()).not.toBeNull();
        await db.machine.update({ where: { id: f.controller.id }, data: { installationId: crypto.randomUUID() } });
        expect(await verify()).toBeNull();
    });

    it('refuses a semantic root borrowing a receipt admitted by another root', async () => {
        const f = await fixture();
        const input = { serverId, environmentId: f.environment.id, targetLinkId: f.link.id };
        const envelope = { ...f.originalActionEnvelope, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.account.id, authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch },
            actionId: 'deployments.deploy', machineId: f.controller.id, target: envelope.target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const verify = (params: DeploymentChildRpcV1 = f.job) => {
            const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            return verifyExternalActionMachineRpcExecution({ v: 1, authorization, target: envelope.target,
                effectActionId: 'deployments.deploy', installationId: f.controller.installationId, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    target: envelope.target, effectActionId: 'deployments.deploy', installationId: f.controller.installationId,
                    method, requestId, params, deploymentChildRouting, privateKey: f.controller.keys.secretKey }) },
            { method, requestId, params, originalActionEnvelope: envelope });
        };
        expect(await f.verify()).not.toBeNull();
        expect(await verify()).toBeNull();
        expect(await verify({ ...f.job, input: { ...f.input, environmentId: 'another-environment' } })).toBeNull();
        expect(await verify({ ...f.job, input: { ...f.input, targetLinkId: 'another-link' } })).toBeNull();
        expect(await verify({ ...f.job, input: { ...f.input, contentArtifactId: f.environment.contentArtifactId } })).toBeNull();
        expect(await verify({ ...f.job, actionOperationId: 'another-operation' })).toBeNull();
    });

    it.each([false, true])('rechecks the retained signed child at the receiver currentness route (template: %s)', async templateRoot => {
        const f = await fixture('account', 'account', { templateRoot }), packet = f.rpc();
        const admitted = await resolveMachineAdmission({ actorAccountId: f.account.id, machineId: f.member.id, requiredRole: 'use' });
        if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
        const context = { actorAccountId: f.account.id, custodianAccountId: f.account.id, machineId: f.member.id,
            installationId: f.member.installationId, role: admitted.role, encryptionMode: admitted.encryptionMode };
        const body = { v: 1 as const, context, method: packet.method, callerInputAuthorization: f.authorization,
            workspaceSyncSourceExecution: { ...packet, externalActionExecution: packet.externalActionExecution } };
        const proof = signMachineInstallationProof({ payload: { version: 1, accountId: f.account.id, machineId: f.member.id,
            installationId: f.member.installationId, rpcAdmission: { context, method: body.method,
                callerInputAuthorization: f.authorization, workspaceSyncSourceExecution: body.workspaceSyncSourceExecution } }, privateKey: f.member.keys.secretKey });
        await withAuthenticatedTestApp(registerMachineAdmissionRoutes, async app => {
            const send = () => app.inject({ method: 'POST', url: `/v1/machines/${f.member.id}/admission/verify`,
                headers: { 'x-test-user-id': f.account.id }, payload: { ...body, proof } });
            expect((await send()).statusCode).toBe(200);
            await db.deploymentTargetLinkMachine.deleteMany({ where: { targetLinkId: f.link.id, machineId: f.member.id } });
            expect((await send()).statusCode).toBe(403);
        });
    });

    it.each([['machine', false], ['scoped-account', false], ['machine', true], ['scoped-account', true]] as const)(
        'forwards the opaque signed child through production socket wiring with the original root retained (%s, template: %s)', async (sender, templateRoot) => {
        const f = await fixture('account', 'account', { templateRoot });
        const request = f.rpc();
        const params = 'opaque-installation-sealed-job';
        const externalActionExecution = { ...request.externalActionExecution, machineSignature: signExternalActionMachineRpcRequestV1({
            authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy', target: f.authorization.binding.target,
            ...(f.reviewedChild ? { reviewedChild: f.reviewedChild } : {}),
            installationId: f.controller.installationId, method: request.method, requestId: request.requestId,
            params, deploymentChildRouting: request.externalActionExecution.deploymentChildRouting, privateKey: f.controller.keys.secretKey }) };
        const forwarded: unknown[] = [];
        const target = { id: 'deployment-receiver', data: { clientType: 'machine-scoped', machineId: f.member.id,
            verifiedMachineInstallationId: f.member.installationId }, timeout: () => ({ emitWithAck: async (_event: string, payload: unknown) => {
                forwarded.push(payload); return { accepted: true };
            } }) };
        qualifyCurrentAccountStoredContentSocket(target);
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${f.account.id}:${request.method}` || room === target.id ? [target] : []);
        const token = await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createAuthenticatedFakeSocket({ id: 'deployment-controller', data: {
            userId: f.account.id,
            ...(sender === 'machine' ? { clientType: 'machine-scoped', machineId: f.controller.id,
                verifiedMachineInstallationId: f.controller.installationId }
                : { clientType: 'user-scoped', clientPurpose: 'scoped-rpc' }),
            authTokenKind: 'account' } }), { handshake: { auth: { token } } });
        qualifyCurrentAccountStoredContentSocket(socket);
        registerSocketRpcHandlers({ userId: f.account.id, socket: socket as unknown as Socket, io });
        let result: unknown;
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...request, params, externalActionExecution },
            (value: unknown) => { result = value; });
        expect(result).toMatchObject({ ok: true, result: { accepted: true } });
        expect(forwarded).toMatchObject([{ params, callerInputAuthorization: f.authorization,
            originalActionEnvelope: f.originalActionEnvelope, workspaceSyncSourceExecution: { method: request.method,
                requestId: request.requestId, params, originalActionEnvelope: f.originalActionEnvelope, externalActionExecution } }]);
        // A signed controller packet does not turn a Session socket scope or
        // Machine identity into this controller's admitted child transport.
        const socketData = socket.data;
        if (!socketData) throw new Error('Expected authenticated socket data');
        if (sender === 'scoped-account') socketData.clientType = 'session-scoped';
        else socketData.machineId = f.outsider.id;
        const refusalRecords: Array<Record<string, unknown>> = [];
        const stream = (logger as unknown as { [symbols.streamSym]: DestinationStream })[symbols.streamSym];
        const output = vi.spyOn(stream, 'write').mockImplementation(message => { refusalRecords.push(JSON.parse(message)); });
        const level = logger.level;
        logger.level = 'warn';
        try {
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...request, params, externalActionExecution },
                (value: unknown) => { result = value; });
            expect(refusalRecords).toContainEqual(expect.objectContaining({ module: 'websocket-rpc', level: 40,
                phase: 'original_action_envelope', rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD }));
            expect(JSON.stringify(refusalRecords)).not.toContain(f.authorization.token);
            expect(JSON.stringify(refusalRecords)).not.toContain(params);
        } finally { logger.level = level; output.mockRestore(); }
        expect(result).toMatchObject({ ok: false });
        expect(forwarded).toHaveLength(1);
        if (sender === 'scoped-account') socketData.clientType = 'user-scoped';
        else socketData.machineId = f.controller.id;
        const forged = { ...externalActionExecution, machineSignature: signExternalActionMachineRpcRequestV1({
            authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy', target: f.authorization.binding.target,
            ...(f.reviewedChild ? { reviewedChild: f.reviewedChild } : {}),
            installationId: f.controller.installationId, method: request.method, requestId: request.requestId,
            params, deploymentChildRouting: request.externalActionExecution.deploymentChildRouting, privateKey: f.outsider.keys.secretKey }) };
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...request, params, externalActionExecution: forged },
            (value: unknown) => { result = value; });
        expect(result).toMatchObject({ ok: false });
        expect(forwarded).toHaveLength(1);
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...request, params: `${params}-changed`, externalActionExecution },
            (value: unknown) => { result = value; });
        expect(result).toMatchObject({ ok: false });
        expect(forwarded).toHaveLength(1);
        if (sender === 'scoped-account') {
            const other = await db.account.create({ data: { encryptionMode: 'plain' } });
            const otherToken = await auth.createToken(other.id, undefined, { kind: 'account', authority: 'present_user' });
            const otherSocket = Object.assign(createAuthenticatedFakeSocket({ id: 'another-account', data: {
                userId: other.id,
                clientType: 'user-scoped', clientPurpose: 'scoped-rpc', authTokenKind: 'account',
            } }), { handshake: { auth: { token: otherToken } } });
            qualifyCurrentAccountStoredContentSocket(otherSocket);
            registerSocketRpcHandlers({ userId: other.id, socket: otherSocket as unknown as Socket, io });
            await triggerSocketHandler(otherSocket, SOCKET_RPC_EVENTS.CALL, { ...request, params, externalActionExecution },
                (value: unknown) => { result = value; });
            expect(result).toMatchObject({ ok: false });
            expect(forwarded).toHaveLength(1);
        }
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...request, params, externalActionExecution },
            (value: unknown) => { result = value; });
        expect(result).toMatchObject({ ok: false });
        expect(forwarded).toHaveLength(1);
    });

    it('keeps finite holder admission on the receiver custodian without replacing the original Action requester', async () => {
        const f = await fixture('team');
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: f.member.id }, data: { accountId: custodian.id } });
        expect(await f.verify()).not.toBeNull();
        expect(await resolveMachineAdmission({ actorAccountId: custodian.id, machineId: f.builder.id, requiredRole: 'use' }))
            .not.toMatchObject({ kind: 'admitted' });
        const source = f.rpc();
        const packet = { method: source.method, requestId: source.requestId, params: source.params,
            originalActionEnvelope: source.originalActionEnvelope, externalActionExecution: source.externalActionExecution };
        const archiveOrigin = { environmentId: f.environment.id, deploymentId: f.receipt.id,
            holderMachineId: f.builder.id, holderInstallationId: f.builder.installationId };
        const deploymentChildExecution = createDeploymentChildExecutionProofV1(packet, archiveOrigin);
        const rpc = (effectActionId = 'daemon.filesystem.download', rpcMethod: string = RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD,
            privateKey = f.member.keys.secretKey) => {
            const method = `${f.builder.id}:${rpcMethod}`, requestId = crypto.randomUUID(), params = 'sealed-finite-request';
            const signing = { authorizationToken: f.authorization.token, effectActionId, target: f.authorization.binding.target,
                installationId: f.member.installationId, method, requestId, params, deploymentChildExecution: packet,
                deploymentArchiveOrigin: archiveOrigin, privateKey };
            const machineSignature = signExternalActionMachineRpcRequestV1(signing);
            if (privateKey === f.member.keys.secretKey) expect(verifyExternalActionMachineRpcRequestV1({
                ...signing, deploymentChildExecution, publicKey: f.member.keys.publicKey, signature: machineSignature })).toBe(true);
            return { method, requestId, params, originalActionEnvelope: f.originalActionEnvelope,
                externalActionExecution: { v: 1 as const, authorization: f.authorization, effectActionId,
                target: f.authorization.binding.target, installationId: f.member.installationId, deploymentChildExecution,
                machineSignature } };
        };
        const verify = (...args: Parameters<typeof rpc>) => {
            const packet = rpc(...args);
            return verifyExternalActionMachineRpcExecution(packet.externalActionExecution, packet);
        };
        expect(await verify()).toMatchObject({ principal: { accountId: f.account.id }, binding: f.authorization.binding,
            deploymentChildSigner: { machineId: f.member.id, installationId: f.member.installationId, custodianAccountId: custodian.id } });
        expect(() => rpc('daemon.filesystem.execute', 'daemon.filesystem.execute')).toThrow();
        expect(() => rpc('daemon.filesystem.copy', RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD)).toThrow();
        expect(await verify('daemon.filesystem.download', RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD, f.controller.keys.secretKey)).toBeNull();
        const request = rpc(), forwarded: unknown[] = [];
        const target = { id: 'archive-holder', data: { clientType: 'machine-scoped', machineId: f.builder.id,
            verifiedMachineInstallationId: f.builder.installationId }, timeout: () => ({ emitWithAck: async (_event: string, payload: unknown) => {
                forwarded.push(payload); return { accepted: true };
            } }) };
        qualifyCurrentAccountStoredContentSocket(target);
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${f.account.id}:${request.method}` || room === target.id ? [target] : []);
        const token = await auth.createToken(custodian.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const socket = Object.assign(createAuthenticatedFakeSocket({ id: 'archive-receiver', data: {
            userId: custodian.id,
            clientType: 'machine-scoped', machineId: f.member.id, verifiedMachineInstallationId: f.member.installationId,
            authTokenKind: 'terminal', authAuthority: 'account_automation' } }), { handshake: { auth: { token } } });
        qualifyCurrentAccountStoredContentSocket(socket);
        registerSocketRpcHandlers({ userId: custodian.id, socket: socket as unknown as Socket, io });
        let response: unknown;
        const finiteRequest = { method: request.method, requestId: request.requestId, params: request.params,
            externalActionExecution: request.externalActionExecution };
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, finiteRequest, (value: unknown) => { response = value; });
        expect(response).toMatchObject({ ok: true, result: { accepted: true } });
        expect(forwarded).toMatchObject([{ callerInputAuthorization: f.authorization, callerAuthority: 'account_automation',
            machineAdmission: { actorAccountId: custodian.id, custodianAccountId: f.account.id, machineId: f.builder.id, role: 'use' },
            workspaceSyncSourceExecution: { externalActionExecution: { deploymentChildExecution } } }]);
        const admittedChild = await readDeploymentChildAdmissionInTx(db, f.authorization.binding,
            source.externalActionExecution.deploymentChildRouting);
        if (!admittedChild) throw new Error('Expected the admitted child');
        const codec = await readDeploymentChildMachineReadInTx(db, admittedChild, f.builder.id);
        if (!codec) throw new Error('Expected the Source-granted holder codec');
        const context = { ...codec.codecAdmission, actorAccountId: custodian.id, role: 'use' as const };
        const holderPacket = { method: request.method, requestId: request.requestId, params: request.params,
            externalActionExecution: request.externalActionExecution };
        const body = { v: 1 as const, context, method: request.method, callerInputAuthorization: f.authorization,
            workspaceSyncSourceExecution: holderPacket };
        const proof = signMachineInstallationProof({ payload: { version: 1, accountId: f.account.id, machineId: f.builder.id,
            installationId: f.builder.installationId, rpcAdmission: { context, method: request.method,
                callerInputAuthorization: f.authorization, workspaceSyncSourceExecution: holderPacket } }, privateKey: f.builder.keys.secretKey });
        await withAuthenticatedTestApp(registerMachineAdmissionRoutes, async app => {
            const send = () => app.inject({ method: 'POST', url: `/v1/machines/${f.builder.id}/admission/verify`,
                headers: { 'x-test-user-id': f.account.id }, payload: { ...body, proof } });
            expect((await send()).statusCode).toBe(200);
            await db.machineTeamGrant.deleteMany({ where: { machineId: f.builder.id, teamId: f.team!.id } });
            // GRANT-U4: an accepted job retains its captured builder placement until its natural end.
            expect((await send()).statusCode).toBe(200);
            await db.machineTeamGrant.create({ data: { machineId: f.builder.id, teamId: f.team!.id,
                accessLevel: 'view', createdByAccountId: f.account.id } });
        });
        await db.machine.update({ where: { id: f.builder.id }, data: { installationId: crypto.randomUUID() } });
        expect(await verify()).toBeNull();
        await db.machine.update({ where: { id: f.builder.id }, data: { installationId: f.builder.installationId } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await verify()).toBeNull();
    });

    it('follows only immutable rollback archive origins rather than predecessor or unrelated receipts', async () => {
        const f = await fixture('team');
        const retained = async (rollbackOfDeploymentId?: string) => db.deployment.create({ data: {
            environmentId: f.environment.id, targetLinkId: f.link.id, operation: rollbackOfDeploymentId ? 'rollback' : 'deploy',
            state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: f.account.id,
            actionOperationId: crypto.randomUUID(), ...await f.content('deployment-receipt.v1'),
            ...(rollbackOfDeploymentId ? { rollbackOfDeploymentId } : {}),
        } });
        const archive = await retained(), selected = await retained(archive.id), unrelated = await retained();
        await db.deployment.update({ where: { id: selected.id }, data: { predecessorDeploymentId: unrelated.id } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: selected.id } });
        const routing = projectDeploymentChildRoutingV1({ ...f.job, phase: 'restore', selectedDeploymentId: selected.id });
        const read = async (deploymentId: string, environmentId = f.environment.id) => {
            const admittedChild = await readDeploymentChildAdmissionInTx(db, f.authorization.binding, routing);
            return admittedChild ? readDeploymentChildMachineReadInTx(db, admittedChild, f.builder.id, {}, { environmentId, deploymentId,
                holderMachineId: f.builder.id, holderInstallationId: f.builder.installationId }) : null;
        };
        expect(await isCurrentDeploymentChildInTx(db, f.authorization.binding, routing)).toBe(true);
        expect(await read(selected.id)).not.toBeNull();
        expect(await read(archive.id)).not.toBeNull();
        expect(await read(unrelated.id)).toBeNull();
        expect(await read(archive.id, 'another-environment')).toBeNull();
        await db.deployment.update({ where: { id: archive.id }, data: { rollbackOfDeploymentId: selected.id, operation: 'rollback' } });
        expect(await read('missing-origin')).toBeNull();
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.builder.id, teamId: f.team!.id } });
        expect(await read(archive.id)).not.toBeNull();
    });

    it('opens only the exact initial child codec under the retained controller proof', async () => {
        for (const credential of ['account', 'api'] as const) {
            const f = await fixture('team', credential);
            const candidates: DeploymentChildRpcV1[] = [f.job,
                { v: 1, kind: 'build', actionId: 'deployments.deploy', input: f.input,
                    machineId: f.builder.id, installationId: f.builder.installationId,
                    deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId},
                { v: 1, kind: 'review', actionId: 'deployments.deploy', input: { ...f.input, expectedRevision: f.environmentRevision },
                    machineId: f.member.id, installationId: f.member.installationId },
                { v: 1, kind: 'prepare', actionId: 'deployments.deploy',
                    input: { serverId, environmentId: f.environment.id, targetLinkId: f.link.id },
                    expectedRevision: f.environmentRevision, expectedTargetLinkRevision: f.link.revision,
                    machineId: f.builder.id, installationId: f.builder.installationId },
                { ...f.job, phase: 'cleanup' }];
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                for (const job of candidates) {
                    // P40-7 producer owed: auth.ts derives the scoped Environment
                    // only from prepared refs, not this semantic intent. RED68658
                    // rejects at mint before HTTP; do not fabricate an admitted root.
                    if (credential === 'api' && job.kind === 'prepare') continue;
                    const originalActionEnvelope = { ...f.originalActionEnvelope, input: job.input };
                    const binding = f.authorization.binding;
                    const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                        accountId: f.account.id, ...('authentication' in binding ? { authentication: binding.authentication }
                            : { principalId: binding.principalId, credentialId: binding.credentialId, grant: binding.grant }),
                        actionId: 'deployments.deploy', machineId: f.controller.id, target: originalActionEnvelope.target,
                        requestId: originalActionEnvelope.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope) }, { input: job.input });
                    const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
                    const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
                    const source = { method, requestId, params: job, originalActionEnvelope, externalActionExecution: {
                        v: 1 as const, authorization, effectActionId: 'deployments.deploy', target: binding.target,
                        installationId: f.controller.installationId, deploymentChildRouting,
                        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                            effectActionId: 'deployments.deploy', target: binding.target, installationId: f.controller.installationId,
                            method, requestId, params: job, deploymentChildRouting, privateKey: f.controller.keys.secretKey }) } };
                    const send = (machineId = job.machineId, privateKey = f.controller.keys.secretKey,
                        installationId = f.controller.installationId) => {
                        const path = `/v1/machines/${machineId}`;
                        return app.inject({ method: 'GET', url: path, headers: {
                            ...currentAccountStoredContentCompatibilityHeaders,
                            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(binding.target),
                            [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(source),
                            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                                authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target: binding.target,
                                installationId, requestId: binding.requestId, deploymentChildExecution: source,
                                method: 'GET', path, body: undefined, privateKey }),
                        } });
                    };
                    expect((await send()).statusCode).toBe(200);
                    expect((await send(f.outsider.id)).statusCode).toBe(401);
                    expect((await send(job.machineId, f.outsider.keys.secretKey)).statusCode).toBe(401);
                    expect((await send(job.machineId, f.controller.keys.secretKey, 'retired-source-installation')).statusCode).toBe(401);
                    await db.machineTeamGrant.deleteMany({ where: { machineId: job.machineId, teamId: f.team!.id } });
                    expect((await send()).statusCode).toBe(job.kind === 'prepare' || job.kind === 'review' ? 401 : 200);
                    await db.machineTeamGrant.create({ data: { machineId: job.machineId, teamId: f.team!.id,
                        accessLevel: 'view', createdByAccountId: f.account.id } });
                }
            }, { authentication: 'real' });
        }
    });

    it('does not promote the receiver key into the controller root HTTP signer', async () => {
        const f = await fixture();
        const body = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
            actionOperationId: f.receipt.actionOperationId, expectedRevision: f.receipt.revision,
            machineId: f.member.id, installationId: f.member.installationId, kind: 'stage' as const, state: 'running' as const };
        const path = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
        const verify = async (kind: 'stage' | 'settle' = 'stage') => {
            const candidate = { ...body, kind };
            const input = { ...candidate, proof: signMachineInstallationProof({ payload: { version: 1, accountId: f.account.id,
                machineId: f.member.id, installationId: f.member.installationId, deploymentTransition: { serverId,
                    environmentId: f.environment.id, deploymentId: f.receipt.id, actionOperationId: f.receipt.actionOperationId,
                    expectedRevision: f.receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(candidate) } }, privateKey: f.member.keys.secretKey }) };
            return verifyExternalActionDomainExecutionRequest({ authorizationToken: f.authorization.token,
                effectActionId: 'deployments.deploy', encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                method: 'POST', path, body: input, machineSignature: signExternalActionMachineRequestV1({
                    authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy', target: f.authorization.binding.target,
                    installationId: f.controller.installationId, requestId: f.authorization.binding.requestId,
                    method: 'POST', path, body: input, privateKey: f.member.keys.secretKey }) });
        };
        expect(await verify()).toBeNull();
        expect(await verify('settle')).toBeNull();
        await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await verify()).toBeNull();
    });

    it('mints only the retained receiver finite carrier for a Source Team archive', async () => {
        const f = await fixture('team', 'api');
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const holderCustodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: f.member.id }, data: { accountId: custodian.id } });
        await db.machine.update({ where: { id: f.builder.id }, data: { accountId: holderCustodian.id } });
        const endpointId = 'a'.repeat(64);
        await db.machine.update({ where: { id: f.builder.id }, data: { operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId } } } });
        const packet = f.rpc();
        expect(await f.verify()).not.toBeNull();
        const archiveOrigin = { environmentId: f.environment.id, deploymentId: f.receipt.id,
            holderMachineId: f.builder.id, holderInstallationId: f.builder.installationId };
        const body = DirectRouteGrantRequestV2Schema.parse({ v: 2, kind: 'ephemeral_ed25519', machineId: f.builder.id,
            ephemeralPublicKeyBase64Url: encodeBase64(nacl.sign.keyPair().publicKey, 'base64url'),
            flowKind: 'bounded_transfer', routeKind: 'iroh_peer', endpointFingerprint: endpointId,
            ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier, scope: { kind: 'bounded_transfer', mode: 'carrier' },
            iroh: { initiator: { kind: 'account_client', endpointId: 'b'.repeat(64) },
                target: { machineId: f.builder.id, endpointId }, operationKind: 'finite_transfer' } });
        const path = '/v1/machines/peer/mediation/route-grants';
        const headers = {
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
            [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet, archiveOrigin),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.member.installationId,
                requestId: f.authorization.binding.requestId, deploymentChildExecution: packet, deploymentArchiveOrigin: archiveOrigin,
                method: 'POST', path, body, privateKey: f.member.keys.secretKey }),
        };
        expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: f.authorization.token,
            machineSignature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], effectActionId: 'deployments.deploy',
            encodedTarget: headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER], method: 'POST', path, body, routeInput: body,
            deploymentChildExecution: createDeploymentChildExecutionProofV1(packet, archiveOrigin) })).toMatchObject({
            principal: { accountId: f.account.id }, deploymentChildSigner: { custodianAccountId: custodian.id },
            deploymentChildMachineRead: { machineId: f.builder.id } });
        await withAuthenticatedTestApp(app => {
            registerPeerMediationGrantRoutes(app, { env: harness.envBase });
            app.addHook('preSerialization', async (request: FastifyRequest, _reply: FastifyReply, payload: unknown) => {
                if (request.externalActionExecutionAuthorized) {
                    expect(request.userId).toBe(f.account.id);
                    expect(request.apiTokenPrincipal?.accountId).toBe(f.account.id);
                }
                return payload;
            });
        }, async app => {
            const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const ordinary = await app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${token}` }, payload: body });
            expect(ordinary.json()).not.toMatchObject({ ok: true });
            const mixed = await app.inject({ method: 'POST', url: path, headers: { ...headers, authorization: `Bearer ${token}` }, payload: body });
            expect(mixed.statusCode, mixed.body).toBe(403);
            expect(mixed.json()).toEqual({ error: 'credential_scope_denied', authorizationRefusal: 'proof_shape' });
            const send = (payload: unknown = body) => app.inject({ method: 'POST', url: path, headers, payload });
            const admitted = await send();
            expect(admitted.statusCode).toBe(200);
            expect(admitted.json()).toMatchObject({ ok: true, grant: { payload: { accountId: custodian.id,
                machineId: f.builder.id, flowKind: 'bounded_transfer', scope: { kind: 'bounded_transfer', mode: 'carrier' },
                iroh: body.iroh } } });
            expect((await send({ ...body, ephemeralPublicKeyBase64Url: encodeBase64(nacl.sign.keyPair().publicKey, 'base64url') })).statusCode).toBe(401);
            const receiverSignature = (path: string, privateKey = f.member.keys.secretKey) => signExternalActionMachineRequestV1({
                authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy', target: f.authorization.binding.target,
                installationId: f.member.installationId, requestId: f.authorization.binding.requestId,
                deploymentChildExecution: packet, deploymentArchiveOrigin: archiveOrigin,
                method: 'POST', path, body, privateKey });
            expect((await app.inject({ method: 'POST', url: path, payload: body, headers: { ...headers,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: receiverSignature(path, f.controller.keys.secretKey) } })).statusCode).toBe(401);
            const wrongPath = '/v1/machines/peer/mediation/not-the-grant-route';
            expect((await app.inject({ method: 'POST', url: path, payload: body, headers: { ...headers,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: receiverSignature(wrongPath) } })).statusCode).toBe(401);
            await db.machine.update({ where: { id: f.member.id }, data: { installationId: crypto.randomUUID() } });
            expect((await send()).statusCode).toBe(401);
            await db.machine.update({ where: { id: f.member.id }, data: { installationId: f.member.installationId } });
            await db.machine.update({ where: { id: f.builder.id }, data: { installationId: crypto.randomUUID() } });
            expect((await send()).statusCode).toBe(401);
            await db.machine.update({ where: { id: f.builder.id }, data: { installationId: f.builder.installationId } });
            const another = await fixture('team', 'api');
            expect((await app.inject({ method: 'POST', url: path, headers: { ...headers,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: another.authorization.token }, payload: body })).statusCode).toBe(401);
            await db.machineTeamGrant.deleteMany({ where: { machineId: f.builder.id, teamId: f.team!.id } });
            expect((await send()).json()).toMatchObject({ ok: true });
        }, { authentication: 'real' });
    });

    it('opens only the original admitted codec for a Source Team holder while retaining the real receiver actor', async () => {
        const f = await fixture('team', 'api');
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: f.member.id }, data: { accountId: custodian.id } });
        const source = f.rpc();
        const packet = { method: source.method, requestId: source.requestId, params: source.params,
            originalActionEnvelope: source.originalActionEnvelope, externalActionExecution: source.externalActionExecution };
        expect(await f.verify()).not.toBeNull();
        const send = (app: Parameters<Parameters<typeof withAuthenticatedTestApp>[1]>[0], machineId: string,
            archiveOrigin?: Readonly<{ environmentId: string; deploymentId: string; holderMachineId: string; holderInstallationId: string }>) => {
            const path = `/v1/machines/${machineId}`;
            return app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet, archiveOrigin),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                    effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.member.installationId,
                    requestId: f.authorization.binding.requestId, deploymentChildExecution: packet, deploymentArchiveOrigin: archiveOrigin, method: 'GET', path,
                    body: undefined, privateKey: f.member.keys.secretKey }),
            } });
        };
        await withAuthenticatedTestApp(app => {
            machinesRoutes(app);
            app.addHook('preSerialization', async (request: FastifyRequest, _reply: FastifyReply, payload: unknown) => {
                if (request.externalActionExecutionAuthorized) {
                    expect(request.userId).toBe(f.account.id);
                    expect(request.apiTokenPrincipal?.accountId).toBe(f.account.id);
                }
                return payload;
            });
        }, async app => {
            const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await app.inject({ method: 'GET', url: `/v1/machines/${f.builder.id}`, headers: {
                ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` } })).statusCode).toBe(404);
            expect((await send(app, f.builder.id)).statusCode).toBe(200);
            const origin = { environmentId: f.environment.id, deploymentId: f.receipt.id,
                holderMachineId: f.builder.id, holderInstallationId: f.builder.installationId };
            expect((await send(app, f.builder.id, origin)).statusCode).toBe(200);
            const unrelated = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
                operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: f.account.id,
                actionOperationId: crypto.randomUUID(), ...await f.content('deployment-receipt.v1') } });
            expect((await send(app, f.builder.id, { ...origin, deploymentId: unrelated.id })).statusCode).not.toBe(200);
            const foreignCustodian = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.machine.update({ where: { id: f.outsider.id }, data: { accountId: foreignCustodian.id } });
            const foreignOrigin = { ...origin, holderMachineId: f.outsider.id, holderInstallationId: f.outsider.installationId };
            expect((await send(app, f.outsider.id, foreignOrigin)).statusCode).not.toBe(200);
            await db.machineTeamGrant.create({ data: { machineId: f.outsider.id, teamId: f.team!.id,
                accessLevel: 'view', createdByAccountId: f.account.id } });
            expect((await send(app, f.outsider.id)).statusCode).not.toBe(200);
            expect((await send(app, f.outsider.id, foreignOrigin)).statusCode).toBe(200);
            await db.machine.update({ where: { id: f.outsider.id }, data: { installationId: crypto.randomUUID() } });
            expect((await send(app, f.outsider.id, foreignOrigin)).statusCode).not.toBe(200);
            await db.machineTeamGrant.deleteMany({ where: { machineId: f.outsider.id, teamId: f.team!.id } });
            // Personal ownership cannot replace the Source Team's actual holder grant.
            expect((await send(app, f.outsider.id)).statusCode).not.toBe(200);
            await db.machineTeamGrant.deleteMany({ where: { machineId: f.builder.id, teamId: f.team!.id } });
            expect((await send(app, f.builder.id)).statusCode).toBe(200);
            await db.machineTeamGrant.create({ data: { machineId: f.builder.id, teamId: f.team!.id,
                accessLevel: 'view', createdByAccountId: f.account.id } });
            await db.account.update({ where: { id: f.account.id }, data: { status: 'suspended' } });
            // O1: the admitted receipt outlives requester credential withdrawal.
            expect((await send(app, f.builder.id)).statusCode).toBe(200);
            await db.account.update({ where: { id: f.account.id }, data: { status: 'active' } });
            await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
            expect((await send(app, f.builder.id)).statusCode).not.toBe(200);
        }, { authentication: 'real' });
    });

    it('reads only selected runtime lineage Artifacts rather than unrelated runtime links', async () => {
        const f = await fixture();
        const predecessorContent = await f.content('deployment-target-link.v1');
        const predecessorArtifact = predecessorContent.contentArtifactId;
        const predecessor = await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id,
            createdByAccountId: f.account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'old-runtime', targetKind: 'ownServer', state: 'configured',
            ...predecessorContent } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { predecessorTargetLinkId: predecessor.id } });
        const routing = projectDeploymentChildRoutingV1(f.job);
        expect(await isDeploymentChildHttpPurposeInTx(db, routing, { method: 'GET', body: undefined,
            path: `/v1/artifacts/${predecessorArtifact}` })).toBe(true);
        const unrelatedContent = await f.content('deployment-target-link.v1');
        const unrelatedArtifact = unrelatedContent.contentArtifactId;
        await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id, createdByAccountId: f.account.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'unrelated', targetKind: 'ownServer', state: 'configured',
            ...unrelatedContent } });
        expect(await isDeploymentChildHttpPurposeInTx(db, routing, { method: 'GET', body: undefined,
            path: `/v1/artifacts/${unrelatedArtifact}` })).toBe(false);
    });

    it('reads an admitted child receipt over real HTTP with the signed GET proof in the POST read carrier', async () => {
        const { encodeExternalActionHttpBodyV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
        const f = await fixture('team', 'account', { templateRoot: true });
        const packet = f.rpc();
        const path = `/v1/deployments/receipts/${f.receipt.id}?serverId=${encodeURIComponent(serverId)}&environmentId=${f.environment.id}`;
        const headers = {
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
            [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(packet),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy',
                target: f.authorization.binding.target, installationId: f.member.installationId,
                requestId: f.authorization.binding.requestId, deploymentChildExecution: packet,
                method: 'GET', path, privateKey: f.member.keys.secretKey }),
        };
        const frame = encodeExternalActionHttpBodyV1(headers, undefined);
        if (!frame) throw new Error('Expected signed read frame');
        let started = 0, completed = 0;
        await withAuthenticatedTestApp(app => {
            app.addHook('onRequest', async () => { started++; });
            app.addHook('onResponse', async () => { completed++; });
            registerDeploymentRoutes(app);
        }, async app => {
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            const legacy = await fetch(`${origin}${path}`, { headers });
            expect(legacy.status, await legacy.text()).toBe(200);
            const before = { started, completed };
            const read = await fetch(`${origin}${path}`, { method: 'POST',
                headers: { 'content-type': 'application/json', 'x-happier-action-body': 'get-v1' }, body: JSON.stringify(frame) });
            const result: unknown = await read.json();
            expect(read.status, JSON.stringify(result)).toBe(200);
            expect(result).toMatchObject({ ok: true, deployment: { id: f.receipt.id, environmentId: f.environment.id } });
            expect({ started: started - before.started, completed: completed - before.completed }).toEqual({ started: 1, completed: 1 });
            const tampered = await fetch(`${origin}${path}&substituted=true`, { method: 'POST',
                headers: { 'content-type': 'application/json', 'x-happier-action-body': 'get-v1' }, body: JSON.stringify(frame) });
            expect(tampered.status, await tampered.text()).toBe(401);
            for (const payload of [{ ...frame, body: {} }, { ...frame, unexpected: true }]) {
                const malformed = await fetch(`${origin}${path}`, { method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-happier-action-body': 'get-v1' }, body: JSON.stringify(payload) });
                expect(malformed.status, await malformed.text()).toBe(400);
            }
            const unmarked = await fetch(`${origin}${path}`, { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame) });
            expect(unmarked.status, await unmarked.text()).toBe(404);
        }, { authentication: 'real' });
    });

    it.each([false, true])('retains the scoped API root through the signed source packet for receiver HTTP stage currentness and secret materialization (template: %s)', async templateRoot => {
        const f = await fixture('team', 'api', { templateRoot });
        const source = f.rpc();
        const sourcePacket = { method: source.method, requestId: source.requestId, params: source.params,
            externalActionExecution: source.externalActionExecution, originalActionEnvelope: source.originalActionEnvelope };
        const deploymentChildExecution = projectDeploymentChildExecutionProofV1(sourcePacket);
        const path = `/v1/deployments/environments/${f.environment.id}/deployments/${f.receipt.id}/transitions`;
        const signed = (kind: 'stage' | 'settle' = 'stage', operationId = f.receipt.actionOperationId) => {
            const body = { serverId, environmentId: f.environment.id, deploymentId: f.receipt.id,
                actionOperationId: operationId, expectedRevision: f.receipt.revision, machineId: f.member.id,
                installationId: f.member.installationId, kind, state: 'running' as const };
            const input = { ...body, proof: signMachineInstallationProof({ payload: { version: 1, accountId: f.account.id,
                machineId: f.member.id, installationId: f.member.installationId, deploymentTransition: { serverId,
                    environmentId: f.environment.id, deploymentId: f.receipt.id, actionOperationId: operationId,
                    expectedRevision: f.receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: f.member.keys.secretKey }) };
            const machineSignature = signExternalActionMachineRequestV1({
                authorizationToken: f.authorization.token, effectActionId: 'deployments.deploy', target: f.authorization.binding.target,
                installationId: f.member.installationId, requestId: f.authorization.binding.requestId,
                deploymentChildExecution: sourcePacket, method: 'POST', path, body: input, privateKey: f.member.keys.secretKey });
            return { input, proof: { authorizationToken: f.authorization.token,
                effectActionId: 'deployments.deploy', encodedTarget: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                deploymentChildExecution, method: 'POST', path, body: input, machineSignature }, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: f.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: machineSignature,
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: encodeDeploymentChildExecutionV1(sourcePacket),
            } };
        };
        const verify = (kind: 'stage' | 'settle' = 'stage', operationId = f.receipt.actionOperationId) =>
            verifyExternalActionDomainExecutionRequest(signed(kind, operationId).proof);
        expect(await verify()).toMatchObject({ binding: f.authorization.binding,
            principal: { authority: 'account_automation' } });
        expect(await verify('settle')).toBeNull();
        expect(await verify('stage', 'substituted-operation')).toBeNull();
        // A participant publishes only after the controller has started the parent.
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'running' } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const stage = signed();
            expect((await app.inject({ method: 'POST', url: path, headers: stage.headers, payload: stage.input })).statusCode).toBe(200);
            const settle = signed('settle');
            expect((await app.inject({ method: 'POST', url: path, headers: settle.headers, payload: settle.input })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: path, headers: { ...stage.headers,
                [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: 'invalid' }, payload: stage.input })).statusCode).toBe(401);
            const secretPath = `/v1/deployments/environments/${f.environment.id}/secret-launch-admission`;
            const materialize = (actionOperationId = f.receipt.actionOperationId) => {
                const body = EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ serverId, environmentId: f.environment.id,
                    targetLinkId: f.link.id, machineId: f.member.id, installationId: f.member.installationId,
                    materialization: { kind: 'deployment', deploymentId: f.receipt.id, actionOperationId } });
                const payload = EnvironmentSecretLaunchAdmissionInputV1Schema.parse({ ...body,
                    proof: signMachineInstallationProof({ payload: { version: 1, accountId: f.account.id,
                        machineId: f.member.id, installationId: f.member.installationId,
                        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                        privateKey: f.member.keys.secretKey }) });
                return app.inject({ method: 'POST', url: secretPath, payload, headers: { ...stage.headers,
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: f.authorization.token,
                        effectActionId: 'deployments.deploy', target: f.authorization.binding.target, installationId: f.member.installationId,
                        requestId: f.authorization.binding.requestId, deploymentChildExecution: sourcePacket,
                        method: 'POST', path: secretPath, body: payload, privateKey: f.member.keys.secretKey }) } });
            };
            const materialized = await materialize();
            expect(materialized.statusCode, materialized.body).toBe(200);
            expect(materialized.json()).toMatchObject({ ok: true, grants: [] });
            expect((await materialize('substituted-operation')).statusCode).toBe(401);
            await db.deployment.update({ where: { id: f.receipt.id }, data: { cancelRequestedAt: new Date() } });
            expect((await materialize()).statusCode).toBe(401);
        }, { authentication: 'real' });
        expect(await verify()).toBeNull();
    });
});
