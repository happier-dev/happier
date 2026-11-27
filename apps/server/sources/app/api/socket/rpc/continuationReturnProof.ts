import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SocketRpcContinuationReturnV1 } from "@happier-dev/protocol/socketRpc";

const CONTINUATION_RETURN_PROOF_DOMAIN = "happier.socketRpc.continuationReturn.v1";

let ephemeralFallbackKey: Buffer | null = null;

function resolveContinuationReturnHmacKey(): Buffer | string {
    const masterSecret = process.env.HANDY_MASTER_SECRET?.trim();
    if (masterSecret) return masterSecret;
    if (!ephemeralFallbackKey) {
        ephemeralFallbackKey = randomBytes(32);
    }
    return ephemeralFallbackKey;
}

function computeContinuationReturnProof(params: Readonly<{
    targetSocketId: string;
    targetRequestId: string;
    callerSocketId: string;
    callerRequestId: string;
}>): string {
    const canonical = JSON.stringify([
        CONTINUATION_RETURN_PROOF_DOMAIN,
        params.targetSocketId,
        params.targetRequestId,
        params.callerSocketId,
        params.callerRequestId,
    ]);
    return createHmac("sha256", resolveContinuationReturnHmacKey())
        .update(canonical, "utf8")
        .digest("base64url");
}

export function signSocketRpcContinuationReturn(params: Readonly<{
    returnTo: SocketRpcContinuationReturnV1;
    targetSocketId: string;
    targetRequestId: string;
}>): SocketRpcContinuationReturnV1 {
    return {
        socketId: params.returnTo.socketId,
        requestId: params.returnTo.requestId,
        proof: computeContinuationReturnProof({
            targetSocketId: params.targetSocketId,
            targetRequestId: params.targetRequestId,
            callerSocketId: params.returnTo.socketId,
            callerRequestId: params.returnTo.requestId,
        }),
    };
}

export function verifySocketRpcContinuationReturn(params: Readonly<{
    returnTo: SocketRpcContinuationReturnV1;
    targetSocketId: string;
    targetRequestId: string;
}>): boolean {
    if (typeof params.returnTo.proof !== "string" || params.returnTo.proof.length === 0) {
        return false;
    }
    const expected = computeContinuationReturnProof({
        targetSocketId: params.targetSocketId,
        targetRequestId: params.targetRequestId,
        callerSocketId: params.returnTo.socketId,
        callerRequestId: params.returnTo.requestId,
    });
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(params.returnTo.proof, "utf8");
    return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}
