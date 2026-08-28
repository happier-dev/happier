import type { AgentLaunchEnvironment } from '@happier-dev/plugin-sdk/agents/runtime';
import { readFileSync } from 'node:fs';

import {
  parseClaudeRemoteAdvancedOptionsJson,
  type ClaudeRemoteAdvancedOptions,
} from '../../protocol/remoteSettings.js';

const CLAUDE_AGENT_TEAMS_SETTING_KEY = 'claudeCodeExperimentalAgentTeamsEnabled';
const CLAUDE_ADVANCED_OPTIONS_SETTING_KEY = 'claudeRemoteAdvancedOptionsJson';
const CLAUDE_AGENT_TEAMS_ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const CLAUDE_PROMPT_SUGGESTION_ENV_KEY = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION';
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

export function resolveClaudeLaunchSettingsOverlayArgs(input: Readonly<{
  args: readonly string[];
  interactionKind: 'interactive_terminal' | 'noninteractive_sdk';
  permissionMode: string | null;
  launchSettings: Readonly<Record<string, unknown>>;
}>): readonly string[] {
  if (input.interactionKind !== 'interactive_terminal') return input.args;

  // Claude treats bypass selection and acknowledgement as distinct inputs. Happier's YOLO mode
  // is the user's explicit choice, so acknowledge it only in the trusted command-line settings
  // overlay. Never persist this key into project or account settings, and never apply it to SDK
  // protocols where Claude's ordinary permission/question handling remains authoritative.
  const launchSettings = {
    ...input.launchSettings,
    ...(input.permissionMode === 'bypassPermissions'
      ? { skipDangerousModePermissionPrompt: true }
      : {}),
  };
  if (Object.keys(launchSettings).length === 0) return input.args;

  const argsWithoutSettings: string[] = [];
  let firstSettingsIndex: number | null = null;
  let existingSettingsValue: string | null = null;
  for (let index = 0; index < input.args.length; index += 1) {
    const arg = input.args[index];
    if (arg === '--settings') {
      firstSettingsIndex ??= argsWithoutSettings.length;
      const value = input.args[index + 1];
      if (existingSettingsValue === null && typeof value === 'string') {
        existingSettingsValue = value;
      }
      if (typeof value === 'string') index += 1;
      continue;
    }
    if (arg.startsWith('--settings=')) {
      firstSettingsIndex ??= argsWithoutSettings.length;
      existingSettingsValue ??= arg.slice('--settings='.length);
      continue;
    }
    argsWithoutSettings.push(arg);
  }

  let baseSettings: Record<string, unknown> = {};
  if (existingSettingsValue !== null) {
    try {
      const inline = JSON.parse(existingSettingsValue) as unknown;
      if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
        baseSettings = inline as Record<string, unknown>;
      } else {
        throw new Error('Claude inline settings are not an object');
      }
    } catch {
      try {
        const fromFile = JSON.parse(readFileSync(existingSettingsValue, 'utf8')) as unknown;
        if (fromFile && typeof fromFile === 'object' && !Array.isArray(fromFile)) {
          baseSettings = fromFile as Record<string, unknown>;
        }
      } catch {
        // A broken prior settings source cannot carry the required per-launch acknowledgement.
      }
    }
  }

  const mergedSettings = { ...baseSettings, ...launchSettings };
  argsWithoutSettings.splice(
    firstSettingsIndex ?? argsWithoutSettings.length,
    0,
    '--settings',
    JSON.stringify(mergedSettings),
  );
  return argsWithoutSettings;
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

export function resolveClaudeUnifiedTerminalLaunchEnvironment(
  launchEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return {
    ...launchEnv,
    // Claude suggestions look like composer input but are not user-authored drafts. Preserve the
    // unified draft guard's fail-closed protection by removing that ambiguity at process launch.
    [CLAUDE_PROMPT_SUGGESTION_ENV_KEY]: 'false',
  };
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
