import { defineServerConfigRegistry, type ServerConfigEntry } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

/**
 * Per-route API rate-limit defaults and the configuration keys derived from them.
 *
 * This module is the one declaration of every rate-limit key: each id below yields
 * `HAPPIER_<ID>_RATE_LIMIT_MAX` and `HAPPIER_<ID>_RATE_LIMIT_WINDOW`, and the global switches are
 * declared beside them. Limits are registered once with the routes, so a change applies at the
 * next start.
 */
export type ApiRateLimitDefaults = Readonly<{
    defaultMax: number;
    defaultWindow: string;
    /**
     * How to key the rate limit. Defaults to `user` (verified user id with IP fallback).
     */
    keyMode?: "user" | "ip";
}>;

export const API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS = {
    "session.messages": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "session.messages.byLocalId": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "session.detail": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "sessions.list": { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    changes: { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    features: { defaultMax: 120, defaultWindow: "1 minute", keyMode: "ip" },
    machines: { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "machines.peerMediation.routeGrant": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    artifacts: { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    feed: { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "kv.list": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "billing.refresh": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "supporter.lookup": { defaultMax: 20, defaultWindow: "1 minute", keyMode: "ip" },
    "supporter.profile": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "account.profile": { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "account.settings": { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "connectedServices.quotas.read": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "connectedServices.quotas.write": { defaultMax: 120, defaultWindow: "1 minute", keyMode: "user" },
    "connectedServices.quotas.refresh": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "connectedServices.deviceAuth.start": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "user" },
    "connectedServices.deviceAuth.poll": { defaultMax: 240, defaultWindow: "1 minute", keyMode: "user" },
    "session.pending": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "session.pending.materialize": { defaultMax: 120, defaultWindow: "1 minute", keyMode: "user" },
    // Discussions share one profile: an open Collaboration surface reads lists,
    // pages and cursors at roughly the same cadence as the session transcript it
    // sits beside, and no measured traffic separates its reads from its writes.
    "session.discussions": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    // Board mutations are user-scoped, transaction-backed Session writes. The
    // ceiling protects aggregate SSR transaction capacity while retaining the
    // same burst budget as the incumbent interactive Session mutation surface.
    "session.board": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "diagnostics.bugReportSnapshot": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "user" },
    "voice.token": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "voice.sessionComplete": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.start": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.status": { defaultMax: 240, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.consume": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.request": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "ip" },
    // Joining clients poll once per second. Keep the unauthenticated IP key,
    // but leave enough burst room for multiple clients behind one NAT or Iroh
    // loopback endpoint without throttling the product's own happy path.
    "auth.accountRequest.poll": { defaultMax: 240, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.accountRequest.complete": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.entry": { defaultMax: 120, defaultWindow: "1 minute", keyMode: "ip" },
    // POST /v1/auth/request creates or refreshes one enrollment request. The
    // high-cadence wait loop uses the separate status bucket below.
    "auth.terminalRequest.poll": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.terminalRequest.status": { defaultMax: 240, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.terminalRequest.claim": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.terminalRequest.complete": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.homeApproval.list": { defaultMax: 240, defaultWindow: "1 minute", keyMode: "user" },
    "auth.homeApproval.decision": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.keyChallenge.issue": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.keyChallenge.redeem": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "ip" },
    // Native email/password V1 defaults. A limit firing returns the shared
    // rate-limit result and never changes existence-neutral disclosure.
    "auth.email.prelogin": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.email.login": { defaultMax: 20, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.email.unlock": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.email.stepUp": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "auth.email.verify.request": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.email.verify.requestAuthenticated": { defaultMax: 5, defaultWindow: "1 minute", keyMode: "user" },
    // A test email goes out through the owner's own SMTP relay: the same authenticated per-user
    // budget as a user-requested verification mail protects that relay's reputation.
    "home.mailDelivery.test": { defaultMax: 5, defaultWindow: "1 minute", keyMode: "user" },
    // Redeeming a Home claim code is a secret-entry boundary like unlocking a password envelope:
    // the same per-address budget. Keyed by address, not Account, because anyone who can sign up
    // on an ownerless Home can hold an Account to guess from.
    "home.governance.claim": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.email.verify.preview": { defaultMax: 20, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.password.reset.request": { defaultMax: 5, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.password.reset.preview": { defaultMax: 20, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.password.reset.submit": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "ip" },
    "auth.password.mutate": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "account.security.read": { defaultMax: 120, defaultWindow: "1 minute", keyMode: "user" },
    // API-token management is an Account Security surface, but it retains its
    // own operator knobs. The defaults deliberately match the corresponding
    // Security read/mutation cadence instead of introducing a new threshold.
    "auth.apiTokens.read": { defaultMax: 120, defaultWindow: "1 minute", keyMode: "user" },
    "auth.apiTokens.mutate": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "oauthExternal.authParams": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "ip" },
    "oauthExternal.connectParams": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "oauthExternal.callback": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "ip" },
    "share.public.read": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "ip" },
    "share.public.messages": { defaultMax: 20, defaultWindow: "1 minute", keyMode: "ip" },
    "share.public.manage": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "liveActivity.hostedRelay": { defaultMax: 120, defaultWindow: "1 minute", keyMode: "ip" },
    // Bearer-only Action ingress is keyed by IP so rate limiting never
    // performs a second PAT verification before the route's onRequest auth.
    actions: { defaultMax: 600, defaultWindow: "1 minute", keyMode: "ip" },
    // External Provider ingress shares the existing public streamed-request
    // capacity profile. Team usage limits remain the authenticated resource
    // policy owner; this bucket only protects unauthenticated edge work.
    "providerBroker.externalApi": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "ip" },
    "accountDirectory.read": { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "accountDirectory.mutate": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "accountDirectory.assertionMint": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "user" },
    "accountDirectory.assertionRedeem": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "ip" },
} as const satisfies Record<string, ApiRateLimitDefaults>;

export type ApiHotEndpointRateLimitId = keyof typeof API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS;

function toUpperSnakeCase(input: string): string {
    const normalized = input
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return normalized.toUpperCase();
}

export function resolveRateLimitEnvKeysForId(id: string): { maxEnvKey: string; windowEnvKey: string } {
    const prefix = toUpperSnakeCase(id);
    return {
        maxEnvKey: `HAPPIER_${prefix}_RATE_LIMIT_MAX`,
        windowEnvKey: `HAPPIER_${prefix}_RATE_LIMIT_WINDOW`,
    };
}


function normalizeApiRateLimitKeyStrategy(raw: string): string {
    if (["ip", "ip_only"].includes(raw)) return "ip-only";
    if (["user", "user_or_ip", "userorip"].includes(raw)) return "user-or-ip";
    return raw;
}

/** Global switches read by `apiRateLimitPolicy.ts`. */
export const API_RATE_LIMIT_GLOBAL_SERVER_CONFIG = defineServerConfigRegistry({
    HAPPIER_API_RATE_LIMITS_ENABLED: {
        type: "boolean",
        default: true,
        sensitivity: "plain",
        apply: "restart",
        editable: "home",
        section: "server",
        family: "rateLimits",
        description: "Turns every API rate limit on or off.",
        docs: "self-hosting/env#api-rate-limits",
    },
    HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: {
        type: "int",
        default: 0,
        bounds: { min: 0 },
        sensitivity: "plain",
        apply: "restart",
        editable: "home",
        section: "server",
        family: "rateLimits",
        description: "Requests allowed per window across all routes for one client; 0 turns the global limit off.",
        docs: "self-hosting/env#api-rate-limits",
    },
    HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: {
        type: "string",
        default: "1 minute",
        sensitivity: "plain",
        apply: "restart",
        editable: "home",
        section: "server",
        family: "rateLimits",
        description: "Window of the global limit, in @fastify/rate-limit syntax (for example `1 minute`).",
        docs: "self-hosting/env#api-rate-limits",
    },
    HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: {
        type: "enum",
        default: "default",
        bounds: { values: ["default", "ip-only", "user-or-ip"] },
        normalizeEnumValue: normalizeApiRateLimitKeyStrategy,
        sensitivity: "plain",
        apply: "restart",
        editable: "home",
        section: "server",
        family: "rateLimits",
        description: "How the global limit keys clients: `ip-only` (default) or `user-or-ip`.",
        docs: "self-hosting/env#api-rate-limits",
    },
    HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: {
        type: "enum",
        default: "default",
        bounds: { values: ["default", "ip-only", "user-or-ip"] },
        normalizeEnumValue: normalizeApiRateLimitKeyStrategy,
        sensitivity: "plain",
        apply: "restart",
        editable: "home",
        section: "server",
        family: "rateLimits",
        description: "How per-route limits key clients: `user-or-ip` (default) or `ip-only`.",
        docs: "self-hosting/env#api-rate-limits",
    },
    HAPPIER_SERVER_TRUST_PROXY: {
        type: "string",
        sensitivity: "plain",
        apply: "restart",
        editable: "home",
        section: "server",
        family: "rateLimits",
        description: "Trust `X-Forwarded-*` only from the listed proxy addresses or CIDRs; `true` trusts all peers and `false` trusts none. Numeric hop counts are rejected.",
        docs: "self-hosting/env#networking--reverse-proxy",
    },
});

/** The derived per-route keys, two per rate-limit id. */
export const API_ROUTE_RATE_LIMIT_SERVER_CONFIG: readonly ServerConfigEntry[] = Object.freeze(
    Object.entries(API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS).flatMap(([id, defaults]): ServerConfigEntry[] => {
        const keys = resolveRateLimitEnvKeysForId(id);
        const shared = {
            sensitivity: "plain",
            apply: "restart",
            editable: "home",
            section: "server",
            family: "rateLimits",
            docs: "self-hosting/env#api-rate-limits",
        } as const;
        return [
            {
                ...shared,
                key: keys.maxEnvKey,
                type: "int",
                default: defaults.defaultMax,
                bounds: { min: 0 },
                description: `Requests allowed per window on \`${id}\` (keyed by ${defaults.keyMode === "ip" ? "IP" : "user, else IP"}); 0 turns it off.`,
            },
            {
                ...shared,
                key: keys.windowEnvKey,
                type: "string",
                default: defaults.defaultWindow,
                description: `Window of the \`${id}\` limit.`,
            },
        ];
    }),
);
