import { createHash } from "node:crypto";

import type {
    LiveActivityApnsDeliveryClassification,
    LiveActivityRemoteUpdateRequestV1,
} from "@happier-dev/protocol";
import type { AccountLiveActivityTarget, Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { recordLiveActivityTargetFailure } from "../recordLiveActivityTargetFailure";
import type { LiveActivityHostedRelayConfig } from "../resolveLiveActivityRemoteTransport";
import { decryptLiveActivityTargetSecret } from "./directApnsLiveActivityProvider";

export type HostedRelayLiveActivityDeliveryResult = Readonly<{
    targetId: string;
    status: "sent" | "coalesced" | "failed";
    classification?: LiveActivityApnsDeliveryClassification;
    apnsId?: string;
    tokenFingerprint?: string;
    duplicate?: boolean;
    code?: string;
}>;

export type SendHostedRelayLiveActivityUpdateParams = Readonly<{
    target: AccountLiveActivityTarget;
    request: LiveActivityRemoteUpdateRequestV1;
    config: Pick<LiveActivityHostedRelayConfig, "baseUrl" | "accessKey">;
    now: Date;
    fetchImpl?: typeof fetch;
}>;

type HostedRelayResponseBody = Readonly<{
    success?: boolean;
    status?: "sent" | "coalesced" | "failed";
    classification?: LiveActivityApnsDeliveryClassification;
    apnsId?: string;
    tokenFingerprint?: string;
    duplicate?: boolean;
    code?: string;
}>;

function payloadHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hostedRelayUrl(baseUrl: string): string {
    return new URL("/v1/live-activity-hosted-relay", baseUrl).toString();
}

function buildConfigFailure(reason: string): LiveActivityApnsDeliveryClassification {
    return { action: "operator_config", reason };
}

function buildTransientFailure(reason: string): LiveActivityApnsDeliveryClassification {
    return { action: "transient_retry", reason };
}

async function recordFailure(
    targetId: string,
    now: Date,
    code: string,
    classification: LiveActivityApnsDeliveryClassification,
    diagnostics: Prisma.InputJsonValue,
): Promise<void> {
    await recordLiveActivityTargetFailure({
        targetId,
        now,
        code,
        classification,
        diagnostics,
    });
}

async function recordSuccess(
    targetId: string,
    now: Date,
    hash: string,
    diagnostics: Prisma.InputJsonValue,
): Promise<void> {
    await db.accountLiveActivityTarget.update({
        where: { id: targetId },
        data: {
            lastPushedAt: now,
            lastPayloadHash: hash,
            failureCount: 0,
            lastFailureCode: null,
            diagnostics,
        },
    });
}

function classificationToJson(
    classification: LiveActivityApnsDeliveryClassification | undefined,
): Prisma.InputJsonObject | null {
    if (!classification) return null;
    return {
        action: classification.action,
        reason: classification.reason ?? null,
    };
}

function sanitizeRelayDiagnostics(body: HostedRelayResponseBody): Prisma.InputJsonObject {
    const relay: Prisma.InputJsonObject = {
        status: body.status ?? "failed",
        classification: classificationToJson(body.classification),
        apnsId: body.apnsId ?? null,
        tokenFingerprint: body.tokenFingerprint ?? null,
        duplicate: body.duplicate === true,
        code: body.code ?? null,
    };
    return {
        relay,
    };
}

async function readRelayResponse(response: Response): Promise<HostedRelayResponseBody> {
    try {
        const parsed = await response.json();
        return parsed && typeof parsed === "object" ? parsed as HostedRelayResponseBody : {};
    } catch {
        return {};
    }
}

export async function sendHostedRelayLiveActivityUpdate(
    params: SendHostedRelayLiveActivityUpdateParams,
): Promise<HostedRelayLiveActivityDeliveryResult> {
    if (!params.config.baseUrl) {
        const classification = buildConfigFailure("hosted_relay_base_url_missing");
        await recordFailure(params.target.id, params.now, "hosted_relay_base_url_missing", classification, { relay: { classification } });
        return { targetId: params.target.id, status: "failed", classification, code: "hosted_relay_base_url_missing" };
    }
    if (!params.config.accessKey) {
        const classification = buildConfigFailure("hosted_relay_access_key_missing");
        await recordFailure(params.target.id, params.now, "hosted_relay_access_key_missing", classification, { relay: { classification } });
        return { targetId: params.target.id, status: "failed", classification, code: "hosted_relay_access_key_missing" };
    }
    if (!params.target.bundleId || !params.target.environment) {
        const classification = buildConfigFailure("hosted_relay_target_invalid");
        await recordFailure(params.target.id, params.now, "hosted_relay_target_invalid", classification, { relay: { classification } });
        return { targetId: params.target.id, status: "failed", classification, code: "hosted_relay_target_invalid" };
    }

    const activityKitUpdateToken = decryptLiveActivityTargetSecret(params.target, "rawToken");
    if (!activityKitUpdateToken) {
        const classification = buildConfigFailure("activitykit_update_token_missing");
        await recordFailure(params.target.id, params.now, "activitykit_update_token_missing", classification, { relay: { classification } });
        return { targetId: params.target.id, status: "failed", classification, code: "activitykit_update_token_missing" };
    }

    const relayRequest = {
        v: 1,
        requestId: params.request.requestId,
        createdAt: params.request.createdAt,
        bundleId: params.target.bundleId,
        environment: params.target.environment,
        activityName: params.target.activityName,
        activityId: params.target.activityId,
        activityKitUpdateToken,
        update: params.request,
    };
    const hash = payloadHash({
        ...relayRequest,
        activityKitUpdateToken: payloadHash(activityKitUpdateToken),
    });
    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${params.config.accessKey}`,
    };

    let response: Response;
    try {
        response = await fetchImpl(hostedRelayUrl(params.config.baseUrl), {
            method: "POST",
            headers,
            body: JSON.stringify(relayRequest),
        });
    } catch {
        const classification = buildTransientFailure("hosted_relay_transport_error");
        const diagnostics = sanitizeRelayDiagnostics({
            status: "failed",
            classification,
            code: "hosted_relay_transport_error",
        });
        await recordFailure(params.target.id, params.now, "hosted_relay_transport_error", classification, diagnostics);
        return {
            targetId: params.target.id,
            status: "failed",
            classification,
            code: "hosted_relay_transport_error",
        };
    }
    const body = await readRelayResponse(response);
    const classification = body.classification ?? (
        response.ok
            ? { action: "success" as const }
            : { action: response.status >= 500 ? "transient_retry" as const : "unknown_failure" as const, reason: body.code ?? `hosted_relay_http_${response.status}` }
    );
    const diagnostics = sanitizeRelayDiagnostics({ ...body, classification });

    if (response.ok && body.success !== false && (body.status === "sent" || body.status === "coalesced" || !body.status)) {
        await recordSuccess(params.target.id, params.now, params.request.snapshotFingerprint, diagnostics);
        return {
            targetId: params.target.id,
            status: body.status ?? "sent",
            classification,
            apnsId: body.apnsId,
            tokenFingerprint: body.tokenFingerprint,
            duplicate: body.duplicate,
        };
    }

    const code = body.code ?? classification.reason ?? `hosted_relay_http_${response.status}`;
    await recordFailure(params.target.id, params.now, code, classification, diagnostics);
    return {
        targetId: params.target.id,
        status: "failed",
        classification,
        apnsId: body.apnsId,
        tokenFingerprint: body.tokenFingerprint,
        code,
    };
}
