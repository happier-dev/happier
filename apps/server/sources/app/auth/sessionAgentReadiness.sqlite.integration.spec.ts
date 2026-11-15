import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { encodeExternalActionResolvedTargetV1, encodeReviewedActionChildHttpProofV1,
    signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
    type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSignedDiscussionHttpFixture } from '@/app/api/routes/actions/discussionExecutionAuthorization.testkit';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { verifyExternalActionMachineRpcExecution } from './externalActionExecutionAuthorization';
import { auth } from './auth';

describe('signed Session Agent readiness children', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-agent-readiness-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('spends exact reviewed readiness children on the selected installation with requester Use access', async () => {
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, custodian.id, { machineReads: true });
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true, operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ requesterExecutionIsolation: { protocolVersions: [1] },
                    externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id }, level: 'view' }));
            const rootInput = { executionTarget: { serverId: await getOrCreateServerIdentityId(), machineId: f.machine.id },
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
            const root = await f.mint('session.spawn_new', rootInput, true);
            const custodianToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            expect(root.binding.admittedMachineRole).toBe('use');
            const definitions = SESSION_AGENT_READINESS_CHILDREN_V1;
            const children = [
                { ...definitions.inventory, method: RPC_METHODS.CAPABILITIES_DETECT, input: { machineId: f.machine.id, agentId: 'codex', refresh: true } },
                { ...definitions.acquire, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START, input: { machineId: f.machine.id, agentId: 'codex', intent: 'install' } },
                { ...definitions.status, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, input: { machineId: f.machine.id, jobId: randomUUID(), waitForTerminal: true } },
            ];
            for (const child of children) {
                const reviewedChild = { actionId: child.action, role: child.role,
                    inputDigest: computeActionInputApprovalDigestV1(child.action, child.input) };
                // Home verifies opaque child bytes without opening E2EE content;
                // the installed receiver owns the reviewed-input digest check.
                const verify = (options: { reviewedChild?: ReviewedActionChildHttpProofV1; method?: string; signature?: string;
                    installationId?: string; params?: unknown } = {}) => {
                    const method = options.method ?? `${f.machine.id}:${child.method}`;
                    const params = options.params ?? 'opaque-child-input';
                    const installationId = options.installationId ?? f.machine.installationId!;
                    const requestId = randomUUID();
                    const signed = { authorizationToken: root.token, effectActionId: child.action, target: root.binding.target,
                        installationId, requestId, method, params, ...(options.reviewedChild ? { reviewedChild: options.reviewedChild } : {}) };
                    return verifyExternalActionMachineRpcExecution({ v: 1, authorization: root, effectActionId: child.action,
                        target: root.binding.target, installationId, ...(options.reviewedChild ? { reviewedChild: options.reviewedChild } : {}),
                        machineSignature: options.signature ?? signExternalActionMachineRpcRequestV1({ ...signed, privateKey: f.keyPair.secretKey }) },
                    { method, requestId, params });
                };
                const admitted = await verify({ reviewedChild });
                expect(admitted).toMatchObject({ effectActionId: child.action,
                    binding: { actionId: 'session.spawn_new', admittedMachineRole: 'use' },
                    sessionAgentReadinessAdmission: { role: 'use' } });
                if (!admitted?.sessionAgentReadinessAdmission) throw new Error('Expected the child machine admission');
                const { kind: _kind, ...context } = admitted.sessionAgentReadinessAdmission;
                const method = `${f.machine.id}:${child.method}`;
                const requestId = randomUUID();
                const params = 'opaque-child-input';
                const workspaceSyncSourceExecution = { method, requestId, params,
                    originalActionEnvelope: { v: 1 as const, requestId: root.binding.requestId, target: root.binding.target, input: rootInput },
                    externalActionExecution: { v: 1 as const, authorization: root, effectActionId: child.action, target: root.binding.target,
                        installationId: f.machine.installationId!, reviewedChild,
                        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: child.action,
                            target: root.binding.target, installationId: f.machine.installationId!, reviewedChild, method, requestId, params,
                            privateKey: f.keyPair.secretKey }) } };
                const receive = (receiverContext = context, source = workspaceSyncSourceExecution) => {
                    const proof = signMachineInstallationProof({ payload: { version: 1, machineId: f.machine.id,
                        installationId: f.machine.installationId!, accountId: custodian.id,
                        rpcAdmission: { context: receiverContext, method, callerInputAuthorization: root, workspaceSyncSourceExecution: source } },
                        privateKey: f.keyPair.secretKey });
                    return f.app.inject({ method: 'POST', url: `/v1/machines/${f.machine.id}/admission/verify`,
                        headers: { authorization: `Bearer ${custodianToken}`, 'x-happier-account-stored-content-protocol': '2' },
                        payload: { v: 1, context: receiverContext, method, callerInputAuthorization: root, workspaceSyncSourceExecution: source, proof } });
                };
                const received = await receive();
                expect(received.statusCode, received.body).toBe(200);
                if (child.action === definitions.inventory.action) {
                    expect((await receive(context, { ...workspaceSyncSourceExecution, originalActionEnvelope: {
                        ...workspaceSyncSourceExecution.originalActionEnvelope, input: { ...rootInput,
                            directory: { kind: 'path', path: '/different-root' } } } })).statusCode).toBe(403);
                }
                if (child.action === definitions.inventory.action) {
                    await expect(verify({ reviewedChild,
                        method: `${f.machine.id}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}` }))
                        .resolves.toMatchObject({ effectActionId: child.action });
                }
                await expect(verify({ reviewedChild, method: `${f.machine.id}:${RPC_METHODS.BASH}` })).resolves.toBeNull();
                await expect(verify()).resolves.toBeNull();
                await expect(verify({ reviewedChild: { ...reviewedChild, role: 'unreviewed' } })).resolves.toBeNull();
                await expect(verify({ reviewedChild, method: `${randomUUID()}:${child.method}` })).resolves.toBeNull();
                await expect(verify({ reviewedChild, installationId: randomUUID() })).resolves.toBeNull();
                await expect(verify({ reviewedChild, signature: 'A'.repeat(86) })).resolves.toBeNull();
                await expect(f.verify(root, { method: 'GET', path: `/v1/machines/${f.machine.id}`, reviewedChild }, child.action))
                    .resolves.toMatchObject({ effectActionId: child.action });
                const path = `/v1/machines/${f.machine.id}`;
                const response = await f.app.inject({ method: 'GET', url: path, headers: {
                    'x-happier-account-stored-content-protocol': '2',
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: child.action,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        installationId: f.machine.installationId!, requestId: root.binding.requestId, target: root.binding.target,
                        effectActionId: child.action, reviewedChild, method: 'GET', path, privateKey: f.keyPair.secretKey }),
                } });
                expect(response.statusCode, response.body).toBe(200);
                await expect(f.verify(root, { method: 'GET', path: `/v1/machines/${randomUUID()}`, reviewedChild }, child.action)).resolves.toBeNull();
                await expect(f.verify(root, { method: 'GET', path: '/v1/machines', reviewedChild }, child.action)).resolves.toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it.each([false, true])('respects readiness Action ceilings on a PAT (children granted: %s)', async granted => {
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, undefined, { allowedActionIds: ['session.spawn_new',
            ...(granted ? Object.values(SESSION_AGENT_READINESS_CHILDREN_V1).map(child => child.action) : [])] });
        try {
            const root = await f.mint('session.spawn_new', { executionTarget: { serverId: await getOrCreateServerIdentityId(), machineId: f.machine.id },
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
            for (const child of Object.values(SESSION_AGENT_READINESS_CHILDREN_V1)) {
                const method = `${f.machine.id}:${child.action === SESSION_AGENT_READINESS_CHILDREN_V1.inventory.action
                    ? RPC_METHODS.CAPABILITIES_DETECT : child.action === SESSION_AGENT_READINESS_CHILDREN_V1.acquire.action
                        ? RPC_METHODS.DAEMON_AGENTS_INSTALL_START : RPC_METHODS.DAEMON_AGENTS_INSTALL_READ}`;
                const reviewedChild = { actionId: child.action, role: child.role,
                    inputDigest: computeActionInputApprovalDigestV1(child.action, { machineId: f.machine.id }) };
                const requestId = randomUUID();
                const signed = { authorizationToken: root.token, effectActionId: child.action, target: root.binding.target,
                    installationId: f.machine.installationId!, requestId, method, params: 'opaque-child-input', reviewedChild };
                const rpc = await verifyExternalActionMachineRpcExecution({ v: 1, authorization: root, effectActionId: child.action,
                    target: root.binding.target, installationId: f.machine.installationId!, reviewedChild,
                    machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, privateKey: f.keyPair.secretKey }) },
                { method, requestId, params: signed.params });
                const http = await f.verify(root, { method: 'GET', path: `/v1/machines/${f.machine.id}`, reviewedChild }, child.action);
                if (granted) {
                    expect(rpc).toMatchObject({ effectActionId: child.action });
                    expect(http).toMatchObject({ effectActionId: child.action });
                } else {
                    expect(rpc).toBeNull();
                    expect(http).toBeNull();
                }
            }
        } finally { await f.app.close(); }
    });

    it('forwards the original signed readiness child through the real Home RPC router', async () => {
        const f = await createSignedDiscussionHttpFixture();
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true, lastActiveAt: new Date(),
                operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                    requesterExecutionIsolation: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
            const rootInput = { executionTarget: { serverId: await getOrCreateServerIdentityId(), machineId: f.machine.id },
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
            const authorization = await f.mint('session.spawn_new', rootInput, true);
            const originalActionEnvelope = { v: 1 as const, requestId: authorization.binding.requestId,
                target: authorization.binding.target, input: rootInput };
            const child = SESSION_AGENT_READINESS_CHILDREN_V1.inventory;
            const reviewedChild = { actionId: child.action, role: child.role,
                inputDigest: computeActionInputApprovalDigestV1(child.action, { machineId: f.machine.id, agentId: 'codex', refresh: true }) };
            const method = `${f.machine.id}:${RPC_METHODS.CAPABILITIES_DETECT}`;
            const requestId = randomUUID();
            const params = 'opaque-child-input';
            const signed = { authorizationToken: authorization.token, effectActionId: child.action,
                target: authorization.binding.target, installationId: f.machine.installationId!, method, requestId, params, reviewedChild };
            const externalActionExecution = { v: 1 as const, authorization, effectActionId: child.action,
                target: authorization.binding.target, installationId: f.machine.installationId!, reviewedChild,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, privateKey: f.keyPair.secretKey }) };
            const accountStoredContentCompatibility = evaluateAccountStoredContentSocketCompatibility(
                buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)).evaluation;
            let received: SocketRpcRequestPayload | undefined;
            // Only the Socket.IO network peers are substituted. Root issuance,
            // signatures, router admission and the forwarding owner stay real.
            const target = { id: randomUUID(), data: { clientType: 'machine-scoped', userId: f.account.id,
                machineId: f.machine.id, verifiedMachineInstallationId: f.machine.installationId, accountStoredContentCompatibility },
                timeout: () => ({ emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => {
                    received = request;
                    return { ready: true };
                } }) };
            const io = createSocketRoomDiscoveryHarness(async room => room === target.id || room === `rpc:${f.account.id}:${method}` ? [target] : []);
            const caller = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'user-scoped', userId: f.account.id,
                authTokenKind: 'account', accountStoredContentCompatibility } }), { handshake: { auth: { token: f.presentUserToken } } });
            registerSocketRpcHandlers({ userId: f.account.id, socket: caller as unknown as Socket, io });
            let response: unknown;
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, requestId, params, originalActionEnvelope, externalActionExecution },
                (value: unknown) => { response = value; });
            expect(response).toMatchObject({ ok: true, result: { ready: true } });
            expect(received).toMatchObject({ callerInputAuthorization: authorization, callerAuthority: 'present_user',
                workspaceSyncSourceExecution: { originalActionEnvelope, externalActionExecution } });
        } finally { await f.app.close(); }
    });
});
