import { describe, expect, it } from 'vitest';

import {
  normalizeDetectedMcpServerV1,
  type DetectedMcpServerV1,
} from './mcp.js';

describe('normalizeDetectedMcpServerV1', () => {
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
