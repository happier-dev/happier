import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { normalizeProviderOriginRelativePathSyntax } from '@happier-dev/protocol/providers/safety/url';
import { normalizeProviderPublicHeaders } from '@happier-dev/protocol/providers/credential-headers';
import { TeamCredentialRequestPolicyV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { TeamCredentialRequestPolicyV1, TeamCredentialRequestProtocolKindV1 } from '@happier-dev/protocol/teams';

export type TeamCredentialRequestPolicyFailureCodeV1 =
    | 'request_malformed'
    | 'route_not_allowed'
    | 'model_not_allowed'
    | 'reasoning_effort_not_allowed'
    | 'request_constraint_unsupported';

export type TeamCredentialRequestPolicyEvaluationV1 =
    | Readonly<{
        ok: true;
        request: ManagedServiceRequest;
        generation: boolean;
        routeKind: TeamCredentialRequestProtocolKindV1;
        modelId: string;
        reasoningEffort: string | null;
    }>
    | Readonly<{ ok: false; reasonCode: TeamCredentialRequestPolicyFailureCodeV1 }>;

type JsonObject = Record<string, unknown>;

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const OBJECT_KEY_POISON_HEADER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const STRIPPED_REQUEST_HEADERS = new Set([
    'api-key',
    'authorization',
    'connection',
    'content-length',
    'cookie',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-api-key',
]);

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseBody(request: ManagedServiceRequest): JsonObject | null {
    if (request.method !== 'POST' || !request.body) return null;
    try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body));
        return isObject(value) ? value : null;
    } catch {
        return null;
    }
}

function normalizeHeaderName(rawName: string): string | null {
    if (rawName.trim() !== rawName
        || rawName.length === 0
        || rawName.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHeaderNameChars
        || !HEADER_NAME_PATTERN.test(rawName)) return null;
    const normalized = rawName.toLowerCase();
    return OBJECT_KEY_POISON_HEADER_NAMES.has(normalized) ? null : normalized;
}

/**
 * Normalizes the exact request that policy may admit. This is intentionally
 * inside the policy owner: admission and every forwarding consumer receive
 * the same safe bytes, so no caller can authorize one request and dispatch a
 * differently sanitized one.
 */
function sanitizeRequest(request: ManagedServiceRequest): ManagedServiceRequest | null {
    if (request.body && request.body.byteLength > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxDecodedBodyBytes) return null;
    let pathAndQuery: string;
    try {
        pathAndQuery = normalizeProviderOriginRelativePathSyntax(request.pathAndQuery, { allowQuery: true });
    } catch {
        return null;
    }

    const entries = Object.entries(request.headers ?? {});
    if (entries.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxPublicHeaders) return null;
    const normalized = new Map<string, string>();
    for (const [rawName, value] of entries) {
        const name = normalizeHeaderName(rawName);
        if (name === null
            || normalized.has(name)
            || typeof value !== 'string'
            || value.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHeaderValueChars
            || CONTROL_CHARACTER_PATTERN.test(value)) return null;
        normalized.set(name, value);
    }

    const connectionValue = normalized.get('connection');
    const connectionNominated = new Set<string>();
    if (connectionValue !== undefined) {
        const tokens = connectionValue.split(',').map((token) => token.trim());
        if (tokens.length === 0 || tokens.some((token) => token.length === 0)) return null;
        for (const token of tokens) {
            const name = normalizeHeaderName(token);
            if (name === null) return null;
            connectionNominated.add(name);
        }
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of normalized) {
        if (STRIPPED_REQUEST_HEADERS.has(name)
            || connectionNominated.has(name)
            || name === 'forwarded'
            || name.startsWith('x-forwarded-')
            || name.startsWith('x-happier-')) continue;
        headers[name] = value;
    }
    try {
        const publicHeaders = normalizeProviderPublicHeaders(headers);
        return {
            ...request,
            pathAndQuery,
            headers: Object.keys(publicHeaders).length > 0 ? publicHeaders : undefined,
        };
    } catch {
        return null;
    }
}

/** Canonical closed managed-inference route classifier shared by policy and
 * composition; callers must not infer a protocol from an open `/v1/*` prefix. */
export function classifyTeamCredentialRequestRouteV1(pathAndQuery: string): Readonly<{
    kind: TeamCredentialRequestProtocolKindV1;
    generation: boolean;
}> | null {
    const path = pathAndQuery.split('?', 1)[0];
    if (path === '/v1/responses') return { kind: 'openai_responses', generation: true };
    if (path === '/v1/chat/completions') return { kind: 'openai_chat_completions', generation: true };
    if (path === '/v1/messages') return { kind: 'anthropic_messages', generation: true };
    if (path === '/v1/messages/count_tokens') return { kind: 'anthropic_messages', generation: false };
    return null;
}

function configuredEffort(
    policy: TeamCredentialRequestPolicyV1,
    value: unknown,
): Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false; reasonCode: TeamCredentialRequestPolicyFailureCodeV1 }> {
    if (value !== undefined && typeof value !== 'string') return { ok: false, reasonCode: 'request_malformed' };
    if (!policy.reasoningEffort) return { ok: true, value: value ?? null };
    const effort = value ?? policy.reasoningEffort.defaultValue;
    if (!policy.reasoningEffort.allowedValues.includes(effort)) {
        return { ok: false, reasonCode: 'reasoning_effort_not_allowed' };
    }
    return { ok: true, value: effort };
}

/** The policy owns no token bound, so the caller's own output field passes
 * through unchanged; only its shape and protocol-required presence are checked. */
function hasUsableOutputTokens(body: JsonObject, field: string, required: boolean): boolean {
    const supplied = body[field];
    if (supplied !== undefined && readPositiveInteger(supplied) === null) return false;
    return !(required && supplied === undefined);
}

/**
 * The sole Team-credential request-policy parser/evaluator. It parses only the
 * fixed managed inference routes, preserves unrelated Provider fields, and
 * returns the exact body that may be forwarded after Home admission.
 */
export function evaluateTeamCredentialRequestPolicyV1(input: Readonly<{
    policy: TeamCredentialRequestPolicyV1;
    request: ManagedServiceRequest;
    resolveCanonicalModelId?: (requestedModelId: string) => string | null;
}>): TeamCredentialRequestPolicyEvaluationV1 {
    const parsedPolicy = TeamCredentialRequestPolicyV1Schema.safeParse(input.policy);
    if (!parsedPolicy.success) return { ok: false, reasonCode: 'request_constraint_unsupported' };
    const request = sanitizeRequest(input.request);
    if (!request) return { ok: false, reasonCode: 'request_malformed' };
    const route = classifyTeamCredentialRequestRouteV1(request.pathAndQuery);
    if (!route) return { ok: false, reasonCode: 'route_not_allowed' };
    if (parsedPolicy.data.allowedProtocolKinds && !parsedPolicy.data.allowedProtocolKinds.includes(route.kind)) {
        return { ok: false, reasonCode: 'route_not_allowed' };
    }
    const body = parseBody(request);
    if (!body || typeof body.model !== 'string' || body.model.trim() !== body.model || body.model.length === 0) {
        return { ok: false, reasonCode: 'request_malformed' };
    }
    const requestedModelId = body.model;
    const canonicalModelId = input.resolveCanonicalModelId
        ? input.resolveCanonicalModelId(requestedModelId)
        : requestedModelId;
    if (!canonicalModelId) return { ok: false, reasonCode: 'model_not_allowed' };
    if (parsedPolicy.data.allowedModelIds
        && !parsedPolicy.data.allowedModelIds.includes(canonicalModelId)) {
        return { ok: false, reasonCode: 'model_not_allowed' };
    }
    if (!route.generation) {
        return {
            ok: true,
            request: {
                ...request,
                body: new TextEncoder().encode(JSON.stringify(body)),
            },
            generation: false,
            routeKind: route.kind,
            modelId: canonicalModelId,
            reasoningEffort: null,
        };
    }

    let effort: Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false; reasonCode: TeamCredentialRequestPolicyFailureCodeV1 }>;
    if (route.kind === 'openai_responses') {
        if (body.reasoning !== undefined && !isObject(body.reasoning)) return { ok: false, reasonCode: 'request_malformed' };
        const reasoning = body.reasoning as JsonObject | undefined;
        effort = configuredEffort(parsedPolicy.data, reasoning?.effort);
        if (!effort.ok) return effort;
        if (effort.value !== null) body.reasoning = { ...(reasoning ?? {}), effort: effort.value };
        if (!hasUsableOutputTokens(body, 'max_output_tokens', false)) {
            return { ok: false, reasonCode: 'request_malformed' };
        }
    } else if (route.kind === 'openai_chat_completions') {
        if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
            return { ok: false, reasonCode: 'request_malformed' };
        }
        effort = configuredEffort(parsedPolicy.data, body.reasoning_effort);
        if (!effort.ok) return effort;
        if (effort.value !== null) body.reasoning_effort = effort.value;
        const outputField = body.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens';
        if (!hasUsableOutputTokens(body, outputField, false)) {
            return { ok: false, reasonCode: 'request_malformed' };
        }
    } else {
        if (body.output_config !== undefined && !isObject(body.output_config)) return { ok: false, reasonCode: 'request_malformed' };
        const outputConfig = body.output_config as JsonObject | undefined;
        effort = configuredEffort(parsedPolicy.data, outputConfig?.effort);
        if (!effort.ok) return effort;
        if (effort.value !== null) body.output_config = { ...(outputConfig ?? {}), effort: effort.value };
        if (!hasUsableOutputTokens(body, 'max_tokens', route.generation)) {
            return { ok: false, reasonCode: 'request_malformed' };
        }
        if (body.thinking !== undefined && !isObject(body.thinking)) return { ok: false, reasonCode: 'request_malformed' };
        const thinking = body.thinking as JsonObject | undefined;
        if (thinking) {
            if (thinking.type !== 'enabled' && thinking.type !== 'adaptive' && thinking.type !== 'disabled') {
                return { ok: false, reasonCode: 'request_malformed' };
            }
            if (thinking.type !== 'enabled' && thinking.budget_tokens !== undefined) {
                return { ok: false, reasonCode: 'request_malformed' };
            }
            if (thinking.type === 'enabled') {
                const budget = readPositiveInteger(thinking.budget_tokens);
                if (budget === null || budget < 1_024) return { ok: false, reasonCode: 'request_malformed' };
                // Anthropic requires the budget to stay below the output bound.
                const output = readPositiveInteger(body.max_tokens);
                if (output === null || budget >= output) {
                    return { ok: false, reasonCode: 'request_constraint_unsupported' };
                }
            }
        }
    }

    return {
        ok: true,
        request: {
            ...request,
            body: new TextEncoder().encode(JSON.stringify(body)),
        },
        generation: route.generation,
        routeKind: route.kind,
        modelId: canonicalModelId,
        reasoningEffort: effort.value,
    };
}
