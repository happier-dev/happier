import {
    encodeBase64,
    PluginWebhookDeliveryContentV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";

import { readPluginWebhookVerificationCredentialsV1 } from "./credentialStore";
import { admitPluginWebhookDeliveryV1 } from "./deliveryStore";
import { createPluginWebhookDeliveryIdentityDigestV1 } from "./deliveryIdentity";
import { extractVerifiedGitHubInstallationIdV1 } from "./githubInstallationRouting";
import {
    findActivePluginWebhookRouteV1,
    resolveActivePluginWebhookEndpointV1,
    type ActivePluginWebhookEndpointV1,
    type ActivePluginWebhookRouteV1,
} from "./routeStore";
import {
    createPluginWebhookStoredEnvelopeV1,
    type PluginWebhookStoredEnvelopeReadyV1,
} from "./storedEnvelope";
import { createGitHubWebhookHmacSha256V1Verifier } from "./verifiers/githubHmacSha256";
import type { PluginWebhookCommittedDeliveryWakeV1 } from "./wake";

const GITHUB_DELIVERY_ID_PATTERN_V1 = /^[A-Za-z0-9._:-]{1,128}$/u;
const GITHUB_EVENT_PATTERN_V1 = /^[A-Za-z0-9._-]{1,128}$/u;
const CONTENT_TYPE_PATTERN_V1 = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u;

type AccountEnvelopeRowV1 = Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>;

type AdmissionResultV1 = Awaited<ReturnType<typeof admitPluginWebhookDeliveryV1>>;

export type PluginWebhookIngestDependenciesV1 = Readonly<{
    findRoute: (opaqueRouteId: string) => Promise<ActivePluginWebhookRouteV1 | null>;
    readCredentials: (params: Readonly<{ routeId: string; now?: Date }>) => Promise<ReadonlyArray<Readonly<{
        credentialVersionId: string;
        secret: string;
    }>>>;
    parseInstallationId: (rawBody: Uint8Array) => string | null;
    resolveEndpoint: (params: Readonly<{
        routeId: string;
        routingKind: "accountEndpoint" | "providerInstallation";
        providerInstallationId?: string;
    }>) => Promise<ActivePluginWebhookEndpointV1 | null>;
    readAccount: (accountId: string) => Promise<AccountEnvelopeRowV1 | null>;
    admitDelivery: (params: Readonly<{
        endpointId: string;
        expectedEndpointRevision: number;
        routeId: string;
        verifierKind: "github_hmac_sha256_v1";
        credentialVersionId: string;
        deliveryIdentityDigest: string;
        stored: PluginWebhookStoredEnvelopeReadyV1;
        now?: Date;
        deadlineAtMs?: number;
        onCommittedWake?: (wake: PluginWebhookCommittedDeliveryWakeV1) => void;
    }>) => Promise<AdmissionResultV1>;
}>;

const DEFAULT_DEPENDENCIES: PluginWebhookIngestDependenciesV1 = {
    findRoute: findActivePluginWebhookRouteV1,
    readCredentials: readPluginWebhookVerificationCredentialsV1,
    parseInstallationId(rawBody) {
        const parsed = extractVerifiedGitHubInstallationIdV1(rawBody);
        return parsed.ok ? parsed.installationId : null;
    },
    resolveEndpoint: resolveActivePluginWebhookEndpointV1,
    async readAccount(accountId) {
        return await db.account.findUnique({
            where: { id: accountId },
            select: {
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
    },
    admitDelivery: admitPluginWebhookDeliveryV1,
};

function readSingleHeader(headers: Readonly<Record<string, unknown>>, name: string): string | null {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return typeof value === "string" ? value : null;
}

function normalizeContentType(value: string | null): string | null {
    if (!value) return null;
    const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    return mediaType.length <= 128 && CONTENT_TYPE_PATTERN_V1.test(mediaType) ? mediaType : null;
}

export type PluginWebhookIngestResultV1 =
    | Readonly<{ kind: "accepted"; deliveryId: string; duplicate: boolean }>
    | Readonly<{ kind: "rejected"; statusCode: 401 | 404 | 503; code: "unauthorized" | "not_found" | "unavailable" }>;

export type VerifiedPluginWebhookSignatureV1 = Readonly<{
    route: ActivePluginWebhookRouteV1;
    providerDeliveryId: string;
    credentialVersionId: string;
}>;

export type PreparedPluginWebhookSignatureVerifierV1 = Readonly<{
    verifier: Readonly<{
        route: ActivePluginWebhookRouteV1;
        providerDeliveryId: string;
        update(chunk: Uint8Array): void;
        verify(): VerifiedPluginWebhookSignatureV1 | null;
    }>;
}>;

export type PluginWebhookSignaturePreparationResultV1 =
    | (Readonly<{ kind: "ready" }> & PreparedPluginWebhookSignatureVerifierV1)
    | Extract<PluginWebhookIngestResultV1, { kind: "rejected" }>;

export async function preparePluginWebhookSignatureVerifierV1(params: Readonly<{
    opaqueRouteId: string;
    headers: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
    now?: Date;
    dependencies?: PluginWebhookIngestDependenciesV1;
}>): Promise<PluginWebhookSignaturePreparationResultV1> {
    const dependencies = params.dependencies ?? DEFAULT_DEPENDENCIES;
    const now = params.now ?? new Date();
    const unavailableIfAborted = (): Extract<PluginWebhookIngestResultV1, { kind: "rejected" }> | null => (
        params.signal?.aborted
            ? { kind: "rejected", statusCode: 503, code: "unavailable" }
            : null
    );
    const beforeRoute = unavailableIfAborted();
    if (beforeRoute) return beforeRoute;
    const route = await dependencies.findRoute(params.opaqueRouteId);
    const afterRoute = unavailableIfAborted();
    if (afterRoute) return afterRoute;
    if (!route) return { kind: "rejected", statusCode: 404, code: "not_found" };

    const providerDeliveryId = readSingleHeader(params.headers, "x-github-delivery");
    const signatureHeader = readSingleHeader(params.headers, "x-hub-signature-256");
    if (!providerDeliveryId || !GITHUB_DELIVERY_ID_PATTERN_V1.test(providerDeliveryId)) {
        return { kind: "rejected", statusCode: 401, code: "unauthorized" };
    }
    const credentials = await dependencies.readCredentials({ routeId: route.routeId, now });
    const afterCredentials = unavailableIfAborted();
    if (afterCredentials) return afterCredentials;
    const verifiers = credentials.map((credential) => ({
        credentialVersionId: credential.credentialVersionId,
        verifier: createGitHubWebhookHmacSha256V1Verifier(credential.secret),
    }));
    let finalized = false;
    return {
        kind: "ready",
        verifier: {
            route,
            providerDeliveryId,
            update(chunk) {
                if (finalized) throw new Error("Webhook signature verifier has already been finalized");
                for (const candidate of verifiers) candidate.verifier.update(chunk);
            },
            verify() {
                if (finalized) return null;
                finalized = true;
                for (const candidate of verifiers) {
                    if (candidate.verifier.verify(signatureHeader)) {
                        return {
                            route,
                            providerDeliveryId,
                            credentialVersionId: candidate.credentialVersionId,
                        };
                    }
                }
                return null;
            },
        },
    };
}

export async function admitVerifiedPluginWebhookV1(params: Readonly<{
    verification: VerifiedPluginWebhookSignatureV1;
    rawBody: Uint8Array;
    headers: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
    now?: Date;
    deadlineAtMs?: number;
    onCommittedWake?: (wake: PluginWebhookCommittedDeliveryWakeV1) => void;
    reserveResolvedEndpoint?: (endpoint: ActivePluginWebhookEndpointV1) => Promise<Readonly<{
        release(): void | Promise<void>;
    }> | null>;
    dependencies?: PluginWebhookIngestDependenciesV1;
}>): Promise<PluginWebhookIngestResultV1> {
    const dependencies = params.dependencies ?? DEFAULT_DEPENDENCIES;
    const now = params.now ?? new Date();
    const unavailableIfAborted = (): PluginWebhookIngestResultV1 | null => (
        params.signal?.aborted
            ? { kind: "rejected", statusCode: 503, code: "unavailable" }
            : null
    );
    const beforeRoute = unavailableIfAborted();
    if (beforeRoute) return beforeRoute;
    const route = params.verification.route;
    const providerDeliveryId = params.verification.providerDeliveryId;
    const credentialVersionId = params.verification.credentialVersionId;

    const providerInstallationId = route.routingKind === "providerInstallation"
        ? dependencies.parseInstallationId(params.rawBody)
        : undefined;
    if (route.routingKind === "providerInstallation" && !providerInstallationId) {
        return { kind: "rejected", statusCode: 404, code: "not_found" };
    }
    const endpoint = await dependencies.resolveEndpoint({
        routeId: route.routeId,
        routingKind: route.routingKind,
        ...(providerInstallationId ? { providerInstallationId } : {}),
    });
    const afterEndpoint = unavailableIfAborted();
    if (afterEndpoint) return afterEndpoint;
    if (!endpoint) return { kind: "rejected", statusCode: 404, code: "not_found" };

    const resolvedReservation = params.reserveResolvedEndpoint
        ? await params.reserveResolvedEndpoint(endpoint)
        : undefined;
    if (resolvedReservation === null) {
        return { kind: "rejected", statusCode: 503, code: "unavailable" };
    }

    try {
        const afterReservation = unavailableIfAborted();
        if (afterReservation) return afterReservation;
        const account = await dependencies.readAccount(endpoint.accountId);
        const afterAccount = unavailableIfAborted();
        if (afterAccount) return afterAccount;
        if (!account) return { kind: "rejected", statusCode: 503, code: "unavailable" };
        const eventHeader = readSingleHeader(params.headers, "x-github-event");
        const eventType = eventHeader && GITHUB_EVENT_PATTERN_V1.test(eventHeader) ? eventHeader : undefined;
        const content = PluginWebhookDeliveryContentV1Schema.parse({
            v: 1,
            receivedAtMs: now.getTime(),
            contentType: normalizeContentType(readSingleHeader(params.headers, "content-type")),
            headers: eventType ? [{ name: "x-github-event", value: eventType }] : [],
            rawBodyBytes: params.rawBody.byteLength,
            rawBodyBase64: encodeBase64(params.rawBody, "base64"),
            verified: {
                verifier: "github_hmac_sha256_v1",
                providerDeliveryId,
                ...(eventType ? { eventType } : {}),
                credentialVersionId,
            },
        });
        const stored = createPluginWebhookStoredEnvelopeV1({ account, content });
        if (!stored.ok) return { kind: "rejected", statusCode: 503, code: "unavailable" };

        const admitted = await dependencies.admitDelivery({
            endpointId: endpoint.endpointId,
            expectedEndpointRevision: endpoint.revision,
            routeId: route.routeId,
            verifierKind: route.verifierKind,
            credentialVersionId,
            deliveryIdentityDigest: createPluginWebhookDeliveryIdentityDigestV1({
                verifierKind: route.verifierKind,
                routeId: route.routeId,
                providerDeliveryId,
            }),
            stored,
            now,
            ...(params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs }),
            ...(params.onCommittedWake ? { onCommittedWake: params.onCommittedWake } : {}),
        });
        const afterAdmission = unavailableIfAborted();
        if (afterAdmission) return afterAdmission;
        if (admitted.kind === "admitted" || admitted.kind === "duplicate") {
            return {
                kind: "accepted",
                deliveryId: admitted.deliveryId,
                duplicate: admitted.kind === "duplicate",
            };
        }
        return admitted.kind === "endpointUnavailable"
            ? { kind: "rejected", statusCode: 404, code: "not_found" }
            : { kind: "rejected", statusCode: 503, code: "unavailable" };
    } finally {
        await resolvedReservation?.release();
    }
}

export async function ingestPluginWebhookV1(params: Readonly<{
    opaqueRouteId: string;
    rawBody: Uint8Array;
    headers: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
    now?: Date;
    deadlineAtMs?: number;
    onCommittedWake?: (wake: PluginWebhookCommittedDeliveryWakeV1) => void;
    reserveResolvedEndpoint?: (endpoint: ActivePluginWebhookEndpointV1) => Promise<Readonly<{
        release(): void | Promise<void>;
    }> | null>;
    dependencies?: PluginWebhookIngestDependenciesV1;
}>): Promise<PluginWebhookIngestResultV1> {
    const dependencies = params.dependencies ?? DEFAULT_DEPENDENCIES;
    const prepared = await preparePluginWebhookSignatureVerifierV1({
        opaqueRouteId: params.opaqueRouteId,
        headers: params.headers,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.now ? { now: params.now } : {}),
        dependencies,
    });
    if (prepared.kind !== "ready") return prepared;
    prepared.verifier.update(params.rawBody);
    const verification = prepared.verifier.verify();
    if (!verification) return { kind: "rejected", statusCode: 401, code: "unauthorized" };
    return await admitVerifiedPluginWebhookV1({
        verification,
        rawBody: params.rawBody,
        headers: params.headers,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.now ? { now: params.now } : {}),
        ...(params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs }),
        ...(params.onCommittedWake ? { onCommittedWake: params.onCommittedWake } : {}),
        ...(params.reserveResolvedEndpoint ? { reserveResolvedEndpoint: params.reserveResolvedEndpoint } : {}),
        dependencies,
    });
}
