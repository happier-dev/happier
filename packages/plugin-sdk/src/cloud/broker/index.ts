/**
 * Shared, provider-agnostic connected-service auth BROKER core.
 *
 * Consumed by broker plugins and the daemon control server / session control runtime. Centralizing the
 * capability-token derivation, provider-neutral daemon bridge-call source builder, and the load-handshake
 * registry/endpoints here means:
 *  - a SINGLE bridge preHandler authorizes both brokers (one scoped-token derivation + scope label),
 *  - runtime artifacts stay in lockstep on bridge-call mechanics (one bridge-call builder), and
 *  - one daemon load-handshake registry/endpoint pair serves both brokers (keyed by selection identity
 *    plus per-spawn load nonce).
 *
 * The provider-specific runtime artifact wrappers, request shaping, env namespaces, on-disk asset
 * layout, and preflight checks stay in the owning plugin packages and consume this core; broker plugins
 * do not import each other.
 */
export {
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV,
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL,
  deriveConnectedServiceBrokerRefreshToken,
  deriveScopedCapabilityToken,
  isValidConnectedServiceBrokerRefreshToken,
  isValidScopedCapabilityToken,
} from './capabilityToken.js';
export {
  buildBrokerBridgeCallSource,
  type BrokerBridgeCallSourceParams,
} from './bridgeCallSource.js';
export {
  CONNECTED_SERVICE_BROKER_LOADED_PATH,
  CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH,
  CONNECTED_SERVICE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS,
  createBrokerLoadHandshakeRegistry,
  type BrokerLoadHandshakeRegistry,
} from './loadHandshake.js';
export {
  CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
} from './daemonAuthBridge.js';
