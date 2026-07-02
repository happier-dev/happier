import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  McpServerSpecV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
} from '@happier-dev/plugin-sdk';

import { activate } from './activate.js';

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
    let registration: PluginApiMcpDiscoveryProviderRegistrationV1 | null = null;
    activate({
      registerBackendEngine: vi.fn(),
      registerMcpDiscoveryProvider: vi.fn((nextRegistration) => {
        registration = nextRegistration;
      }),
    });

    expect(registration).not.toBeNull();
    const result = await registration!.discover({
      sessionId: 'session_1',
      directory: projectRoot,
    });

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
    let registration: PluginApiMcpDiscoveryProviderRegistrationV1 | null = null;
    activate({
      registerBackendEngine: vi.fn(),
      registerMcpDiscoveryProvider: vi.fn((nextRegistration) => {
        registration = nextRegistration;
      }),
    });

    const result = await registration!.discover({
      sessionId: 'session_1',
      directory: projectRoot,
    });

    expect(result).toEqual({
      servers: [
        expect.objectContaining({
          id: 'opencode.config.team-docs',
          name: 'Team Docs',
        }),
      ],
      warnings: [],
    });
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
    let registration: PluginApiMcpDiscoveryProviderRegistrationV1 | null = null;
    activate({
      registerBackendEngine: vi.fn(),
      registerMcpDiscoveryProvider: vi.fn((nextRegistration) => {
        registration = nextRegistration;
      }),
    });

    const result = await registration!.discover({
      sessionId: 'session_1',
      directory: projectRoot,
    });

    expect(result).toEqual({
      servers: [],
      warnings: [],
    });
  });
});
