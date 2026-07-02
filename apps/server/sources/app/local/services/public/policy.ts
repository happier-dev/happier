import {
    LocalServicePublicPolicyV1Schema,
    type LocalServicePublicExposureModeV1,
    type LocalServicePublicExposureV1,
    type LocalServicePublicPolicyV1,
} from "@happier-dev/protocol";

export type LocalServicePublicExposureRejectionReason =
    | "public_preview_disabled"
    | "preview_not_eligible"
    | "session_not_authorized"
    | "mode_not_allowed"
    | "dns_tls_unavailable"
    | "rate_limit_profile_not_allowed"
    | "too_many_public_exposures"
    | "invalid_policy";

export type LocalServicePublicExposureDecision =
    | Readonly<{
          ok: true;
          mode: LocalServicePublicExposureModeV1;
          ttlMs: number;
          expiresAt: number;
          rateLimitProfileId: string;
      }>
    | Readonly<{
          ok: false;
          reasonCode: LocalServicePublicExposureRejectionReason;
      }>;

export type ResolveLocalServicePublicExposureDecisionInput = Readonly<{
    policy: unknown;
    requestedMode: LocalServicePublicExposureModeV1;
    requestedTtlMs: number;
    nowMs: number;
    previewEligible: boolean;
    sessionAuthorized: boolean;
    dnsTlsValid: boolean;
    rateLimitProfileId: string;
    activeExposureCount?: number;
}>;

function normalizeRequestedTtlMs(requestedTtlMs: number, policy: LocalServicePublicPolicyV1): number {
    const requested = Number.isFinite(requestedTtlMs) ? Math.floor(requestedTtlMs) : 0;
    const positiveRequested = requested > 0 ? requested : 1;
    return typeof policy.maxTtlMs === "number" ? Math.min(positiveRequested, policy.maxTtlMs) : positiveRequested;
}

function isRateLimitProfileAllowed(policy: LocalServicePublicPolicyV1, rateLimitProfileId: string): boolean {
    return policy.rateLimitProfileIds.length === 0 || policy.rateLimitProfileIds.includes(rateLimitProfileId);
}

export function resolveLocalServicePublicExposureDecision(
    input: ResolveLocalServicePublicExposureDecisionInput,
): LocalServicePublicExposureDecision {
    const parsedPolicy = LocalServicePublicPolicyV1Schema.safeParse(input.policy);
    if (!parsedPolicy.success) {
        return { ok: false, reasonCode: "invalid_policy" };
    }

    const policy = parsedPolicy.data;
    if (!policy.enabled) {
        return { ok: false, reasonCode: "public_preview_disabled" };
    }
    if (!input.previewEligible) {
        return { ok: false, reasonCode: "preview_not_eligible" };
    }
    if (!input.sessionAuthorized) {
        return { ok: false, reasonCode: "session_not_authorized" };
    }
    if (!policy.allowedModes.includes(input.requestedMode)) {
        return { ok: false, reasonCode: "mode_not_allowed" };
    }
    if (policy.dnsTlsRequired && !input.dnsTlsValid) {
        return { ok: false, reasonCode: "dns_tls_unavailable" };
    }
    if (!isRateLimitProfileAllowed(policy, input.rateLimitProfileId)) {
        return { ok: false, reasonCode: "rate_limit_profile_not_allowed" };
    }
    if (
        typeof policy.maxConcurrentExposures === "number"
        && typeof input.activeExposureCount === "number"
        && input.activeExposureCount >= policy.maxConcurrentExposures
    ) {
        return { ok: false, reasonCode: "too_many_public_exposures" };
    }
    if (typeof policy.maxTtlMs !== "number") {
        return { ok: false, reasonCode: "invalid_policy" };
    }

    const ttlMs = normalizeRequestedTtlMs(input.requestedTtlMs, policy);
    return {
        ok: true,
        mode: input.requestedMode,
        ttlMs,
        expiresAt: input.nowMs + ttlMs,
        rateLimitProfileId: input.rateLimitProfileId,
    };
}

export function isLocalServicePublicExposureAccessible(input: Readonly<{
    exposure: LocalServicePublicExposureV1;
    nowMs: number;
}>): boolean {
    if (input.exposure.state !== "active") {
        return false;
    }
    if (typeof input.exposure.revokedAt === "number" && input.exposure.revokedAt <= input.nowMs) {
        return false;
    }
    return input.nowMs < input.exposure.expiresAt;
}
