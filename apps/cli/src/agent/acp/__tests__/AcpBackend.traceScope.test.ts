import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { AcpBackend } from '../AcpBackend';
import { createAcpSubprocessEnvScope, createAcpTestTransportHandler, waitForFileToContain,
  writeAcpTestAgentScript } from '../testkit/subprocessHarness';

it('captures native ACP output in each hosted Session trace directory or cwd', async () => {
  await withTempDir('acp-session-captures-', async root => {
    const envScope = createAcpSubprocessEnvScope();
    envScope.patch({ HAPPIER_ACP_CAPTURE_IO: '1', HAPPIER_STACK_TOOL_TRACE_FILE: join(root, 'host.jsonl') });
    try {
      await Promise.all(['trace-file', 'cwd-fallback'].map(async sessionId => {
        const cwd = join(root, sessionId);
        await mkdir(cwd);
        const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'agent.mjs', source: String.raw`
          import { createInterface } from 'node:readline';
          for await (const line of createInterface({ input: process.stdin })) {
            const request = JSON.parse(line);
            if (request.id === undefined) continue;
            if (request.method === 'session/new') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'native-marker-${sessionId}', params: {} }) + '\n');
            const result = request.method === 'initialize' ? { protocolVersion: 1, authMethods: [] }
              : request.method === 'session/new' ? { sessionId: '${sessionId}' } : {};
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
          }
        ` });
        await runAddedHostedSession({ environment: { ...process.env,
          HAPPIER_STACK_TOOL_TRACE_FILE: sessionId === 'trace-file' ? 'trace.jsonl' : undefined,
          // Capture enablement is operator configuration, independent of the Session baseline.
          HAPPIER_ACP_CAPTURE_IO: '0',
        }, workingDirectory: cwd, end() {} }, async () => {
          const backend = new AcpBackend({ agentName: 'fixture', cwd, command: process.execPath, args: [script],
            transportHandler: createAcpTestTransportHandler({
              filterStdoutLine: line => line.includes('native-marker-') ? null : line,
            }) });
          try {
            await backend.startSession();
            await waitForFileToContain(join(cwd, 'acp.stdin.raw'), 'initialize', { timeoutMs: 2000 });
            await waitForFileToContain(join(cwd, 'acp.stdout.raw'), sessionId, { timeoutMs: 2000 });
            if (sessionId === 'trace-file') {
              await waitForFileToContain(join(cwd, 'acp.stdout.dropped.jsonl'), `native-marker-${sessionId}`, { timeoutMs: 2000 });
            } else { expect(existsSync(join(cwd, 'acp.stdout.dropped.jsonl'))).toBe(false); }
          } finally { await backend.dispose(); }
        });
      }));
      expect(existsSync(join(root, 'acp.stdout.raw'))).toBe(false);
    } finally { envScope.restore(); }
  });
});
