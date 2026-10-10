import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
    LocalServicePreviewResourceV1Schema,
    type LocalServicePreviewResourceV1,
    type LocalServicePreviewNativeDirectDescriptorV1,
    localServicePreviewDirectBindingV1,
    type LocalServicePreviewDirectBindingV1,
} from "@happier-dev/protocol/local/services/preview/v1";
import { LocalServicePreviewNativeDirectAccessV1Schema, type LocalServicePreviewNativeDirectAccessRequestV1, type LocalServicePreviewNativeDirectAccessV1 } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import type { MachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol';
import { mintDirectRouteGrantV2, resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';

import {
    resolveLocalServicePreviewUrl,
    type ResolveLocalServicePreviewUrlResult,
} from "@/app/local/services/preview/origin";
import {
    createLocalServicePreviewToken,
    hashLocalServicePreviewToken,
    type LocalServicePreviewTokenRecord,
    validateLocalServicePreviewToken,
    type LocalServicePreviewTokenValidationResult,
} from "@/app/local/services/preview/tokens";

const DEFAULT_PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

type LocalServicePreviewUrlFailureReason = ResolveLocalServicePreviewUrlResult extends Readonly<{
    ok: true;
}> ? never : Exclude<ResolveLocalServicePreviewUrlResult, Readonly<{ ok: true }>>["reasonCode"];

type LocalServicePreviewTokenFailureReason = LocalServicePreviewTokenValidationResult extends Readonly<{
    ok: true;
}> ? never : Exclude<LocalServicePreviewTokenValidationResult, Readonly<{ ok: true }>>["reasonCode"];

export type LocalServicePreviewRuntimeRegistrationResult =
    | Readonly<{
          ok: true;
          resource: LocalServicePreviewResourceV1;
          accessUrl: string | null;
          expiresAt: number | null;
          accessUnavailableReasonCode?: 'preview_private_route_unavailable';
          nativeDirect?: LocalServicePreviewNativeDirectDescriptorV1;
      }>
    | Readonly<{
          ok: false;
          reasonCode:
              | "invalid_preview_resource"
              | "preview_hostname_collision"
              | "preview_token_secret_missing"
              | "preview_public_base_url_missing"
              | LocalServicePreviewUrlFailureReason;
      }>;

export type LocalServicePreviewRuntimeRegistrationInput = Readonly<{
    resource: LocalServicePreviewResourceV1;
    accountId: string;
    nativeDirectSupported?: boolean;
    viewerAccountId?: string;
}>;

export type LocalServicePreviewRuntimeContext = Readonly<{
    resource: LocalServicePreviewResourceV1;
    accountId: string;
}>;

export type LocalServicePreviewRuntimeValidationResult =
    | Readonly<{ ok: true }>
    | Readonly<{
          ok: false;
          reasonCode:
              | "preview_not_found"
              | "preview_token_missing"
              | LocalServicePreviewTokenFailureReason;
      }>;

export type LocalServicePreviewRuntimeExchangeResult =
    | Readonly<{ ok: true; rawToken: string; expiresAt: number | null }>
    | Exclude<LocalServicePreviewRuntimeValidationResult, Readonly<{ ok: true }>>;

export type LocalServicePreviewRuntime = Readonly<{
    closeNativeRegistrations(): void;
    retainConnection(previewId: string, close: () => void, rawToken?: string | null): () => void;
    retireMachineAccess(input: Readonly<{ machineId: string; accountId: string }>): void;
    openNativeRegistration(binding: LocalServicePreviewDirectBindingV1, grantId: string): Readonly<{ ok: true; signal: AbortSignal; close: () => void } | { ok: false; reasonCode: string }>;
    mintNativeDirectAccess(input: Readonly<{ previewId: string; actorAccountId?: string; request: LocalServicePreviewNativeDirectAccessRequestV1; target: MachineIrohEndpointAuthorityV1 }>): Readonly<{ ok: true; access: LocalServicePreviewNativeDirectAccessV1 } | { ok: false; reasonCode: string }>;
    registerPreview(input: LocalServicePreviewRuntimeRegistrationInput): LocalServicePreviewRuntimeRegistrationResult;
    resolvePreview(previewId: string): LocalServicePreviewResourceV1 | null;
    resolvePreviewByHost(hostname: string): LocalServicePreviewResourceV1 | null;
    resolvePreviewContext(previewId: string): LocalServicePreviewRuntimeContext | null;
    validateAccess(input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string | undefined;
        machineId: string;
    }>): LocalServicePreviewRuntimeValidationResult;
    exchangeAccessToken(input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string | undefined;
        machineId: string;
    }>): LocalServicePreviewRuntimeExchangeResult;
    unregisterPreview(previewId: string): Readonly<{ ok: true } | { ok: false; reasonCode: "preview_not_found" }>;
}>;

export type CreateLocalServicePreviewRuntimeInput = Readonly<{
    tokenSecret: string | null | undefined;
    publicBaseUrl: string | null | undefined;
    hostOriginBaseDomain: string | null;
    tokenTtlMs?: number;
    nowMs?: () => number;
    generateTokenId?: () => string;
    generateRawToken?: () => string;
    env?: NodeJS.ProcessEnv;
}>;

type PreviewRuntimeEntry = Readonly<{
    resource: LocalServicePreviewResourceV1;
    accountId: string;
    tokenRecords: Map<string, LocalServicePreviewTokenRecord>;
    nativeRegistrations: Map<string, { controller: AbortController; claimed: boolean; actorAccountId?: string }>;
    connections: Set<Readonly<{ close: () => void; actorAccountId?: string }>>;
}>;

function nonEmptyString(value: string | null | undefined): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTtlMs(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        return DEFAULT_PREVIEW_TOKEN_TTL_MS;
    }
    return value;
}

function defaultRawToken(): string {
    return randomBytes(32).toString("base64url");
}

function normalizeAccountId(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeHostname(value: string): string | null {
    const trimmed = value.trim().toLowerCase().replace(/\.$/u, "");
    return trimmed.length > 0 ? trimmed : null;
}

function hostnameFromOrigin(origin: string): string | null {
    try {
        return normalizeHostname(new URL(origin).hostname);
    } catch {
        return null;
    }
}

export function createLocalServicePreviewRuntime(
    runtimeInput: CreateLocalServicePreviewRuntimeInput,
): LocalServicePreviewRuntime {
    const resources = new Map<string, PreviewRuntimeEntry>();
    const previewIdByHostname = new Map<string, string>();
    const hostnameByPreviewId = new Map<string, string>();
    const nowMs = runtimeInput.nowMs ?? Date.now;
    const generateTokenId = runtimeInput.generateTokenId ?? randomUUID;
    const generateRawToken = runtimeInput.generateRawToken ?? defaultRawToken;

    function retireConnections(entry: PreviewRuntimeEntry): void {
        for (const { controller } of entry.nativeRegistrations.values()) controller.abort();
        for (const connection of entry.connections) connection.close();
        entry.connections.clear();
    }

    function registerPreview(input: LocalServicePreviewRuntimeRegistrationInput): LocalServicePreviewRuntimeRegistrationResult {
        const accountId = normalizeAccountId(input.accountId);
        const parsed = LocalServicePreviewResourceV1Schema.safeParse(input.resource);
        if (!parsed.success) {
            return { ok: false, reasonCode: "invalid_preview_resource" };
        }
        if (!accountId) {
            return { ok: false, reasonCode: "invalid_preview_resource" };
        }
        const resource = parsed.data;
        const nativeDirect: LocalServicePreviewNativeDirectDescriptorV1 | undefined = input.nativeDirectSupported
            ? { v: 1, kind: 'iroh_preview', previewId: resource.previewId, machineId: resource.machineId } : undefined;
        const previous = resources.get(parsed.data.previewId);
        if (previous && (previous.accountId !== accountId
            || previous.resource.machineId !== parsed.data.machineId
            || previous.resource.sessionId !== parsed.data.sessionId
            || !isDeepStrictEqual(previous.resource.owner, parsed.data.owner)
            || !isDeepStrictEqual(previous.resource.serviceTarget, parsed.data.serviceTarget)
            || !isDeepStrictEqual(previous.resource.target, parsed.data.target))) {
            return { ok: false, reasonCode: "invalid_preview_resource" };
        }

        const tokenSecret = nonEmptyString(runtimeInput.tokenSecret);
        if (!tokenSecret) {
            return { ok: false, reasonCode: "preview_token_secret_missing" };
        }

        const publicBaseUrl = nonEmptyString(runtimeInput.publicBaseUrl);
        if (!publicBaseUrl) {
            return { ok: false, reasonCode: "preview_public_base_url_missing" };
        }

        const issuedAt = nowMs();
        const expiresAt = issuedAt + normalizeTtlMs(runtimeInput.tokenTtlMs);
        const { token, record } = createLocalServicePreviewToken({
            secret: tokenSecret,
            tokenId: generateTokenId(),
            rawToken: generateRawToken(),
            previewId: parsed.data.previewId,
            sessionId: parsed.data.sessionId,
            machineId: parsed.data.machineId,
            issuedAt,
            expiresAt,
            exchangeMode: "url",
            ...(resource.serviceTarget ? { actorAccountId: input.viewerAccountId ?? accountId } : {}),
        });

        const resolvedUrl = resolveLocalServicePreviewUrl({
            originMode: resource.originMode,
            publicBaseUrl,
            hostOriginBaseDomain: runtimeInput.hostOriginBaseDomain,
            previewId: parsed.data.previewId,
            initialPath: parsed.data.initialPath,
            token,
        });
        if (!resolvedUrl.ok) {
            if (resolvedUrl.reasonCode === 'host_origin_unavailable') {
                // Registration is still the scoped authority used by public-link actions.
                // No access token or API-origin fallback is admitted without isolation.
                if (previous && !isDeepStrictEqual(previous.resource.policy, resource.policy)) {
                    retireConnections(previous);
                }
                resources.set(resource.previewId, { resource, accountId, tokenRecords: new Map(), nativeRegistrations: previous?.nativeRegistrations ?? new Map(), connections: previous?.connections ?? new Set() });
                return { ok: true, resource, accessUrl: null, expiresAt: null, ...(nativeDirect ? { nativeDirect } : {}), accessUnavailableReasonCode: 'preview_private_route_unavailable' };
            }
            return resolvedUrl;
        }

        const previousHostname = hostnameByPreviewId.get(parsed.data.previewId);
        const hostname = hostnameFromOrigin(resolvedUrl.origin);
        const hostnameOwner = hostname ? previewIdByHostname.get(hostname) : null;
        if (hostname && hostnameOwner && hostnameOwner !== parsed.data.previewId) {
            return { ok: false, reasonCode: "preview_hostname_collision" };
        }

        if (previousHostname) {
            previewIdByHostname.delete(previousHostname);
            hostnameByPreviewId.delete(parsed.data.previewId);
        }

        if (hostname) {
            previewIdByHostname.set(hostname, parsed.data.previewId);
            hostnameByPreviewId.set(parsed.data.previewId, hostname);
        }

        const tokenRecords = previous?.tokenRecords ?? new Map<string, LocalServicePreviewTokenRecord>();
        for (const [hash, existing] of tokenRecords) {
            if (existing.expiresAt !== null && existing.expiresAt <= issuedAt) tokenRecords.delete(hash);
        }
        tokenRecords.set(record.tokenHash, record);
        if (previous && !isDeepStrictEqual(previous.resource.policy, resource.policy)) {
            retireConnections(previous);
        }
        resources.set(parsed.data.previewId, {
            resource,
            accountId,
            tokenRecords,
            nativeRegistrations: previous?.nativeRegistrations ?? new Map(),
            connections: previous?.connections ?? new Set(),
        });

        return {
            ok: true,
            resource,
            accessUrl: resolvedUrl.url,
            expiresAt,
            ...(nativeDirect ? { nativeDirect } : {}),
        };
    }

    function resolvePreview(previewId: string): LocalServicePreviewResourceV1 | null {
        return resources.get(previewId)?.resource ?? null;
    }

    function resolvePreviewByHost(hostname: string): LocalServicePreviewResourceV1 | null {
        const normalizedHostname = normalizeHostname(hostname);
        if (!normalizedHostname) return null;
        const previewId = previewIdByHostname.get(normalizedHostname);
        return previewId ? resolvePreview(previewId) : null;
    }

    function resolvePreviewContext(previewId: string): LocalServicePreviewRuntimeContext | null {
        const entry = resources.get(previewId);
        return entry
            ? {
                resource: entry.resource,
                accountId: entry.accountId,
            }
            : null;
    }

    function validateAccess(input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string | undefined;
        machineId: string;
    }>): LocalServicePreviewRuntimeValidationResult {
        const entry = resources.get(input.previewId);
        if (!entry) {
            return { ok: false, reasonCode: "preview_not_found" };
        }
        if (!input.rawToken) {
            return { ok: false, reasonCode: "preview_token_missing" };
        }

        const tokenSecret = nonEmptyString(runtimeInput.tokenSecret);
        if (!tokenSecret) {
            return { ok: false, reasonCode: "token_mismatch" };
        }

        const record = entry.tokenRecords.get(hashLocalServicePreviewToken(tokenSecret, input.rawToken));
        if (!record) return { ok: false, reasonCode: "token_mismatch" };
        return validateLocalServicePreviewToken({
            secret: tokenSecret,
            rawToken: input.rawToken,
            record,
            previewId: input.previewId,
            sessionId: input.sessionId,
            machineId: input.machineId,
            nowMs: nowMs(),
            expectedExchangeMode: "cookie",
        });
    }

    function exchangeAccessToken(input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string | undefined;
        machineId: string;
    }>): LocalServicePreviewRuntimeExchangeResult {
        const entry = resources.get(input.previewId);
        if (!entry) {
            return { ok: false, reasonCode: "preview_not_found" };
        }
        if (!input.rawToken) {
            return { ok: false, reasonCode: "preview_token_missing" };
        }

        const tokenSecret = nonEmptyString(runtimeInput.tokenSecret);
        if (!tokenSecret) {
            return { ok: false, reasonCode: "token_mismatch" };
        }

        const urlRecord = entry.tokenRecords.get(hashLocalServicePreviewToken(tokenSecret, input.rawToken));
        if (!urlRecord) return { ok: false, reasonCode: "token_mismatch" };
        const tokenValidation = validateLocalServicePreviewToken({
            secret: tokenSecret,
            rawToken: input.rawToken,
            record: urlRecord,
            previewId: input.previewId,
            sessionId: input.sessionId,
            machineId: input.machineId,
            nowMs: nowMs(),
            expectedExchangeMode: "url",
        });
        if (!tokenValidation.ok) {
            return tokenValidation;
        }

        const { token, record } = createLocalServicePreviewToken({
            secret: tokenSecret,
            tokenId: generateTokenId(),
            rawToken: generateRawToken(),
            previewId: entry.resource.previewId,
            sessionId: entry.resource.sessionId,
            machineId: entry.resource.machineId,
            issuedAt: nowMs(),
            // Admission is short-lived and one-use; an admitted viewer remains authorized
            // by this registration until it is explicitly unregistered.
            expiresAt: null,
            exchangeMode: "cookie",
            ...(urlRecord.actorAccountId ? { actorAccountId: urlRecord.actorAccountId } : {}),
        });
        entry.tokenRecords.delete(urlRecord.tokenHash);
        entry.tokenRecords.set(record.tokenHash, record);
        return {
            ok: true,
            rawToken: token,
            expiresAt: record.expiresAt,
        };
    }

    function unregisterPreview(previewId: string): Readonly<{ ok: true } | { ok: false; reasonCode: "preview_not_found" }> {
        if (!resources.has(previewId)) {
            return { ok: false, reasonCode: "preview_not_found" };
        }
        const entry = resources.get(previewId)!;
        resources.delete(previewId);
        retireConnections(entry);
        const hostname = hostnameByPreviewId.get(previewId);
        if (hostname) {
            previewIdByHostname.delete(hostname);
            hostnameByPreviewId.delete(previewId);
        }
        return { ok: true };
    }

    return {
        retainConnection(previewId, close, rawToken) {
            const entry = resources.get(previewId);
            if (!entry) { close(); return () => {}; }
            const secret = nonEmptyString(runtimeInput.tokenSecret);
            const actorAccountId = secret && rawToken ? entry.tokenRecords.get(hashLocalServicePreviewToken(secret, rawToken))?.actorAccountId : undefined;
            const connection = { close, ...(actorAccountId ? { actorAccountId } : {}) };
            entry.connections.add(connection);
            return () => { entry.connections.delete(connection); };
        },
        retireMachineAccess({ machineId, accountId }) {
            for (const entry of resources.values()) {
                if (!entry.resource.serviceTarget || entry.resource.machineId !== machineId) continue;
                if (entry.accountId === accountId) { unregisterPreview(entry.resource.previewId); continue; }
                for (const [hash, record] of entry.tokenRecords) if (record.actorAccountId === accountId) entry.tokenRecords.delete(hash);
                for (const registration of entry.nativeRegistrations.values()) if (registration.actorAccountId === accountId) registration.controller.abort();
                for (const connection of entry.connections) if (connection.actorAccountId === accountId) {
                    entry.connections.delete(connection);
                    connection.close();
                }
            }
        },
        closeNativeRegistrations() {
            for (const entry of resources.values()) {
                retireConnections(entry);
            }
        },
        openNativeRegistration(binding, grantId) {
            const entry = resources.get(binding.previewId);
            if (!entry || !isDeepStrictEqual(localServicePreviewDirectBindingV1(entry.resource), binding)) return { ok: false, reasonCode: 'preview_registration_mismatch' };
            const registration = entry.nativeRegistrations.get(grantId);
            if (!registration || registration.claimed || registration.controller.signal.aborted) return { ok: false, reasonCode: 'preview_grant_unavailable' };
            registration.claimed = true;
            const controller = registration.controller;
            const close = () => controller.abort();
            return { ok: true, signal: controller.signal, close };
        },
        mintNativeDirectAccess(input) {
            const entry = resources.get(input.previewId);
            if (!entry) return { ok: false, reasonCode: 'preview_not_found' };
            const signing = resolvePeerMediationGrantSigningConfig(runtimeInput.env ?? process.env, nowMs());
            if (!signing.ok) return { ok: false, reasonCode: 'grant_signing_unavailable' };
            const resource = entry.resource;
            const { previewId, machineId, target } = resource;
            const minted = mintDirectRouteGrantV2({
                accountId: input.actorAccountId ?? entry.accountId, machineId, flowKind: 'tcp_tunnel', routeKind: 'iroh_peer',
                endpointFingerprint: input.target.endpointId, nowMs: nowMs(), ttlMs: null, serverGateEnabled: true,
                signingKey: { keyId: signing.keyId, secretKey: signing.secretKey, expiresAt: signing.capability.expiresAt },
                ephemeralPublicKeyBase64Url: input.request.ephemeralPublicKeyBase64Url,
                iroh: { initiator: input.request.initiator, target: { machineId, endpointId: input.target.endpointId }, operationKind: 'tcp_tunnel' },
                scope: { kind: 'tcp_tunnel', tunnelId: randomUUID(), allowedPorts: [target.port],
                    preview: localServicePreviewDirectBindingV1(resource) },
            });
            if (!minted.ok) return minted;
            const access = LocalServicePreviewNativeDirectAccessV1Schema.parse({
                v: 1, kind: 'iroh_preview', previewId, machineId, initialPath: resource.initialPath,
                destination: { host: target.host, port: target.port }, grant: minted.grant, target: input.target,
            });
            // The existing signed operation identity belongs to this registration,
            // including while its viewer has not yet claimed the control stream.
            const controller = new AbortController();
            const grantId = minted.grant.payload.grantId;
            entry.nativeRegistrations.set(grantId, { controller, claimed: false,
                ...(resource.serviceTarget ? { actorAccountId: input.actorAccountId ?? entry.accountId } : {}) });
            controller.signal.addEventListener('abort', () => entry.nativeRegistrations.delete(grantId), { once: true });
            return { ok: true, access };
        },
        registerPreview,
        resolvePreview,
        resolvePreviewByHost,
        resolvePreviewContext,
        validateAccess,
        exchangeAccessToken,
        unregisterPreview,
    };
}
