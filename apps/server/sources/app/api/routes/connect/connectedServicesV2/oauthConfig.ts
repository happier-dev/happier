import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_PROFILE_HEADERS, CLAUDE_OAUTH_PROFILE_URL, CLAUDE_OAUTH_TOKEN_URL } from '@happier-dev/protocol/providers/claude/oauth-profile';
import { OPENAI_CODEX_CLIENT_ID, OPENAI_CODEX_DEVICE_TOKEN_URL, OPENAI_CODEX_DEVICE_USER_CODE_URL, OPENAI_CODEX_TOKEN_URL } from '@happier-dev/protocol/providers/codex/oauth';
import { createOutboundFetch } from '@/app/net/outboundIdentityFetch';
import { vendorIdentityEndpointNetworkPolicy } from '@/app/net/outboundIdentityNetworkPolicy';

function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

export function resolveOpenAiCodexOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID, OPENAI_CODEX_CLIENT_ID);
}

export function resolveOpenAiCodexOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL, OPENAI_CODEX_TOKEN_URL);
}

export function resolveClaudeSubscriptionOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID, CLAUDE_OAUTH_CLIENT_ID);
}

export function resolveClaudeSubscriptionOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL, CLAUDE_OAUTH_TOKEN_URL);
}

export function resolveClaudeSubscriptionOauthProfileMetadata() {
  return Object.freeze({
    endpointUrl: CLAUDE_OAUTH_PROFILE_URL,
    headers: CLAUDE_OAUTH_PROFILE_HEADERS,
    projection: "claude_oauth_profile_entitlement" as const,
  });
}

/** The vendor endpoints these flows call; any other URL here is an operator override. */
const CONNECTED_SERVICE_OAUTH_VENDOR_URLS: ReadonlySet<string> = new Set([
  OPENAI_CODEX_TOKEN_URL, OPENAI_CODEX_DEVICE_TOKEN_URL, OPENAI_CODEX_DEVICE_USER_CODE_URL,
  CLAUDE_OAUTH_TOKEN_URL, CLAUDE_OAUTH_PROFILE_URL,
]);

/**
 * Default transport for connected-service OAuth requests: one request through the pinned
 * outbound owner, with the vendor or operator-override policy. The caller keeps its own
 * timeout and error mapping (it passes the signal); the returned body is already buffered.
 */
export const fetchConnectedServiceOauthEndpoint: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const outbound = createOutboundFetch({ policy: vendorIdentityEndpointNetworkPolicy(!CONNECTED_SERVICE_OAUTH_VENDOR_URLS.has(url)) });
  try {
    return await outbound.fetch(url, init);
  } finally {
    await outbound.close();
  }
};
