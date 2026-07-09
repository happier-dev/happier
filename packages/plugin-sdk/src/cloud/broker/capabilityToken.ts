import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Scoped broker-refresh capability token (least privilege; hardening finding F2).
 *
 * Shared, provider-agnostic core used by every connected-service auth broker and by the single daemon
 * bridge preHandler that authorizes them. A broker must NOT receive the daemon's full `controlToken`
 * (which authorizes EVERY control endpoint). Instead the daemon mints a NARROW capability token, scoped
 * to the broker-refresh endpoints only, derived
 * deterministically from the master control token:
 *
 *   token = base64url( HMAC-SHA256(controlToken, BROKER_REFRESH_SCOPE_LABEL) )
 *
 * Properties:
 *  - The broker holds ONLY this derived token (injected via the runtime child env), never the master.
 *    A leaked broker token cannot call the broad control surface (the broad endpoints keep
 *    `requireAuth`, which compares the master token; the scoped token does not match it).
 *  - The daemon re-derives the same value from its in-memory master `controlToken` and constant-time
 *    compares — no extra persisted secret, no parallel token-store mechanism.
 *  - It is rebound to the daemon's master secret: a daemon restart re-mints `controlToken`, which
 *    rotates the scoped token.
 *  - It is provider-agnostic: every broker derives the SAME value, so a SINGLE bridge preHandler
 *    authorizes broker refresh calls (no parallel per-provider refresh path / no parallel token mechanism).
 */
export const CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV = 'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN';

/**
 * Scope label folded into the HMAC. Versioned so a future scope/format change is unambiguous and
 * never collides with the master token or another derived capability. Provider-agnostic: every broker
 * folds the SAME label so the SAME scoped token authorizes the shared bridge.
 */
export const CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL = 'happier:connected-service-broker-refresh:v1';

/**
 * ONE derivation core for every scoped capability token (the scope is the HMAC label; empty
 * inputs fail closed). Every scoped daemon capability (broker refresh, execution-run
 * materialization, future scopes) derives through THIS function — no parallel HMAC/verify
 * implementations.
 */
export function deriveScopedCapabilityToken(
  controlToken: string | null | undefined,
  scopeLabel: string,
): string {
  const normalized = typeof controlToken === 'string' ? controlToken.trim() : '';
  if (!normalized) return '';
  return createHmac('sha256', normalized)
    .update(scopeLabel)
    .digest('base64url');
}

/**
 * Constant-time verification that `provided` is the scoped capability token for `controlToken`
 * under `scopeLabel`. Fails closed on any empty/blank input. Hashes both sides to a fixed length
 * so `timingSafeEqual` never throws on a length mismatch and the comparison stays constant-time
 * regardless of input shape.
 */
export function isValidScopedCapabilityToken(
  provided: string | null | undefined,
  controlToken: string | null | undefined,
  scopeLabel: string,
): boolean {
  const expected = deriveScopedCapabilityToken(controlToken, scopeLabel);
  const candidate = typeof provided === 'string' ? provided.trim() : '';
  if (!expected || !candidate) return false;
  const expectedDigest = createHash('sha256').update(expected).digest();
  const candidateDigest = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

/**
 * Derive the scoped broker-refresh capability token from the daemon master control token.
 * Returns an empty string for an empty/blank control token (fail-closed: an empty token never
 * authorizes anything because the verifier rejects empty providers).
 */
export function deriveConnectedServiceBrokerRefreshToken(controlToken: string | null | undefined): string {
  return deriveScopedCapabilityToken(controlToken, CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
}

/**
 * Constant-time verification that `provided` is the scoped broker-refresh token for `controlToken`.
 * Fails closed on any empty/blank input. Used by the daemon control server's dedicated broker-refresh
 * preHandler (NOT the broad `requireAuth`).
 */
export function isValidConnectedServiceBrokerRefreshToken(
  provided: string | null | undefined,
  controlToken: string | null | undefined,
): boolean {
  return isValidScopedCapabilityToken(provided, controlToken, CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
}
