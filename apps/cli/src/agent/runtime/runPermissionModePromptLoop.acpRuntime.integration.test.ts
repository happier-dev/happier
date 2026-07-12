import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import * as acpModule from '@/agent/acp';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { openCodeTransport } from '@/backends/opencode/acp/transport';
import { configuration } from '@/configuration';
import type { PermissionMode } from '@/api/types';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createVendorResumeIdMetadataPublisher } from '@/session/metadata/createVendorResumeIdMetadataPublisher';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createPiAcpRuntime } from '@/backends/pi/acp/runtime';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

function writeFakeOpenCodeAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-opencode-acp-agent.mjs');
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
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

        const id = req.id;
        const method = req.method;
        const requestParams = req.params;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, {
            sessionId: 'test-session',
            modes: {
              currentModeId: 'build',
              availableModes: [
                { id: 'build', name: 'Build' },
                { id: 'plan', name: 'Plan' },
              ],
            },
          });
          continue;
        }

        if (method === 'session/prompt') {
          ok(id, {});
          setTimeout(() => {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'test-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'hello' },
                },
              },
            });
          }, 10);
          continue;
        }

        if (method === 'session/set_mode') {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'current_mode_update',
                currentModeId: requestParams?.modeId ?? '',
              },
            },
          });
          ok(id, {});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );
}

describe('runPermissionModePromptLoop with real ACP runtime idle overrides', () => {
  const originalIdleWakePollIntervalMs = configuration.pendingQueueIdleWakePollIntervalMs;

  beforeEach(() => {
    (configuration as any).pendingQueueIdleWakePollIntervalMs = 10;
  });

  afterEach(() => {
    (configuration as any).pendingQueueIdleWakePollIntervalMs = originalIdleWakePollIntervalMs;
  });

  it('applies an ACP session mode override after the first turn becomes idle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-runtime-loop-'));
    const scriptPath = writeFakeOpenCodeAcpAgentScript({ dir });
    const transportHandler = Object.assign(Object.create(openCodeTransport), {
      getIdleTimeout: () => 1,
      getPreToolCallIdleTimeoutMs: () => 1,
      getIdleWithoutAssistantMessageTimeoutMs: () => 1,
      getPostToolCallIdleTimeoutMs: () => 1,
      getPostPromptNoUpdatesTimeoutMs: () => 1,
      getPromptLivenessTimeoutMs: () => 1_000,
    });
    const backend = new AcpBackend({
      agentName: 'opencode',
      cwd: dir,
      command: process.execPath,
      args: [scriptPath],
      transportHandler,
    });

    let metadata: Record<string, unknown> = {
      path: dir,
      host: 'test',
      flavor: 'opencode',
      startedBy: 'terminal',
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    };
    let serverMetadata = metadata;
    let readyCount = 0;
    let shouldExit = false;
    let resolveMetadataWake: ((value: boolean) => void) | null = null;
    let appliedModeId: string | null = null;
    const abortController = new AbortController();

    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    let resolveApplied!: () => void;
    const appliedPromise = new Promise<void>((resolve) => {
      resolveApplied = resolve;
    });

    const maybeResolve = () => {
      const currentModeId =
        typeof (metadata as any)?.acpSessionModesV1?.currentModeId === 'string'
          ? String((metadata as any).acpSessionModesV1.currentModeId)
          : null;
      if (currentModeId !== 'plan') return;
      appliedModeId = currentModeId;
      shouldExit = true;
      abortController.abort();
      resolveApplied();
    };

    const session = {
      sessionId: 'happier-session-1',
      keepAlive() {},
      sendAgentMessage() {},
      async sendAgentMessageCommitted() {},
      async sendUserTextMessageCommitted() {
        return undefined;
      },
      async fetchRecentTranscriptTextItemsForAcpImport() {
        return [];
      },
      async fetchLatestUserPermissionIntentFromTranscript() {
        return null;
      },
      updateMetadata(handler: (prev: typeof metadata) => typeof metadata) {
        metadata = handler(metadata);
        maybeResolve();
      },
      getMetadataSnapshot() {
        return metadata as any;
      },
      async refreshSessionSnapshotFromServerBestEffort() {
        metadata = serverMetadata;
        maybeResolve();
      },
      async ensureMetadataSnapshot() {
        return metadata as any;
      },
      async popPendingMessage() {
        return false;
      },
      waitForMetadataUpdate(abortSignal?: AbortSignal) {
        return new Promise<boolean>((resolveWake) => {
          if (abortSignal?.aborted) {
            resolveWake(false);
            return;
          }
          resolveMetadataWake = resolveWake;
          abortSignal?.addEventListener(
            'abort',
            () => {
              if (resolveMetadataWake === resolveWake) {
                resolveMetadataWake = null;
              }
              resolveWake(false);
            },
            { once: true },
          );
        });
      },
    } as const;

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: dir,
      session: session as any,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend as any,
      sessionIdentity: { kind: 'external-owner' },
    });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'OpenCode',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session: session as any,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode() {},
        reset() {},
      } as any,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session: session as any,
          runtime,
          isStarted,
        }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount !== 1) return;
        serverMetadata = {
          ...metadata,
          acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
        };
        const wake = resolveMetadataWake;
        resolveMetadataWake = null;
        wake?.(true);
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    try {
      await expect(
        Promise.race([
          appliedPromise,
          new Promise((_, reject) =>
            setTimeout(() => {
              reject(
                new Error(
                  `Timed out waiting for ACP session mode override (readyCount=${readyCount}, appliedModeId=${String(appliedModeId)}, metadata=${JSON.stringify(metadata)})`,
                ),
              );
            }, 2_000),
          ),
        ]),
      ).resolves.toBeUndefined();
      expect(appliedModeId).toBe('plan');
    } finally {
      shouldExit = true;
      abortController.abort();
      await loopPromise.catch(() => {});
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fork a successfully resumed provider session when redundant metadata publication would fail', async () => {
    const resumeId = 'qwen-resume-1';
    const identityUpdateMetadata = vi.fn()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce(undefined);
    const session = createMutableApiSessionClientFixture({
      metadata: createTestMetadata({ qwenSessionId: resumeId, permissionMode: 'default' }),
    });
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => session.getMetadataSnapshot(),
      updateMetadata: identityUpdateMetadata,
    });

    let shouldExit = false;
    const abortController = new AbortController();
    const loadSession = vi.fn(async (sessionId: string) => ({ sessionId }));
    const startSession = vi.fn(async () => ({ sessionId: 'qwen-fresh-1' }));
    const backend = {
      loadSession,
      startSession,
      sendPrompt: async () => {
        shouldExit = true;
        abortController.abort();
      },
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    };
    const runtime = createAcpRuntime({
      provider: 'qwen',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionIdentity: { kind: 'persist-bound', persistBound: publisher.persistBound },
    });
    const queue = createModeQueue();
    queue.push({ text: 'continue', localId: 'local-resume-1' }, { permissionMode: 'default' });

    await runPermissionModePromptLoop({
      providerName: 'Qwen',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode() {},
        reset() {},
      } as any,
      runtime,
      createOverrideSynchronizer: () => ({
        syncFromMetadata() {},
        async flushPendingAfterStart() {},
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: resumeId,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(loadSession).toHaveBeenCalledWith(resumeId);
    expect(startSession).not.toHaveBeenCalled();
    expect(identityUpdateMetadata).not.toHaveBeenCalled();
    expect(runtime.getSessionId()).toBe(resumeId);
  });

  it('does not fork a Pi session when a permission-mode restart resumes an already-durable identity', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-pi-resume-publication-'));
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tempRoot;

    let shouldExit = false;
    const abortController = new AbortController();
    const startSession = vi.fn(async () => ({ sessionId: 'pi-session-1' }));
    const loadSession = vi.fn(async (sessionId: string) => ({ sessionId }));
    const createBackend = vi.spyOn(acpModule, 'createCatalogAcpBackend').mockImplementation(async () => ({
      backend: {
        startSession,
        loadSession,
        async sendPrompt(_sessionId: string, message: string) {
          if (message === 'second') {
            shouldExit = true;
            abortController.abort();
          }
        },
        async cancel() {},
        onMessage() {},
        async dispose() {},
      },
    }) as unknown as Awaited<ReturnType<typeof acpModule.createCatalogAcpBackend>>);

    let metadataWriteCount = 0;
    const session = createMutableApiSessionClientFixture({
      metadata: createTestMetadata({
        flavor: 'pi',
        permissionMode: 'default',
        permissionModeUpdatedAt: 0,
      }),
      overrides: {
        rpcHandlerManager: new RpcHandlerManager({
          scopePrefix: 'session-test',
          encryptionKey: new Uint8Array(32),
          encryptionVariant: 'legacy',
          encryptionMode: 'plain',
        }),
      },
    });
    session.updateMetadata = (updater) => {
      metadataWriteCount += 1;
      if (metadataWriteCount === 2) return Promise.reject(new Error('metadata unavailable'));
      const current = session.__getMetadata();
      if (!current) return Promise.reject(new Error('missing metadata fixture'));
      session.__setMetadata(updater(current));
      return Promise.resolve();
    };

    const runtime = createPiAcpRuntime({
      directory: tempRoot,
      machineId: 'machine-1',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => session.getMetadataSnapshot()?.permissionMode ?? 'default',
    });
    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'pi-first' }, { permissionMode: 'default' });
    queue.push({ text: 'second', localId: 'pi-second' }, { permissionMode: 'read-only' });

    try {
      await runPermissionModePromptLoop({
        providerName: 'Pi',
        agentMessageType: 'pi',
        explicitPermissionMode: undefined,
        session,
        messageQueue: queue,
        permissionHandler: createProviderEnforcedPermissionHandler({
          session,
          logPrefix: '[Pi resume publication test]',
        }),
        runtime,
        createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
        messageBuffer: new MessageBuffer(),
        shouldExit: () => shouldExit,
        getAbortSignal: () => abortController.signal,
        keepAlive() {},
        setThinking() {},
        sendReady() {},
        currentPermissionModeUpdatedAt: 0,
        setCurrentPermissionMode() {},
        setCurrentPermissionModeUpdatedAt() {},
        formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
      });

      expect(createBackend).toHaveBeenCalledTimes(2);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(loadSession).toHaveBeenCalledTimes(1);
      expect(loadSession).toHaveBeenCalledWith('pi-session-1');
      expect(metadataWriteCount).toBe(1);
      expect(runtime.getSessionId()).toBe('pi-session-1');
    } finally {
      await runtime.reset().catch(() => {});
      createBackend.mockRestore();
      if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
