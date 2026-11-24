import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPersistentTokenGenerator } from 'privacy-kit';
import { bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionRequestEnvelopeSchema, ExternalActionHttpErrorSchema,
    createExternalActionDaemonDispatchResponse, prepareExternalActionResponseEnvelopeV1,
    type ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { projectManagedOpaqueSetupSourcesV1 } from '@happier-dev/cli-common/machines/managed';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    type WorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows';
import { startWorkflowApprovedOperationServer } from '@/testkit/workflowApprovedOperationServer.testkit';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { admitWorkflowRun } from '@/app/workflows/workflowRunService';
import { db } from '@/storage/db';
import { hasCurrentExternalActionWorkflowOriginInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { isAutomationOriginRunPublisherTx } from '@/app/automations/automationTriggerCauseChain';
import { createMachineDataEncryptionKeyV1, decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { DeploymentReceiptResultV1Schema, computeDeploymentTransitionRequestDigestV1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { openExternalActionResponseV2, prepareExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import tweetnacl from 'tweetnacl';
import { fetchAutomationAccountCurrentnessWitnessTx } from '@/app/automations/automationAccountCurrentness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, type EnvironmentSecretLaunchAdmissionBodyV1 } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';

let server: Awaited<ReturnType<typeof startWorkflowApprovedOperationServer>>;
beforeAll(async () => { server = await startWorkflowApprovedOperationServer(); }, 120_000);
afterAll(async () => { if (server) await server.close(); });

async function expectWorkflowScopeDenied(pending: Promise<Response>) {
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'credential_scope_denied' });
}

it('publishes complete Machine metadata for real daemon snapshot readers', async () => {
    for (const machine of server.machines) {
        const row = await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { metadata: true } });
        const metadata = StoredMachinePublishedMetadataV1Schema.parse(decodePlainMachineStoredContent(row.metadata!));
        expect(metadata).toMatchObject({ platform: 'linux', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier' });
    }
});

it('binds native backup Workflow provenance to the assigned publisher and selected installation', async () => {
    const [publisher, receiver] = server.machines;
    const runId = randomUUID();
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId,
        accountCurrentness: server.currentness, origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
            sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: snapshot })) });
    await server.claim(publisher.id);
    const actionId = DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1;
    const requestId = `${runId}/${randomUUID()}/0`;
    const target = { kind: 'machine' as const, machineId: receiver.id };
    const input = { serverId: server.homeId, environmentId: 'backup-environment', targetLinkId: 'backup-link',
        machineId: receiver.id, installationId: receiver.installationId, deploymentId: 'deployment',
        expectedRevision: 1, configRevision: 2, backupOperationId: 'capture',
        snapshotId: 'a'.repeat(64), level: 'manifestReadBack' };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target, input });
    const native = projectDeploymentNativeAdmissionV1(actionId, input);
    const admission = { accountId: server.accountId, serverIdentityId: server.homeId, actionId, requestId, target,
        machineId: publisher.id, publisherMachineId: publisher.id, workflowActionOrigin: { runId, requestId },
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) };
    // This gate proves the Run and exact placement. The native mint separately
    // requires the real Environment, receipt and membership for this input.
    expect(await hasCurrentExternalActionWorkflowOriginInTx(db, { ...admission, deploymentNativeAdmission: native })).toBe(true);
    expect(await hasCurrentExternalActionWorkflowOriginInTx(db, { ...admission, deploymentNativeAdmission: undefined })).toBe(false);
    expect(await hasCurrentExternalActionWorkflowOriginInTx(db, { ...admission, deploymentNativeAdmission:
        projectDeploymentNativeAdmissionV1(actionId, { ...input, installationId: publisher.installationId }) })).toBe(false);
    expect(await hasCurrentExternalActionWorkflowOriginInTx(db, { ...admission, publisherMachineId: receiver.id,
        deploymentNativeAdmission: native })).toBe(false);
}, 120_000);

it.each(['ask', 'trigger-template', 'e2ee', 'teardown', 'move-link', 'move-link-plain'] as const)('issues normal Workflow native provenance before receiver approval (%s)', async intent => {
    const [publisher, receiver] = server.machines;
    const moveLink = intent === 'move-link' || intent === 'move-link-plain';
    const controller = moveLink ? publisher : receiver;
    const project = await server.createDeploymentProject();
    // Fixture content is plain, so the sibling Environment's project is created before any E2EE switch.
    const siblingProject = moveLink ? await server.createDeploymentProject() : project;
    const environment = await db.deploymentEnvironment.create({ data: {
        projectSourceId: project.projectSourceId, createdByAccountId: server.accountId,
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        controllerMachineId: controller.id, buildMachineId: publisher.id, ...project.environmentContent,
        ...(moveLink ? { revision: 3 } : {}),
    } });
    const link = await db.deploymentTargetLink.create({ data: {
        environmentId: environment.id, createdByAccountId: server.accountId, role: 'runtime',
        sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed', ...project.runtimeContent,
        ...(moveLink ? { revision: 2 } : {}),
    } });
    await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
    const actionId = moveLink ? 'deployments.targets.link' : intent === 'teardown' ? 'deployments.teardown' : 'deployments.deploy';
    const runId = randomUUID();
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id,
            executionTarget: { kind: moveLink ? 'detached_run' : 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const accepted: WorkflowAcceptedSnapshotV1 = intent === 'trigger-template' ? { ...snapshot, approvedOperation: {
        parent: { actionId: 'workflow.trigger.add', input: {} }, approvedBy: { accountId: server.accountId }, steps: [],
    } } : snapshot;
    const secret = new Uint8Array(32).fill(7);
    const material = { type: 'dataKey' as const, machineKey: secret };
    const contentBinding = createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(secret).publicKey);
    const mode = intent === 'e2ee' || intent === 'move-link' ? 'e2ee' : 'plain';
    const machineContentBefore = mode === 'e2ee' ? await db.machine.findMany({
        where: { id: { in: server.machines.map(machine => machine.id) } },
        select: { id: true, metadata: true, daemonState: true, dataEncryptionKey: true },
    }) : [];
    try {
        if (mode === 'e2ee') {
            await db.account.update({ where: { id: server.accountId }, data: { encryptionMode: mode, ...contentBinding } });
            for (const machine of machineContentBefore) {
                const key = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: contentBinding.contentPublicKey,
                    randomBytes: length => new Uint8Array(randomBytes(length)) });
                await db.machine.update({ where: { id: machine.id }, data: {
                    metadata: encodeBase64(await sealSessionDataKeyBundleV0(decodePlainMachineStoredContent(machine.metadata!), key.encryptionKey)),
                    daemonState: machine.daemonState === null ? null
                        : encodeBase64(await sealSessionDataKeyBundleV0(decodePlainMachineStoredContent(machine.daemonState), key.encryptionKey)),
                    dataEncryptionKey: new Uint8Array(key.dataEncryptionKey),
                } });
            }
        }
        const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(db, server.accountId);
        if (!accountCurrentness) throw new Error('account_currentness_unavailable');
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(mode === 'e2ee' ? sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'e2ee', runDataKey: secret, randomBytes: length => new Uint8Array(randomBytes(length)),
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: accepted,
        }) : sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: accepted,
        }));
        await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId,
            accountCurrentness, origin: { kind: 'direct' }, acceptedEnvelope,
            ...(mode === 'e2ee' ? { recipientKeyEnvelopes: [{ recipientAccountId: server.accountId,
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentBinding.contentPublicKey),
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: secret,
                    recipientPublicKey: contentBinding.contentPublicKey, randomBytes: length => new Uint8Array(randomBytes(length)) })),
            }] } : {}),
        });
        await server.claim(publisher.id);
        const requestId = `${runId}/${randomUUID()}/0`;
        const target = { kind: 'machine' as const, machineId: controller.id };
        const input = actionId === 'deployments.deploy'
            ? { serverId: server.homeId, environmentId: environment.id, sha: 'a'.repeat(40), requestKey: randomUUID() }
            : actionId === 'deployments.targets.link' ? {
                serverId: server.homeId, environmentId: environment.id, expectedRevision: environment.revision,
                requestKey: `${randomUUID()}:link`, targetId: 'own-server', role: 'runtime', targetKind: 'ownServer',
                replacesLinkId: link.id, expectedTargetLinkRevision: link.revision,
                machines: [{ machineId: receiver.id, installationId: receiver.installationId }],
            } : { serverId: server.homeId, environmentId: environment.id, expectedRevision: 1,
                targetLinkId: link.id, expectedTargetLinkRevision: 1, requestKey: randomUUID(), reason: 'manual',
                ...await server.createDeploymentArtifact({ header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Teardown' }, body: '{}' }) };
        const binding = {
            serverIdentityId: server.homeId, accountId: server.accountId, authentication: { kind: 'account', tokenEpoch: server.tokenEpoch },
            actionId, requestId, target,
        } as const;
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding, input, material, randomBytes: length => new Uint8Array(randomBytes(length)) })
            : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target, input });
        const workflowActionOrigin = { runId, requestId };
        const request = { v: 1, machineId: publisher.id, envelope, workflowActionOrigin,
            installationProof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey, payload: {
                version: 1, accountId: server.accountId, machineId: publisher.id, installationId: publisher.installationId,
                externalActionOrigin: { homeId: server.homeId, actionId, requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: workflowActionOrigin },
            } }) };
        let delivered = 0;
        if (moveLink) {
            server.setReceiver(controller.id, async packet => {
                delivered++;
                expect(packet.executionAuthorization?.binding).toMatchObject({ actionId, machineId: controller.id,
                    installationId: controller.installationId, workflowActionOrigin, deploymentLinkAdmission: { environmentId: environment.id,
                        replacement: { replacesLinkId: link.id, expectedTargetLinkRevision: link.revision,
                            machines: [{ machineId: receiver.id, installationId: receiver.installationId }] } } });
                const execution = { ok: false, errorCode: 'deployment_executor_unavailable', error: 'deployment_executor_unavailable' } as const;
                return createExternalActionDaemonDispatchResponse(envelope.v === 2 ? prepareExternalActionResponseV2({ binding, request: envelope,
                    executedMachineId: controller.id, material, randomBytes: length => new Uint8Array(randomBytes(length)), execution })
                    : prepareExternalActionResponseEnvelopeV1({ v: 1, actionId, requestId: envelope.requestId, execution }));
            });
            // A Run's Link naming another Environment's runtime Link is refused before delivery.
            const siblingEnvironment = await db.deploymentEnvironment.create({ data: { ...siblingProject.environmentContent,
                projectSourceId: siblingProject.projectSourceId, createdByAccountId: server.accountId, protection: 'nonProduction',
                purpose: 'standard', deployerMode: 'managers', controllerMachineId: controller.id, buildMachineId: publisher.id } });
            const siblingLink = await db.deploymentTargetLink.create({ data: { ...siblingProject.runtimeContent,
                environmentId: siblingEnvironment.id, createdByAccountId: server.accountId, role: 'runtime',
                sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed' } });
            const siblingRequestId = `${runId}/${randomUUID()}/0`;
            const siblingInput = { ...input, requestKey: `${randomUUID()}:link`, replacesLinkId: siblingLink.id,
                expectedTargetLinkRevision: siblingLink.revision };
            const siblingBinding = { ...binding, requestId: siblingRequestId };
            const siblingEnvelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding: siblingBinding, input: siblingInput, material, randomBytes: length => new Uint8Array(randomBytes(length)) })
                : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: siblingRequestId, target, input: siblingInput });
            const siblingOrigin = { runId, requestId: siblingRequestId };
            const sibling = await fetch(`${server.baseUrl}/v1/actions/${actionId}`, { method: 'POST',
                headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ v: 1, machineId: publisher.id, envelope: siblingEnvelope, workflowActionOrigin: siblingOrigin,
                    installationProof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey, payload: {
                        version: 1, accountId: server.accountId, machineId: publisher.id, installationId: publisher.installationId,
                        externalActionOrigin: { homeId: server.homeId, actionId, requestId: siblingRequestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(siblingEnvelope), origin: siblingOrigin },
                    } }) }) });
            expect(sibling.status).toBe(403);
            expect(delivered).toBe(0);
        }
        const path = moveLink ? `/v1/actions/${actionId}` : bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
        const response = await fetch(`${server.baseUrl}${path}`, {
            method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(request),
        });
        let refusalCode: string | undefined;
        if (!response.ok) {
            const failure = ExternalActionHttpErrorSchema.safeParse(await response.clone().json());
            refusalCode = failure.success ? 'code' in failure.data ? failure.data.code : failure.data.error : 'unrecognized_http_error';
        }
        expect(response.status, refusalCode).toBe(200);
        if (moveLink) {
            expect(delivered).toBe(1);
            if (envelope.v === 1) return;
            expect(openExternalActionResponseV2({ envelope: await response.json(), binding, request: envelope, material }))
                .toMatchObject({ ok: false, errorCode: 'deployment_executor_unavailable' });
            return;
        }
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
        expect(authorization.binding).toMatchObject({ machineId: receiver.id, installationId: receiver.installationId,
            workflowActionOrigin, accountEncryptionMode: mode });
        expect(authorization.binding.deploymentCandidatePublication).toEqual(expect.objectContaining({
            environmentId: environment.id, source: { id: project.projectSourceId, revision: 1 } }));
    } finally {
        if (mode === 'e2ee') await db.account.update({ where: { id: server.accountId }, data: {
            encryptionMode: 'plain', publicKey: null, contentPublicKey: null, contentPublicKeySig: null,
        } });
        for (const machine of machineContentBefore) {
            await db.machine.update({ where: { id: machine.id }, data: {
                metadata: machine.metadata, daemonState: machine.daemonState, dataEncryptionKey: machine.dataEncryptionKey,
            } });
        }
    }
}, 120_000);

it('does not let a compact Workflow root continue an independently admitted receipt reusing its candidate Artifact', async () => {
    const [publisher, receiver] = server.machines;
    const project = await server.createDeploymentProject();
    const environmentContent = await server.createDeploymentArtifact({
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Workflow Environment' },
        body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) });
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const create = await fetch(`${server.baseUrl}/v1/deployments/environments`, { method: 'POST', headers,
        body: JSON.stringify({ serverId: server.homeId, projectSourceId: project.projectSourceId, requestKey: randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: receiver.id, buildMachineId: publisher.id, ...environmentContent }) });
    expect(create.status).toBe(200);
    const environment = await create.json() as { ok: boolean; environmentId: string; revision: number };
    expect(environment.ok).toBe(true);
    const linked = await fetch(`${server.baseUrl}/v1/deployments/environments/${environment.environmentId}/targets`, {
        method: 'POST', headers, body: JSON.stringify({ serverId: server.homeId, environmentId: environment.environmentId,
            expectedRevision: environment.revision, requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
            machines: [{ machineId: receiver.id, installationId: receiver.installationId }], ...project.runtimeContent }) });
    expect(linked.status).toBe(200);
    const link = await linked.json() as { ok: boolean; targetLinkId: string; targetLinkRevision: number; revision: number };
    expect(link.ok).toBe(true);
    const runId = randomUUID();
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const currentness = await fetchAutomationAccountCurrentnessWitnessTx(db, server.accountId);
    if (!currentness) throw new Error('account_currentness_unavailable');
    await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId,
        accountCurrentness: currentness, origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
            sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: snapshot })) });
    await server.claim(publisher.id);
    const actionId = 'deployments.deploy';
    const target = { kind: 'machine' as const, machineId: receiver.id };
    const mint = async (input: unknown) => {
        const requestId = `${runId}/${randomUUID()}/0`;
        const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target, input });
        const origin = { runId, requestId };
        const response = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
            method: 'POST', headers, body: JSON.stringify({ v: 1, machineId: publisher.id, envelope, workflowActionOrigin: origin,
                installationProof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey, payload: {
                    version: 1, accountId: server.accountId, machineId: publisher.id, installationId: publisher.installationId,
                    externalActionOrigin: { homeId: server.homeId, actionId, requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin },
                } }) }) });
        expect(response.status).toBe(200);
        return ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
    };
    type Authorization = Awaited<ReturnType<typeof mint>>;
    const native = (root: Authorization, path: string, body: unknown) => fetch(`${server.baseUrl}${path}`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json',
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                effectActionId: actionId, target, installationId: receiver.installationId,
                requestId: root.binding.requestId, privateKey: receiver.keys.secretKey, method: 'POST', path, body }) } });
    const compactInput = { serverId: server.homeId, environmentId: environment.environmentId, requestKey: randomUUID() };
    const compact = await mint(compactInput);
    const scope = compact.binding.deploymentCandidatePublication;
    if (!scope) throw new Error('compact_candidate_slot_unavailable');
    const artifact = await native(compact, '/v1/artifacts', { id: scope.contentArtifactId,
        header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Exact compact candidate' }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
    expect(artifact.status).toBe(200);
    const candidate = await db.artifact.findUniqueOrThrow({ where: { id: scope.contentArtifactId } });
    const prepared = { ...compactInput, expectedRevision: link.revision, targetLinkId: link.targetLinkId,
        expectedTargetLinkRevision: link.targetLinkRevision, contentArtifactId: candidate.id,
        contentHeaderVersion: candidate.headerVersion, contentBodyVersion: candidate.bodyVersion };
    const reserve = async (root: Authorization, input: typeof prepared, actionOperationId: string) => {
        const response = await native(root, `/v1/deployments/environments/${environment.environmentId}/deploy`,
            { ...input, actionOperationId });
        expect(response.status).toBe(200);
        const result = DeploymentReceiptResultV1Schema.parse(await response.json());
        if (!result.ok || !('deploymentId' in result)) throw new Error(`compact_receipt_not_admitted:${JSON.stringify(result)}`);
        return result;
    };
    const transition = (root: Authorization, deploymentId: string, actionOperationId: string,
        expectedRevision: number, state: 'running' | 'failed') => {
        const body: Omit<DeploymentTransitionInputV1, 'proof'> = {
            serverId: server.homeId, environmentId: environment.environmentId, deploymentId, actionOperationId,
            expectedRevision, machineId: receiver.id, installationId: receiver.installationId,
            kind: state === 'failed' ? 'settle' : 'stage', state,
        };
        return native(root, `/v1/deployments/environments/${environment.environmentId}/deployments/${deploymentId}/transitions`,
            { ...body, proof: signMachineInstallationProof({ privateKey: receiver.keys.secretKey, payload: {
                version: 1, accountId: server.accountId, machineId: receiver.id, installationId: receiver.installationId,
                deploymentTransition: { serverId: server.homeId, environmentId: environment.environmentId,
                    deploymentId, actionOperationId, expectedRevision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) },
            } }) });
    };
    const originalOperationId = randomUUID();
    const original = await reserve(compact, prepared, originalOperationId);
    expect(await db.deployment.findUniqueOrThrow({ where: { id: original.deploymentId },
        select: { acceptedRequestEnvelopeDigest: true } })).toEqual({
        acceptedRequestEnvelopeDigest: compact.binding.requestEnvelopeDigest,
    });
    const runningResponse = await transition(compact, original.deploymentId, originalOperationId, original.deploymentRevision, 'running');
    expect(runningResponse.status).toBe(200);
    const running = DeploymentReceiptResultV1Schema.parse(await runningResponse.json());
    if (!running.ok || !('deploymentRevision' in running)) throw new Error('compact_continuation_unavailable');
    const settledResponse = await transition(compact, original.deploymentId, originalOperationId, running.deploymentRevision, 'failed');
    expect(settledResponse.status).toBe(200);
    expect(DeploymentReceiptResultV1Schema.parse(await settledResponse.json())).toMatchObject({ ok: true, state: 'failed' });
    // No fabricated receipt/capture: another exact installed root really admits
    // the same Artifact under a different request and native operation identity.
    const current = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.environmentId } });
    const siblingInput = { ...prepared, expectedRevision: current.revision, requestKey: randomUUID() };
    const siblingRoot = await mint(siblingInput);
    const siblingOperationId = randomUUID();
    const sibling = await reserve(siblingRoot, siblingInput, siblingOperationId);
    expect(sibling.deploymentId).not.toBe(original.deploymentId);
    expect(await db.deployment.findUniqueOrThrow({ where: { id: sibling.deploymentId } })).toMatchObject({
        contentArtifactId: candidate.id, actionOperationId: siblingOperationId,
        acceptedControllerMachineId: receiver.id, acceptedControllerInstallationId: receiver.installationId });
    // Keep the independent owner's positive observable even while the wrong-root
    // regression fails. The normal same-state writer also admits its exact replay.
    expect.soft((await transition(compact, sibling.deploymentId, siblingOperationId, sibling.deploymentRevision, 'running')).status).toBe(401);
    const siblingRunning = await transition(siblingRoot, sibling.deploymentId, siblingOperationId, sibling.deploymentRevision, 'running');
    expect(siblingRunning.status).toBe(200);
    const siblingRunningReceipt = DeploymentReceiptResultV1Schema.parse(await siblingRunning.json());
    expect(siblingRunningReceipt).toMatchObject({ ok: true, state: 'running' });
    if (!siblingRunningReceipt.ok || !('deploymentRevision' in siblingRunningReceipt)) throw new Error('sibling_running_unavailable');
    // A retained receipt without its original request binding still requires
    // exact custody to stage. Its captured controller can settle the interrupted slot.
    await db.deployment.update({ where: { id: sibling.deploymentId }, data: { acceptedRequestEnvelopeDigest: null } });
    expect((await transition(siblingRoot, sibling.deploymentId, siblingOperationId,
        siblingRunningReceipt.deploymentRevision, 'running')).status).toBe(401);
    const recovered = await transition(siblingRoot, sibling.deploymentId, siblingOperationId,
        siblingRunningReceipt.deploymentRevision, 'failed');
    expect(recovered.status).toBe(200);
    expect(DeploymentReceiptResultV1Schema.parse(await recovered.json())).toMatchObject({ ok: true, state: 'failed' });
}, 120_000);

it('admits installed Workflow deployment provenance at current placement without inferring receiver consent, including legacy dispatch', async () => {
    const [publisher, receiver, other] = server.machines;
    if (!server.currentness) throw new Error('account_currentness_unavailable');
    const project = await server.createDeploymentProject();
    const environmentContent = await server.createDeploymentArtifact({
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Workflow Environment' },
        body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) });
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const create = await fetch(`${server.baseUrl}/v1/deployments/environments`, { method: 'POST', headers,
        body: JSON.stringify({ serverId: server.homeId, projectSourceId: project.projectSourceId, requestKey: randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: receiver.id, buildMachineId: publisher.id, ...environmentContent }) });
    expect(create.status).toBe(200);
    const created = await create.json() as { ok: boolean; environmentId: string; revision: number };
    expect(created.ok).toBe(true);
    const link = await fetch(`${server.baseUrl}/v1/deployments/environments/${created.environmentId}/targets`, {
        method: 'POST', headers, body: JSON.stringify({ serverId: server.homeId, environmentId: created.environmentId,
            expectedRevision: created.revision, requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
            machines: [{ machineId: receiver.id, installationId: receiver.installationId }], ...project.runtimeContent }) });
    expect(link.status).toBe(200);
    const linked = await link.json() as { ok: boolean; targetLinkId: string; revision: number };
    expect(linked.ok).toBe(true);
    const actionId = 'deployments.deploy';
    const receiptContent = await server.createDeploymentArtifact({
        header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Workflow accepted receipt' }, body: '{}' });
    const childInput = { serverId: server.homeId, environmentId: created.environmentId,
        expectedRevision: linked.revision, requestKey: randomUUID(), targetLinkId: linked.targetLinkId,
        expectedTargetLinkRevision: 1, ...receiptContent };
    const semanticInput = { serverId: server.homeId, environmentId: created.environmentId,
        sha: 'a'.repeat(40), requestKey: randomUUID() };
    const explicitSemanticInput = { ...semanticInput, targetLinkId: linked.targetLinkId };
    const foreignTargetInput = { ...semanticInput, targetLinkId: randomUUID() };
    const runId = randomUUID();
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const approved: WorkflowAcceptedSnapshotV1 = { ...snapshot, approvedOperation: {
        parent: { actionId: 'deployments.deploy', input: {} }, approvedBy: { accountId: server.accountId },
        steps: [{ actionId, input: childInput }, { actionId, input: semanticInput },
            { actionId, input: explicitSemanticInput }, { actionId, input: foreignTargetInput }] } };
    const seal = (value: WorkflowAcceptedSnapshotV1 = approved) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: value }));
    await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId,
        accountCurrentness: server.currentness, origin: { kind: 'direct' }, acceptedEnvelope: seal() });
    await server.claim(publisher.id);
    const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: `${runId}/${randomUUID()}/0`,
        target: { kind: 'machine', machineId: receiver.id }, input: childInput };
    const origin = { runId, requestId: envelope.requestId! };
    const installed = (value = envelope, signer = publisher) => ({ v: 1, machineId: signer.id, envelope: value,
        workflowActionOrigin: origin, installationProof: signMachineInstallationProof({ privateKey: signer.keys.secretKey,
            payload: { version: 1, accountId: server.accountId, machineId: signer.id, installationId: signer.installationId,
                externalActionOrigin: { homeId: server.homeId, actionId, requestId: value.requestId!,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(value), origin } } }) });
    const mint = (value = envelope, signer = publisher) => fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`,
        { method: 'POST', headers, body: JSON.stringify(installed(value, signer)) });
    const response = await mint();
    expect(response.status).toBe(200);
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
    expect(authorization.binding).toMatchObject({ actionId, machineId: receiver.id,
        installationId: receiver.installationId, workflowActionOrigin: origin });
    // Semantic intent can be issued at current placement, but it carries no
    // prepared request/Artifact tuple with which to claim a stored receipt.
    const semanticResponse = await mint({ ...envelope, input: semanticInput });
    expect(semanticResponse.status).toBe(200);
    const semanticAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(await semanticResponse.json());
    expect((await mint({ ...envelope, input: explicitSemanticInput })).status).toBe(200);
    // The exact installed envelope is provenance, not a Home-decrypted approval.
    // Target-link/materialized-input and changed-input consent remain receiver-owned.
    expect((await mint({ ...envelope, input: foreignTargetInput })).status).toBe(200);
    expect((await mint({ ...envelope, input: { ...semanticInput, requestKey: randomUUID() } })).status).toBe(200);
    // A missing selected link is unavailable; an existing live link is no substitute.
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { runtimeTargetLinkId: null } });
    const missingLink = await mint({ ...envelope, input: semanticInput });
    expect(missingLink.status).toBe(403);
    expect(await missingLink.json()).toMatchObject({ error: 'credential_scope_denied' });
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { runtimeTargetLinkId: linked.targetLinkId } });
    const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
    const verifyBody = { v: 1, ...(authorization.binding.admittedMachineRole === undefined
        ? {} : { admittedMachineRole: authorization.binding.admittedMachineRole }) };
    const verify = () => fetch(`${server.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(verifyBody), headers: {
        'content-type': 'application/json', [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target!),
        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
            effectActionId: actionId, target: envelope.target!, installationId: receiver.installationId,
            requestId: envelope.requestId!, privateKey: receiver.keys.secretKey, method: 'POST', path, body: verifyBody }) } });
    expect((await verify()).status).toBe(200);
    const acceptedOperationId = randomUUID();
    const nativeRequest = (requestPath: string, body: unknown, execution = authorization) => fetch(`${server.baseUrl}${requestPath}`, {
        method: 'POST', body: JSON.stringify(body), headers: {
            'content-type': 'application/json', [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: execution.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target!),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: execution.token,
                effectActionId: actionId, target: envelope.target!, installationId: receiver.installationId,
                requestId: envelope.requestId!, privateKey: receiver.keys.secretKey,
                method: 'POST', path: requestPath, body }),
        } });
    const reserved = await nativeRequest(`/v1/deployments/environments/${created.environmentId}/deploy`,
        { ...childInput, actionOperationId: acceptedOperationId });
    expect(reserved.status).toBe(200);
    const receipt = DeploymentReceiptResultV1Schema.parse(await reserved.json());
    if (!receipt.ok || !('deploymentId' in receipt)) throw new Error('workflow_receipt_unavailable');
    expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.deploymentId } })).toMatchObject({
        acceptedControllerMachineId: receiver.id, acceptedControllerInstallationId: receiver.installationId,
        acceptedBuildMachineId: publisher.id, acceptedBuildInstallationId: publisher.installationId,
        acceptedRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest,
    });
    // Receipt admission advances the Environment revision. The issued proof
    // continues to verify against the captured receipt.
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { revision: { increment: 1 } } });
    expect((await verify()).status).toBe(200);
    // Ordered native execution selects immutable build/member history under
    // this exact admitted leaf root, not a newly minted read or Publish root.
    const historyPath = `/v1/deployments/environments/${encodeURIComponent(created.environmentId)}/deployments?serverId=${encodeURIComponent(server.homeId)}`;
    const readHistory = (requestPath = historyPath, effectActionId: 'deployments.receipts.list' | 'deployments.cancel' = 'deployments.receipts.list',
        signedPath = requestPath) => fetch(`${server.baseUrl}${requestPath}`, { headers: {
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target!),
        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
            effectActionId, target: envelope.target!, installationId: receiver.installationId,
            requestId: envelope.requestId!, privateKey: receiver.keys.secretKey, method: 'GET', path: signedPath }),
    } });
    const history = await readHistory();
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ ok: true, items: [{ id: receipt.deploymentId }] });
    // A valid signature cannot turn a list effect into a sibling operation,
    // a changed wire path cannot spend the original signature, and this read
    // exception must not authorize a different deployment mutation effect.
    const environmentPath = `/v1/deployments/environments/${encodeURIComponent(created.environmentId)}?serverId=${encodeURIComponent(server.homeId)}`;
    expect((await readHistory(environmentPath)).status).toBe(401);
    expect((await readHistory(environmentPath, 'deployments.receipts.list', historyPath)).status).toBe(401);
    expect((await readHistory(historyPath, 'deployments.cancel')).status).toBe(401);
    expect((await mint({ ...envelope, input: { ...childInput, requestKey: 'unreviewed' } })).status).toBe(200);
    // An existing Machine at the wrong placement and a missing Machine get the same refusal.
    await expectWorkflowScopeDenied(mint({ ...envelope, target: { kind: 'machine', machineId: other.id } }));
    await expectWorkflowScopeDenied(mint({ ...envelope, target: { kind: 'machine', machineId: randomUUID() } }));
    await expectWorkflowScopeDenied(mint({ ...envelope, target: { kind: 'machine', machineId: publisher.id } }));
    await expectWorkflowScopeDenied(mint(envelope, receiver));
    await db.automationRun.update({ where: { id: runId }, data: { workflowAcceptedSnapshotEnvelope: seal(snapshot) } });
    expect((await mint()).status).toBe(200);
    expect((await verify()).status).toBe(200);
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { controllerMachineId: publisher.id } });
    expect((await mint({ ...envelope, target: { kind: 'machine', machineId: publisher.id } })).status).toBe(200);
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { controllerMachineId: receiver.id } });
    await db.automationRun.update({ where: { id: runId }, data: { workflowAcceptedSnapshotEnvelope: seal() } });
    // The accepted receipt keeps its captured controller while new minting uses current placement.
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { controllerMachineId: other.id } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(200);
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { controllerMachineId: receiver.id } });
    await db.deploymentTargetLink.update({ where: { id: linked.targetLinkId }, data: { detachedAt: new Date() } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(200);
    await db.deploymentTargetLink.update({ where: { id: linked.targetLinkId }, data: { detachedAt: null } });
    const seed = process.env.HANDY_MASTER_SECRET;
    if (!seed) throw new Error('test_auth_seed_unavailable');
    const legacy = await createPersistentTokenGenerator({ service: 'handy', seed });
    const legacyToken = await legacy.new({ user: server.accountId });
    let deliveries = 0;
    server.setReceiver(receiver.id, async () => {
        deliveries++;
        return createExternalActionDaemonDispatchResponse(prepareExternalActionResponseEnvelopeV1({ v: 1, actionId,
            requestId: envelope.requestId, execution: { ok: true, result: { ok: false, error: 'deployment_unavailable' } } }));
    });
    const dispatch = (body: unknown) => fetch(`${server.baseUrl}/v1/actions/${actionId}`, { method: 'POST',
        headers: { ...headers, authorization: `Bearer ${legacyToken}` }, body: JSON.stringify(body) });
    expect((await dispatch(installed())).status).toBe(200);
    expect(deliveries).toBe(1);
    await expectWorkflowScopeDenied(dispatch(envelope));
    expect(deliveries).toBe(1);
    await db.machine.update({ where: { id: receiver.id }, data: { revokedAt: new Date() } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(401);
    await db.machine.update({ where: { id: receiver.id }, data: { revokedAt: null } });
    const foreign = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
    await db.projectSource.update({ where: { id: project.projectSourceId }, data: { owner: { kind: 'account', accountId: foreign.id } } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(200);
    await db.projectSource.update({ where: { id: project.projectSourceId }, data: { owner: { kind: 'account', accountId: server.accountId } } });
    await db.automationRunAssignment.deleteMany({ where: { runId } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(200);
    expect((await readHistory()).status).toBe(200);
    await db.automationRunAssignment.create({ data: { runId, machineId: publisher.id } });
    expect((await verify()).status).toBe(200);
    expect((await readHistory()).status).toBe(200);

    // New issuance follows the edited placement. Verification and the native
    // transition keep the controller already captured by the accepted receipt.
    const currentEnvironment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } });
    const controller = await fetch(`${server.baseUrl}/v1/deployments/environments/${created.environmentId}/controller`, {
        method: 'POST', headers, body: JSON.stringify({ serverId: server.homeId, environmentId: created.environmentId,
            expectedRevision: currentEnvironment.revision, controllerMachineId: other.id }) });
    expect(controller.status).toBe(200);
    const controllerResult = await controller.json() as { ok: boolean; revision: number };
    expect(controllerResult.ok).toBe(true);
    const builder = await fetch(`${server.baseUrl}/v1/deployments/environments/${created.environmentId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ serverId: server.homeId, environmentId: created.environmentId,
            expectedRevision: controllerResult.revision, ...environmentContent, patch: { buildMachineId: other.id } }) });
    expect(builder.status).toBe(200);
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(200);
    const stage = { serverId: server.homeId, environmentId: created.environmentId, deploymentId: receipt.deploymentId,
        actionOperationId: acceptedOperationId, expectedRevision: receipt.deploymentRevision,
        machineId: receiver.id, installationId: receiver.installationId, kind: 'stage' as const, state: 'running' as const };
    const transitionPath = `/v1/deployments/environments/${created.environmentId}/deployments/${receipt.deploymentId}/transitions`;
    const signStage = (value: Omit<DeploymentTransitionInputV1, 'proof'> = stage) => ({ ...value, proof: signMachineInstallationProof({ privateKey: receiver.keys.secretKey,
        payload: { version: 1, accountId: server.accountId, machineId: receiver.id, installationId: receiver.installationId,
            deploymentTransition: { serverId: value.serverId, environmentId: value.environmentId,
                deploymentId: value.deploymentId, actionOperationId: value.actionOperationId,
                expectedRevision: value.expectedRevision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(value) } } }) });
    const stageBody = signStage();
    const continued = await nativeRequest(transitionPath, stageBody);
    expect(continued.status).toBe(200);
    expect(DeploymentReceiptResultV1Schema.parse(await continued.json())).toMatchObject({ ok: true, state: 'running' });
    // Construct a different stored receipt with the same genuine capture, actor,
    // Environment, operation, target and Artifact. That is not this frozen leaf.
    const acceptedRow = await db.deployment.findUniqueOrThrow({ where: { id: receipt.deploymentId } });
    const sibling = await db.deployment.create({ data: { ...acceptedRow, id: randomUUID(),
        requestKey: randomUUID(), actionOperationId: randomUUID(), acceptedRequestEnvelopeDigest: null } });
    const siblingStage = { ...stage, deploymentId: sibling.id, actionOperationId: sibling.actionOperationId,
        expectedRevision: sibling.revision };
    expect((await nativeRequest(`/v1/deployments/environments/${created.environmentId}/deployments/${sibling.id}/transitions`,
        signStage(siblingStage))).status).toBe(401);
    // A separately approved semantic root cannot borrow either receipt. Without
    // the prepared-only parse, absent operands would disappear from Prisma where.
    expect((await nativeRequest(transitionPath, stageBody, semanticAuthorization)).status).toBe(401);
    expect((await nativeRequest(`/v1/deployments/environments/${created.environmentId}/deployments/${sibling.id}/transitions`,
        signStage(siblingStage), semanticAuthorization)).status).toBe(401);
    // The captured controller can replay the committed stage after Source ownership changes.
    await db.projectSource.update({ where: { id: project.projectSourceId }, data: { owner: { kind: 'account', accountId: foreign.id } } });
    const replayedStage = await nativeRequest(transitionPath, stageBody);
    expect(replayedStage.status).toBe(200);
    expect(DeploymentReceiptResultV1Schema.parse(await replayedStage.json())).toMatchObject({
        ok: true, deploymentId: receipt.deploymentId, state: 'running',
    });
    await db.projectSource.update({ where: { id: project.projectSourceId }, data: { owner: { kind: 'account', accountId: server.accountId } } });
    await db.machine.update({ where: { id: receiver.id }, data: { installationId: randomUUID() } });
    expect((await nativeRequest(transitionPath, stageBody)).status).toBe(401);
    await db.machine.update({ where: { id: receiver.id }, data: { installationId: receiver.installationId } });
    // O1: accepted work retains Run-active, not publisher-assignment admission.
    await db.automationRunAssignment.deleteMany({ where: { runId } });
    expect((await nativeRequest(transitionPath, stageBody)).status).toBe(200);
    await db.automationRunAssignment.create({ data: { runId, machineId: publisher.id } });
    expect((await nativeRequest(transitionPath, stageBody)).status).toBe(200);
    const activeRun = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
    await db.automationRun.update({ where: { id: runId }, data: { state: 'cancelled' } });
    expect((await nativeRequest(transitionPath, stageBody)).status).toBe(401);
    await db.automationRun.update({ where: { id: runId }, data: { state: activeRun.state } });
}, 120_000);

it('admits a Workflow backup run root at secret launch like the direct root, only for its own Environment and member (L11)', async () => {
    const [publisher, other] = server.machines;
    const backupEnvironment = async (createdByAccountId = server.accountId) => {
        const project = await server.createDeploymentProject();
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: project.projectSourceId, createdByAccountId,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: publisher.id, buildMachineId: publisher.id, ...project.environmentContent,
        } });
        const link = await db.deploymentTargetLink.create({ data: {
            environmentId: environment.id, createdByAccountId, role: 'runtime',
            sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed', ...project.runtimeContent,
            machines: { create: [{ machineId: publisher.id, installationId: publisher.installationId, position: 0, state: 'active' }] },
        } });
        const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            operation: 'deploy', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: createdByAccountId,
            actionOperationId: randomUUID(), acceptedControllerMachineId: publisher.id,
            acceptedControllerInstallationId: publisher.installationId, ...project.runtimeContent } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        await db.deploymentTargetLink.update({ where: { id: link.id }, data: { activeDeploymentId: receipt.id } });
        return { environment, link, receipt };
    };
    const own = await backupEnvironment();
    const sibling = await backupEnvironment();
    const actionId = DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1;
    const target = { kind: 'machine' as const, machineId: publisher.id };
    const backupInput = (scope: typeof own) => ({ serverId: server.homeId, environmentId: scope.environment.id,
        machineId: publisher.id, installationId: publisher.installationId, targetLinkId: scope.link.id,
        deploymentId: scope.receipt.id, expectedRevision: scope.environment.revision, configRevision: 1 });
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const mintDirect = async () => {
        const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: randomUUID(), target, input: backupInput(own) });
        const response = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
            method: 'POST', headers, body: JSON.stringify({ v: 1, machineId: publisher.id, envelope }) });
        expect(response.status, await response.clone().text()).toBe(200);
        return ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
    };
    const runId = randomUUID();
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const currentness = await fetchAutomationAccountCurrentnessWitnessTx(db, server.accountId);
    if (!currentness) throw new Error('account_currentness_unavailable');
    await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId,
        accountCurrentness: currentness, origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
            sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: snapshot })) });
    await server.claim(publisher.id);
    const requestWorkflowRoot = (input: ReturnType<typeof backupInput>) => {
        const requestId = `${runId}/${randomUUID()}/0`;
        const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target, input });
        const origin = { runId, requestId };
        return fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
            method: 'POST', headers, body: JSON.stringify({ v: 1, machineId: publisher.id, envelope, workflowActionOrigin: origin,
                installationProof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey, payload: {
                    version: 1, accountId: server.accountId, machineId: publisher.id, installationId: publisher.installationId,
                    externalActionOrigin: { homeId: server.homeId, actionId, requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin },
                } }) }) });
    };
    type Authorization = Awaited<ReturnType<typeof mintDirect>>;
    const launch = async (root: Authorization, scope: typeof own = own, changes: Partial<EnvironmentSecretLaunchAdmissionBodyV1> = {}) => {
        const path = `/v1/deployments/environments/${scope.environment.id}/secret-launch-admission`;
        const body: EnvironmentSecretLaunchAdmissionBodyV1 = { serverId: server.homeId, environmentId: scope.environment.id,
            targetLinkId: scope.link.id, machineId: publisher.id, installationId: publisher.installationId,
            materialization: { kind: 'deployment', deploymentId: scope.receipt.id, actionOperationId: scope.receipt.actionOperationId },
            ...changes };
        const payload = { ...body, proof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey, payload: {
            version: 1, accountId: server.accountId, machineId: publisher.id, installationId: publisher.installationId,
            deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } } }) };
        const response = await fetch(`${server.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(payload), headers: {
            'content-type': 'application/json',
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                effectActionId: actionId, target, installationId: publisher.installationId,
                requestId: root.binding.requestId, privateKey: publisher.keys.secretKey, method: 'POST', path, body: payload }) } });
        return { status: response.status, body: await response.json() as unknown };
    };
    expect(await launch(await mintDirect()), 'direct control').toMatchObject({ status: 200, body: { ok: true } });
    const minted = await requestWorkflowRoot(backupInput(own));
    expect(minted.status, await minted.clone().text()).toBe(200);
    const workflowRoot = ExternalActionExecutionAuthorizationV1Schema.parse(await minted.json());
    expect(workflowRoot.binding).toMatchObject({ workflowActionOrigin: { runId },
        deploymentNativeAdmission: { kind: 'backup', environmentId: own.environment.id, deploymentId: own.receipt.id } });
    expect(await launch(workflowRoot), 'workflow child').toMatchObject({ status: 200, body: { ok: true } });
    // The admitted root names one Environment and one installation.
    expect((await launch(workflowRoot, sibling)).status).not.toBe(200);
    expect((await launch(workflowRoot, own, { machineId: other.id, installationId: other.installationId })).status).not.toBe(200);
    // A Workflow step naming an Environment the requester can no longer deploy is refused at mint.
    const retired = await backupEnvironment();
    await db.deploymentEnvironment.update({ where: { id: retired.environment.id }, data: { deletedAt: new Date() } });
    expect((await requestWorkflowRoot(backupInput(retired))).status).toBe(403);
}, 120_000);

it('admits same-Account accepted Run placement without deciding receiver consent, with receiving installation currentness', async () => {
    const [publisher, receiver, other] = server.machines;
    if (!server.currentness) throw new Error('account_currentness_unavailable');
    const runId = randomUUID();
    const actionId = 'machines.setup.apply';
    const childInput = MachineSetupApplyInputV1Schema.parse({ homeId: server.homeId, machineId: receiver.id, targets: [{
        homeId: server.homeId, machineId: receiver.id, desiredRevision: 0, recipePlans: [],
        sources: projectManagedOpaqueSetupSourcesV1([
            { kind: 'accountPreset', presetId: 'reviewed', presetRevision: 1, contentEncryptionMode: 'plain',
                setup: { scripts: [{ body: 'echo retained', affects: 'none' }] } },
            { kind: 'direct', setup: {} },
        ]),
    }] });
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const approved = { ...snapshot, approvedOperation: { parent: { actionId: 'workflow.run.start', input: {} },
        approvedBy: { accountId: server.accountId }, steps: [{ actionId, input: childInput }] } };
    const seal = (acceptedSnapshot: WorkflowAcceptedSnapshotV1 = approved) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot }));
    await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId,
        accountCurrentness: server.currentness, origin: { kind: 'direct' }, acceptedEnvelope: seal() });
    await server.claim(publisher.id);
    const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: `${runId}/${randomUUID()}/0`,
        target: { kind: 'machine', machineId: receiver.id }, input: childInput };
    const workflowActionOrigin = { runId, requestId: envelope.requestId! };
    const installedRequest = (value = envelope, signer = publisher, requestedActionId: string = actionId) => {
        const installationProof = signMachineInstallationProof({ privateKey: signer.keys.secretKey,
            payload: { version: 1, accountId: server.accountId, machineId: signer.id, installationId: signer.installationId,
                externalActionOrigin: { homeId: server.homeId, actionId: requestedActionId, requestId: value.requestId!,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(value), origin: workflowActionOrigin } } });
        return { v: 1, machineId: signer.id, envelope: value, workflowActionOrigin, installationProof };
    };
    const mint = (value = envelope, signer = publisher, requestedActionId: string = actionId) => {
        return fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(requestedActionId)}`, { method: 'POST',
            headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(installedRequest(value, signer, requestedActionId)) });
    };
    const response = await mint();
    if (response.status !== 200) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(installedRequest());
        const digest = computeExternalActionRequestEnvelopeDigestV1(envelope);
        const run = await db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { state: true, workflowCustodyState: true } });
        // Diagnostics carry reason facts only, never tokens, keys or request contents.
        const diagnostic = { state: run.state, custody: run.workflowCustodyState,
            accountHttpStatus: (await fetch(`${server.baseUrl}/v1/account/encryption`, { headers: { authorization: `Bearer ${server.token}` } })).status,
            normalizationMatches: digest === computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            signatureMatches: verifyMachineInstallationProof({ publicKey: publisher.keys.publicKey, proof: request.installationProof!,
                payload: { version: 1, accountId: server.accountId, machineId: publisher.id, installationId: publisher.installationId,
                    externalActionOrigin: { homeId: server.homeId, actionId, requestId: envelope.requestId!, requestEnvelopeDigest: digest, origin: workflowActionOrigin } } }),
            publisherCurrent: await isAutomationOriginRunPublisherTx(db, { accountId: server.accountId, machineId: publisher.id,
                runId, requireCurrentScopeEnd: true }),
            originCurrent: await hasCurrentExternalActionWorkflowOriginInTx(db, { accountId: server.accountId, machineId: publisher.id,
                publisherMachineId: publisher.id, actionId, requestId: envelope.requestId!, target: envelope.target!,
                requestEnvelopeDigest: digest, workflowActionOrigin }),
        };
        expect(response.status, JSON.stringify(diagnostic)).toBe(200);
    }
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
    expect(authorization.binding).toMatchObject({ machineId: receiver.id, installationId: receiver.installationId,
        custodianAccountId: server.accountId, target: envelope.target, workflowActionOrigin });
    const seed = process.env.HANDY_MASTER_SECRET;
    if (!seed) throw new Error('test_auth_seed_unavailable');
    // The real legacy issuer's service/shape, accepted by the existing Home verifier.
    // This generated fixture contains neither a provenance marker nor an epoch.
    const legacyIssuer = await createPersistentTokenGenerator({ service: 'handy', seed });
    const legacyToken = await legacyIssuer.new({ user: server.accountId });
    expect((await fetch(`${server.baseUrl}/v1/account/encryption`, { headers: { authorization: `Bearer ${legacyToken}` } })).status).toBe(200);
    let deliveries = 0;
    server.setReceiver(receiver.id, async packet => {
        deliveries++;
        expect(packet.executionAuthorization?.binding).toMatchObject({ machineId: receiver.id,
            installationId: receiver.installationId, workflowActionOrigin });
        return createExternalActionDaemonDispatchResponse(prepareExternalActionResponseEnvelopeV1({ v: 1, actionId,
            requestId: envelope.requestId, execution: { ok: true, result: { operationId: randomUUID() } } }));
    });
    const legacyDispatch = await fetch(`${server.baseUrl}/v1/actions/${actionId}`, { method: 'POST',
        headers: { authorization: `Bearer ${legacyToken}`, 'content-type': 'application/json' }, body: JSON.stringify(installedRequest()) });
    expect(legacyDispatch.status).toBe(200);
    expect(deliveries).toBe(1);
    const unsignedLegacy = await fetch(`${server.baseUrl}/v1/actions/${actionId}`, { method: 'POST',
        headers: { authorization: `Bearer ${legacyToken}`, 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
    expect(unsignedLegacy.status).toBe(403);
    expect(await unsignedLegacy.json()).toMatchObject({ error: 'credential_scope_denied' });
    expect(deliveries).toBe(1);
    const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
    const verifyBody = { v: 1, ...(authorization.binding.admittedMachineRole === undefined
        ? {} : { admittedMachineRole: authorization.binding.admittedMachineRole }) };
    const verify = () => fetch(`${server.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(verifyBody),
        headers: { 'content-type': 'application/json',
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target!),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: actionId, target: envelope.target!, installationId: receiver.installationId,
                requestId: envelope.requestId!, privateKey: receiver.keys.secretKey, method: 'POST', path, body: verifyBody }) } });
    expect((await verify()).status).toBe(200);
    expect((await mint({ ...envelope, target: { kind: 'machine', machineId: publisher.id },
        input: { ...childInput, machineId: publisher.id } })).status).toBe(200);
    // Home admits provenance, not child consent. The receiving approved-operation
    // reader owns exact Action/input matching, including stricter child policy.
    expect((await mint({ ...envelope, input: { ...childInput, targets: childInput.targets.map(target => ({ ...target,
        sources: target.sources.map(source => source.kind === 'accountPresetOpaque'
            ? { ...source, presetRevision: 2 } : source) })) } })).status).toBe(200);
    expect((await mint({ ...envelope, target: { kind: 'machine', machineId: other.id } })).status).toBe(200);
    await expectWorkflowScopeDenied(mint(envelope, receiver));
    const setEnvelope = async (raw: string) => { await db.automationRun.update({ where: { id: runId }, data: { workflowAcceptedSnapshotEnvelope: raw } }); };
    await setEnvelope(seal(snapshot));
    expect((await mint()).status).toBe(200);
    expect((await verify()).status).toBe(200);
    await setEnvelope(seal());
    for (const data of [{ state: 'failed' }, { workflowCustodyState: 'settled' }] as const) {
        await db.automationRun.update({ where: { id: runId }, data });
        await expectWorkflowScopeDenied(mint());
        expect((await verify()).status).toBe(401);
        await db.automationRun.update({ where: { id: runId }, data: { state: 'claimed', workflowCustodyState: 'pending' } });
    }
    const foreign = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
    // Even a shared recipient is not same-Account standing authority.
    await db.machine.update({ where: { id: receiver.id }, data: { accountId: foreign.id } });
    const team = await db.team.create({ data: { name: 'Shared receiver' } });
    await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: foreign.id, role: 'owner' },
        { teamId: team.id, accountId: server.accountId, role: 'member' }] });
    await db.machineGrant.create({ data: { principalKind: 'team', machineId: receiver.id, teamId: team.id,
        accessLevel: 'admin', createdByAccountId: foreign.id } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(401);
    await db.machine.update({ where: { id: receiver.id }, data: { accountId: server.accountId } });
    await db.machine.update({ where: { id: receiver.id }, data: { revokedAt: new Date() } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(401);
    await db.machine.update({ where: { id: receiver.id }, data: { revokedAt: null } });
    // Publisher and credential changes stop fresh admission. The issued Setup
    // proof spends the active Run's retained authority on the same receiver.
    await db.machine.update({ where: { id: publisher.id }, data: { revokedAt: new Date() } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(200);
    await db.machine.update({ where: { id: publisher.id }, data: { revokedAt: null } });
    await db.automationRunAssignment.deleteMany({ where: { runId } });
    await expectWorkflowScopeDenied(mint());
    expect((await verify()).status).toBe(200);
    await db.automationRunAssignment.create({ data: { runId, machineId: publisher.id } });
    await server.revokeAccount();
    expect((await mint()).status).toBe(401);
    expect((await verify()).status).toBe(200);
}, 120_000);
