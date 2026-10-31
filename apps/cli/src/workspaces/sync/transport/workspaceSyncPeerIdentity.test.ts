import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { listenWorkspaceSyncBroker } from './workspaceSyncBroker';
import { WorkspaceSyncBrokerClient } from './workspaceSyncBrokerClient.testkit';
import {
    createWorkspaceSyncPeerIdentityValidator,
    type WorkspaceSyncPeerIdentityValidator,
} from './workspaceSyncPeerIdentity';
import type { ProcessCustodyPeerIdentity } from '@/subprocess/supervision/processCustody';

const cleanupJobs: Array<() => Promise<void>> = [];
afterEach(async () => {
    while (cleanupJobs.length > 0) {
        const job = cleanupJobs.pop();
        if (job) await job();
    }
});

/** Full-duplex stand-in for the authenticated peer carrier. */
class PeerStream extends Duplex {
    override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
        void chunk;
        cb();
    }

    override _read(): void {}
}

type ObserveRecord = {
    calls: Array<{ socket: Socket; executablePath: string }>;
};

function observeFactory(
    record: ObserveRecord,
    identity: ProcessCustodyPeerIdentity | null | Error,
): (input: Readonly<{ socket: Socket; executablePath: string }>) => Promise<ProcessCustodyPeerIdentity | null> {
    return async (input) => {
        record.calls.push({ socket: input.socket, executablePath: input.executablePath });
        if (identity instanceof Error) throw identity;
        return identity;
    };
}

function validatorWith(overrides: {
    observe?: (input: Readonly<{ socket: Socket; executablePath: string }>) => Promise<ProcessCustodyPeerIdentity | null>;
    platform?: NodeJS.Platform;
    resolveExecutable?: (platform: NodeJS.Platform) => string | null;
    getUid?: () => number | undefined;
}): WorkspaceSyncPeerIdentityValidator {
    return createWorkspaceSyncPeerIdentityValidator({
        platform: overrides.platform ?? 'linux',
        resolveExecutable: overrides.resolveExecutable ?? (() => '/staged/happier-process-custody'),
        observe: overrides.observe ?? observeFactory({ calls: [] }, { pid: 4242, uid: 1000 }),
        getUid: overrides.getUid ?? (() => 1000),
    });
}

describe('workspace sync peer identity validator', () => {
    it('accepts a connection proven to come from the exact expected sidecar pid and same uid', async () => {
        const validator = validatorWith({});
        validator.setExpectedSidecarPid(4242);
        const socket = new Socket({ readable: false, writable: false });
        await expect(validator.validate({ kind: 'control', socket })).resolves.toBe(true);
        await expect(validator.validate({ kind: 'data', socket })).resolves.toBe(true);
    });

    it('fails closed before the sidecar pid is known', async () => {
        const validator = validatorWith({});
        const socket = new Socket({ readable: false, writable: false });
        await expect(validator.validate({ kind: 'control', socket, sidecarPid: 4242 })).resolves.toBe(false);
    });

    it('fails closed when the proven pid is not the expected sidecar pid', async () => {
        const validator = validatorWith({
            observe: observeFactory({ calls: [] }, { pid: 999, uid: 1000 }),
        });
        validator.setExpectedSidecarPid(4242);
        await expect(validator.validate({ kind: 'control', socket: new Socket() })).resolves.toBe(false);
    });

    it('fails closed when a hello claims a different pid than the expected one', async () => {
        const validator = validatorWith({});
        validator.setExpectedSidecarPid(4242);
        await expect(validator.validate({ kind: 'control', socket: new Socket(), sidecarPid: 5150 })).resolves.toBe(false);
    });

    it('fails closed when the proven uid is not this process uid', async () => {
        const validator = validatorWith({
            observe: observeFactory({ calls: [] }, { pid: 4242, uid: 1337 }),
        });
        validator.setExpectedSidecarPid(4242);
        await expect(validator.validate({ kind: 'control', socket: new Socket() })).resolves.toBe(false);
    });

    it('fails closed when the helper is absent, or its answer is null or throws', async () => {
        const absent = validatorWith({ resolveExecutable: () => null });
        absent.setExpectedSidecarPid(4242);
        await expect(absent.validate({ kind: 'control', socket: new Socket() })).resolves.toBe(false);

        const nullAnswer = validatorWith({ observe: observeFactory({ calls: [] }, null) });
        nullAnswer.setExpectedSidecarPid(4242);
        await expect(nullAnswer.validate({ kind: 'data', socket: new Socket() })).resolves.toBe(false);

        const throwing = validatorWith({ observe: observeFactory({ calls: [] }, new Error('spawn failed')) });
        throwing.setExpectedSidecarPid(4242);
        await expect(throwing.validate({ kind: 'control', socket: new Socket() })).resolves.toBe(false);
    });

    it('fails closed on platforms without a supported exact peer primitive', async () => {
        const validator = validatorWith({ platform: 'sunos' });
        validator.setExpectedSidecarPid(4242);
        await expect(validator.validate({ kind: 'control', socket: new Socket() })).resolves.toBe(false);
    });

    it('on Windows accepts only the native relay authenticated exact-pid witness', async () => {
        const observed: ObserveRecord = { calls: [] };
        const windows = validatorWith({
            platform: 'win32',
            getUid: () => 1000,
            observe: observeFactory(observed, { pid: 4242, uid: null }),
        });
        windows.setExpectedSidecarPid(4242);
        await expect(windows.validate({ kind: 'control', socket: new Socket(), witnessedPeerPid: 4242 })).resolves.toBe(true);
        await expect(windows.validate({ kind: 'control', socket: new Socket(), witnessedPeerPid: 999 })).resolves.toBe(false);
        await expect(windows.validate({ kind: 'control', socket: new Socket() })).resolves.toBe(false);
        expect(observed.calls).toHaveLength(0);
    });

    it('passes the exact accepted socket to the helper invocation and never invents one', async () => {
        const record: ObserveRecord = { calls: [] };
        const validator = validatorWith({ observe: observeFactory(record, { pid: 4242, uid: 1000 }) });
        validator.setExpectedSidecarPid(4242);
        const socket = new Socket({ readable: false, writable: false });
        await validator.validate({ kind: 'control', socket });
        expect(record.calls).toHaveLength(1);
        expect(record.calls[0].socket).toBe(socket);
        expect(record.calls[0].executablePath).toBe('/staged/happier-process-custody');
    });

    it('rejects a non-positive or non-integer expected sidecar pid', () => {
        const validator = validatorWith({});
        expect(() => validator.setExpectedSidecarPid(0)).toThrow(TypeError);
        expect(() => validator.setExpectedSidecarPid(1.5)).toThrow(TypeError);
    });
});

describe('plugs into the live broker as validatePeerIdentity', () => {
    it('authenticates hello and data attach for the exact sidecar through the real broker', async () => {
        const record: ObserveRecord = { calls: [] };
        const observedKinds: string[] = [];
        const validator = createWorkspaceSyncPeerIdentityValidator({
            platform: 'linux',
            resolveExecutable: () => '/staged/happier-process-custody',
            observe: async ({ socket }) => {
                record.calls.push({ socket, executablePath: '/staged/happier-process-custody' });
                return { pid: 4242, uid: 1000 };
            },
            getUid: () => 1000,
        });
        const directory = await mkdtemp(join(tmpdir(), 'wspeer-'));
        const secret = randomBytes(32);
        const broker = await listenWorkspaceSyncBroker({
            socketPath: join(directory, 'b.sock'),
            launchSecret: secret,
            validatePeerIdentity: (context) => {
                observedKinds.push(context.kind);
                return validator.validate(context);
            },
            openExternalStream: async () => new PeerStream(),
        });
        cleanupJobs.push(async () => {
            await broker.close().catch(() => {});
            await rm(directory, { recursive: true, force: true });
        });

        // Until the lifecycle supplies the actual spawned pid, every hello
        // fails closed: a first sidecar attempt is rejected...
        const earlyClient = new WorkspaceSyncBrokerClient({
            endpointPath: broker.socketPath,
            brokerInstanceId: broker.brokerInstanceId,
            launchNonce: broker.launchNonce,
            launchSecret: secret,
            sidecarPid: 4242,
        });
        await expect(earlyClient.connectControl()).rejects.toMatchObject({ code: 'unauthorized' });

        // ...then the lifecycle supplies the actual spawned sidecar pid (the
        // waitForReady handoff) and the same validator admits the retry.
        validator.setExpectedSidecarPid(4242);
        const client = new WorkspaceSyncBrokerClient({
            endpointPath: broker.socketPath,
            brokerInstanceId: broker.brokerInstanceId,
            launchNonce: broker.launchNonce,
            launchSecret: secret,
            sidecarPid: 4242,
        });
        await client.connectControl();
        const stream = await client.openStream('ws1_' + 'a'.repeat(32));
        await stream.close();
        // The first 'control' is the pre-pid fail-closed attempt, then the
        // admitted control and data connections of the exact sidecar.
        expect(observedKinds).toEqual(['control', 'control', 'data']);
        // The pre-pid attempt is refused before any helper invocation; only
        // the admitted control and data connections reach the helper.
        expect(record.calls).toHaveLength(2);
        await client.close();
    });

    it('keeps a mismatched sidecar locked out of the broker entirely', async () => {
        const validator = createWorkspaceSyncPeerIdentityValidator({
            platform: 'linux',
            resolveExecutable: () => '/staged/happier-process-custody',
            observe: async () => ({ pid: 999, uid: 1000 }),
            getUid: () => 1000,
        });
        validator.setExpectedSidecarPid(4242);
        const directory = await mkdtemp(join(tmpdir(), 'wspeer-deny-'));
        const secret = randomBytes(32);
        const broker = await listenWorkspaceSyncBroker({
            socketPath: join(directory, 'b.sock'),
            launchSecret: secret,
            validatePeerIdentity: (context) => validator.validate(context),
            openExternalStream: async () => new PeerStream(),
        });
        cleanupJobs.push(async () => {
            await broker.close().catch(() => {});
            await rm(directory, { recursive: true, force: true });
        });

        const client = new WorkspaceSyncBrokerClient({
            endpointPath: broker.socketPath,
            brokerInstanceId: broker.brokerInstanceId,
            launchNonce: broker.launchNonce,
            launchSecret: secret,
            sidecarPid: 4242,
        });
        await expect(client.connectControl()).rejects.toMatchObject({ code: 'unauthorized' });
    });
});
