import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpServersSettingsV1Schema, resolveSessionCapabilitiesV1, projectMcpServerMaterializationV1,
  type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { mapMcpRegistryServerV1 } from '@happier-dev/protocol/mcp/servers/registry/mapMcpRegistryServerV1';
import { McpRegistryServerV1Schema } from '@happier-dev/protocol/registries';
import { McpServerProbeError, probeMcpStdioServerTools } from './probeMcpStdioServerTools';
import { materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';

const acquisition = vi.hoisted(() => ({ requests: 0 }));
// Managed acquisition is an external network boundary and must not run for configured commands.
vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request: () => { acquisition.requests += 1; throw new Error('Unexpected managed tooling acquisition'); },
}));
afterEach(() => { acquisition.requests = 0; });
const require = createRequire(import.meta.url);

async function probeFixture(params: Parameters<typeof probeMcpStdioServerTools>[0]) {
  try { return await probeMcpStdioServerTools(params); }
  catch (error) {
    if (error instanceof McpServerProbeError && error.stderrTail) {
      throw new Error(`${error.message}\n${error.stderrTail}`, { cause: error });
    }
    throw error;
  }
}

function fixtureServerScript(): string {
  return `
import { McpServer } from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href)};
import { z } from ${JSON.stringify(pathToFileURL(require.resolve('zod/mini')).href)};
const server = new McpServer({ name: 'fixture-mcp', version: '1.0.0' });
server.registerTool('fixture_tool', { inputSchema: z.optional(z.object({})) }, async () => ({ content: [{ type: 'text', text: process.cwd() }] }));
await server.connect(new StdioServerTransport());
`;
}

async function fixtureRunner(root: string, name: string, args: readonly string[]): Promise<string> {
  const command = join(root, name);
  await writeFile(command, `#!${process.execPath}
const { spawn } = require('node:child_process');
if (process.cwd() !== process.env.GOOD_CWD) throw new Error('Configured runner cwd changed');
if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))}) throw new Error('Configured runner args changed');
if (process.env.AUTHORED_VALUE !== 'retained') throw new Error('Configured runner env changed');
const child = spawn(process.execPath, [process.env.FIXTURE_MCP_SERVER], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));
`);
  await chmod(command, 0o755);
  return command;
}

function materializeFixture(params: {
  directory: string;
  stdio: NonNullable<McpServerCatalogEntryV1['stdio']>;
  env?: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
  strictMode?: boolean;
}) {
  const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: params.strictMode ?? true,
    servers: [{ id: 'fixture', name: 'fixture', transport: 'stdio', stdio: params.stdio,
      env: Object.fromEntries(Object.entries(params.env ?? {}).map(([key, value]) => [key, { t: 'literal', v: value }])),
      createdAt: 0, updatedAt: 0 }],
    bindings: [{ id: 'on', serverId: 'fixture', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
  });
  return materializeMcpServerConfigRecord({
    resolved: projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
      context: { machineId: 'fixture', directory: params.directory, machinePlatform: null, projectKey: null, agentId: null },
      mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true,
    }), params.directory),
    processEnv: params.processEnv, tmpDir: params.directory,
    deps: { resolveStdioLauncherCommand: () => resolveNodeBackedMcpServerCommand({
      distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
      sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true,
    }) },
  });
}

describe.runIf(process.platform !== 'win32')('configured package-runner MCP composition', () => {
  it.each(['npx', 'uvx'])('connects and relaunches the requested %s with its exact args, env and session cwd', async name => {
    const root = await mkdtemp(join(tmpdir(), 'happier-configured-mcp-'));
    let materialized: Awaited<ReturnType<typeof materializeFixture>> | undefined;
    try {
      const mapped = mapMcpRegistryServerV1({ id: 'fixture', name: 'fixture', nowMs: 0,
        server: McpRegistryServerV1Schema.parse({ name: 'example/pypi', version: '1.0.0', status: 'active',
          description: 'Fixture Python MCP', packages: [{ ecosystem: 'pypi', identifier: 'fixture-mcp', version: '1.0.0',
            transport: 'stdio', environment: [], packageArguments: [], runtimeArguments: [] }], remotes: [] }) });
      if (!mapped.ok || !mapped.entry.stdio) throw new Error('Expected registry stdio fixture');
      const args = name === 'uvx' ? mapped.entry.stdio.args : ['-y', 'fixture-package', '--', '--yes', '--prefer-offline'];
      await fixtureRunner(root, name, args);
      const server = join(root, 'server.mjs');
      await writeFile(server, fixtureServerScript());
      const processEnv = { ...process.env, PATH: root, HOME: join(root, 'different-home'), HAPPIER_HOME_DIR: root };
      materialized = await materializeFixture({ directory: root, stdio: { command: name, args }, processEnv,
        env: { GOOD_CWD: realpathSync(root), AUTHORED_VALUE: 'retained', FIXTURE_MCP_SERVER: server } });
      expect(materialized.warnings).toEqual([]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await probeFixture({ config: materialized.mcpServers.fixture, baseEnv: processEnv });
        expect(result.tools).toMatchObject([{ name: 'fixture_tool' }]);
      }
      expect(acquisition.requests).toBe(0);
    } finally { materialized?.cleanup(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it('preserves the physical configured cwd when a symlink precedes parent traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-physical-cwd-'));
    const directory = join(root, 'workspace');
    const actual = join(root, 'actual');
    let materialized: Awaited<ReturnType<typeof materializeFixture>> | undefined;
    try {
      await mkdir(directory); await mkdir(join(actual, 'deep'), { recursive: true });
      await symlink(join(actual, 'deep'), join(directory, 'link'), 'dir');
      const args = ['exec', 'fixture'];
      const command = await fixtureRunner(root, 'pnpm', args);
      const server = join(root, 'server.mjs'); await writeFile(server, fixtureServerScript());
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: root, HAPPIER_PNPM_BIN: command,
        HAPPIER_JS_RUNTIME_PATH: process.execPath };
      materialized = await materializeFixture({ directory, stdio: { command, args, cwd: { t: 'path', path: './link/..' } },
        env: { GOOD_CWD: realpathSync(actual), AUTHORED_VALUE: 'retained', FIXTURE_MCP_SERVER: server }, processEnv });
      const result = await probeFixture({ config: materialized.mcpServers.fixture, baseEnv: processEnv });
      expect(result.tools).toMatchObject([{ name: 'fixture_tool' }]);
    } finally { materialized?.cleanup(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it('reports a missing requested runner without acquiring a replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-missing-command-'));
    try {
      const params = { directory: root, stdio: { command: 'npx', args: ['fixture'] },
        processEnv: { HAPPIER_HOME_DIR: root, PATH: '' } };
      const optional = await materializeFixture({ ...params, strictMode: false });
      expect(optional.mcpServers).toEqual({});
      expect(optional.warnings).toMatchObject([{ serverName: 'fixture', code: 'invalid_server' }]);
      expect(optional.warnings[0].detail).toMatch(/configured MCP command npx.*not found/i);
      optional.cleanup();
      await expect(materializeFixture(params)).rejects.toThrow(/configured MCP command npx.*not found/i);
      expect(acquisition.requests).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
