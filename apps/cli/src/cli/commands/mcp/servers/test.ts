import chalk from 'chalk';
import { listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveEffectiveMcpServersForDirectory } from '@/mcp/servers/resolveEffectiveMcpServersForDirectory';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { redactMcpServerProbeError } from '@/mcp/servers/redactMcpServerProbeError';
import { loadFreshMcpAccountSettingsContext } from '../loadFreshMcpAccountSettingsContext';

import type { McpCommandDeps } from '../deps';
import { cmd, fail } from '@happier-dev/cli-common/output';

export async function cmdMcpServersTest(
  argv: string[],
  deps: Pick<McpCommandDeps, 'env' | 'readStoredCredentials' | 'bootstrapAccountSettingsContext'
    | 'ensureMachineIdForCredentials' | 'probeMcpStdioServerTools' | 'nowMs'>,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const commandEnv = deps.env ?? process.env;
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_test', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
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
    const operationContext = ctx.operationContext;
    if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
    const mcpSettings = readMcpServersSettingsFromAccountSettings(ctx);

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

    const references = [...new Set(listMcpServerCatalogSavedSecretRefsV1({ v: 1, servers: [item.config], bindings: [] })
      .map(ref => ref.secretId))].map(ref => ({ ref }));
    const capturedSnapshot = operationContext.readSnapshot();
    if (!capturedSnapshot) throw new McpServerCatalogUnavailableError('scope-retired');
    let materialSnapshot: ActiveAccountSettingsSnapshot = capturedSnapshot;
    if (references.length > 0) {
      const admitted = await refreshSavedSecretCatalogForOperation({ expectedScopeKey: ctx.scopeKey, references, operationContext });
      materialSnapshot = admitted;
    }
    const savedSecretMaterializer = createSavedSecretMaterializerFromSnapshotV1(materialSnapshot, {
      isCurrent: () => operationContext.readSnapshot() === materialSnapshot,
    });

    const materialized = await materializeMcpServerConfigRecord({
      resolved: { directory, strictMode: true, serversByName: { [server.name]: item } },
      savedSecretMaterializer,
      processEnv: commandEnv,
      tmpDir: null,
      strictMode: true,
    });

    const config = materialized.mcpServers[server.name];
    if (!config) {
      materialized.cleanup();
      throw new Error('materialize_missing_config');
    }
    if (!await operationContext.isCurrent()) {
      materialized.cleanup();
      throw new McpServerCatalogUnavailableError('scope-retired');
    }

    let tools: Awaited<ReturnType<typeof deps.probeMcpStdioServerTools>>;
    try {
      tools = await deps.probeMcpStdioServerTools({ config, baseEnv: commandEnv });
    } finally {
      materialized.cleanup();
    }
    if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
    const toolNames = tools.map((t) => t.name);
    const durationMs = Math.max(0, deps.nowMs() - startedAt);

    if (opts.json) {
      await printJsonEnvelope({
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
      await printJsonEnvelope({
        ok: false,
        kind: 'mcp_servers_test',
        error: {
          code: 'mcp_test_failed',
          message,
        },
      }, { exitCode: 1 });
      return;
    }
    console.error(fail(message));
    process.exitCode = 1;
  }
}
