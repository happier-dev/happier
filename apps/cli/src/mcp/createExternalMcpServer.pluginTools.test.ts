import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const boundary = vi.hoisted(() => ({
  requestDaemonPluginActionExecution: vi.fn(async () => ({
    matched: true as const,
    result: {
      ok: true as const,
      result: { completed: true },
    },
  })),
}));

vi.mock('@/daemon/controlClient', () => ({
  requestDaemonPluginActionExecution: boundary.requestDaemonPluginActionExecution,
  readDaemonPluginCatalog: vi.fn(async () => ({ kind: 'unavailable', code: 'test' })),
  resolveDaemonSpawnSessionByNonce: vi.fn(),
  spawnDaemonSession: vi.fn(),
  stopDaemonSession: vi.fn(),
  decideDaemonPluginChange: vi.fn(),
  requestDaemonPluginChange: vi.fn(),
}));

import { createExternalMcpServer } from './createExternalMcpServer';

describe('createExternalMcpServer plugin tools', () => {
  it('advertises and dispatches a daemon-projected plugin tool through the MCP SDK boundary', async () => {
    const { mcp, toolNames } = createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      pluginToolCatalog: [{
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/review-start',
        name: 'acme_review_start',
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
          },
          required: ['scope'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            completed: { type: 'boolean' },
          },
          required: ['completed'],
          additionalProperties: false,
        },
        safety: 'danger',
        inputHints: {
          fields: [{
            path: 'scope',
            title: { fallback: 'Scope' },
            widget: 'select',
            options: [{ value: 'diff', label: { fallback: 'Diff' } }],
          }],
        },
        examples: { mcp: { argsExample: '{"scope":"diff"}' } },
        promptSnippet: 'Start an Acme review.',
        promptGuidelines: ['Choose the narrowest applicable scope.'],
        availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
        surfaces: ['agent', 'mcp', 'cli'],
      }],
    } as any);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'plugin-tools-test', version: '1.0.0' }, { capabilities: {} });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(toolNames).toContain('acme_review_start');
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === 'acme_review_start')).toMatchObject({
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
          },
          required: ['scope'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            completed: { type: 'boolean' },
          },
          required: ['completed'],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
        _meta: {
          'happier.dev/pluginTool': {
            toolId: 'acme.review.plugin/review-tool',
            actionId: 'acme.review.plugin/review-start',
            safety: 'danger',
            inputHints: {
              fields: [{
                path: 'scope',
                title: { fallback: 'Scope' },
                widget: 'select',
                options: [{ value: 'diff', label: { fallback: 'Diff' } }],
              }],
            },
            examples: { mcp: { argsExample: '{"scope":"diff"}' } },
            promptSnippet: 'Start an Acme review.',
            promptGuidelines: ['Choose the narrowest applicable scope.'],
            availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
          },
        },
      });

      const result = await client.callTool({
        name: 'acme_review_start',
        arguments: { scope: 'diff' },
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: '{"completed":true}' }],
        structuredContent: { completed: true },
        isError: false,
      });
      expect(boundary.requestDaemonPluginActionExecution).toHaveBeenCalledWith({
        actionId: 'acme.review.plugin/review-start',
        input: { scope: 'diff' },
        surface: 'mcp',
        defaultSessionId: 'cli-global',
      });
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
