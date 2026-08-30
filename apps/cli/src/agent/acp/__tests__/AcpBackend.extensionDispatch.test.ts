import { describe, expect, it } from 'vitest';

import { writeAcpTestAgentScript, readJsonEventually } from '../testkit/subprocessHarness';
import { AcpBackend, buildInitializeRequest } from '../AcpBackend';
import {
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
  type AcpExtensionHandlerContext,
} from '../connection/types';
import { withTempDir } from '@/testkit/fs/tempDir';
import { normalizeAcpPlan, type NormalizedAcpPlanSnapshot } from '@/agent/acp/plans';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


function readNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected nested record at ${key}`);
  }
  return value;
}

async function readPromiseState(evidence: Promise<unknown>): Promise<'resolved' | 'pending'> {
  let resolved = false;
  void evidence.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );
  await Promise.resolve();
  return resolved ? 'resolved' : 'pending';
}

const extensionParams = {
  parse(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error('Expected extension object params');
    return value;
  },
};

function writeExtensionProbeAgentScript(params: {
  dir: string;
  resultFile: string;
  scenario: 'request' | 'notification' | 'error' | 'abort' | 'abort-with-update' | 'outgoing';
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
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          continue;
        }

        if (method === 'example/client_request') {
          writeResult(req.params || {});
          ok(id, { ok: true, echoed: req.params || {} });
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

          if (scenario === 'abort-with-update') {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'test-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'provider activity' },
                },
              },
            });
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
        extensionHandlers: [
          defineAcpExtensionRequest({
            method: 'example/object_request',
            params: extensionParams,
            handler: async (
              params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<Record<string, unknown>> => ({
              ok: true,
              params,
              sessionId: context.sessionId,
              signalAborted: context.signal.aborted,
            }),
          }),
        ],
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger extension request');
        await backend.waitForResponseComplete(1_000);

        const response = await readJsonEventually<Record<string, unknown>>(resultFile, { timeoutMs: 1_000 });
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

  it('shares one turn-scoped plan projector with extensions and rejects late prior-turn delivery', async () => {
    await withTempDir('happier-acp-extension-plan-owner-', async (dir) => {
      const resultFile = `${dir}/extension-plan-owner.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'request' });
      const projectedEvents: unknown[] = [];
      const contexts: AcpExtensionHandlerContext[] = [];
      const snapshots: NormalizedAcpPlanSnapshot[] = [];
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        extensionHandlers: [
          defineAcpExtensionRequest({
            method: 'example/object_request',
            params: extensionParams,
            handler: async (_params, context): Promise<Record<string, unknown>> => {
              if (!context.turnId || !context.plans) throw new Error('missing plan projection context');
              const snapshot = normalizeAcpPlan({
                providerId: context.agentName,
                turnId: context.turnId,
                correlationId: 'plan-call',
                source: 'proprietary',
                merge: false,
                items: [{ id: 'todo-1', content: 'Implement', status: 'pending' }],
              });
              if (!snapshot) throw new Error('invalid fixture plan');
              contexts.push(context);
              snapshots.push(snapshot);
              expect((await context.plans.project(snapshot)).kind).toBe('published');
              expect((await context.plans.project(snapshot)).kind).toBe('duplicate');
              return {};
            },
          }),
        ],
      });
      backend.setPlanStatePublisher(async (snapshot) => {
        projectedEvents.push(snapshot);
      });

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'first plan turn');
        await backend.waitForResponseComplete(1_000);
        expect(projectedEvents).toHaveLength(1);
        expect((await contexts[0]?.plans?.project(snapshots[0]!))?.kind).toBe('late');

        await backend.sendPrompt(started.sessionId, 'second identical plan turn');
        await backend.waitForResponseComplete(1_000);
        expect(projectedEvents).toHaveLength(2);
        expect(contexts[1]?.turnId).not.toBe(contexts[0]?.turnId);
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('exposes provider-neutral outgoing extension requests through the active peer', async () => {
    await withTempDir('happier-acp-extension-outgoing-', async (dir) => {
      const resultFile = `${dir}/extension-outgoing.json`;
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'outgoing' });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      try {
        await backend.startSession();
        const response = await backend.requestExtension<{
          ok: boolean;
          echoed: Record<string, unknown>;
        }>('example/client_request', { value: 'request' }, { timeoutMs: 500 });

        expect(response).toEqual({ ok: true, echoed: { value: 'request' } });
        expect(await readJsonEventually<Record<string, unknown>>(resultFile, { timeoutMs: 1_000 }))
          .toEqual({ value: 'request' });
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
        extensionHandlers: [
          defineAcpExtensionNotification({
            method: 'example/notification',
            params: extensionParams,
            handler: async (
              params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<void> => {
              notifications.push({ ...params, sessionIdFromContext: context.sessionId });
            },
          }),
        ],
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger extension notification');
        await backend.waitForResponseComplete(1_000);

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
        extensionHandlers: [
          defineAcpExtensionRequest({
            method: 'example/object_request',
            params: extensionParams,
            handler: async (): Promise<Record<string, unknown>> => {
              throw new Error('extension exploded');
            },
          }),
        ],
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger extension error');
        await backend.waitForResponseComplete(1_000);

        const response = await readJsonEventually<Record<string, unknown>>(resultFile, { timeoutMs: 1_000 });
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
        extensionHandlers: [
          defineAcpExtensionRequest({
            method: 'example/other_request',
            params: extensionParams,
            handler: async (): Promise<Record<string, unknown>> => ({ unused: true }),
          }),
        ],
      });

      const backend = new AcpBackend(backendOptions);

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'trigger missing extension handler');
        await backend.waitForResponseComplete(1_000);

        const response = await readJsonEventually<Record<string, unknown>>(resultFile, { timeoutMs: 1_000 });
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
      const scriptPath = writeExtensionProbeAgentScript({ dir, resultFile, scenario: 'abort-with-update' });
      let resolveStarted: (() => void) | null = null;
      const startedHandler = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let resolveAborted: (() => void) | null = null;
      const abortedHandler = new Promise<void>((resolve) => {
        resolveAborted = resolve;
      });
      const capturedPlan: {
        context: AcpExtensionHandlerContext | null;
        snapshot: NormalizedAcpPlanSnapshot | null;
      } = { context: null, snapshot: null };
      const backendOptions = {
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      };
      Object.assign(backendOptions, {
        extensionHandlers: [
          defineAcpExtensionRequest({
            method: 'example/object_request',
            params: extensionParams,
            handler: async (
              _params: Record<string, unknown>,
              context: AcpExtensionHandlerContext,
            ): Promise<Record<string, unknown>> => {
              if (!context.turnId || !context.plans) throw new Error('missing plan projection context');
              capturedPlan.context = context;
              capturedPlan.snapshot = normalizeAcpPlan({
                providerId: context.agentName,
                turnId: context.turnId,
                correlationId: 'cancelled-plan',
                source: 'proprietary',
                merge: false,
                items: [{ id: 'todo-cancel', content: 'Cancel', status: 'pending' }],
              });
              if (!capturedPlan.snapshot) throw new Error('invalid fixture plan');
              await context.plans.project(capturedPlan.snapshot);
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
          }),
        ],
      });

      const backend = new AcpBackend(backendOptions);
      backend.setPlanStatePublisher(async () => undefined);

      try {
        const started = await backend.startSession();
        await backend.sendPromptWithEvidence(started.sessionId, 'trigger extension abort');
        const startOutcome = await Promise.race([
          startedHandler.then(() => 'started' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(startOutcome).toBe('started');
        await backend.cancel(started.sessionId);
        if (!capturedPlan.context?.plans || !capturedPlan.snapshot) {
          throw new Error('plan projection context was not captured');
        }
        expect((await capturedPlan.context.plans.project(capturedPlan.snapshot)).kind).toBe('late');

        const abortOutcome = await Promise.race([
          abortedHandler.then(() => 'aborted' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(abortOutcome).toBe('aborted');
        const response = await readJsonEventually<Record<string, unknown>>(resultFile, { timeoutMs: 1_000 });
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
        extensionHandlers: [
          defineAcpExtensionRequest({
            method: 'example/object_request',
            params: extensionParams,
            handler: async (
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
          }),
        ],
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

        const response = await readJsonEventually<Record<string, unknown>>(resultFile, { timeoutMs: 1_000 });
        const error = readNestedRecord(response, 'error');
        expect(error).toMatchObject({ code: -32603 });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);
});
