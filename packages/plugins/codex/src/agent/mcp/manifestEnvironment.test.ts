import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_PLUGIN } from '../../manifest.js';

type PluginMcpDiscoveryHandler = Parameters<Parameters<typeof CODEX_PLUGIN.activate>[0]['mcp']['registerDiscoverySource']>[1];

// Registration and Exec are the host boundary; the native config reader remains real.
async function discoveryHandler(): Promise<PluginMcpDiscoveryHandler> {
  let handler: PluginMcpDiscoveryHandler | undefined;
  const ignore = () => undefined;
  const api = new Proxy({ mcp: { registerServer: ignore,
    registerDiscoverySource: (_id: string, discover: PluginMcpDiscoveryHandler) => { handler = discover; },
  } }, { get: (target, property) => Reflect.get(target, property) ?? new Proxy({}, { get: () => ignore }) });
  await CODEX_PLUGIN.activate(api as unknown as Parameters<typeof CODEX_PLUGIN.activate>[0]);
  if (!handler) throw new Error('MCP discovery handler was not registered');
  return handler;
}

describe('codex MCP discovery environment', () => {
  it('discovers two concurrent invocation homes without reading shared-host config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mcp-scope-'));
    try {
      const homes = await Promise.all(['host', 'first', 'second'].map(async id => {
        const home = join(root, id);
        await mkdir(home);
        await writeFile(join(home, 'config.toml'), '[mcp_servers.SESSION]\ncommand = "bridge"\n'.replace('SESSION', id));
        return home;
      }));
      vi.stubEnv('HOME', homes[0]);
      vi.stubEnv('USERPROFILE', homes[0]);
      vi.stubEnv('CODEX_HOME', homes[0]);
      const discover = await discoveryHandler();
      const results = await Promise.all(homes.slice(1).map(home => discover({ directory: null }, {
        services: { exec: { readEnvironment: (keys: readonly string[]) => Object.fromEntries(
          Object.entries({ HOME: home, USERPROFILE: home, CODEX_HOME: home }).filter(([key]) => keys.includes(key)),
        ) } },
      } as unknown as Parameters<PluginMcpDiscoveryHandler>[1])));
      expect(results.map(result => result.detectedServers?.map(server => server.name))).toEqual([['first'], ['second']]);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});
