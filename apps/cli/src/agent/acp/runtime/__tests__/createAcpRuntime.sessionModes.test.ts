import { describe, expect, it, vi } from 'vitest';

import type { EventMessage } from '@/agent/core/AgentMessage';
import { createAcpRuntime } from '../createAcpRuntime';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createBasicSessionClient, createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';

describe('createAcpRuntime (session modes)', () => {
  it('rejects compact context requests instead of forwarding raw provider commands when no native hook exists', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const backend = createFakeAcpRuntimeBackend({ sendPrompt });
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
    const runtimeWithCompaction = runtime as typeof runtime & { compactContext?: (command: string) => Promise<void> };
    expect(typeof runtimeWithCompaction.compactContext).toBe('function');
    await expect(runtimeWithCompaction.compactContext?.('/compact keep only current task')).rejects.toThrow(
      'does not support context compaction',
    );

    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('prefers native ACP backend compact hooks when available', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const compactContext = vi.fn(async () => undefined);
    const backend = Object.assign(createFakeAcpRuntimeBackend({ sendPrompt }), {
      compactContext,
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
    const runtimeWithCompaction = runtime as typeof runtime & { compactContext?: (command: string) => Promise<void> };
    expect(typeof runtimeWithCompaction.compactContext).toBe('function');
    await runtimeWithCompaction.compactContext?.('/compact keep only current task');

    expect(compactContext).toHaveBeenCalledWith('sess_main', '/compact keep only current task');
    expect(sendPrompt).not.toHaveBeenCalled();
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
