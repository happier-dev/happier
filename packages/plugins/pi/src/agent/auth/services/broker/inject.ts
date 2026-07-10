import {
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  parsePiBrokerSelections,
} from './env.js';
import {
  PI_BROKER_REFRESH_TOKEN_ENV,
  derivePiBrokerRefreshToken,
} from './capabilityToken.js';

/**
 * Inject the SCOPED broker-refresh capability token into the Pi child env for connected brokered
 * sessions ONLY (least privilege / F2). The token is derived (HMAC) from the daemon master control
 * token; ONLY the derived token is placed in the env. The master control token is NEVER injected, so a
 * leaked broker token cannot reach the broad control surface.
 *
 * Native Pi sessions (no selection identity) and direct-API-key connected sessions (no brokered Pi
 * provider) are a strict no-op. Fail-closed: if the control token is unavailable the scoped token is
 * simply not injected; the broker then fails its `readScopedToken()` and the preflight reports it,
 * rather than the broker silently falling back to anything.
 */
export function applyPiBrokerRefreshTokenEnv(
  env: Record<string, string>,
  controlToken: string | null | undefined,
): void {
  if (typeof env[PI_BROKER_SELECTION_IDENTITY_ENV] !== 'string') return;
  const selections = parsePiBrokerSelections(env[PI_BROKER_SELECTIONS_ENV]);
  const hasBrokeredProvider = PI_BROKER_PROVIDERS.some((provider) => selections[provider]);
  if (!hasBrokeredProvider) return;

  const scoped = derivePiBrokerRefreshToken(controlToken);
  if (!scoped) return;
  env[PI_BROKER_REFRESH_TOKEN_ENV] = scoped;
}
