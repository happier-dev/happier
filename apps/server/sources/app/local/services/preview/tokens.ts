import { createHmac, timingSafeEqual } from "node:crypto";

import type { LocalServicePreviewTokenV1 } from "@happier-dev/protocol";

export type LocalServicePreviewTokenRecord = LocalServicePreviewTokenV1 & Readonly<{
    tokenHash: string;
    revokedAt?: number;
    /** Host-admitted viewer; never part of the transported bearer-token schema. */
    actorAccountId?: string;
}>;

export type CreateLocalServicePreviewTokenInput = Readonly<{
    secret: string;
    tokenId: string;
    rawToken: string;
    previewId: string;
    sessionId: string | undefined;
    machineId: string;
    issuedAt: number;
    expiresAt: number | null;
    exchangeMode: "url" | "cookie";
    actorAccountId?: string;
}>;

export type LocalServicePreviewTokenValidationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: "binding_mismatch" | "expired" | "not_yet_valid" | "revoked" | "token_mismatch" | "exchange_mode_mismatch" }>;

export type ValidateLocalServicePreviewTokenInput = Readonly<{
    secret: string;
    rawToken: string;
    record: LocalServicePreviewTokenRecord;
    previewId: string;
    sessionId: string | undefined;
    machineId: string;
    nowMs: number;
    expectedExchangeMode?: "url" | "cookie";
}>;

export function hashLocalServicePreviewToken(secret: string, rawToken: string): string {
    return createHmac("sha256", secret).update(rawToken, "utf8").digest("hex");
}

function requireNonEmpty(value: string, field: string): void {
    if (value.trim().length === 0) {
        throw new Error(`Local service preview token ${field} is required.`);
    }
}

function assertValidTokenWindow(issuedAt: number, expiresAt: number): void {
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
        throw new Error("Local service preview token expiry must follow issuance.");
    }
}

function hashesMatch(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createLocalServicePreviewToken(input: CreateLocalServicePreviewTokenInput): Readonly<{
    token: string;
    record: LocalServicePreviewTokenRecord;
}> {
    requireNonEmpty(input.secret, "secret");
    requireNonEmpty(input.rawToken, "raw token");
    requireNonEmpty(input.tokenId, "id");
    if (input.expiresAt === null) {
        if (input.exchangeMode !== 'cookie' || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
            throw new Error('Only registered viewer sessions may omit expiry.');
        }
    } else {
        assertValidTokenWindow(input.issuedAt, input.expiresAt);
    }

    return {
        token: input.rawToken,
        record: {
            kind: "preview_access",
            tokenId: input.tokenId,
            previewId: input.previewId,
            sessionId: input.sessionId,
            machineId: input.machineId,
            issuedAt: input.issuedAt,
            expiresAt: input.expiresAt,
            exchangeMode: input.exchangeMode,
            tokenHash: hashLocalServicePreviewToken(input.secret, input.rawToken),
            ...(input.actorAccountId ? { actorAccountId: input.actorAccountId } : {}),
        },
    };
}

export function validateLocalServicePreviewToken(
    input: ValidateLocalServicePreviewTokenInput,
): LocalServicePreviewTokenValidationResult {
    if (
        input.record.previewId !== input.previewId ||
        input.record.sessionId !== input.sessionId ||
        input.record.machineId !== input.machineId
    ) {
        return { ok: false, reasonCode: "binding_mismatch" };
    }
    if (typeof input.record.revokedAt === "number" && input.record.revokedAt <= input.nowMs) {
        return { ok: false, reasonCode: "revoked" };
    }
    if (input.nowMs < input.record.issuedAt) {
        return { ok: false, reasonCode: "not_yet_valid" };
    }
    if (input.record.expiresAt === null
        ? input.record.exchangeMode !== 'cookie'
        : input.nowMs >= input.record.expiresAt) {
        return { ok: false, reasonCode: "expired" };
    }
    if (input.expectedExchangeMode && input.record.exchangeMode !== input.expectedExchangeMode) {
        return { ok: false, reasonCode: "exchange_mode_mismatch" };
    }
    if (!hashesMatch(input.record.tokenHash, hashLocalServicePreviewToken(input.secret, input.rawToken))) {
        return { ok: false, reasonCode: "token_mismatch" };
    }
    return { ok: true };
}
