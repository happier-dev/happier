import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAcpTransportHandlerFromDefinition } from '../runtime/definition/transport';
import { createWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';

function backgroundPermissionAgent(dir: string): string {
  // Grok's shared native permission handle sends child requests through the root ACP session.
  // Primary basis: xai-org/grok-build 2bdd1d6a, handle_request.rs:1621 and permission/manager/mod.rs:495,1369.
  return writeAcpTestAgentScript({
    dir,
    fileName: 'background-permission.mjs',
    source: `
      import { appendFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      let buffer = '';
      let promptCount = 0;
      let successor;
      let permissionSent = false;
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
      const timer = setInterval(() => {
        if (permissionSent || !existsSync(join(${JSON.stringify(dir)}, 'background-ready'))) return;
        permissionSent = true;
        send({ jsonrpc: '2.0', id: 'background-permission', method: 'session/request_permission', params: {
          sessionId: 'owned-session',
          toolCall: { toolCallId: 'background-tool', kind: 'execute', rawInput: { command: 'pwd' } },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
        }});
      }, 5);
      process.stdin.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') ok(message.id, { protocolVersion: 1, authMethods: [] });
          else if (message.method === 'session/new') ok(message.id, { sessionId: 'owned-session' });
          else if (message.method === 'session/prompt') {
            promptCount++;
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'owned-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'admitted' } }
            }});
            if (promptCount === 1) ok(message.id, { stopReason: 'end_turn' });
            else successor = message.id;
          } else if (message.method === 'session/cancel') {
            appendFileSync(join(${JSON.stringify(dir)}, 'cancels.jsonl'), JSON.stringify({ sessionId: message.params.sessionId, promptCount }) + '\\n');
            if (successor != null) { ok(successor, { stopReason: 'cancelled' }); successor = null; }
            if (message.id != null) ok(message.id, {});
          } else if (!message.method && message.id === 'background-permission') {
            appendFileSync(join(${JSON.stringify(dir)}, 'background-response.json'), JSON.stringify(message.result));
            if (successor != null) { ok(successor, { stopReason: 'end_turn' }); successor = null; }
            clearInterval(timer);
          } else if (message.id != null && message.method) ok(message.id, {});
        }
      });
    `,
  });
}

function permissionAgent(dir: string, requestSessionId: string, successorPermission = false): string {
  // The subprocess is the genuine ACP transport boundary; the backend and permission pipeline remain real.
  return writeAcpTestAgentScript({
    dir,
    fileName: 'permission-owner.mjs',
    source: `
      import { appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      let buffer = '';
      let promptId;
      let promptCount = 0;
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
      process.stdin.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') ok(message.id, { protocolVersion: 1, authMethods: [] });
          else if (message.method === 'session/new') ok(message.id, { sessionId: 'owned-session' });
          else if (message.method === 'session/prompt') {
            promptId = message.id;
            promptCount++;
            // Session traffic proves admission while the genuine prompt RPC remains in flight.
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'owned-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'admitted' } }
            }});
            if (promptCount === 1) send({ jsonrpc: '2.0', id: 'permission-first', method: 'session/request_permission', params: {
              sessionId: ${JSON.stringify(requestSessionId)},
              toolCall: { toolCallId: 'first-tool', kind: 'execute', rawInput: { command: 'pwd' } },
              options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
            }});
          } else if (message.method === 'session/cancel') {
            appendFileSync(join(${JSON.stringify(dir)}, 'cancels.jsonl'), JSON.stringify({ sessionId: message.params.sessionId, promptCount }) + '\\n');
            if (promptId != null) {
              ok(promptId, { stopReason: 'cancelled' });
              promptId = null;
            }
            if (message.id != null) ok(message.id, {});
          } else if (!message.method && message.id === 'permission-first') {
            if (${JSON.stringify(successorPermission)}) {
              appendFileSync(join(${JSON.stringify(dir)}, 'permission.jsonl'), JSON.stringify(message.result) + '\\n');
              send({ jsonrpc: '2.0', id: 'permission-second', method: 'session/request_permission', params: {
                sessionId: 'owned-session',
                toolCall: { toolCallId: 'first-tool', kind: 'execute', rawInput: { command: 'pwd' } },
                options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
              }});
              continue;
            }
            appendFileSync(join(${JSON.stringify(dir)}, 'permission.jsonl'), JSON.stringify(message.result) + '\\n');
            if (promptId != null) {
              ok(promptId, { stopReason: 'end_turn' });
              promptId = null;
            }
          } else if (!message.method && message.id === 'permission-second') {
            appendFileSync(join(${JSON.stringify(dir)}, 'second-permission.jsonl'), JSON.stringify(message.result) + '\\n');
            if (promptId != null) { ok(promptId, { stopReason: 'end_turn' }); promptId = null; }
          } else if (message.id != null && message.method) ok(message.id, {});
        }
      });
    `,
  });
}

async function cancellations(dir: string): Promise<unknown[]> {
  try {
    return (await readFile(join(dir, 'cancels.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

describe('ACP permission cancellation ownership', () => {
  it.each(['pre_prompt', 'decision'] as const)('records %s policy withdrawal at the default session log level', async (phase) => {
    await withTempDir('happier-acp-permission-log-', async (dir) => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL', 'DEBUG', 'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING']);
      env.patch({ HAPPIER_HOME_DIR: dir, HAPPIER_LOG_LEVEL: undefined, DEBUG: undefined, DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: undefined });
      vi.resetModules();
      const { logger } = await import('@/ui/logger');
      const { AcpBackend: LoggedAcpBackend } = await import('../AcpBackend');
      const fail = async () => { throw new Error('private-provider-payload'); };
      const backend = new LoggedAcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [permissionAgent(dir, 'owned-session')],
        permissionHandler: { handleToolCall: fail, ...(phase === 'pre_prompt' ? { resolvePrePromptDecision: fail } : {}) },
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 50 }),
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'permission');
        await expect(backend.waitForResponseComplete()).rejects.toMatchObject({ name: 'AbortError' });
        await expect.poll(() => readFile(join(dir, 'permission.jsonl'), 'utf8')).toContain('cancelled');
        logger.flushSync();
        const log = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
        const diagnostics = log.split('\n').filter((line) => line.includes('"phase":"' + phase + '"'))
          .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
        expect(diagnostics).toContainEqual(expect.objectContaining({ phase, errorType: 'Error' }));
        expect(log).not.toContain('private-provider-payload');
      } finally {
        await backend.dispose();
        logger.flushSync();
        env.restore();
      }
    });
  });

  it('preserves the active Grok query permission default without a handler', async () => {
    await withTempDir('happier-grok-default-permission-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'grok', cwd: dir, command: process.execPath,
        args: [permissionAgent(dir, 'owned-session')],
        transportHandler: createAcpTransportHandlerFromDefinition({ backendId: 'grok', permissions: { scope: 'session' } }),
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'permission');
        await backend.waitForResponseComplete();
        await expect.poll(() => readFile(join(dir, 'permission.jsonl'), 'utf8')).toContain('reject');
        expect(await cancellations(dir)).toEqual([]);
      } finally {
        await backend.dispose();
      }
    });
  });

  it.each(['idle', 'concurrent'] as const)('preserves Grok session-owned background permissions while %s', async (phase) => {
    await withTempDir('happier-grok-background-permission-', async (dir) => {
      let requests = 0;
      const messages: Array<{ type: string }> = [];
      const backend = new AcpBackend({
        agentName: 'grok', cwd: dir, command: process.execPath,
        args: [backgroundPermissionAgent(dir)],
        permissionHandler: { handleToolCall: async () => {
          requests++;
          return { decision: phase === 'idle' ? 'approved' : 'denied' };
        } },
        transportHandler: createAcpTransportHandlerFromDefinition({ backendId: 'grok', permissions: { scope: 'session' } }),
      });
      backend.onMessage((message) => messages.push(message));
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'start background child');
        await backend.waitForResponseComplete();
        messages.length = 0;
        if (phase === 'concurrent') await backend.sendPrompt(started.sessionId, 'successor');
        const completion = phase === 'concurrent' ? backend.waitForResponseComplete() : null;
        const settled = completion?.then((outcome) => ({ outcome }), (error: unknown) => ({ error }));
        await writeFile(join(dir, 'background-ready'), 'ready');
        await expect.poll(() => readFile(join(dir, 'background-response.json'), 'utf8')).toContain(phase === 'idle' ? 'allow' : 'reject');
        if (settled) expect(await settled).toEqual({ outcome: { kind: 'completed', stopReason: 'end_turn' } });
        expect(requests).toBe(1);
        expect(await cancellations(dir)).toEqual([]);
        expect(messages.filter((message) => message.type === 'tool-call' || message.type === 'tool-result')).toEqual([]);
      } finally {
        await backend.dispose();
      }
    });
  });

  it.each([
    ['owned-session', true],
    ['foreign-session', false],
  ] as const)('only cancels an active prompt owned by the requesting session (%s)', async (requestSessionId, ownsPrompt) => {
    await withTempDir('happier-acp-permission-owner-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [permissionAgent(dir, requestSessionId)],
        permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) },
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 50 }),
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'permission');
        const completion = backend.waitForResponseComplete();
        if (ownsPrompt) await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
        else await expect(completion).resolves.toEqual({ kind: 'completed', stopReason: 'end_turn' });
        await expect.poll(() => readFile(join(dir, 'permission.jsonl'), 'utf8')).toContain(ownsPrompt ? 'reject' : 'cancelled');
        expect(await cancellations(dir)).toEqual(ownsPrompt ? [{ sessionId: 'owned-session', promptCount: 1 }] : []);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('preserves an active capacity failure while cancelling its actual provider prompt', async () => {
    await withTempDir('happier-acp-permission-capacity-', async (dir) => {
      const failure = createWorkflowInteractionCapacityError();
      let decide!: () => void;
      const decision = new Promise<void>((resolve) => { decide = resolve; });
      let requested!: () => void;
      const permissionRequested = new Promise<void>((resolve) => { requested = resolve; });
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [permissionAgent(dir, 'owned-session')],
        permissionHandler: { handleToolCall: async () => {
          requested();
          await decision;
          throw failure;
        } },
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 50 }),
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'permission');
        const completion = backend.waitForResponseComplete();
        const failed = expect(completion).rejects.toMatchObject({ code: failure.code, recoverable: true });
        await permissionRequested;
        decide();
        await failed;
        await expect.poll(() => readFile(join(dir, 'permission.jsonl'), 'utf8')).toContain('cancelled');
        expect(await cancellations(dir)).toEqual([{ sessionId: 'owned-session', promptCount: 1 }]);
      } finally {
        decide();
        await backend.dispose();
      }
    });
  });

  it.each(['denied', 'capacity'] as const)('does not let a late %s decision from a settled turn cancel its successor', async (outcome) => {
    await withTempDir('happier-acp-permission-successor-', async (dir) => {
      let requested!: () => void;
      const permissionRequested = new Promise<void>((resolve) => { requested = resolve; });
      let deny!: () => void;
      const decision = new Promise<void>((resolve) => { deny = resolve; });
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [permissionAgent(dir, 'owned-session')],
        permissionHandler: { handleToolCall: async () => {
          requested();
          await decision;
          if (outcome === 'capacity') throw createWorkflowInteractionCapacityError();
          return { decision: 'denied' };
        } },
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 50 }),
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'first');
        const first = backend.waitForResponseComplete();
        const firstAborted = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await permissionRequested;
        await backend.cancel(started.sessionId);
        await firstAborted;
        await backend.sendPrompt(started.sessionId, 'successor');
        const successor = backend.waitForResponseComplete();
        deny();
        await expect(successor).resolves.toEqual({ kind: 'completed', stopReason: 'end_turn' });
        await expect.poll(() => readFile(join(dir, 'permission.jsonl'), 'utf8')).toContain('cancelled');
        expect(await cancellations(dir)).toEqual([{ sessionId: 'owned-session', promptCount: 1 }]);
      } finally {
        deny();
        await backend.dispose();
      }
    });
  });
  it('withdraws a late approval instead of caching it for a reused successor tool ID', async () => {
    await withTempDir('happier-acp-permission-approval-', async (dir) => {
      let requested!: () => void;
      const permissionRequested = new Promise<void>((resolve) => { requested = resolve; });
      let approve!: () => void;
      const decision = new Promise<void>((resolve) => { approve = resolve; });
      let requests = 0;
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [permissionAgent(dir, 'owned-session', true)],
        permissionHandler: { handleToolCall: async () => {
          requests++;
          if (requests !== 1) return { decision: 'denied' };
          requested();
          await decision;
          return { decision: 'approved' };
        } },
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 50 }),
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'first');
        const firstAborted = expect(backend.waitForResponseComplete()).rejects.toMatchObject({ name: 'AbortError' });
        await permissionRequested;
        await backend.cancel(started.sessionId);
        await firstAborted;
        await backend.sendPrompt(started.sessionId, 'successor');
        const successorAborted = expect(backend.waitForResponseComplete()).rejects.toMatchObject({ name: 'AbortError' });
        approve();
        await successorAborted;
        await expect.poll(() => readFile(join(dir, 'second-permission.jsonl'), 'utf8')).toContain('reject');
        expect(await readFile(join(dir, 'permission.jsonl'), 'utf8')).toContain('cancelled');
        expect(requests).toBe(2);
      } finally {
        approve();
        await backend.dispose();
      }
    });
  });

});
