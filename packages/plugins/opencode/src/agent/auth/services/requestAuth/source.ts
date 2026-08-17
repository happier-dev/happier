import type { JsonValue } from '@happier-dev/plugin-sdk';

import { OPEN_CODE_REQUEST_AUTH_TARGET_ORIGINS } from './purposes.js';

export type OpenCodeRequestAuthProvider = 'openai' | 'anthropic';

export const OPEN_CODE_REQUEST_AUTH_PLUGIN_VERSION = '1';
export const OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const OPEN_CODE_REQUEST_AUTH_ANTHROPIC_BETA = 'oauth-2025-04-20';

export function buildOpenCodeRequestAuthMarker(provider: OpenCodeRequestAuthProvider): string {
  return `happier-request-auth:${provider}:${OPEN_CODE_REQUEST_AUTH_PLUGIN_VERSION}`;
}

function js(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Builds the existing OpenCode auth interceptor with the canonical request-auth transport injected.
 * Each fetch invocation is one independent upstream attempt and performs exactly one lookup.
 */
export function buildOpenCodeRequestAuthPluginSource(input: Readonly<{
  provider: OpenCodeRequestAuthProvider;
  purpose: JsonValue;
  requestAuthClientSource: string;
}>): string {
  return `// Happier OpenCode connected-account request-auth plugin (generated).
import { readFileSync } from "node:fs";

${input.requestAuthClientSource}

const PROVIDER = ${js(input.provider)};
const PURPOSE = Object.freeze(${js(input.purpose)});
const MARKER = ${js(buildOpenCodeRequestAuthMarker(input.provider))};
const CODEX_BASE_URL = ${js(OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL)};
const REQUEST_AUTH_TARGET_ORIGIN = ${js(OPEN_CODE_REQUEST_AUTH_TARGET_ORIGINS[input.provider])};
const ANTHROPIC_BETA = ${js(OPEN_CODE_REQUEST_AUTH_ANTHROPIC_BETA)};
const ANTHROPIC_SYSTEM_IDENTITY = ${js("You are Claude Code, Anthropic's official CLI for Claude.")};

function rewriteCodexUrl(url) {
  return String(url).replace("/responses", "/codex/responses");
}

function requireRequestAuthDestination(url) {
  let destination;
  try {
    destination = new URL(url);
  } catch {
    throw new Error("happier_opencode_request_auth_destination_mismatch");
  }
  if (
    destination.protocol !== "https:"
    || destination.origin !== REQUEST_AUTH_TARGET_ORIGIN
    || destination.username
    || destination.password
  ) {
    throw new Error("happier_opencode_request_auth_destination_mismatch");
  }
  return destination.toString();
}

function isRedirectResponse(response) {
  return response.status === 301
    || response.status === 302
    || response.status === 303
    || response.status === 307
    || response.status === 308;
}

function mergeRequiredHeaders(init, lease) {
  const headers = new Headers(init && init.headers ? init.headers : {});
  headers.delete("authorization");
  headers.delete("chatgpt-account-id");
  headers.delete("x-api-key");
  headers.delete("x-claude-code-session-id");
  headers.set("authorization", "Bearer " + lease.accessToken);
  for (const [name, value] of Object.entries(lease.requiredHeaders || {})) {
    headers.set(name, value);
  }
  if (PROVIDER === "openai") {
    headers.set("openai-beta", "responses=experimental");
    headers.set("originator", "codex_cli_rs");
    headers.set("accept", "text/event-stream");
  } else {
    const existing = headers.get("anthropic-beta");
    headers.set(
      "anthropic-beta",
      existing && !existing.split(",").includes(ANTHROPIC_BETA)
        ? existing + "," + ANTHROPIC_BETA
        : ANTHROPIC_BETA,
    );
    if (!headers.get("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  }
  return headers;
}

function transformCodexBody(init) {
  if (!init || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body);
    body.store = false;
    const include = Array.isArray(body.include) ? body.include.slice() : [];
    if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
    body.include = include;
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

function injectAnthropicIdentity(init) {
  if (!init || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body);
    const identity = { type: "text", text: ANTHROPIC_SYSTEM_IDENTITY };
    if (Array.isArray(body.system)) {
      const first = body.system[0];
      const firstText = first && typeof first.text === "string" ? first.text : first;
      if (firstText !== ANTHROPIC_SYSTEM_IDENTITY) body.system = [identity, ...body.system];
    } else if (typeof body.system === "string" && body.system.length > 0) {
      if (body.system !== ANTHROPIC_SYSTEM_IDENTITY) {
        body.system = [identity, { type: "text", text: body.system }];
      }
    } else {
      body.system = [identity];
    }
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

async function reportExactFailure(response, lease, signal) {
  if (response.status === 401) {
    return await reportConnectedAccountAuthFailure({
      credentialContext: lease.credentialContext,
      normalizedFailure: {
        class: "authentication",
        evidence: {
          httpStatus: 401,
          limitCategory: "auth_invalid",
          quotaScope: "unknown",
          evidenceSource: { kind: "structured" },
        },
      },
      signal,
    });
  } else if (response.status === 429) {
    return await reportConnectedAccountQuotaFailure({
      credentialContext: lease.credentialContext,
      normalizedFailure: {
        class: "quota",
        evidence: {
          httpStatus: 429,
          limitCategory: "rate_limit",
          quotaScope: "unknown",
          evidenceSource: { kind: "structured" },
        },
      },
      signal,
    });
  }
  return null;
}

function isReplayableRequest(requestInput, init) {
  const inputReplayable = typeof requestInput === "string"
    || (typeof URL !== "undefined" && requestInput instanceof URL);
  const body = init && init.body;
  return inputReplayable && (body === undefined || body === null || typeof body === "string");
}

function canRetryAfterOutcome(outcome) {
  return outcome
    && (outcome.status === "stale_context" || outcome.status === "current_changed");
}

async function requestAuthFetch(requestInput, init) {
  const url = typeof requestInput === "string"
    ? requestInput
    : requestInput && requestInput.url
      ? requestInput.url
      : String(requestInput);
  const shaped = PROVIDER === "openai"
    ? transformCodexBody(init)
    : injectAnthropicIdentity(init);
  // Validate before obtaining any bearer. Redirects are rejected below rather than
  // allowing a credential-bearing fetch to choose a later destination.
  const destination = requireRequestAuthDestination(
    PROVIDER === "openai" ? rewriteCodexUrl(url) : url,
  );
  const retrySafe = isReplayableRequest(requestInput, shaped);
  let retryUsed = false;
  while (true) {
    // This is the attempt boundary: no child cache, TTL, or shared in-flight lookup.
    const lease = await lookupConnectedAccountRequestAuth({
      purpose: PURPOSE,
      signal: shaped && shaped.signal,
    });
    const response = await fetch(
      destination,
      { ...shaped, redirect: "manual", headers: mergeRequiredHeaders(shaped, lease) },
    );
    if (isRedirectResponse(response)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("happier_opencode_request_auth_redirect_rejected");
    }
    if (response.status !== 401 && response.status !== 429) return response;

    let outcome = null;
    try {
      outcome = await reportExactFailure(response, lease, shaped && shaped.signal);
    } catch {
      // Preserve the exact upstream rejection if daemon recovery is unavailable.
    }
    if (
      retryUsed
      || !retrySafe
      || !canRetryAfterOutcome(outcome)
      || (shaped && shaped.signal && shaped.signal.aborted)
    ) {
      return response;
    }
    // Once this leaf admits a replay, the rejected response is no longer observable.
    // Release its stream before starting the one allowed replacement attempt.
    await response.body?.cancel().catch(() => undefined);
    retryUsed = true;
  }
}

const HappierOpenCodeRequestAuthPlugin = async () => ({
  auth: {
    provider: PROVIDER,
    methods: [],
    loader: async (getAuth) => {
      const auth = await getAuth().catch(() => null);
      if (!auth || auth.key !== MARKER) return {};
      return {
        apiKey: MARKER,
        fetch: requestAuthFetch,
        ...(PROVIDER === "openai" ? { baseURL: CODEX_BASE_URL } : {}),
      };
    },
  },
});

export default HappierOpenCodeRequestAuthPlugin;
`;
}
