import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ExternalActionMachineRpcExecutionV1Schema, type ExternalActionExecutionAuthorizationV1,
    type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedDiscussionHttpFixture, createSignedDiscussionModelBirthFixture } from '../../routes/actions/discussionExecutionAuthorization.testkit';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '../../testkit/socketHarness';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';

describe('retained original Action envelopes through the Home relay', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-original-envelope-relay-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function relay(fixture: Awaited<ReturnType<typeof createSignedDiscussionHttpFixture>>,
        input: Readonly<{ receiverMachineId: string; receiverInstallationId: string; authorization: ExternalActionExecutionAuthorizationV1;
            envelope: ExternalActionRequestEnvelope; method: string; effectActionId: string; params: unknown;
            controllerSocket?: boolean }>) {
        const method = `${input.receiverMachineId}:${input.method}`;
        const forwarded: SocketRpcRequestPayload[] = [];
        // The receiving daemon is the network boundary. Home HTTP minting,
        // persisted Discussion slots, signatures, currentness and relay stay real.
        const effect = vi.fn(async (_event: string, packet: SocketRpcRequestPayload) => {
            forwarded.push(packet);
            return { accepted: true };
        });
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)).evaluation;
        const daemon = createAuthenticatedFakeSocket({ id: randomUUID(), data: { clientType: 'machine-scoped',
            userId: fixture.account.id, machineId: input.receiverMachineId, verifiedMachineInstallationId: input.receiverInstallationId,
            accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck: effect }) });
        const io = createSocketRoomDiscoveryHarness(async room => room === daemon.id || room === `rpc:${fixture.account.id}:${method}` ? [daemon] : []);
        const caller = Object.assign(createAuthenticatedFakeSocket({ id: randomUUID(), data: { userId: fixture.account.id,
            ...(input.controllerSocket ? { clientType: 'machine-scoped', machineId: fixture.machine.id,
                verifiedMachineInstallationId: fixture.machine.installationId } : { clientType: 'user-scoped' }),
            authTokenKind: 'account', authAuthority: 'present_user', accountStoredContentCompatibility: compatibility } }),
        { handshake: { auth: { token: fixture.presentUserToken } } });
        registerSocketRpcHandlers({ userId: fixture.account.id, socket: caller as unknown as Socket, io });
        const invoke = async (envelope = input.envelope) => {
            const requestId = randomUUID();
            const execution = ExternalActionMachineRpcExecutionV1Schema.parse({ v: 1, authorization: input.authorization,
                effectActionId: input.effectActionId, target: input.authorization.binding.target, installationId: fixture.machine.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: input.authorization.token,
                    effectActionId: input.effectActionId, target: input.authorization.binding.target, installationId: fixture.machine.installationId!,
                    event: SOCKET_RPC_EVENTS.CALL, method, requestId, params: input.params, privateKey: fixture.keyPair.secretKey }) });
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: input.params, requestId,
                externalActionExecution: execution, originalActionEnvelope: envelope }, callback);
            return callback;
        };
        expect(await invoke({ ...input.envelope, requestId: randomUUID() })).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(forwarded).toEqual([]);
        expect(await invoke()).toHaveBeenCalledWith({ ok: true, result: { accepted: true } });
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]?.originalActionEnvelope).toEqual(input.envelope);
        expect(forwarded[0]?.machineAdmission?.actorAccountId).toBe(fixture.account.id);
    }

    it.each([RPC_METHODS.SESSION_SPAWN_NEW, RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT])(
        'relays the reviewed second-opinion child %s with its original root', async method => {
            const fixture = await createSignedDiscussionHttpFixture();
            onTestFinished(() => fixture.app.close());
            const birth = await createSignedDiscussionModelBirthFixture(fixture);
            await db.machine.updateMany({ where: { id: { in: [fixture.machine.id, birth.target.id] } },
                data: { active: true, lastActiveAt: new Date() } });
            const source = birth.sourceExecution;
            await relay(fixture, { receiverMachineId: birth.target.id, receiverInstallationId: birth.target.installationId!,
                authorization: source.externalActionExecution.authorization, envelope: source.originalActionEnvelope,
                method, effectActionId: 'session.spawn_new', params: method === RPC_METHODS.SESSION_SPAWN_NEW
                    ? source.params : { directory: { kind: 'path', path: '/review' } } });
        });

    it.each(['projects.script.run', 'projects.compute.exec'] as const)(
        'preserves the already supported original %s root', async actionId => {
            const fixture = await createSignedDiscussionHttpFixture();
            onTestFinished(() => fixture.app.close());
            await db.machine.update({ where: { id: fixture.machine.id }, data: { active: true, lastActiveAt: new Date() } });
            const workspace = { serverId: 'home-1', machineId: fixture.machine.id, workspaceId: 'project-workspace', rootPath: '/project' };
            const params = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].parse(actionId === 'projects.script.run'
                ? { workspace, selection: { kind: 'named', name: 'test' } }
                : { workspace, executable: 'git', argv: ['status'], cwd: '/project' });
            const authorization = await fixture.mint(actionId, params, true);
            await relay(fixture, { receiverMachineId: fixture.machine.id, receiverInstallationId: fixture.machine.installationId!,
                authorization, envelope: { v: 1, requestId: authorization.binding.requestId, target: authorization.binding.target, input: params },
                method: PROJECT_FINITE_ACTION_RPC_METHODS_V1[actionId], effectActionId: actionId, params, controllerSocket: true });
        });
});
