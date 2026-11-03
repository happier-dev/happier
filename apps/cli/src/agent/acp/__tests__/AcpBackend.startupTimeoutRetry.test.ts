import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import {
  createAcpSubprocessEnvScope,
  createAcpTestTransportHandler,
  writeAcpTestAgentScript,
} from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { SpawnFailureError } from '@/processes/spawnFailure/classifySpawnFailure';
import { createDaemonShutdownController, type DaemonShutdownRequest } from '@/daemon/lifecycle/shutdown';

type StartupMethod = 'initialize' | 'authenticate' | 'session/load';

function writeStallingAcpAgentScript(params: {
  dir: string;
  requestLogPath: string;
  stallMethod: StartupMethod;
}): string {
  const source = `
    const { appendFileSync } = require('node:fs');
    const decoder = new TextDecoder();
    let buffer = '';

    function send(value) {
      process.stdout.write(JSON.stringify(value) + '\\n');
    }

    function record(method) {
      appendFileSync(${JSON.stringify(params.requestLogPath)}, method + '\\n');
    }

    process.stdin.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.id === undefined || typeof request.method !== 'string') continue;

        record(request.method);
        if (request.method === ${JSON.stringify(params.stallMethod)}) continue;

        if (request.method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: 1,
              authMethods: [{ id: 'test-auth', name: 'Test auth' }],
              // The handshake is the runtime authority for resume. Without it
              // the load case stops at the negotiation refusal and never
              // reaches the ambiguous stalled 'session/load' it exists to cover.
              agentCapabilities: { loadSession: true },
            },
          });
          continue;
        }
        if (request.method === 'authenticate') {
          send({ jsonrpc: '2.0', id: request.id, result: {} });
          continue;
        }
        if (request.method === 'session/new' || request.method === 'session/load') {
          send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'test-session' } });
          continue;
        }
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: `stall-${params.stallMethod.replace('/', '-')}.cjs`,
    source,
  });
}

function countRequests(requestLogPath: string, method: StartupMethod): number {
  return readFileSync(requestLogPath, 'utf8')
    .split('\n')
    .filter((line) => line === method)
    .length;
}

describe('AcpBackend startup timeout retry safety', () => {
  it('retains a typed startup transport failure when the configured executable exits without speaking ACP', async () => {
    await withTempDir('happier-acp-closed-startup-', async dir => {
      const backend = new AcpBackend({ agentName: 'non-acp-command', cwd: dir,
        command: process.execPath, args: ['-e', 'process.exit(0)'], transportHandler: createAcpTestTransportHandler() });
      try {
        await expect(backend.startSession()).rejects.toMatchObject({ code: 'agent_startup_transport_failed' });
      } finally {
        await backend.dispose();
      }
    });
  });

  it.each(['start', 'load'] as const)('rejects an absent executable as a typed %s failure and keeps other operations usable', async operation => {
    await withTempDir('happier-acp-missing-executable-', async dir => {
      const environment = createAcpSubprocessEnvScope();
      environment.patch({ HAPPIER_DEBUG_ARTIFACTS_DIR: join(dir, 'artifacts') });
      const backend = new AcpBackend({ agentName: 'missing-configured-agent', cwd: dir,
        command: join(dir, 'absent-agent'), args: [], transportHandler: createAcpTestTransportHandler() });
      const daemonEvents = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit'] as const;
      // The base emitter view accepts the event union; per-event overloads do not.
      const processEvents: NodeJS.EventEmitter = process;
      const priorListeners = new Map(daemonEvents.map(event => [event, new Set(processEvents.listeners(event))] as const));
      const shutdowns: DaemonShutdownRequest[] = [];
      const daemon = createDaemonShutdownController();
      void daemon.resolvesWhenShutdownRequested.then(request => { shutdowns.push(request); });
      try {
        const result = operation === 'start' ? backend.startSession() : backend.loadSession('retained-session');
        await expect(result).rejects.toBeInstanceOf(SpawnFailureError);
        await expect(result).rejects.toMatchObject({
          code: 'ENOENT',
          message: expect.stringMatching(/check.*command.*working directory/i),
          spawnFailure: { reason: 'other', errno: 'ENOENT' },
          cause: { code: 'ENOENT' },
        });
        // An independent operation must still start after the failed OS spawn.
        const scriptPath = writeStallingAcpAgentScript({ dir, requestLogPath: join(dir, 'healthy.log'), stallMethod: 'authenticate' });
        const healthy = new AcpBackend({ agentName: 'healthy-agent', cwd: dir,
          command: process.execPath, args: [scriptPath], transportHandler: createAcpTestTransportHandler() });
        try {
          await expect(healthy.startSession()).resolves.toEqual({ sessionId: 'test-session' });
          expect(shutdowns).toEqual([]);
        } finally {
          await healthy.dispose();
        }
      } finally {
        await backend.dispose();
        environment.restore();
        for (const event of daemonEvents) {
          for (const listener of processEvents.listeners(event)) {
            if (!priorListeners.get(event)?.has(listener)) processEvents.removeListener(event, listener as (...args: unknown[]) => void);
          }
        }
      }
    });
  });
  it.each([
    { method: 'initialize' as const, operation: 'start' as const },
    { method: 'authenticate' as const, operation: 'start' as const },
    { method: 'session/load' as const, operation: 'load' as const },
  ])('does not repeat an ambiguous $method request on the same connection', async ({ method, operation }) => {
    await withTempDir('happier-acp-startup-timeout-', async (dir) => {
      const requestLogPath = join(dir, 'requests.log');
      const scriptPath = writeStallingAcpAgentScript({
        dir,
        requestLogPath,
        stallMethod: method,
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authMethodId: method === 'authenticate' ? 'test-auth' : undefined,
        transportHandler: createAcpTestTransportHandler({ initTimeoutMs: 500 }),
      });

      try {
        const result = operation === 'load'
          ? backend.loadSession('test-session')
          : backend.startSession();
        await expect(result).rejects.toThrow(/timeout/i);
        expect(countRequests(requestLogPath, method)).toBe(1);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
