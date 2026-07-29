import {
  ACP_AGENT_CLI_TRANSPORT_TIMEOUTS,
  createAcpToolNameInferencePreset,
} from '@happier-dev/agents';

export const KILO_ACP_TIMEOUTS = ACP_AGENT_CLI_TRANSPORT_TIMEOUTS;

export const KILO_ACP_TOOL_NAME_INFERENCE = createAcpToolNameInferencePreset();

export const KILO_ACP_STDERR_RULES = Object.freeze({
  suppress: [{
    includes: ['models.dev', 'unable to connect'],
  }],
  statusErrors: [{
    includes: ['authentication'],
    detail: 'Authentication error. Configure Kilo credentials (for example: `kilo auth login`).',
  }, {
    includes: ['unauthorized'],
    detail: 'Authentication error. Configure Kilo credentials (for example: `kilo auth login`).',
  }, {
    includes: ['api key'],
    detail: 'Authentication error. Configure Kilo credentials (for example: `kilo auth login`).',
  }, {
    includes: ['401'],
    detail: 'Authentication error. Configure Kilo credentials (for example: `kilo auth login`).',
  }, {
    includes: ['model not found'],
    detail: 'Model not found. Check available models in your CLI (for example: `kilo models`).',
  }, {
    includes: ['unknown model'],
    detail: 'Model not found. Check available models in your CLI (for example: `kilo models`).',
  }, {
    includes: ['failed to install', 'plugin'],
    detail: 'Kilo failed to install required plugins. Re-run `kilo` from your terminal to complete setup, then retry.',
  }],
} as const);
