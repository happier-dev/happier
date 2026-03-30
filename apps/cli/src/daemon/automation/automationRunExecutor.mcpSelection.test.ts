import { describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import { executeClaimedRun, type ClaimableRunPayload } from './automationRunExecutor';

function buildClaimedRun(overrides: {
  run?: Partial<ClaimableRunPayload['run']>;
  automation?: Partial<ClaimableRunPayload['automation']>;
} = {}): ClaimableRunPayload {
  const now = 0;

  return {
    run: {
      id: 'run-1',
      automationId: 'automation-1',
      state: 'queued',
      scheduledAt: now,
      dueAt: now,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      claimedByMachineId: null,
      leaseExpiresAt: null,
      attempt: 1,
      summaryCiphertext: null,
      errorCode: null,
      errorMessage: null,
      producedSessionId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides.run,
    },
    automation: {
      id: 'automation-1',
      name: 'Nightly',
      enabled: true,
      targetType: 'new_session',
      templateCiphertext: JSON.stringify({
        kind: 'happier_automation_template_plain_v1',
        payload: { directory: '/tmp/project' },
      }),
      ...overrides.automation,
    },
  };
}

describe('executeClaimedRun (mcpSelection)', () => {
  it('passes mcpSelection + connectedServices + transcriptStorage through to spawnSession for new-session automations', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess_1' }));
    const claimClient = {
      startRun: vi.fn(async () => {}),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      claimed: buildClaimedRun({
        automation: {
          id: 'automation-1',
          name: 'Nightly',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: {
              directory: '/tmp/project',
              agent: 'codex',
              mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: ['server-disabled'],
              },
              connectedServices: {
                v: 1,
                bindingsByServiceId: {
                  anthropic: { source: 'connected', profileId: 'work' },
                },
              },
              transcriptStorage: 'direct',
            },
          }),
        },
      }),
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-portable'],
        forceExcludeServerIds: ['server-disabled'],
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', profileId: 'work' },
        },
      },
      transcriptStorage: 'direct',
    }));
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      producedSessionId: 'sess_1',
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('passes mcpSelection + connectedServices + transcriptStorage through to spawnSession for existing-session automations', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess_existing' }));
    const claimClient = {
      startRun: vi.fn(async () => {}),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      claimed: buildClaimedRun({
        run: { id: 'run-2' },
        automation: {
          id: 'automation-1',
          name: 'Nightly existing',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            existingSessionId: 'sess-parent',
            payload: {
              directory: '/tmp/project',
              existingSessionId: 'sess-parent',
              mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: ['server-disabled'],
              },
              connectedServices: {
                v: 1,
                bindingsByServiceId: {
                  anthropic: { source: 'connected', profileId: 'work' },
                },
              },
              transcriptStorage: 'direct',
            },
          }),
        },
      }),
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/project',
      existingSessionId: 'sess-parent',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-portable'],
        forceExcludeServerIds: ['server-disabled'],
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', profileId: 'work' },
        },
      },
      transcriptStorage: 'direct',
    }));
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-2',
      producedSessionId: 'sess_existing',
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });
});
