import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import {
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    MachineLiveStreamCapsV1Schema,
    PEER_MEDIATION_RECEIPTS,
    createMachineLiveStreamRelayAuthorizationSigningInputV1,
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamRelayAuthorizationPayloadV1,
    type MachineLiveStreamRelayAuthorizationV1,
} from "@happier-dev/protocol";

export type MintMachineLiveStreamRelayAuthorizationV1Result =
    | Readonly<{
        ok: true;
        relayAuthorization: MachineLiveStreamRelayAuthorizationV1;
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantMinted;
    }>
    | Readonly<{
        ok: false;
        reasonCode:
        | "blocked_by_server_policy"
        | "invalid_caps"
        | "invalid_ttl";
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantRejected;
    }>;

export type MintMachineLiveStreamRelayAuthorizationV1Input = Readonly<{
    accountId: string;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
    streamFamily: string;
    caps: MachineLiveStreamCapsV1;
    nowMs: number;
    ttlMs: number;
    serverGateEnabled: boolean;
    /**
     * Optional per-tab viewer socket id (C1). When the watcher is a user-scoped browser socket
     * rather than a peer machine, the grant must be minted bound to that socket id so the server
     * relay can deliver frames to the exact tab (`io.to(viewerSocketId)`) instead of a machine
     * room the viewer never joins. It is part of the canonical-JSON signing input, so the minted
     * payload MUST carry the same value the StartRequest will present (the protocol superRefine
     * rejects a grant whose `viewerSocketId` differs from the start request). Omitted for the
     * legacy machine→machine path.
     */
    viewerSocketId?: string;
    signingKey: Readonly<{
        keyId: string;
        secretKey: Uint8Array;
    }>;
}>;

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

export function mintMachineLiveStreamRelayAuthorizationV1(
    input: MintMachineLiveStreamRelayAuthorizationV1Input,
): MintMachineLiveStreamRelayAuthorizationV1Result {
    if (!input.serverGateEnabled) {
        return {
            ok: false,
            reasonCode: "blocked_by_server_policy",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
        return {
            ok: false,
            reasonCode: "invalid_ttl",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    const parsedCaps = MachineLiveStreamCapsV1Schema.safeParse(input.caps);
    if (!parsedCaps.success) {
        return {
            ok: false,
            reasonCode: "invalid_caps",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }

    const payload: MachineLiveStreamRelayAuthorizationPayloadV1 = {
        v: 1,
        grantId: `relay_grant_${randomUUID()}`,
        accountId: input.accountId,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        flowKind: "live_stream",
        routeKind: "server_relay",
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        ...(input.viewerSocketId ? { viewerSocketId: input.viewerSocketId } : {}),
        maxBitrateBps: parsedCaps.data.maxBitrateBps,
        maxFramesPerSecond: parsedCaps.data.maxFramesPerSecond,
        maxFrameBytes: parsedCaps.data.maxFrameBytes,
        maxDurationMs: parsedCaps.data.maxDurationMs,
        ...(parsedCaps.data.maxTotalBytes ? { maxTotalBytes: parsedCaps.data.maxTotalBytes } : {}),
        iat: input.nowMs,
        exp: input.nowMs + input.ttlMs,
        aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    };
    const signature = tweetnacl.sign.detached(
        Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload), "utf8"),
        input.signingKey.secretKey,
    );

    return {
        ok: true,
        relayAuthorization: {
            payload,
            signature: {
                keyId: input.signingKey.keyId,
                alg: "Ed25519",
                valueBase64Url: toBase64Url(signature),
            },
        },
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
    };
}
