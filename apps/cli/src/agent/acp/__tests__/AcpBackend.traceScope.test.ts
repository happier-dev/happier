import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { AcpBackend } from '../AcpBackend';
import { createAcpSubprocessEnvScope, createAcpTestTransportHandler, waitForFileToContain,
  writeAcpTestAgentScript } from '../testkit/subprocessHarness';

it.each(['0', '1'])('captures only enabled hosted Sessions in their trace directory or cwd with host capture %s', async hostFlag => {
  await withTempDir('acp-session-captures-', async root => {
    const envScope = createAcpSubprocessEnvScope();
    vi.stubEnv('HAPPIER_ACP_CAPTURE_DROPPED_MAX_BYTES', '1');
    envScope.patch({ HAPPIER_ACP_CAPTURE_IO: hostFlag, HAPPIER_STACK_TOOL_TRACE_FILE: join(root, 'host.jsonl') });
    try {
      await Promise.all(['trace-file', 'cwd-fallback', 'capture-disabled'].map(async sessionId => {
        const cwd = join(root, sessionId);
        await mkdir(cwd);
        const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'agent.mjs', source: String.raw`
          import { createInterface } from 'node:readline';
          for await (const line of createInterface({ input: process.stdin })) {
            const request = JSON.parse(line);
            if (request.id === undefined) continue;
            if (request.method === 'session/new') {
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'native-marker-${sessionId}', params: {} }) + '\n');
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'later-marker-${sessionId}', params: {} }) + '\n');
            }
            const result = request.method === 'initialize' ? { protocolVersion: 1, authMethods: [] }
              : request.method === 'session/new' ? { sessionId: '${sessionId}' } : {};
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
          }
        ` });
        await runAddedHostedSession({ environment: { ...process.env,
          HAPPIER_STACK_TOOL_TRACE_FILE: sessionId === 'trace-file' ? 'trace.jsonl' : undefined,
          HAPPIER_ACP_CAPTURE_IO: sessionId === 'capture-disabled' ? '0' : '1', HAPPIER_ACP_CAPTURE_DROPPED_MAX_BYTES: '10000',
        }, workingDirectory: cwd, end() {} }, async () => {
          const backend = new AcpBackend({ agentName: 'fixture', cwd, command: process.execPath, args: [script],
            transportHandler: createAcpTestTransportHandler({
              filterStdoutLine: line => line.includes('native-marker-') || line.includes('later-marker-') ? null : line,
            }) });
          try {
            await backend.startSession();
            if (sessionId === 'capture-disabled') {
              expect(existsSync(join(cwd, 'acp.stdin.raw'))).toBe(false);
              expect(existsSync(join(cwd, 'acp.stdout.raw'))).toBe(false);
              return;
            }
            await waitForFileToContain(join(cwd, 'acp.stdin.raw'), 'initialize', { timeoutMs: 2000 });
            await waitForFileToContain(join(cwd, 'acp.stdout.raw'), sessionId, { timeoutMs: 2000 });
            if (sessionId === 'trace-file') {
              await waitForFileToContain(join(cwd, 'acp.stdout.dropped.jsonl'), `later-marker-${sessionId}`, { timeoutMs: 2000 });
            } else { expect(existsSync(join(cwd, 'acp.stdout.dropped.jsonl'))).toBe(false); }
          } finally { await backend.dispose(); }
        });
      }));
      expect(existsSync(join(root, 'acp.stdout.raw'))).toBe(false);
    } finally { envScope.restore(); vi.unstubAllEnvs(); }
  });
});

it('uses the hosted Session multiline frame limit instead of the physical host limit', async () => {
  await withTempDir('acp-session-multiline-', async cwd => {
    vi.stubEnv('HAPPIER_ACP_MULTILINE_JSON_MAX_BYTES', '1');
    try {
      const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'multiline.mjs', source: String.raw`
        import { createInterface } from 'node:readline';
        for await (const line of createInterface({ input: process.stdin })) {
          const request = JSON.parse(line);
          if (request.id === undefined) continue;
          const result = request.method === 'initialize' ? { protocolVersion: 1, authMethods: [] }
            : { sessionId: 'multiline-session' };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }, null, 2) + '\n');
        }
      ` });
      await runAddedHostedSession({ environment: { ...process.env, HAPPIER_ACP_MULTILINE_JSON_MAX_BYTES: '10000' },
        workingDirectory: cwd, end() {},
      }, async () => {
        const backend = new AcpBackend({ agentName: 'fixture', cwd, command: process.execPath, args: [script],
          transportHandler: createAcpTestTransportHandler({ initTimeoutMs: 1000 }),
        });
        try { await expect(backend.startSession()).resolves.toMatchObject({ sessionId: 'multiline-session' }); }
        finally { await backend.dispose(); }
      });
    } finally { vi.unstubAllEnvs(); }
  });
});
