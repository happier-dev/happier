import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { CodexAcpBackendOptions, CodexAcpBackendResult } from './backend';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { publishCodexSessionIdMetadata } from '../utils/codexSessionIdMetadata';
import { configuration } from '@/configuration';

const loadSession = vi.fn(async (sessionId: string) => ({ sessionId }));
const startSession = vi.fn(async () => ({ sessionId: 'unexpected-fresh-session' }));

function makeFakeBackend(): AgentBackend {
  const handlers: AgentMessageHandler[] = [];
  return {
    loadSession,
    startSession,
    async sendPrompt() {},
    async cancel() {},
    onMessage(handler: AgentMessageHandler) {
      handlers.push(handler);
    },
    async dispose() {
      handlers.length = 0;
    },
  };
}

vi.mock('@/backends/codex/acp/backend', async () => {
  const actual = await vi.importActual<typeof import('./backend')>('@/backends/codex/acp/backend');
  return {
    ...actual,
    createCodexAcpBackend: (_opts: CodexAcpBackendOptions): CodexAcpBackendResult => ({
      backend: makeFakeBackend(),
      spawn: { command: 'codex-acp', args: [] },
    }),
  };
});

describe('Codex ACP resume identity publication', () => {
  beforeEach(() => {
    loadSession.mockClear();
    startSession.mockClear();
  });

  it('keeps a successful load bound when the exact rich identity is already durable and a redundant update would fail', async () => {
    const resumeId = 'codex-resume-thread-1';
    let rejectUpdates = false;
    const session = {
      sessionId: 'happier-session-1',
      metadata: createTestMetadata({ path: '/tmp' }),
      getMetadataSnapshot() {
        return this.metadata;
      },
      updateMetadata: vi.fn(async function (this: { metadata: Metadata }, updater: (current: Metadata) => Metadata) {
        if (rejectUpdates) throw new Error('metadata unavailable');
        this.metadata = updater(this.metadata);
      }),
      sendAgentMessage() {},
      keepAlive() {},
      waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
      shouldAttemptPendingMaterialization: () => true,
      reconcilePendingQueueState: async () => false,
    };
    const publicationParams = {
      getCodexThreadId: () => resumeId,
      backendMode: 'acp' as const,
      transcriptStorage: 'persisted' as const,
      codexHome: process.env.CODEX_HOME ?? null,
      activeServerDir: configuration.activeServerDir,
      processEnv: process.env,
    };
    await publishCodexSessionIdMetadata({
      ...publicationParams,
      session,
      operation: 'create',
      lastPublished: { value: null },
    });
    session.updateMetadata.mockClear();
    rejectUpdates = true;

    const { createCodexAcpRuntime } = await import('./runtime');
    const runtime = createCodexAcpRuntime({
      directory: '/tmp',
      session: session as unknown as ApiSessionClient,
      messageBuffer: {
        addMessage() {},
        removeLastMessage: () => false,
        updateLastMessage() {},
      } as unknown as MessageBuffer,
      mcpServers: {},
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' as const }),
      } as AcpPermissionHandler,
      onThinkingChange() {},
      permissionMode: 'default',
      providerInputConsumer: {
        waitForNextInput: async () => null,
        runProviderInputDispatch: async <Value>({ dispatch }: { dispatch: () => Promise<Value> }) => ({ status: 'dispatched' as const, value: await dispatch() }),
        closeProviderInputAdmissionAndWaitForDispatches: async () => {},
        drainPending: async () => ({ materialized: 0, stoppedReason: 'no_pending' as const }),
        pumpPendingWhileActive: async () => {},
      },
    });

    await expect(runtime.startOrLoad({ resumeId })).resolves.toBe(resumeId);
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(loadSession).toHaveBeenCalledWith(resumeId, undefined);
    expect(startSession).not.toHaveBeenCalled();
    expect(session.updateMetadata).not.toHaveBeenCalled();
    expect(runtime.getSessionId()).toBe(resumeId);
    await runtime.reset();
  });
});
