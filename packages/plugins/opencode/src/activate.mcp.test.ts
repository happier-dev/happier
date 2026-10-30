import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenCode plugin activation MCP discovery', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('exposes native OpenCode MCP detections including disabled servers', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'opencode-activate-mcp-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(projectRoot, 'empty-user-config'));
    vi.stubEnv('OPENCODE_CONFIG', '');
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');
    const opencodeDir = join(projectRoot, '.opencode');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(opencodeDir, { recursive: true }));
    await writeFile(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          docs: {
            type: 'remote',
            url: 'https://mcp.example.test/http',
          },
          stream: {
            type: 'remote',
            url: 'https://mcp.example.test/sse',
          },
          disabledDocs: {
            type: 'remote',
            url: 'https://mcp.example.test/disabled',
            enabled: false,
          },
        },
      }),
      'utf8',
    );
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const registration = activation.registration('mcp.discoverySources', 'config');
    if (!registration) throw new Error('Missing OpenCode MCP discovery registration');
    const result = await Reflect.apply(registration, undefined, [{
      sessionId: 'session_1',
      directory: projectRoot,
    }]);

    expect(result).toEqual({
      items: [],
      detectedServers: [
        ['docs', 'https://mcp.example.test/http', null],
        ['stream', 'https://mcp.example.test/sse', null],
        ['disabledDocs', 'https://mcp.example.test/disabled', false],
      ].map(([name, url, enabled]) => ({
        provider: 'opencode',
        name,
        transport: 'http',
        remote: { url, headers: [] },
        envKeys: [],
        enabled,
        source: { kind: 'project', path: join(opencodeDir, 'opencode.json') },
      })),
      warnings: [],
    });
    await activation.dispose();
  });

  it('keeps distinct native names that would collide under endpoint id normalization', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'opencode-activate-mcp-collision-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(projectRoot, 'empty-user-config'));
    vi.stubEnv('OPENCODE_CONFIG', '');
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');
    const opencodeDir = join(projectRoot, '.opencode');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(opencodeDir, { recursive: true }));
    await writeFile(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          'Team Docs': {
            type: 'remote',
            url: 'https://mcp.example.test/team-docs',
          },
          'team--docs': {
            type: 'remote',
            url: 'https://mcp.example.test/team-docs-shadow',
          },
        },
      }),
      'utf8',
    );
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const registration = activation.registration('mcp.discoverySources', 'config');
    if (!registration) throw new Error('Missing OpenCode MCP discovery registration');
    const result = await Reflect.apply(registration, undefined, [{
      sessionId: 'session_1',
      directory: projectRoot,
    }]);

    expect(result).toEqual({
      items: [],
      detectedServers: [
        ['Team Docs', 'https://mcp.example.test/team-docs'],
        ['team--docs', 'https://mcp.example.test/team-docs-shadow'],
      ].map(([name, url]) => ({
        provider: 'opencode',
        name,
        transport: 'http',
        remote: { url, headers: [] },
        envKeys: [],
        enabled: null,
        source: { kind: 'project', path: join(opencodeDir, 'opencode.json') },
      })),
      warnings: [],
    });
    await activation.dispose();
  });
});
