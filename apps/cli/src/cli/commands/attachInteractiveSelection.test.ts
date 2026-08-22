import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildAcpConfiguredBackendV1 } from '@happier-dev/protocol';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildAttachSelectionModel, formatAttachIneligibilityFooter } from './attachInteractiveSelection';

const sessionHostBridgeState = vi.hoisted(() => ({
  evaluateAttachEligibility: vi.fn(),
  resolveExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    evaluateAttachEligibility: sessionHostBridgeState.evaluateAttachEligibility,
    resolveExecutionSurfaces: sessionHostBridgeState.resolveExecutionSurfaces,
  }),
}));

afterEach(() => {
  sessionHostBridgeState.evaluateAttachEligibility.mockReset();
  sessionHostBridgeState.resolveExecutionSurfaces.mockReset();
});

describe('formatAttachIneligibilityFooter', () => {
  it('returns null when there are no ineligible rows', () => {
    expect(formatAttachIneligibilityFooter({
      dominantCategory: null,
      attachableCount: 1,
      ineligibleCount: 0,
      effectiveSessionTmux: { useTmux: true, source: 'global' },
    })).toBeNull();
  });

  it('suggests enabling tmux when sessions were started outside tmux while tmux is disabled', () => {
    const text = formatAttachIneligibilityFooter({
      dominantCategory: 'started_outside_tmux',
      attachableCount: 0,
      ineligibleCount: 2,
      effectiveSessionTmux: { useTmux: false, source: 'machine-override' },
    });

    expect(text).toMatch(/started outside tmux/i);
    expect(text).toMatch(/Spawn Sessions in Tmux/i);
    expect(text).toMatch(/on this computer/i);
  });

  it('keeps remote provider-attach rows from configured plugin backends even when the agent id is not static', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_plugin_remote_attach_1',
      active: true,
      encryptionMode: 'plain',
      updatedAt: 123,
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        flavor: 'acp:plugin-review-bot',
        acpConfiguredBackendV1: buildAcpConfiguredBackendV1({
          updatedAt: 1,
          backendId: 'plugin-review-bot',
          title: 'Plugin Review Bot',
        }),
        path: '/repo',
      }),
    });
    const metadata = {
      machineId: 'machine-remote',
      flavor: 'acp:plugin-review-bot',
      path: '/repo',
      acpConfiguredBackendV1: buildAcpConfiguredBackendV1({
        updatedAt: 1,
        backendId: 'plugin-review-bot',
        title: 'Plugin Review Bot',
      }),
    };
    sessionHostBridgeState.evaluateAttachEligibility.mockResolvedValue({
      eligible: true,
      agentId: 'claude',
      attachStrategy: 'provider_attach',
      attachScope: 'remote',
      metadata,
    });
    const evaluateAvailability = vi.fn(async () => ({
      available: false as const,
      reasonCode: 'agent_unavailable' as const,
      retryable: true,
      safeMessage: 'Provider attach target is unreachable.',
    }));
    sessionHostBridgeState.resolveExecutionSurfaces.mockResolvedValue({
      terminalRuntime: null,
      externalSession: null,
      attach: {
        evaluateAvailability,
        attach: vi.fn(),
      },
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const model = await buildAttachSelectionModel({
      accountEncryptionMode: 'plain',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      currentMachineId: 'machine-local',
      currentMachineHost: null,
      fetchSessionsPageFn: async () => ({
        sessions: [rawSession],
        nextCursor: null,
        hasNext: false,
      }),
      readTerminalAttachmentInfoFn: async () => null,
      isTmuxAvailableFn: async () => true,
    });

    expect(model.rows).toEqual([
      expect.objectContaining({
        sessionId: 'sid_plugin_remote_attach_1',
        annotation: 'remote',
        probeable: true,
        disabled: true,
      }),
    ]);
    await expect(model.probeSessionIdFn('sid_plugin_remote_attach_1')).resolves.toEqual({
      reachable: false,
      reason: 'Provider attach target is unreachable.',
    });
    expect(evaluateAvailability).toHaveBeenCalledWith({
      operation: 'attach',
      sessionId: 'sid_plugin_remote_attach_1',
      metadata,
      depth: 'live',
    });
  });

  it('explains same-host machine-id mismatches without calling them another physical machine', async () => {
    const metadata = {
      machineId: 'machine-from-ui',
      flavor: 'codex',
      host: 'leeroy-mbp',
      path: '/repo',
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_same_host_different_machine_id',
      active: true,
      encryptionMode: 'plain',
      updatedAt: 456,
      metadata: JSON.stringify(metadata),
    });
    sessionHostBridgeState.evaluateAttachEligibility.mockResolvedValue({
      eligible: false,
      agentId: 'codex',
      reasonCode: 'not_current_machine',
      reason: 'Session belongs to another machine and cannot be attached from this computer.',
      metadata,
    });

    const model = await buildAttachSelectionModel({
      accountEncryptionMode: 'plain',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      currentMachineId: 'machine-from-cli',
      currentMachineHost: 'leeroy-mbp',
      fetchSessionsPageFn: async () => ({
        sessions: [rawSession],
        nextCursor: null,
        hasNext: false,
      }),
      readTerminalAttachmentInfoFn: async () => null,
      isTmuxAvailableFn: async () => true,
    });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].disabled).toBe(true);
    expect(model.rows[0].annotation).toMatch(/machine identity/i);
    expect(model.rows[0].disabledReason).toMatch(/machine identity/i);
    expect(model.hint.dominantCategory).toBe('machine_identity_mismatch');

    const footer = formatAttachIneligibilityFooter(model.hint);
    expect(footer).toMatch(/machine identity/i);
    expect(footer).not.toMatch(/other machines/i);
  });
});
