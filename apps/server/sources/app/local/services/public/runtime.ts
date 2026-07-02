import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
    LocalServicePublicExposureV1Schema,
    type LocalServicePublicAuditEventV1,
    type LocalServicePublicExposureModeV1,
    type LocalServicePublicExposureV1,
    type LocalServicePublicPolicyV1,
    type LocalServicePreviewResourceV1,
} from "@happier-dev/protocol";

import {
    isLocalServicePublicExposureAccessible,
    resolveLocalServicePublicExposureDecision,
    type LocalServicePublicExposureRejectionReason,
} from "@/app/local/services/public/policy";

type PublicAccessFailureReason =
    | "exposure_not_found"
    | "expired"
    | "revoked"
    | "rate_limited"
    | "authentication_required"
    | "public_token_missing"
    | "public_token_mismatch";

export type LocalServicePublicRuntimeCreateResult =
    | Readonly<{
          ok: true;
          exposure: LocalServicePublicExposureV1;
      }>
    | Readonly<{
          ok: false;
          reasonCode: LocalServicePublicExposureRejectionReason | "invalid_public_base_url" | "public_token_secret_missing";
      }>;

export type LocalServicePublicRuntimeAccessResult =
    | Readonly<{ ok: true; preview: LocalServicePreviewResourceV1 }>
    | Readonly<{ ok: false; reasonCode: PublicAccessFailureReason }>;

export type LocalServicePublicRuntime = Readonly<{
    createExposure(input: Readonly<{
        preview: LocalServicePreviewResourceV1;
        requestedMode: LocalServicePublicExposureModeV1;
        requestedTtlMs: number;
        actorId: string;
        sessionAuthorized: boolean;
        dnsTlsValid: boolean;
        rateLimitProfileId: string;
    }>): LocalServicePublicRuntimeCreateResult;
    resolveExposure(exposureId: string): LocalServicePublicExposureV1 | null;
    validateAccess(input: Readonly<{
        exposureId: string;
        rawToken: string | null;
        authenticated: boolean;
    }>): LocalServicePublicRuntimeAccessResult;
    revokeExposure(exposureId: string, input: Readonly<{ actorId: string }>): Readonly<{
        ok: true;
    } | {
        ok: false;
        reasonCode: "exposure_not_found";
    }>;
}>;

export type CreateLocalServicePublicRuntimeInput = Readonly<{
    publicBaseUrl: string | null | undefined;
    tokenSecret?: string | null;
    policy: unknown;
    nowMs?: () => number;
    generateExposureId?: () => string;
    generateSecretToken?: () => string;
    generateAuditEventId?: () => string;
    recordAuditEvent?: (event: LocalServicePublicAuditEventV1) => void;
    checkRateLimit?: (input: Readonly<{ exposure: LocalServicePublicExposureV1; nowMs: number }>) => boolean;
}>;

type ExposureEntry = Readonly<{
    preview: LocalServicePreviewResourceV1;
    exposure: LocalServicePublicExposureV1;
    secretTokenHash: string | null;
}>;

function defaultSecretToken(): string {
    return randomBytes(32).toString("base64url");
}

function nonEmptyString(value: string | null | undefined): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsePublicBaseUrl(value: string | null | undefined): URL | null {
    const raw = nonEmptyString(value);
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
        return null;
    }
}

function publicExposureUrl(input: Readonly<{
    publicBaseUrl: URL;
    exposureId: string;
    secretToken: string | null;
}>): string {
    const url = new URL(`/v1/local-services/public/${encodeURIComponent(input.exposureId)}`, input.publicBaseUrl.origin);
    if (input.secretToken) {
        url.searchParams.set("publicToken", input.secretToken);
    }
    return url.toString();
}

function hashToken(secret: string, token: string): string {
    return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createLocalServicePublicRuntime(
    input: CreateLocalServicePublicRuntimeInput,
): LocalServicePublicRuntime {
    const entries = new Map<string, ExposureEntry>();
    const nowMs = input.nowMs ?? Date.now;
    const generateExposureId = input.generateExposureId ?? randomUUID;
    const generateSecretToken = input.generateSecretToken ?? defaultSecretToken;
    const generateAuditEventId = input.generateAuditEventId ?? randomUUID;

    function appendAuditEvent(
        exposure: LocalServicePublicExposureV1,
        event: Omit<LocalServicePublicAuditEventV1, "eventId" | "occurredAt">,
    ): LocalServicePublicExposureV1 {
        const auditEvent: LocalServicePublicAuditEventV1 = {
            ...event,
            eventId: generateAuditEventId(),
            occurredAt: nowMs(),
        };
        input.recordAuditEvent?.(auditEvent);
        return {
            ...exposure,
            auditEventIds: [...exposure.auditEventIds, auditEvent.eventId],
        };
    }

    function createExposure(createInput: Readonly<{
        preview: LocalServicePreviewResourceV1;
        requestedMode: LocalServicePublicExposureModeV1;
        requestedTtlMs: number;
        actorId: string;
        sessionAuthorized: boolean;
        dnsTlsValid: boolean;
        rateLimitProfileId: string;
    }>): LocalServicePublicRuntimeCreateResult {
        const publicBaseUrl = parsePublicBaseUrl(input.publicBaseUrl);
        if (!publicBaseUrl) {
            return { ok: false, reasonCode: "invalid_public_base_url" };
        }

        const decisionNowMs = nowMs();
        const activeExposureCount = Array.from(entries.values()).filter((entry) => (
            isLocalServicePublicExposureAccessible({ exposure: entry.exposure, nowMs: decisionNowMs })
        )).length;
        const decision = resolveLocalServicePublicExposureDecision({
            policy: input.policy,
            requestedMode: createInput.requestedMode,
            requestedTtlMs: createInput.requestedTtlMs,
            nowMs: decisionNowMs,
            previewEligible: true,
            sessionAuthorized: createInput.sessionAuthorized,
            dnsTlsValid: createInput.dnsTlsValid,
            rateLimitProfileId: createInput.rateLimitProfileId,
            activeExposureCount,
        });
        if (!decision.ok) {
            return decision;
        }

        const secretToken = decision.mode === "secret_link" ? generateSecretToken() : null;
        const tokenSecret = nonEmptyString(input.tokenSecret);
        if (secretToken && !tokenSecret) {
            return { ok: false, reasonCode: "public_token_secret_missing" };
        }

        const exposureId = generateExposureId();
        const issuedAt = nowMs();
        let exposure: LocalServicePublicExposureV1 = {
            exposureId,
            previewId: createInput.preview.previewId,
            sessionId: createInput.preview.sessionId,
            machineId: createInput.preview.machineId,
            mode: decision.mode,
            state: "active",
            publicUrl: publicExposureUrl({
                publicBaseUrl,
                exposureId,
                secretToken,
            }),
            issuedAt,
            expiresAt: decision.expiresAt,
            auditEventIds: [],
            rateLimitProfileId: decision.rateLimitProfileId,
        };
        exposure = appendAuditEvent(exposure, {
            exposureId,
            action: "create",
            actorId: createInput.actorId,
        });

        const parsed = LocalServicePublicExposureV1Schema.safeParse(exposure);
        if (!parsed.success) {
            return { ok: false, reasonCode: "invalid_policy" };
        }

        entries.set(exposureId, {
            preview: createInput.preview,
            exposure: parsed.data,
            secretTokenHash: secretToken && tokenSecret ? hashToken(tokenSecret, secretToken) : null,
        });
        return { ok: true, exposure: parsed.data };
    }

    function resolveExposure(exposureId: string): LocalServicePublicExposureV1 | null {
        return entries.get(exposureId)?.exposure ?? null;
    }

    function inaccessibleReason(exposure: LocalServicePublicExposureV1): PublicAccessFailureReason | null {
        if (isLocalServicePublicExposureAccessible({ exposure, nowMs: nowMs() })) {
            return null;
        }
        if (exposure.state === "revoked" || (typeof exposure.revokedAt === "number" && exposure.revokedAt <= nowMs())) {
            return "revoked";
        }
        if (exposure.state === "rate_limited") {
            return "rate_limited";
        }
        return "expired";
    }

    function validateAccess(validateInput: Readonly<{
        exposureId: string;
        rawToken: string | null;
        authenticated: boolean;
    }>): LocalServicePublicRuntimeAccessResult {
        const entry = entries.get(validateInput.exposureId);
        if (!entry) {
            return { ok: false, reasonCode: "exposure_not_found" };
        }

        const unavailableReason = inaccessibleReason(entry.exposure);
        if (unavailableReason) {
            return { ok: false, reasonCode: unavailableReason };
        }

        if (input.checkRateLimit && !input.checkRateLimit({ exposure: entry.exposure, nowMs: nowMs() })) {
            const updated = {
                ...entry.exposure,
                state: "rate_limited" as const,
            };
            entries.set(validateInput.exposureId, { ...entry, exposure: updated });
            return { ok: false, reasonCode: "rate_limited" };
        }

        if (entry.exposure.mode === "authenticated" && !validateInput.authenticated) {
            return { ok: false, reasonCode: "authentication_required" };
        }

        if (entry.exposure.mode === "secret_link") {
            const tokenSecret = nonEmptyString(input.tokenSecret);
            if (!validateInput.rawToken || !tokenSecret || !entry.secretTokenHash) {
                return { ok: false, reasonCode: "public_token_missing" };
            }
            if (!hashesMatch(entry.secretTokenHash, hashToken(tokenSecret, validateInput.rawToken))) {
                return { ok: false, reasonCode: "public_token_mismatch" };
            }
        }

        return { ok: true, preview: entry.preview };
    }

    function revokeExposure(
        exposureId: string,
        revokeInput: Readonly<{ actorId: string }>,
    ): Readonly<{ ok: true } | { ok: false; reasonCode: "exposure_not_found" }> {
        const entry = entries.get(exposureId);
        if (!entry) {
            return { ok: false, reasonCode: "exposure_not_found" };
        }
        const revoked = appendAuditEvent({
            ...entry.exposure,
            state: "revoked",
            revokedAt: nowMs(),
        }, {
            exposureId,
            action: "revoke",
            actorId: revokeInput.actorId,
        });
        entries.set(exposureId, { ...entry, exposure: revoked });
        return { ok: true };
    }

    return {
        createExposure,
        resolveExposure,
        validateAccess,
        revokeExposure,
    };
}
