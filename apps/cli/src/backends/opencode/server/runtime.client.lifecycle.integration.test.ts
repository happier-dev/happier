import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';
import { createOpenCodeServerRuntime } from './runtime';

function createSessionHarness() {
  const metadata: Record<string, unknown> = {};
  return {
    sessionId: 'happy_opencode_composed_lifecycle',
    keepAlive: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    sessionTurnLifecycle: {
      beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
      attachProviderTurnId: vi.fn(async () => {}),
      appendTranscriptAnchors: vi.fn(async () => {}),
      completeTurn: vi.fn(async () => {}),
      failTurn: vi.fn(async () => {}),
      cancelTurn: vi.fn(async () => {}),
      endSession: vi.fn(async () => {}),
      markRollbackEligible: vi.fn(async () => {}),
      markRolledBack: vi.fn(async () => {}),
    },
    sendUserTextMessageCommitted: vi.fn(async () => {}),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    ensureMetadataSnapshot: vi.fn(async () => ({ ok: true })),
    getMetadataSnapshot: () => metadata,
    updateMetadata: vi.fn(async (updater: (previous: unknown) => unknown) => {
      const next = updater(metadata);
      if (!next || typeof next !== 'object' || Array.isArray(next)) return;
      for (const key of Object.keys(metadata)) delete metadata[key];
      Object.assign(metadata, next);
    }),
    getLastObservedMessageSeq: () => 0,
  };
}

function sendJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

describe('OpenCode client/runtime lifecycle composition', () => {
  const openServers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
  });

  it('waits for exact-parent terminal inventory after live provider error and idle', async () => {
    let eventResponse: ServerResponse | null = null;
    let eventStreamKind: 'instance' | 'global' | null = null;
    let promptMessageId = '';
    let promptAccepted = false;
    let terminalInventoryReady = false;

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/global/health') {
        sendJson(response, { healthy: true, version: '1.14.41' });
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/event' || url.pathname === '/global/event')) {
        eventStreamKind = url.pathname === '/event' ? 'instance' : 'global';
        if (eventStreamKind === 'instance') {
          expect(url.searchParams.get('directory')).toBe('/tmp');
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        eventResponse = response;
        const connected = { type: 'server.connected', properties: {} };
        response.write(`data: ${JSON.stringify(eventStreamKind === 'instance'
          ? connected
          : { directory: '/tmp', payload: connected })}\n\n`);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/session') {
        sendJson(response, { id: 'ses_1', directory: '/tmp' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_1/prompt_async') {
        const body = await readJsonBody(request);
        promptMessageId = typeof body.messageID === 'string' ? body.messageID : '';
        promptAccepted = true;
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/session/ses_1/message') {
        if (!promptAccepted) {
          sendJson(response, []);
          return;
        }
        sendJson(response, [
          {
            info: { id: promptMessageId, role: 'user', sessionID: 'ses_1', time: { created: 10 } },
            parts: [{ id: 'part_user', type: 'text', text: 'hello' }],
          },
          {
            info: {
              id: 'msg_provider_error',
              role: 'assistant',
              sessionID: 'ses_1',
              parentID: promptMessageId,
              time: { created: 11, ...(terminalInventoryReady ? { completed: 12 } : {}) },
              error: {
                name: 'ProviderModelNotFoundError',
                data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
              },
            },
            parts: [],
          },
        ]);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/global/config') {
        sendJson(response, { model: 'openai/gpt-test' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/provider') {
        sendJson(response, { all: [{ id: 'openai', models: { 'gpt-test': { id: 'gpt-test' } } }], connected: ['openai'] });
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/agent' || url.pathname === '/skill' || url.pathname === '/permission' || url.pathname === '/question' || url.pathname.endsWith('/todo') || url.pathname.endsWith('/diff'))) {
        sendJson(response, []);
        return;
      }
      sendJson(response, {}, 404);
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    };
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      baseUrlOverride: baseUrl,
      env,
      messageBuffer: new MessageBuffer(),
    });
    const session = createSessionHarness();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env,
      session: session as never,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      happierMcpAdmission: { kind: 'not_available_for_execution_run' },
      permissionHandler: { handleToolCall: async () => ({ decision: 'approved' as const }) } as never,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'default',
    }, {
      createClient: async () => client,
    });

    let promptPromise: Promise<void> | null = null;
    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      promptPromise = runtime.sendPromptWithMeta?.({ text: 'hello', localId: 'local-composed-error' }) ?? Promise.resolve();
      void promptPromise.catch(() => undefined);
      await expect.poll(() => promptAccepted).toBe(true);
      await expect.poll(() => eventResponse !== null).toBe(true);

      const emit = (event: unknown): void => {
        const payload = eventStreamKind === 'instance'
          ? event
          : { directory: '/tmp', payload: event };
        eventResponse?.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'ProviderModelNotFoundError',
            data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();

      emit({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();

      terminalInventoryReady = true;
      emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_provider_error',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: promptMessageId,
            time: { created: 11, completed: 12 },
            error: {
              name: 'ProviderModelNotFoundError',
              data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
            },
          },
        },
      });

      const promptOutcome = Promise.race([
        promptPromise,
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out waiting for prompt failure')), 500);
          timer.unref?.();
        }),
      ]);
      await expect(promptOutcome).rejects.toThrow('Model not found: openai-codex/gpt-5.6-luna');
      await expect.poll(() => session.sessionTurnLifecycle.failTurn.mock.calls.length).toBe(1);
    } finally {
      await runtime.reset().catch(() => {});
      await client.dispose().catch(() => {});
      await promptPromise?.catch(() => undefined);
    }
  });
});
