import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { terminateProcessTreeByPid } from '../../../../packages/tests/src/testkit/process/processTree';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import nacl from 'tweetnacl';
import {
    ExternalActionDaemonDispatchRequestSchema, ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
} from '@happier-dev/protocol/actions';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { isSocketRpcActionApiServerOriginAuthorizationContext, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createExternalActionHomeForTests } from './externalActionExecution';
import { createExternalActionHomeProcessForTests } from './externalActionExecution.testkit.mjs';
import { sealExternalActionRequesterAccountContextV1, openExternalActionRequesterAccountContextV1,
    type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

describe.each([
    ['in process', createExternalActionHomeForTests],
    ['isolated process', createExternalActionHomeProcessForTests],
] as const)('external Action Home testkit %s', (_name, createHome) => {
        const keys = nacl.sign.keyPair();
        const machineId = 'external-action-home-machine';
        const installationId = 'external-action-home-installation';
        const actionId = 'machines.work.summary.get';
        const invocation = { caller: { kind: 'host' }, surface: 'cli', authority: 'account_automation' } as const satisfies ExternalActionRequesterInvocationV1;
        let received: SocketRpcRequestPayload | undefined;
        let home: Awaited<ReturnType<typeof createHome>>;
        beforeAll(async () => { home = await createHome({
            serverIdentityId: 'srv_external_action_home', accountId: 'external-action-home-account', machineId,
            installationId, installationPublicKey: keys.publicKey,
            dispatch: async packet => {
                received = packet;
                const request = ExternalActionDaemonDispatchRequestSchema.parse(packet.params);
                return createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId: request.actionId, requestId: request.envelope.requestId,
                    execution: { ok: true, result: { accepted: true } },
                }));
            },
        }); }, 120_000);
        afterAll(async () => { await home?.close(); });

        it('mints, verifies and relays genuine terminal roots while refusing altered target, installation, signature and bearer', async () => {
            const headers = { authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' };
            const envelope = { v: 1, requestId: 'owner-positive', target: { kind: 'machine', machineId }, input: {} };
            const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
            expect((await home.request('POST', mintPath, { v: 1, machineId, envelope },
                { ...headers, 'Content-Type': 'application/octet-stream' })).status).toBe(415);
            const issued = await home.request('POST', mintPath, { v: 1, machineId, envelope }, headers);
            expect(issued.status).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.data);
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1 };
            const proof = (overrides: Readonly<{ target?: typeof authorization.binding.target; installationId?: string; privateKey?: Uint8Array }> = {}) => {
                const target = overrides.target ?? authorization.binding.target;
                return {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: actionId, target,
                        installationId: overrides.installationId ?? installationId, requestId: authorization.binding.requestId,
                        method: 'POST', path, body, privateKey: overrides.privateKey ?? keys.secretKey,
                    }),
                };
            };
            expect(await home.request('POST', path, body, proof())).toEqual({ status: 200, data: { ok: true } });
            for (const denied of [
                proof({ target: { kind: 'machine', machineId: 'another-machine' } }),
                proof({ installationId: 'another-installation' }),
                proof({ privateKey: nacl.sign.keyPair().secretKey }),
            ]) expect((await home.request('POST', path, body, denied)).status).toBe(401);
            expect((await home.request('POST', mintPath, { v: 1, machineId, envelope }, { authorization: 'Bearer invalid' })).status).toBe(401);
            const sealed = sealExternalActionRequesterAccountContextV1({ authorization, credentials: { token: home.token },
                purpose: { kind: 'external_action' }, invocation, installationPublicKey: keys.publicKey, randomBytes: nacl.randomBytes });
            const relayedResponse = await home.request('POST', `/v1/actions/${actionId}`,
                { v: 1, machineId, envelope, executionAuthorization: sealed }, headers);
            expect(relayedResponse.status).toBe(200);
            expect(relayedResponse.data).toMatchObject({ execution: { ok: true, result: { accepted: true } } });
            expect(received).toBeDefined();
            expect(isSocketRpcActionApiServerOriginAuthorizationContext(received?.authorization)).toBe(true);
            expect(received?.machineAdmission).toMatchObject({ machineId, installationId });
            const request = ExternalActionDaemonDispatchRequestSchema.parse(received?.params);
            expect(request.executionAuthorization?.binding).toMatchObject({ authentication: { kind: 'terminal' },
                accountId: 'external-action-home-account', machineId, installationId });
            expect(request.executionAuthorization?.token === authorization.token).toBe(true);
            const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: 'srv_external_action_home',
                installationPrivateKey: keys.secretKey, includeInvocation: true });
            expect(opened?.invocation).toEqual(invocation);
            expect(opened?.credentials.token === home.token).toBe(true);
            expect(opened?.credentials.secret ?? opened?.credentials.encryption ?? null).toBeNull();
        });

        it('admits the retained setup review read under prepare without admitting operation cancellation or inventory', async () => {
            const headers = { authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' };
            const prepareId = 'projects.prepare';
            const workspace = { serverId: 'srv_external_action_home', machineId, workspaceId: 'checkout', rootPath: '/repo' };
            const issued = await home.request('POST', bindExternalActionExecutionAuthorizationHttpPathV1(prepareId), {
                v: 1, machineId, envelope: { v: 1, requestId: 'setup-consent-review',
                    target: { kind: 'machine', machineId }, input: { workspace, phase: 'setup' } },
            }, headers);
            expect(issued.status).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.data);
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(prepareId);
            const body = { v: 1, admittedMachineRole: authorization.binding.admittedMachineRole };
            const verifyEffect = (effectActionId: string) => home.request('POST', path, body, {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target: authorization.binding.target,
                    installationId, requestId: authorization.binding.requestId, method: 'POST', path, body, privateKey: keys.secretKey,
                }),
            });
            // The admitted root is the control; only its read child is added.
            expect(await verifyEffect(prepareId)).toEqual({ status: 200, data: { ok: true } });
            expect(await verifyEffect('action.operations.get')).toEqual({ status: 200, data: { ok: true } });
            expect((await verifyEffect('action.operations.cancel')).status).toBe(401);
            expect((await verifyEffect('action.operations.list')).status).toBe(401);
        });

        if (_name === 'isolated process') {
            // Acquisition is the behavior under test, using the same SQLite
            // budget as the normal owner's beforeAll rather than fixture setup.
            it('acquires a genuine isolated Home and mints a terminal root when the caller PATH has no tools', async () => {
                const emptyPath = await mkdtemp(join(tmpdir(), 'happier-home-caller-path-'));
                const previousPath = process.env.PATH;
                let restrictedHome: Awaited<ReturnType<typeof createHome>> | undefined;
                try {
                    process.env.PATH = emptyPath;
                    restrictedHome = await createHome({
                        serverIdentityId: 'srv_external_action_home', accountId: 'external-action-home-account',
                        machineId, installationId, installationPublicKey: keys.publicKey,
                        dispatch: async () => { throw new Error('unexpected_external_action_home_dispatch'); },
                    });
                    const minted = await restrictedHome.request('POST',
                        bindExternalActionExecutionAuthorizationHttpPathV1(actionId), {
                            v: 1, machineId, envelope: { v: 1, requestId: 'isolated-restricted-path',
                                target: { kind: 'machine', machineId }, input: {} },
                        }, { authorization: `Bearer ${restrictedHome.token}` });
                    expect(minted.status).toBe(200);
                    expect(ExternalActionExecutionAuthorizationV1Schema.parse(minted.data).binding)
                        .toMatchObject({ authentication: { kind: 'terminal' }, machineId, installationId });
                } finally {
                    if (previousPath === undefined) delete process.env.PATH;
                    else process.env.PATH = previousPath;
                    try { await restrictedHome?.close(); }
                    finally { await rm(emptyPath, { recursive: true, force: true }); }
                }
            }, 120_000);
        }
    });

describe('external Action Home child startup lifetime', () => {
    it('settles the actual Home child when its parent disconnects before startup completes', async () => {
        const require = createRequire(import.meta.url);
        const entry = fileURLToPath(new URL('./externalActionExecution.testkit.mjs', import.meta.url));
        const serverRoot = resolve(dirname(entry), '../..');
        const keys = nacl.sign.keyPair();
        const child = spawn(process.execPath, ['--conditions=happier-source', '--import', require.resolve('tsx/esm'),
            entry, '--external-action-home-child'], { cwd: serverRoot,
            env: { ...process.env, TSX_TSCONFIG_PATH: resolve(serverRoot, 'tsconfig.json') },
            serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
            child.once('exit', (code, signal) => {
                resolveExit({ code, signal });
            });
        });
        const ownerImported = new Promise<void>((resolveStarted, reject) => {
            child.on('message', message => {
                if (message && typeof message === 'object' && 'kind' in message && message.kind === 'setup-phase'
                    && 'phase' in message && message.phase === 'owner_import') {
                    resolveStarted();
                }
            });
            child.once('error', () => reject(new Error('external_action_home_child_spawn_failed')));
            child.once('exit', () => reject(new Error('external_action_home_child_exited_before_start')));
        });
        onTestFinished(async () => {
            if (child.connected) child.disconnect();
            if (child.exitCode === null && child.signalCode === null && child.pid) {
                await terminateProcessTreeByPid(child.pid);
            }
            if (child.pid) await exited;
        });
        child.send({ kind: 'start', options: { serverIdentityId: 'srv_home_disconnect', accountId: 'home-disconnect-account',
            machineId: 'home-disconnect-machine', installationId: 'home-disconnect-installation',
            installationPublicKey: Array.from(keys.publicKey) } });
        await ownerImported;
        child.disconnect();
        await expect(exited).resolves.toEqual({ code: 0, signal: null });
    }, 120_000);
});
