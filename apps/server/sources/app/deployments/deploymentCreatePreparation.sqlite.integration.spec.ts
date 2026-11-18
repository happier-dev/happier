import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, encodePlainArtifactStoredContent,
    DeploymentTargetLinkInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, SOCKET_RPC_EVENTS,
    ArtifactJsonCreateHttpInputV1Schema, ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { EnvironmentSecretClientBindingsInputV1Schema } from '@happier-dev/deployment-protocol';
import { ExternalActionExecutionAuthorizationBindingV1Schema, projectDeploymentPreparationAdmissionV1,
    createDeploymentCandidatePublicationV1, createDeploymentLinkContentArtifactIdV1,
    createDeploymentEnvironmentContentArtifactIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { auth } from '@/app/auth/auth';
import type { Server } from 'socket.io';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions';
import { ExternalActionHttpErrorSchema, projectExternalActionHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionHttpError';
import { MachineProvisionerContributionV1Schema, defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { deriveWorkflowReplacementId } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { computeExternalActionRequestEnvelopeDigestV1, computeExternalActionMachineRpcParamsDigestV1, signExternalActionMachineRpcRequestV1, encodeReviewedActionChildHttpProofV1, encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1, DeploymentDomainMutationResultV1Schema, deploymentDomainObservationProofPayloadV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { verifyExternalActionMachineRpcExecution, verifyExternalActionDomainExecutionRequest,
    isDeploymentNativeHttpPurpose } from '@/app/auth/externalActionExecutionAuthorization';
import { ManagedControlAdmissionInputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { resolveArtifactAccessInTx } from '@/app/artifacts/artifactAccessService';
import { createProjectSourceInTx, readProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { listDeploymentTargetLinksInTx } from './deploymentTargetLinkReadService';
import { isDeploymentPreparationAuthorizedInTx, isDeploymentPreparationHttpPurposeInTx,
    readDeploymentCreateHttpPurposeInTx, readDeploymentLinkPreparationHttpPurpose,
    readDeploymentPreparationAuthorizationInTx } from './deploymentPreparationAuthorization';

describe('reviewed create preparation authority', () => {
    const serverId = `srv_${'b'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-create-preparation-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const destination = await inTx(tx => createProjectSourceInTx(tx, actor.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Destination', audience: [] }));
        await makeShareEligibleForTest(owner.id, actor.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Readable source',
            audience: [{ principal: { kind: 'account', accountId: actor.id }, level: 'view' }] }));
        if (!source.ok || !destination.ok) throw new Error('Expected Source fixtures');
        const key = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: actor.id,
            metadata: encodePlainMachineStoredContent({ host: 'Create carrier', platform: 'linux', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey) } });
        const artifact = async (accountId: string, kind = 'deployment-environment.v1', artifactId: string = crypto.randomUUID()) => {
            const created = await createArtifact({ actorUserId: accountId, artifactId,
                kind: `v1:other:${kind}`,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Copy' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({
                    body: JSON.stringify(kind === 'deployment-domain.v1' ? { hostname: 'reviewed.example.test', target: { service: 'web', containerPort: 80 }, healthCheck: { path: '/', expectStatus: 200 } } : createDeploymentEnvironmentDetailV1().content),
                })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: created.artifact.headerVersion,
                contentBodyVersion: created.artifact.bodyVersion };
        };
        const original = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'production', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...await artifact(owner.id) } });
        const input = { serverId, projectSourceId: destination.source.id, requestKey: crypto.randomUUID(),
            name: 'Independent copy', protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            copyFrom: { environmentId: original.id, expectedRevision: original.revision, choices: { secrets: [], values: [], data: [] } } };
        const admission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', input);
        if (!admission || admission.operation !== 'create') throw new Error('Expected create projection');
        const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ serverIdentityId: serverId,
            accountId: actor.id, authentication: { kind: 'account', tokenEpoch: 0 }, actionId: 'deployments.environments.create',
            requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id }, machineId: machine.id,
            installationId: machine.installationId, custodianAccountId: actor.id, requestEnvelopeDigest: 'a'.repeat(43),
            deploymentPreparationAdmission: admission });
        return { owner, actor, source, destination, original, input, admission, binding, machine, key, artifact };
    }

    it.each(['authorization', 'fresh', 'retained'] as const)('reports missing Team Source management through the real %s Create root before any effect', async entry => {
        const f = await fixture();
        const team = await db.team.create({ data: { name: 'Create Source authority' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.actor.id, role: 'owner' } });
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: f.actor.id,
            machineId: f.machine.id, principal: { kind: 'team', teamId: team.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved', readiness: 'ready' });
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const { projectSourceId: _source, copyFrom: _copy, ...base } = f.input;
        const input = { ...base, newProject: { requestKey: crypto.randomUUID(), name: 'Team Source',
            owner: { kind: 'team' as const, teamId: team.id } } };
        const admission = projectDeploymentPreparationAdmissionV1(f.binding.actionId, input);
        if (!admission || admission.operation !== 'create') throw new Error('Expected Team Create projection');
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input };
        const binding = { ...f.binding, deploymentPreparationAdmission: admission,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) };
        // Machine ownership and explicit Team custody permit transport; Source management is separate.
        const authorization = await auth.mintExternalActionExecutionAuthorization(binding, { input });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: f.actor.id } },
            data: { role: 'member' } });
        expect(await inTx(tx => readDeploymentPreparationAuthorizationInTx(tx, binding, admission)))
            .toEqual({ ok: false, code: 'source_access_denied' });
        const token = await auth.createToken(f.actor.id, undefined, { kind: 'account', authority: 'present_user' });
        let forwarded = false;
        await withAuthenticatedTestApp(app => registerExternalActionRoutes(app, {
            dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
                // The daemon transport is the boundary; the Source and Machine owners remain real.
                forwardRpc: async () => { forwarded = true; throw new Error('Unexpected daemon effect'); } }),
        }), async app => {
            const response = await app.inject({ method: 'POST',
                url: `/v1/actions/deployments.environments.create${entry === 'authorization' ? '/execution-authorization' : ''}`,
                headers: { authorization: `Bearer ${token}` }, payload: entry === 'fresh' ? envelope
                    : { v: 1, envelope, machineId: f.machine.id,
                        ...(entry === 'retained' ? { executionAuthorization: authorization } : {}) } });
            expect(response.statusCode, response.body).toBe(entry === 'fresh' ? 200 : 403);
            const failure = entry === 'fresh' ? ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution
                : projectExternalActionHttpFailureV1(ExternalActionHttpErrorSchema.parse(response.json()));
            expect(failure).toMatchObject({ ok: false, errorCode: 'source_access_denied' });
            expect(forwarded).toBe(false);
        }, { authentication: 'real' });
    });

    it.each(['fresh', 'retained'] as const)('reports a changed copy source through the real %s Create root without attempting an effect', async entry => {
        const f = await fixture();
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input: f.input };
        const authorization = entry === 'retained' ? await auth.mintExternalActionExecutionAuthorization({ ...f.binding,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: f.input }) : undefined;
        await db.deploymentEnvironment.update({ where: { id: f.original.id }, data: { revision: { increment: 1 } } });
        const token = await auth.createToken(f.actor.id, undefined, { kind: 'account', authority: 'present_user' });
        let forwarded = false;
        await withAuthenticatedTestApp(app => registerExternalActionRoutes(app, {
            dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
                // The daemon transport is the system boundary; admission and its database are real.
                forwardRpc: async () => { forwarded = true; throw new Error('Unexpected daemon effect'); } }),
        }), async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/actions/deployments.environments.create',
                headers: { authorization: `Bearer ${token}` }, payload: authorization
                    ? { v: 1, envelope, machineId: f.machine.id, executionAuthorization: authorization } : envelope });
            expect(response.statusCode, response.body).toBe(authorization ? 409 : 200);
            const failure = authorization
                ? projectExternalActionHttpFailureV1(ExternalActionHttpErrorSchema.parse(response.json()))
                : ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution;
            expect(failure).toMatchObject({
                ok: false, errorCode: 'source_changed',
            });
            expect(forwarded).toBe(false);
        }, { authentication: 'real' });
    });

    it.each(['current', 'stale', 'unreadable', 'deleted'] as const)('preserves the %s copy-source admission cause at mint', async state => {
        const f = await fixture();
        if (state === 'stale') await db.deploymentEnvironment.update({ where: { id: f.original.id },
            data: { revision: { increment: 1 } } });
        if (state === 'deleted') await db.deploymentEnvironment.update({ where: { id: f.original.id }, data: { deletedAt: new Date() } });
        const input = state === 'unreadable' ? { ...f.input, copyFrom: { ...f.input.copyFrom, environmentId: crypto.randomUUID() } } : f.input;
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input };
        const minted = auth.mintExternalActionExecutionAuthorization({ ...f.binding,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(f.binding.actionId, input) }, { input });
        if (state === 'current') await expect(minted).resolves.toMatchObject({ binding: { actionId: f.binding.actionId } });
        else await expect(minted).rejects.toMatchObject({ code: state === 'stale' ? 'source_changed' : 'credential_scope_denied' });
    });

    // QA-SWEEP-172 #175: a preview Create with a stale template revision refused as credential_scope_denied,
    // hiding a recoverable CAS conflict. A stale template is the same conflict as a stale copy source.
    it.each(['current', 'stale-revision', 'moved-runtime', 'foreign-template'] as const)('preserves the %s preview template admission cause at mint', async state => {
        const preview = await previewFixture();
        const f = preview.f;
        const { copyFrom: _copy, ...base } = f.input;
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' };
        const templateEnvironmentId = state === 'foreign-template' ? f.original.id : preview.template.id;
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ ...base, purpose: 'preview',
            preview: { templateEnvironmentId, expectedTemplateRevision: preview.template.revision + (state === 'stale-revision' ? 1 : 0),
                runtimeTargetLinkId: state === 'moved-runtime' ? crypto.randomUUID() : preview.runtime.id,
                pullRequestId: '17', headSha: 'a'.repeat(40),
                provenance: { v: 1, templateEnvironmentId, runtimeTargetLinkId: preview.runtime.id,
                    repository, headRepository: repository, pullRequestId: '17', pullRequestNumber: 17,
                    author: { id: 'owner', login: 'owner' } } } });
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input };
        const minted = auth.mintExternalActionExecutionAuthorization({ ...f.binding,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(f.binding.actionId, input) }, { input });
        if (state === 'current') await expect(minted).resolves.toMatchObject({ binding: { actionId: f.binding.actionId } });
        else await expect(minted).rejects.toMatchObject({ code: state === 'foreign-template' ? 'credential_scope_denied' : 'source_changed' });
    });

    it('returns the stale source conflict through the public Create authorization HTTP contract', async () => {
        const f = await fixture();
        await db.deploymentEnvironment.update({ where: { id: f.original.id }, data: { revision: { increment: 1 } } });
        const token = await auth.createToken(f.actor.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerExternalActionRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/actions/deployments.environments.create/execution-authorization',
                headers: { authorization: `Bearer ${token}` }, payload: {
                    v: 1,
                    envelope: { v: 1, requestId: f.binding.requestId, target: f.binding.target, input: f.input },
                    machineId: f.machine.id,
                } });
            expect(response.statusCode, response.body).toBe(409);
            expect(projectExternalActionHttpFailureV1(ExternalActionHttpErrorSchema.parse(response.json()))).toMatchObject({
                ok: false, errorCode: 'source_changed', requestId: f.binding.requestId,
            });
        }, { authentication: 'real' });
    });

    it.each(['copy', 'catalog', 'fork', 'repository'] as const)('limits the %s Create candidate read to its original consuming request and input', async kind => {
        const preview = kind === 'fork' ? await previewFixture() : undefined;
        const f = preview?.f ?? await fixture();
        const { copyFrom: _copy, ...base } = f.input;
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' };
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse(preview ? { ...base, purpose: 'preview',
            preview: { templateEnvironmentId: preview.template.id, expectedTemplateRevision: preview.template.revision,
                runtimeTargetLinkId: preview.runtime.id, pullRequestId: '17', headSha: 'a'.repeat(40),
                provenance: { v: 1, templateEnvironmentId: preview.template.id, runtimeTargetLinkId: preview.runtime.id,
                    repository, headRepository: { ...repository, repository: 'contributor/app' }, pullRequestId: '17',
                    pullRequestNumber: 17, author: { id: 'contributor', login: 'contributor' } } } }
            : kind === 'copy' ? f.input : kind === 'repository' ? { ...base, definition: { from: 'repository', ref: 'main',
                compose: { path: 'compose.yaml', profiles: [], services: [] } } } : { ...base, definition: { from: 'catalogApp' as const,
            templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } } } });
        const mint = async (requestId: string, rootInput = input) => {
            const envelope = { v: 1 as const, requestId, target: f.binding.target, input: rootInput };
            return auth.mintExternalActionExecutionAuthorization({ ...f.binding, requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(f.binding.actionId, rootInput) }, { input: rootInput });
        };
        const authorization = await mint(f.binding.requestId);
        const candidate = await f.artifact(f.actor.id, 'deployment-environment.v1',
            createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding, actionId: 'deployments.environments.create' }));
        const unrelated = await f.artifact(f.actor.id);
        const anotherRequest = await mint(crypto.randomUUID());
        const anotherInput = await mint(f.binding.requestId, input.preview
            ? { ...input, preview: { ...input.preview, headSha: 'b'.repeat(40) } }
            : { ...input, name: 'Another reviewed input' });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const read = (root: typeof authorization, artifactId: string) => {
                const path = `/v1/artifacts/${artifactId}`;
                return app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: root.binding.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: root.binding.actionId, target: root.binding.target, installationId: f.machine.installationId!,
                        requestId: root.binding.requestId, method: 'GET', path, privateKey: f.key.secretKey }),
                } });
            };
            const candidateRead = await read(authorization, candidate.contentArtifactId);
            expect(candidateRead.statusCode, candidateRead.body).toBe(kind === 'catalog' ? 401 : 200);
            if (kind === 'catalog') expect(candidateRead.json()).toMatchObject({ error: 'invalid_token',
                authorizationRefusal: 'deployment_preparation' });
            for (const [root, artifactId] of [[authorization, unrelated.contentArtifactId],
                [anotherRequest, candidate.contentArtifactId], [anotherInput, candidate.contentArtifactId]] as const) {
                const refused = await read(root, artifactId);
                expect(refused.statusCode, refused.body).toBe(401);
                expect(refused.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'deployment_preparation' });
            }
        }, { authentication: 'real' });
    });

    async function previewFixture() {
        const f = await fixture();
        const template = await db.deploymentEnvironment.create({ data: { projectSourceId: f.destination.source.id,
            createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.machine.id, buildMachineId: f.machine.id, ...await f.artifact(f.actor.id) } });
        const runtime = await db.deploymentTargetLink.create({ data: { environmentId: template.id,
            createdByAccountId: f.actor.id, role: 'runtime', state: 'configured', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
            ...await f.artifact(f.actor.id, 'deployment-target-link.v1'),
            machines: { create: [{ machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: template.id }, data: { runtimeTargetLinkId: runtime.id } });
        const input = { serverId, projectSourceId: f.destination.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
            controllerMachineId: f.machine.id, buildMachineId: f.machine.id, ...await f.artifact(f.actor.id),
            preview: { templateEnvironmentId: template.id, expectedTemplateRevision: template.revision,
                runtimeTargetLinkId: runtime.id, pullRequestId: '17' },
            firstTargetLink: { ...await f.artifact(f.actor.id, 'deployment-target-link.v1'),
                machines: [{ machineId: f.machine.id, installationId: f.machine.installationId! }] } };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target: f.binding.target, input };
        const actionId = 'deployments.environments.create';
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.actor.id, authentication: { kind: 'account', tokenEpoch: f.actor.tokenEpoch }, actionId,
            requestId: envelope.requestId, target: envelope.target, machineId: f.machine.id,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) }, { input });
        const readPath = (path: string, effectActionId = 'deployments.environments.list',
            reviewedChild?: Parameters<typeof encodeReviewedActionChildHttpProofV1>[0]) => {
            return { path, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target),
                ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target: envelope.target,
                    installationId: f.machine.installationId!, requestId: envelope.requestId,
                    method: 'GET', path, reviewedChild, privateKey: f.key.secretKey }),
            } };
        };
        const read = (machineId: string) => readPath(`/v1/deployments/environments?serverId=${encodeURIComponent(serverId)}&machineId=${encodeURIComponent(machineId)}`);
        return { f, template, runtime, input, envelope, authorization, read, readPath };
    }

    it.each(['template', 'retained'] as const)('opens only the server-selected %s preview builder under its signed Create root', async placement => {
        const { f, template, runtime, readPath } = await previewFixture();
        const builder = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.actor.id,
            metadata: f.machine.metadata, dataEncryptionKey: f.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey) } });
        const other = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.actor.id,
            metadata: f.machine.metadata, dataEncryptionKey: f.machine.dataEncryptionKey } });
        const environment = placement === 'template' ? template : await db.deploymentEnvironment.create({ data: {
            projectSourceId: f.destination.source.id, createdByAccountId: f.actor.id,
            protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
            controllerMachineId: f.machine.id, buildMachineId: builder.id,
            previewTemplateEnvironmentId: template.id, previewRepositoryId: f.destination.source.id,
            previewPullRequestId: '17', previewTargetLinkId: runtime.id, ...await f.artifact(f.actor.id),
        } });
        await db.deploymentEnvironment.update({ where: { id: template.id },
            data: { buildMachineId: placement === 'template' ? builder.id : other.id } });
        const foreign = await previewFixture();
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const read = (machineId: string, root = readPath) => {
                const request = root(`/v1/machines/${machineId}`, 'deployments.environments.create');
                return app.inject({ method: 'GET', url: request.path,
                    headers: { ...request.headers, ...currentAccountStoredContentCompatibilityHeaders } });
            };
            const allowed = await read(builder.id);
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(allowed.json()).toMatchObject({ machine: { id: builder.id, installationId: builder.installationId } });
            // A retained preview's parent template, and so its builder, is in the root's admitted scope.
            if (placement === 'retained') expect((await read(other.id)).statusCode).toBe(200);
            for (const request of [...(placement === 'template' ? [() => read(other.id)] : []), () => read(builder.id, foreign.readPath)]) {
                const refused = await request();
                expect(refused.statusCode, refused.body).toBe(401);
                expect(refused.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'deployment_preparation' });
            }
            // Placement does not grant visibility to another Account's Machine.
            await db.machine.update({ where: { id: builder.id }, data: { accountId: f.owner.id } });
            const invisible = await read(builder.id);
            expect(invisible.statusCode, invisible.body).toBe(404);
            expect(invisible.json()).toMatchObject({ error: 'Machine not found' });
            await db.machine.update({ where: { id: builder.id }, data: { accountId: f.actor.id } });
            // Mint decided placement once; a later controller edit applies at the next admission, not mid-operation.
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { controllerMachineId: other.id } });
            const laterControllerEdit = await read(builder.id);
            expect(laterControllerEdit.statusCode, laterControllerEdit.body).toBe(200);
        }, { authentication: 'real' });
    });

    it('lets a signed preview Create inspect only its execution Machines and omits unreadable workload headers', async () => {
        const { f, read } = await previewFixture();
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const own = read(f.machine.id);
            const complete = await app.inject({ method: 'GET', url: own.path, headers: own.headers });
            expect(complete.statusCode, complete.body).toBe(200);
            expect(complete.json()).toMatchObject({ ok: true, coverage: 'complete' });
            const hidden = await db.deploymentEnvironment.create({ data: { projectSourceId: f.source.source.id,
                createdByAccountId: f.owner.id, protection: 'production', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id, buildMachineId: f.machine.id, ...await f.artifact(f.owner.id) } });
            await db.projectSource.update({ where: { id: f.source.source.id }, data: { audience: [] } });
            const partial = await app.inject({ method: 'GET', url: own.path, headers: own.headers });
            expect(partial.statusCode, partial.body).toBe(200);
            expect(partial.json()).toMatchObject({ ok: true, coverage: 'complete' });
            expect(partial.json().items.map((row: { id: string }) => row.id)).not.toContain(hidden.id);
            const other = read(crypto.randomUUID());
            const refused = await app.inject({ method: 'GET', url: other.path, headers: other.headers });
            expect(refused.statusCode, refused.body).toBe(401);
            expect(refused.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'deployment_preparation' });
        }, { authentication: 'real' });
    });

    it('lets signed preview Create list only the selected Source, template and pull request', async () => {
        const { f, template, readPath } = await previewFixture();
        const selected = { serverId, projectSourceId: f.destination.source.id,
            previewRepositoryId: f.destination.source.id, previewTemplateEnvironmentId: template.id, previewPullRequestIds: ['17'] };
        const spec = getActionSpec('deployments.environments.list');
        if (!spec.serverTransport) throw new Error('Expected Environment list transport');
        const transport = spec.serverTransport;
        const read = (input: unknown) => readPath(bindHomeDomainHttpRequestV1({ transport,
            inputSchema: spec.inputSchema, input }).path);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const own = read(selected);
            const allowed = await app.inject({ method: 'GET', url: own.path, headers: own.headers });
            expect(allowed.statusCode, allowed.body).toBe(200);
            for (const query of [{ ...selected, projectSourceId: f.source.source.id },
                { ...selected, previewTemplateEnvironmentId: f.original.id },
                { ...selected, previewPullRequestIds: ['18'] }, { serverId }]) {
                const request = read(query);
                const refused = await app.inject({ method: 'GET', url: request.path, headers: request.headers });
                expect(refused.statusCode, refused.body).toBe(401);
                expect(refused.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'deployment_preparation' });
            }
        }, { authentication: 'real' });
    });

    it('lets signed preview Update inspect its proposed builder and retained runtime only', async () => {
        const { f, template } = await previewFixture();
        const builder = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.actor.id,
            metadata: f.machine.metadata, dataEncryptionKey: f.machine.dataEncryptionKey } });
        const actionId = 'deployments.environments.update';
        const input = { serverId, environmentId: template.id, expectedRevision: template.revision,
            mode: 'preview', patch: { buildMachineId: builder.id } };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target: f.binding.target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.actor.id, authentication: { kind: 'account', tokenEpoch: f.actor.tokenEpoch }, actionId,
            requestId: envelope.requestId, target: envelope.target, machineId: f.machine.id,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const readPath = (path: string, effectActionId: string) => {
            return { path, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target: envelope.target,
                    installationId: f.machine.installationId!, requestId: envelope.requestId,
                    method: 'GET', path, privateKey: f.key.secretKey }),
            } };
        };
        const read = (machineId: string) => readPath(
            `/v1/deployments/environments?serverId=${encodeURIComponent(serverId)}&machineId=${encodeURIComponent(machineId)}`,
            'deployments.environments.list');
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const metadata = readPath(`/v1/deployments/environments/${template.id}?serverId=${encodeURIComponent(serverId)}`,
                'deployments.environments.get');
            const opened = await app.inject({ method: 'GET', url: metadata.path, headers: metadata.headers });
            expect(opened.statusCode, opened.body).toBe(200);
            for (const machineId of [builder.id, f.machine.id]) {
                const request = read(machineId);
                const allowed = await app.inject({ method: 'GET', url: request.path, headers: request.headers });
                expect(allowed.statusCode, allowed.body).toBe(200);
                expect(allowed.json()).toMatchObject({ ok: true, coverage: 'complete' });
            }
            const request = read(crypto.randomUUID());
            const refused = await app.inject({ method: 'GET', url: request.path, headers: request.headers });
            expect(refused.statusCode, refused.body).toBe(401);
            expect(refused.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
            const foreign = readPath(`/v1/deployments/environments/${f.original.id}?serverId=${encodeURIComponent(serverId)}`,
                'deployments.environments.get');
            const refusedEnvironment = await app.inject({ method: 'GET', url: foreign.path, headers: foreign.headers });
            expect(refusedEnvironment.statusCode, refusedEnvironment.body).toBe(401);
            expect(refusedEnvironment.json()).toMatchObject({ authorizationRefusal: 'verification_purpose' });
        }, { authentication: 'real' });
    });

    it('lets signed preview Create read Domain operands only from its admitted template', async () => {
        const { f, template, runtime, readPath } = await previewFixture();
        const createDomain = async (environmentId: string) => db.deploymentDomain.create({ data: {
            environmentId, targetLinkId: runtime.id, createdByAccountId: f.actor.id, state: 'pending',
            ...await f.artifact(f.actor.id, 'deployment-domain.v1'),
        } });
        const selected = await createDomain(template.id);
        const other = await createDomain(f.original.id);
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const domain = (environmentId: string, domainId: string) => readPath(
                `/v1/deployments/environments/${encodeURIComponent(environmentId)}/domains/${encodeURIComponent(domainId)}?serverId=${encodeURIComponent(serverId)}`,
                'deployments.domains.get');
            const allowedRead = domain(template.id, selected.id);
            const allowed = await app.inject({ method: 'GET', url: allowedRead.path, headers: allowedRead.headers });
            expect(allowed.statusCode, allowed.body).toBe(200);
            const content = readPath(`/v1/artifacts/${encodeURIComponent(selected.contentArtifactId)}`, 'deployments.environments.create');
            const opened = await app.inject({ method: 'GET', url: content.path, headers: content.headers });
            expect(opened.statusCode, opened.body).toBe(200);
            const wrongDomain = domain(f.original.id, other.id);
            const wrongArtifact = readPath(`/v1/artifacts/${encodeURIComponent(other.contentArtifactId)}`, 'deployments.environments.create');
            for (const [request, authorizationRefusal] of [[wrongDomain, 'deployment_metadata_environment'],
                [wrongArtifact, 'deployment_preparation']] as const) {
                const refused = await app.inject({ method: 'GET', url: request.path, headers: request.headers });
                expect(refused.statusCode, refused.body).toBe(401);
                expect(refused.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal });
            }
        }, { authentication: 'real' });
    });

    it('binds signed preview Deploy and Domain roles to the retained exact child', async () => {
        const { f, template, runtime, authorization, envelope, readPath } = await previewFixture();
        const child = await db.deploymentEnvironment.create({ data: { projectSourceId: f.destination.source.id,
            createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
            controllerMachineId: f.machine.id, buildMachineId: f.machine.id,
            previewTemplateEnvironmentId: template.id, previewRepositoryId: f.destination.source.id,
            previewPullRequestId: '17', previewTargetLinkId: runtime.id, ...await f.artifact(f.actor.id) } });
        const childRuntime = await db.deploymentTargetLink.create({ data: { environmentId: child.id,
            createdByAccountId: f.actor.id, role: 'runtime', state: 'configured', sourceKind: 'host',
            hostTargetId: 'own-server', targetKind: 'ownServer', ...await f.artifact(f.actor.id, 'deployment-target-link.v1'),
            machines: { create: [{ machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: child.id }, data: { runtimeTargetLinkId: childRuntime.id } });
        const domain = await db.deploymentDomain.create({ data: { id: child.id, environmentId: child.id,
            targetLinkId: childRuntime.id, createdByAccountId: f.actor.id, state: 'pending',
            ...await f.artifact(f.actor.id, 'deployment-domain.v1') } });
        const cases = [
            { actionId: 'deployments.deploy' as const, role: 'preview.deploy', suffix: 'deploy',
                input: { serverId, environmentId: child.id, expectedRevision: child.revision,
                    targetLinkId: childRuntime.id, expectedTargetLinkRevision: 1, requestKey: `${envelope.requestId}-deploy`,
                    ...await f.artifact(f.actor.id, 'deployment-receipt.v1') } },
            { actionId: 'deployments.domains.add' as const, role: 'template.domain:preview', suffix: 'domains',
                input: { serverId, environmentId: child.id, expectedRevision: child.revision,
                    domainId: 'child-domain', targetLinkId: childRuntime.id, expectedTargetLinkRevision: 1,
                    requestKey: 'child-domain', ...await f.artifact(f.actor.id, 'deployment-domain.v1') } },
        ];
        for (const selected of cases) {
            const reviewedChild = { actionId: selected.actionId, role: selected.role,
                inputDigest: computeActionInputApprovalDigestV1(selected.actionId, selected.input) };
            const path = `/v1/deployments/environments/${child.id}/${selected.suffix}`;
            const body = { ...selected.input, actionOperationId: 'child-operation',
                ...(selected.suffix === 'domains' ? { requestId: envelope.requestId, placements: [{
                    machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'public',
                    dockerEngineId: 'engine', listener: 'public',
                }] } : {}) };
            const verify = (role = selected.role, input = body) => verifyExternalActionDomainExecutionRequest({
                method: 'POST', path, body: input, reviewedChild: { ...reviewedChild, role },
                authorizationToken: authorization.token, effectActionId: selected.actionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(envelope.target),
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: selected.actionId, target: envelope.target, installationId: f.machine.installationId!,
                    requestId: envelope.requestId, method: 'POST', path, body: input,
                    reviewedChild: { ...reviewedChild, role }, privateKey: f.key.secretKey }),
            });
            expect(await verify()).toMatchObject({ effectActionId: selected.actionId, reviewedChildAdmission: reviewedChild });
            expect(await verify('preview.bindings')).toBeNull();
            expect(await verify(selected.role, { ...body, contentBodyVersion: 2 })).toBeNull();
            expect(await verify(selected.role, { ...body, requestKey: `${selected.input.requestKey}-changed` })).toBeNull();
        }
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const deploy = cases[0];
            const reviewedChild = { actionId: deploy.actionId, role: deploy.role,
                inputDigest: computeActionInputApprovalDigestV1(deploy.actionId, deploy.input) };
            for (const [environmentId, childProof, status] of [
                [child.id, reviewedChild, 200], [f.original.id, reviewedChild, 401],
                [child.id, { ...reviewedChild, role: 'preview.bindings' }, 401], [child.id, undefined, 401],
            ] as const) {
                const request = readPath(`/v1/deployments/environments/${environmentId}?serverId=${serverId}`,
                    deploy.actionId, childProof);
                const response = await app.inject({ method: 'GET', url: request.path, headers: request.headers });
                expect(response.statusCode, response.body).toBe(status);
                if (status === 401) expect(response.json()).toMatchObject({ error: 'invalid_token',
                    authorizationRefusal: 'deployment_preparation' });
            }
            // The admitted read scope decides the Domain operand: an id outside it is refused before the route reads.
            for (const [domainId, status] of [[domain.id, 200], [`${domain.id}-missing`, 401]] as const) {
                const request = readPath(`/v1/deployments/environments/${child.id}/domains/${domainId}?serverId=${serverId}`,
                    'deployments.domains.get');
                const response = await app.inject({ method: 'GET', url: request.path, headers: request.headers });
                expect(response.statusCode, response.body).toBe(status);
            }
            const list = readPath(`/v1/deployments/environments/${child.id}/domains?serverId=${serverId}`,
                'deployments.domains.list');
            const listed = await app.inject({ method: 'GET', url: list.path, headers: list.headers });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json()).toMatchObject({ ok: true, domains: [{ id: domain.id }] });
            const foreign = readPath(`/v1/deployments/environments/${f.original.id}/domains?serverId=${serverId}`,
                'deployments.domains.list');
            const refused = await app.inject({ method: 'GET', url: foreign.path, headers: foreign.headers });
            expect(refused.statusCode, refused.body).toBe(401);
        }, { authentication: 'real' });
    });

    it.each(['create', 'deploy'] as const)('carries the verified %s root into signed remote preparation with a captured Domain fact', async rootKind => {
        const { f, template, runtime, authorization: createAuthorization, envelope: createEnvelope } = await previewFixture();
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const builderKey = nacl.sign.keyPair();
        const builder = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.actor.id,
            metadata: f.machine.metadata, dataEncryptionKey: f.machine.dataEncryptionKey, active: true,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(builderKey.publicKey) } });
        const child = await db.deploymentEnvironment.create({ data: { projectSourceId: f.destination.source.id,
            createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
            controllerMachineId: f.machine.id, buildMachineId: builder.id, previewTemplateEnvironmentId: template.id,
            previewRepositoryId: f.destination.source.id, previewPullRequestId: '17', previewTargetLinkId: runtime.id,
            ...await f.artifact(f.actor.id) } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: child.id, createdByAccountId: f.actor.id,
            role: 'runtime', state: 'configured', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
            ...await f.artifact(f.actor.id, 'deployment-target-link.v1'), machines: { create: [{ machineId: f.machine.id,
                installationId: f.machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: child.id }, data: { runtimeTargetLinkId: link.id } });
        const input = { serverId, environmentId: child.id, targetLinkId: link.id,
            requestKey: `${createEnvelope.input.requestKey}-deploy` };
        const envelope = rootKind === 'create' ? createEnvelope : { ...createEnvelope,
            requestId: crypto.randomUUID(), input };
        const authorization = rootKind === 'create' ? createAuthorization : await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: serverId, accountId: f.actor.id,
            authentication: { kind: 'account', tokenEpoch: f.actor.tokenEpoch }, actionId: 'deployments.deploy',
            requestId: envelope.requestId, target: envelope.target, machineId: f.machine.id,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare', actionId: 'deployments.deploy', input,
            machineId: builder.id, installationId: builder.installationId!, expectedRevision: child.revision,
            expectedTargetLinkRevision: link.revision,
            previewDomain: { domainId: 'selected-template-domain', url: 'https://pr-17.example.test' } });
        if (job.kind !== 'prepare' || job.actionId !== 'deployments.deploy') throw new Error('Expected Deploy preparation');
        const reviewedChild = rootKind === 'create' ? { actionId: 'deployments.deploy', role: 'preview.deploy',
            inputDigest: computeActionInputApprovalDigestV1('deployments.deploy', input) } : undefined;
        const verify = (params = job, proof = reviewedChild, signer = f.key.secretKey) => {
            const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
            const execution = { v: 1 as const, authorization, effectActionId: 'deployments.deploy', target: envelope.target,
                installationId: f.machine.installationId!, deploymentChildRouting, ...(proof ? { reviewedChild: proof } : {}),
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.deploy', target: envelope.target, installationId: f.machine.installationId!,
                    event: SOCKET_RPC_EVENTS.CALL, method, requestId, params, deploymentChildRouting,
                    ...(proof ? { reviewedChild: proof } : {}), privateKey: signer }) };
            return verifyExternalActionMachineRpcExecution(execution, { method, requestId, params,
                originalActionEnvelope: envelope, event: SOCKET_RPC_EVENTS.CALL });
        };
        expect(await verify()).toMatchObject({ binding: { actionId: authorization.binding.actionId },
            deploymentChildAdmission: { routing: { kind: 'prepare', machineId: builder.id } } });
        expect(await verify({ ...job, input: { ...job.input, requestKey: `${input.requestKey}-changed` } })).toBeNull();
        expect(await verify(job, reviewedChild, builderKey.secretKey)).toBeNull();
        if (reviewedChild) expect(await verify(job, { ...reviewedChild, role: 'preview.bindings' })).toBeNull();
    });

    it.each(['connected', 'created'] as const)('binds %s provider Link preparation and publication to the admitted Environment and owner', async providerIntent => {
        const f = await fixture();
        const teams = await Promise.all(['Link owner', 'Other readable owner'].map(name => db.team.create({ data: { name } })));
        await db.teamMembership.createMany({ data: teams.map(team => ({ teamId: team.id, accountId: f.actor.id, role: 'owner' })) });
        const owner = { kind: 'team' as const, teamId: teams[0].id };
        const otherOwner = { kind: 'team' as const, teamId: teams[1].id };
        await db.teamMembership.create({ data: { teamId: owner.teamId, accountId: f.owner.id, role: 'member' } });
        await db.machine.update({ where: { id: f.machine.id }, data: { accountId: f.owner.id } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: owner.teamId, accessLevel: 'admin', createdByAccountId: f.owner.id }), accessLevel: 'admin', machineId: f.machine.id } });
        const source = await inTx(tx => createProjectSourceInTx(tx, f.actor.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Team Link', owner }));
        if (!source.ok) throw new Error(source.error);
        const content = await f.artifact(f.actor.id);
        await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: owner.teamId, accessLevel: 'admin', createdByAccountId: f.actor.id }), artifactId: content.contentArtifactId } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.machine.id, ...content } });
        const otherEnvironment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.machine.id, ...await f.artifact(f.actor.id) } });
        const actionId = 'deployments.targets.link';
        const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
            requestKey: crypto.randomUUID(), role: 'runtime', targetId: 'fixture.platform', targetKind: 'platform',
            source: { kind: 'plugin', contribution: { pluginId: 'fixture.deploy', localId: 'platform' } }, machines: [],
            provider: { credentialPrincipal: { kind: 'account', accountId: f.actor.id,
                purpose: { consumer: { pluginId: 'fixture.deploy', localId: 'platform' }, purpose: 'manage' },
                target: { kind: 'account', account: { service: { pluginId: 'fixture.deploy', localId: 'service' }, accountId: 'credential' } } },
                providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'production' } } };
        // VERCEL-JOURNEY #139: native creation keeps Link's signed scope when
        // the private providerCreate intent becomes a stored Link publication.
        const { provider, ...linkInput } = input;
        const rootInput = providerIntent === 'created' ? { ...linkInput, providerCreate: {
            credentialRef: provider.credentialPrincipal.target.account,
            credentialPrincipal: provider.credentialPrincipal,
            providerEnvironment: provider.providerEnvironment,
            providerAccountId: provider.providerIdentity.providerAccountId,
            resourceName: 'reviewed-project', sourceMethod: 'upload',
        } } : input;
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target: f.binding.target, input: rootInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.actor.id, authentication: { kind: 'account', tokenEpoch: f.actor.tokenEpoch }, actionId,
            requestId: envelope.requestId, target: envelope.target, machineId: f.machine.id,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: rootInput });
        expect(authorization.binding.custodianAccountId).toBe(f.owner.id);
        expect(authorization.binding.deploymentLinkAdmission).toEqual({ environmentId: environment.id, owner });
        const mintInput = { ...authorization.binding, deploymentLinkAdmission: undefined };
        const projected = await auth.mintExternalActionExecutionAuthorization(mintInput, { deploymentLinkEnvironmentId: environment.id });
        expect(projected.binding.deploymentLinkAdmission).toEqual(authorization.binding.deploymentLinkAdmission);
        await expect(auth.mintExternalActionExecutionAuthorization({ ...mintInput,
            deploymentLinkAdmission: { environmentId: environment.id, owner: otherOwner } }, { input }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(auth.mintExternalActionExecutionAuthorization(mintInput, { input, deploymentLinkEnvironmentId: otherEnvironment.id }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        const path = '/v1/deployments/targets/list';
        const body = { serverId, scope: owner, selection: { source: input.source, targetKind: input.targetKind } };
        expect(await readDeploymentLinkPreparationHttpPurpose(db, ExternalActionExecutionAuthorizationBindingV1Schema.parse(mintInput),
            actionId, { method: 'POST', path, body }, () => false)).toBe(false);
        const proof = (payload: unknown, url = path, effectActionId = actionId, method = 'POST') => ({
            authorizationToken: authorization.token, effectActionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(envelope.target), method, path: url, body: payload,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId,
                target: envelope.target, installationId: f.machine.installationId!, requestId: envelope.requestId,
                method, path: url, body: payload, privateKey: f.key.secretKey }),
        });
        const headers = (signed: ReturnType<typeof proof>) => ({
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: signed.authorizationToken,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: signed.effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: signed.encodedTarget,
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signed.machineSignature,
        });
        // Both scopes are genuinely readable by the requester; only this job's scope is delegated.
        expect(await inTx(tx => listDeploymentTargetLinksInTx(tx, f.actor.id, { serverId, scope: otherOwner })))
            .toEqual({ ok: true, items: [], nextCursor: null, coverage: 'complete' });
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const list = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: path,
                payload, headers: headers(proof(payload)) });
            const response = await list(body);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, items: [], nextCursor: null, coverage: 'complete' });
            const otherScope = await list({ serverId, scope: otherOwner });
            expect.soft(otherScope.statusCode, 'another readable Team is outside this Link job').toBe(401);
            expect.soft(otherScope.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
            const read = (id: string) => {
                const url = `/v1/deployments/environments/${encodeURIComponent(id)}?serverId=${encodeURIComponent(serverId)}`;
                return app.inject({ method: 'GET', url,
                    headers: headers(proof(undefined, url, 'deployments.environments.get', 'GET')) });
            };
            const own = await read(environment.id);
            expect.soft(own.statusCode, own.body).toBe(200);
            const other = await read(otherEnvironment.id);
            expect.soft(other.statusCode, 'another Environment in the same Team is outside this Link job').toBe(401);
            expect.soft(other.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
            const environmentContentPath = `/v1/artifacts/${environment.contentArtifactId}`;
            const environmentContent = await app.inject({ method: 'GET', url: environmentContentPath,
                headers: headers(proof(undefined, environmentContentPath, actionId, 'GET')) });
            expect.soft(environmentContent.statusCode, 'Link failure-observer setup reads its admitted Environment content').toBe(200);
            const siblingContentPath = `/v1/artifacts/${otherEnvironment.contentArtifactId}`;
            const siblingContent = await app.inject({ method: 'GET', url: siblingContentPath,
                headers: headers(proof(undefined, siblingContentPath, actionId, 'GET')) });
            expect.soft(siblingContent.statusCode, 'a sibling Environment content is outside this Link job').toBe(401);
            const otherProvider = await f.artifact(f.actor.id, 'deployment-target-link.v1');
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: otherOwner.teamId, accessLevel: 'admin', createdByAccountId: f.actor.id }), artifactId: otherProvider.contentArtifactId } });
            const otherSource = await inTx(tx => createProjectSourceInTx(tx, f.actor.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Other Team Link', owner: otherOwner }));
            if (!otherSource.ok) throw new Error(otherSource.error);
            const outsideEnvironment = await db.deploymentEnvironment.create({ data: { projectSourceId: otherSource.source.id,
                createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id, ...content } });
            await db.deploymentTargetLink.create({ data: { environmentId: outsideEnvironment.id,
                createdByAccountId: f.actor.id, role: 'runtime', state: 'configured', sourceKind: 'plugin',
                pluginId: 'fixture.deploy', contributionLocalId: 'platform', targetKind: 'platform', ...otherProvider } });
            const otherProviderPath = `/v1/artifacts/${otherProvider.contentArtifactId}`;
            const otherProviderRead = await app.inject({ method: 'GET', url: otherProviderPath,
                headers: headers(proof(undefined, otherProviderPath, actionId, 'GET')) });
            expect(otherProviderRead.statusCode, 'another readable Team provider is outside this Link job').toBe(401);
            const existingProvider = await f.artifact(f.actor.id, 'deployment-target-link.v1');
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: owner.teamId, accessLevel: 'view', createdByAccountId: f.actor.id }), artifactId: existingProvider.contentArtifactId } });
            const existingLink = await db.deploymentTargetLink.create({ data: { environmentId: otherEnvironment.id,
                createdByAccountId: f.actor.id, role: 'runtime', state: 'configured', sourceKind: 'plugin',
                pluginId: 'fixture.deploy', contributionLocalId: 'platform', targetKind: 'platform', ...existingProvider } });
            const existingPath = `/v1/artifacts/${existingProvider.contentArtifactId}`;
            const existingRead = await app.inject({ method: 'GET', url: existingPath,
                headers: headers(proof(undefined, existingPath, actionId, 'GET')) });
            expect(existingRead.statusCode, 'Link compares provider content already listed in its admitted owner scope').toBe(200);
            // An approved replay re-reads the Link content its first, pre-approval run prepared. That
            // not-yet-linked publication is the requester's own content in this job's owner scope.
            const prepareReplayRead = async (grantTeamId: string) => {
                const prepared = await f.artifact(f.actor.id, 'deployment-target-link.v1');
                await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: grantTeamId, accessLevel: 'admin',
                    createdByAccountId: f.actor.id }), artifactId: prepared.contentArtifactId } });
                const preparedPath = `/v1/artifacts/${prepared.contentArtifactId}`;
                return await app.inject({ method: 'GET', url: preparedPath, headers: headers(proof(undefined, preparedPath, actionId, 'GET')) });
            };
            expect((await prepareReplayRead(owner.teamId)).statusCode, 'prepared Link content in this owner scope').toBe(200);
            expect((await prepareReplayRead(otherOwner.teamId)).statusCode, 'prepared Link content for another Team').toBe(401);
            const existingGrantPath = `${existingPath}/access/grants`;
            const existingGrants = await app.inject({ method: 'GET', url: existingGrantPath,
                headers: headers(proof(undefined, existingGrantPath, actionId, 'GET')) });
            expect(existingGrants.statusCode, 'inventory content does not delegate grant inspection').toBe(401);
            const existingUpdate = ArtifactJsonUpdateHttpInputV1Schema.parse({ expectedHeaderVersion: 1,
                header: encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Changed' }) });
            const refusedExistingUpdate = await app.inject({ method: 'POST', url: existingPath, payload: existingUpdate,
                headers: headers(proof(existingUpdate, existingPath)) });
            expect(refusedExistingUpdate.statusCode, 'inventory comparison does not delegate content mutation').toBe(401);
            await db.deploymentTargetLink.update({ where: { id: existingLink.id }, data: { detachedAt: new Date() } });
            const detachedRead = await app.inject({ method: 'GET', url: existingPath,
                headers: headers(proof(undefined, existingPath, actionId, 'GET')) });
            expect(detachedRead.statusCode, 'detached content is outside the live inventory').toBe(401);
            const admission = authorization.binding.deploymentLinkAdmission;
            if (!admission) throw new Error('Link admission missing');
            const artifactId = createDeploymentLinkContentArtifactIdV1({ ...authorization.binding, deploymentLinkAdmission: admission });
            const createBody = ArtifactJsonCreateHttpInputV1Schema.parse({ id: artifactId, kind: 'v1:other:deployment-target-link.v1',
                header: encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: '' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(input.provider) }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', payload: createBody,
                headers: headers(proof(createBody, '/v1/artifacts')) });
            expect(created.statusCode, 'the admitted Link must publish its own private content').toBe(200);
            expect(await db.artifact.findUnique({ where: { id: artifactId }, select: { accountId: true,
                account: { select: { encryptionMode: true } } } }))
                .toEqual({ accountId: f.actor.id, account: { encryptionMode: 'plain' } });
            const grantBody = { artifactId, principal: owner, accessLevel: 'admin' };
            const grantPath = `/v1/artifacts/${artifactId}/access/grants`;
            const granted = await app.inject({ method: 'PUT', url: grantPath, payload: grantBody,
                headers: headers(proof(grantBody, grantPath, actionId, 'PUT')) });
            expect(granted.statusCode, granted.body).toBe(200);
            const recipientsPath = `/v1/artifacts/${artifactId}/access/recipients`;
            const recipients = await app.inject({ method: 'GET', url: recipientsPath,
                headers: headers(proof(undefined, recipientsPath, actionId, 'GET')) });
            expect(recipients.statusCode, recipients.body).toBe(200);
            const unrelated = await f.artifact(f.actor.id, 'deployment-target-link.v1');
            const deniedCreateBodies = [
                { ...createBody, id: crypto.randomUUID() },
                { ...createBody, kind: 'v1:other:deployment-environment.v1' },
                { ...createBody, approvalState: 'open' },
            ];
            for (const deniedBody of deniedCreateBodies) {
                const payload = ArtifactJsonCreateHttpInputV1Schema.parse(deniedBody);
                const refused = await app.inject({ method: 'POST', url: '/v1/artifacts', payload,
                    headers: headers(proof(payload, '/v1/artifacts')) });
                expect(refused.statusCode, refused.body).toBe(401);
                if (payload.id !== artifactId) expect(await db.artifact.findUnique({ where: { id: payload.id } })).toBeNull();
            }
            const wrongGrant = { ...grantBody, principal: otherOwner };
            const deniedGrant = await app.inject({ method: 'PUT', url: grantPath, payload: wrongGrant,
                headers: headers(proof(wrongGrant, grantPath, actionId, 'PUT')) });
            expect(deniedGrant.statusCode, deniedGrant.body).toBe(401);
            expect(await db.artifactGrant.count({ where: { principalKind: 'team', artifactId, teamId: otherOwner.teamId } })).toBe(0);
            for (const id of [artifactId, unrelated.contentArtifactId]) {
                const before = await db.artifact.findUnique({ where: { id }, select: { headerVersion: true, bodyVersion: true } });
                const artifactPath = `/v1/artifacts/${id}`;
                const updateBody = ArtifactJsonUpdateHttpInputV1Schema.parse({ header: createBody.header, expectedHeaderVersion: 1 });
                const refusedUpdate = await app.inject({ method: 'POST', url: artifactPath, payload: updateBody,
                    headers: headers(proof(updateBody, artifactPath)) });
                expect(refusedUpdate.statusCode, refusedUpdate.body).toBe(401);
                const refusedDelete = await app.inject({ method: 'DELETE', url: artifactPath,
                    headers: headers(proof(undefined, artifactPath, actionId, 'DELETE')) });
                expect(refusedDelete.statusCode, refusedDelete.body).toBe(401);
                expect(await db.artifact.findUnique({ where: { id }, select: { headerVersion: true, bodyVersion: true } })).toEqual(before);
            }
            const unrelatedPath = `/v1/artifacts/${unrelated.contentArtifactId}`;
            const deniedRead = await app.inject({ method: 'GET', url: unrelatedPath,
                headers: headers(proof(undefined, unrelatedPath, actionId, 'GET')) });
            expect(deniedRead.statusCode, deniedRead.body).toBe(401);
            const unrelatedGrant = { ...grantBody, artifactId: unrelated.contentArtifactId };
            const unrelatedGrantPath = `${unrelatedPath}/access/grants`;
            const deniedOldGrant = await app.inject({ method: 'PUT', url: unrelatedGrantPath, payload: unrelatedGrant,
                headers: headers(proof(unrelatedGrant, unrelatedGrantPath, actionId, 'PUT')) });
            expect(deniedOldGrant.statusCode, deniedOldGrant.body).toBe(401);
            expect(await db.artifactGrant.count({ where: { principalKind: 'team', artifactId: unrelated.contentArtifactId } })).toBe(0);
            const stored = await db.artifact.findUniqueOrThrow({ where: { id: artifactId }, select: { headerVersion: true, bodyVersion: true } });
            const prepared = { contentArtifactId: artifactId, contentHeaderVersion: stored.headerVersion, contentBodyVersion: stored.bodyVersion };
            const link = (target: typeof environment) => {
                const payload = DeploymentTargetLinkInputV1Schema.parse({ serverId, environmentId: target.id,
                    expectedRevision: target.revision, requestKey: crypto.randomUUID(), role: input.role,
                    targetId: input.targetId, targetKind: input.targetKind, source: input.source, machines: [], ...prepared });
                const url = `/v1/deployments/environments/${encodeURIComponent(target.id)}/targets`;
                return app.inject({ method: 'POST', url, payload, headers: headers(proof(payload, url)) });
            };
            const linked = await link(environment);
            expect(linked.statusCode, 'the admitted Environment Link must remain usable').toBe(200);
            expect(linked.json()).toMatchObject({ ok: true, environmentId: environment.id });
            expect(await db.deploymentTargetLink.count({ where: { environmentId: environment.id } })).toBe(1);
            // The reviewed receipt setup retains its qualified effect on observation HTTP.
            const setupAction = formatQualifiedPluginActionId({ pluginId: 'happier.machine.services', localId: 'deployment-failed/setup' });
            const setupInput = { v: 1, serverId, environmentId: environment.id, targetLinkId: linked.json().targetLinkId };
            const setupRequest = (url: string, role: string | null = 'platform-failure.setup', method: 'GET' | 'POST' = 'GET', payload?: Record<string, unknown>) => {
                const reviewedChild = role === null ? undefined : { actionId: setupAction, role,
                    inputDigest: computeActionInputApprovalDigestV1(setupAction, setupInput) };
                const signed = proof(payload, url, setupAction, method);
                return app.inject({ method, url, ...(payload ? { payload } : {}), headers: {
                    ...headers(signed),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: setupAction, target: envelope.target,
                        installationId: f.machine.installationId!, requestId: envelope.requestId, method, path: url,
                        body: payload, privateKey: f.key.secretKey, ...(reviewedChild ? { reviewedChild } : {}),
                    }),
                    ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
                } });
            };
            const setupEnvironmentPath = `/v1/deployments/environments/${environment.id}?serverId=${encodeURIComponent(serverId)}`;
            const setupEnvironment = await setupRequest(setupEnvironmentPath);
            expect.soft(setupEnvironment.statusCode, 'reviewed Link setup reads its admitted Environment').toBe(200);
            const setupContent = await setupRequest(`/v1/artifacts/${artifactId}`);
            expect.soft(setupContent.statusCode, 'reviewed Link setup opens this Link content').toBe(200);
            for (const refused of [
                await setupRequest(`/v1/deployments/environments/${otherEnvironment.id}?serverId=${encodeURIComponent(serverId)}`),
                await setupRequest(`/v1/artifacts/${existingProvider.contentArtifactId}`),
                await setupRequest(setupEnvironmentPath, null),
                await setupRequest(setupEnvironmentPath, 'unreviewed-role'),
                await setupRequest(`/v1/artifacts/${artifactId}`, 'platform-failure.setup', 'POST', { header: createBody.header, expectedHeaderVersion: 1 }),
            ]) {
                expect.soft(refused.statusCode, 'setup adds no sibling, unreviewed, or mutation authority').toBe(401);
                expect.soft(refused.json()).toMatchObject({ error: 'invalid_token' });
            }
            const substituted = await link(otherEnvironment);
            expect.soft(substituted.statusCode, 'a sibling Environment Link is outside this admitted job').toBe(401);
            expect.soft(substituted.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
            expect.soft(await db.deploymentTargetLink.count({ where: { environmentId: otherEnvironment.id } }),
                'the sibling Environment keeps only its pre-existing inventory Link').toBe(1);
        }, { authentication: 'real' });
        expect(await verifyExternalActionDomainExecutionRequest(proof({ ...body, serverId: 'another-home' }))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof({ ...body, private: true }))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(body, `${path}?scope=other`))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(body, path, 'deployments.environments.get'))).toBeNull();
    });

    it.each(['deployments.environments.create', 'deployments.targets.link'] as const)(
        'admits only exact reviewed target retention under the scoped %s requester and root', async actionId => {
        const f = await fixture();
        const content = await f.artifact(f.actor.id);
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: f.destination.source.id,
            createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.machine.id, ...content } });
        const machines = [{ machineId: f.machine.id, installationId: f.machine.installationId! }];
        const input = actionId === 'deployments.environments.create'
            ? { ...f.input, controllerMachineId: f.machine.id, ...content, firstTargetLink: { machines, ...content } }
            : { serverId, environmentId: environment.id, expectedRevision: environment.revision, requestKey: crypto.randomUUID(),
                targetId: 'own-server', role: 'runtime', machines, ...content };
        const mint = async (rootActionId: typeof actionId | 'deployments.environments.update', rootInput: typeof input | typeof update) => {
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target: f.binding.target, input: rootInput };
            return auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.actor.id, authentication: { kind: 'account', tokenEpoch: f.actor.tokenEpoch }, actionId: rootActionId,
                requestId: envelope.requestId, target: envelope.target, machineId: f.machine.id,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                ...(projectDeploymentPreparationAdmissionV1(rootActionId, rootInput)
                    ? { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(rootActionId, rootInput) } : {}),
            }, { input: rootInput });
        };
        const update = { serverId, environmentId: environment.id, expectedRevision: environment.revision, ...content };
        const authorization = await mint(actionId, input);
        const childAction = 'machines.managed.retention.update' as const;
        // Match the retained guest topology: its provisioner controller is another Machine.
        const controller = actionId === 'deployments.environments.create'
            ? await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.actor.id,
                metadata: f.machine.metadata, dataEncryptionKey: f.machine.dataEncryptionKey,
                installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey) } }) : f.machine;
        const provider = { pluginId: 'fixture.compute', localId: 'vm' };
        const provisioner = MachineProvisionerContributionV1Schema.parse({ id: provider.localId, title: 'VM', icon: 'machine',
            resourceKind: 'vm', schemaVersion: 1, platforms: ['linux'], prerequisites: [],
            launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
            billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } });
        const roles = defineMachineProvisionerSchemas({ launch: defineProtocolObject({}, { policy: 'closed' }),
            resource: defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' }) });
        const roleActions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'power', inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({ schemaVersion: 2,
            id: provider.pluginId, version: '1.0.0', displayName: 'Retention fixture', engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 }, contributes: { machineProvisioners: [provisioner], actions: roleActions.map(action => ({
                ...action, title: action.id, execution: { target: 'daemon' }, surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })) } }));
        await db.machine.update({ where: { id: controller.id }, data: { pluginMaterializationRevision: BigInt(1) } });
        await db.accountPluginIntent.create({ data: { accountId: f.actor.id, pluginId: provider.pluginId, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: f.actor.id, serverIdentityId: serverId,
            machineId: controller.id, materializationId: controller.installationId!, pluginId: provider.pluginId, version: '1.0.0',
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const allocation = await db.managedMachine.create({ data: { homeId: serverId, custodianAccountId: f.actor.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: { enrollmentAccountId: f.actor.id },
            launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'guest' } },
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
            enrolledMachineId: controller.id === f.machine.id ? undefined : f.machine.id,
            retention: { kind: 'unused', afterMs: 1_000, effect: 'stop' }, wakeOnAcceptedMessage: true } });
        const childRequestId = deriveWorkflowReplacementId(['action.child', authorization.binding.requestId, actionId, childAction, 0]);
        const body = { homeId: serverId, managedId: allocation.id, expectedIntentRevision: allocation.intentRevision,
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: true };
        const reviewedChild = { actionId: childAction, role: `target-retention:${f.machine.id}`,
            inputDigest: computeActionInputApprovalDigestV1(childAction, body) };
        const proof = (credential = authorization, requestBody: unknown = body, child: typeof reviewedChild | null = reviewedChild,
            signingKey = f.key.secretKey, effectActionId: string = childAction) => {
            const path = effectActionId === 'machines.managed.list' ? managedMachineActionEndpointPathV1(effectActionId)
                : '/v1/machines/managed/controller/admit-control';
            const transportBody = effectActionId === childAction
                ? { action: childAction, requestId: childRequestId, input: requestBody } : requestBody;
            return { authorizationToken: credential.token, effectActionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(credential.binding.target), method: 'POST', path,
                body: transportBody, ...(effectActionId === childAction && child ? { reviewedChild: child } : {}),
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: credential.token, effectActionId,
                    target: credential.binding.target, installationId: credential.binding.installationId,
                    requestId: credential.binding.requestId, method: 'POST', path, body: transportBody,
                    ...(effectActionId === childAction && child ? { reviewedChild: child } : {}), privateKey: signingKey }) };
        };
        await withAuthenticatedTestApp(registerManagedMachineRoutes, async app => {
            const signed = proof();
            const headers = {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: signed.authorizationToken,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: signed.effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: signed.encodedTarget,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signed.machineSignature,
                [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
            };
            const tampered = await app.inject({ method: 'POST', url: signed.path, headers,
                payload: { ...ManagedControlAdmissionInputV1Schema.parse(signed.body), requestId: crypto.randomUUID() } });
            expect(tampered.statusCode).toBe(401);
            const { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: _reviewedChild, ...missingChild } = headers;
            expect((await app.inject({ method: 'POST', url: signed.path, headers: missingChild, payload: signed.body })).statusCode).toBe(401);
            if (controller.id !== f.machine.id) {
                const unrelated = await db.managedMachine.create({ data: { homeId: serverId, custodianAccountId: f.actor.id,
                    admittedActionRequestId: crypto.randomUUID(), admittedInput: {},
                    launch: { provider, schemaVersion: 1, name: 'Another allocation', choices: {} },
                    controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } });
                const unrelatedInput = { ...body, managedId: unrelated.id };
                const unrelatedChild = { ...reviewedChild, inputDigest: computeActionInputApprovalDigestV1(childAction, unrelatedInput) };
                const unrelatedProof = proof(authorization, unrelatedInput, unrelatedChild);
                const refused = await app.inject({ method: 'POST', url: signed.path, payload: unrelatedProof.body, headers: {
                    ...headers, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: unrelatedProof.machineSignature,
                    [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(unrelatedChild),
                } });
                expect(refused.statusCode, refused.body).toBe(403);
                expect((await db.managedMachine.findUniqueOrThrow({ where: { id: unrelated.id } })).intentRevision).toBe(unrelated.intentRevision);
            }
            const response = await app.inject({ method: 'POST', url: signed.path, headers, payload: signed.body });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machine).toMatchObject({ id: allocation.id, retention: { kind: 'until-delete' },
                intentRevision: allocation.intentRevision + 1 });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: allocation.id } }))
                .toMatchObject({ retention: { kind: 'until-delete' }, intentRevision: allocation.intentRevision + 1 });
            expect((await app.inject({ method: 'POST', url: signed.path, headers, payload: signed.body })).json()).toMatchObject({ replayed: true });
        }, { authentication: 'real' });
        const admitted = await verifyExternalActionDomainExecutionRequest(proof());
        expect(admitted).toMatchObject({ binding: { actionId, accountId: f.actor.id, requestId: authorization.binding.requestId },
            principal: { accountId: f.actor.id }, effectActionId: childAction, reviewedChildAdmission: reviewedChild });
        expect(await verifyExternalActionDomainExecutionRequest(proof(authorization,
            { homeId: serverId, enrolledMachineId: f.machine.id }, reviewedChild, f.key.secretKey, 'machines.managed.list'))).not.toBeNull();
        // The creation-scope retention variant carries no retention; target-retention admission refuses it instead of throwing.
        const creationScopeBody = { homeId: serverId, managedId: allocation.id, expectedIntentRevision: allocation.intentRevision,
            creationScopeRetention: null };
        await expect(verifyExternalActionDomainExecutionRequest(proof(authorization, creationScopeBody,
            { ...reviewedChild, inputDigest: computeActionInputApprovalDigestV1(childAction, creationScopeBody) }))).resolves.toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(authorization,
            { homeId: serverId }, reviewedChild, f.key.secretKey, 'machines.managed.list'))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(authorization, { ...body, wakeOnAcceptedMessage: false }))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(authorization, body,
            { ...reviewedChild, inputDigest: 'z'.repeat(43) }))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(authorization, body, null))).toBeNull();
        expect(await verifyExternalActionDomainExecutionRequest(proof(authorization, body,
            { ...reviewedChild, role: 'unrelated-child' }))).toBeNull();
        const otherRoot = await mint('deployments.environments.update', update);
        expect(await verifyExternalActionDomainExecutionRequest(proof(otherRoot))).toBeNull();
        const otherPerson = await fixture();
        expect(await verifyExternalActionDomainExecutionRequest(proof(authorization, body, reviewedChild, otherPerson.key.secretKey))).toBeNull();
    });

    it('opens only the exact preview parent Environment and prepared candidate with captured create authority', async () => {
        const f = await fixture();
        const parentContent = await f.artifact(f.actor.id);
        const parent = await db.deploymentEnvironment.create({ data: { projectSourceId: f.destination.source.id,
            createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.machine.id, ...parentContent } });
        const targetContent = await f.artifact(f.actor.id, 'deployment-target-link.v1');
        const target = await db.deploymentTargetLink.create({ data: { environmentId: parent.id,
            createdByAccountId: f.actor.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', ...targetContent,
            machines: { create: { machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'active' } } } });
        await db.deploymentEnvironment.update({ where: { id: parent.id }, data: { runtimeTargetLinkId: target.id } });
        const candidate = await f.artifact(f.actor.id);
        const { copyFrom: _copy, name: _name, ...base } = f.input;
        const preview = { templateEnvironmentId: parent.id, expectedTemplateRevision: parent.revision,
            runtimeTargetLinkId: target.id, pullRequestId: 'preview-read-pr' };
        const input = { ...base, ...candidate, purpose: 'preview' as const, controllerMachineId: f.machine.id, preview };
        const admission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', input);
        expect(admission, 'prepared preview create must retain its finite parent and candidate scope')
            .toMatchObject({ operation: 'create', preview, candidate });
        if (!admission || admission.operation !== 'create') throw new Error('Expected preview create admission');
        const binding = { ...f.binding, deploymentPreparationAdmission: admission };
        expect(await inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, binding, admission))).toBe(true);
        const envelope = { v: 1 as const, requestId: binding.requestId, target: binding.target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ ...binding,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const foreignCandidate = await f.artifact(f.actor.id);
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const read = (path: string, credential = authorization, effectActionId = binding.actionId) => app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: credential.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: credential.token,
                    effectActionId, target: binding.target, installationId: f.machine.installationId!,
                    requestId: binding.requestId, method: 'GET', path, body: undefined, privateKey: f.key.secretKey }),
            } });
            // O-DEPLOY ruling: the root also reads the preview parent named by its admitted input.
            const parentPath = `/v1/deployments/environments/${parent.id}?serverId=${serverId}`;
            const declaredParent = await read(parentPath, authorization, 'deployments.environments.get');
            expect(declaredParent.statusCode, declaredParent.body).toBe(200);
            const rootEffectParent = await read(parentPath, authorization, binding.actionId);
            expect(rootEffectParent.statusCode, rootEffectParent.body).toBe(200);
            for (const ref of [parentContent, candidate]) {
                const result = await read(`/v1/artifacts/${ref.contentArtifactId}`);
                expect(result.statusCode, result.body).toBe(200);
            }
            for (const id of [f.original.id, 'unknown-parent']) {
                expect((await read(`/v1/deployments/environments/${id}?serverId=${serverId}`, authorization, 'deployments.environments.get')).statusCode).toBe(401);
                expect((await read(`/v1/deployments/environments/${id}?serverId=${serverId}`, authorization, binding.actionId)).statusCode).toBe(401);
            }
            for (const ref of [targetContent, foreignCandidate]) {
                expect((await read(`/v1/artifacts/${ref.contentArtifactId}`)).statusCode).toBe(401);
            }
            // A preview deploy opens its parent through the existing native preparation
            // read purpose; this carrier change must not introduce another scope owner.
            const child = await db.deploymentEnvironment.create({ data: { projectSourceId: f.destination.source.id,
                createdByAccountId: f.actor.id, protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
                controllerMachineId: f.machine.id, ...candidate, previewTemplateEnvironmentId: parent.id,
                previewRepositoryId: f.destination.source.id, previewPullRequestId: preview.pullRequestId,
                previewTargetLinkId: target.id } });
            const childTarget = await db.deploymentTargetLink.create({ data: { environmentId: child.id,
                createdByAccountId: f.actor.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', ...targetContent,
                machines: { create: { machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'active' } } } });
            await db.deploymentEnvironment.update({ where: { id: child.id }, data: { runtimeTargetLinkId: childTarget.id } });
            const nativeInput = { serverId, environmentId: child.id, expectedRevision: child.revision,
                targetLinkId: childTarget.id, expectedTargetLinkRevision: childTarget.revision, requestKey: crypto.randomUUID(), ...candidate };
            const nativeEnvelope = { ...envelope, input: nativeInput };
            const native = await auth.mintExternalActionExecutionAuthorization({ ...binding,
                actionId: 'deployments.deploy', deploymentPreparationAdmission: undefined,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(nativeEnvelope) }, { input: nativeInput });
            const parentMetadata = await read(`/v1/deployments/environments/${parent.id}?serverId=${serverId}`,
                native, 'deployments.environments.get');
            expect(parentMetadata.statusCode, parentMetadata.body).toBe(200);
            const parentArtifact = await read(`/v1/artifacts/${parentContent.contentArtifactId}`, native, 'deployments.deploy');
            expect(parentArtifact.statusCode, parentArtifact.body).toBe(200);
        }, { authentication: 'real' });
        const prepared = input;
        const permissionReads: string[] = [];
        const stop = observeSqliteRequests({ before: request => {
            if (['ProjectSource', 'TeamMembership', 'TeamGroupMember'].includes(request.model ?? '')) permissionReads.push(request.model!);
        } });
        try {
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, 'deployments.environments.get', {
                method: 'GET', path: `/v1/deployments/environments/${parent.id}?serverId=${serverId}`,
            }))).not.toBeNull();
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, binding.actionId, {
                method: 'POST', path: '/v1/deployments/environments', body: prepared,
            }))).not.toBeNull();
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, binding.actionId, {
                method: 'POST', path: '/v1/deployments/environments', body: { ...prepared, preview: { ...preview, pullRequestId: 'other-pr' } },
            }))).toBeNull();
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, binding.actionId, {
                method: 'POST', path: '/v1/deployments/environments', body: { ...prepared, ...foreignCandidate },
            }))).toBeNull();
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, binding.actionId, {
                method: 'POST', path: '/v1/deployments/environments', body: { ...prepared, contentBodyVersion: prepared.contentBodyVersion + 1 },
            }))).toBeNull();
            expect(permissionReads).toEqual([]);
        } finally { stop(); }
        const stale = { ...admission, preview: { ...preview, expectedTemplateRevision: parent.revision + 1 } };
        expect(await inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, binding, stale))).toBe(false);
        const foreign = { ...admission, preview: { ...preview, templateEnvironmentId: f.original.id } };
        expect(await inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, binding, foreign))).toBe(false);
    });

    it('admits source read and destination management with the exact source CAS only at issuance', async () => {
        const f = await fixture();
        const authorized = () => inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, f.binding, f.admission));
        expect(await authorized()).toBe(true);
        expect(await inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, { ...f.binding, accountId: f.owner.id }, f.admission)))
            .toBe(false);
        await db.deploymentEnvironment.update({ where: { id: f.original.id }, data: { revision: { increment: 1 } } });
        expect(await authorized(), 'stale source cannot mint new copy authority').toBe(false);
        await db.deploymentEnvironment.update({ where: { id: f.original.id }, data: { revision: f.original.revision, deletedAt: new Date() } });
        expect(await authorized()).toBe(false);
        await db.deploymentEnvironment.update({ where: { id: f.original.id }, data: { deletedAt: null } });
        await db.projectSource.update({ where: { id: f.source.source.id }, data: { audience: [] } });
        expect(await authorized(), 'unreadable source cannot mint new copy authority').toBe(false);
    });

    it('binds a reviewed catalog Domain child to the allocated Environment and requester without permission rechecks', async () => {
        const f = await fixture();
        const { copyFrom: _copy, ...base } = f.input;
        const admission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', { ...base,
            definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } } });
        if (!admission || admission.operation !== 'create') throw new Error('Expected catalog admission');
        const binding = { ...f.binding, deploymentPreparationAdmission: admission };
        expect(await inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, binding, admission))).toBe(true);
        const content = await f.artifact(f.actor.id);
        const domain = (environmentId: string) => {
            const input = { serverId, environmentId, expectedRevision: 1, domainId: 'reviewed-domain', targetLinkId: 'runtime',
                expectedTargetLinkRevision: 1, requestKey: 'reviewed-domain', ...content };
            return { method: 'POST', path: `/v1/deployments/environments/${environmentId}/domains`,
            reviewedChild: { actionId: 'deployments.domains.add', role: 'template.domain:web',
                inputDigest: computeActionInputApprovalDigestV1('deployments.domains.add', input) },
            body: { serverId, environmentId, expectedRevision: 1, domainId: 'reviewed-domain', targetLinkId: 'runtime',
                expectedTargetLinkRevision: 1, requestKey: 'reviewed-domain', actionOperationId: 'domain-operation', requestId: binding.requestId,
                placements: [{ machineId: f.machine.id, installationId: f.machine.installationId, nativeServer: 'public',
                    dockerEngineId: 'engine', listener: 'public' }], ...content } };
        };
        expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, 'deployments.domains.add', domain(f.original.id)))).toBeNull();
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, {
            serverId, projectSourceId: f.destination.source.id, requestKey: f.input.requestKey,
            controllerMachineId: f.machine.id, protection: f.input.protection, purpose: f.input.purpose,
            deployerMode: f.input.deployerMode, ...content }));
        if (!created.ok) throw new Error(created.error);
        let permissionReads = 0;
        const stop = observeSqliteRequests({ before: request => {
            if (['ProjectSource', 'TeamMembership', 'TeamGroupMember'].includes(request.model ?? '')) permissionReads++;
        } });
        try {
            const purpose = () => inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, 'deployments.domains.add', domain(created.environmentId)));
            expect(await purpose()).toEqual({ rootActionId: binding.actionId, effectActionId: 'deployments.domains.add',
                child: { environmentId: created.environmentId } });
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, { ...binding, accountId: f.owner.id },
                'deployments.domains.add', domain(created.environmentId)))).toBeNull();
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, 'deployments.domains.add', domain(f.original.id)))).toBeNull();
            const reviewed = domain(created.environmentId);
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, 'deployments.domains.add', {
                ...reviewed, reviewedChild: { ...reviewed.reviewedChild, inputDigest: 'z'.repeat(43) },
            }))).toBeNull();
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, 'deployments.domains.add', {
                ...reviewed, body: { ...reviewed.body, contentBodyVersion: 2 },
            }))).toBeNull();
            expect(permissionReads).toBe(0);
        } finally { stop(); }
    });

    it.each(['deployments.templates.instantiate', 'deployments.publish.prepare'] as const)(
        'refuses a new Team project on an unshared Machine at %s mint with the share remedy, and admits it once shared', async actionId => {
        const f = await fixture();
        const team = await db.team.create({ data: { name: 'Team project placement' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.actor.id, role: 'owner' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const newProject = { name: 'Team project', requestKey: crypto.randomUUID(), owner: { kind: 'team' as const, teamId: team.id } };
        const templateRef = { sourceId: 'apps', itemId: 'web', version: '1',
            ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } };
        const instantiateInput = {
            mode: 'preview' as const, serverId, machineId: f.machine.id, newProject, templateRef,
            environment: { kind: 'create' as const, name: 'Team app', requestKey: crypto.randomUUID(),
                protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
                controllerMachineId: f.machine.id },
            target: { kind: 'new' as const, installationId: f.machine.installationId! },
            destination: { kind: 'stored' as const }, bindings: [],
        };
        const previewInput = { serverId, machineId: f.machine.id, installationId: f.machine.installationId!, newProject, templateRef };
        const input = actionId === 'deployments.templates.instantiate' ? instantiateInput : previewInput;
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input };
        const mintInput = { ...f.binding, actionId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) };
        // The Team owner's personal Machine is not the Team's workload Machine until it is shared.
        await expect(auth.mintExternalActionExecutionAuthorization(mintInput, { input })).rejects.toMatchObject({
            code: 'credential_scope_denied',
            details: { reason: 'source_machine_access_missing', requiredFact: 'source_machine_use', remedy: 'share_machine_with_source_owner' } });
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: f.actor.id,
            machineId: f.machine.id, principal: { kind: 'team', teamId: team.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved' });
        await expect(auth.mintExternalActionExecutionAuthorization(mintInput, { input }))
            .resolves.toMatchObject({ binding: { actionId } });
        // A role-less member stays refused without learning the placement remedy.
        await expect(auth.mintExternalActionExecutionAuthorization({ ...mintInput, accountId: member.id, custodianAccountId: member.id },
            { input })).rejects.toMatchObject({ code: 'credential_scope_denied', details: undefined });
    });

    it.each(['deployments.templates.instantiate', 'deployments.publish.prepare'] as const)(
        'retains admitted Source Manage through the first %s Source read after membership withdrawal', async actionId => {
        const f = await fixture();
        const team = await db.team.create({ data: { name: 'Admitted preparation Source' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.actor.id, role: 'owner' } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: f.actor.id }), accessLevel: 'admin', machineId: f.machine.id } });
        const selected = await inTx(tx => createProjectSourceInTx(tx, f.actor.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Selected team Source', owner: { kind: 'team', teamId: team.id } }));
        if (!selected.ok) throw new Error(selected.error);
        const templateRef = { sourceId: 'apps', itemId: 'web', version: '1',
            ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } };
        // Separate literals keep each branch exact (a literal ternary would add `?: undefined` keys, which are not JSON).
        const instantiateInput = {
            mode: 'apply' as const, serverId, machineId: f.machine.id, projectSourceId: selected.source.id, templateRef,
            environment: { kind: 'create' as const, name: 'Admitted app', requestKey: crypto.randomUUID(),
                protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
                controllerMachineId: f.machine.id },
            target: { kind: 'new' as const, installationId: f.machine.installationId! },
            destination: { kind: 'stored' as const }, bindings: [], deploy: { requestKey: crypto.randomUUID() },
        };
        const previewInput = { serverId, machineId: f.machine.id, installationId: f.machine.installationId!,
            projectSourceId: selected.source.id, sourceRevision: selected.source.revision, templateRef };
        const input = actionId === 'deployments.templates.instantiate' ? instantiateInput : previewInput;
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input };
        const mintInput = { ...f.binding, actionId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) };
        const authorization = await auth.mintExternalActionExecutionAuthorization(mintInput, { input });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: f.actor.id } });
        await expect(auth.mintExternalActionExecutionAuthorization(mintInput, { input }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        await withAuthenticatedTestApp(projectSourceRoutes, async app => {
            const pathFor = (sourceId: string, home = serverId) =>
                `/v1/projects/sources/${encodeURIComponent(sourceId)}?serverId=${encodeURIComponent(home)}`;
            const read = (sourceId = selected.source.id, home = serverId) => {
                const path = pathFor(sourceId, home);
                const effectActionId = 'projects.sources.read';
                return app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target: f.binding.target, installationId: f.machine.installationId!,
                        requestId: f.binding.requestId, method: 'GET', path, body: undefined, privateKey: f.key.secretKey }),
                } });
            };
            const token = await auth.createToken(f.actor.id, undefined, { kind: 'account', authority: 'present_user' });
            const ordinary = await app.inject({ method: 'GET', url: pathFor(selected.source.id),
                headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders } });
            expect(ordinary.statusCode, ordinary.body).toBe(404);
            let permissionReads = 0;
            let sourceReads = 0;
            const stop = observeSqliteRequests({ before(request) {
                if (request.model === 'ProjectSource') sourceReads++;
                if (request.model === 'TeamMembership' || request.model === 'TeamGroupMember') permissionReads++;
            } });
            try {
                const response = await read();
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ ok: true, source: selected.source, canManage: true });
                expect(permissionReads).toBe(0);
                expect(sourceReads).toBe(1);
                for (const [sourceId, home] of [[f.destination.source.id, serverId], [selected.source.id, 'another-home']]) {
                    permissionReads = 0;
                    sourceReads = 0;
                    const refused = await read(sourceId, home);
                    expect(refused.statusCode, refused.body).toBe(401);
                    expect(permissionReads).toBe(0);
                    expect(sourceReads).toBeLessThanOrEqual(1);
                }
            } finally { stop(); }
            if (actionId === 'deployments.publish.prepare') {
                await db.projectSource.update({ where: { id: selected.source.id }, data: { revision: { increment: 1 } } });
            } else {
                await db.projectSource.delete({ where: { id: selected.source.id } });
            }
            expect((await read()).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('reads newly created Catalog Source metadata from admitted allocation after ownership withdrawal', async () => {
        const f = await fixture();
        const { projectSourceId: _source, copyFrom: _copy, ...base } = f.input;
        const newProject = { name: 'New catalog project', requestKey: crypto.randomUUID(), owner: { kind: 'account' as const, accountId: f.actor.id } };
        const rootInput = { ...base, newProject, definition: { from: 'catalogApp' as const,
            templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } } } };
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input: rootInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ ...f.binding,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(f.binding.actionId, rootInput) }, { input: rootInput });
        const content = await f.artifact(f.actor.id);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, {
            serverId, newProject, requestKey: rootInput.requestKey, controllerMachineId: f.machine.id,
            protection: rootInput.protection, purpose: rootInput.purpose, deployerMode: rootInput.deployerMode,
            ...content }));
        if (!created.ok) throw new Error(created.error);
        const source = await db.projectSource.update({ where: { id: created.projectSourceId }, data: {
            owner: { kind: 'account', accountId: f.owner.id }, audience: [], revision: { increment: 1 },
        } });
        expect(await inTx(tx => readProjectSourceInTx(tx, f.actor.id, { serverId, sourceId: created.projectSourceId })))
            .toMatchObject({ ok: false });
        await withAuthenticatedTestApp(projectSourceRoutes, async app => {
            const read = (sourceId = created.projectSourceId, server = serverId) => {
                const path = `/v1/projects/sources/${encodeURIComponent(sourceId)}?serverId=${encodeURIComponent(server)}`;
                const effectActionId = 'projects.sources.read';
                return app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target: f.binding.target, installationId: f.machine.installationId!,
                        requestId: f.binding.requestId, method: 'GET', path, body: undefined, privateKey: f.key.secretKey }),
                } });
            };
            let permissionReads = 0;
            const stop = observeSqliteRequests({ before(request) {
                if (request.model === 'TeamMembership' || request.model === 'TeamGroupMember') permissionReads++;
            } });
            try {
                const response = await read();
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ ok: true, source: { id: source.id, revision: source.revision }, canManage: false });
                expect(permissionReads).toBe(0);
            } finally { stop(); }
            expect((await read(f.destination.source.id)).statusCode).toBe(401);
            expect((await read(created.projectSourceId, 'another-home')).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('reads a newly created Project Source for a catalog preparation with a new Project', async () => {
        const f = await fixture();
        const newProject = { name: 'New publish project', requestKey: crypto.randomUUID(),
            owner: { kind: 'account' as const, accountId: f.actor.id } };
        const input = { serverId, machineId: f.machine.id, installationId: f.machine.installationId!,
            newProject, templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } } };
        const admission = projectDeploymentPreparationAdmissionV1('deployments.publish.prepare', input);
        if (!admission || admission.operation !== 'catalog') throw new Error('Expected catalog admission');
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ ...f.binding,
            actionId: 'deployments.publish.prepare', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: admission }, { input });
        const content = await f.artifact(f.actor.id);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, {
            serverId, newProject, requestKey: newProject.requestKey, controllerMachineId: f.machine.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...content }));
        if (!created.ok) throw new Error(created.error);
        await withAuthenticatedTestApp(projectSourceRoutes, async app => {
            const path = `/v1/projects/sources/${encodeURIComponent(created.projectSourceId)}?serverId=${encodeURIComponent(serverId)}`;
            const effectActionId = 'projects.sources.read';
            const response = await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target: f.binding.target,
                    installationId: f.machine.installationId!, requestId: f.binding.requestId,
                    method: 'GET', path, privateKey: f.key.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            await db.projectSource.update({ where: { id: created.projectSourceId }, data: { owner: { kind: 'account', accountId: f.owner.id }, audience: [] } });
            expect((await app.inject({ method: 'GET', url: path,
                headers: { ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId, target: f.binding.target,
                        installationId: f.machine.installationId!, requestId: f.binding.requestId,
                        method: 'GET', path,
                        privateKey: f.key.secretKey }),
                } })).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it.each([false, true])('reads and publishes only the allocated template with a separate controller: %s', async separateController => {
        const f = await fixture();
        const controllerKey = separateController ? nacl.sign.keyPair() : f.key;
        const controller = separateController ? await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: f.actor.id, metadata: f.machine.metadata,
            dataEncryptionKey: f.machine.dataEncryptionKey, installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(controllerKey.publicKey),
        } }) : f.machine;
        const newProject = { name: 'Template project', requestKey: crypto.randomUUID(),
            owner: { kind: 'account' as const, accountId: f.actor.id } };
        const rootInput = { mode: 'apply' as const, serverId, machineId: f.machine.id, newProject,
            templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } },
            environment: { kind: 'create' as const, name: 'Template app', requestKey: crypto.randomUUID(),
                protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
                controllerMachineId: controller.id },
            target: { kind: 'new' as const, installationId: f.machine.installationId! },
            destination: { kind: 'stored' as const }, bindings: [], deploy: { requestKey: crypto.randomUUID() } };
        const target = { kind: 'machine' as const, machineId: controller.id };
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target, input: rootInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ ...f.binding,
            machineId: controller.id, target,
            actionId: 'deployments.templates.instantiate', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', rootInput),
        }, { input: rootInput });
        const content = await f.artifact(f.actor.id);
        const runtimeMember = { machineId: f.machine.id, installationId: f.machine.installationId! };
        const createInput = { serverId, newProject, requestKey: rootInput.environment.requestKey,
            controllerMachineId: controller.id, buildMachineId: f.machine.id,
            protection: rootInput.environment.protection, purpose: rootInput.environment.purpose,
            deployerMode: rootInput.environment.deployerMode, ...content,
            firstTargetLink: { machines: [runtimeMember], ...content } };
        const createPurpose = (body: typeof createInput) => isDeploymentPreparationHttpPurposeInTx(db, authorization.binding,
            'deployments.environments.create', { method: 'POST', path: '/v1/deployments/environments', body, routeInput: body }, {});
        expect(await createPurpose(createInput)).toBe(true);
        expect(await createPurpose({ ...createInput, firstTargetLink: { ...createInput.firstTargetLink,
            machines: [{ ...runtimeMember, installationId: crypto.randomUUID() }] } })).toBe(false);
        if (separateController) expect(await createPurpose({ ...createInput, firstTargetLink: { ...createInput.firstTargetLink,
            machines: [{ machineId: controller.id, installationId: controller.installationId! }] } })).toBe(false);
        const create = async (requestKey: string) => {
            const content = await f.artifact(f.actor.id);
            return inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, {
                serverId, newProject, requestKey, controllerMachineId: controller.id,
                protection: rootInput.environment.protection, purpose: rootInput.environment.purpose,
                deployerMode: rootInput.environment.deployerMode, ...content,
            }));
        };
        await withAuthenticatedTestApp(app => { projectSourceRoutes(app); machinesRoutes(app); }, async app => {
            const readMachine = (id: string) => {
                const path = `/v1/machines/${id}`;
                return app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.templates.instantiate',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'deployments.templates.instantiate', target, installationId: controller.installationId!,
                        requestId: f.binding.requestId, method: 'GET', path, privateKey: controllerKey.secretKey }),
                } });
            };
            if (separateController) {
                await db.machine.update({ where: { id: f.machine.id }, data: { accountId: f.owner.id } });
                const unadmitted = await readMachine(f.machine.id);
                expect(unadmitted.statusCode, unadmitted.body).toBe(404);
                expect(unadmitted.json()).toEqual({ error: 'Machine not found' });
                await db.machine.update({ where: { id: f.machine.id }, data: { accountId: f.actor.id } });
            }
            const runtime = await readMachine(f.machine.id);
            expect(runtime.statusCode, runtime.body).toBe(200);
            expect(runtime.json()).toMatchObject({ machine: { id: f.machine.id, installationId: f.machine.installationId } });
            // The executing controller is the admitted Environment's own controller operand.
            if (separateController) expect((await readMachine(controller.id)).statusCode).toBe(200);
            const read = (sourceId: string, home = serverId) => {
                const path = `/v1/projects/sources/${encodeURIComponent(sourceId)}?serverId=${encodeURIComponent(home)}`;
                const effectActionId = 'projects.sources.read';
                return app.inject({ method: 'GET', url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId, target, installationId: controller.installationId!,
                        requestId: f.binding.requestId, method: 'GET', path, privateKey: controllerKey.secretKey }),
                } });
            };
            expect((await read(f.destination.source.id)).statusCode).toBe(401);
            const otherAllocation = await create(crypto.randomUUID());
            if (!otherAllocation.ok) throw new Error(otherAllocation.error);
            expect((await read(otherAllocation.projectSourceId)).statusCode).toBe(401);
            const created = await create(rootInput.environment.requestKey);
            if (!created.ok) throw new Error(created.error);
            await withAuthenticatedTestApp(registerDeploymentRoutes, async preparation => {
                const effectActionId = 'deployments.bindings.set';
                const reviewedChild = { actionId: effectActionId, role: 'template.bindings',
                    inputDigest: computeActionInputApprovalDigestV1(effectActionId, { serverId,
                        environmentId: created.environmentId, expectedRevision: created.revision, set: [], remove: [] }) };
                const body = EnvironmentSecretClientBindingsInputV1Schema.parse({ kind: 'clientBindings', serverId,
                    environmentId: created.environmentId, expectedRevision: created.revision });
                const admit = (input: typeof body) => {
                    const path = `/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/secret-launch-admission`;
                    return preparation.inject({ method: 'POST', url: path, payload: input, headers: {
                        ...currentAccountStoredContentCompatibilityHeaders,
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                        [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                            authorizationToken: authorization.token, effectActionId, target,
                            installationId: controller.installationId!, requestId: f.binding.requestId,
                            method: 'POST', path, body: input, reviewedChild, privateKey: controllerKey.secretKey }),
                    } });
                };
                expect((await admit({ ...body, serverId: 'another-home' })).statusCode).toBe(401);
                expect((await admit({ ...body, environmentId: otherAllocation.environmentId })).statusCode).toBe(401);
                const admitted = await admit(body);
                expect(admitted.statusCode, admitted.body).toBe(200);
                expect(admitted.json()).toMatchObject({ ok: true, bindingPreparation: { runtimeInstallations: [] } });
            }, { authentication: 'real' });
            const linkInput = { serverId, environmentId: created.environmentId, expectedRevision: 1,
                requestKey: f.binding.requestId, targetId: 'own-server', role: 'runtime', machines: [runtimeMember], ...content };
            const linkPurpose = (body: typeof linkInput) => isDeploymentPreparationHttpPurposeInTx(db, authorization.binding,
                'deployments.targets.link', { method: 'POST', path: `/v1/deployments/environments/${created.environmentId}/targets`, body, routeInput: body }, {});
            expect(await linkPurpose(linkInput)).toBe(true);
            expect(await linkPurpose({ ...linkInput, machines: [{ ...runtimeMember, installationId: crypto.randomUUID() }] })).toBe(false);
            if (separateController) expect(await linkPurpose({ ...linkInput,
                machines: [{ machineId: controller.id, installationId: controller.installationId! }] })).toBe(false);
            const response = await read(created.projectSourceId);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, source: { id: created.projectSourceId } });
            const source = response.json().source;
            const scope = createDeploymentCandidatePublicationV1({ ...authorization.binding,
                environmentId: created.environmentId, source: { id: source.id, revision: source.revision } });
            await withAuthenticatedTestApp(artifactsRoutes, async artifacts => {
                const publish = (id: string) => {
                    const path = '/v1/artifacts';
                    const body = ArtifactJsonCreateHttpInputV1Schema.parse({ id,
                        kind: 'v1:other:deployment-receipt.v1', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        header: encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Receipt' }),
                        body: encodePlainArtifactStoredContent({ body: '{}' }) });
                    return artifacts.inject({ method: 'POST', url: path, payload: body, headers: {
                        ...currentAccountStoredContentCompatibilityHeaders,
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                            authorizationToken: authorization.token, effectActionId: 'deployments.deploy',
                            target, installationId: controller.installationId!,
                            requestId: f.binding.requestId, method: 'POST', path, body, privateKey: controllerKey.secretKey }),
                    } });
                };
                expect((await publish(crypto.randomUUID())).statusCode).toBe(401);
                const published = await publish(scope.contentArtifactId);
                expect(published.statusCode, published.body).toBe(200);
                expect(published.json()).toMatchObject({ id: scope.contentArtifactId });
                const replacement = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.actor.id,
                    metadata: f.machine.metadata, dataEncryptionKey: f.machine.dataEncryptionKey,
                    installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey) } });
                await db.deploymentEnvironment.update({ where: { id: created.environmentId },
                    data: { controllerMachineId: replacement.id } });
                const moved = await publish(scope.contentArtifactId);
                expect(moved.statusCode, moved.body).toBe(401);
                expect(moved.json()).toMatchObject({ error: 'invalid_token' });
            }, { authentication: 'real' });
            for (const sourceId of [f.destination.source.id, f.source.source.id]) {
                expect((await read(sourceId)).statusCode).toBe(401);
            }
            expect((await read(created.projectSourceId, 'another-home')).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('binds the reviewed catalog Deploy to its allocated Environment before the Domain child', async () => {
        const f = await fixture();
        const { copyFrom: _copy, ...base } = f.input;
        const rootInput = { ...base, definition: { from: 'catalogApp' as const,
            templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } } } };
        const admission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', rootInput);
        if (!admission || admission.operation !== 'create') throw new Error('Expected catalog admission');
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input: rootInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ ...f.binding,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: admission }, { input: rootInput });
        const binding = authorization.binding;
        const environmentContent = await f.artifact(f.actor.id);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, {
            serverId, projectSourceId: f.destination.source.id, requestKey: f.input.requestKey,
            controllerMachineId: f.machine.id, protection: f.input.protection, purpose: f.input.purpose,
            deployerMode: f.input.deployerMode, ...environmentContent }));
        if (!created.ok) throw new Error(created.error);
        const input = { serverId, environmentId: created.environmentId, expectedRevision: created.revision,
            targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: binding.requestId,
            ...await f.artifact(f.actor.id, 'deployment-receipt.v1') };
        const reviewedChild = { actionId: 'deployments.deploy', role: 'template.deploy',
            inputDigest: computeActionInputApprovalDigestV1('deployments.deploy', input) };
        const proof = { method: 'POST', path: `/v1/deployments/environments/${created.environmentId}/deploy`,
            reviewedChild, body: { ...input, actionOperationId: 'deploy-operation' } };
        // Ownership withdrawal affects the next admission, not this finite root.
        await db.projectSource.update({ where: { id: f.destination.source.id }, data: {
            owner: { kind: 'account', accountId: f.owner.id }, audience: [],
        } });
        await db.artifact.update({ where: { id: environmentContent.contentArtifactId }, data: { accountId: f.owner.id } });
        expect(await inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, binding, admission))).toBe(false);
        expect(await inTx(tx => resolveArtifactAccessInTx(tx, { actorAccountId: f.actor.id,
            artifactId: environmentContent.contentArtifactId }))).toBeNull();
        const verify = (request: Readonly<{ method: string; path: string; body: unknown; reviewedChild?: typeof reviewedChild }>) =>
            verifyExternalActionDomainExecutionRequest({ ...request,
            authorizationToken: authorization.token, effectActionId: reviewedChild.actionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(binding.target),
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: reviewedChild.actionId, target: binding.target, installationId: binding.installationId,
                requestId: binding.requestId, ...request, privateKey: f.key.secretKey }),
        });
        expect(await verify(proof)).toMatchObject({ binding: { actionId: binding.actionId, requestId: binding.requestId },
            effectActionId: reviewedChild.actionId, reviewedChildAdmission: reviewedChild });
        let permissionReads = 0;
        const stop = observeSqliteRequests({ before: request => {
            if (['ProjectSource', 'TeamMembership', 'TeamGroupMember'].includes(request.model ?? '')) permissionReads++;
        } });
        try {
            const purpose = (value = proof) => inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, 'deployments.deploy', value,
                undefined, request => isDeploymentNativeHttpPurpose({ binding, effectActionId: 'deployments.deploy' }, {
                    ...request, body: request.body, authorizationToken: authorization.token, effectActionId: reviewedChild.actionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(binding.target),
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: reviewedChild.actionId, target: binding.target, installationId: binding.installationId,
                        requestId: binding.requestId, ...request, privateKey: f.key.secretKey }),
                })));
            expect(await purpose({ ...proof, path: `${proof.path}ments` })).toBeNull();
            expect(await purpose()).toEqual({ rootActionId: binding.actionId, effectActionId: 'deployments.deploy',
                child: { environmentId: created.environmentId } });
            for (const patch of [{ environmentId: f.original.id }, { requestKey: 'foreign' },
                { contentBodyVersion: 2 }, { expectedTargetLinkRevision: 2 }]) {
                expect(await purpose({ ...proof, body: { ...proof.body, ...patch } })).toBeNull();
            }
            expect(await purpose({ ...proof, reviewedChild: { ...reviewedChild, role: 'template.domain:web' } })).toBeNull();
            expect(permissionReads).toBe(0);
        } finally { stop(); }
        const scope = createDeploymentCandidatePublicationV1({ ...binding, environmentId: created.environmentId,
            source: { id: f.destination.source.id, revision: f.destination.source.revision } });
        let authorityReads = 0;
        const stopCandidate = observeSqliteRequests({ before: request => {
            if (['TeamMembership', 'TeamGroupMember'].includes(request.model ?? '')) authorityReads++;
        } });
        try {
            // Initial Create content cannot borrow the native Deploy candidate purpose.
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, binding, binding.actionId, {
                method: 'GET', path: `/v1/artifacts/${scope.contentArtifactId}`,
            }))).toBeNull();
            expect(await verify({ method: 'GET', body: undefined, path: `/v1/artifacts/${scope.contentArtifactId}`, reviewedChild }))
                .toMatchObject({ reviewedChildAdmission: reviewedChild });
            expect(await verify({ method: 'GET', body: undefined, path: `/v1/artifacts/${environmentContent.contentArtifactId}`, reviewedChild }))
                .toMatchObject({ reviewedChildAdmission: reviewedChild });
            expect(await verify({ method: 'GET', body: undefined, path: '/v1/account/encryption/currentness', reviewedChild }))
                .toMatchObject({ reviewedChildAdmission: reviewedChild });
            expect(await verify({ method: 'GET', body: undefined, path: `/v1/artifacts/${f.original.contentArtifactId}`, reviewedChild })).toBeNull();
            expect(await verify({ method: 'GET', body: undefined, path: `/v1/artifacts/${scope.contentArtifactId}`,
                reviewedChild: { ...reviewedChild, role: 'template.domain:web' } })).toBeNull();
            expect(authorityReads).toBe(0);
        } finally { stopCandidate(); }
    });

    it('admits the signed create Domain child through the ordinary receiving route and captures its original root', async () => {
        const f = await fixture();
        const { copyFrom: _copy, ...base } = f.input;
        const rootInput = { ...base, definition: { from: 'catalogApp' as const, templateRef: { sourceId: 'apps', itemId: 'web',
            version: '1', ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } } } };
        const admission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', rootInput);
        if (!admission) throw new Error('Expected catalog projection');
        const envelope = { v: 1 as const, requestId: f.binding.requestId, target: f.binding.target, input: rootInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.actor.id, authentication: { kind: 'account', tokenEpoch: f.actor.tokenEpoch }, actionId: f.binding.actionId,
            requestId: f.binding.requestId, target: f.binding.target, machineId: f.machine.id,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), deploymentPreparationAdmission: admission }, { input: rootInput });
        const environmentContent = await f.artifact(f.actor.id);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, { serverId,
            projectSourceId: f.destination.source.id, requestKey: rootInput.requestKey, controllerMachineId: f.machine.id,
            protection: rootInput.protection, purpose: rootInput.purpose, deployerMode: rootInput.deployerMode, ...environmentContent }));
        if (!created.ok) throw new Error(created.error);
        const target = await db.deploymentTargetLink.create({ data: { environmentId: created.environmentId,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: f.actor.id, ...await f.artifact(f.actor.id, 'deployment-target-link.v1'),
            machines: { create: { machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'active' } } } });
        await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { runtimeTargetLinkId: target.id } });
        const input = { serverId, environmentId: created.environmentId, expectedRevision: created.revision,
            domainId: crypto.randomUUID(), targetLinkId: target.id, expectedTargetLinkRevision: target.revision,
            requestKey: crypto.randomUUID(), ...await f.artifact(f.actor.id, 'deployment-domain.v1') };
        const reviewedChild = { actionId: 'deployments.domains.add', role: 'template.domain:web',
            inputDigest: computeActionInputApprovalDigestV1('deployments.domains.add', input) };
        const body = { ...input, requestId: f.binding.requestId, actionOperationId: crypto.randomUUID(),
            placements: [{ machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'public',
                dockerEngineId: 'domain-engine', listener: 'public' }] };
        const path = `/v1/deployments/environments/${input.environmentId}/domains`;
        const rpc = (job: ReturnType<typeof DeploymentChildRpcV1Schema.parse>, transport: 'plain' | 'sealed' | 'digest' = 'plain') => {
            const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
            const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
            const params = transport === 'plain' ? job : 'opaque-encrypted-child-params';
            const execution = { v: 1 as const, authorization, effectActionId: reviewedChild.actionId, target: f.binding.target,
                installationId: f.machine.installationId!, reviewedChild, deploymentChildRouting,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: reviewedChild.actionId, target: f.binding.target, installationId: f.machine.installationId!,
                    method, requestId, params, reviewedChild, deploymentChildRouting, privateKey: f.key.secretKey }) };
            return verifyExternalActionMachineRpcExecution(execution, { method, requestId,
                ...(transport === 'digest' ? { paramsPresent: true, paramsDigest: computeExternalActionMachineRpcParamsDigestV1(params) }
                    : { params, originalActionEnvelope: envelope }) });
        };
        const discover = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: reviewedChild.actionId, input,
            machineId: f.machine.id, installationId: f.machine.installationId });
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const read = (artifactId: string) => {
                const readPath = `/v1/artifacts/${artifactId}`;
                return app.inject({ method: 'GET', url: readPath, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: reviewedChild.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.binding.target),
                    [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: reviewedChild.actionId, target: f.binding.target, installationId: f.machine.installationId!,
                        requestId: f.binding.requestId, method: 'GET', path: readPath, body: undefined, reviewedChild, privateKey: f.key.secretKey }),
                } });
            };
            const opened = await read(input.contentArtifactId);
            expect(opened.statusCode, opened.body).toBe(200);
            if (discover.kind !== 'domainDiscover') throw new Error('Expected discover fixture');
            for (const transport of ['plain', 'sealed', 'digest'] as const) {
                expect(await rpc(discover, transport)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domainDiscover' } } });
                expect(await rpc(DeploymentChildRpcV1Schema.parse({ ...discover, input: { ...discover.input, requestKey: crypto.randomUUID() } }),
                    transport), transport).toBeNull();
            }

            const foreignArtifact = await f.artifact(f.owner.id, 'deployment-domain.v1');
            expect((await read(foreignArtifact.contentArtifactId)).statusCode).toBe(404);
            const request = (payload = body) => app.inject({ method: 'POST', url: path, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: reviewedChild.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.binding.target),
                [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: reviewedChild.actionId, target: f.binding.target, installationId: f.machine.installationId!,
                    requestId: f.binding.requestId, method: 'POST', path, body: payload, reviewedChild, privateKey: f.key.secretKey }),
            } });
            const result = await request();
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ ok: true, domain: { state: 'pending' } });
            const row = await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } });
            expect(row.capturedPlacements).toEqual(expect.arrayContaining([expect.objectContaining({ execution: {
                actionId: 'deployments.domains.add', requestEnvelopeDigest: authorization.binding.requestEnvelopeDigest,
                controller: { machineId: f.machine.id, installationId: f.machine.installationId },
            } })]));
            const accepted = DeploymentDomainMutationResultV1Schema.parse(result.json());
            if (!accepted.ok || !accepted.domain.placements?.[0]) throw new Error('Expected accepted Domain capture');
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: reviewedChild.actionId,
                machineId: f.machine.id, installationId: f.machine.installationId,
                input: { serverId, environmentId: input.environmentId, domainId: input.domainId },
                expectedDomainRevision: accepted.domain.revision, actionOperationId: body.actionOperationId,
                capture: accepted.domain.placements[0] });
            const authorityReads: string[] = [];
            const stopAuthorityReads = observeSqliteRequests({ before: event => {
                if (['RepeatKey', 'ProjectSource', 'TeamMembership', 'TeamGroupMember'].includes(event.model ?? '')) {
                    authorityReads.push(event.model!);
                }
            } });
            try {
                expect(await rpc(job)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domain' } } });
            } finally { stopAuthorityReads(); }
            expect(authorityReads).toEqual([]);
            const transitionPath = `${path}/${input.domainId}/transitions`;
            const observations = accepted.domain.placements.map(capture => {
                const observation = { capture, state: 'active' as const, dnsHealth: {
                    status: 'up' as const, evidence: { v: 1 as const, items: [{
                        source: { kind: 'alert' as const, label: 'dns' }, author: { kind: 'process' as const },
                        text: JSON.stringify({ reason: 'dns_matched' }),
                    }] },
                } };
                return { ...observation, proof: signMachineInstallationProof({ privateKey: f.key.secretKey,
                    payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: accepted.domain.revision, observation }) }) };
            });
            const transitionBody = { serverId, environmentId: input.environmentId, domainId: input.domainId,
                expectedDomainRevision: accepted.domain.revision, observations };
            const transitioned = await app.inject({ method: 'POST', url: transitionPath, payload: transitionBody, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: reviewedChild.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(f.binding.target),
                [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: reviewedChild.actionId, target: f.binding.target, installationId: f.machine.installationId!,
                    requestId: f.binding.requestId, method: 'POST', path: transitionPath, body: transitionBody, reviewedChild, privateKey: f.key.secretKey }),
            } });
            expect(transitioned.statusCode, transitioned.body).toBe(200);
            expect(transitioned.json()).toMatchObject({ ok: true, domain: { state: 'active' } });
            expect((await request({ ...body, contentBodyVersion: 2 })).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('spends admitted copy purposes on the exact source and acknowledged new Environment without Source permission reads', async () => {
        const f = await fixture();
        expect(await inTx(tx => isDeploymentPreparationAuthorizedInTx(tx, f.binding, f.admission))).toBe(true);
        const content = await f.artifact(f.actor.id);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, {
            serverId, projectSourceId: f.destination.source.id, requestKey: f.input.requestKey,
            controllerMachineId: f.machine.id, protection: f.input.protection, purpose: f.input.purpose,
            deployerMode: f.input.deployerMode, ...content, copyFrom: f.admission.copyFrom }));
        if (!created.ok) throw new Error(created.error);
        const otherContent = await f.artifact(f.actor.id);
        const other = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, {
            serverId, projectSourceId: f.destination.source.id, requestKey: crypto.randomUUID(), controllerMachineId: f.machine.id,
            protection: f.input.protection, purpose: f.input.purpose, deployerMode: f.input.deployerMode, ...otherContent }));
        if (!other.ok) throw new Error(other.error);
        await db.projectSource.update({ where: { id: f.source.source.id }, data: { audience: [] } });
        const proof = (environmentId: string) => ({ method: 'POST', path: `/v1/deployments/environments/${environmentId}/bindings`,
            body: { serverId, environmentId, expectedRevision: 1, ...content, referencedSavedSecretRevisions: [], grants: [] } });
        let permissionReads = 0;
        const stop = observeSqliteRequests({ before: request => {
            if (['TeamMembership', 'TeamGroupMember'].includes(request.model ?? '')) permissionReads++;
            if (request.model === 'ProjectSource') permissionReads++;
        } });
        const purpose = (effect: string, value: Parameters<typeof isDeploymentPreparationHttpPurposeInTx>[3]) =>
            inTx(tx => isDeploymentPreparationHttpPurposeInTx(tx, f.binding, effect, value, {}));
        try {
            expect(await purpose('deployments.bindings.set', proof(created.environmentId))).toBe(true);
            expect(await inTx(tx => readDeploymentCreateHttpPurposeInTx(tx, f.binding, 'deployments.bindings.set', proof(created.environmentId))))
                .toEqual({ rootActionId: f.binding.actionId, effectActionId: 'deployments.bindings.set', child: { environmentId: created.environmentId } });
            expect(await purpose('deployments.bindings.set', proof(other.environmentId))).toBe(false);
            expect(await purpose('deployments.bindings.set', proof(f.original.id))).toBe(false);
            expect(await purpose('deployments.environments.get', { method: 'GET',
                path: `/v1/deployments/environments/${f.original.id}?serverId=${serverId}` })).toBe(true);
            expect(await purpose('deployments.environments.get', { method: 'GET',
                path: `/v1/deployments/environments/${created.environmentId}?serverId=${serverId}` })).toBe(true);
            expect(await purpose(f.binding.actionId, { method: 'GET', path: `/v1/artifacts/${f.original.contentArtifactId}` })).toBe(true);
            expect(await purpose(f.binding.actionId, { method: 'GET', path: `/v1/artifacts/${content.contentArtifactId}` })).toBe(true);
            expect(await purpose('deployments.bindings.set', { method: 'GET', path: `/v1/artifacts/${otherContent.contentArtifactId}` })).toBe(false);
            expect(await purpose('deployments.bindings.set', { method: 'GET', path: `/v1/artifacts/${f.original.contentArtifactId}` })).toBe(false);
            expect(await purpose(f.binding.actionId, { method: 'GET', path: '/v1/account/encryption' })).toBe(true);
            expect(permissionReads, 'signed admitted work must not re-evaluate Source/Team permission per call').toBe(0);
        } finally { stop(); }
    });
});
