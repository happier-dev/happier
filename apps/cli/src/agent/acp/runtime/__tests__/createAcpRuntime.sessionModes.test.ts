import { describe, expect, it, vi } from 'vitest';

import type { EventMessage } from '@/agent/core/AgentMessage';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createBasicSessionClient, createBasicSessionClientWithOverrides, createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';

describe('createAcpRuntime (session modes)', () => {
  it('forwards compact context requests as raw provider commands without imposing a response timeout', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const waitForResponseComplete = vi.fn(async () => undefined);
    const backend = createFakeAcpRuntimeBackend({ sendPrompt, waitForResponseComplete });
    const session = createBasicSessionClient();

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.compactContext('/compact keep only current task');

    expect(sendPrompt).toHaveBeenCalledWith('sess_main', '/compact keep only current task');
    expect(waitForResponseComplete).toHaveBeenCalledTimes(1);
    expect(waitForResponseComplete).toHaveBeenCalledWith(undefined);
  });

  it('prefers native ACP backend compact hooks when available', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const compactContext = vi.fn(async () => undefined);
    const backend = createFakeAcpRuntimeBackend({ sendPrompt, compactContext });
    const session = createBasicSessionClient();

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.compactContext('/compact keep only current task');

    expect(compactContext).toHaveBeenCalledWith('sess_main', '/compact keep only current task');
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('forwards structured context compaction provider events into ACP transcript data', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: unknown[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'completed',
        lifecycleId: 'compact_1',
        provider: 'pi',
        source: 'provider-event',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
      },
    });

    expect(sent).toEqual([
      {
        type: 'context-compaction',
        phase: 'completed',
        lifecycleId: 'compact_1',
        provider: 'pi',
        source: 'provider-event',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
      },
    ]);
  });

  it('commits typed connected-service runtime-auth recovery backend events as session events', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sentEvents: unknown[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendSessionEvent: (event: unknown) => {
        sentEvents.push(event);
      },
    } as any);

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'connected-service-runtime-auth-recovery',
      payload: {
        type: 'connected-service-runtime-auth-recovery',
        status: 'retry_scheduled',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team-pool',
        attempt: 2,
        nextRetryAtMs: 1_900_000_000_000,
        terminal: false,
        diagnostic: {
          code: 'recovery_retry_scheduled',
          failurePhase: 'runtime_auth_recovery',
          source: 'runtime_auth_recovery',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team-pool',
          retryable: true,
          suggestedActions: ['retry'],
        },
      },
    } satisfies EventMessage);

    expect(sentEvents).toEqual([
      expect.objectContaining({
        type: 'connected-service-runtime-auth-recovery',
        status: 'retry_scheduled',
        serviceId: 'openai-codex',
        diagnostic: expect.objectContaining({
          source: 'runtime_auth_recovery',
          failurePhase: 'runtime_auth_recovery',
        }),
      }),
    ]);
  });

  it('drops malformed connected-service runtime-auth recovery backend events', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sentEvents: unknown[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendSessionEvent: (event: unknown) => {
        sentEvents.push(event);
      },
    } as any);

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'connected-service-runtime-auth-recovery',
      payload: {
        type: 'connected-service-runtime-auth-recovery',
        status: 'retry_scheduled',
        serviceId: 'openai-codex',
        diagnostic: {
          code: 'recovery_retry_scheduled',
          failurePhase: 'runtime_auth_recovery',
          source: 'manual_auth_switch',
          retryable: true,
          suggestedActions: ['retry'],
        },
      },
    } as EventMessage);

    expect(sentEvents).toEqual([]);
  });

  it('normalizes ACP-carried context compaction compatibility aliases before forwarding', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: unknown[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'detected',
        tokensBefore: 12,
        tokensAfter: 4,
        errorMessage: 'safe preview',
        retrying: true,
      },
    });

    expect(sent).toEqual([
      {
        type: 'context-compaction',
        phase: 'completed',
        source: 'transcript-inference',
        tokenCountBefore: 12,
        tokenCountAfter: 4,
        sanitizedErrorPreview: 'safe preview',
      },
    ]);
  });

  it('publishes ACP session modes into session metadata', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, metadataUpdates, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    const modesEvent: EventMessage = {
      type: 'event',
      name: 'session_modes_state',
      payload: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan', description: 'Think first' },
        ],
      },
    };
    backend.emit(modesEvent);

    expect(metadataUpdates.length).toBeGreaterThan(0);
    const metadata: Metadata = getMetadata();
    expect(metadata.sessionModesV1).toMatchObject({
      v: 1,
      provider: 'codex',
      currentModeId: 'code',
      availableModes: [
        { id: 'code', name: 'Code' },
        { id: 'plan', name: 'Plan', description: 'Think first' },
      ],
    });
    expect(typeof metadata.sessionModesV1?.updatedAt).toBe('number');
    expect(metadata.acpSessionModesV1).toMatchObject({
      v: 1,
      provider: 'codex',
      currentModeId: 'code',
      availableModes: [
        { id: 'code', name: 'Code' },
        { id: 'plan', name: 'Plan', description: 'Think first' },
      ],
    });
    expect(typeof metadata.acpSessionModesV1?.updatedAt).toBe('number');
  });

  it('preserves available modes on current mode updates from canonical metadata', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata({
        sessionModesV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 1,
          currentModeId: 'code',
          availableModes: [
            { id: 'code', name: 'Code' },
            { id: 'plan', name: 'Plan', description: 'Think first' },
          ],
        },
      }),
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'current_mode_update',
      payload: {
        currentModeId: 'plan',
      },
    });

    const metadata: Metadata = getMetadata();
    expect(metadata.sessionModesV1).toMatchObject({
      currentModeId: 'plan',
      availableModes: [
        { id: 'code', name: 'Code' },
        { id: 'plan', name: 'Plan', description: 'Think first' },
      ],
    });
    expect(metadata.acpSessionModesV1).toMatchObject({
      currentModeId: 'plan',
      availableModes: [
        { id: 'code', name: 'Code' },
        { id: 'plan', name: 'Plan', description: 'Think first' },
      ],
    });
  });

  it('publishes session modes derived from ACP mode config options', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'config_options_state',
      payload: {
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'ask',
            options: [
              { value: 'ask', name: 'Ask' },
              {
                name: 'Advanced',
                options: [
                  { value: 'plan', name: 'Plan', description: 'Think first' },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(getMetadata().sessionModesV1).toMatchObject({
      v: 1,
      provider: 'cursor',
      currentModeId: 'ask',
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'plan', name: 'Plan', description: 'Think first' },
      ],
    });
    expect(getMetadata().acpSessionModesV1).toMatchObject({
      currentModeId: 'ask',
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'plan', name: 'Plan', description: 'Think first' },
      ],
    });
  });

  it('delegates setSessionMode to the backend when supported', async () => {
    let lastSet: { sessionId: string; modeId: string } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionMode(sessionId: string, modeId: string) {
        lastSet = { sessionId, modeId };
      },
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionMode('plan');

    expect(lastSet).toEqual({ sessionId: 'sess_main', modeId: 'plan' });
  });

  it('uses the mode config option directly for providers that require config-option mode switching', async () => {
    let modeSetCalls = 0;
    let lastSetConfig: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionMode() {
        modeSetCalls += 1;
      },
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSetConfig = { sessionId, configId, value };
      },
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionMode('plan');

    expect(modeSetCalls).toBe(0);
    expect(lastSetConfig).toEqual({
      sessionId: 'sess_main',
      configId: 'mode',
      value: 'plan',
    });
  });

  it('applies startup metadata mode overrides before deferred pending queue drain', async () => {
    const calls: string[] = [];
    const backend = createFakeAcpRuntimeBackend({
      async startSession() {
        calls.push('start');
        return { sessionId: 'sess_main' };
      },
      async setSessionConfigOption(_sessionId: string, configId: string, value: unknown) {
        calls.push(`config:${configId}:${String(value)}`);
      },
    });
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: {
        ...createTestMetadata(),
        acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' },
      } as Metadata,
    });
    const sessionWithSnapshot = {
      ...session,
      getMetadataSnapshot: getMetadata,
    };

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: sessionWithSnapshot,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      pendingQueue: {
        drainAfterStartOrLoad: true,
        inputConsumer: {
          drainPending: async () => {
            calls.push('drain');
            return { materialized: 0, stoppedReason: 'no_pending' };
          },
        },
        waitForMetadataUpdate: async () => false,
      },
    });

    await runtime.startOrLoad({ deferPendingDrain: true });
    await runtime.drainPendingAfterStartOrLoad();

    expect(calls).toEqual(['start', 'config:mode:plan', 'drain']);
  });

  it('applies explicit startup mode overrides before deferred pending queue drain', async () => {
    const calls: string[] = [];
    const backend = createFakeAcpRuntimeBackend({
      async startSession() {
        calls.push('start');
        return { sessionId: 'sess_main' };
      },
      async setSessionConfigOption(_sessionId: string, configId: string, value: unknown) {
        calls.push(`config:${configId}:${String(value)}`);
      },
    });
    const { session } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      startupOverrides: {
        mode: { modeId: 'plan' },
      },
      pendingQueue: {
        drainAfterStartOrLoad: true,
        inputConsumer: {
          drainPending: async () => {
            calls.push('drain');
            return { materialized: 0, stoppedReason: 'no_pending' };
          },
        },
        waitForMetadataUpdate: async () => false,
      },
    });

    await runtime.startOrLoad({ deferPendingDrain: true });
    await runtime.drainPendingAfterStartOrLoad();

    expect(calls).toEqual(['start', 'config:mode:plan', 'drain']);
  });

  it('rejects setSessionMode before the ACP runtime has started', async () => {
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => createFakeAcpRuntimeBackend(),
    });

    await expect(runtime.setSessionMode('plan')).rejects.toThrow(/ACP session was not started/);
  });
});
