import type { AgentLaunchEnvironment } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  parseClaudeRemoteAdvancedOptionsJson,
  type ClaudeRemoteAdvancedOptions,
} from '../../protocol/remoteSettings.js';

const CLAUDE_AGENT_TEAMS_SETTING_KEY = 'claudeCodeExperimentalAgentTeamsEnabled';
const CLAUDE_ADVANCED_OPTIONS_SETTING_KEY = 'claudeRemoteAdvancedOptionsJson';
const CLAUDE_AGENT_TEAMS_ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const CLAUDE_LOCAL_AUTH_USER_ENV_KEY = 'USER';
const CLAUDE_EXTERNAL_SANDBOX_ENV_KEY = 'IS_SANDBOX';

type ClaudeSettingsReader = Readonly<{
  get(key: string): unknown | Promise<unknown>;
}>;

export function resolveClaudeExternalSandboxEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return env[CLAUDE_EXTERNAL_SANDBOX_ENV_KEY] === '1'
    ? { [CLAUDE_EXTERNAL_SANDBOX_ENV_KEY]: '1' }
    : {};
}

async function readSetting(settings: ClaudeSettingsReader, key: string): Promise<unknown> {
  try {
    return await settings.get(key);
  } catch {
    return null;
  }
}

export function resolveClaudeNativeBaseLaunchEnvironment(input: Readonly<{
  launchEnvironment?: AgentLaunchEnvironment;
  processEnv: Readonly<Record<string, string | undefined>>;
}>): Readonly<Record<string, string>> {
  const values = { ...(input.launchEnvironment?.values ?? {}) };
  if (
    values[CLAUDE_LOCAL_AUTH_USER_ENV_KEY] === undefined
    && !input.launchEnvironment?.unset.includes(CLAUDE_LOCAL_AUTH_USER_ENV_KEY)
  ) {
    const user = input.processEnv[CLAUDE_LOCAL_AUTH_USER_ENV_KEY]?.trim();
    if (user) values[CLAUDE_LOCAL_AUTH_USER_ENV_KEY] = user;
  }
  if (
    values[CLAUDE_EXTERNAL_SANDBOX_ENV_KEY] === undefined
    && !input.launchEnvironment?.unset.includes(CLAUDE_EXTERNAL_SANDBOX_ENV_KEY)
  ) {
    Object.assign(values, resolveClaudeExternalSandboxEnv(input.processEnv));
  }
  return values;
}

export async function resolveClaudeNativeLaunchSettings(input: Readonly<{
  settings: ClaudeSettingsReader;
  launchEnv: Readonly<Record<string, string>>;
  includeAdvancedOptions: boolean;
}>): Promise<Readonly<{
  launchEnv: Readonly<Record<string, string>>;
  advancedOptions: ClaudeRemoteAdvancedOptions;
}>> {
  const [agentTeamsEnabled, advancedOptionsJson] = await Promise.all([
    readSetting(input.settings, CLAUDE_AGENT_TEAMS_SETTING_KEY),
    input.includeAdvancedOptions
      ? readSetting(input.settings, CLAUDE_ADVANCED_OPTIONS_SETTING_KEY)
      : Promise.resolve(null),
  ]);
  return {
    launchEnv: agentTeamsEnabled === true
      ? {
          ...input.launchEnv,
          [CLAUDE_AGENT_TEAMS_ENV_KEY]: '1',
        }
      : input.launchEnv,
    advancedOptions: input.includeAdvancedOptions
      ? parseClaudeRemoteAdvancedOptionsJson(advancedOptionsJson)
      : {},
  };
}
