export const COPILOT_AUTH_ENV_VARS = Object.freeze([
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const);

export const COPILOT_GH_AUTH_PROBE = Object.freeze({
  command: 'gh',
  args: ['auth', 'token'],
  timeoutEnvKey: 'HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS',
  defaultTimeoutMs: 1_500,
} as const);
