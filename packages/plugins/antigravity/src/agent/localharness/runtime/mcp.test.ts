import { describe, expect, it } from 'vitest';

import {
  formatUnsupportedMcpServersDiagnostic,
  mapMcpServersToLocalharnessConfig,
} from './mcp.js';

describe('Antigravity localharness MCP mapping', () => {
  it('maps supported remote MCP transports and rejects unsafe URLs', () => {
    const result = mapMcpServersToLocalharnessConfig([
      {
        id: 'http-id',
        name: 'http-server',
        transport: { kind: 'http', url: 'https://example.test/mcp' },
        scope: { sessionId: 'session-1' },
      },
      {
        id: 'sse-id',
        name: 'sse-server',
        transport: { kind: 'sse', url: 'http://127.0.0.1:3000/sse' },
        scope: { sessionId: 'session-1' },
      },
      {
        id: 'managed-id',
        name: 'managed-server',
        transport: { kind: 'managed', url: 'https://managed.example.test/mcp' },
        scope: { sessionId: 'session-1' },
      },
      {
        id: 'unsafe-id',
        name: 'unsafe-server',
        transport: { kind: 'http', url: 'file:///tmp/socket' },
        scope: { sessionId: 'session-1' },
      },
      {
        id: 'credentials-id',
        name: 'credentials-server',
        transport: { kind: 'http', url: 'https://user:secret@example.test/mcp' },
        scope: { sessionId: 'session-1' },
      },
      {
        id: 'whitespace-id',
        name: 'whitespace-server',
        transport: { kind: 'sse', url: 'https://example.test/mcp token' },
        scope: { sessionId: 'session-1' },
      },
    ]);

    expect(result.configs).toEqual([
      { name: 'http-server', http: { url: 'https://example.test/mcp' } },
      { name: 'sse-server', http: { url: 'http://127.0.0.1:3000/sse' } },
      { name: 'managed-server', http: { url: 'https://managed.example.test/mcp' } },
    ]);
    expect(result.unsupported).toEqual([
      {
        id: 'unsafe-id',
        name: 'unsafe-server',
        transportKind: 'http',
        reason: 'invalid_url',
      },
      {
        id: 'credentials-id',
        name: 'credentials-server',
        transportKind: 'http',
        reason: 'invalid_url',
      },
      {
        id: 'whitespace-id',
        name: 'whitespace-server',
        transportKind: 'sse',
        reason: 'invalid_url',
      },
    ]);
  });

  it('reports unsupported unresolved transports without leaking transport payloads', () => {
    const result = mapMcpServersToLocalharnessConfig([
      {
        id: 'stdio-id',
        name: 'stdio-server',
        transport: { kind: 'stdio' },
        scope: { sessionId: 'session-1' },
      },
      {
        id: 'managed-no-url',
        name: 'managed-no-url',
        transport: { kind: 'managed' },
        scope: { sessionId: 'session-1' },
      },
      {
        id: 'hosted-id',
        name: 'hosted-server',
        transport: { kind: 'hosted' },
        scope: { sessionId: 'session-1' },
      },
    ]);

    expect(result.configs).toEqual([]);
    expect(result.unsupported).toEqual([
      {
        id: 'stdio-id',
        name: 'stdio-server',
        transportKind: 'stdio',
        reason: 'unsupported_stdio',
      },
      {
        id: 'managed-no-url',
        name: 'managed-no-url',
        transportKind: 'managed',
        reason: 'missing_url',
      },
      {
        id: 'hosted-id',
        name: 'hosted-server',
        transportKind: 'hosted',
        reason: 'unsupported_transport',
      },
    ]);

    expect(formatUnsupportedMcpServersDiagnostic(result.unsupported)).toBe(
      'Antigravity localharness cannot attach these MCP servers: stdio-server (stdio: unsupported_stdio), managed-no-url (managed: missing_url), hosted-server (hosted: unsupported_transport).',
    );
  });
});
