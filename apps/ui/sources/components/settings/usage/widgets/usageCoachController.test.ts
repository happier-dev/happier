import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import {
  getUsageQueryKey,
  normalizeUsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import { evaluateUsageCoach, applyUsageCoachPreferences } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { UsageCoachPreferencesV1Schema } from '@happier-dev/protocol/account/settings/usageCoachPreferencesV1';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createUsageCoachController } from './usageCoachController';
import { projectUsageCoachFindings } from './usageCoachPresentation';
import { createUsageCoachSuppressionPort, UsageCoachSuppressionStateV1Schema } from '@happier-dev/protocol/usage/coach/coachActions';

const ANCHOR = 'usage.exampleCoachSetting';
const PREFERENCES = 'usage.coachPreferences';
const COACH_STATE = 'usage-coach:suppressions';
const query = normalizeUsageQuery({
  period: { startMs: 0, endMs: 1000 },
  granularity: 'day',
});
const key = getUsageQueryKey(query);
const compactions = [
  { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
  { evidenceId: 'c2', observedAtMs: 20, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
  { evidenceId: 'c3', observedAtMs: 30, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
];
const evaluation = evaluateUsageCoach({
  queryKey: key,
  period: { startMs: 0, endMs: 1000 },
  asOfMs: 1000,
  currentness: 'current',
  detail: { coverage: 'partial', compactions },
  admittedRemedies: [
    {
      detectorId: 'compaction_storms',
      evidenceIds: ['c1', 'c2', 'c3'],
      remedy: { kind: 'setting', anchor: ANCHOR, value: true },
    },
  ],
});
const finding = evaluation.findings[0]!;

function lifetimeHarness() {
  let current = true;
  const listeners = new Set<() => void>();
  const lifetime: ServerAccountScopeLifetime = {
    scope: { serverId: 'home', accountId: 'account' },
    isCurrent: () => current,
    onRetire: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  return {
    lifetime,
    retire: () => {
      current = false;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * The Home's usage read and the Account settings store are the substituted boundaries; the Action
 * front door, Coach orchestration and approval policy below the controller are the real owners.
 */
function harness(options: Readonly<{ approve?: boolean }> = {}) {
  const scope = lifetimeHarness();
  const store = new Map<string, unknown>([
    [ANCHOR, false],
    [PREFERENCES, { v: 1, suppressions: [] }],
    [COACH_STATE, { v: 1, suppressions: [] }],
  ]);
  let version = 5;
  const settings = ActionsSettingsV1Schema.parse({
    v: 1,
    ...(options.approve === false ? { actions: {
      'usage.coach.apply': { approvalRequiredSurfaces: ['ui'] },
      'usage.coach.undo': { approvalRequiredSurfaces: ['ui'] },
      'usage.coach.dismiss': { approvalRequiredSurfaces: ['ui'] },
      'usage.coach.snooze': { approvalRequiredSurfaces: ['ui'] },
    } } : {}),
  });
  const deps = {
    usageActions: {
      coachSuppressions: () => createUsageCoachSuppressionPort({ readLegacy: async () => [], transport: {
        read: async () => ({ value: store.get(COACH_STATE), version }),
        compareAndSet: async (value, expected) => {
          if (expected !== version) return { success: false as const, value: store.get(COACH_STATE), version };
          store.set(COACH_STATE, value);
          return { success: true as const, version: ++version };
        },
      } }),
      query: async () => ({
        v: 1 as const,
        results: [
          {
            key,
            requestedQuery: query,
            shownQuery: query,
            coach: evaluation,
            sources: [{ source: 'how_you_work', status: 'available' as const }],
            pending: false,
          },
        ],
      }),
    },
    settingsDeclarationAction: async ({ actionId, input }) => {
      const request = input as {
        anchor: string;
        value?: unknown;
        expectedSettingsVersion?: number;
        reversal?:
          | { kind: 'capture' }
          | {
              kind: 'restore';
              appliedVersion: number;
              before: { value?: unknown; unset?: true };
            };
      };
      if (actionId === 'settings.get')
        return {
          anchor: request.anchor,
          value: store.get(request.anchor),
          settingsVersion: version,
        };
      if (
        (request.expectedSettingsVersion !== undefined &&
          request.expectedSettingsVersion !== version) ||
        (request.reversal?.kind === 'restore' &&
          request.reversal.appliedVersion !== version)
      ) {
        return {
          ok: false,
          errorCode: 'account_settings_mutation_conflict',
          error: 'account_settings_mutation_conflict',
        };
      }
      if (request.reversal?.kind === 'restore') {
        store.set(request.anchor, request.reversal.before.value);
        version += 1;
        return { anchor: request.anchor, value: request.reversal.before.value };
      }
      const before = store.get(request.anchor);
      store.set(request.anchor, request.value);
      version += 1;
      return {
        anchor: request.anchor,
        value: request.value,
        settingsVersion: version,
        ...(request.reversal?.kind === 'capture'
          ? {
              reversal: {
                scope: scope.lifetime.scope,
                beforeVersion: version - 1,
                appliedVersion: version,
                before: { value: before },
                applied: { value: request.value },
              },
            }
          : {}),
      };
    },
    isActionApprovalRequired: (id, context) =>
      isApprovalRequiredByActionsSettings(id, settings, context),
  } satisfies Partial<ActionExecutorDeps>;
  const executor = createActionExecutor(createActionExecutorBoundaryFixture(deps));
  const controller = createUsageCoachController({
    lifetime: scope.lifetime,
    // The substituted host ingress supplies the authenticated human identity;
    // production gets this from the front door, never from the Coach caller.
    executor: { execute: (id, input, context) => executor.execute(id, input,
      { ...context, authority: 'present_user', actionCaller: { kind: 'host' } }) },
  });
  return {
    ...scope,
    controller,
    store,
    bump: () => {
      version += 1;
    },
  };
}

describe('Usage Coach widget controller', () => {
  it('shows refreshed canonical findings after snooze expiry or an external restore in the same mount', async () => {
    const { controller, store } = harness();
    const untilMs = Date.now() + 60_000;
    const rows = (nowMs: number) => projectUsageCoachFindings(applyUsageCoachPreferences(evaluation,
      UsageCoachSuppressionStateV1Schema.parse(store.get(COACH_STATE)), nowMs).findings, controller.getSnapshot(), nowMs);
    try {
      expect((await controller.snooze(query, finding.evidenceKey, untilMs)).ok).toBe(true);
      expect(rows(untilMs - 1).visible).toEqual([]);
      expect(rows(untilMs).visible.map(row => row.evidenceKey)).toEqual([finding.evidenceKey]);
      await controller.snooze(query, finding.evidenceKey, untilMs + 4000);
      store.set(COACH_STATE, { v: 1, suppressions: [] });
      expect(rows(untilMs + 1).visible.map(row => row.evidenceKey)).toEqual([finding.evidenceKey]);
      await controller.dismiss(query, finding.evidenceKey);
      expect(rows(untilMs + 5000).visible).toEqual([]);
      store.set(COACH_STATE, { v: 1, suppressions: [] });
      expect(rows(untilMs + 5001).visible.map(row => row.evidenceKey)).toEqual([finding.evidenceKey]);
    } finally { controller.dispose(); }
  });
  it('keeps digest opt-in within the captured Account and refuses an invalid Automation destination', async () => {
    const { controller, retire } = harness();
    const suggestion = resolveUsagePageAggregation({ queries: [query] }).results[0]!.coach!.digestSuggestion!;
    const schedule = { kind: 'schedule' as const, enabled: true,
      schedule: { kind: 'interval' as const, everyMs: 60_000, scheduleExpr: null, timezone: null } };
    try {
      expect(await controller.createDigest(suggestion, { machineId: 'machine', directory: '' }, schedule))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(controller.getSnapshot()).toMatchObject({ digest: null, error: {
        actionId: 'workflow.trigger.add', evidenceKey: suggestion.queryKey,
      } });
      retire();
      expect(await controller.createDigest(suggestion, { machineId: 'machine', directory: '/repo' }, schedule))
        .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    } finally { controller.dispose(); }
  });
  it('applies through the owner, keeps the exact receipt after the finding, and undoes to the captured value', async () => {
    const { controller, store } = harness();
    const applied = await controller.apply(query, finding);
    expect(applied.ok).toBe(true);
    expect(store.get(ANCHOR)).toBe(true);
    expect(controller.getSnapshot().applied).toEqual([
      expect.objectContaining({
        evidenceKey: finding.evidenceKey,
        undone: false,
      }),
    ]);
    expect(controller.getSnapshot().applied[0]!.result.reversal).toBeDefined();
    const undone = await controller.undo(finding.evidenceKey);
    expect(undone.ok).toBe(true);
    expect(store.get(ANCHOR)).toBe(false);
    expect(controller.getSnapshot().applied[0]!.undone).toBe(true);
    controller.dispose();
  });

  it('refuses Undo after an intervening edit and says so on that finding', async () => {
    const { controller, store, bump } = harness();
    await controller.apply(query, finding);
    bump();
    const undone = await controller.undo(finding.evidenceKey);
    expect(undone).toMatchObject({
      ok: false,
      errorCode: 'account_settings_mutation_conflict',
    });
    expect(store.get(ANCHOR)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      error: { evidenceKey: finding.evidenceKey },
      applied: [expect.objectContaining({ undone: false })],
    });
  });

  it('refuses an Apply the approval policy has not admitted, without claiming it happened', async () => {
    const { controller, store } = harness({ approve: false });
    const result = await controller.apply(query, finding);
    expect(result.ok).toBe(false);
    expect(store.get(ANCHOR)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ applied: [], error: { evidenceKey: finding.evidenceKey }, pending: [] });
  });

  it('dismisses and snoozes exact evidence through Account KV without changing settings', async () => {
    const { controller, store } = harness();
    const state = () => applyUsageCoachPreferences(evaluation,
      UsageCoachSuppressionStateV1Schema.parse(store.get(COACH_STATE)), Date.now()).findings[0]!.state;
    expect((await controller.dismiss(query, finding.evidenceKey)).ok).toBe(
      true,
    );
    expect(UsageCoachSuppressionStateV1Schema.parse(store.get(COACH_STATE)).suppressions).toHaveLength(1);
    expect(state().dismissed).toBe(true);
    const untilMs = Date.now() + 60_000;
    expect((await controller.snooze(query, finding.evidenceKey, untilMs)).ok).toBe(
      true,
    );
    expect(UsageCoachSuppressionStateV1Schema.parse(store.get(COACH_STATE)).suppressions).toHaveLength(1);
    expect(state()).toMatchObject({ dismissed: false, snoozedUntilMs: untilMs });
    expect((await controller.snooze(query, finding.evidenceKey, null)).ok).toBe(true);
    expect(store.get(COACH_STATE)).toMatchObject({ suppressions: [] });
    expect(store.get(PREFERENCES)).toEqual({ v: 1, suppressions: [] });
    await controller.dismiss(query, finding.evidenceKey);
    expect((await controller.dismiss(query, finding.evidenceKey, false)).ok).toBe(true);
    expect(store.get(COACH_STATE)).toMatchObject({ suppressions: [] });
    expect(store.get(PREFERENCES)).toEqual({ v: 1, suppressions: [] });
  });

  it('drops a late result once the captured Account retires', async () => {
    const { controller, retire, store } = harness();
    const pending = controller.apply(query, finding);
    retire();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_account_scope_changed',
    });
    expect(controller.getSnapshot()).toMatchObject({
      retired: true,
      applied: [],
    });
  });
});
