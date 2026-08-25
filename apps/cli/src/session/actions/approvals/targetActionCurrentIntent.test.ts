import { describe, expect, it, vi } from 'vitest';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';
import { getSharedBlockingApprovalCoordinator } from './blockingApprovalCoordinator';

describe('target action current-intent adapter', () => {
  it('persists the exact subject and admits only the matching durable approval', async () => {
    let stored: any;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => { stored = request; return { artifactId: 'approval-1' }; },
      read: async () => ({ ...stored, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } }),
    });
    await expect(adapter({
      action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7', dangerLevel: 'destructive', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 }, policyFingerprint: 'b'.repeat(64), confirmation: { title: 'Run action' } },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64) });
    expect(stored).toMatchObject({ kind: 'plugin_target_action', qualifiedActionId: 'acme.alpha/actions/run', generation: '7', policyFingerprint: 'b'.repeat(64) });
  });

  it('persists only the exact Action confirmation presentation for one durable prompt', async () => {
    let stored: any;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => {
        stored = request;
        const approved: TargetActionApprovalRequestV1 = {
          ...request,
          status: 'approved',
          updatedAtMs: 2,
          decision: { kind: 'approve', decidedAtMs: 2 },
        };
        stored = approved;
        queueMicrotask(() => getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({
          artifactId: 'approval-confirmation-1',
          request: approved,
        }));
        return { artifactId: 'approval-confirmation-1' };
      },
      read: async () => stored,
    });

    await expect(adapter({
      action: {
        qualifiedId: 'acme.github/actions/automations/reset-history-gap', pluginId: 'acme.github',
        localId: 'automations/reset-history-gap', generation: '7', dangerLevel: 'writesLocal',
        scopes: ['global'], surfaces: ['ui'], hostAccess: [], input: { automationId: 'automation-1', secret: 'must-not-render' },
        policyFingerprint: 'b'.repeat(64),
        confirmation: {
          title: { key: 'automation.historyGapReset.title', fallback: 'Start a new baseline' },
          body: {
            key: 'automation.historyGapReset.body',
            fallback: 'Events in the history gap are not replayed.',
          },
        },
      },
      fingerprint: 'a'.repeat(64), surface: 'ui',
    })).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64) });

    expect(stored).toMatchObject({
      summary: 'Start a new baseline',
      detail: 'Events in the history gap are not replayed.',
    });
    expect(stored.detail).not.toContain('must-not-render');
  });

  it('uses the existing durable approval path for Action-settings approval without inventing plugin confirmation', async () => {
    let stored: TargetActionApprovalRequestV1 | undefined;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => {
        const approved: TargetActionApprovalRequestV1 = {
          ...request,
          status: 'approved',
          updatedAtMs: 2,
          decision: { kind: 'approve', decidedAtMs: 2 },
        };
        stored = approved;
        queueMicrotask(() => getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({
          artifactId: 'approval-settings-required-1',
          request: approved,
        }));
        return { artifactId: 'approval-settings-required-1' };
      },
      read: async () => stored ?? null,
    });

    await expect(adapter({
      action: {
        qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7',
        dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 },
        policyFingerprint: 'b'.repeat(64), approvalRequiredByActionSettings: true,
      },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64) });

    expect(stored).toMatchObject({
      qualifiedActionId: 'acme.alpha/actions/run',
      summary: 'Action approval required',
    });
    expect(stored).not.toHaveProperty('detail');
  });

  it('returns the created artifact immediately for an API Action-settings approval', async () => {
    let stored: TargetActionApprovalRequestV1 | undefined;
    const read = vi.fn(async () => stored ?? null);
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => {
        stored = request;
        return { artifactId: 'approval-api-required-1' };
      },
      read,
    });

    await expect(adapter({
      action: {
        qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7',
        dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 },
        policyFingerprint: 'b'.repeat(64), approvalRequiredByActionSettings: true,
      },
      fingerprint: 'a'.repeat(64), surface: 'cli', invocationSurface: 'api',
      replayPlacement: {
        serverId: 'server-1',
        machineId: 'machine-1',
        defaultSessionId: 'session-1',
      },
    })).resolves.toEqual({
      status: 'deferred',
      artifactId: 'approval-api-required-1',
    });
    expect(read).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      replayPlacement: {
        serverId: 'server-1',
        machineId: 'machine-1',
        defaultSessionId: 'session-1',
      },
    });
  });

  it('rejects a durable decision whose subject fields changed under the same fingerprint', async () => {
    let stored: any;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => { stored = request; return { artifactId: 'approval-2' }; },
      read: async () => ({
        ...stored, generation: '8', status: 'approved', updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    });
    await expect(adapter({
      action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7', dangerLevel: 'destructive', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 }, policyFingerprint: 'b'.repeat(64), confirmation: { title: 'Run action' } },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
  });

  it('fails closed when the durable confirmation presentation is changed or canceled', async () => {
    let stored: any;
    const action = {
      qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7',
      dangerLevel: 'destructive' as const, scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 },
      policyFingerprint: 'b'.repeat(64), confirmation: { title: 'Delete the workspace', body: 'This cannot be undone.' },
    };
    const changed = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => {
        stored = request;
        const approved: TargetActionApprovalRequestV1 = {
          ...request,
          detail: 'A different disclosure.',
          status: 'approved',
          updatedAtMs: 2,
          decision: { kind: 'approve', decidedAtMs: 2 },
        };
        stored = approved;
        queueMicrotask(() => getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({
          artifactId: 'approval-detail-changed',
          request: approved,
        }));
        return { artifactId: 'approval-detail-changed' };
      },
      read: async () => stored,
    });
    await expect(changed({ action, fingerprint: 'a'.repeat(64), surface: 'cli' })).resolves.toEqual({
      status: 'unavailable', code: 'plugin_action_current_intent_mismatch',
    });

    const canceled = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => {
        stored = { ...request, status: 'canceled', updatedAtMs: 2 };
        queueMicrotask(() => getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({
          artifactId: 'approval-canceled',
          request: stored,
        }));
        return { artifactId: 'approval-canceled' };
      },
      read: async () => stored,
    });
    await expect(canceled({ action, fingerprint: 'c'.repeat(64), surface: 'cli' })).resolves.toEqual({
      status: 'rejected', code: 'plugin_action_current_intent_rejected',
    });
  });
});
