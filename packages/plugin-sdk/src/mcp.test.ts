import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  normalizeDetectedMcpServerV1,
  type DetectedMcpServerV1,
  type McpServerTransportV1,
} from './mcp.js';
import type { PluginExecSpawnRequest } from './services/io.js';
import type {
  PluginMcpClient,
  PluginMcpToolPage,
} from './services/resources.js';
import type { PluginMcpListToolsResult } from './activation.js';
import type { PluginMcpServerRuntime } from './activation.js';

type StdioMcpTransport = Extract<McpServerTransportV1, { kind: 'stdio' }>;
type ManagedMcpTransport = Extract<McpServerTransportV1, { kind: 'managed' }>;

describe('normalizeDetectedMcpServerV1', () => {
  it('uses one canonical tool-page result across MCP clients and server runtimes', () => {
    expectTypeOf<Awaited<ReturnType<PluginMcpClient['listTools']>>>()
      .toEqualTypeOf<PluginMcpToolPage>();
    expectTypeOf<PluginMcpListToolsResult>().toEqualTypeOf<PluginMcpToolPage>();
    expectTypeOf<Awaited<ReturnType<PluginMcpServerRuntime['listTools']>>>()
      .toEqualTypeOf<PluginMcpToolPage>();
  });

  it('composes stdio with the canonical exec request and exposes no managed transport arm', () => {
    expectTypeOf<StdioMcpTransport['launch']>().toEqualTypeOf<PluginExecSpawnRequest>();
    expectTypeOf<ManagedMcpTransport>().toEqualTypeOf<never>();
  });
  it('returns canonical detected MCP servers from valid provider discovery payloads', () => {
    const normalized = normalizeDetectedMcpServerV1({
      provider: 'opencode',
      name: 'docs',
      transport: 'http',
      remote: {
        url: 'https://mcp.example.test/http',
        headers: ['AUTHORIZATION'],
      },
      envKeys: ['OPENCODE_DOCS_TOKEN'],
      enabled: null,
      source: {
        kind: 'project',
        path: '/repo/.opencode/opencode.json',
      },
    });

    const canonical: DetectedMcpServerV1 | null = normalized;
    expect(canonical).toEqual({
      provider: 'opencode',
      name: 'docs',
      transport: 'http',
      remote: {
        url: 'https://mcp.example.test/http',
        headers: ['AUTHORIZATION'],
      },
      envKeys: ['OPENCODE_DOCS_TOKEN'],
      enabled: null,
      source: {
        kind: 'project',
        path: '/repo/.opencode/opencode.json',
      },
    });
  });

  it('rejects payloads that mix stdio and remote transport shapes', () => {
    expect(normalizeDetectedMcpServerV1({
      provider: 'opencode',
      name: 'broken',
      transport: 'stdio',
      stdio: { command: 'opencode-mcp', args: [] },
      remote: { url: 'https://mcp.example.test/http', headers: [] },
      envKeys: [],
      enabled: true,
      source: { kind: 'user', path: '/home/alice/.config/opencode/opencode.json' },
    })).toBeNull();
  });
});
