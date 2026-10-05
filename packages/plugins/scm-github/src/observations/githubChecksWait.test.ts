import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { waitGithubChecksSource } from './githubChecksWait.js';
import { createGithubAutomationEventCheckpointRowId, createGithubAutomationEventCheckpointRowV1 } from './githubAutomationEventCheckpoint.js';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS } from '../githubAutomationEvents.js';
import { GITHUB_PLUGIN_ID } from './githubProviderContracts.js';
import { githubChecksSourceInstanceId } from './githubChecksSource.js';
import type { GithubChecksConditionSnapshotV1 } from '../triage/checksCondition.js';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { GITHUB_CHECKS_WAIT_ACTION_ID } from './githubChecksSource.js';

const checks = { pullRequestNumber: 7, headSha: 'a'.repeat(40), selection: 'all' as const };
const ref = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.checksPassed };
const identity = { automationId: 'automation-a', triggerId: 'trigger-a', eventRef: ref, sourceSelectorId: 'selector-a' };
const sourceId = createGithubAutomationEventCheckpointRowId(identity);
function harness(state: GithubChecksConditionSnapshotV1['state'] = 'pending', failure?: GithubChecksConditionSnapshotV1['failure']) {
  let current = state;
  let listener: (() => void) | null = null;
  let reads = 0;
  let disposals = 0;
  let onWatch: (() => void) | null = null;
  let admitted = true;
  const controller = new AbortController();
  const collection = {
    get: async () => {
      reads += 1;
      const snapshot: GithubChecksConditionSnapshotV1 = { ...checks, currentHeadSha: current === 'superseded' ? 'b'.repeat(40) : checks.headSha, state: current,
        complete: current === 'passed' || current === 'failed', passed: current === 'passed', ...(failure ? { failure } : {}) };
      return { rowId: sourceId, revision: 1, value: createGithubAutomationEventCheckpointRowV1({
        ...identity, checkpointRowId: sourceId, sourceInstanceId: githubChecksSourceInstanceId('77', checks), sourceContractVersion: 1,
        cursor: { v: 1, kind: 'pullRequestChecks', snapshot, observedAtMs: 1000, evidenceKey: 'evidence' },
        lastContiguousOccurrenceId: null, baseline: { kind: 'currentHead', establishedAt: 1000 },
        lastEvaluatedTriggerRevision: 1, continuity: { v: 1, endpointKind: 'pullRequestChecks', repositoryId: '77' },
      }) };
    },
    watch: (_query: unknown, callback: () => void) => { listener = callback; onWatch?.();
      return { dispose: () => { listener = null; disposals += 1; } }; },
  };
  // Only the persistent Account Collection boundary is faked; observation,
  // checkpoint validation, predicate and cancellation remain real.
  const context = { signal: controller.signal, services: { storage: { account: { collection: () => collection } },
    actions: { execute: async (_id: string, input: { knownRevision?: string }) => input.knownRevision
      ? { kind: 'unchanged', revision: '7' }
      : { kind: 'page', revision: '7', nextCursor: null, definitions: admitted ? [{ ...identity, triggerRevision: 1,
        sourceInstanceId: githubChecksSourceInstanceId('77', checks) }] : [] } },
  } } as unknown as PluginInvocationContext;
  return { context, controller, reads: () => reads, disposals: () => disposals,
    hasListener: () => listener !== null, change: (next: typeof state) => { current = next; listener?.(); },
    duringWatch: (callback: () => void) => { onWatch = callback; }, revoke: () => { admitted = false; listener?.(); } };
}
async function untilSubscribed(fixture: ReturnType<typeof harness>) {
  for (let attempt = 0; attempt < 20 && !fixture.hasListener(); attempt += 1) await Promise.resolve();
}
function genericWait(fixture: ReturnType<typeof harness>, durationMs?: number) {
  // The contributed-Action RPC is the boundary fixture. The real checkpoint
  // waiter, generic dispatch, Action admission and result schemas stay live.
  const executor = createActionExecutor({ invokeContributedAction: async ({ action, input, signal }: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0]) => {
    expect(action).toEqual({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_CHECKS_WAIT_ACTION_ID });
    return { ok: true, result: await waitGithubChecksSource(input, { ...fixture.context,
      ...(signal ? { signal } : {}) }) };
  } } as unknown as ActionExecutorDeps);
  return executor.execute('wait', {
    target: { kind: 'plugin_source', serverId: 'home', pluginId: GITHUB_PLUGIN_ID, sourceId },
    condition: { kind: 'plugin', actionLocalId: GITHUB_CHECKS_WAIT_ACTION_ID, condition: 'checks_passed' },
    ...(durationMs === undefined ? {} : { timeout: { durationMs } }),
  }, { surface: 'cli', serverId: 'home', signal: fixture.controller.signal });
}
describe('GitHub admitted checks source wait', () => {
  it('matches checks-passed through the generic admitted Action dispatch', async () => {
    expect(await genericWait(harness('passed'))).toMatchObject({ ok: true, result: { disposition: 'matched', snapshot: { state: 'passed' } } });
  });
  it('does not match failed checks through generic wait and preserves failure evidence at timeout', async () => {
    expect(await genericWait(harness('failed'), 5)).toMatchObject({ ok: true, result: { disposition: 'observation_timeout', snapshot: { state: 'failed', passed: false } } });
  });
  it('applies the generic observation deadline to pending checks', async () => {
    const fixture = harness();
    expect(await genericWait(fixture, 5)).toMatchObject({ ok: true, result: { disposition: 'observation_timeout', snapshot: { state: 'pending' } } });
    expect(fixture.disposals()).toBe(1);
  });
  it('cancels the generic plugin observer without changing the checkpoint', async () => {
    const fixture = harness();
    const pending = genericWait(fixture);
    await untilSubscribed(fixture);
    fixture.controller.abort();
    expect(await pending).toMatchObject({ ok: true, result: { disposition: 'cancelled', snapshot: { state: 'pending' } } });
    expect(fixture.disposals()).toBe(1);
    expect(await waitGithubChecksSource({ sourceId, condition: 'checks_complete', timeoutMs: 0 }, { ...fixture.context,
      signal: new AbortController().signal })).toMatchObject({ disposition: 'observation_timeout' });
  });
  it('matches already passed without a watcher', async () => {
    const fixture = harness('passed');
    expect(await waitGithubChecksSource({ sourceId, condition: 'checks_passed' }, fixture.context)).toMatchObject({ disposition: 'matched', snapshot: { state: 'passed' } });
    expect(fixture.hasListener()).toBe(false);
  });
  it('parks on Collection invalidation without recurring reads and closes the registration race', async () => {
    const fixture = harness();
    const pending = waitGithubChecksSource({ sourceId, condition: 'checks_passed' }, fixture.context);
    await untilSubscribed(fixture);
    expect(fixture.hasListener()).toBe(true);
    const reads = fixture.reads();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.reads()).toBe(reads);
    fixture.change('passed');
    expect(await pending).toMatchObject({ disposition: 'matched', snapshot: { state: 'passed' } });
    expect(fixture.disposals()).toBe(1);
    const race = harness();
    race.duringWatch(() => race.change('passed'));
    expect(await waitGithubChecksSource({ sourceId, condition: 'checks_passed' }, race.context)).toMatchObject({ disposition: 'matched' });
  });
  it('does not accept failed or no checks as passed and cancels only the observer', async () => {
    for (const state of ['failed', 'none'] as const) {
      const fixture = harness(state);
      const pending = waitGithubChecksSource({ sourceId, condition: 'checks_passed' }, fixture.context);
      await untilSubscribed(fixture);
      fixture.controller.abort();
      expect(await pending).toMatchObject({ disposition: 'cancelled' });
      expect(fixture.disposals()).toBe(1);
    }
    expect(await waitGithubChecksSource({ sourceId, condition: 'checks_complete' }, harness('failed').context)).toMatchObject({ disposition: 'matched' });
  });
  it('times out with explicit none and releases the subscription', async () => {
    const fixture = harness('none');
    expect(await waitGithubChecksSource({ sourceId, condition: 'checks_passed', timeoutMs: 5 }, fixture.context)).toMatchObject({ disposition: 'observation_timeout', snapshot: { state: 'none' } });
    expect(fixture.disposals()).toBe(1);
  });
  it('reports withheld permission separately from unknown or superseded evidence', async () => {
    expect(await waitGithubChecksSource({ sourceId, condition: 'checks_passed' }, harness('unknown', { class: 'permission', code: 'github_forbidden' }).context))
      .toMatchObject({ disposition: 'permission_denied' });
    for (const state of ['unknown', 'superseded'] as const) {
      expect(await waitGithubChecksSource({ sourceId, condition: 'checks_passed' }, harness(state).context))
        .toMatchObject({ disposition: 'target_unavailable', snapshot: { state } });
    }
  });
  it('does not match a removed source even when its retained checkpoint turns green', async () => {
    const fixture = harness();
    const pending = waitGithubChecksSource({ sourceId, condition: 'checks_passed' }, fixture.context);
    await untilSubscribed(fixture);
    fixture.revoke();
    fixture.change('passed');
    expect(await pending).toMatchObject({ disposition: 'target_unavailable' });
    expect(fixture.disposals()).toBe(1);
  });
  it('applies the observation deadline to an in-flight checkpoint read', async () => {
    const fixture = harness();
    let stoppedRead = false;
    const context: PluginInvocationContext = { ...fixture.context, services: { ...fixture.context.services,
      storage: { ...fixture.context.services.storage, account: { collection: () => ({
        get: (_rowId: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { stoppedRead = true; reject(new Error('observer aborted')); }, { once: true });
        }),
      }) } },
    } } as unknown as PluginInvocationContext; // Persistent Collection transport boundary.
    const pending = waitGithubChecksSource({ sourceId, condition: 'checks_passed', timeoutMs: 5 }, context);
    const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('deadline ignored'), 50))]);
    fixture.controller.abort(); // Ensure a failing implementation cannot leave a read alive.
    expect(result).toMatchObject({ disposition: 'observation_timeout' });
    expect(stoppedRead).toBe(true);
    await pending;
  });
});
