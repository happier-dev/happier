import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "psm1";
const TOKEN_MAX_LENGTH = 4096;

export const PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER = "x-public-share-messages-access-token";
export const PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;

export type PublicShareUseLimit =
    | Readonly<{ type: "unlimited" }>
    | Readonly<{ type: "capped"; maxUses: number }>
    | Readonly<{ type: "invalid" }>;

type GrantPayload = Readonly<{
    v: 1;
    psid: string;
    sid: string;
    th: string;
    iat: number;
    exp: number;
}>;

export function resolvePublicShareUseLimit(maxUses: number | null | undefined): PublicShareUseLimit {
    if (maxUses === null || maxUses === undefined) return { type: "unlimited" };
    if (!Number.isInteger(maxUses) || maxUses <= 0) return { type: "invalid" };
    return { type: "capped", maxUses };
}

export function requirePublicShareAccessGrantSecret(env: NodeJS.ProcessEnv = process.env): string {
    const secret = (env.HANDY_MASTER_SECRET ?? "").toString().trim();
    if (!secret) {
        throw new Error("HANDY_MASTER_SECRET is required for public share message access grants");
    }
    return secret;
}

function signGrantPayload(secret: string, payloadHex: string): string {
    return createHmac("sha256", secret).update(payloadHex, "utf8").digest("hex");
}

function safeHex(value: string): boolean {
    return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

function signaturesMatch(left: string, right: string): boolean {
    if (!safeHex(left) || !safeHex(right)) return false;
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePayload(payloadHex: string): GrantPayload | null {
    if (!safeHex(payloadHex)) return null;
    try {
        const decoded = JSON.parse(Buffer.from(payloadHex, "hex").toString("utf8"));
        if (!decoded || typeof decoded !== "object") return null;
        if ((decoded as { v?: unknown }).v !== 1) return null;
        const payload = decoded as Partial<GrantPayload>;
        if (
            typeof payload.psid !== "string" ||
            typeof payload.sid !== "string" ||
            typeof payload.th !== "string" ||
            typeof payload.iat !== "number" ||
            typeof payload.exp !== "number"
        ) {
            return null;
        }
        return {
            v: 1,
            psid: payload.psid,
            sid: payload.sid,
            th: payload.th,
            iat: payload.iat,
            exp: payload.exp,
        };
    } catch {
        return null;
    }
}

export function createPublicShareMessagesAccessToken(input: Readonly<{
    secret: string;
    publicShareId: string;
    sessionId: string;
    tokenHashHex: string;
    nowMs?: number;
    ttlMs?: number;
}>): string {
    const nowMs = Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs as number) : Date.now();
    const ttlMs = Number.isFinite(input.ttlMs) ? Math.trunc(input.ttlMs as number) : PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_TTL_MS;
    const payload: GrantPayload = {
        v: 1,
        psid: input.publicShareId,
        sid: input.sessionId,
        th: input.tokenHashHex,
        iat: nowMs,
        exp: nowMs + Math.max(1, ttlMs),
    };
    const payloadHex = Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
    return `${TOKEN_PREFIX}.${payloadHex}.${signGrantPayload(input.secret, payloadHex)}`;
}

export function validatePublicShareMessagesAccessToken(input: Readonly<{
    secret: string;
    token: string | null | undefined;
    publicShareId: string;
    sessionId: string;
    tokenHashHex: string;
    nowMs?: number;
}>): boolean {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token || token.length > TOKEN_MAX_LENGTH) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return false;
    const [, payloadHex, signature] = parts;
    if (!signaturesMatch(signature, signGrantPayload(input.secret, payloadHex))) return false;

    const payload = parsePayload(payloadHex);
    if (!payload) return false;
    const nowMs = Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs as number) : Date.now();
    return (
        payload.psid === input.publicShareId &&
        payload.sid === input.sessionId &&
        payload.th === input.tokenHashHex &&
        nowMs < payload.exp
    );
}
