import { createPluginTestkit, createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { computeCanonicalDomainSeparatedDigest, PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginCollectionMutation, PluginCollectionQuery } from '@happier-dev/plugin-sdk/collections';
import { PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { describe, expect, it, vi } from 'vitest';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';
import { SENTRY_ACTION_IDS, SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';
import { scanSentrySource } from './operations.js';
import recorded from '../fixtures/issuesListPage2.json' with { type: 'json' };

type CheckpointRow = { id: string; sourceInstanceId: string; checkpoint: Record<string, JsonValue> };

describe('Sentry issue observer through plugin activation', () => {
  it.each(['inbox'] as const)(
    'observes one issue in %s mode with quiet equal/replay cycles and zero direct legacy auto_start handoffs', async investigationOutcome => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    const controller = new AbortController();
    const sourceInstanceId = '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05';
    const instance = {
      v: 1,
      instance: { source: { pluginId: 'happier.sentry', localId: 'sentry-issues' }, sourceInstanceId },
      binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: {
        service: { pluginId: 'happier.sentry', localId: 'sentry-account' }, accountId: 'account-1',
      } },
      localInstanceKey: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
      configuration: { v: 1, token: encodeSentryInstanceConfiguration({
        v: 1, organizationId: '7701', projectScope: { kind: 'allAccessible' }, environmentScope: { kind: 'all' },
      }) },
    } as const;
    const automatic = false;
    const sourceConfig = { v: 1, instance, checkPeriodMs: 120_000, investigation: { mode: 'inbox' as const } };
    const materialization = { pluginId: 'happier.sentry', machineId: 'machine-1', materializationId: 'materialization-1' };
    const definition = {
      automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 1,
      eventRef: { pluginId: 'happier.sentry', localId: 'issue-transition' },
      sourceInstanceId, sourceSelectorId: '00000000-0000-4000-8000-000000000001',
      sourceContractVersion: 1, sourceConfig,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
      filter: null, maximumObservationAgeMs: null,
    };
    const admitted: JsonValue[] = [];
    let catalogReads = 0;
    let choiceReads = 0;
    const occurrenceTimes: Array<number | undefined> = [];
    const rows = new Map<string, { revision: number; value: CheckpointRow }>();
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
      batch: async (operations: readonly PluginCollectionMutation<CheckpointRow>[]) => {
        const results = operations.map(operation => {
          if (operation.kind !== 'put') throw new Error('Expected a checkpoint put');
          const current = rows.get(operation.value.id);
          expect(operation.expectedRevision).toBe(current?.revision ?? 'absent');
          return { rowId: operation.value.id, revision: (current?.revision ?? 0) + 1, deleted: false };
        });
        operations.forEach((operation, index) => {
          if (operation.kind === 'put') rows.set(operation.value.id, { value: operation.value, revision: results[index]!.revision });
        });
        return { status: 'updated', results, changeCursor: 0 };
      },
      limits: async () => ({ ...PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
        maxRows: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountRows,
        maxCollectionEncodedBytes: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountBytes, basis: 'deployment' }),
      measureBatch: async (operations: readonly PluginCollectionMutation<CheckpointRow>[]) => ({ overheadEncodedBytes: 0,
        operationEncodedBytes: operations.map(operation => new TextEncoder().encode(JSON.stringify(operation)).byteLength) }),
    };
    let populated = false;
    let limited = false;
    let admissionSafe = true;
    let resolved = false;
    let additionalIssues = false;
    const request = vi.fn(async (input: { url: string }) => limited ? {
      status: 429, finalUrl: input.url,
      headers: { 'x-sentry-rate-limit-reset': String((Date.now() + 600_000) / 1_000) },
      body: new TextEncoder().encode('{}'),
    } : ({
      status: 200, finalUrl: input.url, headers: recorded.headers,
      body: new TextEncoder().encode(JSON.stringify(populated ? [
        ...recorded.body.map((row, index) => resolved && index === 0 ? { ...row, status: 'resolved' } : row),
        ...(additionalIssues ? ['5501010', '5501011'].map(id => ({ ...recorded.body[0]!, id,
          permalink: `https://example-org.sentry.io/issues/${id}/` })) : []),
      ] : [])),
    }));
    const handoffAttempts: JsonValue[] = [];
    let outcomeNoticeFailed = false;
    const send = vi.fn(async (input: Parameters<PluginInvocationContext['services']['notifications']['send']>[0]) => {
      if (investigationOutcome === 'outcomeNoticeUnavailable' && input.clientRequestId?.endsWith(':investigation')) {
        outcomeNoticeFailed = true;
        throw new PluginError({ code: 'notice_transport_unavailable' });
      }
      return { deliveries: [], replayed: outcomeNoticeFailed,
        notice: { artifactId: 'notice-1', changed: !outcomeNoticeFailed, opened: !outcomeNoticeFailed } };
    });
    const scanServices = {
      http: createPluginHttpFixture({ request }),
      connectedAccounts: {
        listAccounts: async () => ({ status: 'complete' as const, accounts: [{ account: instance.binding.account,
          state: 'connected' as const, connectedAccountOrigins: ['https://us.sentry.io'], connectedAccountBases: ['https://us.sentry.io'] }] }),
        materializeListedAccount: async () => ({ kind: 'httpHeaders' as const, headers: { authorization: 'Bearer fixture-token' } }),
      },
    };
    const context = {
      surface: 'background', signal: controller.signal, materialization,
      plugin: { id: 'happier.sentry', version: '0.0.0' },
      contribution: { id: 'issue-observer', qualifiedId: 'happier.sentry/backgroundServices/issue-observer' },
      services: {
        storage: { account: { collection: () => collection } },
        notifications: { send },
        events: { host: { subscribe: () => ({ dispose() {} }) } },
        actions: { execute: async (action: unknown, input: { knownRevision?: string; payload?: JsonValue; handoff?: JsonValue; occurredAt?: number; definitions?: readonly { automationId: string; triggerId: string; triggerRevision: number; sourceSelectorId: string }[] }, options?: { signal?: AbortSignal }) => {
          if (action === 'automation.event.sources.list') {
            catalogReads += 1;
            return input.knownRevision === '1' ? { kind: 'unchanged', revision: '1' }
              : { kind: 'page', revision: '1', definitions: [definition], nextCursor: null };
          }
          if (action === 'automation.event.source.status.report') return {};
          if (action === 'automation.event.admit') {
            occurrenceTimes.push(input.occurredAt);
            if (input.payload !== undefined) admitted.push(input.payload);
            return { results: (input.definitions ?? []).map(() => admissionSafe
              ? { kind: 'admitted', checkpointSafe: true, runId: 'workflow-1' }
              : { kind: 'blocked', reason: 'capacity', checkpointSafe: false }) };
          }
          if (action && typeof action === 'object' && 'localId' in action) {
            if (action.localId === SENTRY_ACTION_IDS.scan) {
              return scanSentrySource(input, { signal: options?.signal ?? controller.signal, services: scanServices });
            }
            if (action.localId === 'actions/read-v1') {
              choiceReads += 1;
              return investigationOutcome === 'catalogUnavailable'
                ? { v: 1, kind: 'unavailable', reason: 'catalogUnavailable' }
                : { v: 1, kind: 'choices', defaultActionId: 'investigate', actions: investigationOutcome === 'missingChoice' ? [] : [{
                  label: 'Investigate', selection: { configuredActionId: 'investigate', sessionChoice: { kind: 'configured' },
                    agentChoice: { kind: 'configured' }, delivery: 'configured' },
                }] };
            }
            if (action.localId === 'sessions/run-configured-v1') {
              if (input.handoff !== undefined) handoffAttempts.push(input.handoff);
              if (investigationOutcome === 'throws') throw new Error('secret-provider-exception');
              if (investigationOutcome === 'failed') return { ok: false, errorCode: 'machine_unavailable', error: 'secret-provider-exception', effectAttempted: false };
              if (investigationOutcome === 'approval') return { ok: true, result: { kind: 'approval_request_created',
                artifactId: 'approval-1', actionId: 'plugin:happier.triage:sessions/run-configured-v1' } };
              return { ok: true, result: { v: 1, handoff: investigationOutcome === 'unavailable' || investigationOutcome === 'outcomeNoticeUnavailable'
                ? { kind: 'unavailable', reason: 'targetUnavailable' }
                : investigationOutcome === 'selectionRequired' ? { kind: 'selectionRequired', fields: ['placement'] }
                : investigationOutcome === 'uncertain' ? { kind: 'uncertain', phase: 'send', session: null }
                : { kind: 'sendResult', session: { serverId: 'server-a', sessionId: 'session-1' }, result: { status: 'accepted', localId: 'input-1' } },
                recovery: { private: 'secret-recovery' } } };
            }
            return { kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active', configured: instance }] };
          }
          throw new Error(`Unexpected host Action ${String(action)}`);
        } },
      },
    } as unknown as BackgroundServiceContext;
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    let running: Promise<void> | undefined;
    try {
      const setup = kit.registration('actions', 'automation/setup-issue-transition-v1');
      if (setup) await setup({ sourceInstanceId, checkPeriodSeconds: 120 }, context);
      const reset = kit.registration('actions', 'automation/reset-issue-transition-v1');
      expect(await reset?.({ automationId: definition.automationId, triggerId: definition.triggerId,
        triggerRevision: definition.triggerRevision, sourceSelectorId: definition.sourceSelectorId }, context))
        .toEqual({ kind: 'noHistoryGap' });
      expect(catalogReads).toBe(1);
      expect(await reset?.({ automationId: definition.automationId, triggerId: definition.triggerId,
        triggerRevision: 2, sourceSelectorId: definition.sourceSelectorId }, context)).toEqual({ kind: 'stale' });
      expect(catalogReads).toBe(2);
      expect(request).not.toHaveBeenCalled();
      expect(rows.size).toBe(0);
      const background = kit.registration('backgroundServices', 'issue-observer');
      running = background?.(context);
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted).toHaveLength(0);
      populated = true;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(admitted).toHaveLength(1);
      let initialNoticeCount = automatic && investigationOutcome !== 'started' ? 2 : 1;
      expect(send).toHaveBeenCalledTimes(initialNoticeCount);
      const openingNotice = send.mock.calls[0]![0];
      const openingEntry = openingNotice.investigation?.entry.entryRef;
      if (!openingEntry) throw new Error('The source must publish the exact issue reference');
      expect(openingNotice.itemId).toBe(computeCanonicalDomainSeparatedDigest('happier.triage.attention.v1', [
        buildTriageEntryRouteSegmentV1(openingEntry), 'watchedAlert',
      ]));
      const expectedAttempts = automatic && investigationOutcome !== 'missingChoice' && investigationOutcome !== 'catalogUnavailable' ? 1 : 0;
      expect(handoffAttempts).toHaveLength(expectedAttempts);
      if (automatic && investigationOutcome !== 'started') {
        const original = send.mock.calls[0]![0];
        const outcome = send.mock.calls[1]![0];
        expect(outcome.itemId).toBe(original.itemId);
        expect(outcome.clientRequestId).toBe(`${original.clientRequestId}:investigation`);
        expect(outcome.body).not.toBe(original.body);
        expect(outcome.body).toMatch(investigationOutcome === 'uncertain' || investigationOutcome === 'throws'
          ? /may have started/i : /couldn't start|approval|choose/i);
        if (investigationOutcome === 'missingChoice') expect(outcome.body).toMatch(/configured/i);
        if (investigationOutcome === 'selectionRequired') expect(outcome.body).toMatch(/placement|machine/i);
        expect(JSON.stringify(outcome)).not.toMatch(/secret-provider-exception|secret-recovery/);
      }
      if (investigationOutcome === 'outcomeNoticeUnavailable') {
        // A failed notice write retains the normal checkpoint retry. There is no
        // durable outcome carrier and replay must never repeat the Session start.
        expect([...rows.values()][0]?.value.checkpoint).toHaveProperty('pending');
        initialNoticeCount += 1;
      } else expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
      await vi.advanceTimersByTimeAsync(240_000);
      const admissionAttempts = investigationOutcome === 'outcomeNoticeUnavailable' ? 2 : 1;
      expect(admitted).toHaveLength(admissionAttempts);
      if (investigationOutcome === 'outcomeNoticeUnavailable') expect(occurrenceTimes[1]).toBe(occurrenceTimes[0]);
      expect(send).toHaveBeenCalledTimes(initialNoticeCount);
      expect(handoffAttempts).toHaveLength(expectedAttempts);
      expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
      expect(request).toHaveBeenCalledTimes(4);
      limited = true;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(request).toHaveBeenCalledTimes(5);
      limited = false;
      await vi.advanceTimersByTimeAsync(599_999);
      expect(request).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(6);
      expect(admitted).toHaveLength(admissionAttempts);
      expect(send).toHaveBeenCalledTimes(initialNoticeCount);
      resolved = true;
      admissionSafe = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(send).toHaveBeenCalledTimes(initialNoticeCount);
      expect([...rows.values()].map(row => row.revision)).toEqual([3]);
      expect([...rows.values()].map(row => row.value.checkpoint)).toMatchObject([{ state: 'active', pending: { state: 'resolved', occurredAt: Date.now() } }]);
      admissionSafe = true;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(send).toHaveBeenCalledTimes(initialNoticeCount + 1);
      expect(handoffAttempts).toHaveLength(expectedAttempts);
      expect([...rows.values()].map(row => row.revision)).toEqual([4]);
      expect(occurrenceTimes.at(-1)).toBe(occurrenceTimes.at(-2));
      expect([...rows.values()][0]?.value.checkpoint).not.toHaveProperty('pending');
      if (investigationOutcome === 'started' || investigationOutcome === 'missingChoice') {
        const priorChoiceReads = choiceReads;
        const priorAdmissions = admitted.length;
        const priorNotices = send.mock.calls.length;
        additionalIssues = true;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(admitted).toHaveLength(priorAdmissions + 2);
        expect(handoffAttempts).toHaveLength(expectedAttempts + (investigationOutcome === 'started' ? 2 : 0));
        if (investigationOutcome === 'started') {
          expect(new Set(handoffAttempts.slice(-2).map(attempt => JSON.stringify(attempt))).size).toBe(2);
        } else {
          const notices = send.mock.calls.slice(priorNotices).map(call => call[0]);
          expect(notices).toHaveLength(4);
          const itemIds = new Set(notices.map(notice => notice.itemId));
          expect(itemIds.size).toBe(2);
          for (const itemId of itemIds) {
            const updates = notices.filter(notice => notice.itemId === itemId);
            expect(updates).toHaveLength(2);
            expect(updates[1]?.body).toMatch(/couldn't start.*configured/i);
          }
        }
        expect(choiceReads - priorChoiceReads).toBe(1);
        expect(rows.size).toBe(3);
        for (const row of rows.values()) expect(row.value.checkpoint).not.toHaveProperty('pending');
      }
    } finally {
      controller.abort();
      await running;
      await kit.dispose();
      vi.useRealTimers();
    }
  });
});
