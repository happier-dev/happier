/**
 * OpenCode broker plugin-load handshake surface — a THIN alias over the SHARED, provider-agnostic core.
 *
 * The registry + endpoint paths live in `@happier-dev/plugin-sdk/experimental/cloud/broker` so a SINGLE daemon
 * registry + endpoint pair (`/connected-service-auth/broker/{loaded,loaded-status}`) serves BOTH the
 * OpenCode plugin and the Pi extension (keyed by the stable selection identity plus per-spawn load nonce,
 * not by provider). This module keeps the OpenCode-local names as aliases purely so existing OpenCode call
 * sites read naturally.
 *
 * See `loadHandshake.ts` in the shared core for the full F4 rationale (a present-but-not-loaded artifact
 * must fail the connected session closed instead of silently using no brokered auth).
 */
export {
  CONNECTED_SERVICE_BROKER_LOADED_PATH as OPEN_CODE_BROKER_LOADED_PATH,
  CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH as OPEN_CODE_BROKER_LOADED_STATUS_PATH,
  CONNECTED_SERVICE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS as OPEN_CODE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS,
  createBrokerLoadHandshakeRegistry as createOpenCodeBrokerLoadHandshakeRegistry,
  type BrokerLoadHandshakeRegistry as OpenCodeBrokerLoadHandshakeRegistry,
} from '@happier-dev/plugin-sdk/experimental/cloud/broker';
