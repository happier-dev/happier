import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectOpenCodeMcpServers } from './discovery.js';

describe('detectOpenCodeMcpServers', () => {
  it('reads OpenCode MCP stdio servers from the final plugin agent path', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'opencode-mcp-config-'));
    const opencodeDir = join(configRoot, 'opencode');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(opencodeDir, { recursive: true }));
    await writeFile(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcpServers: {
          review: {
            command: 'review-mcp',
            args: ['--stdio'],
            env: {
              REVIEW_TOKEN: 'hidden',
            },
          },
        },
      }),
      'utf8',
    );

    const result = await detectOpenCodeMcpServers({
      env: {
        XDG_CONFIG_HOME: configRoot,
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        name: 'review',
        transport: 'stdio',
        stdio: {
          command: 'review-mcp',
          args: ['--stdio'],
        },
        envKeys: ['REVIEW_TOKEN'],
      }),
    ]);
  });

  it('reads OpenCode MCP remote HTTP and SSE servers from recovered config shapes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'opencode-mcp-project-'));
    const opencodeDir = join(projectRoot, '.opencode');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(opencodeDir, { recursive: true }));
    await writeFile(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcp_servers: {
          docs: {
            url: 'https://mcp.example.test/http',
            headers: {
              AUTHORIZATION: 'redacted',
            },
            enabled: false,
          },
          stream: {
            endpoint: 'https://mcp.example.test/sse',
            type: 'sse',
          },
        },
      }),
      'utf8',
    );

    const result = await detectOpenCodeMcpServers({
      directory: projectRoot,
      env: {
        XDG_CONFIG_HOME: join(projectRoot, 'empty-config-root'),
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        name: 'docs',
        transport: 'http',
        remote: {
          url: 'https://mcp.example.test/http',
          headers: ['AUTHORIZATION'],
        },
        enabled: false,
      }),
      expect.objectContaining({
        provider: 'opencode',
        name: 'stream',
        transport: 'sse',
        remote: {
          url: 'https://mcp.example.test/sse',
          headers: [],
        },
        enabled: null,
      }),
    ]);
  });
});
