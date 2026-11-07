import { createPluginTestkit, createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginCollectionMutation, PluginCollectionQuery } from '@happier-dev/plugin-sdk/collections';
import { PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';
import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../posthogContracts.js';
import { encodePosthogConfiguration } from './instance.js';
import recorded from '../api/__fixtures__/queryIssuesPage1.json' with { type: 'json' };

type CheckpointRow = { id: string; sourceInstanceId: string; checkpoint: Record<string, JsonValue> };

describe('PostHog issue observer through plugin activation', () => {
  it.each(['blocked', 'noticeFailed'] as const)('uses real source setup and preserves transition identity across %s reversion and reload', async reversionOutcome => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    const encoded = encodePosthogConfiguration({
      v: 1, organizationUuid: '00000000-0000-4000-8000-0000000000a1',
      environments: [{ teamPathId: 4821, teamUuid: '00000000-0000-4000-8000-0000000000d1', displayName: 'Storefront' }],
      scanWindowPolicy: { kind: 'exact', from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' },
      detailWindowPolicy: { kind: 'relative', durationMs: 30 * 86_400_000 },
    });
    if (!encoded.ok) throw new Error('fixture configuration must encode');
    const instance = { ...createTriageSourceV1Fixture().configuredInstance,
      instance: { source: { pluginId: 'happier.posthog', localId: 'posthog-error-tracking' }, sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
      binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: {
        service: { pluginId: 'happier.posthog', localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }, accountId: 'account-1' } },
      localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
      configuration: { v: 1 as const, token: encoded.token },
    };
    const materialization = { pluginId: 'happier.posthog', machineId: 'machine-1', materializationId: 'materialization-1' };
    const sourceConfig = { v: 1, instance, checkPeriodMs: 300_000, investigation: { mode: 'inbox' } };
    let definition = { automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 1,
      eventRef: { pluginId: 'happier.posthog', localId: 'issue-transition' }, sourceInstanceId: instance.instance.sourceInstanceId,
      sourceSelectorId: '00000000-0000-4000-8000-000000000001', sourceContractVersion: 1, sourceConfig,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null };
    const admitted: JsonValue[] = [];
    const attempts: Array<{ occurrenceId?: string; occurredAt?: number; payload?: JsonValue }> = [];
    const handoffs: JsonValue[] = [];
    const catalogTasks: Array<string | undefined> = [];
    const sourceObservedDeltas: number[] = [];
    const rows = new Map<string, { revision: number; value: CheckpointRow }>();
    let subscribed = true;
    let mixedSubscribers = false;
    let currentHost = materialization;
    let status = 'active';
    let lastSeen = recorded.results[0]!.last_seen;
    let holdRequest = false;
    let incomplete = false;
    let contendPendingWrite = false;
    let winningObservedAt: number | undefined;
    let failNotice = false;
    let abortAfterPending: (() => void) | undefined;
    let admissionOutcome: 'admitted' | 'rejoined' | 'blocked' | 'filtered' | 'outsideFreshness' = 'admitted';
    let releaseRequest: (() => void) | undefined;
    const request = vi.fn(async (input: { url: string }) => {
      if (holdRequest) await new Promise<void>(resolve => { releaseRequest = resolve; });
      return { status: 200, finalUrl: input.url,
      headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({
        ...recorded, results: [{ ...recorded.results[0], status, last_seen: lastSeen },
          ...(incomplete ? [{ malformed: true }] : [])], hasMore: false, limit: 100,
      })) };
    });
    const batch = vi.fn(async (operations: readonly PluginCollectionMutation<CheckpointRow>[]) => {
      const results = operations.map(operation => {
        if (operation.kind !== 'put') throw new Error('Expected a checkpoint put');
        const prior = rows.get(operation.value.id);
        expect(operation.expectedRevision).toBe(prior?.revision ?? 'absent');
        return { rowId: operation.value.id, revision: (prior?.revision ?? 0) + 1, deleted: false };
      });
      for (const [index, operation] of operations.entries()) {
        if (operation.kind !== 'put') throw new Error('Expected a checkpoint put');
        const value = operation.value;
        const pending = value.checkpoint.pending;
        if (contendPendingWrite && pending !== null && typeof pending === 'object' && !Array.isArray(pending)) {
          contendPendingWrite = false;
          winningObservedAt = Date.now() - 1_000;
          const revision = results[index]!.revision;
          rows.set(value.id, { revision, value: { ...value, checkpoint: {
            ...value.checkpoint, pending: { ...pending, occurredAt: winningObservedAt },
          } } });
          return { status: 'conflict', conflicts: [{ rowId: value.id, revision, deleted: false }] };
        }
      }
      operations.forEach((operation, index) => {
        if (operation.kind === 'put') rows.set(operation.value.id, { revision: results[index]!.revision, value: operation.value });
      });
      if (operations.some(operation => operation.kind === 'put' && 'pending' in operation.value.checkpoint)) {
        const abort = abortAfterPending;
        abortAfterPending = undefined;
        abort?.();
      }
      return { status: 'updated', results, changeCursor: 0 };
    });
    // Only persistent storage is replaced; activation, the SDK runner and provider stay real.
    const collection = {
      query: async (query: PluginCollectionQuery) => {
        expect(query.index).toBe('by-source');
        const prefixes = query.prefixes ?? [query.prefix ?? []];
        return { rows: [...rows].filter(([rowId, row]) => prefixes.some(prefix =>
          (prefix[0] === undefined || prefix[0] === row.value.sourceInstanceId)
          && (prefix[1] === undefined || prefix[1] === rowId)))
          .map(([rowId, row]) => ({ rowId, ...row })), changeCursor: 0 };
      },
      batch,
      limits: async () => ({ ...PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
        maxRows: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountRows,
        maxCollectionEncodedBytes: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountBytes, basis: 'deployment' }),
      measureBatch: async (operations: readonly PluginCollectionMutation<CheckpointRow>[]) => ({ overheadEncodedBytes: 0,
        operationEncodedBytes: operations.map(operation => new TextEncoder().encode(JSON.stringify(operation)).byteLength) }),
    };
    const send = vi.fn(async (_input: Parameters<PluginInvocationContext['services']['notifications']['send']>[0]) => {
      if (failNotice) throw new Error('C1 boundary unavailable after Event admission');
      return { deliveries: [], replayed: false,
        ...(status === 'resolved' ? {} : { notice: { artifactId: 'notice-1', changed: true, opened: true } }) };
    });
    const context = (signal: AbortSignal) => ({ surface: 'background', signal, materialization: currentHost,
      plugin: { id: 'happier.posthog', version: '0.0.0' },
      contribution: { id: 'issue-observer', qualifiedId: 'happier.posthog/backgroundServices/issue-observer' },
      services: {
        http: createPluginHttpFixture({ request }), notifications: { send },
        connectedAccounts: { listAccounts: async () => ({ status: 'complete', accounts: [{ account: instance.binding.account,
          state: 'connected', connectedAccountOrigins: ['https://eu.posthog.com'], connectedAccountBases: ['https://eu.posthog.com'] }] }),
        materializeListedAccount: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-token' } }) },
        storage: { account: { collection: () => collection } },
        events: { host: { subscribe: () => ({ dispose() {} }) } },
        actions: { execute: async (action: unknown, input: { knownRevision?: string; payload?: JsonValue; definitions?: readonly Record<string, JsonValue>[]; task?: string; handoff?: JsonValue; occurrenceId?: string; occurredAt?: number; observedDelta?: number }) => {
          if (action === 'automation.event.sources.list') return input.knownRevision === '1' ? { kind: 'unchanged', revision: '1' }
            : { kind: 'page', revision: '1', definitions: subscribed ? [definition,
              ...(mixedSubscribers ? [{ ...definition, automationId: 'automation-2', triggerId: 'trigger-2',
                sourceSelectorId: '00000000-0000-4000-8000-000000000002' }] : [])] : [], nextCursor: null };
          if (action === 'automation.event.source.status.report') {
            if (input.observedDelta !== undefined) sourceObservedDeltas.push(input.observedDelta);
            return {};
          }
          if (action === 'automation.event.admit') {
            attempts.push({ ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId }),
              ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
              ...(input.payload === undefined ? {} : { payload: input.payload }) });
            if (input.payload !== undefined && (admissionOutcome === 'admitted' || admissionOutcome === 'rejoined')) admitted.push(input.payload);
            return { results: (input.definitions ?? []).map((_definition, index) => mixedSubscribers && index === 0
              ? { kind: 'skipped', reason: 'filtered', checkpointSafe: true }
              : admissionOutcome === 'blocked'
              ? { kind: 'blocked', reason: 'capacity', checkpointSafe: false }
              : admissionOutcome === 'filtered' || admissionOutcome === 'outsideFreshness'
                ? { kind: 'skipped', reason: admissionOutcome, checkpointSafe: true }
                : { kind: admissionOutcome, checkpointSafe: true, runId: 'workflow-1' }) };
          }
          if (action && typeof action === 'object' && 'localId' in action) {
            if (action.localId === 'actions/read-v1') {
              catalogTasks.push(input.task);
              return { v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [{ label: 'Investigate', selection: {
                configuredActionId: 'investigate', sessionChoice: { kind: 'configured' },
                agentChoice: { kind: 'configured' }, delivery: 'configured',
              } }] };
            }
            if (action.localId === 'sessions/run-configured-v1') {
              if (input.handoff !== undefined) handoffs.push(input.handoff);
              return { v: 1, handoff: { kind: 'sendResult', session: { serverId: 'server-a', sessionId: 'native-alert-session' },
                result: { status: 'accepted', localId: 'native-alert-input' } } };
            }
            return { kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active', configured: instance }] };
          }
          throw new Error(`Unexpected host Action ${String(action)}`);
        } },
      },
    } as unknown as BackgroundServiceContext);
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const controller = new AbortController();
      const setup = kit.registration('actions', 'automation/setup-issue-transition-v1');
      expect(await setup?.({ sourceInstanceId: instance.instance.sourceInstanceId }, context(controller.signal)))
        .toMatchObject({ sourceConfig, observationOnly: { kind: 'observationOnly' } });
      expect(request).not.toHaveBeenCalled();
      const background = kit.registration('backgroundServices', 'issue-observer');
      const cycle = async () => {
        const abort = new AbortController();
        const running = background?.(context(abort.signal));
        await vi.advanceTimersByTimeAsync(0);
        abort.abort();
        await running;
      };
      currentHost = { ...materialization, machineId: 'wrong-host' };
      await cycle();
      currentHost = materialization;
      subscribed = false;
      await cycle();
      expect(request).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      subscribed = true;
      admissionOutcome = 'blocked';
      const firstObservedAt = Date.now();
      await cycle();
      expect(attempts[0]?.occurredAt).toBe(firstObservedAt);
      expect([...rows.values()].map(row => row.value.checkpoint)).toMatchObject([{ v: 1, pending: { occurredAt: firstObservedAt } }]);
      expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('signature');
      expect(send).not.toHaveBeenCalled();
      expect(batch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await cycle(); // New runner instance adopts the same durable pending candidate.
      expect(attempts[1]).toEqual(attempts[0]);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(sourceObservedDeltas.slice(0, 2)).toEqual([1, 0]);
      admissionOutcome = 'admitted';
      await cycle();
      expect(admitted).toHaveLength(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toMatchObject({ investigation: {
        kind: 'alertEntry', entry: {
          entryRef: { source: instance.instance.source, kindId: 'error-issue',
            collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
            entryId: recorded.results[0]!.id },
          sourceInstanceId: instance.instance.sourceInstanceId,
        },
      } });
      await cycle();
      expect(admitted).toHaveLength(1);
      expect(batch).toHaveBeenCalledTimes(2);
      expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
      status = 'resolved';
      await cycle();
      status = 'active';
      await cycle();
      expect(admitted).toMatchObject([{ phase: 'open' }, { phase: 'resolved' }, { phase: 'open' }]);
      expect(new Set(send.mock.calls.map(([value]) => value.itemId)).size).toBe(1);
      expect(new Set(send.mock.calls.map(([value]) => value.clientRequestId)).size).toBe(3);
      // A new native exception is content even when a rolling aggregate count is unchanged.
      lastSeen = '2026-08-14T06:42:55.902000Z';
      await cycle();
      expect(admitted).toMatchObject([{ phase: 'open' }, { phase: 'resolved' }, { phase: 'open' }, { phase: 'updated' }]);
      status = 'resolved';
      holdRequest = true;
      const cancelled = new AbortController();
      const pending = background?.(context(cancelled.signal));
      await vi.advanceTimersByTimeAsync(0);
      expect(releaseRequest).toBeTypeOf('function');
      cancelled.abort();
      releaseRequest?.();
      await pending;
      expect(admitted).toHaveLength(4);
      expect(send).toHaveBeenCalledTimes(4);
      expect(batch).toHaveBeenCalledTimes(8);
      holdRequest = false;
      const cancelPersistedPending = new AbortController();
      abortAfterPending = () => cancelPersistedPending.abort();
      const cancelledObservedAt = Date.now();
      const beforePendingCancel = attempts.length;
      const pendingCancelled = background?.(context(cancelPersistedPending.signal));
      await vi.advanceTimersByTimeAsync(0);
      await pendingCancelled;
      expect(attempts).toHaveLength(beforePendingCancel);
      expect([...rows.values()].map(row => row.value.checkpoint)).toMatchObject([{ state: 'active', pending: {
        state: 'resolved', occurredAt: cancelledObservedAt,
      } }]);
      await vi.advanceTimersByTimeAsync(1_000);
      const automatic = { ...sourceConfig, investigation: { mode: 'auto_start', configuredActionId: 'investigate' } };
      await expect(setup?.({ sourceInstanceId: instance.instance.sourceInstanceId,
        investigation: { mode: 'auto_start', configuredActionId: 'missing' } }, context(controller.signal)))
        .rejects.toMatchObject({ code: 'triage_issue_investigation_unavailable' });
      expect(await setup?.({ sourceInstanceId: instance.instance.sourceInstanceId, investigation: automatic.investigation }, context(controller.signal)))
        .toMatchObject({ sourceConfig: automatic });
      expect(catalogTasks).toEqual(['investigate', 'investigate']);
      definition = { ...definition, sourceConfig: automatic };
      await cycle(); // The cancelled recovery is now observed and committed.
      expect(attempts.at(-1)?.occurredAt).toBe(cancelledObservedAt);
      status = 'active';
      await cycle();
      await cycle();
      expect(handoffs).toMatchObject([{ task: 'investigate', configuredActionId: 'investigate', delivery: 'send',
        context: { kind: 'entry', entry: { sourceInstanceId: instance.instance.sourceInstanceId } },
        evidence: [{ kind: 'alertEntry', entry: { sourceInstanceId: instance.instance.sourceInstanceId } }],
      }]);
      expect(catalogTasks).toEqual(['investigate', 'investigate', 'investigate']);
      for (const reason of ['filtered', 'outsideFreshness'] as const) {
        status = 'resolved';
        await cycle();
        status = 'active';
        admissionOutcome = reason;
        const noticesBefore = send.mock.calls.length;
        await cycle();
        expect(send).toHaveBeenCalledTimes(noticesBefore + 1);
        expect(handoffs).toHaveLength(1);
        expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
        const writesAfterSkip = batch.mock.calls.length;
        await cycle();
        expect(batch).toHaveBeenCalledTimes(writesAfterSkip);
        admissionOutcome = 'admitted';
      }
      status = 'resolved';
      incomplete = true;
      const writesBeforeIncomplete = batch.mock.calls.length;
      const attemptsBeforeIncomplete = attempts.length;
      await cycle();
      expect(batch).toHaveBeenCalledTimes(writesBeforeIncomplete);
      expect(attempts).toHaveLength(attemptsBeforeIncomplete);
      incomplete = false;
      await cycle();
      status = 'active';
      contendPendingWrite = true;
      const attemptsBeforeConflict = attempts.length;
      await cycle();
      expect(attempts).toHaveLength(attemptsBeforeConflict);
      expect([...rows.values()].map(row => row.value.checkpoint)).toMatchObject([{ state: 'resolved', pending: { state: 'active' } }]);
      await vi.advanceTimersByTimeAsync(10_000);
      admissionOutcome = 'rejoined';
      await cycle();
      expect(attempts.at(-1)?.occurredAt).toBe(winningObservedAt);
      expect(sourceObservedDeltas.at(-1)).toBe(0);
      expect(handoffs).toHaveLength(2);
      expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
      admissionOutcome = 'admitted';
      mixedSubscribers = true;
      status = 'resolved';
      await cycle();
      status = 'active';
      await cycle();
      expect(handoffs).toHaveLength(3); // One actual admission, despite another subscriber's filtered outcome.
      status = 'resolved';
      admissionOutcome = 'admitted';
      await cycle();
      status = 'active';
      admissionOutcome = 'blocked';
      await cycle();
      const replacedPending = attempts.at(-1);
      await vi.advanceTimersByTimeAsync(1_000);
      lastSeen = '2026-08-14T06:43:55.902000Z';
      await cycle();
      const replacementObservedAt = Date.now();
      expect(attempts.at(-1)?.occurredAt).toBe(replacementObservedAt);
      expect(attempts.at(-1)?.occurrenceId).not.toBe(replacedPending?.occurrenceId);
      const replacementWrites = batch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      admissionOutcome = 'outsideFreshness';
      await cycle();
      expect(attempts.at(-1)?.occurredAt).toBe(replacementObservedAt);
      expect(batch).toHaveBeenCalledTimes(replacementWrites + 1);
      expect(handoffs).toHaveLength(3);
      expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
      // The provider's status may revert while the effective cursor is still
      // active. A second resolve at the SAME native time is a distinct occurrence,
      // including when the first resolve was admitted but C1 could not commit it.
      status = 'resolved';
      admissionOutcome = reversionOutcome === 'blocked' ? 'blocked' : 'admitted';
      failNotice = reversionOutcome === 'noticeFailed';
      await cycle();
      const firstResolve = attempts.at(-1);
      expect([...rows.values()].map(row => row.value.checkpoint)).toMatchObject([{ state: 'active', pending: { state: 'resolved' } }]);
      failNotice = false;
      admissionOutcome = 'blocked';
      status = 'active';
      await vi.advanceTimersByTimeAsync(1_000);
      await cycle();
      const firstReopen = attempts.at(-1);
      const reopenWrites = batch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      await cycle();
      const retryReopen = attempts.at(-1);
      status = 'resolved';
      await vi.advanceTimersByTimeAsync(1_000);
      const secondResolvedAt = Date.now();
      await cycle();
      expect(attempts.at(-1)?.occurrenceId).not.toBe(firstResolve?.occurrenceId);
      expect(attempts.at(-1)?.occurredAt).toBe(secondResolvedAt);
      expect(firstReopen?.payload).toMatchObject({ phase: 'open' });
      expect(retryReopen).toEqual(firstReopen);
      expect(batch).toHaveBeenCalledTimes(reopenWrites + 1);
      expect([...rows.values()].map(row => row.value.checkpoint)).toMatchObject([{ state: 'active', pending: { state: 'resolved' } }]);
      admissionOutcome = 'admitted';
      await cycle();
      expect(attempts.at(-1)?.occurredAt).toBe(secondResolvedAt);
      expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
    } finally { await kit.dispose(); vi.useRealTimers(); }
  });
});
