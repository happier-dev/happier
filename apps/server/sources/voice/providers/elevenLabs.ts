import { HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE } from "@happier-dev/protocol";
import { z } from "zod";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const LEASE_TIME_SKEW_MS = 5 * 60 * 1000;
const MAX_MINT_RESPONSE_BYTES = 64 * 1024;
const MAX_CONVERSATION_RESPONSE_BYTES = 4 * 1024 * 1024;

const mintResponseSchema = z.object({
    token: z.string().trim().min(1).max(16_384),
}).passthrough();

export type HostedElevenLabsFetch = (url: string, init: RequestInit) => Promise<Response>;

type HostedElevenLabsUpstreamDiagnosticCode =
    | "missing_api_key"
    | "missing_agent_id"
    | "aborted"
    | "timeout"
    | "network_error"
    | "provider_http_error"
    | "response_too_large"
    | "invalid_mint_response"
    | "invalid_conversation_response";

type HostedElevenLabsNotFoundDiagnosticCode =
    | "conversation_id_mismatch"
    | "agent_mismatch"
    | "binding_nonce_mismatch"
    | "conversation_outside_lease_window";

export type HostedElevenLabsMintResult =
    | Readonly<{ ok: true; token: string }>
    | Readonly<{
          ok: false;
          reason: "misconfigured" | "upstream_error";
          diagnosticCode: HostedElevenLabsUpstreamDiagnosticCode;
      }>;

export type HostedElevenLabsConversationVerificationResult =
    | Readonly<{
          ok: true;
          durationSeconds: number;
          startedAt: Date;
          endedAt: Date;
      }>
    | Readonly<{
          ok: false;
          reason: "upstream_error";
          diagnosticCode: HostedElevenLabsUpstreamDiagnosticCode;
      }>
    | Readonly<{
          ok: false;
          reason: "not_found";
          diagnosticCode: HostedElevenLabsNotFoundDiagnosticCode;
      }>;

export interface HostedElevenLabsService {
    readonly isApiConfigured: boolean;
    readonly configuredAgentId: string | undefined;
    mintConversationToken(input?: Readonly<{ signal?: AbortSignal }>): Promise<HostedElevenLabsMintResult>;
    verifyConversation(input: Readonly<{
        providerConversationId: string;
        expectedAgentId: string;
        expectedBindingNonce: string;
        leaseCreatedAt: Date;
        leaseExpiresAt: Date;
        signal?: AbortSignal;
    }>): Promise<HostedElevenLabsConversationVerificationResult>;
}

interface HostedElevenLabsServiceDependencies {
    readonly fetchImpl?: HostedElevenLabsFetch;
    readonly requestTimeoutMs?: number;
}

interface ProviderRequestFailure {
    readonly ok: false;
    readonly diagnosticCode:
        | "aborted"
        | "timeout"
        | "network_error"
        | "provider_http_error"
        | "response_too_large";
}

interface ProviderRequestSuccess {
    readonly ok: true;
    readonly payload: unknown | null;
}

type ProviderRequestResult = ProviderRequestSuccess | ProviderRequestFailure;

async function cancelResponseBody(response: Response): Promise<void> {
    if (!response.body || response.body.locked) return;
    await response.body.cancel().catch(() => {});
}

function createAbortError(): Error {
    const error = new Error("provider_request_aborted");
    error.name = "AbortError";
    return error;
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw createAbortError();
    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(createAbortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then(
            (value) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : null;
}

function trimmedString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function nestedRecord(record: Readonly<Record<string, unknown>> | null, key: string): Readonly<Record<string, unknown>> | null {
    return asRecord(record?.[key]);
}

function extractConversationAgentId(payload: unknown): string | null {
    const root = asRecord(payload);
    const agent = nestedRecord(root, "agent");
    const metadata = nestedRecord(root, "metadata");
    return (
        trimmedString(root?.agent_id) ??
        trimmedString(root?.agentId) ??
        trimmedString(agent?.id) ??
        trimmedString(metadata?.agent_id) ??
        trimmedString(metadata?.agentId)
    );
}

function extractConversationId(payload: unknown): string | null {
    const value = asRecord(payload)?.conversation_id;
    return typeof value === "string" && value.length > 0 ? value : null;
}

function extractConversationBindingNonce(payload: unknown): string | null {
    const root = asRecord(payload);
    const clientData =
        nestedRecord(root, "conversation_initiation_client_data") ??
        nestedRecord(root, "conversationInitiationClientData");
    const dynamicVariables =
        nestedRecord(clientData, "dynamic_variables") ??
        nestedRecord(clientData, "dynamicVariables");
    const value = dynamicVariables?.[HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE];
    return typeof value === "string" && value.length > 0 ? value : null;
}

function extractFiniteNumber(value: unknown): number | null {
    if (typeof value === "string" && value.trim().length === 0) return null;
    const normalized = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(normalized) ? normalized : null;
}

function extractConversationTiming(payload: unknown): Readonly<{
    startUnixSeconds: number;
    durationSeconds: number;
}> | null {
    const metadata = nestedRecord(asRecord(payload), "metadata");
    const rawStart = extractFiniteNumber(metadata?.start_time_unix_secs);
    const rawDuration = extractFiniteNumber(metadata?.call_duration_secs);
    if (rawStart === null || rawStart <= 0 || rawDuration === null || rawDuration < 0) return null;
    return {
        startUnixSeconds: Math.floor(rawStart),
        durationSeconds: Math.floor(rawDuration),
    };
}

async function parseBoundedJsonResponse(
    response: Response,
    signal: AbortSignal,
    maxResponseBytes: number,
): Promise<Readonly<{ ok: true; payload: unknown | null }> | Readonly<{ ok: false; tooLarge: true }>> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        await cancelResponseBody(response);
        return { ok: false, tooLarge: true };
    }
    if (!response.body) return { ok: true, payload: null };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    try {
        while (true) {
            const chunk = await raceWithAbort(reader.read(), signal);
            if (chunk.done) break;
            totalBytes += chunk.value.byteLength;
            if (totalBytes > maxResponseBytes) {
                await reader.cancel().catch(() => {});
                return { ok: false, tooLarge: true };
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        try {
            return { ok: true, payload: JSON.parse(text) as unknown };
        } catch {
            return { ok: true, payload: null };
        }
    } finally {
        if (signal.aborted) {
            await reader.cancel().catch(() => {});
        }
    }
}

/**
 * Resolves the configured ElevenLabs agent ID, if any.
 * Returns `undefined` when no usable agent ID is configured.
 */
export function resolveElevenLabsAgentId(env: NodeJS.ProcessEnv): string | undefined {
    const isProduction = env.NODE_ENV === "production";
    const generic = typeof env.ELEVENLABS_AGENT_ID === "string" ? env.ELEVENLABS_AGENT_ID.trim() : "";
    const production = typeof env.ELEVENLABS_AGENT_ID_PROD === "string" ? env.ELEVENLABS_AGENT_ID_PROD.trim() : "";
    const resolved = isProduction ? production || generic : generic || production;
    return resolved || undefined;
}

export function resolveElevenLabsApiBaseUrl(env: NodeJS.ProcessEnv): string {
    const raw = typeof env.ELEVENLABS_API_BASE_URL === "string" ? env.ELEVENLABS_API_BASE_URL.trim() : "";
    const base = raw || "https://api.elevenlabs.io";
    return base.replace(/\/+$/, "");
}

/**
 * Creates the deployment-owned ElevenLabs boundary. The API key stays captured in this server-only
 * service; callers receive only provider results and bounded diagnostic codes.
 */
export function createHostedElevenLabsService(
    env: NodeJS.ProcessEnv,
    dependencies: HostedElevenLabsServiceDependencies = {},
): HostedElevenLabsService {
    const apiKey = typeof env.ELEVENLABS_API_KEY === "string" ? env.ELEVENLABS_API_KEY.trim() : "";
    const configuredAgentId = resolveElevenLabsAgentId(env);
    const apiBaseUrl = resolveElevenLabsApiBaseUrl(env);
    const fetchImpl = dependencies.fetchImpl ?? ((url, init) => fetch(url, init));
    const requestTimeoutMs = Math.max(1, Math.floor(dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));

    async function providerRequest(
        url: string,
        maxResponseBytes: number,
        signal?: AbortSignal,
    ): Promise<ProviderRequestResult> {
        if (signal?.aborted) return { ok: false, diagnosticCode: "aborted" };

        const requestController = new AbortController();
        let response: Response | null = null;
        let didTimeout = false;
        const onCallerAbort = () => requestController.abort();
        signal?.addEventListener("abort", onCallerAbort, { once: true });
        const timeoutId = setTimeout(() => {
            didTimeout = true;
            requestController.abort();
        }, requestTimeoutMs);

        try {
            response = await raceWithAbort(fetchImpl(url, {
                method: "GET",
                headers: {
                    "xi-api-key": apiKey,
                    Accept: "application/json",
                },
                redirect: "manual",
                signal: requestController.signal,
            }), requestController.signal);
            if (!response.ok) {
                await cancelResponseBody(response);
                return { ok: false, diagnosticCode: "provider_http_error" };
            }
            const parsed = await parseBoundedJsonResponse(response, requestController.signal, maxResponseBytes);
            if (!parsed.ok) {
                return { ok: false, diagnosticCode: "response_too_large" };
            }
            return { ok: true, payload: parsed.payload };
        } catch {
            if (response) await cancelResponseBody(response);
            return {
                ok: false,
                diagnosticCode: didTimeout ? "timeout" : signal?.aborted ? "aborted" : "network_error",
            };
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener("abort", onCallerAbort);
        }
    }

    const service: HostedElevenLabsService = {
        isApiConfigured: apiKey.length > 0,
        configuredAgentId,

        async mintConversationToken(
            input: Readonly<{ signal?: AbortSignal }> = {},
        ): Promise<HostedElevenLabsMintResult> {
            if (!apiKey) {
                return { ok: false, reason: "misconfigured", diagnosticCode: "missing_api_key" };
            }
            if (!configuredAgentId) {
                return { ok: false, reason: "misconfigured", diagnosticCode: "missing_agent_id" };
            }

            const response = await providerRequest(
                `${apiBaseUrl}/v1/convai/conversation/token?agent_id=${encodeURIComponent(configuredAgentId)}`,
                MAX_MINT_RESPONSE_BYTES,
                input.signal,
            );
            if (!response.ok) {
                return { ok: false, reason: "upstream_error", diagnosticCode: response.diagnosticCode };
            }
            const parsed = mintResponseSchema.safeParse(response.payload);
            if (!parsed.success) {
                return { ok: false, reason: "upstream_error", diagnosticCode: "invalid_mint_response" };
            }
            return { ok: true, token: parsed.data.token };
        },

        async verifyConversation(input: Readonly<{
            providerConversationId: string;
            expectedAgentId: string;
            expectedBindingNonce: string;
            leaseCreatedAt: Date;
            leaseExpiresAt: Date;
            signal?: AbortSignal;
        }>): Promise<HostedElevenLabsConversationVerificationResult> {
            if (!apiKey) {
                return { ok: false, reason: "upstream_error", diagnosticCode: "missing_api_key" };
            }
            const response = await providerRequest(
                `${apiBaseUrl}/v1/convai/conversations/${encodeURIComponent(input.providerConversationId)}`,
                MAX_CONVERSATION_RESPONSE_BYTES,
                input.signal,
            );
            if (!response.ok) {
                return { ok: false, reason: "upstream_error", diagnosticCode: response.diagnosticCode };
            }

            const payload = response.payload;
            const timing = extractConversationTiming(payload);
            const conversationId = extractConversationId(payload);
            if (!timing || !conversationId) {
                return { ok: false, reason: "upstream_error", diagnosticCode: "invalid_conversation_response" };
            }
            if (conversationId !== input.providerConversationId) {
                return { ok: false, reason: "not_found", diagnosticCode: "conversation_id_mismatch" };
            }
            if (extractConversationAgentId(payload) !== input.expectedAgentId) {
                return { ok: false, reason: "not_found", diagnosticCode: "agent_mismatch" };
            }
            if (extractConversationBindingNonce(payload) !== input.expectedBindingNonce) {
                return { ok: false, reason: "not_found", diagnosticCode: "binding_nonce_mismatch" };
            }

            const startedAt = new Date(timing.startUnixSeconds * 1000);
            const endedAt = new Date(startedAt.getTime() + timing.durationSeconds * 1000);
            const lowerBound = input.leaseCreatedAt.getTime() - LEASE_TIME_SKEW_MS;
            const upperBound = input.leaseExpiresAt.getTime() + LEASE_TIME_SKEW_MS;
            if (
                !Number.isFinite(startedAt.getTime()) ||
                !Number.isFinite(endedAt.getTime()) ||
                startedAt.getTime() < lowerBound ||
                startedAt.getTime() > upperBound ||
                endedAt.getTime() < lowerBound ||
                endedAt.getTime() > upperBound
            ) {
                return { ok: false, reason: "not_found", diagnosticCode: "conversation_outside_lease_window" };
            }

            return {
                ok: true,
                durationSeconds: timing.durationSeconds,
                startedAt,
                endedAt,
            };
        },
    };
    return Object.freeze(service);
}
