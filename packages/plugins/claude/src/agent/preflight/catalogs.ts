import { readClaudeSettingSourcesV2 } from '@happier-dev/plugin-sdk/first-party/claude';
import { CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS } from '../../protocol/remoteSettings.js';
import { buildClaudeSettingSourcesArgs } from '../runtime/launchSettings.js';
import { CLAUDE_RUNTIME_REFRESH_SECRET_ENV_KEYS } from '../auth/services/runtime/env.js';
import type { AgentPreflightSessionControlsCommandV1, AgentPreflightSessionControlsCommandResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';

const INITIALIZE_REQUEST_ID = 'happier-preflight-catalogs';
const CATALOG_ARGS = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Claude Code 2.1.291 / Agent SDK 0.2.123 initialization; EOF ends this inspection without a prompt. */
export const CLAUDE_NATIVE_CATALOG_COMMAND = {
  toolId: 'claude-cli',
  args: CATALOG_ARGS,
  stdin: `${JSON.stringify({
    type: 'control_request',
    request_id: INITIALIZE_REQUEST_ID,
    request: { subtype: 'initialize' },
  })}\n`,
  environmentExcludeKeys: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', ...CLAUDE_RUNTIME_REFRESH_SECRET_ENV_KEYS],
  prepareCommand(input) {
    return { args: [...CATALOG_ARGS, ...buildClaudeSettingSourcesArgs(
      readClaudeSettingSourcesV2(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS, input.pluginSettings?.account ?? {}),
    )] };
  },
} satisfies AgentPreflightSessionControlsCommandV1;

export function parseClaudeNativeCatalogsOutput(
  result: AgentPreflightSessionControlsCommandResultV1,
): Readonly<{ commands: unknown[]; skills: null }> {
  if (!result.ok || result.exitCode !== 0) throw new Error('Claude native catalog command failed');
  let commands: unknown[] | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error('Claude native catalog output is incomplete or malformed');
    }
    if (!isRecord(frame) || frame.type !== 'control_response' || !isRecord(frame.response)) continue;
    const response = frame.response;
    if (response.request_id !== INITIALIZE_REQUEST_ID) continue;
    if (response.subtype !== 'success' || !isRecord(response.response) || !Array.isArray(response.response.commands)) {
      throw new Error('Claude native catalog initialization failed');
    }
    commands = response.response.commands;
  }
  if (commands === null) throw new Error('Claude native catalog initialization response is missing');
  // Slash commands are advertised natively. Initialization has no typed skill-mention catalog.
  return { commands, skills: null };
}

export const CLAUDE_PREFLIGHT_CATALOGS = {
  command: CLAUDE_NATIVE_CATALOG_COMMAND,
  parseOutput: parseClaudeNativeCatalogsOutput,
} as const;
