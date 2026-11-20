import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { plainPrivateLabel, preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createProjectSourceInTx, updateProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createTeamGroupForActorInTx, addTeamGroupMemberForActorInTx } from '@/app/teams/groups/groupService';
import { resolveDeploymentEnvironmentAdmissionInTx, admitDeploymentMachinesInTx, canEditDeploymentEnvironmentData } from './deploymentAdmission';
import { createSavedSecretResourceInTx, readSavedSecretResourcesForPrincipalInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, signMachineInstallationProof,
    DeploymentReceiptResultV1Schema } from '@happier-dev/protocol';
import { createOwnServerEnvironmentConfigurationV1 } from '@happier-dev/deployments/contracts/v1';
import { captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, type EnvironmentSecretLaunchAdmissionBodyV1 } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { DeploymentEnvironmentUpdateStorageInputV1Schema } from '@happier-dev/protocol/deployments/deploymentStorageInputsV1';
import { MachineSecretGrantV1Schema, type MachineSecretGrantV1 } from '@happier-dev/protocol/deployments/machineSecretGrantV1';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { readEnvironmentSecretLaunchAdmissionInTx } from './environmentSecretLaunchAdmission';
import { createDeploymentEnvironmentInTx, loadDeploymentEnvironmentInTx, projectDeploymentEnvironmentHeader, updateDeploymentEnvironmentInTx, setDeploymentEnvironmentBindingsInTx,
    setDeploymentEnvironmentTemplateInTx, setDeploymentEnvironmentBackupInTx } from './deploymentEnvironmentService';
import { requestCancelDeploymentInTx } from './deploymentService';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol';
import { isDeploymentCandidatePublicationHttpPurposeInTx, isDeploymentPreparationAuthorizedInTx, isDeploymentPreparationHttpPurposeInTx } from './deploymentPreparationAuthorization';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ExternalActionExecutionAuthorizationBindingV1Schema, projectDeploymentPreparationAdmissionV1,
    createDeploymentEnvironmentContentArtifactIdV1, isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readDeploymentEnvironmentInTx, readDeploymentReceiptInTx, readDeploymentEnvironmentAccessInTx } from './deploymentReadService';
import { syncEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { readProjectDeploymentDefaultsInTx, setProjectDeploymentDefaultsInTx } from '@/app/projects/projectDeploymentDefaultsService';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { linkDeploymentTargetInTx, projectDeploymentTargetHeader } from './deploymentTargetLinkService';
import { projectDeploymentHealthAggregateV1 } from '@happier-dev/deployments';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
    TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { getActionSpec, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions';
import { Server } from 'socket.io';
import { setDeploymentEnvironmentControllerInTx } from './deploymentControllerService';
import { unlinkDeploymentTargetInTx, deleteDeploymentEnvironmentInTx } from './deploymentDispositionService';

describe('current Source deployment authority', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-admission-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('admits the current installed collector for a Team reader without a Machine grant (%s)', async mode => {
        const [owner, teammate, outsider] = await Promise.all(Array.from({ length: 3 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        if (mode === 'e2ee') await db.account.update({ where: { id: teammate.id }, data: { encryptionMode: 'e2ee' } });
        const team = await db.team.create({ data: { name: 'Telemetry readers' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: teammate.id, role: 'member' } });
        const project = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Telemetry', audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] }));
        if (!project.ok) throw new Error(project.error);
        const collectorSigning = nacl.sign.keyPair();
        const collectorKey = collectorSigning.publicKey;
        const createCollector = (publicKey: Uint8Array) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, active: true, installationId: crypto.randomUUID(),
            installationPublicKey: Uint8Array.from(publicKey), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const [collector, unrelated] = await Promise.all([createCollector(collectorKey), createCollector(nacl.sign.keyPair().publicKey)]);
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Telemetry' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: project.source.id,
            createdByAccountId: owner.id, controllerMachineId: collector.id, telemetryMachineId: collector.id,
            protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', referencedSavedSecretRevisions: [], contentArtifactId: artifact.artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1, telemetryMetricsEnabled: true } });
        const token = (accountId: string) => auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
        const [ownerToken, readerToken, outsiderToken] = await Promise.all([token(owner.id), token(teammate.id), token(outsider.id)]);
        const relayed: Array<{ machineId: string; installationId: string }> = [];
        await withAuthenticatedTestApp(app => registerExternalActionRoutes(app, {
            dispatch: async request => {
                if (request.admittedMachine) relayed.push(request.admittedMachine);
                return { kind: 'placement_error', code: 'target_unavailable' };
            },
        }), async app => {
            const route = `/v1/actions/${ACTION_INVOKE_ACTION_ID_V1}`;
            const makeRead = (accountId: string, machineId: string, regression = false) => {
                const target = { kind: 'machine' as const, machineId };
                const material = { type: 'dataKey' as const, machineKey: nacl.randomBytes(32) };
                const input = regression
                    ? { action: parseQualifiedPluginActionId(TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1),
                        input: { serverId, environmentId: environment.id, serviceName: 'app', measure: 'http.error_rate', windowMs: 1000 } }
                    : { action: parseQualifiedPluginActionId(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1),
                        input: { source: { kind: 'environment', serverId, environmentId: environment.id }, page: { limit: 6 } } };
                const envelope = sealExternalActionRequestV2({ material, input, randomBytes: nacl.randomBytes,
                    projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                    binding: { accountId, serverIdentityId: serverId, actionId: ACTION_INVOKE_ACTION_ID_V1, target,
                        requestId: crypto.randomUUID(), authentication: { kind: 'account', tokenEpoch: 0 } } });
                return { material, body: { v: 1 as const, machineId, envelope: { ...envelope, telemetryCollectorCodec: true as const } } };
            };
            const post = (bearer: string, url: string, payload: object) => app.inject({
                method: 'POST', url, headers: { authorization: `Bearer ${bearer}` }, payload,
            });
            const admit = (bearer: string, body: object) => post(bearer, `${route}/execution-authorization`, body);
            expect((await admit(ownerToken, makeRead(owner.id, collector.id).body)).statusCode).toBe(200);
            expect((await loadDeploymentEnvironmentInTx(db, teammate.id, serverId, environment.id)).ok).toBe(true);
            const { body, material } = makeRead(teammate.id, collector.id);
            const accepted = await admit(readerToken, body);
            expect(accepted.statusCode).toBe(200);
            const { telemetryReadInstallationPublicKey, ...signed } = ExternalActionExecutionAuthorizationV1Schema.parse(accepted.json());
            expect(telemetryReadInstallationPublicKey).toBe(Buffer.from(collectorKey).toString('base64url'));
            expect(signed.binding).toMatchObject({
                accountId: teammate.id, custodianAccountId: owner.id, machineId: collector.id, installationId: collector.installationId,
                deploymentTelemetryRead: [{ environmentId: environment.id, revision: environment.revision, capabilities: { metrics: true } }],
            });
            const executionAuthorization = sealManagedControllerActionCodecV1({ authorization: signed, material,
                installationPublicKey: collectorKey, randomBytes: nacl.randomBytes });
            await post(readerToken, route, { ...body, executionAuthorization });
            expect(relayed.map(row => ({ machineId: row.machineId, installationId: row.installationId })))
                .toEqual([{ machineId: collector.id, installationId: collector.installationId }]);
            expect((await admit(outsiderToken, makeRead(outsider.id, collector.id).body)).statusCode).toBe(403);
            expect((await admit(readerToken, makeRead(teammate.id, unrelated.id).body)).statusCode).toBe(403);
            const nonRead = { ...body, envelope: { ...body.envelope, deploymentReadAdmission: {
                ...body.envelope.deploymentReadAdmission, action: parseQualifiedPluginActionId(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1),
            } } };
            expect((await admit(readerToken, nonRead)).statusCode).toBe(400);

            const regression = ExternalActionExecutionAuthorizationV1Schema.parse((await admit(readerToken,
                makeRead(teammate.id, collector.id, true).body)).json());
            const readReceipts = (root: typeof regression, environmentId: string) => {
                const target = root.binding.target;
                const effectActionId = 'deployments.receipts.list';
                const routeInput = { serverId, environmentId, state: 'succeeded' };
                const { inputSchema, serverTransport } = getActionSpec(effectActionId);
                if (!serverTransport) throw new Error('Receipt list transport unavailable');
                const { method, path, body } = bindHomeDomainHttpRequestV1({ inputSchema, transport: serverTransport, input: routeInput });
                const signature = signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId, target,
                    installationId: root.binding.installationId, requestId: root.binding.requestId,
                    method, path, privateKey: collectorSigning.secretKey });
                return verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token, effectActionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(target), machineSignature: signature,
                    method, path, body, routeInput });
            };
            expect(await readReceipts(signed, environment.id)).toBeNull();
            expect(await readReceipts(regression, crypto.randomUUID())).toBeNull();
            await db.teamMembership.delete({ where: { id: membership.id } });
            expect((await admit(readerToken, makeRead(teammate.id, collector.id).body)).statusCode).toBe(403);
            expect((await post(readerToken, route, { ...body, executionAuthorization })).statusCode).toBe(403);
            expect(relayed).toHaveLength(1);
            expect((await readReceipts(regression, environment.id))?.acceptedDeploymentReceipt?.read)
                .toStrictEqual({ environmentId: environment.id });
        }, { authentication: 'real' });
    });

    it('atomically cuts over reviewed definition and Saved Secret bindings through Environment update', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            name: 'Database cutover', requestKey: crypto.randomUUID() }));
        if (!source.ok) throw new Error(source.error);
        const signing = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(signing.publicKey),
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
                host: 'database-cutover', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier',
            })), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const content = { name: 'Database cutover', retainPreviousDeployments: 1, bindings: [],
            template: { templateRef: { sourceId: 'builtin:apps', itemId: 'database-app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
                definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
                services: ['app', 'db'], data: [{ engine: 'postgres', service: 'db', port: 5432 }] },
            definition: { kind: 'stored', document: 'services:\n  app:\n    image: app:1\n  db:\n    image: postgres:17\n',
                contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app', 'db'] } };
        const artifact = async (body: unknown, target = false, artifactId: string = crypto.randomUUID()) => {
            const saved = await createArtifact({ actorUserId: owner.id, artifactId,
                kind: target ? DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 : DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({
                    kind: target ? 'deployment-target-link.v1' : 'deployment-environment.v1', title: content.name })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!saved.ok) throw new Error(saved.error);
            return { contentArtifactId: saved.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const initial = await artifact(content);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...initial, serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id }));
        if (!created.ok) throw new Error(created.error);
        const targetContent = await artifact({}, true);
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: created.environmentId, expectedRevision: created.revision, requestKey: crypto.randomUUID(),
            targetId: 'own-server', role: 'runtime', machines: [{ machineId: machine.id, installationId: machine.installationId! }],
            ...targetContent }));
        if (!linked.ok) throw new Error(linked.error);
        const resourceId = crypto.randomUUID();
        const secret = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Database administrator', kind: 'token', encryptionMode: 'plain', accountGrants: [], teamGrants: [], keyEnvelopes: [],
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
                content: { v: 1, name: 'Database administrator', kind: 'token', value: 'private-admin-password' } }) }));
        if (!secret.ok) throw new Error(secret.error);
        const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'DATABASE_PASSWORD',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: secret.value.revision } };
        const operationalBinding = { purpose: 'backupDestination' as const, configKey: 'destination' as const, role: 'repositoryPassword' as const,
            source: binding.source };
        const ownServer = { rollout: 'recreate' as const, autoRestorePreviousRelease: true };
        const serviceExport = { key: 'database', service: 'db', containerPort: 5432, scheme: 'postgres',
            exposure: 'privateNetwork', privateNetwork: 'database-network' };
        const candidateContent = { ...content, bindings: [binding, operationalBinding],
            ownServer,
            template: { ...content.template, services: ['app'], data: undefined }, definition: { ...content.definition,
            document: 'services:\n  app:\n    image: app:1\n', contentRevision: 2,
            composeDigest: `sha256:${'b'.repeat(64)}`, services: ['app'] } };
        const candidate = await artifact(candidateContent);
        const forgedProvenance = await artifact({ ...candidateContent, template: { ...candidateContent.template,
            templateRef: { ...content.template.templateRef, itemId: 'unreviewed-template' } } });
        const invalidDefinition = await artifact({ ...candidateContent,
            definition: { ...candidateContent.definition, document: 'services: [' } });
        const grant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId: created.environmentId,
            machineId: machine.id, installationId: machine.installationId!, resourceId,
            resourceRevision: secret.value.revision, sealedContent: 'incumbent-admin-seal' };
        const incumbentContent = await artifact({ ...content, bindings: [{ ...binding, name: 'POSTGRES_PASSWORD' }] });
        const variableCaptures = captureDeploymentBindingSavedSecretRevisionsV1([binding]);
        const incumbent = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, { serverId,
            environmentId: created.environmentId, expectedRevision: linked.revision,
            ...incumbentContent, grants: [{ ...grant, sealedContent: 'incumbent-admin-seal' }], referencedSavedSecretRevisions: variableCaptures }));
        if (!incumbent.ok) throw new Error(incumbent.error);
        const backup = { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'open' },
            occurrenceId: 'destination', config: { bucket: 'recovery' }, credentialBindings: [],
            sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }],
            ownership: { environmentId: created.environmentId, prefix: 'backups' }, retention: { kind: 'keepEverything' } };
        // Existing operational custody is a persisted fixture; only the ordinary writer runs in the mutation below.
        const operationalContent = await artifact({ ...content, backup, ownServer: { ...ownServer, serviceExports: [serviceExport] },
            bindings: [{ ...binding, name: 'POSTGRES_PASSWORD' }, operationalBinding] });
        const operationalRecipient = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const operationalGrant: MachineSecretGrantV1 = { ...grant, machineId: operationalRecipient.id,
            installationId: operationalRecipient.installationId!, sealedContent: 'incumbent-operational-seal' };
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: created.environmentId,
            grants: [grant, operationalGrant] }));
        const captures = captureDeploymentBindingSavedSecretRevisionsV1(candidateContent.bindings);
        await db.deploymentEnvironment.update({ where: { id: created.environmentId },
            data: { ...operationalContent, referencedSavedSecretRevisions: captures } });
        const input = { ...candidate, serverId, environmentId: created.environmentId, expectedRevision: incumbent.revision,
            preparedBindings: { grants: [grant, operationalGrant], referencedSavedSecretRevisions: captures } };
        const snapshot = async () => ({
            environment: await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }),
            grants: await db.machineSecretGrant.findMany({ where: { environmentId: created.environmentId } }),
        });
        const before = await snapshot();
        // Real HTTP schema, registration, mutation owner and transaction; authentication is the transport fixture boundary.
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const update = (payload: unknown) => app.inject({ method: 'PATCH',
                url: `/v1/deployments/environments/${created.environmentId}`, headers: { 'x-test-user-id': owner.id }, payload });
            const refused = await update({ ...input, preparedBindings: { ...input.preparedBindings, grants: [] } });
            expect(refused.statusCode, refused.body).toBe(409);
            expect(await snapshot()).toEqual(before);
            expect((await update({ ...input, ...forgedProvenance })).statusCode).toBe(409);
            expect(await snapshot()).toEqual(before);
            expect((await update({ ...input, ...invalidDefinition })).statusCode).toBe(400);
            expect(await snapshot()).toEqual(before);
            const changedPolicy = await artifact({ ...candidateContent,
                ownServer: { ...ownServer, serviceExports: [serviceExport] } });
            expect((await update({ ...input, ...changedPolicy })).statusCode).toBe(409);
            expect(await snapshot()).toEqual(before);
            expect((await update({ ...input, ...await artifact({ ...candidateContent, backup }) })).statusCode).toBe(409);
            expect(await snapshot()).toEqual(before);
            for (const bindings of [[binding], [binding, { ...operationalBinding, role: 'another-role' }],
                [binding, operationalBinding, { ...operationalBinding, configKey: 'another-destination' }]]) {
                expect((await update({ ...input, ...await artifact({ ...candidateContent, bindings }) })).statusCode).toBe(409);
                expect(await snapshot()).toEqual(before);
            }
            expect((await update({ ...input, preparedBindings: { ...input.preparedBindings,
                grants: [{ ...grant, sealedContent: 'unreviewed-operational-seal' }] } })).statusCode).toBe(409);
            expect(await snapshot()).toEqual(before);
        });
        const authored = DeploymentEnvironmentUpdateInputV1Schema.parse({ ...operationalContent, serverId,
            environmentId: created.environmentId, expectedRevision: incumbent.revision,
            patch: { definition: { from: 'compose', document: candidateContent.definition.document,
                profiles: [], services: ['app'] }, bindings: { set: [binding],
                remove: [{ purpose: 'variable', phase: 'runtime', name: 'POSTGRES_PASSWORD' }] } } });
        const target = { kind: 'machine' as const, machineId: machine.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: authored };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
            actionId: 'deployments.environments.update', machineId: machine.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: authored });
        const native = authorization.binding.deploymentNativeAdmission;
        if (!isDeploymentEnvironmentUpdateNativeAdmissionV1(native)) throw new Error('Expected combined content admission');
        const signedCandidate = await artifact(candidateContent, false, createDeploymentEnvironmentContentArtifactIdV1({
            ...authorization.binding, environmentId: created.environmentId }));
        const signedInput = { ...input, ...signedCandidate, patch: {}, authoredInputDigest: native.inputDigest };
        const path = `/v1/deployments/environments/${created.environmentId}`;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const update = (payload = signedInput) => app.inject({ method: 'PATCH', url: path, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.environments.update',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.environments.update', target,
                    installationId: machine.installationId!, requestId: envelope.requestId,
                    method: 'PATCH', path, body: payload, privateKey: signing.secretKey }),
            } });
            expect((await update({ ...signedInput, preparedBindings: { ...signedInput.preparedBindings, grants: [grant] } })).statusCode).toBe(409);
            expect(await snapshot()).toEqual(before);
            const accepted = await update();
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toMatchObject({ ok: true, revision: incumbent.revision + 1 });
            const committed = await snapshot();
            expect(committed.environment).toMatchObject({ ...signedCandidate, revision: incumbent.revision + 1,
                referencedSavedSecretRevisions: input.preparedBindings.referencedSavedSecretRevisions });
            expect(committed.grants).toHaveLength(2);
            expect(committed.grants.map(row => row.contentEnvelope).sort()).toEqual([grant.sealedContent, operationalGrant.sealedContent].sort());
            expect((await update()).statusCode).toBe(409);
            expect(await snapshot()).toEqual(committed);
        }, { authentication: 'real' });
    });

    it('persists signed prepared private content and refuses ordinary forged backup or preview content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            name: 'Backup setup', requestKey: crypto.randomUUID() }));
        if (!source.ok) throw new Error(source.error);
        const signing = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(signing.publicKey),
            metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const content = { name: 'Backup setup', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'stored', document: 'services:\n  app:\n    image: nginx:1\n', contentRevision: 1,
                composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] } };
        const artifact = async (body: unknown, artifactId: string = crypto.randomUUID()) => {
            const saved = await createArtifact({ actorUserId: owner.id, artifactId,
                kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: content.name })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!saved.ok) throw new Error(saved.error);
            return { contentArtifactId: saved.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const initial = await artifact(content);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...initial, serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id }));
        if (!created.ok) throw new Error(created.error);
        const backup = { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'open' },
            occurrenceId: 'destination', config: { bucket: 'recovery' }, credentialBindings: [],
            sources: [{ kind: 'dump', sourceId: 'database', service: 'app', consistency: 'logical' }],
            ownership: { environmentId: created.environmentId, prefix: 'backups' }, retention: { kind: 'keepEverything' } };
        const base = { ...initial, serverId, environmentId: created.environmentId, expectedRevision: created.revision };
        const path = `/v1/deployments/environments/${created.environmentId}`;
        const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const forgedContent of [{ ...content, backup }, { ...content, previewTemplate }]) {
                const forged = { ...base, ...await artifact(forgedContent) };
                for (const extra of [{}, { authoredInputDigest: 'a'.repeat(43) }]) {
                    const response = await app.inject({ method: 'PATCH', url: path, payload: { ...forged, ...extra },
                        headers: { 'x-test-user-id': owner.id } });
                    expect(response.statusCode, response.body).toBe(409);
                    expect(response.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
                }
            }
        });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }))
            .toMatchObject({ ...initial, revision: created.revision });

        const authored = DeploymentEnvironmentUpdateInputV1Schema.parse({ ...base, patch: { previewTemplate } });
        const target = { kind: 'machine' as const, machineId: machine.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: authored };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
            actionId: 'deployments.environments.update', machineId: machine.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: authored });
        const native = authorization.binding.deploymentNativeAdmission;
        if (!isDeploymentEnvironmentUpdateNativeAdmissionV1(native)) throw new Error('Expected prepared Environment admission');
        const forgedBackup = await artifact({ ...content, backup, previewTemplate });
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateStorageInputV1Schema.parse({ ...base, ...forgedBackup,
                patch: {}, authoredInputDigest: native.inputDigest }), {}, 'environment', undefined, undefined,
            authorization.binding))).toMatchObject({ ok: false, error: 'deployment_conflict' });
        const prepared = await artifact({ ...content, previewTemplate }, createDeploymentEnvironmentContentArtifactIdV1({
            ...authorization.binding, environmentId: created.environmentId }));
        const payload = DeploymentEnvironmentUpdateStorageInputV1Schema.parse({ ...base, ...prepared,
            patch: {}, authoredInputDigest: native.inputDigest });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'PATCH', url: path, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.environments.update',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.environments.update', target,
                    installationId: machine.installationId!, requestId: envelope.requestId,
                    method: 'PATCH', path, body: payload, privateKey: signing.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, revision: created.revision + 1 });
        }, { authentication: 'real' });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }))
            .toMatchObject({ ...prepared, revision: created.revision + 1 });
    });

    it('reserves backup configuration and retention for the backup writer under Environment CAS', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            name: 'Backup retention', requestKey: crypto.randomUUID() }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const content = { name: 'Backup retention', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['app'] } } };
        const artifact = async (body: unknown) => {
            const saved = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: content.name })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!saved.ok) throw new Error(saved.error);
            return { contentArtifactId: saved.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const initial = await artifact(content);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...initial, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id }));
        if (!created.ok) throw new Error(created.error);
        const backup = { configRevision: 3, destinationRef: { pluginId: 'example.storage', localId: 'open' },
            occurrenceId: 'destination', config: { bucket: 'recovery' }, credentialBindings: [],
            sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }],
            ownership: { environmentId: created.environmentId, prefix: 'backups' }, retention: { kind: 'keepEverything' } };
        const configuredContent = await artifact({ ...content, backup });
        const configured = await inTx(tx => setDeploymentEnvironmentBackupInTx(tx, owner.id, {
            ...configuredContent, serverId, environmentId: created.environmentId, expectedRevision: created.revision }));
        if (!configured.ok) throw new Error(configured.error);
        const retention = { kind: 'keep', last: 7, monthly: 12 };
        const selected = await artifact({ ...content, backup: { ...backup, retention } });
        const input = { ...selected, serverId, environmentId: created.environmentId, expectedRevision: configured.revision };
        const update = (value: unknown) => inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateInputV1Schema.parse(value)));
        expect(await update({ ...input, ...await artifact({ ...content, backup: { ...backup, retention,
            config: { bucket: 'unreviewed' } } }) })).toMatchObject({ ok: false });
        expect(await update(input)).toMatchObject({ ok: false, error: 'deployment_conflict' });
        expect(await inTx(tx => setDeploymentEnvironmentBackupInTx(tx, owner.id, input)))
            .toMatchObject({ ok: true, revision: configured.revision + 1 });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }))
            .toMatchObject(selected);
        expect(await update(input)).toMatchObject({ ok: false, error: 'deployment_conflict' });
    });

    it.each([
        ['plain', 'create'], ['e2ee', 'create'],
        ['plain', 'firstTarget'], ['e2ee', 'firstTarget'],
        ['plain', 'definition'], ['e2ee', 'definition'],
        ['plain', 'builder'], ['e2ee', 'builder'],
        ['plain', 'controller'], ['e2ee', 'controller'],
        ['plain', 'target'], ['e2ee', 'target'], ['e2ee', 'bindings'], ['e2ee', 'template'], ['e2ee', 'backup'],
        ['plain', 'detach'], ['e2ee', 'detach'], ['plain', 'delete'], ['e2ee', 'delete'],
        ['plain', 'unlinkEmpty'], ['e2ee', 'unlinkEmpty'], ['plain', 'deleteEmpty'], ['e2ee', 'deleteEmpty'],
        ['plain', 'config'], ['plain', 'bindingValues'], ['plain', 'grant'],
        ['plain', 'placedController'], ['e2ee', 'placedController'],
    ] as const)('requires actual requester Machine Manage for %s %s writes, including Team grants', async (mode, writer) => {
        const contentKeys = nacl.box.keyPair();
        const actor = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(contentKeys.publicKey) : {}) } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Definition writer Machines' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, actor.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Definition writer' }));
        if (!source.ok) throw new Error(source.error);
        const machines = await Promise.all([0, 1, 2].map(() => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, installationId: crypto.randomUUID(),
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
                host: 'Definition writer', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/deployment', happyHomeDir: '/home/deployment/.happier',
            })), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } })));
        const [controller, target, peer] = machines;
        if (!controller || !target || !peer) throw new Error('Expected exact placement fixtures');
        const limitedMachine = writer === 'placedController' ? peer : target;
        await db.machineGrant.createMany({ data: machines.map(machine => ({ ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: custodian.id }), machineId: machine.id })) });
        const body = (revision: number) => ({ name: 'Definition writer', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'stored', document: `services:\n  app:\n    image: app:${revision}\n`, contentRevision: revision,
                composeDigest: `sha256:${String(revision).repeat(64)}`, profiles: [], services: ['app'] } });
        const artifact = async (content: unknown, targetContent = false) => {
            const key = nacl.randomBytes(32);
            const header = { kind: targetContent ? 'deployment-target-link.v1' : 'deployment-environment.v1', title: 'Definition writer' };
            const value = { body: JSON.stringify(content) };
            const created = await createArtifact({ actorUserId: actor.id, artifactId: crypto.randomUUID(),
                kind: targetContent ? DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 : DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
                header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(header))
                    : new Uint8Array(await sealSessionDataKeyBundleV0(header, key)),
                body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                    : new Uint8Array(await sealSessionDataKeyBundleV0(value, key)),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: contentKeys.publicKey,
                        randomBytes: nacl.randomBytes })) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const variable = createDeploymentVariableBindingV1({ phase: 'runtime', name: 'COLOR', source: { kind: 'value', value: 'blue' } });
        const initialBody = writer === 'grant' ? { ...body(1), bindings: [variable] } : body(1);
        const initial = await artifact(initialBody);
        const createInput = { ...initial, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: controller.id, buildMachineId: controller.id };
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, actor.id, createInput));
        if (!created.ok) throw new Error(created.error);
        let targetLinkId: string | undefined;
        if (writer === 'definition' || writer === 'bindings' || writer === 'template' || writer === 'backup'
            || writer === 'detach' || writer === 'delete' || writer === 'unlinkEmpty' || writer === 'deleteEmpty'
            || writer === 'config' || writer === 'bindingValues' || writer === 'grant' || writer === 'placedController') {
            // The runtime placement is deliberately a different Machine from the controller/builder.
            const link = await db.deploymentTargetLink.create({ data: {
                ...await artifact({}, true), environmentId: created.environmentId, createdByAccountId: actor.id,
                role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
                machines: { create: { machineId: limitedMachine.id, installationId: limitedMachine.installationId!, position: 0, state: 'active' } },
            } });
            await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { runtimeTargetLinkId: link.id } });
            targetLinkId = link.id;
        }
        const configuration = createOwnServerEnvironmentConfigurationV1({ rollout: 'startFirst', autoRestorePreviousRelease: false });
        const candidate = await artifact(writer === 'config' ? { ...body(1), ownServer: configuration }
            : writer === 'bindingValues' ? { ...body(1), bindings: [variable] } : body(2));
        const targetContent = await artifact({}, true);
        const run = (accountId = actor.id, expectedRevision = created.revision) => inTx(async tx => {
            const base = { serverId, environmentId: created.environmentId, expectedRevision };
            if (writer === 'create') return createDeploymentEnvironmentInTx(tx, accountId, {
                ...createInput, requestKey: crypto.randomUUID(), controllerMachineId: target.id });
            if (writer === 'firstTarget') return createDeploymentEnvironmentInTx(tx, accountId, {
                ...createInput, requestKey: crypto.randomUUID(), firstTargetLink: { ...targetContent,
                    machines: [{ machineId: target.id, installationId: target.installationId! }] } });
            if (writer === 'controller' || writer === 'placedController') return setDeploymentEnvironmentControllerInTx(tx, accountId, { ...base, controllerMachineId: target.id });
            if (writer === 'target') return linkDeploymentTargetInTx(tx, accountId, { ...base, ...targetContent,
                requestKey: crypto.randomUUID(), role: 'runtime', targetId: 'own-server',
                machines: [{ machineId: target.id, installationId: target.installationId! }] });
            if (writer === 'bindings') return setDeploymentEnvironmentBindingsInTx(tx, accountId, {
                ...base, ...candidate, referencedSavedSecretRevisions: [], grants: [] });
            if (writer === 'bindingValues' || writer === 'grant') return setDeploymentEnvironmentBindingsInTx(tx, accountId, {
                ...base, ...(writer === 'grant' ? initial : candidate), referencedSavedSecretRevisions: [], grants: [MachineSecretGrantV1Schema.parse({
                    v: 1, kind: 'environmentValues', environmentId: created.environmentId, machineId: target.id,
                    installationId: target.installationId!, binding: { purpose: 'variable', phase: variable.phase, grantRef: variable.grantRef! }, sealedContent: 'sealed-new-values',
                })] });
            if (writer === 'template') return setDeploymentEnvironmentTemplateInTx(tx, accountId, { ...base, ...candidate });
            if (writer === 'backup') return setDeploymentEnvironmentBackupInTx(tx, accountId, { ...base, ...candidate });
            if (writer === 'detach' || writer === 'unlinkEmpty') {
                if (!targetLinkId) throw new Error('Expected placed target');
                return unlinkDeploymentTargetInTx(tx, accountId, { ...base, targetLinkId, expectedTargetLinkRevision: 1,
                    requestKey: crypto.randomUUID(), ...(writer === 'detach' ? { detachKeepRunning: true } : {}) });
            }
            if (writer === 'delete' || writer === 'deleteEmpty') return deleteDeploymentEnvironmentInTx(tx, accountId, {
                ...base, requestKey: crypto.randomUUID(), ...(writer === 'delete' ? { detachKeepRunning: true } : {}) });
            return updateDeploymentEnvironmentInTx(tx, accountId, { ...base,
                ...(writer === 'builder' ? initial : candidate), ...(writer === 'config' ? { patch: { ownServer: configuration } } : {}),
                ...(writer === 'builder' ? { patch: { buildMachineId: target.id },
                    preparedBindings: { referencedSavedSecretRevisions: [], grants: [] } } : {}) });
        });
        const before = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } });
        const beforeLinks = await db.deploymentTargetLink.findMany({ where: { environmentId: created.environmentId }, include: { machines: true } });
        const beforeGrants = await db.machineSecretGrant.findMany({ where: { environmentId: created.environmentId } });
        const beforeSequence = (await db.account.findUniqueOrThrow({ where: { id: actor.id } })).seq;
        const count = await db.deploymentEnvironment.count({ where: { projectSourceId: source.source.id } });
        await db.machineGrant.update({ where: { principalKind: 'team', machineId_teamId: { machineId: limitedMachine.id, teamId: team.id } }, data: { accessLevel: 'view' } });
        expect(await run()).toMatchObject({ ok: false, error: 'deployment_access_denied' });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } })).toEqual(before);
        expect(await db.deploymentTargetLink.findMany({ where: { environmentId: created.environmentId }, include: { machines: true } })).toEqual(beforeLinks);
        expect(await db.machineSecretGrant.findMany({ where: { environmentId: created.environmentId } })).toEqual(beforeGrants);
        expect((await db.account.findUniqueOrThrow({ where: { id: actor.id } })).seq).toBe(beforeSequence);
        expect(await db.deploymentEnvironment.count({ where: { projectSourceId: source.source.id } })).toBe(count);
        await db.machineGrant.delete({ where: { principalKind: 'team', machineId_teamId: { machineId: limitedMachine.id, teamId: team.id } } });
        expect(await run()).toMatchObject({ ok: false });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: custodian.id }), machineId: limitedMachine.id } });
        // Custody alone cannot replace the separate Source-management requirement.
        expect(await run(custodian.id)).toMatchObject({ ok: false });
        let requesterFactReads = 0;
        const stop = observeSqliteRequests({ before: request => {
            if (request.model !== 'Machine' || request.action !== 'findMany' || !request.args || typeof request.args !== 'object') return;
            const select: unknown = Reflect.get(request.args, 'select');
            if (select && typeof select === 'object' && Reflect.get(select, 'metadata') === true
                && Reflect.get(select, 'grants') !== undefined) requesterFactReads++;
        } });
        try {
            const result = await run();
            expect(result).toMatchObject({ ok: true });
            expect(requesterFactReads, 'one batched requester-role decision per public writer').toBe(1);
            if (writer === 'grant' && result.ok) {
                await db.machineGrant.update({ where: { principalKind: 'team', machineId_teamId: { machineId: target.id, teamId: team.id } }, data: { accessLevel: 'view' } });
                expect(await run(actor.id, result.revision)).toMatchObject({ ok: true, revision: result.revision });
                expect(requesterFactReads, 'unchanged seal maintenance is not another definition admission').toBe(1);
            }
        } finally { stop(); }
    });

    it.each(['plain', 'e2ee'] as const)('persists reviewed %s ingress through the Environment writer into edge-critical health', async mode => {
        const contentKeys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(contentKeys.publicKey) : {}) } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            name: 'Edge placement writer', requestKey: crypto.randomUUID() }));
        if (!source.ok) throw new Error(source.error);
        const machines = await Promise.all(['runtime-a', 'runtime-b', 'edge'].map(async () => {
            const key = nacl.randomBytes(32);
            const metadata = { host: 'Ingress', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' };
            return db.machine.create({ data: {
                id: crypto.randomUUID(), accountId: owner.id, installationId: crypto.randomUUID(),
                metadata: mode === 'plain' ? encodePlainMachineStoredContent(metadata)
                    : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(metadata, key))),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: contentKeys.publicKey, randomBytes: nacl.randomBytes })),
            } });
        }));
        const edge = machines[2]!;
        const body = { name: 'Edge placement writer', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'stored', document: 'services:\n  app:\n    image: app:1\n', contentRevision: 1,
                composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] } };
        const artifact = async (content: unknown, target = false) => {
            const key = nacl.randomBytes(32);
            const header = { kind: target ? 'deployment-target-link.v1' : 'deployment-environment.v1', title: body.name };
            const value = { body: JSON.stringify(content) };
            const result = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                kind: target ? DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 : DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
                header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(header))
                    : new Uint8Array(await sealSessionDataKeyBundleV0(header, key)),
                body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                    : new Uint8Array(await sealSessionDataKeyBundleV0(value, key)),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                        recipientPublicKey: contentKeys.publicKey, randomBytes: nacl.randomBytes })) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const initial = await artifact(body);
        const targetContent = await artifact({}, true);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...initial, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'production', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machines[0]!.id,
        }));
        if (!created.ok) throw new Error(created.error);
        const link = await db.deploymentTargetLink.create({ data: { environmentId: created.environmentId,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...targetContent,
            machines: { create: machines.slice(0, 2).map((machine, position) => ({ machineId: machine.id,
                installationId: machine.installationId!, position, state: 'active' })) },
        }, include: { machines: true } });
        await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { runtimeTargetLinkId: link.id } });
        const ingress = { kind: 'edgeCaddy', edgeMachineId: edge.id };
        const selected = await artifact({ ...body, ingress });
        const update = DeploymentEnvironmentUpdateInputV1Schema.parse({ ...selected, serverId,
            environmentId: created.environmentId, expectedRevision: created.revision, patch: { ingress } });
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id, update)))
            .toMatchObject({ ok: true, revision: created.revision + 1 });
        const read = await inTx(tx => readDeploymentEnvironmentInTx(tx, owner.id, { serverId, environmentId: created.environmentId }));
        if (!read.ok) throw new Error(read.error);
        expect(read.environment.ingress).toEqual(ingress);
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }))
            .toMatchObject({ edgeMachineId: edge.id, ...selected });
        const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id, { ...update, expectedRevision: created.revision + 1 })))
            .toMatchObject({ ok: true, revision: created.revision + 1 });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
        const aggregate = projectDeploymentHealthAggregateV1({ environment: read.environment,
            targetLink: projectDeploymentTargetHeader(link), observations: machines.slice(0, 2).map(machine => ({
                environmentId: created.environmentId, targetLinkId: link.id, targetLinkRevision: link.revision,
                machineId: machine.id, installationId: machine.installationId!, role: 'runtime', status: 'up',
                observedAtMs: 1, source: { kind: 'native' },
            })) });
        expect(aggregate).toMatchObject({ status: 'down', down: 1, unknown: 1, n: 3 });
        const tunnel = await artifact({ ...body, ingress: { kind: 'cloudflareTunnel' } });
        const retainedLink = await db.deploymentTargetLink.create({ data: { environmentId: created.environmentId,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', detachedAt: new Date(), ...targetContent } });
        const retainedDomain = await db.deploymentDomain.create({ data: { environmentId: created.environmentId,
            targetLinkId: retainedLink.id, state: 'removing', createdByAccountId: owner.id, ...selected } });
        const replacementIngress = { kind: 'edgeCaddy', edgeMachineId: machines[0]!.id };
        const replacement = await artifact({ ...body, ingress: replacementIngress });
        for (const desired of [{ reference: tunnel, ingress: { kind: 'cloudflareTunnel' } },
            { reference: replacement, ingress: replacementIngress }]) {
            expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
                DeploymentEnvironmentUpdateInputV1Schema.parse({ ...desired.reference, serverId,
                    environmentId: created.environmentId, expectedRevision: created.revision + 1,
                    patch: { ingress: desired.ingress } }))))
                .toMatchObject({ ok: false, error: 'deployment_conflict' });
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } })).edgeMachineId).toBe(edge.id);
        }
        // Complete captured custody, including a removing predecessor, keeps
        // the old edge discoverable when desired placement changes.
        const capturedPlacements = [{ placement: { serverId, accountId: owner.id, environmentId: created.environmentId,
            targetLinkId: retainedLink.id, domainId: retainedDomain.id, machineId: edge.id,
            installationId: edge.installationId!, actionOperationId: 'captured-operation', requestId: 'captured-request',
            nativeServer: 'happier_public' }, content: selected, desired: false, listener: 'public',
            installationPublicKey: privacyKit.encodeBase64(new Uint8Array(nacl.sign.keyPair().publicKey)) }];
        await db.deploymentDomain.update({ where: { id: retainedDomain.id }, data: { capturedPlacements } });
        // A Tunnel has one connector per active member; a singleton does not
        // need the separate multi-Machine edge-Caddy placement contract.
        await db.deploymentTargetLink.update({ where: { id: link.id }, data: {
            machines: { deleteMany: { machineId: machines[1]!.id } },
        } });
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateInputV1Schema.parse({ ...tunnel, serverId, environmentId: created.environmentId,
                expectedRevision: created.revision + 1, patch: { ingress: { kind: 'cloudflareTunnel' } } }))))
            .toMatchObject({ ok: true, revision: created.revision + 2 });
        const tunnelRow = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } });
        expect(tunnelRow.edgeMachineId).toBeNull();
        expect(await db.deploymentDomain.findUniqueOrThrow({ where: { id: retainedDomain.id } }))
            .toMatchObject({ deletedAt: null, state: 'removing', capturedPlacements });
        // A null edge reference never invents Tunnel selection in a metadata-only reader.
        const loaded = await inTx(tx => loadDeploymentEnvironmentInTx(tx, owner.id, serverId, created.environmentId));
        if (!loaded.ok) throw new Error(loaded.error);
        expect(projectDeploymentEnvironmentHeader(loaded.row, serverId, loaded.admission).ingress).toBeUndefined();
        await db.deploymentTargetLink.update({ where: { id: link.id }, data: {
            machines: { create: { machineId: machines[1]!.id, installationId: machines[1]!.installationId!, position: 1, state: 'active' } },
        } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: outsider.id,
            installationId: crypto.randomUUID(), metadata: '{}' } });
        const foreignIngress = { kind: 'edgeCaddy', edgeMachineId: foreign.id };
        const foreignContent = await artifact({ ...body, ingress: foreignIngress });
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateInputV1Schema.parse({ ...foreignContent, serverId, environmentId: created.environmentId,
                expectedRevision: created.revision + 2, patch: { ingress: foreignIngress } }))))
            .toMatchObject({ ok: false, error: 'machine_unavailable', machineIds: [foreign.id] });
        if (mode === 'plain') expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateInputV1Schema.parse({ ...initial, serverId, environmentId: created.environmentId,
                expectedRevision: created.revision + 2, patch: { ingress } }))))
            .toMatchObject({ ok: false, error: 'deployment_conflict' });
        await db.deploymentTargetLinkMachine.deleteMany({ where: { targetLinkId: link.id, machineId: machines[1]!.id } });
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateInputV1Schema.parse({ ...selected, serverId, environmentId: created.environmentId,
                expectedRevision: created.revision + 2, patch: { ingress } }))))
            .toMatchObject({ ok: false, error: 'deployment_invalid' });
    });

    it.each([{ kind: 'account', mode: 'plain' }, { kind: 'team', mode: 'plain' },
        { kind: 'account', mode: 'e2ee' }, { kind: 'team', mode: 'e2ee' }] as const)(
        'creates a repository-free $kind/$mode Project and Environment in one apply transaction and rolls both back on refusal', async ({ kind, mode }) => {
        const contentKeys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(contentKeys.publicKey) : {}) } });
        const team = kind === 'team' ? await db.team.create({ data: { name: 'New catalog app owner' } }) : null;
        if (team) await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const signing = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: mode === 'plain' ? encodePlainMachineStoredContent({}) : '{}',
            ...(mode === 'plain' ? { dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } : {}),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(signing.publicKey) } });
        const key = nacl.randomBytes(32);
        const header = { kind: 'deployment-environment.v1', title: 'New catalog app' };
        const body = { body: JSON.stringify({ name: 'New catalog app', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'stored', document: 'services:\n  app:\n    image: nginx:1\n', contentRevision: 1,
                composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] } }) };
        const content = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
            header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(header))
                : new Uint8Array(await sealSessionDataKeyBundleV0(header, key)),
            body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(body))
                : new Uint8Array(await sealSessionDataKeyBundleV0(body, key)),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                    recipientPublicKey: contentKeys.publicKey, randomBytes: nacl.randomBytes })) });
        if (!content.ok) throw new Error(content.error);
        if (team) {
            await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId: machine.id } });
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), artifactId: content.artifact.id } });
        }
        const input = { serverId, requestKey: crypto.randomUUID(), newProject: { name: `APP-ENTRY ${owner.id}`,
            owner: team ? { kind: 'team' as const, teamId: team.id } : { kind: 'account' as const, accountId: owner.id }, requestKey: crypto.randomUUID() },
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: machine.id, contentArtifactId: content.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(0);
        const parsed = DeploymentEnvironmentCreateInputV1Schema.parse(input);
        const target = { kind: 'machine' as const, machineId: machine.id };
        const authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId, requestKey: input.requestKey,
            name: 'New catalog app', newProject: input.newProject, protection: input.protection, purpose: input.purpose,
            deployerMode: input.deployerMode, controllerMachineId: machine.id,
            definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } },
            firstTargetLink: { machines: [{ machineId: machine.id, installationId: machine.installationId! }] } });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: authored };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
            actionId: 'deployments.environments.create', machineId: machine.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: authored });
        // Preparation admits the intended owner without manufacturing a Source.
        expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(0);
        let createdResponse: unknown;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const path = '/v1/deployments/environments';
            const response = await app.inject({ method: 'POST', url: path, payload: parsed, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.environments.create',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.environments.create', target,
                    installationId: machine.installationId!, requestId: envelope.requestId,
                    method: 'POST', path, body: parsed, privateKey: signing.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            createdResponse = response.json();
        }, { authentication: 'real' });
        const created = DeploymentEnvironmentCreateResultV1Schema.parse(createdResponse);
        if (!created.ok) throw new Error(created.error);
        const loaded = await inTx(tx => loadDeploymentEnvironmentInTx(tx, owner.id, serverId, created.environmentId));
        if (!loaded.ok) throw new Error(loaded.error);
        expect(loaded.admission.source).toMatchObject({ name: input.newProject.name, owner: input.newProject.owner });
        expect(created).toMatchObject({ projectSourceId: loaded.admission.source.id });
        expect(loaded.admission.source.repository).toBeUndefined();
        expect(await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, parsed)))
            .toEqual({ ...created, replayed: true });
        expect(await db.deploymentEnvironment.count({ where: { projectSourceId: loaded.admission.source.id } })).toBe(1);
        expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(1);
        const refused = DeploymentEnvironmentCreateInputV1Schema.parse({ ...input, requestKey: crypto.randomUUID(),
            newProject: { ...input.newProject, requestKey: crypto.randomUUID(), name: 'Refused project' }, controllerMachineId: 'unavailable' });
        await expect(inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, refused))).rejects.toMatchObject({
            failure: { ok: false, error: 'machine_unavailable' },
        });
        expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(1);
        const foreign = DeploymentEnvironmentCreateInputV1Schema.parse({ ...input, requestKey: crypto.randomUUID(),
            newProject: { ...input.newProject, requestKey: crypto.randomUUID(), owner: { kind: 'account', accountId: 'someone-else' } } });
        expect(await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, foreign))).toMatchObject({ ok: false });
        expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(1);
    });

    it.each(['runtime', 'build'] as const)('keeps Source owner CAS sensitive to %s grant demand after a runtime joins', async phase => {
        const keys = nacl.box.keyPair();
        const creator = await db.account.create({ data: { encryptionMode: 'e2ee',
            ...createSignedAccountContentBinding(keys.publicKey) } });
        const team = await db.team.create({ data: { name: 'Exact binding uses' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Exact current destinations', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const [first, joining] = await Promise.all([0, 1].map(() => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: creator.id, metadata: '{}', installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey),
        } })));
        await db.machineGrant.createMany({ data: [first!, joining!].map(machine => ({ ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view' as const, createdByAccountId: creator.id }), machineId: machine.id })) });
        const artifact = async (kind: string, storedKind: string, content: unknown) => {
            const key = nacl.randomBytes(32);
            const created = await createArtifact({ actorUserId: creator.id, artifactId: crypto.randomUUID(), kind: storedKind,
                header: new Uint8Array(await sealSessionDataKeyBundleV0({ kind, title: 'Private binding intent' }, key)),
                body: new Uint8Array(await sealSessionDataKeyBundleV0({ body: JSON.stringify(content) }, key)),
                dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                    recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) });
            if (!created.ok) throw new Error(created.error);
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: creator.id }), artifactId: created.artifact.id } });
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const definition = { kind: 'stored' as const, document: '{"services":{"app":{"image":"app:1"}}}',
            contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] };
        const emptyContent = await artifact('deployment-environment.v1', DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
            { name: 'Exact current destinations', retainPreviousDeployments: 1, definition, bindings: [] });
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, creator.id, {
            serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: first!.id, buildMachineId: first!.id, ...emptyContent,
        }));
        if (!environment.ok) throw new Error(environment.error);
        const initialTargetContent = await artifact('deployment-target-link.v1', DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, {});
        const initial = await inTx(tx => linkDeploymentTargetInTx(tx, creator.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision, requestKey: crypto.randomUUID(),
            role: 'runtime', targetId: 'own-server', machines: [{ machineId: first!.id, installationId: first!.installationId! }],
            ...initialTargetContent }));
        if (!initial.ok) throw new Error(initial.error);
        const resourceId = crypto.randomUUID();
        const resourceDataKey = nacl.randomBytes(32);
        const secret = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: creator.id, resourceId,
            displayName: 'Exact credential', kind: 'token', encryptionMode: 'e2ee', teamGrants: [team.id],
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
                content: { v: 1, name: 'Exact credential', kind: 'token', value: 'private-test-material' }, randomBytes: nacl.randomBytes }),
            keyEnvelopes: [{ recipientAccountId: creator.id,
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey),
                encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey,
                    recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) }] }));
        if (!secret.ok) throw new Error(`Expected admitted Saved Secret: ${secret.error}`);
        const bindings = [{ purpose: 'variable' as const, phase, name: 'TOKEN',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }];
        const boundContent = await artifact('deployment-environment.v1', DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
            { name: 'Exact current destinations', retainPreviousDeployments: 1, definition,
                bindings });
        const grant = (machine: typeof first): MachineSecretGrantV1 => ({ v: 1, kind: 'secret',
            environmentId: environment.environmentId, machineId: machine!.id, installationId: machine!.installationId!,
            resourceId, resourceRevision: 1, sealedContent: 'opaque-client-sealed-material' });
        // Both uses legitimately start with the same one installation grant:
        // A is both builder and sole runtime. Its encrypted binding intent differs.
        const bound = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, creator.id, {
            serverId, environmentId: environment.environmentId, expectedRevision: initial.revision,
            ...boundContent, referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(bindings), grants: [grant(first)],
        }));
        if (!bound.ok) throw new Error(bound.error);
        expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, creator.id, {
            serverId, environmentId: environment.environmentId, expectedRevision: bound.revision,
            ...boundContent, referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(bindings), grants: [grant(first)],
        }))).toEqual(bound);
        const appendedTargetContent = await artifact('deployment-target-link.v1', DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, {});
        const appended = await inTx(tx => linkDeploymentTargetInTx(tx, creator.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: bound.revision, requestKey: crypto.randomUUID(),
            role: 'runtime', targetId: 'own-server', replacesLinkId: initial.targetLinkId,
            expectedTargetLinkRevision: initial.targetLinkRevision, machines: [first!, joining!].map(machine => ({
                machineId: machine.id, installationId: machine.installationId!,
            })), ...appendedTargetContent }));
        if (!appended.ok) throw new Error(appended.error);
        const owner = { kind: 'team' as const, teamId: team.id };
        const flip = () => inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId, sourceId: source.source.id,
            expectedRevision: source.source.revision, patch: { owner } }), { isolationLevel: 'Serializable' });
        if (phase === 'runtime') {
            expect(await flip()).toMatchObject({ ok: false, error: 'source_conflict' });
            expect(await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } }))
                .toMatchObject({ revision: source.source.revision, owner: { kind: 'account', accountId: creator.id } });
            const prepared = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, creator.id, {
                serverId, environmentId: environment.environmentId, expectedRevision: appended.revision,
                ...boundContent, referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(bindings), grants: [grant(first), grant(joining)],
            }));
            expect(prepared).toMatchObject({ ok: true });
        }
        // Build-only use stays valid without delivering its secret to B.
        expect(await flip()).toMatchObject({ ok: true, source: { owner, revision: source.source.revision + 1 } });
    });

    it('keeps Source owner CAS separate from explicit CI root and child reapproval', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain', publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: 'CI successor' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'CI custody', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID() } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: creator.id }), machineId: machine.id } });
        const artifact = await createArtifact({ actorUserId: creator.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'CI custody' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: creator.id }), artifactId: artifact.artifact.id } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: creator.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, contentArtifactId: artifact.artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1, referencedSavedSecretRevisions: [] } });
        // Full-grant roots and narrowed children both authorize this exact Environment.
        const root = await auth.createApiToken({ accountId: creator.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(creator.id, 'CI root') });
        const principal = (await auth.verifyToken(root.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Expected root API-token principal');
        const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
            targets: { sessions: [], machines: [], environments: [environment.id] } });
        const child = await auth.createChildApiToken({ principal, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(principal.accountId, 'CI child'),
            expiresAt: new Date(Date.now() + 3_600_000), grant });
        const owner = { kind: 'team' as const, teamId: team.id };
        const flip = () => inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId,
            sourceId: source.source.id, expectedRevision: source.source.revision, patch: { owner } }), { isolationLevel: 'Serializable' });
        const credentials = await Promise.all([root.token, child.token].map(token => auth.verifyToken(token)));
        expect(credentials.every(credential => credential !== null)).toBe(true);
        const tokens = await db.accountApiToken.findMany({ where: { accountId: creator.id }, orderBy: { id: 'asc' } });
        // P40-3b flips the Source first; the same Move must explicitly reapprove
        // its reviewed dependents before withdrawal, not inside this generic CAS.
        expect(await flip()).toMatchObject({ ok: true, source: { owner, revision: source.source.revision + 1 } });
        expect(await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } }))
            .toMatchObject({ revision: source.source.revision + 1, owner });
        expect(await db.accountApiToken.findMany({ where: { accountId: creator.id }, orderBy: { id: 'asc' } })).toEqual(tokens);
        expect(await Promise.all([root.token, child.token].map(token => auth.verifyToken(token)))).toEqual(credentials);
    });

    it.each(['plain', 'e2ee'] as const)('keeps a %s Source owner CAS closed until exact shared defaults and recipient custody are ready', async mode => {
        const keys = [nacl.box.keyPair(), nacl.box.keyPair()];
        const [creator, manager] = await Promise.all(keys.map(key => db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(key.publicKey) : {}) } })));
        const team = await db.team.create({ data: { name: 'Defaults successor' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: creator.id, role: 'owner' },
            { teamId: team.id, accountId: manager.id, role: 'admin' },
        ] });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Retained defaults', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const key = nacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)) : new Uint8Array(await sealSessionDataKeyBundleV0(value, key));
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
            recipientPublicKey: publicKey, randomBytes: nacl.randomBytes }));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
            kind: 'v1:other:project-deployment-defaults.v1', headerVersion: 1, bodyVersion: 1,
            header: await seal({ kind: 'project-deployment-defaults.v1', title: 'Private defaults' }),
            body: await seal({ body: JSON.stringify({ projectSourceId: source.source.id,
                deploymentDefaults: { retainPreviousDeployments: 0 } }) }),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : wrap(keys[0]!.publicKey) } });
        const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        expect(await inTx(tx => setProjectDeploymentDefaultsInTx(tx, creator.id, { serverId,
            projectSourceId: source.source.id, expectedSourceRevision: source.source.revision, expectedRevision: 0, content })))
            .toMatchObject({ ok: true, revision: 1, content });
        const owner = { kind: 'team' as const, teamId: team.id };
        const flip = (expectedRevision = source.source.revision) => inTx(tx => updateProjectSourceInTx(tx, creator.id,
            { serverId, sourceId: source.source.id, expectedRevision, patch: { owner } }), { isolationLevel: 'Serializable' });
        const refusedWithoutEffect = async () => {
            const before = await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } });
            const changes = await db.accountChange.findMany({ where: { entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 }, orderBy: { accountId: 'asc' } });
            expect(await flip()).toMatchObject({ ok: false, error: 'source_conflict' });
            expect(await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } })).toEqual(before);
            expect(await db.accountChange.findMany({ where: { entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 }, orderBy: { accountId: 'asc' } })).toEqual(changes);
        };
        await refusedWithoutEffect();
        // Direct access for today's members is not the Team's durable management grant.
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: manager.id,
            accessLevel: 'admin', createdByAccountId: creator.id } });
        if (mode === 'e2ee') await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id,
            recipientAccountId: manager.id, encryptedDataKey: wrap(keys[1]!.publicKey),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys[1]!.publicKey) } });
        await refusedWithoutEffect();
        await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: artifact.id, accountId: manager.id } });
        await db.artifactKeyEnvelope.deleteMany({ where: { artifactId: artifact.id, recipientAccountId: manager.id } });
        await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'edit', createdByAccountId: creator.id }), artifactId: artifact.id } });
        if (mode === 'e2ee') {
            await refusedWithoutEffect();
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: manager.id,
                encryptedDataKey: wrap(keys[1]!.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys[1]!.publicKey) } });
        }
        await db.projectDeploymentDefaults.update({ where: { projectSourceId: source.source.id }, data: { contentBodyVersion: 2 } });
        await refusedWithoutEffect();
        await db.projectDeploymentDefaults.update({ where: { projectSourceId: source.source.id }, data: { contentBodyVersion: 1 } });
        expect(await flip(source.source.revision + 1)).toMatchObject({ ok: false, error: 'source_conflict' });
        const moved = await flip();
        expect(moved).toMatchObject({ ok: true, source: { owner, revision: source.source.revision + 1 } });
        if (!moved.ok) throw new Error(moved.error);
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: creator.id } });
        expect(await inTx(tx => readProjectDeploymentDefaultsInTx(tx, manager.id,
            { serverId, projectSourceId: source.source.id }))).toMatchObject({ ok: true, content });
        const readerKey = nacl.box.keyPair();
        const reader = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(readerKey.publicKey) : {}) } });
        await makeShareEligibleForTest(manager.id, reader.id);
        const audience = [{ principal: { kind: 'account' as const, accountId: reader.id }, level: 'view' as const }];
        const expand = () => inTx(tx => updateProjectSourceInTx(tx, manager.id, { serverId,
            sourceId: source.source.id, expectedRevision: moved.source.revision, patch: { audience } }), { isolationLevel: 'Serializable' });
        // Source audience edits do not transfer ownership or pre-share dependent Artifacts.
        expect(await expand()).toMatchObject({ ok: true, source: { owner, audience, revision: moved.source.revision + 1 } });
        if (mode === 'plain') {
            expect(await inTx(tx => readProjectDeploymentDefaultsInTx(tx, reader.id,
                { serverId, projectSourceId: source.source.id }))).toMatchObject({ ok: true, content });
        }
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: manager.id } });
        if (mode === 'e2ee') {
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: reader.id,
                encryptedDataKey: wrap(readerKey.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(readerKey.publicKey) } });
        }
        expect(await inTx(tx => readProjectDeploymentDefaultsInTx(tx, reader.id,
            { serverId, projectSourceId: source.source.id }))).toMatchObject({ ok: true, content });
    });

    it('refuses a Team admin owner flip to their own Account despite prepared defaults custody', async () => {
        const [ownerAccount, administrator] = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: 'Retained Team control' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: ownerAccount.id, role: 'owner' },
            { teamId: team.id, accountId: administrator.id, role: 'admin' },
        ] });
        const owner = { kind: 'team' as const, teamId: team.id };
        const source = await inTx(tx => createProjectSourceInTx(tx, administrator.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Team defaults', audience: [], owner,
        }));
        if (!source.ok) throw new Error(source.error);
        const encode = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: administrator.id,
            kind: 'v1:other:project-deployment-defaults.v1', headerVersion: 1, bodyVersion: 1,
            header: encode({ kind: 'project-deployment-defaults.v1', title: 'Team defaults' }),
            body: encode({ body: JSON.stringify({ projectSourceId: source.source.id, deploymentDefaults: { retainPreviousDeployments: 0 } }) }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: administrator.id }), artifactId: artifact.id } });
        const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        expect(await inTx(tx => setProjectDeploymentDefaultsInTx(tx, administrator.id, { serverId,
            projectSourceId: source.source.id, expectedSourceRevision: source.source.revision, expectedRevision: 0, content })))
            .toMatchObject({ ok: true, content });
        const before = await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } });
        expect(await inTx(tx => updateProjectSourceInTx(tx, administrator.id, { serverId, sourceId: source.source.id,
            expectedRevision: source.source.revision, patch: { owner: { kind: 'account', accountId: administrator.id } } }),
        { isolationLevel: 'Serializable' })).toEqual({ ok: false, error: 'source_access_denied' });
        expect(await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } })).toEqual(before);
        expect(await inTx(tx => readProjectDeploymentDefaultsInTx(tx, ownerAccount.id,
            { serverId, projectSourceId: source.source.id }))).toMatchObject({ ok: true, content });
    });


    it('refuses a Source-only owner flip until every live and retained deployment dependency is prepared', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Prepared Source owner' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: creator.id, role: 'owner' },
            { teamId: team.id, accountId: manager.id, role: 'admin' },
        ] });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Moving Production', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const machines = await Promise.all(Array.from({ length: 9 }, () => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: creator.id, metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey),
        } })));
        const [controller, builder, edge, first, second, retiring, detached, acceptedController, acceptedBuilder] = machines;
        const artifact = async (kind: string) => {
            const result = await createArtifact({ actorUserId: creator.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Moving private content' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environmentContent = await artifact('deployment-environment.v1');
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: creator.id, protection: 'production', purpose: 'standard', deployerMode: 'members',
            controllerMachineId: controller!.id, buildMachineId: builder!.id, edgeMachineId: edge!.id, ...environmentContent } });
        const targetContent = await artifact('deployment-target-link.v1');
        const runtime = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: creator.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...targetContent,
            machines: { create: [first!, second!].map((machine, position) => ({ machineId: machine.id,
                installationId: machine.installationId!, position, state: 'active' })) } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: runtime.id } });
        const retiredContent = await artifact('deployment-target-link.v1');
        await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: creator.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', deletedAt: new Date(), ...retiredContent,
            machines: { create: { machineId: retiring!.id, installationId: retiring!.installationId!, position: 0, state: 'active' } } } });
        const detachedContent = await artifact('deployment-target-link.v1');
        await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: creator.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', detachedAt: new Date(), ...detachedContent,
            machines: { create: { machineId: detached!.id, installationId: detached!.installationId!, position: 0, state: 'active' } } } });
        const receiptContent = await artifact('deployment-receipt.v1');
        const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: runtime.id,
            requestedByAccountId: creator.id, operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), ...receiptContent } });
        const acceptedContent = await artifact('deployment-receipt.v1');
        await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: runtime.id,
            requestedByAccountId: creator.id, operation: 'deploy', state: 'running', requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(),
            acceptedControllerMachineId: acceptedController!.id, acceptedControllerInstallationId: acceptedController!.installationId!,
            acceptedBuildMachineId: acceptedBuilder!.id, acceptedBuildInstallationId: acceptedBuilder!.installationId!, ...acceptedContent } });
        const resourceId = crypto.randomUUID();
        const secret = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: creator.id, resourceId,
            displayName: 'Moving credential', kind: 'token', encryptionMode: 'plain', teamGrants: [],
            storedContent: { t: 'plain', v: { v: 1, name: 'Moving credential', kind: 'token', value: 'private-test-material' } } }));
        if (!secret.ok) throw new Error('Secret fixture unavailable');
        // The sole binding writer's stored reference census is the server-visible E2EE-safe boundary.
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: {
            referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
        } });
        const oldResourceId = crypto.randomUUID();
        const oldSecret = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: creator.id, resourceId: oldResourceId,
            displayName: 'Detached credential', kind: 'token', encryptionMode: 'plain', teamGrants: [],
            storedContent: { t: 'plain', v: { v: 1, name: 'Detached credential', kind: 'token', value: 'old-test-material' } } }));
        if (!oldSecret.ok) throw new Error('Detached secret fixture unavailable');
        const currentGrants = [first!, second!, builder!].map(machine => ({ v: 1 as const,
            kind: 'secret' as const, environmentId: environment.id, machineId: machine.id, installationId: machine.installationId!,
            resourceId, resourceRevision: 1, sealedContent: 'opaque-current-installation-envelope' })) satisfies readonly MachineSecretGrantV1[];
        // A retained detached installation is no longer a current secret consumer.
        const grants = [...currentGrants, { v: 1 as const,
            kind: 'secret', environmentId: environment.id, machineId: detached!.id, installationId: detached!.installationId!,
            resourceId: oldResourceId, resourceRevision: 1, sealedContent: 'opaque-retained-installation-envelope' }] satisfies readonly MachineSecretGrantV1[];
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: environment.id, grants }));
        const tombstoneContent = await artifact('deployment-environment.v1');
        const tombstone = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: creator.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: detached!.id, deletedAt: new Date(), ...tombstoneContent,
            referencedSavedSecretRevisions: [{ resourceId: oldResourceId, revision: 1 }] } });
        const contents = [environmentContent, targetContent, retiredContent, detachedContent, receiptContent, acceptedContent, tombstoneContent];
        const owner = { kind: 'team' as const, teamId: team.id };
        const flip = () => inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId, sourceId: source.source.id,
            expectedRevision: source.source.revision, patch: { owner } }));
        const unchanged = async () => {
            expect(await flip()).toMatchObject({ ok: false, error: 'source_conflict' });
            expect(await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } }))
                .toMatchObject({ revision: source.source.revision, owner: { kind: 'account', accountId: creator.id } });
        };
        await unchanged();
        // Prepare through the existing resource grant tables before testing each missing fact independently.
        for (const machine of [controller!, builder!, edge!, first!, acceptedController!, acceptedBuilder!]) await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: creator.id }), machineId: machine.id } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: creator.id }), machineId: second!.id } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: creator.id }), machineId: retiring!.id } });
        // Retained detached/retiring link and receipt content must remain readable too.
        for (const content of contents) {
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: creator.id }), artifactId: content.contentArtifactId } });
        }
        await db.savedSecretTeamGrant.create({ data: { resourceId, teamId: team.id, createdByAccountId: creator.id } });
        // Even complete delivered grants cannot prove a retained resource-only capture's purpose.
        await unchanged();
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: {
            referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(['runtime', 'build'].map(phase => ({
                purpose: 'variable' as const, phase: phase === 'runtime' ? 'runtime' as const : 'build' as const,
                name: phase === 'runtime' ? 'TOKEN' : 'BUILD_TOKEN',
                source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 },
            }))),
        } });
        for (const machine of [controller!, builder!, edge!, first!, second!, retiring!, acceptedController!, acceptedBuilder!]) {
            await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: machine.id, teamId: team.id } });
            await unchanged();
            await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: creator.id }), machineId: machine.id } });
        }
        for (const content of contents) {
            await db.artifactGrant.deleteMany({ where: { principalKind: 'team', artifactId: content.contentArtifactId, teamId: team.id } });
            await unchanged();
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: creator.id }), artifactId: content.contentArtifactId } });
        }
        await db.savedSecretTeamGrant.deleteMany({ where: { resourceId, teamId: team.id } });
        await unchanged();
        await db.savedSecretTeamGrant.create({ data: { resourceId, teamId: team.id, createdByAccountId: creator.id } });
        await db.machine.update({ where: { id: second!.id }, data: { installationId: crypto.randomUUID() } });
        await unchanged();
        await db.machine.update({ where: { id: second!.id }, data: { installationId: second!.installationId } });
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: environment.id,
            grants: grants.filter(grant => grant.resourceId !== resourceId) }));
        await unchanged();
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: environment.id, grants }));
        const moved = await flip();
        expect(moved).toMatchObject({ ok: true, source: { owner, revision: source.source.revision + 1,
            createdByAccountId: creator.id } });
        if (!moved.ok) throw new Error(moved.error);
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: creator.id } });
        expect(await inTx(tx => resolveDeploymentEnvironmentAdmissionInTx(tx, manager.id,
            { serverId, projectSourceId: source.source.id }))).toMatchObject({ ok: true, admission: { owner, canManage: true } });
        expect(await inTx(tx => readDeploymentEnvironmentInTx(tx, manager.id, { serverId, environmentId: environment.id })))
            .toMatchObject({ ok: true, environment: { owner }, targetLinks: expect.arrayContaining([
                expect.objectContaining({ detachedAtMs: expect.any(Number) }), expect.objectContaining({ deletedAtMs: expect.any(Number) }),
            ]) });
        expect(await inTx(tx => readDeploymentReceiptInTx(tx, manager.id, { serverId, deploymentId: receipt.id })))
            .toMatchObject({ ok: true, deployment: { id: receipt.id } });
        expect(await inTx(tx => readDeploymentEnvironmentInTx(tx, manager.id, { serverId, environmentId: tombstone.id })))
            .toMatchObject({ ok: true, environment: { deletedAtMs: expect.any(Number), capabilities: { deploy: false } } });
        expect(await inTx(tx => readSavedSecretResourcesForPrincipalInTx(tx, owner, [resourceId])))
            .toMatchObject([{ revision: 1, capabilities: { use: true } }]);
        expect(await inTx(tx => admitDeploymentMachinesInTx(tx, owner, [first!, second!, retiring!].map(machine => ({
            machineId: machine.id, installationId: machine.installationId!, role: 'target' as const,
        }))))).toBeNull();
        expect(await inTx(tx => resolveDeploymentEnvironmentAdmissionInTx(tx, creator.id,
            { serverId, projectSourceId: source.source.id }))).toMatchObject({ ok: false, error: 'deployment_unavailable' });
        const childReads: string[] = [];
        const stop = observeSqliteRequests({ before: request => {
            if (request.model && ['DeploymentEnvironment', 'ProjectDeploymentDefaults', 'Artifact', 'ArtifactGrant',
                'Machine', 'MachineGrant', 'MachineSecretGrant', 'SavedSecretResource', 'AccountApiToken', 'Automation']
                .includes(request.model)) childReads.push(`${request.model}:${request.action}`);
        } });
        try {
            expect(await inTx(tx => updateProjectSourceInTx(tx, manager.id, { serverId, sourceId: source.source.id,
                expectedRevision: moved.source.revision, patch: { owner } }))).toEqual(moved);
            expect(childReads).toEqual([]);
            expect(await inTx(tx => updateProjectSourceInTx(tx, manager.id, { serverId, sourceId: source.source.id,
                expectedRevision: moved.source.revision, patch: { owner, name: 'Renamed Production' } })))
                .toMatchObject({ ok: true, source: { owner, name: 'Renamed Production', revision: moved.source.revision + 1 } });
            expect(childReads).toEqual([]);
        } finally { stop(); }
    });

    it('stores exact chosen Account/Group references and re-admits projection and receipt cancellation after membership and Source changes', async () => {
        const [owner, selected, guest, reader, outsider] = await Promise.all(Array.from({ length: 5 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: 'Chosen group' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: 'guest' } });
        const createdGroup = await inTx(tx => createTeamGroupForActorInTx(tx, { teamId: team.id,
            actorAccountId: owner.id, groupId: crypto.randomUUID(), name: plainPrivateLabel('Explicit deployers'), requestKey: crypto.randomUUID() }));
        if (!createdGroup.ok) throw new Error(createdGroup.error);
        const group = createdGroup.value;
        const addedMember = await inTx(tx => addTeamGroupMemberForActorInTx(tx, { teamId: team.id,
            actorAccountId: owner.id, groupId: group.id, accountId: guest.id, historyAccess: 'from_membership' }));
        if (!addedMember.ok) throw new Error(addedMember.error);
        await makeShareEligibleForTest(owner.id, [selected.id, guest.id, reader.id]);
        const accountGrants = [selected, guest, reader].map(account => ({ principal: { kind: 'account' as const, accountId: account.id }, level: 'view' as const }));
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Chosen authority', audience: [...accountGrants,
                { principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'view' }] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID() } });
        const content = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Chosen authority' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ name: 'Chosen authority',
                retainPreviousDeployments: 1, bindings: [], definition: { kind: 'stored', document: '{"services":{"app":{"image":"app:1"}}}',
                    contentRevision: 1, composeDigest: 'sha256:' + 'a'.repeat(64), profiles: [], services: ['app'] } }) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!content.ok) throw new Error(content.error);
        const reference = { contentArtifactId: content.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        // The protocol owner is part of this contract: ignoring an unknown policy operand cannot pass RED.
        const createInput = DeploymentEnvironmentCreateInputV1Schema.parse({ ...reference, serverId, projectSourceId: source.source.id,
            requestKey: crypto.randomUUID(), protection: 'production', purpose: 'standard', deployerMode: 'chosen',
            controllerMachineId: machine.id, deployerPrincipals: [{ kind: 'account', accountId: selected.id },
                { kind: 'group', teamId: team.id, groupId: group.id }] });
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, createInput));
        if (!created.ok) throw new Error(created.error);
        const environmentId = created.environmentId;
        const projection = async (accountId: string) => {
            const loaded = await inTx(tx => loadDeploymentEnvironmentInTx(tx, accountId, serverId, environmentId));
            if (!loaded.ok) return loaded;
            return projectDeploymentEnvironmentHeader(loaded.row, serverId, loaded.admission);
        };
        expect(await projection(owner.id)).toMatchObject({ capabilities: { role: 'manager', deploy: true } });
        expect(await projection(selected.id)).toMatchObject({ capabilities: { role: 'deployer', deploy: true } });
        expect(await projection(guest.id)).toMatchObject({ capabilities: { role: 'deployer', deploy: true } });
        expect(await projection(reader.id)).toMatchObject({ capabilities: { role: 'reader', deploy: false } });
        const relations = await db.deploymentEnvironmentDeployer.findMany({ where: { environmentId } });
        expect(relations).toHaveLength(2);
        expect(relations.every(row => row.createdByAccountId === owner.id)).toBe(true);
        const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        const update = (patch: unknown, expectedRevision = created.revision) => inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateInputV1Schema.parse({ ...reference, serverId, environmentId, expectedRevision, patch })));
        expect(await update({ deployerPrincipals: [...createInput.deployerPrincipals!].reverse() })).toMatchObject({ ok: true, revision: created.revision });
        expect(await db.deploymentEnvironmentDeployer.findMany({ where: { environmentId } })).toEqual(relations);
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
        expect(await update({ deployerPrincipals: [{ kind: 'account', accountId: outsider.id }] }))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        expect(await db.deploymentEnvironmentDeployer.findMany({ where: { environmentId } })).toEqual(relations);
        expect(await update({ deployerMode: 'members' })).toMatchObject({ ok: true, revision: created.revision + 1 });
        // Guest is explicitly Source-readable, but the member policy does not derive Team deploy rights from a guest role.
        // The direct Account grant is an independent members-mode path; remove it for this control.
        const groupAudience = accountGrants.filter(grant => grant.principal.accountId !== guest.id);
        const currentSource = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
            expectedRevision: source.source.revision, patch: { audience: [...groupAudience,
                { principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'view' }] } }));
        if (!currentSource.ok) throw new Error(currentSource.error);
        expect(await projection(guest.id)).toMatchObject({ capabilities: { role: 'reader', deploy: false } });
        expect(await update({ deployerMode: 'chosen' }, created.revision + 1)).toMatchObject({ ok: true, revision: created.revision + 2 });
        expect(await projection(guest.id)).toMatchObject({ capabilities: { role: 'deployer', deploy: true } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId, createdByAccountId: owner.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed', ...reference } });
        const receipt = await db.deployment.create({ data: { environmentId, targetLinkId: link.id, requestedByAccountId: selected.id,
            operation: 'deploy', state: 'running', requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...reference } });
        const cancellation = { serverId, environmentId, deploymentId: receipt.id, expectedReceiptRevision: receipt.revision };
        expect(await inTx(tx => requestCancelDeploymentInTx(tx, reader.id, cancellation)))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        expect(await projection(guest.id)).toEqual({ ok: false, error: 'deployment_unavailable' });
        expect(await inTx(tx => requestCancelDeploymentInTx(tx, guest.id, cancellation)))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        expect((await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).state).toBe('running');
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
        expect(await projection(guest.id)).toMatchObject({ capabilities: { role: 'deployer', deploy: true } });
        // Keep this Account readable after the Group scope is removed: stale Group references must still lose deploy authority.
        const otherSource = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Independent Group scope', audience: [{ principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'view' }] }));
        if (!otherSource.ok) throw new Error(otherSource.error);
        const otherEnvironment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...createInput, projectSourceId: otherSource.source.id, requestKey: crypto.randomUUID(),
            deployerPrincipals: [{ kind: 'group', teamId: team.id, groupId: group.id }],
        }));
        if (!otherEnvironment.ok) throw new Error(otherEnvironment.error);
        const removed = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
            expectedRevision: currentSource.source.revision, patch: { audience: accountGrants } }));
        if (!removed.ok) throw new Error(removed.error);
        expect(await projection(guest.id)).toMatchObject({ capabilities: { role: 'reader', deploy: false } });
        // One credential/membership census must not lend another Source's Group scope
        // to a retained chosen relation; the ordinary admitted Group remains usable.
        expect(await inTx(tx => readDeploymentEnvironmentAccessInTx(tx, guest.id, { serverId,
            environmentIds: [environmentId, otherEnvironment.environmentId] }))).toEqual({ ok: true, items: [
            { environmentId, read: true, deploy: false },
            { environmentId: otherEnvironment.environmentId, read: true, deploy: true },
        ] });
        expect(await inTx(tx => requestCancelDeploymentInTx(tx, guest.id, cancellation)))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        expect(await inTx(tx => requestCancelDeploymentInTx(tx, selected.id, cancellation)))
            .toMatchObject({ ok: true, state: 'outcome_unknown' });
        // Tightening policy remains possible when a retained chosen reference is no longer Source-eligible.
        expect(await update({ deployerMode: 'managers' }, created.revision + 2)).toMatchObject({ ok: true, revision: created.revision + 3 });
        expect(await projection(selected.id)).toMatchObject({ capabilities: { role: 'reader', deploy: false } });
        // Builder rebinding and an admitted policy edit share one Environment CAS;
        // the binding writer cannot silently drop the same reviewed policy patch.
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateStorageInputV1Schema.parse({ ...reference, serverId, environmentId,
                expectedRevision: created.revision + 3, patch: { buildMachineId: machine.id, deployerMode: 'chosen',
                    deployerPrincipals: [{ kind: 'account', accountId: selected.id }] },
                preparedBindings: { grants: [], referencedSavedSecretRevisions: [] },
            })))).toMatchObject({ ok: true, revision: created.revision + 4 });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } }))
            .toMatchObject({ buildMachineId: machine.id, deployerMode: 'chosen', revision: created.revision + 4 });
        expect(await db.deploymentEnvironmentDeployer.findMany({ where: { environmentId } }))
            .toMatchObject([{ purpose: 'deploy', principalKind: 'account', principalId: selected.id }]);
        expect(await projection(selected.id)).toMatchObject({ capabilities: { role: 'deployer', deploy: true } });
        await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { deletedAt: new Date() } });
        expect(await projection(selected.id)).toMatchObject({ capabilities: { role: 'reader', deploy: false } });
    });

    it('admits a chosen Team for deploys and database edits through one matcher until membership ends (TS.P3.F5a)', async () => {
        const [owner, member, outsider] = await Promise.all(Array.from({ length: 3 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: 'Chosen Team' } });
        const otherTeam = await db.team.create({ data: { name: 'Other Team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        await db.teamMembership.create({ data: { teamId: otherTeam.id, accountId: outsider.id, role: 'member' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Team authority', audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID() } });
        const content = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Team authority' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ name: 'Team authority',
                retainPreviousDeployments: 1, bindings: [], definition: { kind: 'stored', document: '{"services":{"app":{"image":"app:1"}}}',
                    contentRevision: 1, composeDigest: 'sha256:' + 'b'.repeat(64), profiles: [], services: ['app'] } }) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!content.ok) throw new Error(content.error);
        const reference = { contentArtifactId: content.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const teamRef = { kind: 'team' as const, teamId: team.id };
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, DeploymentEnvironmentCreateInputV1Schema.parse({
            ...reference, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'production',
            purpose: 'standard', deployerMode: 'chosen', controllerMachineId: machine.id, deployerPrincipals: [teamRef] })));
        if (!created.ok) throw new Error(created.error);
        const environmentId = created.environmentId;
        const load = (accountId: string) => inTx(tx => loadDeploymentEnvironmentInTx(tx, accountId, serverId, environmentId));
        const projection = async (accountId: string) => {
            const loaded = await load(accountId);
            return loaded.ok ? projectDeploymentEnvironmentHeader(loaded.row, serverId, loaded.admission) : loaded;
        };
        const canEdit = async (accountId: string) => {
            const loaded = await load(accountId);
            return loaded.ok && canEditDeploymentEnvironmentData(loaded.admission, loaded.row);
        };
        // G1 control: the Team member is admitted to deploy through the chosen Team before any refusal counts.
        expect(await projection(member.id)).toMatchObject({ capabilities: { role: 'deployer', deploy: true, editData: false },
            deployerPrincipals: [teamRef], dataEditorMode: 'off', dataAgentAccess: 'read', dataEditors: [] });
        expect(await canEdit(member.id)).toBe(false);
        expect(await canEdit(owner.id)).toBe(false);
        const update = (patch: unknown, expectedRevision: number) => inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id,
            DeploymentEnvironmentUpdateInputV1Schema.parse({ ...reference, serverId, environmentId, expectedRevision, patch })));
        // A Team the Source does not name cannot be chosen.
        expect(await update({ dataEditorMode: 'chosen', dataEditors: [{ kind: 'team', teamId: otherTeam.id }] }, created.revision))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        expect(await update({ dataEditorMode: 'chosen', dataEditors: [teamRef] }, created.revision))
            .toMatchObject({ ok: true, revision: created.revision + 1 });
        // An unchanged Save writes nothing.
        expect(await update({ dataEditorMode: 'chosen', dataEditors: [teamRef], dataAgentAccess: 'read' }, created.revision + 1))
            .toMatchObject({ ok: true, revision: created.revision + 1 });
        expect((await db.deploymentEnvironmentDeployer.findMany({ where: { environmentId }, orderBy: { purpose: 'asc' } }))
            .map(row => [row.purpose, row.principalKind, row.principalId])).toEqual([['dataEdit', 'team', team.id], ['deploy', 'team', team.id]]);
        expect(await projection(member.id)).toMatchObject({ dataEditorMode: 'chosen', dataEditors: [teamRef], deployerPrincipals: [teamRef],
            capabilities: { editData: true } });
        expect(await projection(owner.id)).toMatchObject({ capabilities: { editData: true } });
        expect(await canEdit(member.id)).toBe(true);
        expect(await update({ dataEditorMode: 'managers' }, created.revision + 1)).toMatchObject({ ok: true, revision: created.revision + 2 });
        expect(await projection(member.id)).toMatchObject({ capabilities: { editData: false } });
        expect(await projection(owner.id)).toMatchObject({ capabilities: { editData: true } });
        expect(await update({ dataEditorMode: 'chosen' }, created.revision + 2)).toMatchObject({ ok: true, revision: created.revision + 3 });
        // D13 (P3 U3): the Environment stores either agent write level.
        expect(await update({ dataAgentAccess: 'readWriteNoApproval' }, created.revision + 3)).toMatchObject({ ok: true, revision: created.revision + 4 });
        expect(await projection(member.id)).toMatchObject({ dataAgentAccess: 'readWriteNoApproval' });
        expect(await update({ dataAgentAccess: 'readWriteAsk' }, created.revision + 4)).toMatchObject({ ok: true, revision: created.revision + 5 });
        expect(await projection(outsider.id)).toEqual({ ok: false, error: 'deployment_unavailable' });
        // Membership ends: the next admission refuses both the deploy and the database edit.
        await db.teamMembership.delete({ where: { id: membership.id } });
        expect(await projection(member.id)).toEqual({ ok: false, error: 'deployment_unavailable' });
        expect(await canEdit(member.id)).toBe(false);
        expect(await update({ dataEditorMode: 'off' }, created.revision + 5)).toMatchObject({ ok: true, revision: created.revision + 6 });
        expect(await projection(owner.id)).toMatchObject({ capabilities: { editData: false } });
        expect(await canEdit(owner.id)).toBe(false);
    });

    it('uses the explicit Team owner and its Machine grant, surviving the creating member leaving', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Workload authority' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: creator.id, role: 'owner' },
            { teamId: team.id, accountId: manager.id, role: 'admin' },
            { teamId: team.id, accountId: member.id, role: 'member' },
        ] });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Production', audience: [], owner: { kind: 'team', teamId: team.id },
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'team/production', cloneUrl: 'https://github.com/team/production.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const input = { serverId, projectSourceId: source.source.id };
        const admitted = await inTx(tx => resolveDeploymentEnvironmentAdmissionInTx(tx, member.id, input));
        expect(admitted).toMatchObject({ ok: true, admission: { owner: { kind: 'team', teamId: team.id }, canManage: false, canDeployMember: true } });
        if (!admitted.ok) throw new Error('Team Source not admitted');
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID() } });
        const destinations = [{ machineId: machine.id, role: 'target' as const, installationId: machine.installationId! }];
        // Owning the Machine personally cannot replace the Source Team grant.
        expect(await inTx(tx => admitDeploymentMachinesInTx(tx, admitted.admission.owner, destinations)))
            .toMatchObject({ ok: false, error: 'machine_unavailable' });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: creator.id }), machineId: machine.id } });
        expect(await inTx(tx => admitDeploymentMachinesInTx(tx, admitted.admission.owner, destinations)))
            .toMatchObject({ ok: true, placements: new Map([[machine.id, { machineId: machine.id, installationId: machine.installationId }]]) });
        const resourceId = crypto.randomUUID();
        const secret = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: creator.id, resourceId,
            displayName: 'Used Team secret', kind: 'token', encryptionMode: 'plain', teamGrants: [team.id],
            storedContent: { t: 'plain', v: { v: 1, name: 'Used Team secret', kind: 'token', value: 'never-in-use-facts' } } }));
        expect(secret.ok).toBe(true);
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: creator.id } });
        expect(await inTx(tx => resolveDeploymentEnvironmentAdmissionInTx(tx, manager.id, input)))
            .toMatchObject({ ok: true, admission: { owner: { kind: 'team', teamId: team.id }, canManage: true } });
        expect(await inTx(tx => resolveDeploymentEnvironmentAdmissionInTx(tx, creator.id, input)))
            .toMatchObject({ ok: false, error: 'deployment_unavailable' });
        expect(await inTx(tx => admitDeploymentMachinesInTx(tx, admitted.admission.owner, destinations))).toMatchObject({ ok: true });
        const resources = await inTx(tx => readSavedSecretResourcesForPrincipalInTx(tx, admitted.admission.owner, [resourceId]));
        expect(resources).toMatchObject([{ revision: 1, materialStatus: 'ready', capabilities: { use: true } }]);
        expect(JSON.stringify(resources)).not.toContain('never-in-use-facts');
        await db.savedSecretTeamGrant.deleteMany({ where: { resourceId, teamId: team.id } });
        expect(await inTx(tx => readSavedSecretResourcesForPrincipalInTx(tx, admitted.admission.owner, [resourceId]))).toEqual([]);
        await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: machine.id, teamId: team.id } });
        expect(await inTx(tx => admitDeploymentMachinesInTx(tx, admitted.admission.owner, destinations)))
            .toMatchObject({ ok: false, error: 'machine_unavailable' });
    });

    it.each(['view', 'admin'] as const)('delivers an admitted Team operation with its actual %s Machine role without borrowing custodian Source membership', async accessLevel => {
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Installed workload' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, manager.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Team operation', audience: [], owner: { kind: 'team', teamId: team.id },
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'team/app', cloneUrl: 'https://github.com/team/app.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id, active: true,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
                host: 'Installed Team workload', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/deployment', happyHomeDir: '/home/deployment/.happier',
            })), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        await db.machineGrant.create({ data: { principalKind: 'team', machineId: machine.id, teamId: team.id, accessLevel, createdByAccountId: custodian.id } });
        const artifact = await createArtifact({ actorUserId: manager.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Team operation' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: manager.id }), artifactId: artifact.artifact.id } });
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id, createdByAccountId: manager.id,
            protection: 'production', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
            buildMachineId: machine.id, ...content } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id, createdByAccountId: manager.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed', ...content,
            machines: { create: { machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' } } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const uncaptured = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            requestedByAccountId: manager.id, operation: 'deploy', state: 'running', requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), ...content } });
        const signed = (body: EnvironmentSecretLaunchAdmissionBodyV1, accountId: string) => ({ ...body,
            proof: signMachineInstallationProof({ payload: { version: 1, accountId, machineId: machine.id,
                installationId: machine.installationId!, deploymentSecretLaunch: {
                    requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, privateKey: keys.secretKey }) });
        const uncapturedBody: EnvironmentSecretLaunchAdmissionBodyV1 = { serverId, environmentId: environment.id, targetLinkId: link.id,
            machineId: machine.id, installationId: machine.installationId!,
            materialization: { kind: 'deployment', deploymentId: uncaptured.id, actionOperationId: uncaptured.actionOperationId } };
        expect(await inTx(tx => resolveDeploymentEnvironmentAdmissionInTx(tx, custodian.id, { serverId, projectSourceId: source.source.id })))
            .toMatchObject({ ok: false, error: 'deployment_unavailable' });
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, custodian.id, signed(uncapturedBody, custodian.id))))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        // This explicitly seeded legacy-history control has no native custody.
        // Settle only that fixture so the genuine admission below owns the slot.
        await db.deployment.update({ where: { id: uncaptured.id }, data: { state: 'failed', settledAt: new Date() } });
        const candidate = await createArtifact({ actorUserId: manager.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Team operation' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!candidate.ok) throw new Error(candidate.error);
        await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: manager.id }), artifactId: candidate.artifact.id } });
        const deployInput = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
            contentArtifactId: candidate.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const target = { kind: 'machine' as const, machineId: machine.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: deployInput };
        const token = await auth.createToken(manager.id, undefined, { kind: 'account', authority: 'present_user' });
        if (accessLevel === 'admin') {
            const mintInput = { accountId: manager.id, serverIdentityId: serverId, machineId: machine.id, target,
                authentication: { kind: 'account' as const, tokenEpoch: manager.tokenEpoch },
                actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1 as typeof DEPLOYMENT_DEPLOY_ACTION_ID_V1 | typeof DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
                admittedMachineRole: 'manage' as const };
            const compact = { serverId, environmentId: environment.id, targetLinkId: link.id };
            const mint = (extra: Partial<typeof mintInput> = {}, deploymentReview?: {
                originalAuthorizationToken: string;
                candidate: { contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number };
            }) => {
                const actionInput = extra.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 ? { ...compact, reason: 'manual' as const } : compact;
                const request = { ...envelope, requestId: crypto.randomUUID(), input: actionInput };
                return auth.mintExternalActionExecutionAuthorization({ ...mintInput, ...extra,
                    requestId: request.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request),
                }, { input: actionInput, ...(deploymentReview ? { deploymentReview } : {}) });
            };
            const original = await mint();
            const differentRequest = await mint();
            const contentArtifactId = original.binding.deploymentCandidatePublication!.contentArtifactId;
            const pins = { contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
            const published = await createArtifact({ actorUserId: manager.id, artifactId: contentArtifactId,
                kind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Reviewed candidate' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            expect(published.ok).toBe(true);
            const carried = { originalAuthorizationToken: original.token, candidate: pins };
            await expect(mint({}, { ...carried, originalAuthorizationToken: differentRequest.token }))
                .rejects.toMatchObject({ code: 'credential_scope_denied' });
            const otherManager = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: otherManager.id, role: 'owner' } });
            const otherActor = { accountId: otherManager.id, authentication: { kind: 'account' as const, tokenEpoch: otherManager.tokenEpoch } };
            await expect(mint(otherActor)).resolves.toHaveProperty('binding.accountId', otherManager.id);
            await expect(mint(otherActor, carried)).rejects.toMatchObject({ code: 'credential_scope_denied' });
            await db.artifact.update({ where: { id: contentArtifactId }, data: { bodyVersion: 2 } });
            await expect(mint({}, carried)).rejects.toMatchObject({ code: 'credential_scope_denied', details: { deploymentReview: 'stale' } });
            await db.artifact.update({ where: { id: contentArtifactId }, data: { bodyVersion: 1 } });
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin',
                createdByAccountId: manager.id }), artifactId: contentArtifactId } });
            await withAuthenticatedTestApp(app => {
                registerExternalActionRoutes(app);
                registerDeploymentRoutes(app);
                artifactsRoutes(app);
            }, async app => {
                const confirmEnvelope = { ...envelope, requestId: crypto.randomUUID(), input: compact };
                const reply = await app.inject({ method: 'POST', url: '/v1/actions/deployments.deploy/execution-authorization',
                    headers: { authorization: `Bearer ${token}` },
                    payload: { v: 1, machineId: machine.id, envelope: confirmEnvelope, deploymentReview: carried } });
                expect(reply.statusCode, reply.body).toBe(200);
                const confirmation = ExternalActionExecutionAuthorizationV1Schema.parse(reply.json());
                const otherConfirmation = await mint({}, carried);
                expect(confirmation.binding.deploymentCandidatePublication).toMatchObject({ contentArtifactId, reviewed: pins });
                const candidatePath = `/v1/artifacts/${contentArtifactId}`;
                const purpose = (method: string, path: string) => inTx(tx => isDeploymentCandidatePublicationHttpPurposeInTx(
                    tx, confirmation.binding, DEPLOYMENT_DEPLOY_ACTION_ID_V1, { method, path }));
                expect(await purpose('POST', candidatePath)).toBe(false);
                expect(await purpose('GET', `/v1/artifacts/${candidate.artifact.id}`)).toBe(false);
                const signedHeaders = (method: string, path: string, body?: unknown, authorization = confirmation) => ({
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: authorization.binding.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: authorization.binding.actionId, target,
                        installationId: machine.installationId!, requestId: authorization.binding.requestId,
                        method, path, ...(body === undefined ? {} : { body }), privateKey: keys.secretKey }),
                });
                const read = await app.inject({ method: 'GET', url: candidatePath, headers: signedHeaders('GET', candidatePath) });
                expect(read.statusCode, read.body).toBe(200);
                expect(read.json()).toMatchObject({ id: contentArtifactId, headerVersion: 1, bodyVersion: 1 });
                const path = `/v1/deployments/environments/${environment.id}/deploy`;
                const payload = { ...deployInput, ...pins, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() };
                const executed = await app.inject({ method: 'POST', url: path, payload, headers: signedHeaders('POST', path, payload) });
                expect(executed.statusCode, executed.body).toBe(200);
                const receipt = DeploymentReceiptResultV1Schema.parse(executed.json());
                if (!receipt.ok || !('deploymentId' in receipt)) throw new Error('Expected committed deployment candidate');
                const duplicate = { ...payload, expectedRevision: receipt.revision, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() };
                const repeated = await app.inject({ method: 'POST', url: path, payload: duplicate,
                    headers: signedHeaders('POST', path, duplicate, otherConfirmation) });
                expect(repeated.statusCode, repeated.body).toBe(409);
                expect(repeated.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
                const existing = await db.deployment.findMany({ where: { contentArtifactId } });
                expect(existing).toHaveLength(1);
                await db.deployment.update({ where: { id: existing[0].id }, data: { state: 'failed', settledAt: new Date() } });
                deployInput.expectedRevision = receipt.revision;

                const teardownAction = { actionId: DEPLOYMENT_TEARDOWN_ACTION_ID_V1 };
                const teardown = await mint(teardownAction);
                const teardownId = teardown.binding.deploymentCandidatePublication?.contentArtifactId;
                if (!teardownId) throw new Error('Expected a Teardown candidate');
                const teardownCandidate = await createArtifact({ actorUserId: manager.id, artifactId: teardownId,
                    kind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
                    header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Reviewed teardown' })),
                    body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
                    dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                expect(teardownCandidate.ok).toBe(true);
                const teardownPins = { contentArtifactId: teardownId, contentHeaderVersion: 1, contentBodyVersion: 1 };
                await expect(mint(teardownAction, { originalAuthorizationToken: original.token, candidate: teardownPins }))
                    .rejects.toMatchObject({ code: 'credential_scope_denied' });
                const confirmedTeardown = await mint(teardownAction, { originalAuthorizationToken: teardown.token, candidate: teardownPins });
                expect(confirmedTeardown.binding.deploymentCandidatePublication).toMatchObject({ reviewed: teardownPins });
                const teardownPath = `/v1/artifacts/${teardownId}`;
                const reopened = await app.inject({ method: 'GET', url: teardownPath,
                    headers: signedHeaders('GET', teardownPath, undefined, confirmedTeardown) });
                expect(reopened.statusCode, reopened.body).toBe(200);
                expect(reopened.json()).toMatchObject({ id: teardownId, headerVersion: 1, bodyVersion: 1 });
            }, { authentication: 'real' });
            await expect(mint({}, carried)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        }
        const authorization = await (async () => {
            let minted: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
            await withAuthenticatedTestApp(app => registerExternalActionRoutes(app), async app => {
                const response = await app.inject({ method: 'POST', url: '/v1/actions/deployments.deploy/execution-authorization',
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id, envelope } });
                expect(response.statusCode, response.body).toBe(200);
                minted = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                expect(minted.binding).toMatchObject({ admittedMachineRole: accessLevel === 'view' ? 'use' : 'manage' });
                expect(await auth.verifyExternalActionExecutionAuthorization(minted.token)).toEqual(minted.binding);
                const verifyPath = '/v1/actions/deployments.deploy/execution-authorization/verify';
                for (const role of [minted.binding.admittedMachineRole,
                    minted.binding.admittedMachineRole === 'use' ? 'manage' : 'use', undefined] as const) {
                    const body = { v: 1, ...(role ? { admittedMachineRole: role } : {}) };
                    const verified = await app.inject({ method: 'POST', url: verifyPath, payload: body, headers: {
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: minted.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                            authorizationToken: minted.token, effectActionId: 'deployments.deploy', target,
                            installationId: machine.installationId!, requestId: envelope.requestId,
                            method: 'POST', path: verifyPath, body, privateKey: keys.secretKey }),
                    } });
                    if (role === minted.binding.admittedMachineRole) expect(verified.statusCode, verified.body).toBe(200);
                    else expect([401, 403], verified.body).toContain(verified.statusCode);
                }
            }, { authentication: 'real' });
            if (!minted) throw new Error('Expected the Home-minted deployment root');
            return minted;
        })();
        if (!('authentication' in authorization.binding)) throw new Error('Expected an Account root');
        let relayedRole: 'use' | 'manage' | undefined;
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            const carried = request.callParams;
            if (!carried || typeof carried !== 'object' || !('executionAuthorization' in carried)) {
                throw new Error('Expected the daemon Action transport root');
            }
            const delivered = ExternalActionExecutionAuthorizationV1Schema.parse(carried.executionAuthorization);
            expect(await auth.verifyExternalActionExecutionAuthorization(delivered.token)).toEqual(delivered.binding);
            relayedRole = delivered.binding.admittedMachineRole;
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: 'deployments.deploy', requestId: envelope.requestId,
                execution: { ok: true, result: { accepted: true } },
            })) };
        } });
        const authentication = authorization.binding.authentication;
        if (authentication.kind !== 'account') throw new Error('Deploy dispatch requires the signed Account authentication.');
        const dispatched = await dispatch({ actionId: 'deployments.deploy', envelope, principal: {
            accountId: manager.id, authentication, authority: 'present_user',
        } });
        expect(relayedRole).toBe(accessLevel === 'view' ? 'use' : 'manage');
        expect(dispatched).toMatchObject({ kind: 'response' });
        const path = `/v1/deployments/environments/${environment.id}/deploy`;
        const payload = { ...deployInput, actionOperationId: crypto.randomUUID() };
        let admittedReceiptId: string | undefined;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: path, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target,
                    installationId: machine.installationId!, requestId: envelope.requestId,
                    method: 'POST', path, body: payload, privateKey: keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            const admitted = DeploymentReceiptResultV1Schema.parse(response.json());
            if (!admitted.ok || !('deploymentId' in admitted)) throw new Error('Expected authenticated receipt admission');
            admittedReceiptId = admitted.deploymentId;
        }, { authentication: 'real' });
        if (!admittedReceiptId) throw new Error('Expected an admitted deployment receipt');
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admittedReceiptId } });
        const body: EnvironmentSecretLaunchAdmissionBodyV1 = { ...uncapturedBody,
            materialization: { kind: 'deployment', deploymentId: receipt.id, actionOperationId: receipt.actionOperationId } };
        const input = signed(body, custodian.id);
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, custodian.id, input)))
            .toEqual({ ok: true, grants: [] });
        const requesterInput = signed(body, manager.id);
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, manager.id, requesterInput)))
            .toEqual({ ok: true, grants: [] });
        await db.deployment.update({ where: { id: receipt.id }, data: { cancelRequestedAt: new Date() } });
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, custodian.id, input)))
            .toMatchObject({ ok: false, error: 'deployment_unavailable' });
        await db.deployment.update({ where: { id: receipt.id }, data: { cancelRequestedAt: null } });
        await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: machine.id, teamId: team.id } });
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, custodian.id, input)))
            .toMatchObject({ ok: false, error: 'machine_unavailable' });
    });

    it('limits setup app preparation to exact current Environment and Artifact references under the original requester', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, requester.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Setup app', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'me/app', cloneUrl: 'https://github.com/me/app.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const hostKeys = nacl.sign.keyPair(), targetKeys = nacl.sign.keyPair();
        const machineMetadata = encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'Setup preparation',
            platform: 'linux', happyCliVersion: 'test', homeDir: '/home/setup', happyHomeDir: '/home/setup/.happier' }));
        const host = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: machineMetadata, dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID(), installationPublicKey: Buffer.from(hostKeys.publicKey) } });
        const target = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: requester.id,
            metadata: machineMetadata, dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID(), installationPublicKey: Buffer.from(targetKeys.publicKey) } });
        const artifact = async (kind: string) => {
            // The real Artifact owner publishes the ids/CAS under test. Receipt
            // body semantics are exercised by the composed native setup journey.
            const created = await createArtifact({ actorUserId: requester.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private setup content' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const content = await artifact('deployment-environment.v1'), candidate = await artifact('deployment-receipt.v1');
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: requester.id, protection: 'production', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: host.id, ...content } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: requester.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...content,
            machines: { create: { machineId: target.id, installationId: target.installationId!, position: 0, state: 'active' } } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const input = MachineSetupApplyInputV1Schema.parse({ homeId: serverId, machineId: host.id, targets: [{
            homeId: serverId, machineId: target.id, desiredRevision: 0, recipePlans: [],
            sources: [{ kind: 'direct', setup: { items: [{ kind: 'app', definition: {
                name: 'Setup app', project: { kind: 'existing', projectSourceId: source.source.id }, bindings: [],
                definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] },
            } }] } }], appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy', input: {
                serverId, environmentId: environment.id, expectedRevision: environment.revision,
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(), ...candidate,
            } }],
        }] });
        const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ accountId: requester.id,
            custodianAccountId: custodian.id, authentication: { kind: 'terminal', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            serverIdentityId: serverId, machineId: host.id, installationId: host.installationId!, actionId: 'machines.setup.apply',
            requestId: crypto.randomUUID(), requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: host.id },
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', input) });
        const metadata = { method: 'GET', path: `/v1/deployments/environments/${environment.id}?serverId=${serverId}`,
            routeInput: { serverId, environmentId: environment.id } };
        const reads = [metadata, ...[content, candidate].map(ref => ({ method: 'GET', path: `/v1/artifacts/${ref.contentArtifactId}`,
            routeInput: { id: ref.contentArtifactId } }))];
        const read = (proof: Parameters<typeof isDeploymentPreparationHttpPurposeInTx>[3] = metadata, actor = binding) => inTx(tx => isDeploymentPreparationHttpPurposeInTx(tx, actor,
            proof.path.startsWith('/v1/deployments/') ? 'deployments.environments.get' : actor.actionId, proof, {}));
        for (const proof of reads) expect(await read(proof), proof.path).toBe(true);
        expect(await read(metadata, { ...binding, deploymentPreparationAdmission: undefined })).toBe(false);
        for (const proof of [{ ...metadata, method: 'PATCH' }, { ...metadata, routeInput: { serverId, environmentId: 'another' } },
            { method: 'GET', path: '/v1/artifacts', routeInput: {} },
            { method: 'GET', path: '/v1/artifacts/unreviewed', routeInput: { id: 'unreviewed' } }]) expect(await read(proof)).toBe(false);
        await db.artifact.update({ where: { id: candidate.contentArtifactId }, data: { bodyVersion: 2 } });
        expect(await read(reads[2])).toBe(false);
        await db.artifact.update({ where: { id: candidate.contentArtifactId }, data: { bodyVersion: 1 } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { revision: environment.revision + 1 } });
        expect.soft(await read(), 'admitted setup survives Environment revision changes').toBe(true);
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { revision: environment.revision } });
        await db.deploymentTargetLink.update({ where: { id: link.id }, data: { revision: link.revision + 1 } });
        expect.soft(await read(), 'admitted setup survives target-link revision changes').toBe(true);
        await db.deploymentTargetLink.update({ where: { id: link.id }, data: { revision: link.revision } });
        const team = await db.team.create({ data: { name: 'Admitted setup target' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: requester.id, role: 'owner' } });
        await db.machine.update({ where: { id: target.id }, data: { accountId: custodian.id } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: custodian.id }), machineId: target.id } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: custodian.id }), machineId: host.id } });
        const admission = binding.deploymentPreparationAdmission;
        if (!admission) throw new Error('Expected setup preparation admission');
        const admit = () => inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, binding, admission));
        expect(await admit()).toBe(true);
        const envelope = { v: 1 as const, requestId: binding.requestId, target: binding.target, input };
        const mintInput = { ...binding, authentication: { kind: 'account' as const, tokenEpoch: requester.tokenEpoch },
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) };
        const authorization = await auth.mintExternalActionExecutionAuthorization(mintInput, { input });
        await expect(auth.mintExternalActionExecutionAuthorization({ ...mintInput, accountId: custodian.id,
            authentication: { kind: 'account', tokenEpoch: custodian.tokenEpoch } }, { input }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        const receiverRead = () => verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
            effectActionId: 'deployments.environments.get', encodedTarget: encodeExternalActionResolvedTargetV1(binding.target), ...metadata,
            body: undefined,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: 'deployments.environments.get', target: binding.target, installationId: target.installationId!,
                requestId: binding.requestId, method: metadata.method, path: metadata.path, privateKey: targetKeys.secretKey }) });
        expect(await receiverRead()).toMatchObject({ binding: { accountId: requester.id }, setupReceiverMachineId: target.id });
        // A self-target Setup consumes its ingress Machine admission once;
        // Source-owner target custody remains the deployment owner's decision.
        await db.machine.update({ where: { id: target.id }, data: { active: true,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const selfInput = { ...input, machineId: target.id };
        const selfEnvelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: target.id }, input: selfInput };
        const token = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerExternalActionRoutes, async app => {
            let machineAdmissionReads = 0;
            const stop = observeSqliteRequests({ before: request => {
                if (request.model !== 'Machine' || !request.args || typeof request.args !== 'object'
                    || !('select' in request.args)) return;
                const selection = request.args.select;
                if (selection && typeof selection === 'object' && 'metadata' in selection && 'grants' in selection) {
                    machineAdmissionReads++;
                }
            } });
            try {
                const response = await app.inject({ method: 'POST', url: '/v1/actions/machines.setup.apply/execution-authorization',
                    headers: { authorization: `Bearer ${token}` },
                    payload: { v: 1, machineId: target.id, envelope: selfEnvelope } });
                expect(response.statusCode, response.body).toBe(200);
                expect(ExternalActionExecutionAuthorizationV1Schema.parse(response.json()).binding)
                    .toMatchObject({ machineId: target.id, admittedMachineRole: 'manage' });
                expect(machineAdmissionReads).toBe(1);
            } finally { stop(); }
        }, { authentication: 'real' });
        await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: target.id, teamId: team.id } });
        expect(await admit()).toBe(false);
        await expect(auth.mintExternalActionExecutionAuthorization(mintInput, { input })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: custodian.id }), machineId: target.id } });
        await expect.soft(auth.mintExternalActionExecutionAuthorization(mintInput, { input }), 'Setup admission requires target Manage')
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: target.id, teamId: team.id } });
        for (const proof of reads) expect.soft(await read(proof), 'admitted setup survives Machine Manage withdrawal').toBe(true);
        expect.soft(await receiverRead()).toMatchObject({ binding: { accountId: requester.id }, setupReceiverMachineId: target.id });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: custodian.id }), machineId: target.id } });
        expect(await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, requester.id, { serverId,
            environmentId: environment.id, expectedRevision: environment.revision, controllerMachineId: target.id })))
            .toMatchObject({ ok: true });
        for (const proof of reads) expect.soft(await read(proof), 'admitted setup survives future controller placement').toBe(true);
        expect.soft(await receiverRead()).toMatchObject({ setupReceiverMachineId: target.id });
        await db.machine.update({ where: { id: target.id }, data: { installationId: crypto.randomUUID() } });
        expect.soft(await read(), 'root purpose consumes the signed selection').toBe(true);
        expect(await receiverRead(), 'the receiver signature owner refuses rotated installations').toBeNull();
    });

    it('keeps personal Source authority separate from audience Team administrators', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Audience only' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: viewer.id, role: 'admin' },
        ] });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Personal Source', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'me/app', cloneUrl: 'https://github.com/me/app.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const updated = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
            expectedRevision: source.source.revision, patch: { audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] } }));
        expect(updated.ok).toBe(true);
        expect(await inTx(tx => resolveDeploymentEnvironmentAdmissionInTx(tx, viewer.id, { serverId, projectSourceId: source.source.id })))
            .toMatchObject({ ok: true, admission: { owner: { kind: 'account', accountId: owner.id }, canManage: false } });
    });
});
