import { describe, expect, it, vi } from 'vitest';
import type { PluginSourceCustodyV1, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { createTargetActionCurrentIntentAdapter, targetActionApprovalMatchesCurrentIntent } from './targetActionCurrentIntent';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';

const developmentCustody = { kind: 'development', registeredRootId: 'root-7' } as const;

describe('target action current-intent adapter', () => {
  it('observes a decision from another device through its artifact invalidation subscription', async () => {
    const stored: { request: TargetActionApprovalRequestV1 | null } = { request: null };
    let onChange = () => {};
    let subscribedArtifactId = '';
    const dispose = vi.fn();
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => { stored.request = request; return { artifactId: 'approval-other-device' }; },
      read: async () => stored.request,
      subscribeChanges: (artifactId, change) => {
        subscribedArtifactId = artifactId;
        onChange = change;
        return { dispose };
      },
    });
    const pending = adapter({
      action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7', sourceCustody: developmentCustody, dangerLevel: 'destructive', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 }, policyFingerprint: 'b'.repeat(64), confirmation: { title: 'Run action' } },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    });
    await Promise.resolve();
    expect(subscribedArtifactId).toBe('approval-other-device');
    if (!stored.request) throw new Error('approval_not_created');
    stored.request = { ...stored.request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } };
    onChange();
    await expect(pending).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64), artifactId: 'approval-other-device' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('persists the exact subject and admits only the matching durable approval', async () => {
    let stored: any;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => { stored = request; return { artifactId: 'approval-1' }; },
      read: async () => ({ ...stored, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } }),
    });
    await expect(adapter({
      action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7', sourceCustody: developmentCustody, dangerLevel: 'destructive', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 }, policyFingerprint: 'b'.repeat(64), confirmation: { title: 'Run action' } },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64), artifactId: 'approval-1' });
    expect(stored).toMatchObject({ kind: 'plugin_target_action', qualifiedActionId: 'acme.alpha/actions/run', sourceCustody: developmentCustody, policyFingerprint: 'b'.repeat(64) });
    expect(stored).not.toHaveProperty('occurrenceId');
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
        localId: 'automations/reset-history-gap', occurrenceId: '7', sourceCustody: developmentCustody, dangerLevel: 'writesLocal',
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
    })).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64), artifactId: 'approval-confirmation-1' });

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
        qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7', sourceCustody: developmentCustody,
        dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 },
        policyFingerprint: 'b'.repeat(64), approvalRequiredByActionSettings: true,
      },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64), artifactId: 'approval-settings-required-1' });

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
        qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7', sourceCustody: developmentCustody,
        dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 },
        policyFingerprint: 'b'.repeat(64), approvalRequiredByActionSettings: true,
      },
      fingerprint: 'a'.repeat(64), surface: 'cli', invocationSurface: 'api',
      replayPlacement: {
        serverId: 'server-1',
        machineId: 'machine-1',
        defaultSessionId: 'session-1',
      },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'server-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        machineId: 'machine-1',
        sessionId: 'session-1',
        actionId: 'action.invoke',
        requestId: 'request-1',
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
      executionOriginV1: expect.objectContaining({
        actionId: 'action.invoke',
        requestId: 'request-1',
      }),
    });
  });

  it('rejects a durable decision whose subject fields changed under the same fingerprint', async () => {
    let stored: any;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => { stored = request; return { artifactId: 'approval-2' }; },
      read: async () => ({
        ...stored, sourceCustody: { kind: 'development', registeredRootId: 'root-8' }, status: 'approved', updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    });
    await expect(adapter({
      action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7', sourceCustody: developmentCustody, dangerLevel: 'destructive', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 }, policyFingerprint: 'b'.repeat(64), confirmation: { title: 'Run action' } },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
  });

  it('fails closed when the durable confirmation presentation is changed or canceled', async () => {
    let stored: any;
    const action = {
      qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7', sourceCustody: developmentCustody,
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

  it.each([
    {
      label: 'managed',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-7', installSource: 'npm' },
      staleSourceCustody: { kind: 'managed', immutableGenerationId: 'generation-8', installSource: 'npm' },
    },
    {
      label: 'bundled',
      sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-root-7' } },
      staleSourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-root-8' } },
    },
    {
      label: 'development',
      sourceCustody: developmentCustody,
      staleSourceCustody: { kind: 'development', registeredRootId: 'root-8' },
    },
  ] satisfies ReadonlyArray<Readonly<{
    label: string;
    sourceCustody: PluginSourceCustodyV1;
    staleSourceCustody: PluginSourceCustodyV1;
  }>>)('binds $label durable replay to source custody, never the live occurrence', async ({ sourceCustody, staleSourceCustody }) => {
    let stored: TargetActionApprovalRequestV1 | undefined;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => {
        stored = request;
        return { artifactId: 'approval-api-source-custody' };
      },
      read: async () => null,
    });
    const currentIntent: Parameters<typeof adapter>[0] = {
      action: {
        qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run',
        occurrenceId: 'occurrence-7', sourceCustody, dangerLevel: 'safe' as const,
        scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 },
        policyFingerprint: 'b'.repeat(64), approvalRequiredByActionSettings: true as const,
      },
      fingerprint: 'a'.repeat(64), surface: 'cli', invocationSurface: 'api',
      replayPlacement: { serverId: 'server-1', machineId: 'machine-1' },
      executionOriginV1: {
        v: 1 as const, authority: 'account_automation' as const, surface: 'api' as const,
        caller: { kind: 'host' as const }, serverId: 'server-1', accountId: 'account-1',
        principalId: 'principal-1', credentialId: 'credential-1', machineId: 'machine-1',
        actionId: 'action.invoke', requestId: 'request-1',
      },
    };

    await expect(adapter(currentIntent)).resolves.toEqual({
      status: 'deferred', artifactId: 'approval-api-source-custody',
    });
    expect(stored?.sourceCustody).toEqual(sourceCustody);
    expect(stored).not.toHaveProperty('occurrenceId');
    if (!stored) throw new Error('Expected the deferred approval to be persisted');
    expect(targetActionApprovalMatchesCurrentIntent(stored, {
      ...currentIntent,
      action: { ...currentIntent.action, occurrenceId: 'occurrence-8' },
    })).toBe(true);
    expect(targetActionApprovalMatchesCurrentIntent(stored, {
      ...currentIntent,
      action: { ...currentIntent.action, sourceCustody: staleSourceCustody },
    })).toBe(false);
  });
});
