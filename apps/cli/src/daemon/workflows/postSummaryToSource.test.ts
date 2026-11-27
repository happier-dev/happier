import { describe, expect, it, vi } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';
import { postWorkflowRunSummaryToAuthorizedSource } from './postSummaryToSource';

const baseContext = { surface: 'cli' } as unknown as ActionExecutorContext;

const SOURCE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

const githubOccurrence = {
  eventRef: { pluginId: 'happier.scm.github', localId: 'automation/issue-labeled-v1' },
  sourceInstanceId: SOURCE_INSTANCE_ID,
  payload: {
    repository: { repositoryId: '777', nameWithOwner: 'happier-dev/happier' },
    issue: { id: '888', number: 42, title: 'Investigate' },
  },
};

const internalTaskOccurrence = {
  eventRef: { pluginId: 'happier.triage', localId: 'task-labeled' },
  sourceInstanceId: 'triage-source-1',
  payload: { task: { taskId: 'task-1', ownerAccountId: 'acct-1' } },
};

describe('postWorkflowRunSummaryToAuthorizedSource (Q11)', () => {
  it('stays off by default and performs zero external calls when disabled', async () => {
    const execute = vi.fn();
    const outcome = await postWorkflowRunSummaryToAuthorizedSource({
      enabled: false,
      occurrence: githubOccurrence,
      finalResult: 'Done.',
      actionExecutor: { execute },
      context: baseContext,
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses internal Task triggers with unsupported_source and performs zero external calls', async () => {
    const execute = vi.fn();
    const outcome = await postWorkflowRunSummaryToAuthorizedSource({
      enabled: true,
      occurrence: internalTaskOccurrence,
      finalResult: 'Done.',
      actionExecutor: { execute },
      context: baseContext,
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'unsupported_source' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('posts the run summary via the authorized GitHub comment Action when enabled on a GitHub issue/PR trigger', async () => {
    const configured = {
      v: 1,
      instance: {
        source: { pluginId: 'happier.scm.github', localId: 'github-triage' },
        sourceInstanceId: SOURCE_INSTANCE_ID,
      },
      binding: {
        purpose: 'triage-source',
        account: { service: { pluginId: 'happier.scm.github', localId: 'github-account' }, accountId: 'acct-gh' },
      },
      localInstanceKey: 'github/happier-dev/happier',
      configuration: { v: 1, token: 'tok' },
    };
    const execute = vi.fn(async (_actionId: string, input: any) => {
      if (input.action.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId) {
        return {
          ok: true as const,
          result: { kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active', configured }] },
        };
      }
      return { ok: true as const, result: { kind: 'applied', effect: 'changed' } };
    });

    const outcome = await postWorkflowRunSummaryToAuthorizedSource({
      enabled: true,
      occurrence: githubOccurrence,
      finalResult: 'Summary: fixed the root cause.',
      actionExecutor: { execute },
      context: baseContext,
    });

    expect(outcome).toEqual({ kind: 'posted' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(2, 'action.invoke', {
      action: { pluginId: 'happier.scm.github', localId: 'github/comment/create' },
      input: {
        v: 1,
        instance: configured,
        localRef: { kindId: 'issue', collisionScope: 'github:777', entryId: '42' },
        routingToken: 'happier-dev/happier',
        body: 'Summary: fixed the root cause.',
      },
    }, baseContext);
  });
});
