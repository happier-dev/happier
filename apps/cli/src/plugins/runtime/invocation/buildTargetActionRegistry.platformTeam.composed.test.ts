import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { createDeploymentTargetRoleAdmissionFixture } from '@/deployments/targets/deploymentTargetRoleAdmission.testkit';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, ARTIFACT_PLAIN_DATA_KEY_MARKER, decodeBase64 } from '@happier-dev/protocol';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';

describe('Team platform Home operation binding', () => {
    it.each(['recipient', 'ungranted-source-owner'] as const)('binds signed Home material to the accepted deploy receipt (%s)', async actor => {
        const { createLightSqliteHarness, createAccountTokenForTests } = await import('../../../../../../apps/server/sources/testkit/lightSqliteHarness');
        const { createAuthenticatedTestApp } = await import('../../../../../../apps/server/sources/app/api/testkit/sqliteFastify');
        const { registerTeamCredentialResourceRoutes } = await import('../../../../../../apps/server/sources/app/teams/credentials/registerTeamCredentialResourceRoutes');
        const { registerPluginAvailabilityRoutes } = await import('../../../../../../apps/server/sources/app/plugins/availability/routes');
        const { registerExternalActionRoutes } = await import('../../../../../../apps/server/sources/app/api/routes/actions/registerExternalActionRoutes');
        const { registerDeploymentRoutes } = await import('../../../../../../apps/server/sources/app/api/routes/deployments/deploymentRoutes');
        const { createExternalActionAuthorizedRequestHeaders } = await import('@/api/externalActionExecutionAuthorization');
        const { readDeploymentAcceptedExecution, deploymentAcceptedExecutionColumns } = await import('../../../../../../apps/server/sources/app/deployments/deploymentAcceptedExecution');
        const { setEligibleMachineAccessGrantInTx } = await import('../../../../../../apps/server/sources/testkit/machineAccessGrant.testkit');
        const { createArtifact } = await import('../../../../../../apps/server/sources/app/artifacts/artifactWriteService');
        const { ExternalActionExecutionAuthorizationV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
        const { registerAccountEncryptionRoutes } = await import('../../../../../../apps/server/sources/app/api/routes/account/registerAccountEncryptionRoutes');
        const { upsertTeamCredentialRecipientMaterialInTx } = await import('../../../../../../apps/server/sources/app/teams/credentials/recipientMaterial');
        const { createServiceAccountTokenIdentityFields } = await import('../../../../../../apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity');
        const { db } = await import('../../../../../../apps/server/sources/storage/db');
        const { inTx } = await import('../../../../../../apps/server/sources/storage/inTx');
        const { getOrCreateServerIdentityId } = await import('../../../../../../apps/server/sources/app/serverIdentity/serverIdentity');
        const { computeTeamCredentialConnectedAccountSourceVersionV1, computeTeamCredentialSourceMemberKeyV1,
            createTeamCredentialDirectMaterialStoredV1, TeamCredentialDirectMaterialMineResponseV1Schema, TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1 } = await import('@happier-dev/protocol/teams');
        const { computeCanonicalDomainSeparatedDigest } = await import('@happier-dev/protocol');
        const vercel = await import('../../../../../../packages/plugins/deploy-vercel/src/index.js');
        const vercelAccount = await import('../../../../../../packages/plugins/machine-vercel/src/index.js');
        const home = await createLightSqliteHarness({ tempDirPrefix: 'platform-team-operation-', initAuth: true, initEncrypt: true, env: {
            HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
            HAPPIER_SERVER_IDENTITY_ID: 'srv_platform_team_public_deploy_fixture',
        } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        try {
            const custodian = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
            const recipient = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
            const team = await db.team.create({ data: { name: 'Platform operation Team' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
            const githubManifest = normalizePluginManifestV2(vercelAccount.manifest);
            const descriptor = githubManifest.contributes.connectedAccountDescriptors[0]!;
            const account = { service: { pluginId: githubManifest.id, localId: descriptor.id }, accountId: 'team-source' };
            const revision = 'csr_cccccccccccccccccccccc';
            const contributionVersion = 'platform-operation-contract';
            const sourceCredential = await db.serviceAccountToken.create({ data: { accountId: custodian.id,
                ...createServiceAccountTokenIdentityFields({ ref: account, authenticationModeId: descriptor.authentication.defaultModeId }),
                token: Buffer.from('source-owned-storage'), metadata: { v: 4, storage: 'stored_envelope_v1', credentialRevision: revision,
                    directExportContract: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
                    contributionContractVersion: contributionVersion, values: { scopes: [] } },
            } });
            const resource = await db.teamCredentialResource.create({ data: { teamId: team.id, custodianAccountId: custodian.id,
                displayName: 'Team platform credential', disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed',
                sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_account', target: { kind: 'account', account }, credentialIncarnation: sourceCredential.id }),
                memberGrants: { create: { teamMembershipId: member.id, deliveryMode: 'direct' } },
            } });
            const sourceMember = { kind: 'connected_account' as const, service: account.service, connectedAccountId: account.accountId };
            const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
            const sourceVersion = computeTeamCredentialConnectedAccountSourceVersionV1({ sourceAccountId: account.accountId,
                credentialIncarnation: sourceCredential.id, sourceMember, credentialRevision: revision, configurationRevision: null,
                authenticationModeId: descriptor.authentication.defaultModeId, contributionContractVersion: computeCanonicalDomainSeparatedDigest(
                    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1, [contributionVersion]),
            });
            const storedMaterial = createTeamCredentialDirectMaterialStoredV1({ recipientMode: 'plain', payload: {
                v: 1, domain: 'happier.team-credential-direct-material', homeServerIdentityId: await getOrCreateServerIdentityId(process.env),
                teamId: team.id, resourceId: resource.id, resourceRevision: resource.revision, recipientAccountId: recipient.id,
                sourceMember, sourceVersion, material: { kind: 'qualified_connected_account', credential: { v: 1, values: { token: 'team-operation-secret' } },
                    configuration: null, authenticationModeId: descriptor.authentication.defaultModeId },
            } });
            expect(await inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, { actorAccountId: custodian.id,
                resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey, sourceVersion, recipientMode: 'plain',
                recipientContentPublicKeyFingerprint: null, stored: storedMaterial, expectedResourceRevision: resource.revision,
                expectedStoredSourceVersion: null, expectedPublishedSourceVersion: null }))).toMatchObject({ ok: true });
            registerTeamCredentialResourceRoutes(app);
            registerAccountEncryptionRoutes(app);
            registerPluginAvailabilityRoutes(app);
            registerExternalActionRoutes(app);
            const actorAccountId = actor === 'recipient' ? recipient.id : custodian.id;
            const token = await createAccountTokenForTests(actorAccountId, { kind: 'account', authority: 'present_user' });
            const homeIdentity = await getOrCreateServerIdentityId(process.env);
            const identityPair = nacl.sign.keyPair();
            await db.machine.create({ data: { id: 'controller', accountId: custodian.id, active: true,
                metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'controller', platform: 'linux',
                    happyCliVersion: '0.3.0', homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' })),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                installationId: 'installation-controller', installationPublicKey: identityPair.publicKey,
                operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } } } });
            if (actorAccountId !== custodian.id) expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: 'controller', principal: { kind: 'account', accountId: actorAccountId }, level: 'admin' })))
                .toMatchObject({ kind: 'saved' });
            const { DeploymentReceiptResultV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
            const { createDeploymentReceiptHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
            const pluginId = vercel.manifest.id;
            const fixture = createDeploymentTargetRoleAdmissionFixture('deploy');
            const environment = fixture.state.environment;
            const selected = environment.targetLinks[0]!;
            const principal = { kind: 'team' as const, teamId: team.id,
                purpose: { consumer: { pluginId, localId: 'project-link' }, purpose: 'deploy.manage' },
                selection: { source: 'team_resource' as const, resourceId: resource.id, deliveryMode: 'direct' as const, disclosedMember: account } };
            environment.environment.owner = { kind: 'account', accountId: actorAccountId };
            selected.targetLink.source = { kind: 'plugin', contribution: { pluginId, localId: 'runtime' } };
            selected.targetLink.targetKind = 'vercel';
            selected.targetLink.createdByAccountId = actorAccountId;
            selected.targetLink.machineId = 'controller';
            selected.targetLink.installationId = 'installation-controller';
            const preparedNative = { projectName: 'team-app', gitSource: { type: 'github', repoId: '42' } };
            const repositoryAccess = { status: 'ready', repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } };
            selected.content = { credentialPrincipal: principal,
                providerIdentity: { providerAccountId: 'team-provider', providerResourceId: 'prj-team', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, preparedNative, repositoryAccess };
            // Home's real execution issuer reads the same Environment/Source authority.
            expect(await createArtifact({ actorUserId: actorAccountId, artifactId: environment.environment.contentArtifactId,
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Team deploy' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(environment.content) })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
            await db.projectSource.create({ data: { id: environment.environment.projectSourceId, name: 'Reviewed repository',
                createdByAccountId: actorAccountId, audience: [], attachments: [], repository: { protocol: 'https',
                    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } } });
            await db.deploymentEnvironment.create({ data: { id: environment.environment.id,
                projectSourceId: environment.environment.projectSourceId, createdByAccountId: actorAccountId,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'controller',
                contentArtifactId: environment.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const receipt = createDeploymentReceiptHeaderV1({ ...fixture.state.receipt.deployment,
                actionOperationId: 'team-deploy-operation', requestKey: 'team-deploy-request', requestedByAccountId: actorAccountId });
            const receiptContent = { ...fixture.state.receipt.content, platform: {
                ...fixture.state.receipt.content.platform, ...selected.content, targetLinkRevision: selected.targetLink.revision,
            } };
            // Persist the Link and receipt artifact, then let Home's real signed
            // receipt route create the accepted operation; no admitted-row stub.
            for (const [artifactId, kind, content] of [
                [selected.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, selected.content],
                [receipt.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receiptContent],
            ] as const) {
                expect(await createArtifact({ actorUserId: actorAccountId, artifactId,
                    header: decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Team deploy' })),
                    body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
                    dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
            }
            await db.deploymentTargetLink.create({ data: { id: selected.targetLink.id,
                environmentId: environment.environment.id, revision: selected.targetLink.revision,
                role: 'runtime', sourceKind: 'plugin', pluginId, contributionLocalId: 'runtime', targetKind: 'vercel',
                state: selected.targetLink.state, machineId: 'controller', installationId: 'installation-controller',
                createdByAccountId: actorAccountId, contentArtifactId: selected.targetLink.contentArtifactId,
                contentHeaderVersion: selected.targetLink.contentHeaderVersion, contentBodyVersion: selected.targetLink.contentBodyVersion } });
            await db.deploymentEnvironment.update({ where: { id: environment.environment.id },
                data: { runtimeTargetLinkId: selected.targetLink.id } });
            registerDeploymentRoutes(app);
            const input = DeploymentDeployInputV1Schema.parse({ serverId: 'home', environmentId: environment.environment.id,
                expectedRevision: environment.environment.revision, targetLinkId: selected.targetLink.id,
                expectedTargetLinkRevision: selected.targetLink.revision, requestKey: receipt.requestKey,
                contentArtifactId: receipt.contentArtifactId, contentHeaderVersion: receipt.contentHeaderVersion, contentBodyVersion: receipt.contentBodyVersion });
            const path = `/v1/deployments/environments/${environment.environment.id}/deploy`;
            const body = { ...input, serverId: homeIdentity, actionOperationId: receipt.actionOperationId };
            const minted = await app.inject({ method: 'POST', url: '/v1/actions/deployments.deploy/execution-authorization',
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: 'controller', envelope: {
                    v: 1, requestId: 'home-material-request', target: { kind: 'machine', machineId: 'controller' },
                    input: { ...input, serverId: homeIdentity } } } });
            expect(minted.statusCode, minted.body).toBe(200);
            const materialRoot = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const signed = (requestPath: string, requestBody: unknown) => createExternalActionAuthorizedRequestHeaders({
                authorization: materialRoot, effectActionId: 'deployments.deploy', target: materialRoot.binding.target,
                installationId: 'installation-controller', privateKey: identityPair.secretKey,
                method: 'POST', path: requestPath, body: requestBody });
            const headers = signed(path, body);
            const admitted = await app.inject({ method: 'POST', url: path, headers, payload: body });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const admittedResult = DeploymentReceiptResultV1Schema.parse(admitted.json());
            expect(admittedResult.ok).toBe(true);
            if (!admittedResult.ok) throw new Error('Expected an admitted receipt');
            const stored = await db.deployment.findUniqueOrThrow({ where: { id: admittedResult.deploymentId } });
            expect(stored).toMatchObject({ requestedByAccountId: actorAccountId,
                actionOperationId: receipt.actionOperationId, state: 'queued', acceptedControllerMachineId: 'controller',
                acceptedControllerInstallationId: 'installation-controller', acceptedRequestEnvelopeDigest: expect.any(String) });
            const materialPath = `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`;
            const open = async (operationId: string, { bearer = false, deploymentId = stored.id, environmentId = stored.environmentId } = {}) => {
                const payload = { resourceId: resource.id, consumer: { kind: 'platform_operation', deploymentId, environmentId, operationId },
                    slot: { kind: 'connected_service_purpose', purpose: principal.purpose }, disclosedMember: account };
                return await app.inject({ method: 'POST', url: materialPath, payload,
                    headers: bearer ? { authorization: `Bearer ${token}` } : signed(materialPath, payload) });
            };
            const expectUnavailable = async (operationId: string, deploymentId = stored.id) => {
                const response = await open(operationId, { deploymentId });
                expect(response.statusCode).toBe(401);
            };
            // The same issued root that created this receipt must spend its
            // captured admission; a new root or a bare bearer is not a substitute.
            const allowed = await open(receipt.actionOperationId);
            expect(allowed.statusCode).toBe(200);
            const material = TeamCredentialDirectMaterialMineResponseV1Schema.parse(allowed.json());
            expect(material.status).toBe(actor === 'recipient' ? 'ready' : 'unavailable');
            if (material.status === 'unavailable') expect(material.reason).toBe('access_removed');
            const bare = await open(receipt.actionOperationId, { bearer: true });
            expect(bare.statusCode).toBe(200);
            expect(TeamCredentialDirectMaterialMineResponseV1Schema.parse(bare.json()))
                .toEqual({ status: 'unavailable', reason: 'access_removed' });
            const accepted = readDeploymentAcceptedExecution(stored);
            expect(accepted).not.toBeNull();
            if (!accepted) throw new Error('Expected canonical accepted execution capture');
            // The database boundary supplies a second accepted capture, so
            // A's valid Team grant cannot mask a missing recipient filter.
            const foreignOperationId = 'another-account-platform-operation';
            const foreign = await db.deployment.create({ data: { environmentId: stored.environmentId,
                targetLinkId: stored.targetLinkId, operation: stored.operation, state: 'queued',
                requestKey: 'foreign-operation-request', actionOperationId: foreignOperationId,
                requestedByAccountId: actor === 'recipient' ? custodian.id : recipient.id,
                acceptedRequestEnvelopeDigest: stored.acceptedRequestEnvelopeDigest,
                ...deploymentAcceptedExecutionColumns(accepted), contentArtifactId: stored.contentArtifactId,
                contentHeaderVersion: stored.contentHeaderVersion, contentBodyVersion: stored.contentBodyVersion } });
            const otherEnvironment = await db.deploymentEnvironment.create({ data: {
                projectSourceId: environment.environment.projectSourceId, createdByAccountId: actorAccountId,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'controller',
                contentArtifactId: environment.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const wrongEnvironment = await open(receipt.actionOperationId, { environmentId: otherEnvironment.id });
            expect(wrongEnvironment.statusCode).toBe(401);
            await expectUnavailable('unknown-platform-operation');
            await expectUnavailable(foreignOperationId, foreign.id);
            await expectUnavailable(receipt.actionOperationId, 'unknown-deployment');
            await db.deployment.update({ where: { id: stored.id }, data: { cancelRequestedAt: new Date() } });
            await expectUnavailable(receipt.actionOperationId);
            await db.deployment.update({ where: { id: stored.id }, data: { cancelRequestedAt: null } });
            await db.deployment.update({ where: { id: stored.id }, data: { state: 'succeeded' } });
            await expectUnavailable(receipt.actionOperationId);
            await db.deployment.update({ where: { id: stored.id },
                data: { state: 'queued', acceptedRequestEnvelopeDigest: null } });
            await expectUnavailable(receipt.actionOperationId);
        } finally { await app.close(); await home.close(); }
    }, 180_000);
});
