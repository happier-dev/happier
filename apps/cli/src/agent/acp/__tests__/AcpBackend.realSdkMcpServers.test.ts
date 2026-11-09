import { describe, expect, it } from 'vitest';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { readFileSync } from 'node:fs';

import { join, resolve } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

const ACP_STUB_PROVIDER_PATH = resolve(
  __dirname,
  '../../../../../../packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs',
);

describe('AcpBackend with real ACP SDK stub provider', () => {
  it.each(['new', 'load'] as const)('does not drop broken when session/%s rejects the complete foreign-broken identifier', async operation => {
    await withTempDir('happier-acp-complete-name-', async cwd => {
      const capture = join(cwd, 'starts.json');
      const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'rejection-agent.mjs', source: `
        import { createInterface } from 'node:readline';
        import { writeFileSync } from 'node:fs';
        const starts = [];
        for await (const line of createInterface({ input: process.stdin })) {
          const r = JSON.parse(line); if(r.id === undefined) continue;
          if(r.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id,
            result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\\n');
          else if(r.method === 'session/new' || r.method === 'session/load') {
            starts.push(r.params.mcpServers); writeFileSync(process.env.CAPTURE, JSON.stringify(starts));
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id,
              error: { code: -32602, message: "Required MCP server 'foreign-broken' failed to start: FileNotFound" } }) + '\\n');
          } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n');
        }
      ` });
      const backend = new AcpBackend({ agentName: 'test', cwd, command: process.execPath, args: [script],
        env: { CAPTURE: capture }, mcpServers: { broken: { command: 'broken-mcp' } } });
      try {
        await expect(operation === 'new' ? backend.startSession() : backend.loadSession('parent'))
          .rejects.toMatchObject({ code: -32602, message: expect.stringContaining("'foreign-broken'") });
        expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
          [{ name: 'broken', command: 'broken-mcp', args: [], env: [] }],
        ]);
      } finally { await backend.dispose(); }
    });
  });

  it.each(['new', 'load', 'fork'] as const)('sends ACP v1 stdio records without a transport discriminator on session/%s', async operation => {
    await withTempDir('happier-acp-stdio-wire-', async cwd => {
      const capture = join(cwd, 'mcp-wire.json');
      const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'wire-agent.mjs', source: `
        import { createInterface } from 'node:readline';
        import { writeFileSync } from 'node:fs';
        for await (const line of createInterface({ input: process.stdin })) {
          const request = JSON.parse(line);
          if (request.id === undefined) continue;
          let result = {};
          if (request.method === 'initialize') result = { protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } };
          if (['session/new', 'session/load', 'session/fork'].includes(request.method)) {
            writeFileSync(process.env.CAPTURE, JSON.stringify(request));
            result = { sessionId: 'wire-session' };
          }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        }
      ` });
      const expected = { name: 'happier', command: process.execPath,
        args: ['--mcp-bridge'], env: [{ name: 'MCP_WIRE_TEST', value: '1' }] } satisfies McpServerStdio;
      const backend = new AcpBackend({ agentName: 'test', cwd, command: process.execPath, args: [script],
        env: { CAPTURE: capture }, mcpServers: {
          happier: { command: expected.command, args: expected.args, env: { MCP_WIRE_TEST: '1' } },
          minimal: { command: 'minimal-mcp' },
        } });
      try {
        const result = operation === 'new' ? await backend.startSession()
          : operation === 'load' ? await backend.loadSession('wire-parent')
          : await backend.forkSession({ sessionId: 'wire-parent' });
        expect(result.sessionId).toBe(operation === 'load' ? 'wire-parent' : 'wire-session');
        // Inspect the raw subprocess request before any consumer schema can strip unknown keys.
        // SDK 1.2.1 McpServerStdio has no `type`; FX 0.0.14 rejects that extra field.
        const wire: unknown = JSON.parse(readFileSync(capture, 'utf8'));
        expect(wire).toMatchObject({ method: `session/${operation}` });
        expect(wire).toHaveProperty('params.mcpServers', [expected,
          { name: 'minimal', command: 'minimal-mcp', args: [], env: [] } satisfies McpServerStdio]);
      } finally { await backend.dispose(); }
    });
  });

  it('starts a session when MCP servers are included in the ACP session/new request', async () => {
    await withTempDir('happier-acp-real-sdk-mcp-', async (cwd) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd,
        command: process.execPath,
        args: [ACP_STUB_PROVIDER_PATH],
        mcpServers: {
          happier: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: { HAPPIER_MCP_TEST: '1' },
          },
        },
        transportHandler: createAcpTestTransportHandler({ initTimeoutMs: 1_000 }),
      });

      try {
        await expect(backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 15_000);
});
