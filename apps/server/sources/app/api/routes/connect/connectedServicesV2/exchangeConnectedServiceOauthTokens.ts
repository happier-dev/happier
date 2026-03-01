import { randomBytes } from "node:crypto";

import {
    sealBoxBundle,
    decodeBase64,
    encodeBase64,
    BOX_BUNDLE_PUBLIC_KEY_BYTES,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { parseIntEnv } from "@/config/env";
import { assertNonEmptyString } from "./connectValueParsers";
import { extractOpenAiCodexAccountId } from "./openaiCodex/openaiCodexIdTokenClaims";
import {
    resolveClaudeSubscriptionOauthClientId,
    resolveClaudeSubscriptionOauthTokenUrl,
    resolveGeminiOauthClientId,
    resolveGeminiOauthClientSecret,
    resolveGeminiOauthTokenUrl,
    resolveOpenAiCodexOauthClientId,
    resolveOpenAiCodexOauthTokenUrl,
} from "./oauthConfig";

export class ConnectedServiceOauthTimeoutError extends Error {
    constructor() {
        super("Token exchange timed out");
        this.name = "ConnectedServiceOauthTimeoutError";
    }
}

export class ConnectedServiceOauthStateMismatchError extends Error {
    constructor() {
        super("OAuth state mismatch");
        this.name = "ConnectedServiceOauthStateMismatchError";
    }
}

export type ConnectedServiceOauthExchangeErrorCode =
    | "connect_oauth_exchange_failed"
    | "connect_oauth_invalid_grant"
    | "connect_oauth_invalid_client"
    | "connect_oauth_missing_refresh_token";

export class ConnectedServiceOauthExchangeError extends Error {
    constructor(
        public readonly errorCode: ConnectedServiceOauthExchangeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ConnectedServiceOauthExchangeError";
    }
}

type OauthExchangeInput = Readonly<{
    serviceId: ConnectedServiceId;
    publicKeyB64Url: string;
    code: string;
    verifier: string;
    redirectUri: string;
    state?: string | null;
    now: number;
    fetcher?: typeof fetch;
}>;

type OauthExchangePayload = Readonly<{
    serviceId: ConnectedServiceId;
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    scope: string | null;
    tokenType: string | null;
    providerEmail: string | null;
    providerAccountId: string | null;
    expiresAt: number | null;
    raw: unknown;
}>;

function parseRecipientPublicKey(publicKeyB64Url: string): Uint8Array {
    const bytes = decodeBase64(publicKeyB64Url, "base64url");
    if (bytes.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
        throw new Error(`Invalid publicKey length: ${bytes.length}`);
    }
    return bytes;
}

function resolveOauthExchangeTimeoutMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS, 10_000, { min: 1_000, max: 60_000 });
}

function createFetchWithTimeout(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
    return async (input: any, init?: any) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetcher(input, { ...(init ?? {}), signal: controller.signal });
        } catch (error) {
            const name = error && typeof error === "object" && "name" in (error as any) ? String((error as any).name) : "";
            if (name === "AbortError") {
                throw new ConnectedServiceOauthTimeoutError();
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };
}

async function exchangeOpenAiCodex(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
    now: number;
    fetcher: typeof fetch;
}>): Promise<OauthExchangePayload> {
    const clientId = resolveOpenAiCodexOauthClientId(process.env);
    const tokenUrl = resolveOpenAiCodexOauthTokenUrl(process.env);

    const response = await params.fetcher(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code: params.code,
            code_verifier: params.verifier,
            redirect_uri: params.redirectUri,
        }),
    });
    if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
    }

    const json = (await response.json()) as any;
    const idToken = typeof json?.id_token === "string" ? json.id_token : null;
    const accessToken = typeof json?.access_token === "string" ? json.access_token : idToken;
    const refreshToken = assertNonEmptyString(json?.refresh_token, "refresh_token");
    const providerAccountId = extractOpenAiCodexAccountId(idToken);

    const expiresIn = Number.isFinite(json?.expires_in) ? Number(json.expires_in) : NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

    return {
        serviceId: "openai-codex",
        accessToken: assertNonEmptyString(accessToken, "access_token"),
        refreshToken,
        idToken,
        scope: null,
        tokenType: null,
        providerEmail: null,
        providerAccountId,
        expiresAt,
        raw: json,
    };
}

async function exchangeGemini(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
    now: number;
    fetcher: typeof fetch;
}>): Promise<OauthExchangePayload> {
    const clientId = resolveGeminiOauthClientId(process.env);
    const clientSecret = resolveGeminiOauthClientSecret(process.env);
    const tokenUrl = resolveGeminiOauthTokenUrl(process.env);

    const response = await params.fetcher(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            client_secret: clientSecret,
            code: params.code,
            code_verifier: params.verifier,
            redirect_uri: params.redirectUri,
        }),
    });
    if (!response.ok) {
        const json = await response.json().catch(() => null);
        const providerError = json && typeof (json as any).error === "string" ? String((json as any).error) : "";
        const providerDescription =
            json && typeof (json as any).error_description === "string" ? String((json as any).error_description) : "";
        if (providerError === "invalid_grant") {
            throw new ConnectedServiceOauthExchangeError(
                "connect_oauth_invalid_grant",
                providerDescription || "Gemini OAuth code is invalid or expired.",
            );
        }
        if (providerError === "invalid_client") {
            throw new ConnectedServiceOauthExchangeError(
                "connect_oauth_invalid_client",
                providerDescription || "Gemini OAuth client credentials are invalid.",
            );
        }
        throw new ConnectedServiceOauthExchangeError(
            "connect_oauth_exchange_failed",
            `Token exchange failed: ${response.status}`,
        );
    }

    const json = (await response.json()) as any;
    const accessToken = assertNonEmptyString(json?.access_token, "access_token");
    const refreshToken = typeof json?.refresh_token === "string" ? json.refresh_token : "";
    if (!refreshToken.trim()) {
        throw new ConnectedServiceOauthExchangeError(
            "connect_oauth_missing_refresh_token",
            "Gemini OAuth did not return a refresh token.",
        );
    }
    const expiresIn = Number.isFinite(json?.expires_in) ? Number(json.expires_in) : NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

    return {
        serviceId: "gemini",
        accessToken,
        refreshToken,
        idToken: typeof json?.id_token === "string" ? json.id_token : null,
        scope: typeof json?.scope === "string" ? json.scope : null,
        tokenType: typeof json?.token_type === "string" ? json.token_type : null,
        providerEmail: null,
        providerAccountId: null,
        expiresAt,
        raw: json,
    };
}

async function exchangeClaudeSubscription(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
    state: string;
    now: number;
    fetcher: typeof fetch;
}>): Promise<OauthExchangePayload> {
    const clientId = resolveClaudeSubscriptionOauthClientId(process.env);
    const tokenUrl = resolveClaudeSubscriptionOauthTokenUrl(process.env);

    const response = await params.fetcher(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "authorization_code",
            code: params.code,
            redirect_uri: params.redirectUri,
            client_id: clientId,
            code_verifier: params.verifier,
            state: params.state,
        }),
    });
    if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
    }

    const json = (await response.json()) as any;
    const accessToken = assertNonEmptyString(json?.access_token, "access_token");
    const refreshToken = assertNonEmptyString(json?.refresh_token, "refresh_token");
    const expiresIn = Number.isFinite(json?.expires_in) ? Number(json.expires_in) : NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

    const providerEmail = typeof json?.account?.email_address === "string" ? json.account.email_address : null;
    const providerAccountId = typeof json?.account?.uuid === "string" ? json.account.uuid : null;

    return {
        serviceId: "claude-subscription",
        accessToken,
        refreshToken,
        idToken: null,
        scope: typeof json?.scope === "string" ? json.scope : null,
        tokenType: typeof json?.token_type === "string" ? json.token_type : null,
        providerEmail,
        providerAccountId,
        expiresAt,
        raw: json,
    };
}

export async function exchangeConnectedServiceOauthTokens(params: OauthExchangeInput): Promise<Readonly<{
    bundleB64Url: string;
}>> {
    const baseFetcher = params.fetcher ?? fetch;
    const timeoutMs = resolveOauthExchangeTimeoutMs(process.env);
    const fetcher = createFetchWithTimeout(baseFetcher, timeoutMs);
    const recipientPublicKey = parseRecipientPublicKey(params.publicKeyB64Url);

    const payload = await (async () => {
        if (params.serviceId === "openai-codex") {
            return await exchangeOpenAiCodex({
                code: params.code,
                verifier: params.verifier,
                redirectUri: params.redirectUri,
                now: params.now,
                fetcher,
            });
        }
        if (params.serviceId === "anthropic") {
            throw new Error("Anthropic OAuth exchange is not supported. Use an API key instead.");
        }
        if (params.serviceId === "openai") {
            throw new Error("OpenAI API key service does not support OAuth exchange.");
        }
        if (params.serviceId === "claude-subscription") {
            const state = params.state?.trim() ?? "";
            if (!state) throw new ConnectedServiceOauthStateMismatchError();
            return await exchangeClaudeSubscription({
                code: params.code,
                verifier: params.verifier,
                redirectUri: params.redirectUri,
                state,
                now: params.now,
                fetcher,
            });
        }
        if (params.serviceId === "gemini") {
            return await exchangeGemini({
                code: params.code,
                verifier: params.verifier,
                redirectUri: params.redirectUri,
                now: params.now,
                fetcher,
            });
        }
        throw new Error("Unsupported connected service");
    })();

    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const bundle = sealBoxBundle({
        plaintext,
        recipientPublicKey,
        randomBytes: (length) => randomBytes(length),
    });

    return { bundleB64Url: encodeBase64(bundle, "base64url") };
}
