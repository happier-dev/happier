import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { McpServerSpecV1 } from '@happier-dev/plugin-sdk/experimental/mcp';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenCode plugin activation MCP discovery', () => {
  it('maps recovered remote OpenCode MCP config entries into endpoint MCP specs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'opencode-activate-mcp-'));
    const opencodeDir = join(projectRoot, '.opencode');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(opencodeDir, { recursive: true }));
    await writeFile(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            url: 'https://mcp.example.test/http',
          },
          stream: {
            endpoint: 'https://mcp.example.test/sse',
            transport: 'sse',
          },
          disabledDocs: {
            url: 'https://mcp.example.test/disabled',
            enabled: false,
          },
        },
      }),
      'utf8',
    );
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const registration = activation.registration('mcp.discoveryProviders', 'config');
    if (!registration) throw new Error('Missing OpenCode MCP discovery registration');
    const result = await Reflect.apply(registration, undefined, [{
      sessionId: 'session_1',
      directory: projectRoot,
    }]);

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual(expect.arrayContaining<McpServerSpecV1>([
      expect.objectContaining({
        id: 'opencode.config.docs',
        name: 'docs',
        transport: {
          kind: 'http',
          url: 'https://mcp.example.test/http',
        },
      }),
      expect.objectContaining({
        id: 'opencode.config.stream',
        name: 'stream',
        transport: {
          kind: 'sse',
          url: 'https://mcp.example.test/sse',
        },
      }),
    ]));
    expect(result.servers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'opencode.config.disabledDocs',
      }),
    ]));
    await activation.dispose();
  });

  it('normalizes discovered OpenCode MCP server names before using them in spec ids', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'opencode-activate-mcp-id-'));
    const opencodeDir = join(projectRoot, '.opencode');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(opencodeDir, { recursive: true }));
    await writeFile(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcpServers: {
          'Team Docs': {
            url: 'https://mcp.example.test/team-docs',
          },
        },
      }),
      'utf8',
    );
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const registration = activation.registration('mcp.discoveryProviders', 'config');
    if (!registration) throw new Error('Missing OpenCode MCP discovery registration');
    const result = await Reflect.apply(registration, undefined, [{
      sessionId: 'session_1',
      directory: projectRoot,
    }]);

    expect(result).toEqual({
      items: [],
      servers: [
        expect.objectContaining({
          id: 'opencode.config.team-docs',
          name: 'Team Docs',
        }),
      ],
      warnings: [],
    });
    await activation.dispose();
  });

  it('skips OpenCode MCP config entries whose normalized ids collide', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'opencode-activate-mcp-collision-'));
    const opencodeDir = join(projectRoot, '.opencode');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(opencodeDir, { recursive: true }));
    await writeFile(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcpServers: {
          'Team Docs': {
            url: 'https://mcp.example.test/team-docs',
          },
          'team--docs': {
            url: 'https://mcp.example.test/team-docs-shadow',
          },
        },
      }),
      'utf8',
    );
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const registration = activation.registration('mcp.discoveryProviders', 'config');
    if (!registration) throw new Error('Missing OpenCode MCP discovery registration');
    const result = await Reflect.apply(registration, undefined, [{
      sessionId: 'session_1',
      directory: projectRoot,
    }]);

    expect(result).toEqual({
      items: [],
      servers: [],
      warnings: [],
    });
    await activation.dispose();
  });
});
