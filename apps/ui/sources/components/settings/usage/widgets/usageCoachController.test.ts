import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import {
  getUsageQueryKey,
  normalizeUsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import { evaluateUsageCoach } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createUsageCoachController } from './usageCoachController';

const ANCHOR = 'usage.exampleCoachSetting';
const PREFERENCES = 'usage.coachPreferences';
const query = normalizeUsageQuery({
  period: { startMs: 0, endMs: 1000 },
  granularity: 'day',
});
const key = getUsageQueryKey(query);
const compactions = [
  { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't' },
  { evidenceId: 'c2', observedAtMs: 20, sessionId: 's', turnId: 't' },
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
      evidenceIds: ['c1', 'c2'],
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
  ]);
  let version = 5;
  const settings = ActionsSettingsV1Schema.parse({
    v: 1,
    ...(options.approve === false
      ? {}
      : {
          approvalWaivedSurfaces: {
            'usage.coach.apply': ['ui'],
            'usage.coach.undo': ['ui'],
            'usage.coach.dismiss': ['ui'],
            'usage.coach.snooze': ['ui'],
            'settings.set': ['ui'],
          },
        }),
  });
  const deps = {
    usageActions: {
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
    executor,
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

  it('dismisses and snoozes the exact evidence through Account preferences and hides it in this mount', async () => {
    const { controller, store } = harness();
    expect((await controller.dismiss(query, finding.evidenceKey)).ok).toBe(
      true,
    );
    expect(store.get(PREFERENCES)).toMatchObject({
      suppressions: [{ kind: 'dismissed', evidenceKey: finding.evidenceKey }],
    });
    expect(controller.getSnapshot().hiddenEvidenceKeys).toEqual([
      finding.evidenceKey,
    ]);
    expect((await controller.snooze(query, finding.evidenceKey, 5000)).ok).toBe(
      true,
    );
    expect(store.get(PREFERENCES)).toMatchObject({
      suppressions: [
        { kind: 'snoozed', evidenceKey: finding.evidenceKey, untilMs: 5000 },
      ],
    });
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
