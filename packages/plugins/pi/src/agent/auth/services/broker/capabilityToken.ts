/**
 * Pi broker capability-token surface — a THIN alias over the SHARED, provider-agnostic core.
 *
 * The Pi broker authenticates to the daemon bridge with the SAME scoped capability token as the
 * OpenCode broker (derived by HMAC from the daemon master control token). Sharing the derivation +
 * env name + scope label means the SINGLE daemon bridge preHandler (`verifyBrokerRefreshToken`)
 * authorizes both brokers — no parallel Pi refresh path, no duplicated crypto. This module keeps
 * Pi-local names as aliases purely so Pi call sites read naturally.
 */
export {
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV as PI_BROKER_REFRESH_TOKEN_ENV,
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL as PI_BROKER_REFRESH_SCOPE_LABEL,
  deriveConnectedServiceBrokerRefreshToken as derivePiBrokerRefreshToken,
  isValidConnectedServiceBrokerRefreshToken as isValidPiBrokerRefreshToken,
} from '@happier-dev/plugin-sdk/experimental/cloud/broker';
