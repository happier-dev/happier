import { describe, expect, it } from 'vitest';

import {
  readFileEventually,
  waitForFileToContain,
  writeAcpTestAgentScript,
} from '../testkit/subprocessHarness';
import { AcpBackend, buildInitializeRequest, type AcpExtensionHandlerContext } from '../AcpBackend';
import { withTempDir } from '@/testkit/fs/tempDir';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('Expected JSON record');
  }
  return parsed;
}

function readNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected nested record at ${key}`);
  }
  return value;
}

function writeExtensionProbeAgentScript(params: {
  dir: string;
  resultFile: string;
  scenario: 'request' | 'notification' | 'error' | 'abort';
}): string {
  const src = `
    const fs = require('node:fs');
    const decoder = new TextDecoder();
    let buf = '';
    let pendingPromptId = null;

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function writeResult(obj) {
      fs.writeFileSync(${JSON.stringify(params.resultFile)}, JSON.stringify(obj), 'utf8');
    }

    function finishPrompt() {
      if (pendingPromptId !== null) {
        ok(pendingPromptId, { stopReason: 'end_turn' });
        pendingPromptId = null;
      }
    }

    function handleResponse(message) {
      if (message.id === 'extension-request-1') {
        writeResult(message);
        finishPrompt();
      }
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;

        if (!('method' in req) && 'id' in req) {
          handleResponse(req);
          continue;
        }

        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          writeResult(req.params || {});
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          continue;
        }

        if (method === 'session/prompt') {
          pendingPromptId = id;
          const scenario = ${JSON.stringify(params.scenario)};
          if (scenario === 'notification') {
            send({
              jsonrpc: '2.0',
              method: 'example/notification',
              params: { sessionId: 'test-session', value: 'notify' },
            });
            setTimeout(finishPrompt, 25);
            continue;
          }

          send({
            jsonrpc: '2.0',
            id: 'extension-request-1',
            method: 'example/object_request',
            params: { sessionId: 'test-session', value: scenario },
          });
          continue;
        }

        if (method === 'session/cancel') {
          ok(id, {});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: `fake-acp-extension-${params.scenario}.cjs`,
    source: src,
  });
}

function writeExtensionLifecycleAgentScript(params: {
  dir: string;
  resultFile: string;
}): string {
  const src = `
    const fs = require('node:fs');
    const decoder = new TextDecoder();
    let buf = '';
    let pendingPromptId = null;
    let promptCount = 0;
    const labelsByRequestId = new Map();
    const results = [];

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function persist(label, message) {
      results.push({ label, result: message.result, error: message.error });
      fs.writeFileSync(${JSON.stringify(params.resultFile)}, JSON.stringify(results), 'utf8');
    }

    function request(label) {
      const id = 'extension-' + label;
      labelsByRequestId.set(id, label);
      send({
        jsonrpc: '2.0',
        id,
        method: 'example/object_request',
        params: { sessionId: 'test-session', value: label },
      });
    }

    function notify(phase) {
      send({
        jsonrpc: '2.0',
        method: 'example/notification',
        params: { phase },
      });
    }

    function finishPrompt() {
      if (pendingPromptId === null) return;
      ok(pendingPromptId, { stopReason: 'end_turn' });
      pendingPromptId = null;
    }

    function handleResponse(message) {
      const label = labelsByRequestId.get(message.id);
      if (!label) return;
      labelsByRequestId.delete(message.id);
      persist(label, message);

      if (label === 'in-turn') {
        finishPrompt();
        setImmediate(() => {
          notify('after-turn');
          request('post-terminal');
        });
      } else if (label === 'next-turn') {
        finishPrompt();
      }
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;

        if (!('method' in req) && 'id' in req) {
          handleResponse(req);
          continue;
        }

        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          notify('initialize');
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          setImmediate(() => {
            notify('pre-prompt');
            request('pre-prompt');
          });
          continue;
        }

        if (method === 'session/prompt') {
          pendingPromptId = id;
          promptCount += 1;
          notify('during-turn-' + promptCount);
          if (promptCount === 1) {
            request('in-turn');
          } else if (promptCount === 2) {
            request('terminal-race');
            setTimeout(finishPrompt, 25);
          } else {
            request('next-turn');
          }
          continue;
        }

        if (method === 'session/cancel') {
          ok(id, {});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-extension-lifecycle.cjs',
    source: src,
  });
}

describe('AcpBackend ACP extension dispatch', () => {
  it('merges provider-supplied initialize metadata into the ACP initialize request', () => {
    const params = {
      clientName: 'test',
      clientVersion: '0.0.0',
      initializeMeta: { 'example/client': true },
      initializeClientCapabilitiesMeta: { 'example/capability': 'enabled' },
    };

    const request = buildInitializeRequest(params);

    expect(request._meta).toMatchObject({ 'example/client': true });
    expect(request.clientCapabilities?._meta).toMatchObject({ 'example/capability': 'enabled' });
    expect(request.clientCapabilities?.fs?.readTextFile).toBe(true);
  });

  it('dispatches extension requests and returns object-shaped results to the agent', async () => {
    await withTempDir('happier-acp-extension-request-', async (dir) => {
      const resultFile = `${dir}/extension-result.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'request' });
      const backendOptions = {
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      };
      Object.assign(backendOptions, {
        extensionHandlers: {
          requests: {
            'example/object_request': async (
              params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<Record<string, unknown>> => ({
              ok: true,
              params,
              sessionId: context.sessionId,
              signalAborted: context.signal.aborted,
            }),
          },
        },
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger extension request');

        const response = parseJsonRecord(await readFileEventually(resultFile, { timeoutMs: 1_000 }));
        const result = readNestedRecord(response, 'result');
        expect(result).toMatchObject({
          ok: true,
          sessionId: 'test-session',
          signalAborted: false,
        });
        expect(readNestedRecord(result, 'params')).toMatchObject({ value: 'request' });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('dispatches extension notifications without requiring a response', async () => {
    await withTempDir('happier-acp-extension-notification-', async (dir) => {
      const resultFile = `${dir}/initialize.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'notification' });
      const notifications: Record<string, unknown>[] = [];
      const backendOptions = {
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      };
      Object.assign(backendOptions, {
        extensionHandlers: {
          notifications: {
            'example/notification': async (
              params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<void> => {
              notifications.push({ ...params, sessionIdFromContext: context.sessionId });
            },
          },
        },
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger extension notification');

        expect(notifications).toEqual([
          {
            sessionId: 'test-session',
            sessionIdFromContext: 'test-session',
            value: 'notify',
          },
        ]);
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('scopes requests to active prompt turns while notifications remain connection-scoped', async () => {
    await withTempDir('happier-acp-extension-lifecycle-', async (dir) => {
      const resultFile = `${dir}/extension-lifecycle.json`;
      const scriptPath = writeExtensionLifecycleAgentScript({ dir, resultFile });
      const requestInvocations: string[] = [];
      const notificationInvocations: Array<{
        phase: unknown;
        sessionId: string | null;
        signalAborted: boolean;
        signal: AbortSignal;
      }> = [];
      let resolveTerminalRaceStarted: (() => void) | null = null;
      const terminalRaceStarted = new Promise<void>((resolve) => {
        resolveTerminalRaceStarted = resolve;
      });
      let resolveTerminalRaceAborted: (() => void) | null = null;
      const terminalRaceAborted = new Promise<void>((resolve) => {
        resolveTerminalRaceAborted = resolve;
      });

      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        extensionHandlers: {
          requests: {
            'example/object_request': async (
              params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<Record<string, unknown>> => {
              const value = typeof params.value === 'string' ? params.value : 'unknown';
              requestInvocations.push(value);
              if (value !== 'terminal-race') {
                return { accepted: value, signalAborted: context.signal.aborted };
              }

              resolveTerminalRaceStarted?.();
              await new Promise<void>((_resolve, reject) => {
                const onAbort = () => {
                  resolveTerminalRaceAborted?.();
                  reject(context.signal.reason instanceof Error
                    ? context.signal.reason
                    : new Error('turn-scoped extension aborted'));
                };
                if (context.signal.aborted) {
                  onAbort();
                  return;
                }
                context.signal.addEventListener('abort', onAbort, { once: true });
              });
              return { shouldNotReach: true };
            },
          },
          notifications: {
            'example/notification': async (
              params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<void> => {
              notificationInvocations.push({
                phase: params.phase,
                sessionId: context.sessionId,
                signalAborted: context.signal.aborted,
                signal: context.signal,
              });
            },
          },
        },
      });

      try {
        const started = await backend.startSession();
        await waitForFileToContain(resultFile, 'pre-prompt', { timeoutMs: 1_000 });

        await backend.sendPrompt(started.sessionId, 'first turn');
        await waitForFileToContain(
          resultFile,
          '"label":"post-terminal","error":',
          { timeoutMs: 1_000 },
        );
        const firstTurnResults = JSON.parse(await readFileEventually(resultFile, { timeoutMs: 1_000 })) as Array<{
          label: string;
          result?: Record<string, unknown>;
          error?: Record<string, unknown>;
        }>;
        expect(firstTurnResults.find((entry) => entry.label === 'in-turn')?.result)
          .toMatchObject({ accepted: 'in-turn', signalAborted: false });

        const secondPrompt = backend.sendPrompt(started.sessionId, 'terminal race');
        await expect(Promise.race([
          terminalRaceStarted.then(() => 'started' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
        ])).resolves.toBe('started');
        await secondPrompt;
        await expect(Promise.race([
          terminalRaceAborted.then(() => 'aborted' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
        ])).resolves.toBe('aborted');
        await waitForFileToContain(resultFile, 'terminal-race', { timeoutMs: 1_000 });

        await backend.sendPrompt(started.sessionId, 'next turn');
        await waitForFileToContain(resultFile, 'next-turn', { timeoutMs: 1_000 });
        await waitForFileToContain(
          resultFile,
          '"label":"post-terminal","error":',
          { timeoutMs: 1_000 },
        );

        const finalResults = JSON.parse(await readFileEventually(resultFile, { timeoutMs: 1_000 })) as Array<{
          label: string;
          result?: Record<string, unknown>;
          error?: Record<string, unknown>;
        }>;
        expect(finalResults.find((entry) => entry.label === 'pre-prompt')?.error)
          .toMatchObject({ code: -32600, data: { reason: 'no_active_prompt_turn' } });
        expect(finalResults.find((entry) => entry.label === 'post-terminal')?.error)
          .toMatchObject({ code: -32600, data: { reason: 'no_active_prompt_turn' } });
        expect(finalResults.find((entry) => entry.label === 'terminal-race')?.error)
          .toMatchObject({ code: -32603 });
        expect(finalResults.find((entry) => entry.label === 'next-turn')?.result)
          .toMatchObject({ accepted: 'next-turn', signalAborted: false });
        expect(requestInvocations).toEqual(['in-turn', 'terminal-race', 'next-turn']);

        expect(notificationInvocations.map((entry) => entry.phase)).toEqual(expect.arrayContaining([
          'initialize',
          'pre-prompt',
          'during-turn-1',
          'after-turn',
          'during-turn-2',
          'during-turn-3',
        ]));
        expect(notificationInvocations.every((entry) => entry.signalAborted === false)).toBe(true);
        expect(notificationInvocations.every(
          (entry) => entry.sessionId === null || entry.sessionId === 'test-session',
        )).toBe(true);
        expect(notificationInvocations
          .filter((entry) => typeof entry.phase === 'string' && entry.phase.startsWith('during-turn-'))
          .every((entry) => entry.sessionId === 'test-session')).toBe(true);
        expect(new Set(notificationInvocations.map((entry) => entry.signal)).size).toBe(1);
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 15_000);

  it('surfaces extension handler errors as JSON-RPC internal errors', async () => {
    await withTempDir('happier-acp-extension-error-', async (dir) => {
      const resultFile = `${dir}/extension-error.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'error' });
      const backendOptions = {
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      };
      Object.assign(backendOptions, {
        extensionHandlers: {
          requests: {
            'example/object_request': async (): Promise<Record<string, unknown>> => {
              throw new Error('extension exploded');
            },
          },
        },
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger extension error');

        const response = parseJsonRecord(await readFileEventually(resultFile, { timeoutMs: 1_000 }));
        const error = readNestedRecord(response, 'error');
        expect(error).toMatchObject({ code: -32603 });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('returns JSON-RPC method-not-found when no extension request handler matches', async () => {
    await withTempDir('happier-acp-extension-missing-', async (dir) => {
      const resultFile = `${dir}/extension-missing.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'request' });
      const backendOptions = {
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      };
      Object.assign(backendOptions, {
        extensionHandlers: {
          requests: {
            'example/other_request': async (): Promise<Record<string, unknown>> => ({ unused: true }),
          },
        },
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger missing extension handler');

        const response = parseJsonRecord(await readFileEventually(resultFile, { timeoutMs: 1_000 }));
        const error = readNestedRecord(response, 'error');
        expect(error).toMatchObject({
          code: -32601,
          data: { method: 'example/object_request' },
        });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('aborts in-flight extension handlers when the turn is cancelled', async () => {
    await withTempDir('happier-acp-extension-cancel-', async (dir) => {
      const resultFile = `${dir}/extension-cancel.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'abort' });
      let resolveStarted: (() => void) | null = null;
      const startedHandler = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let resolveAborted: (() => void) | null = null;
      const abortedHandler = new Promise<void>((resolve) => {
        resolveAborted = resolve;
      });
      const backendOptions = {
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      };
      Object.assign(backendOptions, {
        extensionHandlers: {
          requests: {
            'example/object_request': async (
              _params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<Record<string, unknown>> => {
              resolveStarted?.();
              if (context.signal.aborted) {
                resolveAborted?.();
                throw new Error('extension aborted');
              }
              await new Promise<void>((_resolve, reject) => {
                context.signal.addEventListener(
                  'abort',
                  () => {
                    resolveAborted?.();
                    reject(new Error('extension aborted'));
                  },
                  { once: true },
                );
              });
              return { shouldNotReach: true };
            },
          },
        },
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        const prompt = backend.sendPrompt(started.sessionId, 'trigger extension abort');
        const startOutcome = await Promise.race([
          startedHandler.then(() => 'started' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(startOutcome).toBe('started');

        await backend.cancel(started.sessionId);

        const abortOutcome = await Promise.race([
          abortedHandler.then(() => 'aborted' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(abortOutcome).toBe('aborted');
        await prompt.catch(() => {});

        const response = parseJsonRecord(await readFileEventually(resultFile, { timeoutMs: 1_000 }));
        const error = readNestedRecord(response, 'error');
        expect(error).toMatchObject({ code: -32603 });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('aborts in-flight extension handlers when response completion times out', async () => {
    await withTempDir('happier-acp-extension-timeout-', async (dir) => {
      const resultFile = `${dir}/extension-timeout.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'abort' });
      let resolveStarted: (() => void) | null = null;
      const startedHandler = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let resolveAborted: (() => void) | null = null;
      const abortedHandler = new Promise<void>((resolve) => {
        resolveAborted = resolve;
      });
      const backendOptions = {
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      };
      Object.assign(backendOptions, {
        extensionHandlers: {
          requests: {
            'example/object_request': async (
              _params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<Record<string, unknown>> => {
              resolveStarted?.();
              if (context.signal.aborted) {
                resolveAborted?.();
                throw new Error('extension aborted');
              }
              await new Promise<void>((_resolve, reject) => {
                context.signal.addEventListener(
                  'abort',
                  () => {
                    resolveAborted?.();
                    reject(new Error('extension aborted'));
                  },
                  { once: true },
                );
              });
              return { shouldNotReach: true };
            },
          },
        },
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        const prompt = backend.sendPrompt(started.sessionId, 'trigger extension timeout');
        const startOutcome = await Promise.race([
          startedHandler.then(() => 'started' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(startOutcome).toBe('started');

        await expect(backend.waitForResponseComplete(25)).rejects.toThrow(/Timeout waiting for response/i);

        const abortOutcome = await Promise.race([
          abortedHandler.then(() => 'aborted' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(abortOutcome).toBe('aborted');
        await prompt.catch(() => {});

        const response = parseJsonRecord(await readFileEventually(resultFile, { timeoutMs: 1_000 }));
        const error = readNestedRecord(response, 'error');
        expect(error).toMatchObject({ code: -32603 });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);
});
