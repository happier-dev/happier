import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { TurnStallNotice } from '@/agent/runtime/session/turn/stallWatch';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe('createAcpRuntime provider activity ingress', () => {
  it('postpones a silence notice on native ingress before a permission wait, then reports continued silence once', async () => {
    await withTempDir('happier-acp-provider-activity-', async (dir) => {
      const script = writeAcpTestAgentScript({ dir, fileName: 'provider.mjs', source: `
        let buffer = '';
        let promptId;
        const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
        process.stdin.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.method === 'initialize') {
              send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [] } });
            } else if (message.method === 'session/new') {
              send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-session' } });
            } else if (message.method === 'session/prompt') {
              promptId = message.id;
              send({ jsonrpc: '2.0', method: 'session/update', params: {
                sessionId: 'native-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } },
              } });
              send({ jsonrpc: '2.0', id: 'native-write', method: 'fs/write_text_file', params: {
                sessionId: 'native-session', path: 'native.txt', content: 'native content',
              } });
            } else if (message.id === 'native-write') {
              send({ jsonrpc: '2.0', id: 'native-read', method: 'fs/read_text_file', params: {
                sessionId: 'native-session', path: 'native.txt',
              } });
            } else if (message.id === 'native-read') {
              send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
            } else if (message.id !== undefined) {
              send({ jsonrpc: '2.0', id: message.id, result: {} });
            }
          }
        });
      ` });
      let permissionEntered!: () => void;
      const permissionWaiting = new Promise<void>((resolve) => { permissionEntered = resolve; });
      let approveWrite!: (value: { decision: 'approved' }) => void;
      const approval = new Promise<{ decision: 'approved' }>((resolve) => { approveWrite = resolve; });
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath, args: [script],
        // User approval is the external boundary; the ACP SDK, filesystem and lifecycle remain real.
        permissionHandler: { handleToolCall: async () => { permissionEntered(); return approval; } },
      });
      const notices: TurnStallNotice[] = [];
      const lifecycle = createSessionTurnLifecycle({
        sessionId: 'happier-session', enqueueSessionTurn: async () => {},
        now: () => Date.now(),
        turnStallWarnMs: 1000, onTurnStallNotice: (notice) => { notices.push(notice); },
      });
      const runtime = createTestAcpRuntime({
        provider: 'customAcp', directory: dir, messageBuffer: new MessageBuffer(), mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {},
        ensureBackend: async () => backend,
        session: createBasicSessionClientWithOverrides({ sessionTurnLifecycle: lifecycle }),
      });
      let sending: Promise<void> | null = null;
      try {
        await runtime.startOrLoad({});
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(0);
        await lifecycle.beginTurn({ provider: 'customAcp' });
        runtime.beginTurn();
        await vi.advanceTimersByTimeAsync(600);
        sending = runtime.sendPrompt('hello');
        void sending.catch(() => {}); // The assertion path awaits it; cleanup also drains failed attempts.
        await permissionWaiting;
        await vi.advanceTimersByTimeAsync(400);
        expect(notices).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(599);
        expect(notices).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(notices).toEqual([expect.objectContaining({
          stallMs: 1000, lastEventAgeMs: 1000, sessionId: 'happier-session',
        })]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(notices).toHaveLength(1);
        approveWrite({ decision: 'approved' });
        await sending;
      } finally {
        approveWrite({ decision: 'approved' });
        await sending?.catch(() => {});
        lifecycle.dispose();
        vi.useRealTimers();
        await runtime.reset();
        await lifecycle.endSession();
      }
    });
  });
});
