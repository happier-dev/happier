import { readFile } from 'node:fs/promises';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import type { RpcHandler } from '@/api/rpc/types';

vi.mock('./capabilities', () => ({ registerCapabilitiesHandlers: vi.fn() }));
vi.mock('./previewEnv', () => ({ registerPreviewEnvHandler: vi.fn() }));
vi.mock('./bash', () => ({ registerBashHandler: vi.fn() }));
vi.mock('./ripgrep', () => ({ registerRipgrepHandler: vi.fn() }));
vi.mock('./difftastic', () => ({ registerDifftasticHandler: vi.fn() }));
vi.mock('./sessionUserMessageSend', () => ({ registerSessionUserMessageSendHandler: vi.fn() }));
vi.mock('./daemonContributionRegistryProjection', () => ({ registerDaemonContributionRegistryProjectionHandler: vi.fn() }));

function createRpcHarness() {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  return {
    handlers,
    rpcHandlerManager: {
      registerHandler<TRequest = unknown, TResponse = unknown>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>,
      ) {
        handlers.set(method, (input: unknown) => handler(input as TRequest) as Promise<unknown>);
      },
    },
  };
}

const TRANSCRIPT_RPC_CASES = [
  [RPC_METHODS.SESSION_LOG_TAIL, 'session.log.tail', { path: '/tmp/session.log', maxBytes: 4096 }],
  [RPC_METHODS.TRANSCRIPT_PAGE, 'transcript.page', { sessionId: 'session-1', cursor: 'cursor-1', maxItems: 25 }],
  [RPC_METHODS.TRANSCRIPT_READ_AFTER, 'transcript.readAfter', { sessionId: 'session-1', cursor: 'cursor-1', maxItems: 25 }],
  [RPC_METHODS.TRANSCRIPT_FOLLOW, 'transcript.follow', { sessionId: 'session-1', cursor: 'tail', leaseId: 'lease-1' }],
  [RPC_METHODS.TRANSCRIPT_IMPORT, 'transcript.import', { sessionId: 'session-1', items: [{ id: 'row-1' }], maxItems: 1 }],
  [RPC_METHODS.TRANSCRIPT_SEARCH, 'transcript.search', { sessionId: 'session-1', query: 'needle', maxItems: 10 }],
] as const;

describe('session transcript RPC handlers', () => {
  it('does not own a transcript-local RPC binding table', async () => {
    const source = await readFile(new URL('./registerSessionHandlers.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('TRANSCRIPT_RPC_BINDINGS');
  });

  it('dispatches transcript RPC methods through the ActionSpec adapter', async () => {
    const module = await import('./registerSessionHandlers');
    const calls: unknown[] = [];
    const actionExecutor: RpcActionExecutor = {
      execute: async (actionId, input, context) => {
        calls.push({ actionId, input, context });
        return { ok: true, result: { ok: true, actionId } };
      },
    };
    const { handlers, rpcHandlerManager } = createRpcHarness();

    module.registerSessionTranscriptRpcHandlers({
      rpcHandlerManager,
      actionExecutor,
    });

    for (const [method, actionId, input] of TRANSCRIPT_RPC_CASES) {
      await expect(handlers.get(method)?.(input)).resolves.toEqual({ ok: true, actionId });
    }

    expect(calls).toEqual(TRANSCRIPT_RPC_CASES.map(([, actionId, input]) => ({
      actionId,
      input,
      context: {
        ...('sessionId' in input ? { defaultSessionId: input.sessionId } : {}),
        surface: 'rpc',
      },
    })));
  });

  it('registers transcript RPC methods in the production session handler set without injected test executors', async () => {
    const module = await import('./registerSessionHandlers');
    const { handlers, rpcHandlerManager } = createRpcHarness();

    module.registerSessionHandlers(rpcHandlerManager, process.cwd());

    expect([...handlers.keys()]).toEqual(expect.arrayContaining(
      TRANSCRIPT_RPC_CASES.map(([method]) => method),
    ));
  });
});
