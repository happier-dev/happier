import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
    DaemonLocalServicePublicPreviewStatusRequestV1Schema,
    LocalServicePublicExposureV1Schema,
    LocalServicePublicPolicyV1Schema,
    LocalServicePublicPreviewSnapshotV1Schema,
    type DaemonLocalServicePublicPreviewStatusRequestV1,
    type LocalServicePublicAuditEventV1,
    type LocalServicePublicExposureModeV1,
    type LocalServicePublicExposureV1,
    type LocalServicePublicPolicyV1,
    type LocalServicePublicPreviewSnapshotV1,
    type LocalServicePreviewDiagnosticV1,
    type LocalServicePreviewResourceV1,
} from "@happier-dev/protocol";

import {
    isLocalServicePublicExposureAccessible,
    resolveLocalServicePublicExposureDecision,
    type LocalServicePublicExposureRejectionReason,
} from "@/app/local/services/public/policy";
import { resolveLocalServiceHostOrigin } from "@/app/local/services/preview/origin";

type PublicAccessFailureReason =
    | "exposure_not_found"
    | "preview_not_found"
    | "preview_mismatch"
    | "expired"
    | "revoked"
    | "rate_limited"
    | "authentication_required"
    | "session_not_authorized"
    | "public_token_missing"
    | "public_token_exchange_required"
    | "public_token_mismatch"
    | "audit_sink_unavailable"
    | "rate_limit_checker_unavailable";

export type LocalServicePublicRuntimeCreateResult =
    | Readonly<{
          ok: true;
          exposure: LocalServicePublicExposureV1;
      }>
    | Readonly<{
          ok: false;
          reasonCode:
              | LocalServicePublicExposureRejectionReason
              | "invalid_public_base_url"
              | "public_origin_unavailable"
              | "public_token_secret_missing"
              | "audit_sink_unavailable"
              | "rate_limit_checker_unavailable";
      }>;

export type LocalServicePublicRuntimeAccessResult =
    | Readonly<{ ok: true; preview: LocalServicePreviewResourceV1 }>
    | Readonly<{ ok: false; reasonCode: PublicAccessFailureReason }>;

/**
 * S-2: `authenticated` alone only proves the caller holds SOME account on this server. An
 * `authenticated` exposure is bound to one session, so the caller must additionally hold access
 * to that session — `sessionAuthorized` carries that fact. It is required (never optional) so a
 * caller cannot omit it and silently reopen the co-tenant hole.
 *
 * S-5: `clientKey` identifies the requesting client for rate-limit bucketing, so one visitor
 * cannot exhaust the window for every other visitor of the same exposure.
 */
export type LocalServicePublicRuntimeAccessInput = Readonly<{
    exposureId: string;
    rawToken: string | null;
    authenticated: boolean;
    sessionAuthorized: boolean;
    clientKey: string;
}>;

type PublicExchangeFailureReason =
    | "exposure_not_found"
    | "preview_not_found"
    | "preview_mismatch"
    | "expired"
    | "revoked"
    | "rate_limited"
    | "exchange_not_supported"
    | "public_token_missing"
    | "public_token_mismatch"
    | "public_token_secret_missing"
    | "audit_sink_unavailable";

export type LocalServicePublicRuntimeExchangeResult =
    | Readonly<{
          ok: true;
          exposureId: string;
          rawToken: string;
          expiresAt: number;
      }>
    | Readonly<{ ok: false; reasonCode: PublicExchangeFailureReason }>;

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
    validateAccess(input: LocalServicePublicRuntimeAccessInput): LocalServicePublicRuntimeAccessResult;
    exchangeAccessToken(input: Readonly<{
        exposureId: string;
        rawToken: string | null;
    }>): LocalServicePublicRuntimeExchangeResult;
    revokeExposure(exposureId: string, input: Readonly<{ actorId: string }>): Readonly<{
        ok: true;
    } | {
        ok: false;
        reasonCode: "exposure_not_found" | "audit_sink_unavailable";
    }>;
    getSnapshot(request: DaemonLocalServicePublicPreviewStatusRequestV1): LocalServicePublicPreviewSnapshotV1;
}>;

export type CreateLocalServicePublicRuntimeInput = Readonly<{
    publicBaseUrl: string | null | undefined;
    tokenSecret?: string | null;
    policy: unknown;
    nowMs?: () => number;
    generateExposureId?: () => string;
    generateSecretToken?: () => string;
    generateAuditEventId?: () => string;
    auditSinkDurable?: boolean;
    allowTestDevAuditSink?: boolean;
    recordAuditEvent?: (event: LocalServicePublicAuditEventV1) => void;
    hostOriginBaseDomain?: string | null;
    checkRateLimit?: (input: Readonly<{
        exposure: LocalServicePublicExposureV1;
        clientKey: string;
        nowMs: number;
    }>) => boolean;
    resolvePreview?: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    maxExposureAuditEventIds?: number;
}>;

type ExposureEntry = Readonly<{
    preview: LocalServicePreviewResourceV1;
    exposure: LocalServicePublicExposureV1;
    secretTokenHash: string | null;
    secretTokenPurpose: "url_exchange" | "access" | null;
}>;

type AppendAuditEventResult =
    | Readonly<{ ok: true; exposure: LocalServicePublicExposureV1 }>
    | Readonly<{ ok: false; reasonCode: "audit_sink_unavailable" }>;

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
    exposureOrigin: string;
    exposureId: string;
    secretToken: string | null;
}>): string {
    const url = new URL(`/v1/local-services/public/${encodeURIComponent(input.exposureId)}`, input.exposureOrigin);
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

function normalizeMaxAuditEventIds(value: number | null | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 256;
    return Math.max(1, Math.floor(value));
}

function defaultPublicPolicy(): LocalServicePublicPolicyV1 {
    return LocalServicePublicPolicyV1Schema.parse({});
}

function previewOwnerMatches(left: LocalServicePreviewResourceV1["owner"], right: LocalServicePreviewResourceV1["owner"]): boolean {
    return left.kind === right.kind && left.id === right.id;
}

function previewTargetMatches(left: LocalServicePreviewResourceV1["target"], right: LocalServicePreviewResourceV1["target"]): boolean {
    return left.scheme === right.scheme && left.host === right.host && left.port === right.port;
}

function previewStillMatchesExposureSnapshot(input: Readonly<{
    current: LocalServicePreviewResourceV1;
    snapshot: LocalServicePreviewResourceV1;
}>): boolean {
    return input.current.previewId === input.snapshot.previewId
        && input.current.sessionId === input.snapshot.sessionId
        && input.current.machineId === input.snapshot.machineId
        && previewOwnerMatches(input.current.owner, input.snapshot.owner)
        && previewTargetMatches(input.current.target, input.snapshot.target);
}

export function createLocalServicePublicRuntime(
    input: CreateLocalServicePublicRuntimeInput,
): LocalServicePublicRuntime {
    const entries = new Map<string, ExposureEntry>();
    const nowMs = input.nowMs ?? Date.now;
    const generateExposureId = input.generateExposureId ?? randomUUID;
    const generateSecretToken = input.generateSecretToken ?? defaultSecretToken;
    const generateAuditEventId = input.generateAuditEventId ?? randomUUID;
    const maxExposureAuditEventIds = normalizeMaxAuditEventIds(input.maxExposureAuditEventIds);
    const parsedRuntimePolicy = LocalServicePublicPolicyV1Schema.safeParse(input.policy);
    const snapshotPolicy = parsedRuntimePolicy.success ? parsedRuntimePolicy.data : defaultPublicPolicy();

    function hasRequiredAuditSink(): boolean {
        if (!parsedRuntimePolicy.success || !parsedRuntimePolicy.data.auditRequired) {
            return true;
        }
        return Boolean(input.recordAuditEvent)
            && (input.auditSinkDurable === true || input.allowTestDevAuditSink === true);
    }

    function appendAuditEvent(
        exposure: LocalServicePublicExposureV1,
        event: Omit<LocalServicePublicAuditEventV1, "eventId" | "occurredAt">,
    ): AppendAuditEventResult {
        if (!hasRequiredAuditSink()) {
            return { ok: false, reasonCode: "audit_sink_unavailable" };
        }
        const auditEvent: LocalServicePublicAuditEventV1 = {
            ...event,
            eventId: generateAuditEventId(),
            occurredAt: nowMs(),
        };
        try {
            input.recordAuditEvent?.(auditEvent);
        } catch {
            return { ok: false, reasonCode: "audit_sink_unavailable" };
        }
        const auditEventIds = [...exposure.auditEventIds, auditEvent.eventId].slice(-maxExposureAuditEventIds);
        return {
            ok: true,
            exposure: {
                ...exposure,
                auditEventIds,
            },
        };
    }

    function updateExposureEntry(
        entry: ExposureEntry,
        exposure: LocalServicePublicExposureV1,
    ): ExposureEntry {
        const updated = { ...entry, exposure };
        entries.set(exposure.exposureId, updated);
        return updated;
    }

    function appendAuditEventToEntry(
        entry: ExposureEntry,
        event: Omit<LocalServicePublicAuditEventV1, "eventId" | "occurredAt">,
    ): Readonly<{ ok: true; entry: ExposureEntry } | { ok: false; reasonCode: "audit_sink_unavailable" }> {
        const result = appendAuditEvent(entry.exposure, event);
        if (!result.ok) return result;
        return { ok: true, entry: updateExposureEntry(entry, result.exposure) };
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
        if (!parsedRuntimePolicy.success) {
            return { ok: false, reasonCode: "invalid_policy" };
        }
        if (!hasRequiredAuditSink()) {
            return { ok: false, reasonCode: "audit_sink_unavailable" };
        }
        // S-5 / INV-1: abuse control is a hard prerequisite, not a conditional one. Without a
        // checker there is no rate limiting at all, so the exposure must not be minted.
        if (!input.checkRateLimit) {
            return { ok: false, reasonCode: "rate_limit_checker_unavailable" };
        }

        const secretToken = decision.mode === "secret_link" ? generateSecretToken() : null;
        const tokenSecret = nonEmptyString(input.tokenSecret);
        if (secretToken && !tokenSecret) {
            return { ok: false, reasonCode: "public_token_secret_missing" };
        }

        const exposureId = generateExposureId();
        // S-3: an exposed local service serves untrusted content. Minting it on the API origin
        // would put that content same-origin with the API and with every other exposure and
        // preview on the host. Refuse rather than fall back.
        const exposureOrigin = resolveLocalServiceHostOrigin({
            publicBaseUrl: publicBaseUrl.toString(),
            hostOriginBaseDomain: input.hostOriginBaseDomain,
            resourceId: exposureId,
        });
        if (!exposureOrigin.ok) {
            return { ok: false, reasonCode: "public_origin_unavailable" };
        }
        const issuedAt = nowMs();
        let exposure: LocalServicePublicExposureV1 = {
            exposureId,
            previewId: createInput.preview.previewId,
            sessionId: createInput.preview.sessionId,
            machineId: createInput.preview.machineId,
            mode: decision.mode,
            state: "active",
            publicUrl: publicExposureUrl({
                exposureOrigin: exposureOrigin.origin,
                exposureId,
                secretToken,
            }),
            issuedAt,
            expiresAt: decision.expiresAt,
            auditEventIds: [],
            rateLimitProfileId: decision.rateLimitProfileId,
        };
        const auditResult = appendAuditEvent(exposure, {
            exposureId,
            action: "create",
            actorId: createInput.actorId,
        });
        if (!auditResult.ok) {
            return auditResult;
        }
        exposure = auditResult.exposure;

        const parsed = LocalServicePublicExposureV1Schema.safeParse(exposure);
        if (!parsed.success) {
            return { ok: false, reasonCode: "invalid_policy" };
        }

        entries.set(exposureId, {
            preview: createInput.preview,
            exposure: parsed.data,
            secretTokenHash: secretToken && tokenSecret ? hashToken(tokenSecret, secretToken) : null,
            secretTokenPurpose: secretToken ? "url_exchange" : null,
        });
        return { ok: true, exposure: parsed.data };
    }

    function resolveExposure(exposureId: string): LocalServicePublicExposureV1 | null {
        return entries.get(exposureId)?.exposure ?? null;
    }

    function expireExposureIfNeeded(
        entry: ExposureEntry,
        now: number,
    ): Readonly<{ ok: true; entry: ExposureEntry } | { ok: false; reasonCode: "audit_sink_unavailable" }> {
        if (entry.exposure.state !== "active" || now < entry.exposure.expiresAt) {
            return { ok: true, entry };
        }
        const auditResult = appendAuditEvent({
            ...entry.exposure,
            state: "expired",
        }, {
            exposureId: entry.exposure.exposureId,
            action: "expire",
        });
        if (!auditResult.ok) return auditResult;
        return { ok: true, entry: updateExposureEntry(entry, auditResult.exposure) };
    }

    function inaccessibleReason(
        exposure: LocalServicePublicExposureV1,
        now: number,
    ): "revoked" | "rate_limited" | "expired" | null {
        if (isLocalServicePublicExposureAccessible({ exposure, nowMs: now })) {
            return null;
        }
        if (exposure.state === "revoked" || (typeof exposure.revokedAt === "number" && exposure.revokedAt <= now)) {
            return "revoked";
        }
        if (exposure.state === "rate_limited") {
            return "rate_limited";
        }
        return "expired";
    }

    function denyAccess(
        entry: ExposureEntry,
        reasonCode: PublicAccessFailureReason,
    ): LocalServicePublicRuntimeAccessResult {
        const auditResult = appendAuditEventToEntry(entry, {
            exposureId: entry.exposure.exposureId,
            action: "access_denied",
            reasonCode,
        });
        if (!auditResult.ok) return auditResult;
        return { ok: false, reasonCode };
    }

    function resolveCurrentPreviewForAccess(
        entry: ExposureEntry,
    ): Readonly<{ ok: true; preview: LocalServicePreviewResourceV1 } | { ok: false; reasonCode: "preview_not_found" | "preview_mismatch" }> {
        const currentPreview = input.resolvePreview
            ? input.resolvePreview(entry.exposure.previewId)
            : entry.preview;
        if (!currentPreview) {
            return { ok: false, reasonCode: "preview_not_found" };
        }
        if (!previewStillMatchesExposureSnapshot({ current: currentPreview, snapshot: entry.preview })) {
            return { ok: false, reasonCode: "preview_mismatch" };
        }
        return { ok: true, preview: currentPreview };
    }

    function validateAccess(validateInput: LocalServicePublicRuntimeAccessInput): LocalServicePublicRuntimeAccessResult {
        let entry = entries.get(validateInput.exposureId);
        if (!entry) {
            return { ok: false, reasonCode: "exposure_not_found" };
        }

        const accessNowMs = nowMs();
        const expiryResult = expireExposureIfNeeded(entry, accessNowMs);
        if (!expiryResult.ok) return expiryResult;
        entry = expiryResult.entry;
        const unavailableReason = inaccessibleReason(entry.exposure, accessNowMs);
        if (unavailableReason) {
            return denyAccess(entry, unavailableReason);
        }

        if (entry.exposure.mode === "authenticated") {
            if (!validateInput.authenticated) {
                return denyAccess(entry, "authentication_required");
            }
            // S-2: holding an account on this server is not authorization for someone else's
            // exposed service. The exposure is bound to a session; require access to it.
            if (!validateInput.sessionAuthorized) {
                return denyAccess(entry, "session_not_authorized");
            }
        }

        if (entry.exposure.mode === "secret_link") {
            const tokenSecret = nonEmptyString(input.tokenSecret);
            if (!validateInput.rawToken || !tokenSecret || !entry.secretTokenHash) {
                return denyAccess(entry, "public_token_missing");
            }
            if (entry.secretTokenPurpose !== "access") {
                return denyAccess(entry, "public_token_exchange_required");
            }
            if (!hashesMatch(entry.secretTokenHash, hashToken(tokenSecret, validateInput.rawToken))) {
                return denyAccess(entry, "public_token_mismatch");
            }
        }

        const currentPreview = resolveCurrentPreviewForAccess(entry);
        if (!currentPreview.ok) {
            return denyAccess(entry, currentPreview.reasonCode);
        }

        // S-5 / INV-1: no checker means no abuse control, so access fails closed rather than open.
        if (!input.checkRateLimit) {
            return denyAccess(entry, "rate_limit_checker_unavailable");
        }

        let rateLimitAllowed = false;
        try {
            rateLimitAllowed = input.checkRateLimit({
                exposure: entry.exposure,
                clientKey: validateInput.clientKey,
                nowMs: accessNowMs,
            });
        } catch {
            return denyAccess(entry, "rate_limit_checker_unavailable");
        }

        if (!rateLimitAllowed) {
            // S-5: rate limiting is a property of THIS request, not of the exposure. Persisting
            // `state:'rate_limited'` made `isLocalServicePublicExposureAccessible` treat the link
            // as permanently dead, so one visitor bricked it for everyone. Audit and deny; the
            // next request in the next window succeeds.
            const rateLimitAuditResult = appendAuditEventToEntry(entry, {
                exposureId: entry.exposure.exposureId,
                action: "rate_limit",
            });
            if (!rateLimitAuditResult.ok) return rateLimitAuditResult;
            return denyAccess(rateLimitAuditResult.entry, "rate_limited");
        }

        const auditResult = appendAuditEventToEntry(entry, {
            exposureId: entry.exposure.exposureId,
            action: "access",
        });
        if (!auditResult.ok) return auditResult;
        return { ok: true, preview: currentPreview.preview };
    }

    function exchangeAccessToken(exchangeInput: Readonly<{
        exposureId: string;
        rawToken: string | null;
    }>): LocalServicePublicRuntimeExchangeResult {
        let entry = entries.get(exchangeInput.exposureId);
        if (!entry) {
            return { ok: false, reasonCode: "exposure_not_found" };
        }

        const exchangeNowMs = nowMs();
        const expiryResult = expireExposureIfNeeded(entry, exchangeNowMs);
        if (!expiryResult.ok) return expiryResult;
        entry = expiryResult.entry;
        const unavailableReason = inaccessibleReason(entry.exposure, exchangeNowMs);
        if (unavailableReason) {
            return { ok: false, reasonCode: unavailableReason };
        }

        if (entry.exposure.mode !== "secret_link") {
            return { ok: false, reasonCode: "exchange_not_supported" };
        }

        const tokenSecret = nonEmptyString(input.tokenSecret);
        if (!exchangeInput.rawToken || !tokenSecret || !entry.secretTokenHash) {
            return { ok: false, reasonCode: "public_token_missing" };
        }
        if (entry.secretTokenPurpose !== "url_exchange") {
            return { ok: false, reasonCode: "public_token_mismatch" };
        }
        if (!hashesMatch(entry.secretTokenHash, hashToken(tokenSecret, exchangeInput.rawToken))) {
            return { ok: false, reasonCode: "public_token_mismatch" };
        }

        const currentPreview = resolveCurrentPreviewForAccess(entry);
        if (!currentPreview.ok) {
            return { ok: false, reasonCode: currentPreview.reasonCode };
        }

        const rotatedToken = generateSecretToken();
        entries.set(entry.exposure.exposureId, {
            ...entry,
            secretTokenHash: hashToken(tokenSecret, rotatedToken),
            secretTokenPurpose: "access",
        });
        return {
            ok: true,
            exposureId: entry.exposure.exposureId,
            rawToken: rotatedToken,
            expiresAt: entry.exposure.expiresAt,
        };
    }

    function revokeExposure(
        exposureId: string,
        revokeInput: Readonly<{ actorId: string }>,
    ): Readonly<{ ok: true } | { ok: false; reasonCode: "exposure_not_found" | "audit_sink_unavailable" }> {
        const entry = entries.get(exposureId);
        if (!entry) {
            return { ok: false, reasonCode: "exposure_not_found" };
        }
        const auditResult = appendAuditEvent({
            ...entry.exposure,
            state: "revoked",
            revokedAt: nowMs(),
        }, {
            exposureId,
            action: "revoke",
            actorId: revokeInput.actorId,
        });
        if (!auditResult.ok) return auditResult;
        entries.set(exposureId, { ...entry, exposure: auditResult.exposure });
        return { ok: true };
    }

    function entryMatchesStatusRequest(
        entry: ExposureEntry,
        request: DaemonLocalServicePublicPreviewStatusRequestV1,
    ): boolean {
        return entry.exposure.machineId === request.machineId
            && (!request.sessionId || entry.exposure.sessionId === request.sessionId)
            && (!request.previewId || entry.exposure.previewId === request.previewId)
            && (!request.exposureId || entry.exposure.exposureId === request.exposureId);
    }

    function getSnapshot(
        rawRequest: DaemonLocalServicePublicPreviewStatusRequestV1,
    ): LocalServicePublicPreviewSnapshotV1 {
        const request = DaemonLocalServicePublicPreviewStatusRequestV1Schema.parse(rawRequest);
        const generatedAt = nowMs();
        const diagnostics: LocalServicePreviewDiagnosticV1[] = [];
        const exposures: LocalServicePublicExposureV1[] = [];

        for (const entry of entries.values()) {
            if (!entryMatchesStatusRequest(entry, request)) continue;
            const expiryResult = expireExposureIfNeeded(entry, generatedAt);
            if (expiryResult.ok) {
                exposures.push(expiryResult.entry.exposure);
                continue;
            }
            diagnostics.push({
                v: 1,
                code: "public_policy_denied",
                severity: "error",
                scope: "publicPreview",
                previewId: entry.exposure.previewId,
                publicExposureId: entry.exposure.exposureId,
                emittedAtMs: generatedAt,
                details: {
                    reasonCode: expiryResult.reasonCode,
                },
            });
            exposures.push(entry.exposure);
        }

        exposures.sort((left, right) => (
            left.issuedAt - right.issuedAt || left.exposureId.localeCompare(right.exposureId)
        ));

        return LocalServicePublicPreviewSnapshotV1Schema.parse({
            v: 1,
            machineId: request.machineId,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
            ...(request.previewId ? { previewId: request.previewId } : {}),
            generatedAt,
            refreshState: diagnostics.length > 0 ? "error" : "idle",
            policy: snapshotPolicy,
            exposures,
            diagnostics,
        });
    }

    return {
        createExposure,
        resolveExposure,
        validateAccess,
        exchangeAccessToken,
        revokeExposure,
        getSnapshot,
    };
}
