import type { PluginSettingsContribution, SettingsService } from '@happier-dev/plugin-sdk/settings';

export const CURSOR_BINARY_PATH_SETTING_ID = 'cursorBinaryPath';
export const CURSOR_AGENT_FALLBACK_SETTING_ID = 'cursorAgentFallbackEnabled';
export const CURSOR_API_ENDPOINT_SETTING_ID = 'cursorApiEndpoint';

export function normalizeCursorBinaryPath(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeCursorAgentFallbackEnabled(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value !== 'string') return true;
  return !['0', 'false', 'no'].includes(value.trim().toLowerCase());
}

export function normalizeCursorApiEndpoint(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export type CursorRuntimeSettings = Readonly<{
  binaryPath: string;
  agentFallbackEnabled: boolean;
  apiEndpoint: string;
}>;

export async function readCursorRuntimeSettings(
  settings: SettingsService,
): Promise<CursorRuntimeSettings> {
  const daemonSettings = settings.forScope({ kind: 'daemon' });
  const [binaryPath, agentFallbackEnabled, apiEndpoint] = await Promise.all([
    daemonSettings.get(CURSOR_BINARY_PATH_SETTING_ID),
    daemonSettings.get(CURSOR_AGENT_FALLBACK_SETTING_ID),
    daemonSettings.get(CURSOR_API_ENDPOINT_SETTING_ID),
  ]);
  return Object.freeze({
    binaryPath: normalizeCursorBinaryPath(binaryPath),
    agentFallbackEnabled: normalizeCursorAgentFallbackEnabled(agentFallbackEnabled),
    apiEndpoint: normalizeCursorApiEndpoint(apiEndpoint),
  });
}

export const CURSOR_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: 'Cursor',
  target: { kind: 'agent', agent: 'cursor' },
  scope: 'daemon',
  fields: [{
    id: CURSOR_BINARY_PATH_SETTING_ID,
    title: 'Cursor binary path',
    description: 'Optional absolute path to cursor-agent or agent.',
    schema: { type: 'string' },
    default: '',
    presentation: { control: 'text', order: 1 },
    analytics: {
      valueKind: 'presence',
      privacy: 'presence_only',
      identityScope: 'device_user',
    },
  }, {
    id: CURSOR_AGENT_FALLBACK_SETTING_ID,
    title: 'Allow agent fallback',
    description: 'Use the agent command when cursor-agent is unavailable.',
    schema: { type: 'boolean' },
    default: true,
    presentation: { control: 'switch', order: 2 },
    analytics: {
      trackCurrentState: true,
      trackChanges: true,
      valueKind: 'boolean',
      privacy: 'safe',
      identityScope: 'device_user',
    },
  }, {
    id: CURSOR_API_ENDPOINT_SETTING_ID,
    title: 'Cursor API endpoint',
    description: 'Optional Cursor Agent API endpoint override.',
    schema: { type: 'string' },
    default: '',
    presentation: { control: 'text', order: 3 },
    analytics: {
      valueKind: 'presence',
      privacy: 'presence_only',
      identityScope: 'device_user',
    },
  }],
  presentation: {
    icon: {
      ionName: 'code-slash-outline',
      color: { kind: 'theme', token: 'green' },
    },
    sections: [{
      id: 'cursor-cli',
      title: 'Cursor CLI',
      description: 'Use a specific Cursor binary when auto-detection is not enough. Happier prefers cursor-agent and can fall back to agent when enabled.',
      fields: [
        CURSOR_BINARY_PATH_SETTING_ID,
        CURSOR_AGENT_FALLBACK_SETTING_ID,
        CURSOR_API_ENDPOINT_SETTING_ID,
      ],
    }],
    subagentSections: [],
  },
} satisfies PluginSettingsContribution;
