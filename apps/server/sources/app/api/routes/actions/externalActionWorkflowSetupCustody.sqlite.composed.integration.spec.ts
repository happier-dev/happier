import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol';
import { randomBytes, randomUUID } from 'node:crypto';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionResponseEnvelopeV1Schema, ExternalActionHttpErrorSchema, createExternalActionDaemonDispatchResponse, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { admitWorkflowRun } from '@/app/workflows/workflowRunService';
import { db } from '@/storage/db';
import { createMachineDataEncryptionKeyV1, decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { openExternalActionResponseV2, prepareExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import tweetnacl from 'tweetnacl';
import { fetchAutomationAccountCurrentnessWitnessTx } from '@/app/automations/automationAccountCurrentness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { dispatchOriginalAccountAction } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createDockerEngineSetupSteps, createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { auth } from '@/app/auth/auth';
import { DeploymentEnvironmentCreateIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createCliActionDeps } from '../../../../../../cli/src/session/actions/createCliActionDeps';
import { buildWorkflowActionContext } from '../../../../../../cli/src/daemon/workflows/workflowActionContext';
import { startWorkflowSharedMachineServer } from '@/testkit/workflowSharedMachineServer.testkit';
import { inTx } from '@/storage/inTx';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { readCurrentMachineWorkflowOriginInTx } from '@/app/auth/deploymentWorkflowOrigin';

let server: Awaited<ReturnType<typeof startWorkflowSharedMachineServer>>;
beforeAll(async () => { server = await startWorkflowSharedMachineServer(); }, 120_000);
afterAll(async () => { if (server) await server.close(); });

it.each([
    { intent: 'setup-e2ee', remote: false, denyRemote: false }, { intent: 'setup-plain', remote: false, denyRemote: false },
    { intent: 'setup-e2ee', remote: true, denyRemote: false }, { intent: 'setup-plain', remote: true, denyRemote: false },
    { intent: 'setup-plain', remote: true, denyRemote: true },
] as const)('keeps installed Workflow Setup requester custody through real Home ($intent, remote=$remote, denyRemote=$denyRemote)', async ({ intent, remote, denyRemote }) => {
    const [, receiver] = server.machines;
    const publisher = remote ? server.machines[0] : receiver;
    const actionId = 'machines.setup.apply';
    const parentRequestId = randomUUID();
    const runId = deriveMachineSetupCombinedRunIdV1({ homeId: server.homeId,
        accountId: server.accountId, requestId: parentRequestId });
    const selection = { ref: { pluginId: 'happier.machine.recipes', recipeId: 'docker-engine', revision: '1' }, inputs: {} };
    const steps = createDockerEngineSetupSteps({ distribution: 'ubuntu', daemonUsername: 'happier', enginePresent: false });
    const setupInput = MachineSetupApplyInputV1Schema.parse({ homeId: server.homeId, machineId: receiver.id, targets: [{
        homeId: server.homeId, machineId: receiver.id, desiredRevision: 0,
        recipePlans: intent === 'setup-plain' ? [] : [{ sourceIndex: 0, itemIndex: 0, plan: createMachineSetupEffectPlan({
            basis: { kind: 'setup', machineId: receiver.id, desiredRevision: 0, selection }, steps,
            nativeFacts: steps.map(step => ({ stepId: step.id, status: 'drifted', facts: {} })),
        }) }], sources: [{ kind: 'direct', setup: { items: intent === 'setup-plain' ? [] : [{ kind: 'softwareRecipe', selection }] } }],
    }] });
    const combinedInput = remote ? MachineSetupApplyInputV1Schema.parse({ ...setupInput, machineId: publisher.id,
        targets: [{ ...setupInput.targets[0], machineId: publisher.id }, ...setupInput.targets] }) : setupInput;
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const accepted = snapshot;
    const secret = new Uint8Array(32).fill(7);
    const material = { type: 'dataKey' as const, machineKey: secret };
    const contentBinding = createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(secret).publicKey);
    const mode = intent === 'setup-e2ee' ? 'e2ee' : 'plain';
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
        let parent: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
        {
            const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding: { serverIdentityId: server.homeId, accountId: server.accountId,
                    authentication: { kind: 'account', tokenEpoch: server.tokenEpoch }, actionId, requestId: parentRequestId,
                    target: { kind: 'machine', machineId: publisher.id } }, input: combinedInput, material,
                randomBytes: length => new Uint8Array(randomBytes(length)) }) : ExternalActionRequestEnvelopeSchema.parse({
                    v: 1, requestId: parentRequestId, target: { kind: 'machine', machineId: publisher.id }, input: combinedInput });
            if (denyRemote) {
                const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
                const before = await db.machine.findMany({ where: { id: { in: [publisher.id, receiver.id] } },
                    orderBy: { id: 'asc' }, select: { id: true, metadata: true } });
                await db.machine.update({ where: { id: receiver.id }, data: { accountId: foreign.id } });
                try {
                    const refused = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
                        method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
                        body: JSON.stringify({ v: 1, machineId: publisher.id, envelope }),
                    });
                    expect(refused.status).toBe(403);
                    expect(await db.automationRun.findUnique({ where: { id: runId } })).toBeNull();
                    expect(await db.machine.findMany({ where: { id: { in: [publisher.id, receiver.id] } },
                        orderBy: { id: 'asc' }, select: { id: true, metadata: true } })).toEqual(before);
                } finally {
                    await db.machine.update({ where: { id: receiver.id }, data: { accountId: server.accountId } });
                }
                return;
            }
            const response = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
                method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ v: 1, machineId: publisher.id, envelope }),
            });
            expect(response.status).toBe(200);
            parent = ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
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
        if (!remote) {
            const unlisted = server.machines[0];
            const requestId = `${runId}/${randomUUID()}/0`;
            // Keeping the envelope target admitted must not broaden the child scope.
            for (const broadenScope of [false, true]) {
                const target = { kind: 'machine' as const, machineId: broadenScope ? receiver.id : unlisted.id };
                const extra = { ...setupInput.targets[0], machineId: unlisted.id };
                const input = MachineSetupApplyInputV1Schema.parse({ ...setupInput, machineId: target.machineId,
                    targets: broadenScope ? [...setupInput.targets, extra] : [extra] });
                const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                    binding: { serverIdentityId: server.homeId, accountId: server.accountId,
                        authentication: { kind: 'account', tokenEpoch: server.tokenEpoch }, actionId, requestId, target },
                    input, material, randomBytes: length => new Uint8Array(randomBytes(length)) })
                    : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target, input });
                const origin = { runId, requestId };
                const denied = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
                    method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ v: 1, machineId: publisher.id, envelope, workflowActionOrigin: origin,
                        executionAuthorization: parent, installationProof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey,
                            payload: { version: 1, accountId: server.accountId, machineId: publisher.id,
                                installationId: publisher.installationId, externalActionOrigin: { homeId: server.homeId, actionId,
                                    requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) }),
                });
                expect(denied.status, `broadenScope=${broadenScope}`).toBe(403);
            }
        }
        const requestId = `${runId}/${randomUUID()}/0`;
        const target = { kind: 'machine' as const, machineId: receiver.id };
        const input = setupInput;
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: {
            serverIdentityId: server.homeId, accountId: server.accountId, authentication: { kind: 'account', tokenEpoch: server.tokenEpoch },
            actionId, requestId, target }, input, material, randomBytes: length => new Uint8Array(randomBytes(length)) })
            : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target, input });
        const workflowActionOrigin = { runId, requestId };
        const request = { v: 1, machineId: publisher.id, envelope, workflowActionOrigin,
            ...(parent ? { executionAuthorization: parent } : {}),
            installationProof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey, payload: {
                version: 1, accountId: server.accountId, machineId: publisher.id, installationId: publisher.installationId,
                externalActionOrigin: { homeId: server.homeId, actionId, requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: workflowActionOrigin },
            } }) };
        const response = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
            method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(request),
        });
        let refusalCode: string | undefined;
        if (!response.ok) {
            const failure = ExternalActionHttpErrorSchema.safeParse(await response.clone().json());
            refusalCode = failure.success ? 'code' in failure.data ? failure.data.code : failure.data.error : 'unrecognized_http_error';
        }
        expect(response.status, refusalCode).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
        expect(authorization.binding).toMatchObject({ machineId: receiver.id, installationId: receiver.installationId,
            workflowActionOrigin, accountEncryptionMode: mode });
        {
            const operationId = randomUUID();
            const binding = { serverIdentityId: server.homeId, accountId: server.accountId,
                authentication: { kind: 'account' as const, tokenEpoch: server.tokenEpoch }, actionId, requestId, target };
            // Only delivery is replaced; HTTP authentication, placement and mint stay real.
            server.setReceiver(receiver.id, async () => createExternalActionDaemonDispatchResponse(envelope.v === 2
                ? prepareExternalActionResponseV2({ binding, request: envelope, material,
                    randomBytes: length => new Uint8Array(randomBytes(length)), executedMachineId: receiver.id,
                    execution: { ok: true, result: { operationId } } })
                : prepareExternalActionResponseEnvelopeV1({ v: 1, actionId, requestId, execution: { ok: true, result: { operationId } } })));
            const dispatched = await fetch(`${server.baseUrl}/v1/actions/${actionId}`, {
                method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
                body: JSON.stringify(request),
            });
            expect(dispatched.status).toBe(200);
            const dispatchedResult: unknown = await dispatched.json();
            expect(envelope.v === 2 ? openExternalActionResponseV2({ envelope: dispatchedResult, binding, request: envelope, material })
                : ExternalActionResponseEnvelopeV1Schema.parse(dispatchedResult).execution)
                .toMatchObject({ ok: true, result: { operationId } });
            if (!parent || !('authentication' in parent.binding)) throw new Error('setup_parent_authorization_unavailable');
            const parentAuthentication = parent.binding.authentication;
            const publisherToken = await auth.createToken(server.accountId, undefined, { kind: 'terminal', authority: 'account_automation' });
            let invocationCodec = false;
            let deliveries = 0;
            server.setReceiver(receiver.id, async packet => {
                deliveries++;
                const recipient = { authorization: packet.executionAuthorization,
                    machineId: receiver.id, installationId: receiver.installationId,
                    serverIdentityId: server.homeId, installationPrivateKey: receiver.keys.secretKey };
                const codec = openManagedControllerActionCodecV1(recipient);
                invocationCodec = codec !== null;
                expect(openExternalActionRequesterAccountContextV1({ ...recipient,
                    purpose: { kind: 'external_action' } })).toBeNull();
                if (!codec) throw new Error('setup_invocation_codec_unavailable');
                expect(codec.machineKey).not.toEqual(material.machineKey);
                expect(packet.executionAuthorization?.binding).toMatchObject({ authentication: parentAuthentication });
                return createExternalActionDaemonDispatchResponse(packet.envelope.v === 2 ? prepareExternalActionResponseV2({ binding,
                    request: packet.envelope, material: codec, randomBytes: length => new Uint8Array(randomBytes(length)),
                    executedMachineId: receiver.id, execution: { ok: true, result: { operationId } } })
                    : prepareExternalActionResponseEnvelopeV1({ v: 1, actionId, requestId,
                        execution: { ok: true, result: { operationId } } }));
            });
            const dispatchInput = { actionId, input, requestId, target,
                credentials: { token: publisherToken, encryption: mode === 'e2ee' ? { ...material, publicKey: contentBinding.contentPublicKey } : null }, serverHttpBaseUrl: server.baseUrl,
                serverIdentityId: server.homeId, authority: 'account_automation', installedWorkflow: {
                    machineId: publisher.id, installationId: publisher.installationId, privateKey: publisher.keys.secretKey,
                    context: { executionRunWorkflowRunId: runId, actionRequestId: requestId,
                        actionCaller: { kind: 'workflowRun', runId, authorization: { ...accepted.authorization,
                            externalActionExecutionAuthorization: parent } } },
                } } satisfies Parameters<typeof dispatchOriginalAccountAction>[0];
            const delivered = await dispatchOriginalAccountAction(dispatchInput);
            expect(delivered, delivered?.ok ? undefined : JSON.stringify({ errorCode: delivered?.errorCode,
                requests: server.readRequestCosts().slice(-8) })).toMatchObject({ ok: true, result: { operationId } });
            expect(invocationCodec).toBe(true);
            const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
            const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'terminal', authority: 'account_automation' });
            expect(await dispatchOriginalAccountAction({ ...dispatchInput,
                credentials: { ...dispatchInput.credentials, token: foreignToken } })).toMatchObject({
                    ok: false, errorCode: 'admission_unavailable',
                });
            expect(deliveries).toBe(1);
        }
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

it('keeps installed Workflow Setup admission after the selected receiver grant is withdrawn', async () => {
    const [publisher, receiver] = server.machines;
    const accountId = server.guest.accountId;
    for (const machine of [publisher, receiver]) expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
        actorAccountId: server.custodianAccountId, machineId: machine.id,
        principal: { kind: 'account', accountId }, level: 'admin',
    }))).toMatchObject({ kind: 'saved' });
    const actionId = 'machines.setup.apply';
    const parentRequestId = randomUUID();
    const runId = deriveMachineSetupCombinedRunIdV1({ homeId: server.homeId, accountId, requestId: parentRequestId });
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: server.homeId, machineId: publisher.id,
        targets: [publisher, receiver].map(machine => ({ homeId: server.homeId, machineId: machine.id,
            desiredRevision: 0, recipePlans: [], sources: [{ kind: 'direct', setup: { items: [] } }] })) });
    const parentEnvelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: parentRequestId,
        target: { kind: 'machine', machineId: publisher.id }, input });
    const parentResponse = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
        method: 'POST', headers: { authorization: `Bearer ${server.guest.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, machineId: publisher.id, envelope: parentEnvelope }),
    });
    expect(parentResponse.status).toBe(200);
    const parent = ExternalActionExecutionAuthorizationV1Schema.parse(await parentResponse.json());
    const snapshot = await server.materialize({ version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
        document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] }, publisher.id);
    await admitWorkflowRun({ accountId, machineId: publisher.id, runId, accountCurrentness: server.guest.currentness,
        origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: snapshot,
        })) });
    expect(await server.claimGuestRun(publisher.id)).toMatchObject({ runId });
    expect(await server.revokeGuest(receiver.id)).toMatchObject({ kind: 'removed', effectiveAccess: 'none' });
    const requestId = `${runId}/${randomUUID()}/0`;
    const target = { kind: 'machine' as const, machineId: receiver.id };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target,
        input: { ...input, machineId: receiver.id, targets: [input.targets[1]] } });
    const origin = { runId, requestId };
    const response = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
        method: 'POST', headers: { authorization: `Bearer ${server.guest.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, machineId: publisher.id, envelope, workflowActionOrigin: origin,
            executionAuthorization: parent, installationProof: signMachineInstallationProof({ privateKey: publisher.keys.secretKey,
                payload: { version: 1, accountId, machineId: publisher.id, installationId: publisher.installationId,
                    externalActionOrigin: { homeId: server.homeId, actionId, requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) }),
    });
    expect(response.status).toBe(200);
    const child = ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
    expect(child.binding).toMatchObject({ accountId, custodianAccountId: server.custodianAccountId,
        machineId: receiver.id, deploymentPreparationAdmission: { operation: 'setup', machineTargets: [receiver.id] } });
}, 120_000);

it.each(['cold', 'retained'] as const)('routes the installed Workflow preview Create before mint (%s)', async placement => {
    const [publisher, retainedController] = server.machines;
    const project = await server.createDeploymentProject();
    const template = await db.deploymentEnvironment.create({ data: {
        projectSourceId: project.projectSourceId, createdByAccountId: server.accountId,
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        controllerMachineId: publisher.id, buildMachineId: publisher.id, ...project.environmentContent,
    } });
    const originalRuntime = await db.deploymentTargetLink.create({ data: {
        environmentId: template.id, createdByAccountId: server.accountId, role: 'runtime', state: 'configured',
        sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', ...project.runtimeContent,
        machines: { create: [{ machineId: publisher.id, installationId: publisher.installationId, position: 0, state: 'active' }] },
    } });
    await db.deploymentEnvironment.update({ where: { id: template.id }, data: { runtimeTargetLinkId: originalRuntime.id } });
    if (placement === 'retained') await db.deploymentEnvironment.create({ data: {
        projectSourceId: project.projectSourceId, createdByAccountId: server.accountId,
        protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
        controllerMachineId: retainedController.id, buildMachineId: retainedController.id,
        previewTemplateEnvironmentId: template.id, previewRepositoryId: project.projectSourceId,
        previewPullRequestId: '17', previewTargetLinkId: originalRuntime.id, ...project.environmentContent,
    } });
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/publish-host' };
    const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: server.homeId,
        projectSourceId: project.projectSourceId, requestKey: randomUUID(), name: 'pr-17', mode: 'apply',
        protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers', preview: {
            templateEnvironmentId: template.id, expectedTemplateRevision: template.revision,
            runtimeTargetLinkId: originalRuntime.id, pullRequestId: '17', headSha: 'a'.repeat(40), provenance: {
                v: 1, templateEnvironmentId: template.id, runtimeTargetLinkId: originalRuntime.id, repository,
                headRepository: { ...repository, repository: 'contributor/publish-host' }, pullRequestId: '17', pullRequestNumber: 17,
                author: { id: 'contributor', login: 'contributor' },
            },
        } });
    const runId = randomUUID();
    const accepted = await materializeWorkflowAcceptedSnapshotFixture({
        effects: { readActionContract: async () => freezeWorkflowActionContractV1(
            actionSpecToActionDefinitionV1(getActionSpec('deployments.environments.create'))) },
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'preview',
            actionId: 'deployments.environments.create', input: Object.fromEntries(Object.entries(input)
                .map(([key, value]) => [key, { kind: 'literal' as const, value }])) }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(db, server.accountId);
    if (!accountCurrentness) throw new Error('account_currentness_unavailable');
    await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId, accountCurrentness,
        origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
            sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: accepted })) });
    await server.claim(publisher.id);
    const requestId = `${runId}/${randomUUID()}/0`;
    const target = placement === 'retained' ? retainedController : publisher;
    const originalEnvelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId,
        target: { kind: 'machine', machineId: target.id }, input });
    expect(await readCurrentMachineWorkflowOriginInTx(db, { accountId: server.accountId,
        machineId: publisher.id, requestId, target: { kind: 'machine', machineId: target.id },
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalEnvelope),
        workflowActionOrigin: { runId, requestId } })).toMatchObject({
        accountId: server.accountId, installationId: target.installationId,
    });
    const deliveries: string[] = [];
    const deliveredBindings: unknown[] = [];
    for (const machine of server.machines) server.setReceiver(machine.id, async packet => {
        deliveries.push(machine.id);
        const binding = packet.executionAuthorization?.binding;
        deliveredBindings.push({ inputMatches: packet.envelope.v === 1
                && sameStrictJsonValue(packet.envelope.input, input, { omitUndefinedObjectMembers: true }),
            accountId: binding?.accountId, machineId: binding?.machineId,
            workflowActionOrigin: binding?.workflowActionOrigin,
            authenticationKind: binding?.authentication.kind });
        // Only daemon delivery is substituted. The real accepted Run, installed
        // publisher proof, requester mint and original envelope reach Home.
        return createExternalActionDaemonDispatchResponse(prepareExternalActionResponseEnvelopeV1({
            v: 1, actionId: 'deployments.environments.create', requestId,
            execution: { ok: false, errorCode: 'deployment_access_denied', error: 'deployment_access_denied' },
        }));
    });
    const token = await auth.createToken(server.accountId, undefined, { kind: 'terminal', authority: 'account_automation' });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
        serverId: server.homeId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        externalActionMachineRequestPrivateKey: publisher.keys.secretKey,
        externalActionMachineInstallationId: publisher.installationId,
        machineActionDirectTargetTransport: { machineId: publisher.id, invoke: async () => {
            throw new Error('Preview Create must dispatch its original Account Action');
        } } });
    const result = await deps.deploymentAction!('deployments.environments.create', input, {
        ...buildWorkflowActionContext({ runId, authorization: accepted.authorization }), actionRequestId: requestId,
    });
    expect(result, JSON.stringify({ code: 'errorCode' in result ? result.errorCode : undefined,
        requests: server.readRequestCosts().slice(-8), deliveredBindings, expectedPublisherMachineId: publisher.id,
        expectedTargetMachineId: target.id, expectedEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalEnvelope) }))
      .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    expect(deliveries).toEqual([target.id]);
    expect(deliveredBindings).toEqual([{ inputMatches: true, accountId: server.accountId,
        machineId: target.id, workflowActionOrigin: { runId, requestId },
        authenticationKind: 'terminal' }]);
}, 120_000);
