import type { AgentConnectedAccountStateSharingDescriptorV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export const ohMyPiConnectedServiceStateSharingDescriptor = Object.freeze({
  nativeHome: {
    environmentKey: 'PI_CODING_AGENT_DIR',
    defaultRelativePath: '.omp/agent',
  },
  providerSupportStatus: 'supported',
  config: {
    supported: false,
    modes: ['isolated'],
    entries: [],
    unavailableReason: 'not_implemented',
  },
  state: {
    supported: true,
    modes: ['isolated', 'shared'],
    entries: [{ path: 'sessions', mode: 'linked' }],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'process_env',
    secretEntries: [
      'OPENAI_CODEX_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
    ],
  },
} satisfies AgentConnectedAccountStateSharingDescriptorV1);
