import type { AgentConnectedAccountStateSharingDescriptorV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export const geminiConnectedServiceStateSharingDescriptor = Object.freeze({
  nativeHome: { environmentKey: 'GEMINI_CLI_HOME', defaultRelativePath: '.' },
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
    entries: [
      { path: '.gemini/tmp', mode: 'linked' },
      { path: '.gemini/projects.json', mode: 'linked' },
    ],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
    unavailableReason: 'not_implemented',
  },
  authIsolation: {
    mode: 'process_env',
    secretEntries: [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
    ],
  },
} satisfies AgentConnectedAccountStateSharingDescriptorV1);
