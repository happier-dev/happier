import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema, resolveEffectiveServersV1 } from '@happier-dev/protocol';

import { probeMcpStdioServerTools } from './probeMcpStdioServerTools';
import { materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';

const require = createRequire(import.meta.url);

function buildFixtureServerScript(): string {
  const mcpServerUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
  const stdioTransportUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
  const zodUrl = pathToFileURL(require.resolve('zod')).href;

  return `
import { McpServer } from ${JSON.stringify(mcpServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioTransportUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const server = new McpServer({ name: 'fixture-mcp', version: '1.0.0' });
server.registerTool('fixture_tool', { inputSchema: z.object({}).optional() }, async () => ({ content: [{ type: 'text', text: process.cwd() }] }));

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

function buildFakePnpmScript(): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';

const goodCwd = process.env.GOOD_CWD ?? '';
const fixtureServer = process.env.FIXTURE_MCP_SERVER ?? '';
const args = process.argv.slice(2);

if (!goodCwd || !fixtureServer || process.cwd() !== goodCwd || args[0] !== 'dlx') {
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [fixtureServer], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
`;
}

describe.runIf(process.platform !== 'win32')('materializeMcpServerConfigRecord package-runner integration', () => {
  it('keeps package-runner stdio MCP servers connectable from a bad session cwd by normalizing them through managed pnpm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-integration-'));
    const badCwd = join(root, 'bad-cwd');
    const goodHome = join(root, 'good-home');
    const fixtureServerPath = join(root, 'fixture-server.mjs');
    const fakePnpmPath = join(root, 'pnpm');
    const tsxCliPath = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    const sourceLauncherPath = fileURLToPath(new URL('../launchers/stdioMcpServerLauncher.ts', import.meta.url));
    const originalCwd = process.cwd();

    await mkdir(badCwd, { recursive: true });
    await mkdir(goodHome, { recursive: true });
    await writeFile(join(badCwd, 'package.json'), '{"name":"bad-cwd"}\n');
    await writeFile(fixtureServerPath, buildFixtureServerScript());
    await writeFile(fakePnpmPath, buildFakePnpmScript());
    await chmod(fakePnpmPath, 0o755);
    const goodHomeRealpath = realpathSync(goodHome);

    try {
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: true,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', 'fixture-package'] },
            env: {
              GOOD_CWD: { t: 'literal', v: goodHomeRealpath },
              FIXTURE_MCP_SERVER: { t: 'literal', v: fixtureServerPath },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: badCwd });
      const materialized = await materializeMcpServerConfigRecord({
        resolved,
        settingsSecretsKey: null,
        savedSecretsById: new Map(),
        processEnv: { HOME: goodHome, HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: root,
        deps: {
          resolveStdioLauncherCommand: () => ({
            command: process.execPath,
            args: [tsxCliPath, sourceLauncherPath],
          }),
        },
      });

      process.chdir(badCwd);
      const tools = await probeMcpStdioServerTools({
        config: materialized.mcpServers.alpha,
        baseEnv: {
          ...process.env,
          HOME: goodHome,
        },
        connectTimeoutMs: 15_000,
        listToolsTimeoutMs: 15_000,
      });

      expect(tools).toEqual([{ name: 'fixture_tool' }]);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});
