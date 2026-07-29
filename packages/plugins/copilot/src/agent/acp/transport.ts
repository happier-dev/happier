import {
  ACP_AGENT_CLI_TRANSPORT_TIMEOUTS,
  createAcpToolNameInferencePreset,
} from '@happier-dev/agents';

export const COPILOT_ACP_TIMEOUTS = ACP_AGENT_CLI_TRANSPORT_TIMEOUTS;

export const COPILOT_ACP_TOOL_NAME_INFERENCE = createAcpToolNameInferencePreset({
  shellBridgeHint: true,
});

export const COPILOT_ACP_STDERR_RULES = Object.freeze({
  statusErrors: [{
    includes: ['authentication'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['unauthorized'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['not logged in'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['401'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['model not found'],
    detail: 'Model not found. Check available models with `copilot models`.',
  }, {
    includes: ['unknown model'],
    detail: 'Model not found. Check available models with `copilot models`.',
  }, {
    includes: ['subscription'],
    detail: 'GitHub Copilot subscription required. Check your Copilot access at https://github.com/settings/copilot.',
  }, {
    includes: ['copilot is not enabled'],
    detail: 'GitHub Copilot subscription required. Check your Copilot access at https://github.com/settings/copilot.',
  }],
} as const);
