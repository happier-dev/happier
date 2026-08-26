import type { AgentConnectedAccountStateSharingDescriptorV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export const geminiConnectedServiceStateSharingDescriptor = Object.freeze({
  providerSupportStatus: 'unsupported',
  config: {
    supported: false,
    modes: ['isolated'],
    entries: [],
    unavailableReason: 'not_implemented',
  },
  state: {
    supported: false,
    modes: ['isolated'],
    entries: [],
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
