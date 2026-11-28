import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { withTempDir } from '@/testkit/fs/tempDir';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';

function writeAgentKilledDuringPrompt(dir: string): string {
  return writeAcpTestAgentScript({
    dir,
    fileName: 'fake-acp-agent-killed-during-prompt.mjs',
    source: `
      let buf = '';
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, authMethods: [] } });
          else if (req.method === 'session/new') send({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'test-session' } });
          // Like an agent stopped by the OS (for example its systemd scope after an OOM kill) mid-turn.
          else if (req.method === 'session/prompt') process.kill(process.pid, 'SIGTERM');
          else if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, result: {} });
        }
      });
    `,
  });
}

describe('AcpBackend provider process exit', () => {
  it('reports an agent killed by a signal as a provider process exit, not as a provider-reported error', async () => {
    await withTempDir('happier-acp-process-exit-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeAgentKilledDuringPrompt(dir)],
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
        permissionHandler: { async handleToolCall() { return { decision: 'denied' as const }; } },
      });
      const statusErrors: Extract<AgentMessage, { type: 'status' }>[] = [];
      backend.onMessage((message) => {
        if (message.type === 'status' && message.status === 'error') statusErrors.push(message);
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi').catch(() => {});
        await expect.poll(() => statusErrors.length, { timeout: 10_000 }).toBeGreaterThan(0);

        const exitStatus = statusErrors.find((message) => message.detail === 'Signal: SIGTERM');
        expect(exitStatus).toBeDefined();
        const issue = classifyPrimarySessionRuntimeIssue({
          cause: 'status_error',
          provider: 'test',
          error: exitStatus?.error ?? exitStatus?.detail,
        });
        expect(issue).toEqual(expect.objectContaining({
          source: 'provider_process_exit',
          code: 'provider_process_exit',
          sanitizedPreview: 'Provider process exited',
        }));
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
