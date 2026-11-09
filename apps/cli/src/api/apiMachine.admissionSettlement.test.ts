import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { ApiMachineClient } from './apiMachine';
import type { MachineRpcAdmissionBoundary } from './machine/machineRpcAuthorization';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import nacl from 'tweetnacl';
import * as installationStore from '@/daemon/identity/store';
import { MachineAdmissionVerifyResponseV1Schema, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const { socketIo } = vi.hoisted(() => ({ socketIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketIo }));

it('preserves the typed Home receiving admission through the installed ApiMachine callback', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(83));
    const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
        version: 1, installationId: 'receiver-installation', createdAt: 1,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'),
        privateKey: Buffer.from(keys.secretKey).toString('base64url'),
    });
    const context = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'owner', custodianAccountId: 'owner',
        machineId: 'machine', installationId: 'receiver-installation', role: 'manage', encryptionMode: 'plain' });
    const receipt = MachineAdmissionVerifyResponseV1Schema.parse({ v: 1, ok: true, receivingMachineAdmission: context });
    const method = `machine:${RPC_METHODS.DAEMON_TERMINAL_LIST}`;
    // Only installed-file and Home HTTP boundaries are substituted. The actual
    // callback must sign its admission and retain Home's parsed response object.
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
        expect(String(url)).toMatch(/\/v1\/machines\/machine\/admission\/verify$/);
        expect(raw).toMatchObject({ v: 1, context, method });
        if (!raw || typeof raw !== 'object' || !('proof' in raw)) throw new Error('Missing installation admission proof');
        const proof = MachineInstallationProofV1Schema.parse(raw.proof);
        expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof,
            payload: { version: 1, accountId: 'owner', machineId: 'machine', installationId: context.installationId,
                rpcAdmission: { context, method } } })).toBe(true);
        return { status: 200, data: receipt };
    });
    socketIo.mockImplementation(() => createApiSessionSocketStub());
    const token = `test.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const boundary: MachineRpcAdmissionBoundary = Reflect.get(client, 'machineRpcAdmissionBoundary');
    try {
        expect(await boundary.verifyMachineAdmission({ context, method })).toEqual(receipt);
        expect(network).toHaveBeenCalledTimes(1);
    } finally {
        await client.shutdown();
        network.mockRestore();
        installation.mockRestore();
    }
});

it.each(['profile', 'currentness'] as const)('lets an admission joiner cancel without cancelling shared Account identity acquisition (%s)', async phase => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    // Hold only Home HTTP; identity, currentness and the installed admission reader stay real.
    const network = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/profile')) {
            if (phase === 'profile') { entered = true; await held; }
            return { status: 200, data: { id: 'owner' } };
        }
        expect(String(url)).toContain('/v1/account/encryption/currentness');
        entered = true;
        await held;
        return { status: 200, data: { mode: 'plain', version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null } };
    });
    socketIo.mockImplementation(() => createApiSessionSocketStub());
    const token = phase === 'profile' ? 'opaque-daemon-token'
        : `test.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const boundary: MachineRpcAdmissionBoundary = Reflect.get(client, 'machineRpcAdmissionBoundary');
    const owner = boundary.resolveCustodianAccountId();
    const cancellation = new AbortController();
    let joined = false;
    let joinedError: unknown;
    try {
        await vi.waitFor(() => expect(entered).toBe(true));
        const joiner = boundary.resolveCustodianAccountId(cancellation.signal).then(
            () => { joined = true; }, error => { joined = true; joinedError = error; });
        const reason = new Error('admission reader retired');
        cancellation.abort(reason);
        await vi.waitFor(() => expect(joined).toBe(true));
        expect(joinedError).toBe(reason);
        release();
        expect(await owner).toBe('owner');
        await joiner;
        expect(await boundary.resolveCustodianAccountId()).toBe('owner');
        expect(network.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/profile'))).toHaveLength(1);
    } finally { release(); await owner; await client.shutdown(); network.mockRestore(); }
});
