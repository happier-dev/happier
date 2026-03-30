import chalk from 'chalk';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveEffectiveMcpServersForDirectory } from '@/mcp/servers/resolveEffectiveMcpServersForDirectory';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
  indexSavedSecretsByIdFromAccountSettings,
} from '@/mcp/servers/resolveMcpValueRefPlaintext';
import { redactMcpServerProbeError } from '@/mcp/servers/redactMcpServerProbeError';
import { loadFreshMcpAccountSettingsContext } from '../loadFreshMcpAccountSettingsContext';

import type { McpCommandDeps } from '../deps';

export async function cmdMcpServersTest(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readCredentials();
  if (!credentials) {
    if (opts.json) {
      printJsonEnvelope({ ok: false, kind: 'mcp_servers_test', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exitCode = 1;
    return;
  }

  const serverRef = readFlagValue(argv, '--mcp-server') ?? readFlagValue(argv, '--server');
  const directory = readFlagValue(argv, '--dir') ?? process.cwd();
  if (!serverRef) throw new Error('Usage: happier mcp servers test --mcp-server <name|id> [--dir <path>] [--json]');

  const startedAt = deps.nowMs();

  try {
    const { machineId } = await deps.ensureMachineIdForCredentials(credentials);
    const ctx = await loadFreshMcpAccountSettingsContext(credentials, deps);
    const mcpSettings = readMcpServersSettingsFromAccountSettings(ctx.settings);

    const server = mcpSettings.servers.find((s) => s.id === serverRef || s.name === serverRef) ?? null;
    if (!server) throw new Error(`MCP server not found: ${serverRef}`);

    const resolved = resolveEffectiveMcpServersForDirectory({
      settings: mcpSettings,
      machineId,
      directory,
    });
    const item = resolved.serversByName[server.name];
    if (!item) throw new Error(`MCP server not enabled for this target: ${server.name}`);
    if (item.enabled !== true) throw new Error(`MCP server disabled for this target: ${server.name}`);

    const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(ctx.settings);
    const settingsSecretsKey = deriveSettingsSecretsKeyForCredentials(credentials);
    const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(credentials);

    const materialized = await materializeMcpServerConfigRecord({
      resolved: { directory, strictMode: true, serversByName: { [server.name]: item } },
      savedSecretsById,
      settingsSecretsKey,
      settingsSecretsReadKeys,
      processEnv: process.env,
      tmpDir: null,
      strictMode: true,
    });

    const config = materialized.mcpServers[server.name];
    if (!config) throw new Error('materialize_missing_config');

    const tools = await deps.probeMcpStdioServerTools({ config, baseEnv: process.env });
    const toolNames = tools.map((t) => t.name);
    const durationMs = Math.max(0, deps.nowMs() - startedAt);

    if (opts.json) {
      printJsonEnvelope({
        ok: true,
        kind: 'mcp_servers_test',
        data: {
          toolCount: toolNames.length,
          toolNamesSample: toolNames.slice(0, 20),
          durationMs,
        },
      });
      return;
    }

    console.log(chalk.green('✓'), `${toolNames.length} tools`);
    for (const name of toolNames.slice(0, 20)) console.log(`- ${name}`);
  } catch (error) {
    const message = redactMcpServerProbeError(error);
    if (opts.json) {
      printJsonEnvelope({
        ok: false,
        kind: 'mcp_servers_test',
        error: {
          code: 'mcp_test_failed',
          message,
        },
      }, { exitCode: 1 });
      return;
    }
    console.error(chalk.red('Error:'), message);
    process.exitCode = 1;
  }
}
