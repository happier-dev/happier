import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveCustomHappierToolsContext } from '@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';

it.each(['runner', 'custom'])('materializes each concurrent Session %s MCP profile from its own environment', async resolver => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-hosted-profile-'));
  const credentials = { token: 'hosted-mcp-account', encryption: null, credentialProvenance: 'stored_session' as const };
  const settings = accountSettingsParse({ mcpServersStrictMode: true });
  const snapshot = { source: 'network' as const, settings, settingsVersion: 1, loadedAtMs: 1,
    scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token), settingsSecretsReadKeys: [],
    mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, revision: 1, diagnostics: [],
      catalog: McpServerCatalogV1Schema.parse({ v: 1,
        servers: [{ id: 'scoped', name: 'scoped', transport: 'stdio', stdio: { command: process.execPath, args: [] },
          env: { SCOPE: { t: 'literal', v: '${HAPPIER_MCP_SCOPE_TEST}' } }, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'scoped-binding', serverId: 'scoped', enabled: true, target: { t: 'allMachines' },
          createdAt: 1, updatedAt: 1 }],
      }) },
  };
  try {
    await Promise.all(['first', 'second'].map(scope => runAddedHostedSession({
      environment: { ...process.env, HAPPIER_MCP_SCOPE_TEST: scope }, workingDirectory: directory, end: () => undefined,
    }, async () => {
      if (resolver === 'runner') {
        const result = await resolveRunnerMcpServers({ session: createMutableApiSessionClientFixture({ sessionId: scope }),
          credentials, accountSettings: settings, accountSettingsSnapshot: snapshot, machineId: 'machine', directory,
          includeHappierMcpServer: false, localWorkflow: true, tmpDir: directory });
        try {
          const configPath = result.mcpServers.scoped?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
          expect(configPath).toBeTypeOf('string');
          if (!configPath) throw new Error('Missing private MCP launcher configuration');
          expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({ env: { SCOPE: scope } });
        } finally { await result.happierMcpServer.stop(); }
        return;
      }
      const serverHttpBaseUrl = 'https://hosted-mcp.test';
      const operationSnapshot = { ...snapshot, scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl,
        () => resolveAccountSettingsScopeKeyForToken(credentials.token)) };
      const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl,
        () => createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl,
          snapshot: operationSnapshot, isCurrent: async () => true }));
      const custom = await resolveCustomHappierToolsContext({ credentials, accountSettingsSnapshot: operationSnapshot,
        operationContext, machineId: 'machine', directory, localWorkflow: true });
      try {
        const configPath = custom.mcpServers.scoped?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
        expect(configPath).toBeTypeOf('string');
        if (!configPath) throw new Error('Missing private custom MCP launcher configuration');
        expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({ env: { SCOPE: scope } });
      } finally { custom.cleanup(); }
    })));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
