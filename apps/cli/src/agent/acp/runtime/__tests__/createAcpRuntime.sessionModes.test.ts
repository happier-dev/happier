import { describe, expect, it } from 'vitest';

import type { AgentMessage, EventMessage } from '@/agent/core/AgentMessage';
import { createAcpRuntime, type AcpRuntimeBackend } from '../createAcpRuntime';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  createApprovedPermissionHandler,
  createBasicSessionClient,
  createDefaultMetadata,
  createFakeAcpRuntimeBackend,
  createSessionClientWithMetadata,
} from '../createAcpRuntime.testkit';

describe('createAcpRuntime (session modes)', () => {
  it('publishes ACP session modes into session metadata', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, metadataUpdates, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createDefaultMetadata(),
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
      initialMetadata: createDefaultMetadata({
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
    const backend = {
      ...createFakeAcpRuntimeBackend(),
      async setSessionMode(sessionId: string, modeId: string) {
        lastSet = { sessionId, modeId };
      },
    } as AcpRuntimeBackend & { emit: (msg: AgentMessage) => void };

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
});
