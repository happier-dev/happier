import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DirectRouteGrantRequestV2Schema, IrohMachineHandshakeV1Schema, type IrohEndpointDescriptorV1 } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR } from './machineCarrierHttpLease';
import {
    MACHINE_CARRIER_STREAM_PREAMBLE_BYTE,
    type MachineCarrierBrowserStreamLease,
    type MachineCarrierStreamDuplex,
    type OpenMachineCarrierStream,
    acquireBrowserMachineCarrierStreamLease,
} from './machineCarrierBrowserStream';

const SERVER_URL = 'https://server.example.test';
const targetToken = 'header.eyJzdWIiOiJhY2NvdW50LWIifQ.signature';
const BROWSER_ENDPOINT_ID = 'b'.repeat(64);
const TARGET_ENDPOINT_ID = 'a'.repeat(64);
let serverId: string;
const grantRequests: Array<ReturnType<typeof DirectRouteGrantRequestV2Schema.parse>> = [];
const originalMachineState = {
    machines: storage.getState().machines,
    machineListByServerId: storage.getState().machineListByServerId,
};
const previousStorageScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

function publishEndpoint(endpoint: IrohEndpointDescriptorV1 | null) {
    // The accepted Machine capability projection owns identity and dial hints.
    const machine = createMachineFixture({
        id: 'machine-1',
        operationProtocolCapabilities: endpoint ? {
            irohMachineEndpoint: { protocolVersions: [1], ...endpoint },
        } : {},
        operationProtocolCapabilitiesRevision: 1,
    });
    storage.setState((state) => ({
        machines: { ...state.machines, [machine.id]: machine },
        machineListByServerId: { ...state.machineListByServerId, [serverId]: [machine] },
    }));
}

function grantedResponse(request: ReturnType<typeof DirectRouteGrantRequestV2Schema.parse>) {
    return {
        ok: true as const,
        value: {
            payload: {
                v: 2,
                grantId: 'grant-v2-browser',
                accountId: 'account-from-signed-grant',
                machineId: request.machineId,
                flowKind: 'bounded_transfer',
                routeKind: 'iroh_peer',
                scope: request.scope,
                iat: 1_000,
                exp: 301_000,
                aud: 'happier-daemon-route-grant',
                endpointFingerprint: request.endpointFingerprint,
                proofKind: 'ephemeral_ed25519',
                ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                iroh: request.iroh,
            },
            signature: {
                keyId: 'key-1',
                alg: 'Ed25519',
                valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url'),
            },
        },
    };
}

type FakeStreamOptions = Readonly<{
    remoteEndpointId?: string;
    decisionBytes?: readonly number[];
    /** The decision read never settles, until the stream is cancelled. */
    hangDecision?: boolean;
    inboundChunks?: readonly Uint8Array[];
    closeError?: Error;
    /** `closeError` rejects only the first close attempt, then closes succeed. */
    closeErrorOnce?: boolean;
}>;

function createFakeMachineStream(options: FakeStreamOptions = {}) {
    const events: string[] = [];
    const writes: Uint8Array[] = [];
    const openedWith: Array<Readonly<{ alpn: string; endpointId: string; relayUrls: readonly string[] }>> = [];
    const decisionQueue = [...(options.decisionBytes ?? [0x01])];
    const inboundQueue = [...(options.inboundChunks ?? [])];
    let cancelCount = 0;
    let closeCount = 0;
    let settleDecision: (() => void) | null = null;
    const decisionSettled = new Promise<void>((resolve) => {
        settleDecision = resolve;
    });

    const stream: MachineCarrierStreamDuplex = {
        remoteEndpointId: options.remoteEndpointId ?? TARGET_ENDPOINT_ID,
        observedPath: 'relay',
        read: async (maxBytes) => {
            void maxBytes;
            if (decisionQueue.length > 0) {
                events.push('decisionRead');
                const byte = decisionQueue.shift()!;
                if (options.hangDecision) {
                    await decisionSettled;
                    return { bytes: new Uint8Array(0), done: true };
                }
                return { bytes: new Uint8Array([byte]), done: false };
            }
            events.push('payloadRead');
            const chunk = inboundQueue.shift();
            if (chunk === undefined) return { bytes: new Uint8Array(0), done: true };
            return { bytes: chunk, done: false };
        },
        write: async (bytes) => {
            events.push('write');
            writes.push(bytes);
        },
        finishWrite: async () => {
            events.push('finish');
        },
        cancel: () => {
            cancelCount += 1;
            events.push('cancel');
            settleDecision?.();
        },
        close: async () => {
            closeCount += 1;
            events.push('close');
            if (options.closeError && (closeCount === 1 || !options.closeErrorOnce)) {
                throw options.closeError;
            }
        },
    };

    const open: OpenMachineCarrierStream = async (input) => {
        events.push('open');
        openedWith.push(input);
        return stream;
    };

    return {
        open,
        events,
        writes,
        openedWith,
        cancelCount: () => cancelCount,
        closeCount: () => closeCount,
    };
}

function createEndpointLeaseBoundary() {
    const release = vi.fn(async () => undefined);
    const acquireEndpointLease = vi.fn(async (_relayUrls: readonly string[]) => ({
        endpointId: BROWSER_ENDPOINT_ID,
        release,
    }));
    return { acquireEndpointLease, release };
}

type AcquireInput = Partial<Parameters<typeof acquireBrowserMachineCarrierStreamLease>[0]>;

async function acquireWith(
    overrides: AcquireInput = {},
    streamOptions: FakeStreamOptions = {},
): Promise<{
    lease: MachineCarrierBrowserStreamLease;
    machineStream: ReturnType<typeof createFakeMachineStream>;
    endpointLease: ReturnType<typeof createEndpointLeaseBoundary>;
}> {
    const endpointLease = createEndpointLeaseBoundary();
    const machineStream = createFakeMachineStream(streamOptions);
    const lease = await acquireBrowserMachineCarrierStreamLease({
        operationId: 'prepared-browser-1',
        machineId: 'machine-1',
        serverId,
        acquireEndpointLease: endpointLease.acquireEndpointLease,
        openMachineCarrierStream: machineStream.open,
        ...overrides,
    });
    return { lease, machineStream, endpointLease };
}

describe('acquireBrowserMachineCarrierStreamLease', () => {
    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'browser_machine_carrier_test';
        serverId = (await upsertServerProfile({ serverUrl: SERVER_URL })).id;
        expect(await TokenStorage.setCredentialsForServerUrl(SERVER_URL, { serverId }, { token: targetToken })).toBe(true);
        publishEndpoint({
            endpointId: TARGET_ENDPOINT_ID,
            directAddresses: ['127.0.0.1:48123'],
            relayUrls: ['https://relay.example.test'],
        });
        grantRequests.length = 0;
        // Only the Home HTTP edge is replaced; scope, credentials, grant
        // decoding, proof and canonical handshake minting remain real.
        setRuntimeFetch(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
            expect(url.origin).toBe(SERVER_URL);
            expect(url.pathname).toBe('/v1/machines/peer/mediation/route-grants');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${targetToken}`);
            const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
            grantRequests.push(request);
            return new Response(JSON.stringify({ ok: true, grant: grantedResponse(request).value }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        });
    });

    afterEach(async () => {
        await TokenStorage.removeCredentialsForServerUrl(SERVER_URL, { serverId });
        storage.setState(originalMachineState);
        resetRuntimeFetch();
        if (previousStorageScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousStorageScope;
    });

    it('opens happier/machine/1 to the exact signed target and writes the canonical framed handshake exactly once', async () => {
        const { lease, machineStream, endpointLease } = await acquireWith();

        // The dial targets exactly the signed machine endpoint through its own
        // descriptor relays, on the machine ALPN — never a Home-tunnel stream.
        expect(machineStream.openedWith).toEqual([
            {
                alpn: 'happier/machine/1',
                endpointId: TARGET_ENDPOINT_ID,
                relayUrls: ['https://relay.example.test'],
            },
        ]);

        // One write carries the whole canonical frame: preamble, u32be length,
        // handshake JSON — the exact frame the native carrier pump writes.
        expect(machineStream.writes).toHaveLength(1);
        const frame = machineStream.writes[0]!;
        expect(frame[0]).toBe(MACHINE_CARRIER_STREAM_PREAMBLE_BYTE);
        const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
        expect(length).toBe(frame.byteLength - 5);
        const handshake = JSON.parse(new TextDecoder().decode(frame.subarray(5)));
        expect(IrohMachineHandshakeV1Schema.safeParse(handshake).success).toBe(true);
        expect(handshake.initiator).toEqual({ kind: 'account_client', endpointId: BROWSER_ENDPOINT_ID });
        expect(handshake.target).toEqual({ machineId: 'machine-1', endpointId: TARGET_ENDPOINT_ID });
        expect(handshake.flow).toBe('finite_transfer');
        expect(handshake).not.toHaveProperty('operationId');
        expect(handshake.accountId).toBe('account-from-signed-grant');

        // The one admission decision byte is consumed before any payload write.
        expect(machineStream.events.indexOf('decisionRead'))
            .toBeGreaterThan(machineStream.events.indexOf('write'));

        // The initiator is the actual shared browser endpoint from the lease,
        // minted through the one canonical grant owner with the V2 shape.
        expect(endpointLease.acquireEndpointLease).toHaveBeenCalledWith(['https://relay.example.test']);
        const grantRequest = grantRequests[0];
        if (!grantRequest?.iroh) throw new Error('Expected a canonical Iroh grant request');
        expect(grantRequest.routeKind).toBe('iroh_peer');
        expect(grantRequest.scope).toMatchObject({
            kind: 'bounded_transfer',
            mode: 'carrier',
        });
        expect(grantRequest.iroh.initiator).toEqual({ kind: 'account_client', endpointId: BROWSER_ENDPOINT_ID });
        expect(grantRequest.iroh.target).toEqual({ machineId: 'machine-1', endpointId: TARGET_ENDPOINT_ID });

        expect(lease.kind).toBe('browser_stream');
        expect(lease.remoteEndpointId).toBe(TARGET_ENDPOINT_ID);
        expect(lease.observedPath).toBe('relay');
        expect(lease.handshakeJson).toBe(JSON.stringify(handshake));
    });

    it('fails closed before any byte when the stream proves a different remote EndpointId', async () => {
        const mismatched = createFakeMachineStream({ remoteEndpointId: 'd'.repeat(64) });
        const endpointLease = createEndpointLeaseBoundary();

        await expect(acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-mismatch',
            machineId: 'machine-1',
            serverId,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: mismatched.open,
        })).rejects.toMatchObject({ errorCode: 'machine_carrier_transport_failed' });

        // Not one byte — including the handshake — reached the wrong peer, and
        // the custody taken for the acquisition was fully released.
        expect(mismatched.writes).toHaveLength(0);
        expect(mismatched.cancelCount()).toBe(1);
        expect(endpointLease.release).toHaveBeenCalledTimes(1);
    });

    it('maps an admission rejection to the existing machine-carrier failure and never a standard path', async () => {
        const rejected = createFakeMachineStream({ decisionBytes: [0x00] });
        const endpointLease = createEndpointLeaseBoundary();

        await expect(acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-reject',
            machineId: 'machine-1',
            serverId,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: rejected.open,
        })).rejects.toMatchObject({
            errorCode: 'machine_carrier_transport_failed',
            message: MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
        });

        expect(rejected.closeCount()).toBe(1);
        expect(endpointLease.release).toHaveBeenCalledTimes(1);
    });

    it('carries post-admission bytes bidirectionally through the one admitted duplex', async () => {
        const payload = new Uint8Array([1, 2, 3, 4, 5]);
        const responseChunk = new Uint8Array([9, 8, 7]);
        const { lease, machineStream } = await acquireWith({
            operationId: 'prepared-browser-bytes',
        }, { inboundChunks: [responseChunk] });

        await lease.duplex.write(payload);
        expect(machineStream.writes[1]).toEqual(payload);

        const read = await lease.duplex.read(64);
        expect(read.bytes).toEqual(responseChunk);
        expect(read.done).toBe(false);

        await lease.duplex.finishWrite();
        expect(machineStream.events).toContain('finish');
    });

    it('cancels the stream and releases custody when the caller aborts during admission', async () => {
        const hanging = createFakeMachineStream({ hangDecision: true });
        const endpointLease = createEndpointLeaseBoundary();
        const controller = new AbortController();

        const promise = acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-abort',
            machineId: 'machine-1',
            serverId,
            signal: controller.signal,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: hanging.open,
        });
        // Attach the rejection observer before awaiting admission readiness.
        const rejected = expect(promise).rejects.toMatchObject({ errorCode: 'machine_carrier_transport_failed' });
        // The handshake frame is written, then the caller aborts while the
        // decision byte is outstanding.
        await vi.waitFor(() => expect(hanging.writes).toHaveLength(1));
        controller.abort();

        await rejected;
        expect(hanging.cancelCount()).toBe(1);
        expect(endpointLease.release).toHaveBeenCalledTimes(1);
    });

    it('releases the stream and the endpoint lease exactly once across concurrent release calls', async () => {
        const { lease, machineStream, endpointLease } = await acquireWith();

        await Promise.all([lease.release(), lease.release()]);
        await lease.release();

        expect(machineStream.closeCount()).toBe(1);
        expect(endpointLease.release).toHaveBeenCalledTimes(1);
    });

    it('retains custody after a failed release and retries it on the next release call', async () => {
        const failingClose = createFakeMachineStream({
            closeError: new Error('close rejected'),
            closeErrorOnce: true,
        });
        const endpointLease = createEndpointLeaseBoundary();
        const lease = await acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-release-retry',
            machineId: 'machine-1',
            serverId,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: failingClose.open,
        });

        await expect(lease.release()).rejects.toThrow('close rejected');
        expect(endpointLease.release).toHaveBeenCalledTimes(1);

        // Custody is retained: the retry runs the whole release again instead
        // of reporting a success that never happened.
        await lease.release();
        expect(failingClose.closeCount()).toBe(2);
        expect(endpointLease.release).toHaveBeenCalledTimes(2);
    });

    it('rejects a failed endpoint lease release instead of swallowing it, then retries the whole release', async () => {
        // The endpoint lease release is the worker's forced close for the
        // stream, so a failure there is custody the worker still holds: the
        // release must observe it, not resolve as if nothing happened.
        const endpointLease = createEndpointLeaseBoundary();
        const machineStream = createFakeMachineStream();
        let releaseFailures = 1;
        endpointLease.release.mockImplementation(async () => {
            if (releaseFailures > 0) {
                releaseFailures -= 1;
                throw new Error('endpoint lease release failed');
            }
        });
        const lease = await acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-lease-retry',
            machineId: 'machine-1',
            serverId,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: machineStream.open,
        });

        await expect(lease.release()).rejects.toThrow('endpoint lease release failed');
        expect(machineStream.closeCount()).toBe(1);
        expect(endpointLease.release).toHaveBeenCalledTimes(1);

        // Custody is retained: the next explicit release runs the whole close
        // and release again and succeeds.
        await lease.release();
        expect(machineStream.closeCount()).toBe(2);
        expect(endpointLease.release).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent releases into one attempt whose failure every caller observes', async () => {
        const endpointLease = createEndpointLeaseBoundary();
        const machineStream = createFakeMachineStream();
        let rejectFirstAttempt!: (error: unknown) => void;
        const firstAttempt = new Promise<void>((_resolve, reject) => {
            rejectFirstAttempt = reject;
        });
        let attempts = 0;
        endpointLease.release.mockImplementation(async () => {
            attempts += 1;
            if (attempts === 1) await firstAttempt;
        });
        const lease = await acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-coalesce',
            machineId: 'machine-1',
            serverId,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: machineStream.open,
        });

        const first = lease.release();
        const second = lease.release();
        // Both callers join the one in-flight attempt: exactly one endpoint
        // lease release runs while it is outstanding.
        await vi.waitFor(() => expect(endpointLease.release).toHaveBeenCalledTimes(1));

        rejectFirstAttempt(new Error('endpoint lease release failed'));
        await expect(first).rejects.toThrow('endpoint lease release failed');
        await expect(second).rejects.toThrow('endpoint lease release failed');

        // The next explicit release retries the whole release and succeeds.
        await lease.release();
        expect(machineStream.closeCount()).toBe(2);
        expect(endpointLease.release).toHaveBeenCalledTimes(2);
    });

    it('surfaces a failed custody release when the acquisition itself fails', async () => {
        // The dial failure already fails the acquisition, but the failed lease
        // release during cleanup must not be swallowed behind it: the worker
        // still holds the lease, and the rejection has to say so.
        const endpointLease = createEndpointLeaseBoundary();
        endpointLease.release.mockRejectedValue(new Error('endpoint lease release failed'));
        const refusedOpen: OpenMachineCarrierStream = async () => {
            throw new Error('dial refused');
        };

        const acquisition = acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-custody',
            machineId: 'machine-1',
            serverId,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: refusedOpen,
        });

        await expect(acquisition).rejects.toThrow(/endpoint lease release failed/u);
        expect(endpointLease.release).toHaveBeenCalledTimes(1);
    });

    it('fails like the native lease owner when no signed target exists and never opens a stream', async () => {
        // Missing current endpoint authority cannot be bound by the grant owner.
        publishEndpoint(null);
        const missing = createFakeMachineStream();
        const endpointLease = createEndpointLeaseBoundary();

        await expect(acquireBrowserMachineCarrierStreamLease({
            operationId: 'prepared-browser-missing-target',
            machineId: 'machine-1',
            serverId,
            acquireEndpointLease: endpointLease.acquireEndpointLease,
            openMachineCarrierStream: missing.open,
        })).rejects.toThrow('A direct machine connection is required for this transfer.');

        expect(missing.openedWith).toHaveLength(0);
        expect(endpointLease.acquireEndpointLease).not.toHaveBeenCalled();
    });
});
