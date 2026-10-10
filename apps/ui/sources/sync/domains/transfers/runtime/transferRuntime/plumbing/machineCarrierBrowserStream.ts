/**
 * The browser `happier/machine/1` byte-carrier seam (Lane 06 A7.4/I13).
 *
 * A browser cannot bind the native machine HTTP loopback lease, so the account
 * client carrier is the machine/1 byte stream itself: the same relay-only
 * SharedWorker endpoint dials the exact signed machine endpoint, the canonical
 * handshake is admitted, and the post-admission duplex is the byte path the
 * existing transfer owners consume. Grant minting, proof, and handshake bytes
 * are not duplicated here — they come from the one canonical mint owner in
 * `machineCarrierHttpLease`, so the browser sends exactly what native sends.
 *
 * FOUNDATION BOUNDARY: the machine/1 dial is an explicit seam,
 * {@link OpenMachineCarrierStream}, and a home-tunnel stream must never be
 * passed to it: the dial names the ALPN, and the frame below is
 * machine-admission framing, not tunnel traffic. The browser Iroh foundation
 * supplies a conforming opener — `createBrowserMachineCarrierEndpointBinding`
 * in `sync/runtime/browserIroh`, which dials the shared core's `MACHINE_ALPN`
 * on the one SharedWorker endpoint. The canonical transfer route owner loads
 * that binding only after a browser host and target descriptor are eligible.
 *
 * Wire framing is the canonical native machine pump
 * (`happier-iroh-core/src/machine.rs`): one write of
 * `[TUNNEL_PREAMBLE] || u32be(handshakeLength) || handshake JSON`, then
 * exactly one admission decision byte (`0x01` accepted, anything else
 * rejected) read before any payload byte moves. The proven remote EndpointId
 * is checked against the signed target before that first byte.
 *
 * After the signed grant is minted, every failure is the existing
 * machine-carrier transport failure. There is no standard/user-socket
 * fallback, and there is no local origin: browsers cannot bind one, and none
 * is fabricated.
 */

import {
    MACHINE_ALPN,
    MACHINE_CONTROL_TIMEOUT_MS,
    MACHINE_STREAM_ACCEPT_BYTE,
    MAX_MACHINE_HANDSHAKE_BYTES,
    TUNNEL_PREAMBLE,
} from '@happier-dev/iroh-native';
import {
    MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
    mintSignedMachineCarrierHandshake,
} from './machineCarrierHttpLease';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** The only ALPN this seam dials. Shared constant with happier-iroh-core. */
export const MACHINE_CARRIER_BROWSER_ALPN_V1 = MACHINE_ALPN;

/** happier-iroh-core `TUNNEL_PREAMBLE`. */
export const MACHINE_CARRIER_STREAM_PREAMBLE_BYTE = TUNNEL_PREAMBLE;
/**
 * happier-iroh-core `MACHINE_STREAM_ACCEPT_BYTE`. Any other decision byte —
 * including `MACHINE_STREAM_REJECT_BYTE` (0x00) — rejects admission.
 */
export const MACHINE_CARRIER_STREAM_ACCEPT_BYTE = MACHINE_STREAM_ACCEPT_BYTE;
/** happier-iroh-core `MAX_MACHINE_HANDSHAKE_BYTES`. */
export const MACHINE_CARRIER_HANDSHAKE_MAX_BYTES = MAX_MACHINE_HANDSHAKE_BYTES;
/** happier-iroh-core `MACHINE_CONTROL_TIMEOUT`. */
export const MACHINE_CARRIER_STREAM_CONTROL_TIMEOUT_MS = MACHINE_CONTROL_TIMEOUT_MS;

/**
 * The one post-selection failure. The transfer families already classify
 * `machine_carrier_transport_failed` with the interrupted-transfer copy; this
 * seam surfaces the same contract so integration maps it one-to-one.
 */
export type BrowserMachineCarrierErrorCode = 'machine_carrier_transport_failed';

export class BrowserMachineCarrierStreamError extends Error {
    constructor(readonly errorCode: BrowserMachineCarrierErrorCode, message: string) {
        super(message);
        this.name = 'BrowserMachineCarrierStreamError';
    }
}

/**
 * The admitted machine/1 duplex. Shaped like the browser Iroh incremental
 * stream handle so the future foundation opener is a pass-through.
 */
export type MachineCarrierStreamDuplex = Readonly<{
    remoteEndpointId: string;
    observedPath: 'direct' | 'relay' | 'unknown';
    read: (maxBytes: number) => Promise<Readonly<{ bytes: Uint8Array; done: boolean }>>;
    write: (bytes: Uint8Array) => Promise<void>;
    finishWrite: () => Promise<void>;
    cancel: () => void | Promise<void>;
    close: () => Promise<void>;
}>;

/**
 * The machine/1 dial boundary the browser Iroh foundation must add (A7.4
 * gate): dial `happier/machine/1` to `endpointId` through `relayUrls` on the
 * one shared browser endpoint and return the raw stream plus the EndpointId
 * the transport cryptographically proved. It must never be satisfied with a
 * `happier/home-tunnel/1` stream.
 */
export type OpenMachineCarrierStream = (input: Readonly<{
    alpn: typeof MACHINE_CARRIER_BROWSER_ALPN_V1;
    endpointId: string;
    relayUrls: readonly string[];
    signal?: AbortSignal;
}>) => Promise<MachineCarrierStreamDuplex>;

/**
 * One lease on the one shared browser endpoint (the SharedWorker owner's).
 * Production wiring passes a lease acquired on the tab's shared packaged
 * endpoint client (`resolvePackagedBrowserIrohEndpointClient().acquireLease`)
 * adapted to this shape; the endpoint id is the initiator transport identity.
 */
export type BrowserMachineCarrierEndpointLease = Readonly<{
    endpointId: string;
    release: () => Promise<void> | void;
}>;

export type AcquireBrowserMachineCarrierEndpointLease = (
    relayUrls: readonly string[],
) => Promise<BrowserMachineCarrierEndpointLease>;

export type MachineCarrierBrowserStreamLease = Readonly<{
    kind: 'browser_stream';
    /** The EndpointId the transport proved; equals the signed target. */
    remoteEndpointId: string;
    observedPath: 'direct' | 'relay' | 'unknown';
    handshakeJson: string;
    /**
     * The admitted byte pipe to the target daemon's fixed loopback application
     * port. Application bytes only — the handshake was admitted above it.
     */
    duplex: MachineCarrierStreamDuplex;
    /**
     * Closes the carrier stream and releases the endpoint lease. Exactly one
     * release runs at a time; concurrent callers share the attempt, and any
     * failed step — the direct close or the endpoint lease release — rejects
     * and retains custody for a retry instead of reporting a success that
     * never happened.
     */
    release: () => Promise<void>;
}>;

export async function acquireBrowserMachineCarrierStreamLease(input: Readonly<{
    operationId: string;
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime;
    acquireEndpointLease: AcquireBrowserMachineCarrierEndpointLease;
    openMachineCarrierStream: OpenMachineCarrierStream;
}>): Promise<MachineCarrierBrowserStreamLease> {
    // Custody taken during acquisition is released on every failure path; on
    // success it moves into the returned lease's release.
    const custody: { endpointLease: BrowserMachineCarrierEndpointLease | null } = { endpointLease: null };
    try {
        const minted = await mintSignedMachineCarrierHandshake({
            machineId: input.machineId,
            serverId: input.serverId,
            accountLifetime: input.accountLifetime,
            resolveInitiatorEndpointId: async (relayUrls) => {
                const lease = await input.acquireEndpointLease(relayUrls);
                custody.endpointLease = lease;
                return lease.endpointId;
            },
        });

        const endpointLease = custody.endpointLease;
        if (!endpointLease) {
            throw new BrowserMachineCarrierStreamError(
                'machine_carrier_transport_failed',
                'The browser machine carrier acquired no shared endpoint identity.',
            );
        }
        const stream = await openAdmittedMachineStream({
            input: { signal: input.signal, openMachineCarrierStream: input.openMachineCarrierStream },
            minted,
        });
        custody.endpointLease = null;

        let release: Promise<void> | null = null;
        return {
            kind: 'browser_stream',
            remoteEndpointId: stream.remoteEndpointId,
            observedPath: stream.observedPath,
            handshakeJson: minted.handshakeJson,
            duplex: stream.duplex,
            release: () => {
                if (release === null) {
                    release = releaseAdmittedStream(stream, endpointLease).catch((error: unknown) => {
                        // Retain custody for a retry; the next release runs the
                        // whole close again instead of a success that never
                        // happened.
                        release = null;
                        throw error;
                    });
                }
                return release;
            },
        };
    } finally {
        if (custody.endpointLease !== null) {
            // Custody taken during acquisition is released on every failure
            // path, and a failed release is never swallowed behind the
            // operation's own failure: the worker still holds the lease, so
            // the caller must see that release outcome.
            await Promise.resolve(custody.endpointLease.release());
        }
    }
}

type AdmittedStream = Readonly<{
    remoteEndpointId: string;
    observedPath: 'direct' | 'relay' | 'unknown';
    duplex: MachineCarrierStreamDuplex;
}>;

/**
 * Opens the machine/1 stream, proves the remote identity against the signed
 * target before any byte, writes the canonical handshake frame exactly once,
 * and consumes the one admission decision byte. Every failure is the typed
 * machine-carrier transport failure and leaves nothing behind for a caller to
 * fall back with.
 */
async function openAdmittedMachineStream(params: Readonly<{
    input: Readonly<{
        signal?: AbortSignal;
        openMachineCarrierStream: OpenMachineCarrierStream;
    }>;
    minted: Awaited<ReturnType<typeof mintSignedMachineCarrierHandshake>>;
}>): Promise<AdmittedStream> {
    const { input, minted } = params;
    let stream: MachineCarrierStreamDuplex;
    try {
        stream = await input.openMachineCarrierStream({
            alpn: MACHINE_CARRIER_BROWSER_ALPN_V1,
            endpointId: minted.signedTargetEndpointId,
            relayUrls: minted.currentTargetRelayUrls,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    } catch (error) {
        // A dial that never produced a stream has nothing to clean up here —
        // the opener owns its own failure — but after selection it is still
        // the one typed machine-carrier transport failure.
        throw new BrowserMachineCarrierStreamError(
            'machine_carrier_transport_failed',
            error instanceof Error ? error.message : MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
        );
    }

    try {
        // The proven peer is checked before one byte — including the signed
        // handshake — reaches the wire.
        if (stream.remoteEndpointId !== minted.signedTargetEndpointId) {
            throw new BrowserMachineCarrierStreamError(
                'machine_carrier_transport_failed',
                'Browser machine carrier proved a remote EndpointId other than the signed target.',
            );
        }

        const handshakeBytes = new TextEncoder().encode(minted.handshakeJson);
        if (
            handshakeBytes.byteLength === 0
            || handshakeBytes.byteLength > MACHINE_CARRIER_HANDSHAKE_MAX_BYTES
        ) {
            throw new BrowserMachineCarrierStreamError(
                'machine_carrier_transport_failed',
                `Browser machine carrier handshake is ${handshakeBytes.byteLength} bytes, outside the canonical 1..${MACHINE_CARRIER_HANDSHAKE_MAX_BYTES} bound.`,
            );
        }

        const frame = new Uint8Array(5 + handshakeBytes.byteLength);
        frame[0] = MACHINE_CARRIER_STREAM_PREAMBLE_BYTE;
        new DataView(frame.buffer).setUint32(1, handshakeBytes.byteLength, false);
        frame.set(handshakeBytes, 5);
        await raceWithControlGuards(stream.write(frame), input.signal);

        const decision = await raceWithControlGuards(stream.read(1), input.signal);
        if (decision.done || decision.bytes.byteLength < 1) {
            // The peer stopped before one admission decision byte arrived.
            throw new BrowserMachineCarrierStreamError(
                'machine_carrier_transport_failed',
                MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
            );
        }
        if (decision.bytes[0] !== MACHINE_CARRIER_STREAM_ACCEPT_BYTE) {
            throw new BrowserMachineCarrierStreamError(
                'machine_carrier_transport_failed',
                MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
            );
        }
        return { remoteEndpointId: stream.remoteEndpointId, observedPath: stream.observedPath, duplex: stream };
    } catch (error) {
        await Promise.resolve(stream.cancel()).catch(() => undefined);
        await stream.close().catch(() => undefined);
        if (error instanceof BrowserMachineCarrierStreamError) throw error;
        throw new BrowserMachineCarrierStreamError(
            'machine_carrier_transport_failed',
            error instanceof Error ? error.message : MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
        );
    }
}

async function releaseAdmittedStream(
    stream: AdmittedStream,
    endpointLease: BrowserMachineCarrierEndpointLease,
): Promise<void> {
    try {
        await stream.duplex.close();
    } finally {
        // Releasing the lease is the endpoint owner's forced close for any
        // stream this client still holds, so it runs even when the direct
        // close failed — and a failed lease release rejects: the caller keeps
        // custody and retries instead of reporting a success that never
        // happened.
        await Promise.resolve(endpointLease.release());
    }
}

/**
 * Bounds one control-plane operation with the native machine control timeout
 * and the caller's abort signal, so a silent peer cannot hold the acquisition
 * open. The abort itself is not special-cased: after selection, cancellation
 * is the same typed transport failure.
 */
async function raceWithControlGuards<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const guards = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new BrowserMachineCarrierStreamError(
                'machine_carrier_transport_failed',
                'The browser machine carrier admission decision did not arrive in time.',
            )),
            MACHINE_CARRIER_STREAM_CONTROL_TIMEOUT_MS,
        );
        if (signal) {
            onAbort = () => reject(signalAbortReason(signal));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    // Settled guards are consumed only when raced; sink the rejection so an
    // uncontested guard is never an unhandled rejection.
    guards.catch(() => undefined);
    try {
        return await Promise.race([operation, guards]);
    } finally {
        if (timer !== null) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}

function signalAbortReason(signal: AbortSignal): unknown {
    const reason: unknown = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason !== undefined) return reason;
    const fallback = new Error('The browser machine carrier request was aborted');
    fallback.name = 'AbortError';
    return fallback;
}
