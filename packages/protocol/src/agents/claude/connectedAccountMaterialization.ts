/**
 * Producer-declared, non-secret materialization contract for the Claude
 * Subscription Connected Account. Consumers use this instead of inferring an
 * account mode from a display label, token shape, or an empty environment.
 */
export const CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 = Object.freeze({
  service: Object.freeze({
    pluginId: 'happier.agent.claude',
    localId: 'claude-subscription',
  }),
  setupToken: Object.freeze({
    authenticationModeId: 'setup-token',
    environmentKey: 'CLAUDE_CODE_OAUTH_TOKEN',
  }),
  oauth: Object.freeze({
    authenticationModeId: 'oauth',
    requestAuthRequiredErrorCode:
      'plugin_connected_account_claude_subscription_oauth_request_auth_required',
  }),
  unsupportedEnvironmentRequestErrorCode:
    'plugin_connected_account_claude_subscription_environment_request_unsupported',
});

export const CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1 = Object.freeze({
  kind: 'environment' as const,
  keys: Object.freeze([
    CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey,
  ]),
});
