import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { StoredCredentials } from '@/persistence';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

const readStoredCredentialsMock = vi.fn<() => Promise<StoredCredentials | null>>();
const fetchSessionByIdMock = vi.fn();
const fetchEncryptedTranscriptMessagesPageMock = vi.fn();

vi.mock('@/persistence', () => ({
  readStoredCredentials: () => readStoredCredentialsMock(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionById: (args: unknown) => fetchSessionByIdMock(args),
  };
});

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', async () => {
  const actual = await vi.importActual<typeof import('@/session/replay/fetchEncryptedTranscriptMessages')>('@/session/replay/fetchEncryptedTranscriptMessages');
  return {
    ...actual,
    fetchEncryptedTranscriptMessagesPage: (args: unknown) => fetchEncryptedTranscriptMessagesPageMock(args),
  };
});

import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';

describe('rpcHandlers.memory (window retrieval)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the configured content policy into citation windows', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: 'token-memory-window',
      encryption: null,
    });
    fetchSessionByIdMock.mockResolvedValue(
      createSessionRecordFixture({
        id: 'sess-memory-window',
        active: true,
        activeAt: 1,
        metadata: '{}',
        encryptionMode: 'plain',
      }),
    );
    fetchEncryptedTranscriptMessagesPageMock.mockResolvedValue({
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
      messages: [
        {
          seq: 1,
          createdAt: 1000,
          messageRole: 'agent',
          content: {
            t: 'plain' as const,
            v: {
              role: 'agent',
              content: { type: 'codex', data: { type: 'reasoning', message: 'handler reasoning sentinel' } },
            },
          },
        },
      ],
    });

    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as unknown as RpcHandlerManager; // Test boundary: this registration helper only reads registerHandler.
    const memoryWorker: MemoryWorkerHandle = {
      stop: () => {},
      reloadSettings: async () => {},
      ensureUpToDate: async () => {},
      getWorkerStatus: () => ({
        state: 'idle',
        lastTickAtMs: null,
        lastInventoryAtMs: null,
        currentSessionId: null,
        currentPhase: null,
      }),
      getEmbeddingsDiagnostics: () => ({
        mode: 'disabled' as const,
        presetId: null,
        providerKind: null,
        modelId: null,
        runtimeState: 'unavailable' as const,
        usingFallback: false,
        lastError: null,
      }),
      getSettings: () => ({
        v: 1,
        enabled: true,
        enabledAtMs: 1,
        indexMode: 'hints' as const,
        defaultScope: { type: 'global' as const },
        backfillPolicy: 'new_only' as const,
        deleteOnDisable: false,
        coveragePolicy: { type: 'full' as const },
        contentPolicy: {
          includeUserMessages: true,
          includeAssistantMessages: true,
          includeReasoning: true,
          includeToolSummaries: false,
          includeToolOutputs: false,
        },
        hints: {
          summarizerBackendId: 'claude',
          summarizerModelId: 'default',
          summarizerPermissionMode: 'no_tools',
          windowSizeMessages: 40,
          targetShardMessages: 16,
          minShardMessages: 1,
          targetShardChars: 8_000,
          maxShardChars: 12_000,
          maxSummaryChars: 500,
          paddingMessagesOnVerify: 0,
          updateMode: 'onIdle' as const,
          idleDelayMs: 15_000,
          maxRunsPerHour: 12,
          failureBackoffBaseMs: 60_000,
          failureBackoffMaxMs: 3_600_000,
          maxShardsPerSession: 250,
          maxKeywords: 12,
          maxEntities: 12,
          maxDecisions: 12,
        },
        deep: {
          recentDays: 30,
          maxChunkChars: 12_000,
          maxChunkMessages: 50,
          targetChunkMessages: 50,
          minChunkMessages: 5,
          includeAssistantAcpMessage: true,
          includeToolOutput: false,
          candidateLimit: 200,
          previewChars: 800,
          failureBackoffBaseMs: 60_000,
          failureBackoffMaxMs: 3_600_000,
        },
        embeddings: {
          mode: 'disabled' as const,
          presetId: 'balanced' as const,
          custom: null,
          blend: {
            ftsWeight: 0.7,
            embeddingWeight: 0.3,
          },
        },
        budgets: { maxDiskMbLight: 250, maxDiskMbDeep: 1_500 },
        worker: {
          tickIntervalMs: 10_000,
          inventoryRefreshIntervalMs: 60_000,
          maxSessionsPerTick: 2,
          sessionListPageLimit: 50,
        },
      }),
      getTier1DbPath: () => null,
      getDeepDbPath: () => null,
    };

    registerMachineMemoryRpcHandlers({ rpcHandlerManager, memoryWorker });

    const handler = handlers.get(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW);
    expect(handler).toBeTruthy();

    const result = await handler!({
      v: 1,
      sessionId: 'sess-memory-window',
      seqFrom: 1,
      seqTo: 1,
    });

    const window = result as { snippets: Array<{ text: string }> };
    expect(window.snippets).toHaveLength(1);
    expect(window.snippets[0]!.text).toContain('handler reasoning sentinel');
  });
});
