import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import { MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1, MachineLiveStreamCapsV1Schema, MachineLiveStreamRelayAuthorizationPayloadV1Schema, createMachineLiveStreamRelayAuthorizationSigningInputV1, type MachineLiveStreamCapsV1, type MachineLiveStreamSourceAdmissionBindingV1, type MachineLiveStreamRelayAuthorizationV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { type MachineLiveStreamCodecIdV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import type { SocketRpcSessionBrowserAuthorizationContext } from '@happier-dev/protocol/socketRpc';

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
    sourceId?: string;
    codecId?: MachineLiveStreamCodecIdV1;
    viewerCodecs?: readonly MachineLiveStreamCodecIdV1[];
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
    /** Present only after the installed source proof and its canonical access admission agree. */
    personalViewer?: Readonly<{
        viewerAccountId: string;
        sourceMachineInstallationId: string;
        personalSourceAdmission: MachineLiveStreamSourceAdmissionBindingV1;
        sessionBrowserAccess?: SocketRpcSessionBrowserAuthorizationContext;
    }>;
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

    const payload = MachineLiveStreamRelayAuthorizationPayloadV1Schema.parse({
        v: input.personalViewer ? 2 : 1,
        ...(input.personalViewer ?? {}),
        grantId: `relay_grant_${randomUUID()}`,
        accountId: input.accountId,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        flowKind: "live_stream",
        routeKind: "server_relay",
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.codecId ? { codecId: input.codecId } : {}),
        ...(input.viewerCodecs ? { viewerCodecs: [...input.viewerCodecs] } : {}),
        ...(input.viewerSocketId ? { viewerSocketId: input.viewerSocketId } : {}),
        ...(parsedCaps.data.maxBitrateBps !== undefined ? { maxBitrateBps: parsedCaps.data.maxBitrateBps } : {}),
        ...(parsedCaps.data.maxFramesPerSecond !== undefined ? { maxFramesPerSecond: parsedCaps.data.maxFramesPerSecond } : {}),
        ...(parsedCaps.data.maxFrameBytes !== undefined ? { maxFrameBytes: parsedCaps.data.maxFrameBytes } : {}),
        ...(parsedCaps.data.maxDurationMs !== undefined ? { maxDurationMs: parsedCaps.data.maxDurationMs } : {}),
        ...(parsedCaps.data.maxTotalBytes ? { maxTotalBytes: parsedCaps.data.maxTotalBytes } : {}),
        iat: input.nowMs,
        exp: input.nowMs + input.ttlMs,
        aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    });
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
