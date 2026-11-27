import { describe, expect, it } from 'vitest';
import { HealthCheckSourceConfigV1Schema } from '../../deployments/healthCheckSourceV1.js';
import {
  isAuthorizedPostSummaryTriggerV1,
  resolveGithubPostSummaryTargetV1,
  supportsWorkflowTriggerPostSummaryV1,
} from './workflowTriggerPostSummaryV1.js';

describe('workflowTriggerPostSummaryV1 (Q11)', () => {
  it('authorizes GitHub issue and PR triggers and rejects internal Task, schedule, push, and session triggers', () => {
    expect(isAuthorizedPostSummaryTriggerV1({
      kind: 'pluginEvent',
      eventRef: { pluginId: 'happier.scm.github', localId: 'automation/issue-labeled-v1' },
    })).toBe(true);
    expect(isAuthorizedPostSummaryTriggerV1({
      kind: 'pluginEvent',
      eventRef: { pluginId: 'happier.scm.github', localId: 'automation/pull-request-opened-v1' },
    })).toBe(true);
    expect(isAuthorizedPostSummaryTriggerV1({
      kind: 'pluginEvent',
      eventRef: { pluginId: 'happier.scm.github', localId: 'automation/pull-request-checks-failed-v1' },
    })).toBe(true);

    // Pure internal Task triggers have no authorized external destination.
    expect(isAuthorizedPostSummaryTriggerV1({
      kind: 'pluginEvent',
      eventRef: { pluginId: 'happier.triage', localId: 'task-labeled' },
    })).toBe(false);
    expect(isAuthorizedPostSummaryTriggerV1({
      kind: 'pluginEvent',
      eventRef: { pluginId: 'happier.triage', localId: 'task-ready' },
    })).toBe(false);
    expect(isAuthorizedPostSummaryTriggerV1({
      kind: 'pluginEvent',
      eventRef: { pluginId: 'happier.scm.github', localId: 'automation/push-v1' },
    })).toBe(false);
    expect(isAuthorizedPostSummaryTriggerV1({ kind: 'schedule' })).toBe(false);
    expect(isAuthorizedPostSummaryTriggerV1({ kind: 'sessionLifecycle' })).toBe(false);

    expect(supportsWorkflowTriggerPostSummaryV1([
      { kind: 'pluginEvent', eventRef: { pluginId: 'happier.triage', localId: 'task-labeled' } },
      { kind: 'schedule' },
    ])).toBe(false);
    expect(supportsWorkflowTriggerPostSummaryV1([
      { kind: 'pluginEvent', eventRef: { pluginId: 'happier.triage', localId: 'task-labeled' } },
      { kind: 'pluginEvent', eventRef: { pluginId: 'happier.scm.github', localId: 'automation/issue-opened-v1' } },
    ])).toBe(true);
  });

  it('resolves exact GitHub comment targets for issue and PR events and returns null for internal Task events', () => {
    expect(resolveGithubPostSummaryTargetV1({
      eventRef: { pluginId: 'happier.scm.github', localId: 'automation/issue-labeled-v1' },
      sourceInstanceId: 'github-inst-1',
      payload: {
        repository: { repositoryId: '4242', nameWithOwner: 'happier-dev/happier' },
        issue: { id: '99', number: 123, title: 'Fix bug' },
      },
    })).toEqual({
      pluginId: 'happier.scm.github',
      actionLocalId: 'github/comment/create',
      sourceInstanceId: 'github-inst-1',
      localRef: { kindId: 'issue', collisionScope: 'github:4242', entryId: '123' },
      routingToken: 'happier-dev/happier',
    });

    expect(resolveGithubPostSummaryTargetV1({
      eventRef: { pluginId: 'happier.scm.github', localId: 'automation/pull-request-opened-v1' },
      sourceInstanceId: 'github-inst-1',
      payload: {
        repository: { repositoryId: '4242', nameWithOwner: 'happier-dev/happier' },
        pullRequest: { id: '101', number: 456, title: 'Add feature' },
      },
    })).toEqual({
      pluginId: 'happier.scm.github',
      actionLocalId: 'github/comment/create',
      sourceInstanceId: 'github-inst-1',
      localRef: { kindId: 'pull-request', collisionScope: 'github:4242', entryId: '456' },
      routingToken: 'happier-dev/happier',
    });

    expect(resolveGithubPostSummaryTargetV1({
      eventRef: { pluginId: 'happier.triage', localId: 'task-labeled' },
      sourceInstanceId: 'triage-1',
      payload: { task: { taskId: 'task-1' } },
    })).toBeNull();
  });

  it('rejects retired legacy auto_start investigation mode in HealthCheckSourceConfigV1Schema', () => {
    const parsed = HealthCheckSourceConfigV1Schema.safeParse({
      v: 1,
      subject: { kind: 'machineService', machineId: 'm1', serviceId: 'web' },
      investigation: { mode: 'auto_start', configuredActionId: 'investigate' },
      checks: [{
        checkId: 'tcp',
        kind: { pluginId: 'happier.machine.services', localId: 'tcp' },
        binding: { kind: 'healthCheck' },
        config: { host: '127.0.0.1', port: 8080 },
        periodMs: 60_000,
        consecutiveFailuresBeforeAlerting: 1,
      }],
    });
    expect(parsed.success).toBe(false);
  });
});
