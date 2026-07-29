import { randomBytes, randomUUID } from "node:crypto";

import {
    LocalServicePreviewResourceV1Schema,
    type LocalServicePreviewResourceV1,
} from "@happier-dev/protocol";

import {
    resolveLocalServicePreviewUrl,
    type ResolveLocalServicePreviewUrlResult,
} from "@/app/local/services/preview/origin";
import {
    createLocalServicePreviewToken,
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
          accessUrl: string;
          expiresAt: number;
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
    | Readonly<{ ok: true; rawToken: string; expiresAt: number }>
    | Exclude<LocalServicePreviewRuntimeValidationResult, Readonly<{ ok: true }>>;

export type LocalServicePreviewRuntime = Readonly<{
    registerPreview(input: LocalServicePreviewRuntimeRegistrationInput): LocalServicePreviewRuntimeRegistrationResult;
    resolvePreview(previewId: string): LocalServicePreviewResourceV1 | null;
    resolvePreviewByHost(hostname: string): LocalServicePreviewResourceV1 | null;
    resolvePreviewContext(previewId: string): LocalServicePreviewRuntimeContext | null;
    validateAccess(input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string;
        machineId: string;
    }>): LocalServicePreviewRuntimeValidationResult;
    exchangeAccessToken(input: Readonly<{
        previewId: string;
        rawToken: string | null;
        sessionId: string;
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
}>;

type PreviewRuntimeEntry = Readonly<{
    resource: LocalServicePreviewResourceV1;
    accountId: string;
    tokenRecord: LocalServicePreviewTokenRecord;
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

    function registerPreview(input: LocalServicePreviewRuntimeRegistrationInput): LocalServicePreviewRuntimeRegistrationResult {
        const accountId = normalizeAccountId(input.accountId);
        const parsed = LocalServicePreviewResourceV1Schema.safeParse(input.resource);
        if (!parsed.success) {
            return { ok: false, reasonCode: "invalid_preview_resource" };
        }
        if (!accountId) {
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
        });

        const resolvedUrl = resolveLocalServicePreviewUrl({
            originMode: parsed.data.originMode,
            publicBaseUrl,
            hostOriginBaseDomain: runtimeInput.hostOriginBaseDomain,
            previewId: parsed.data.previewId,
            initialPath: parsed.data.initialPath,
            token,
        });
        if (!resolvedUrl.ok) {
            return resolvedUrl;
        }

        const previousHostname = hostnameByPreviewId.get(parsed.data.previewId);
        const hostname = parsed.data.originMode === "host" ? hostnameFromOrigin(resolvedUrl.origin) : null;
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

        resources.set(parsed.data.previewId, {
            resource: parsed.data,
            accountId,
            tokenRecord: record,
        });

        return {
            ok: true,
            resource: parsed.data,
            accessUrl: resolvedUrl.url,
            expiresAt,
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
        sessionId: string;
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

        return validateLocalServicePreviewToken({
            secret: tokenSecret,
            rawToken: input.rawToken,
            record: entry.tokenRecord,
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
        sessionId: string;
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

        const tokenValidation = validateLocalServicePreviewToken({
            secret: tokenSecret,
            rawToken: input.rawToken,
            record: entry.tokenRecord,
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
            expiresAt: entry.tokenRecord.expiresAt,
            exchangeMode: "cookie",
        });
        resources.set(entry.resource.previewId, {
            ...entry,
            tokenRecord: record,
        });
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
        resources.delete(previewId);
        const hostname = hostnameByPreviewId.get(previewId);
        if (hostname) {
            previewIdByHostname.delete(hostname);
            hostnameByPreviewId.delete(previewId);
        }
        return { ok: true };
    }

    return {
        registerPreview,
        resolvePreview,
        resolvePreviewByHost,
        resolvePreviewContext,
        validateAccess,
        exchangeAccessToken,
        unregisterPreview,
    };
}
