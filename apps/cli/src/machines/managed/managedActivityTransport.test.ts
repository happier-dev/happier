import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ExternalActionExecutionAuthorizationV1Schema, projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionMachineRpcExecutionV1Schema, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions';
import nacl from 'tweetnacl';
import { createManagedGuestActivityTransport } from './managedActivityTransport';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { ManagedMachineExecutionOptions } from './acquire';
import { ManagedMachineControllerError } from './controllerErrors';

const machine = ManagedMachineV1Schema.parse({
    id: 'managed', homeId: 'srv_home', custodianAccountId: 'owner',
    controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
    allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
    enrolledMachineId: 'guest', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' }, wakeOnAcceptedMessage: false,
});

function signedAccountAfterIdle(actionId: 'machines.managed.power.set' | 'machines.managed.delete') {
    const keys = nacl.sign.keyPair();
    const current = { ...machine, controller: undefined,
        desired: actionId === 'machines.managed.delete' ? 'delete' as const : 'stop' as const,
        desiredWhen: 'after-idle' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
        accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', machineId: 'controller', installationId: 'installation', serverIdentityId: machine.homeId,
        actionId, requestId: 'retention', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'controller' },
        managedAccountExecutor: { enrolledMachineId: current.enrolledMachineId },
        managedAdmission: projectExternalActionManagedAdmissionV1(actionId, {
            homeId: current.homeId, managedId: current.id, intent: current.desired, when: current.desiredWhen,
            ...(actionId === 'machines.managed.delete' ? { reviewedDependencies: true } : {}),
        }),
    } });
    return { keys, current, authorization };
}

async function withPendingConnection(run: (endpoint: string, connecting: Promise<void>) => Promise<void>) {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    let attempted!: () => void;
    const connecting = new Promise<void>(resolve => { attempted = resolve; });
    // The Home/socket boundary holds authentication before readiness, as can happen during startup.
    server.use(() => { attempted(); });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing activity socket endpoint');
        await run(`http://127.0.0.1:${address.port}`, connecting);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

async function withConnectedTransport(run: (bridge: ReturnType<typeof createManagedGuestActivityTransport>, socket: Socket, reads: () => number) => Promise<void>,
    options: ManagedMachineExecutionOptions = { requestId: 'retention' }, current = machine, signingKey?: Uint8Array) {
    let httpReads = 0;
    const http = createServer((_request, response) => { httpReads++; response.writeHead(403); response.end(); });
    const server = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const connected = new Promise<Socket>(resolve => server.once('connection', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing activity socket endpoint');
    const bridge = createManagedGuestActivityTransport({ token: 'owner-token',
        serverUrl: `http://127.0.0.1:${address.port}`,
        credentials: { token: 'owner-token', encryption: null },
        ...(signingKey ? { externalActionMachineRequestPrivateKey: signingKey } : {}) }, options, current);
    try {
        await run(bridge, await connected, () => httpReads);
    } finally {
        await bridge.dispose?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

describe('managed activity transport lifetime', () => {
    it('observes an Account-owned guest without fabricating a native controller', async () => {
        const current = { ...machine, controller: undefined };
        await withConnectedTransport(async (bridge, socket) => {
            const requests: unknown[] = [];
            socket.on(SOCKET_RPC_EVENTS.CALL, (request: { params: unknown }, reply: (result: unknown) => void) => {
                requests.push(request.params);
                reply({ ok: true, result: { kind: 'idle', since: 100 } });
            });
            expect(await bridge.read(current)).toMatchObject({ kind: 'idle' });
            expect(await bridge.confirmIdle(current)).toMatchObject({ kind: 'idle' });
            expect(requests).toEqual([
                { homeId: current.homeId, managedId: current.id, expectedRevision: current.intentRevision },
                { homeId: current.homeId, managedId: current.id, expectedRevision: current.intentRevision, action: 'begin' },
            ]);
        }, { requestId: 'retention' }, current);
    });
    it.each(['machines.managed.power.set', 'machines.managed.delete'] as const)('uses the admitted Account signer for exact after-idle %s activity and drain', async actionId => {
        const { keys, authorization, current } = signedAccountAfterIdle(actionId);
        await withConnectedTransport(async (bridge, socket) => {
            socket.on(SOCKET_RPC_EVENTS.CALL, (request: { method: string; requestId: string; params: unknown; externalActionExecution: unknown }, reply: (result: unknown) => void) => {
                const proof = ExternalActionMachineRpcExecutionV1Schema.parse(request.externalActionExecution);
                expect(proof.installationId).toBe(authorization.binding.installationId);
                expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: proof.effectActionId, target: proof.target, installationId: proof.installationId,
                    method: request.method, requestId: request.requestId, params: request.params, event: SOCKET_RPC_EVENTS.CALL,
                    signature: proof.machineSignature, publicKey: keys.publicKey })).toBe(true);
                reply({ ok: true, result: { kind: 'idle', since: 100 } });
            });
            expect(await bridge.read(current)).toMatchObject({ kind: 'idle' });
            expect(await bridge.confirmIdle(current)).toMatchObject({ kind: 'idle' });
        }, { requestId: 'retention', context: { externalActionExecutionAuthorization: authorization,
            externalActionTarget: { kind: 'machine', machineId: 'controller' } } }, current, keys.secretKey);
    });
    it.each(['missing-executor', 'foreign-guest', 'foreign-row', 'foreign-account', 'mismatched-intent', 'replayed-request'] as const)(
        'refuses %s before opening an Account after-idle activity transport', async mismatch => {
            const { keys, authorization, current } = signedAccountAfterIdle('machines.managed.power.set');
            const binding = authorization.binding;
            if (mismatch === 'missing-executor') delete binding.managedAccountExecutor;
            if (mismatch === 'foreign-guest') binding.managedAccountExecutor = { enrolledMachineId: 'foreign-guest' };
            if (mismatch === 'foreign-account') binding.accountId = 'foreign-account';
            if (binding.managedAdmission?.actionId === 'machines.managed.power.set') {
                if (mismatch === 'foreign-row') binding.managedAdmission.input.managedId = 'foreign-row';
                if (mismatch === 'mismatched-intent') binding.managedAdmission.input.intent = 'suspend';
            }
            let bridge: ReturnType<typeof createManagedGuestActivityTransport> | undefined;
            try {
                expect(() => { bridge = createManagedGuestActivityTransport({ token: 'owner-token', serverUrl: 'http://127.0.0.1:1',
                    credentials: { token: 'owner-token', encryption: null }, externalActionMachineRequestPrivateKey: keys.secretKey },
                { requestId: mismatch === 'replayed-request' ? 'new-request' : 'retention', context: {
                    externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse(authorization),
                    externalActionTarget: { kind: 'machine', machineId: 'controller' },
                } }, current); }).toThrow(ManagedMachineControllerError);
            } finally { await bridge?.dispose?.(); }
        });
    it.each(['read', 'confirmIdle', 'waitForChange'] as const)('cancels %s before readiness while retaining the connection for cleanup', async method => {
        await withPendingConnection(async (serverUrl, connecting) => {
            const cancellation = new AbortController();
            const bridge = createManagedGuestActivityTransport({ token: 'owner-token', serverUrl,
                credentials: { token: 'owner-token', encryption: null } }, { requestId: 'retention', signal: cancellation.signal }, machine);
            const pending = (method === 'waitForChange' ? bridge.waitForChange()
                : bridge[method](machine)).catch((error: unknown) => error);
            try {
                await connecting;
                cancellation.abort();
                expect(await pending).toMatchObject({ name: 'AbortError' });
            } finally { await bridge.dispose?.(); }
        });
    });
    it.each(['read', 'confirmIdle'] as const)('cancels an in-flight %s without closing the cleanup socket', async method => {
        const cancellation = new AbortController();
        await withConnectedTransport(async (bridge, socket) => {
            const issued = new Promise<void>(resolve => socket.once(SOCKET_RPC_EVENTS.CALL, () => resolve()));
            const pending = bridge[method](machine, cancellation.signal).catch((error: unknown) => error);
            await issued;
            cancellation.abort();
            expect(await pending).toMatchObject({ name: 'AbortError' });
            await expect(bridge[method](machine)).rejects.toMatchObject({ name: 'AbortError' });
            // Let the cancellation settle at the transport lifetime boundary.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(socket.connected).toBe(true);
        }, { requestId: 'retention', signal: cancellation.signal });
    });
    it('uses the subscribed content-free RPC without reading the guest private Machine or keys', async () => {
        await withConnectedTransport(async (bridge, socket, reads) => {
            const requests: unknown[] = [];
            socket.on(SOCKET_RPC_EVENTS.CALL, (request: { params: unknown }, reply: (result: unknown) => void) => {
                requests.push(request.params);
                reply({ ok: true, result: { kind: 'idle', since: 100 } });
            });
            expect(await bridge.read(machine)).toMatchObject({ kind: 'idle' });
            expect(await bridge.confirmIdle(machine)).toMatchObject({ kind: 'idle' });
            expect(await bridge.reopen(machine)).toMatchObject({ kind: 'idle' });
            expect(reads()).toBe(0);
            expect(requests).toEqual([
                { homeId: machine.homeId, managedId: machine.id, expectedRevision: machine.intentRevision, controller: machine.controller },
                { homeId: machine.homeId, managedId: machine.id, expectedRevision: machine.intentRevision, controller: machine.controller, action: 'begin' },
                { homeId: machine.homeId, managedId: machine.id, expectedRevision: machine.intentRevision, controller: machine.controller, action: 'resume' },
            ]);
        });
    });
    it('classifies 60 unrelated Account wakes as currentness and the target Machine wake as activity', async () => {
        await withConnectedTransport(async (bridge, socket) => {
            // Connection itself invalidates the prior observation.
            await expect(bridge.waitForChange()).resolves.toBe('activity');
            for (let seq = 1; seq <= 60; seq++) {
                const changed = bridge.waitForChange();
                socket.emit('update', { id: `account-${seq}`, seq, createdAt: seq,
                    body: { t: 'account-change' } });
                await expect(changed).resolves.toBe('currentness');
            }
            const changed = bridge.waitForChange();
            socket.emit('update', { id: 'target-machine', seq: 61, createdAt: 61,
                body: { t: 'update-machine', machineId: machine.enrolledMachineId } });
            await expect(changed).resolves.toBe('activity');
        });
    });
    it.each([false, true])('disposes before readiness without an unhandled rejection (waiting reader=%s)', async waitingReader => {
        await withPendingConnection(async (serverUrl, connecting) => {
            const rejections: unknown[] = [];
            const onUnhandled = (error: unknown) => { rejections.push(error); };
            process.on('unhandledRejection', onUnhandled);
            const bridge = createManagedGuestActivityTransport({ token: 'owner-token', serverUrl,
                credentials: { token: 'owner-token', encryption: null } }, { requestId: 'retention' }, machine);
            const pending = waitingReader ? bridge.waitForChange().then(() => undefined, (error: unknown) => error) : undefined;
            try {
                await connecting;
                await bridge.dispose?.();
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(rejections).toEqual([]);
                if (pending) expect(await pending).toMatchObject({ name: 'AbortError' });
                // Disposal must keep the original readiness failure for a later consumer too.
                await expect(bridge.waitForChange()).rejects.toMatchObject({ name: 'AbortError' });
            } finally {
                await bridge.dispose?.();
                await bridge.waitForChange().catch(() => undefined);
                process.off('unhandledRejection', onUnhandled);
            }
        });
    });
});
