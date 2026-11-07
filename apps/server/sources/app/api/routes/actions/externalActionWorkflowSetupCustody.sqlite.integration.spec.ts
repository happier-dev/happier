import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionResponseEnvelopeV1Schema, ExternalActionHttpErrorSchema, createExternalActionDaemonDispatchResponse, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { startWorkflowApprovedOperationServer } from '@/testkit/workflowApprovedOperationServer.testkit';
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

let server: Awaited<ReturnType<typeof startWorkflowApprovedOperationServer>>;
beforeAll(async () => { server = await startWorkflowApprovedOperationServer(); }, 120_000);
afterAll(async () => { if (server) await server.close(); });

it.each(['setup-e2ee', 'setup-plain'] as const)('keeps installed Workflow Setup requester custody through real Home (%s)', async intent => {
    const [, receiver] = server.machines;
    // Combined Setup runs on the selected target Machine.
    const publisher = receiver;
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
                    target: { kind: 'machine', machineId: publisher.id } }, input: setupInput, material,
                randomBytes: length => new Uint8Array(randomBytes(length)) }) : ExternalActionRequestEnvelopeSchema.parse({
                    v: 1, requestId: parentRequestId, target: { kind: 'machine', machineId: publisher.id }, input: setupInput });
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
            expect(delivered, delivered?.ok ? undefined : delivered?.errorCode).toMatchObject({ ok: true, result: { operationId } });
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
