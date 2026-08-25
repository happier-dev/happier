import { describe, expect, it } from 'vitest';

import {
  createActionExecutor,
  DEFAULT_ACTIONS_SETTINGS_V1,
  getActionSpec,
  isApprovalRequiredByActionsSettings,
  isInternalActionId,
  RUNTIME_ACTION_IDS_V1,
  type ActionExecutorContext,
  type ActionExecutorDeps,
  type ActionId,
  type ApprovalRequestV1,
  type RuntimeActionExecute,
} from '@happier-dev/protocol';

/**
 * Layer coverage for the approval floor (LANE-CONSENT / CON-1..6, root cause D — the agent-browser consent hole).
 *
 * This is the policy/executor proof that the agent-initiated approval FLOOR is derived
 * from the danger SSOT and is actually ENFORCED by the assembled action executor — not merely
 * declared in a policy table. It drives the REAL protocol `createActionExecutor` wired exactly as
 * production (`apps/ui/.../defaultActionExecutor.ts`) routes approvals through
 * `isApprovalRequiredByActionsSettings`. The only stubbed seams are the two real SYSTEM boundaries:
 *   - the runtime-action leaf (the daemon RPC transport), and
 *   - the approvals store (persistence/await transport).
 * There are NO internal mocks: the executor, the approval-routing logic, the danger-floor derivation
 * and every ActionSpec are the production singletons.
 *
 * Two layers of proof:
 *   1. POLICY CONTRACT over the COMPLETE SSOT-derived verb set: every mutating/navigating browser
 *      verb + `localServices.launcher.start` + `browser.recording.start` + `browser.diagnostics.eval`
 *      (every `safety:'danger'` runtime action that is surfaced on `agent`) is floored on
 *      `agent` and NEVER on `ui`; the read-only agent verbs are NOT floored. This is the
 *      exact predicate the executor consults, iterated over the real `RUNTIME_ACTION_IDS_V1` so it
 *      cannot drift from a hand-list.
 *   2. ASSEMBLED-EXECUTOR ROUND-TRIP for a real danger+agent verb with a valid input
 *      (`localServices.launcher.start`): on `agent` the dispatch is diverted into the
 *      approvals store FIRST and the runtime leaf is gated (reject → leaf never runs; approve →
 *      leaf runs); on `ui` it runs straight through with no approval. This proves the floor is
 *      load-bearing through the same executor an agent tool-call flows through.
 */

const EMPTY_SETTINGS = DEFAULT_ACTIONS_SETTINGS_V1;

function isFlooredVerbId(id: ActionId): boolean {
  const spec = getActionSpec(id);
  return spec.safety === 'danger' && spec.surfaces.agent === true;
}

/**
 * The complete agent-floored verb set, DERIVED from the SSOT: every runtime action that is
 * `safety:'danger'` AND surfaced on `agent`. The CON lane classifies every mutating/
 * navigating browser verb (`browser.*`, `browser.automation.*`), `browser.recording.start`,
 * `browser.diagnostics.eval` and `localServices.launcher.start` as `danger`, so they land here
 * automatically. Read-only verbs (`safety:'safe'`) are excluded by construction.
 */
const FLOORED_DANGER_AGENT_VERBS: readonly ActionId[] = RUNTIME_ACTION_IDS_V1.filter(isFlooredVerbId);

/**
 * A guard set: the headline verbs that must not lose the floor by accident. If a future edit
 * silently flips one of these to `safe` or drops its `agent` surface, the consent hole
 * re-opens — this list fails loudly rather than letting the derivation go quietly empty.
 *
 * The ONE accepted way off the floor is the canonical internal-action registry
 * (`INTERNAL_ACTION_REASONS` in `actionSpecs.ts`, read here through `isInternalActionId`): an id
 * recorded there is deliberately unreachable from every public surface with a written reason, so it
 * cannot be agent-floored and must not be. Anything else losing `danger`+`agent` is a regression.
 * The assertion below is therefore a branch on the registry rather than a shortened hand list —
 * deleting an id from this array would silently retire its guard.
 */
const REQUIRED_FLOORED_VERBS: readonly ActionId[] = [
  'browser.navigate',
  'browser.reload',
  'browser.goBack',
  'browser.goForward',
  'browser.stop',
  'browser.view.open',
  'browser.view.close',
  'browser.automation.navigate',
  'browser.automation.click',
  'browser.automation.tap',
  'browser.automation.type',
  'browser.automation.press',
  'browser.automation.scroll',
  'browser.automation.hover',
  'browser.automation.focus',
  'browser.automation.select',
  'browser.automation.setValue',
  'browser.recording.start',
  'browser.diagnostics.eval',
  'localServices.launcher.start',
];

/**
 * Read-only agent verbs that carry no egress/input/mutation and MUST NOT prompt — proving the floor
 * is a precise SUBSET, not a blanket gate that would wrongly prompt safe reads.
 */
const READ_ONLY_AGENT_VERBS: readonly ActionId[] = [
  'browser.automation.status',
  'browser.automation.snapshot',
  'browser.automation.semanticSnapshot',
  'browser.automation.queryElements',
  'browser.automation.waitFor',
  'browser.automation.timeline.get',
  'browser.view.focus',
  'browser.target.set',
];

// A real danger+agent verb with a cheap, fully-valid input so the assembled executor can be
// driven all the way to the approval gate (the browser nav/recording/diagnostics inputs require a
// live browser/view identity; launcher.start needs only machine + target ids).
const EXECUTOR_DRIVE_ACTION_ID: ActionId = 'localServices.launcher.start';
const EXECUTOR_DRIVE_INPUT = { machineId: 'machine_1', targetId: 'managed:web' } as const;

/**
 * The runtime leaf stands in for the daemon RPC transport, so what it returns must be what the
 * daemon really returns: `createActionExecutor` projects every successful built-in Action through
 * its declared `outputSchema` (`actionExecutor.ts` `settleActionOutput`) and answers
 * `invalid_action_output` otherwise. A leaf returning an invented shape makes an approved dispatch
 * indistinguishable from a rejected one.
 */
const EXECUTOR_DRIVE_LEAF_RESULT = {
  protocolVersion: 1,
  machineId: EXECUTOR_DRIVE_INPUT.machineId,
  targetId: EXECUTOR_DRIVE_INPUT.targetId,
  status: 'succeeded',
  snapshot: {
    v: 1,
    machineId: EXECUTOR_DRIVE_INPUT.machineId,
    updatedAt: 1_000,
    targets: [],
  },
} as const;

function unsupportedDep(): never {
  throw new Error('unexpected executor dependency invocation');
}

/**
 * Builds the production-wired executor. Approval routing is decided by the REAL
 * `isApprovalRequiredByActionsSettings` (exactly as `defaultActionExecutor.ts` wires it). The
 * runtime leaf and approvals store are the only seams provided, and they ARE the system boundaries
 * (RPC + persistence). Every other dep is a rejecting stub so an accidental extra dependency surfaces.
 */
function createProductionWiredExecutor(input: Readonly<{
  runtimeLeaf: RuntimeActionExecute;
  decision: 'approve' | 'reject';
  onApprovalsCreate: () => void;
  onApprovalsWait: () => void;
}>) {
  const deps = {
    runtimeActionExecute: input.runtimeLeaf,
    approvalsCreate: async () => {
      input.onApprovalsCreate();
      return { artifactId: 'approval_floor_e2e' };
    },
    approvalsUpdate: async () => ({ ok: true as const }),
    approvalsWaitForDecision: async (args: { request: ApprovalRequestV1 }) => {
      input.onApprovalsWait();
      return {
        decision: input.decision,
        request: {
          ...args.request,
          status: input.decision === 'approve' ? ('approved' as const) : ('rejected' as const),
        },
      };
    },
    isActionApprovalRequired: (actionId: ActionId, ctx: ActionExecutorContext) =>
      isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: ctx.surface ?? null }),
    executionRunStart: unsupportedDep,
    sessionOpen: unsupportedDep,
  } as unknown as ActionExecutorDeps;
  return createActionExecutor(deps);
}

describe('core layer: agent approval floor enforced by the assembled executor', () => {
  it('derives a non-empty danger floor that contains every headline mutating/navigating verb', () => {
    expect(FLOORED_DANGER_AGENT_VERBS.length).toBeGreaterThan(0);
    const flooredSet = new Set<ActionId>(FLOORED_DANGER_AGENT_VERBS);
    for (const id of REQUIRED_FLOORED_VERBS) {
      // Still `danger` regardless of reachability — the safety classification is what the floor
      // derives from, and downgrading it is always a regression.
      expect(getActionSpec(id).safety).toBe('danger');
      if (isInternalActionId(id)) {
        // Deliberately unreachable with a recorded reason: it must be off EVERY public surface, not
        // merely off `agent`. A "internal" id that is still agent-dispatchable would be the actual
        // hole, so this branch is an assertion, not an exemption.
        expect(getActionSpec(id).surfaces.agent).toBe(false);
        expect(getActionSpec(id).surfaces.api).toBe(false);
        expect(flooredSet.has(id)).toBe(false);
        continue;
      }
      expect(getActionSpec(id).surfaces.agent).toBe(true);
      expect(flooredSet.has(id)).toBe(true);
    }
  });

  it('keeps every headline verb reachable (an internal-registry escape cannot empty the floor)', () => {
    // Guards the branch above: routing a headline verb through `INTERNAL_ACTION_REASONS` satisfies
    // every per-id assertion (internal ids are legitimately off `agent`/`api` and off the floor),
    // so without this the floor could be emptied one silent escape at a time. NO headline verb is
    // internal today, so the ceiling is zero: it is a forward-only gate, not a tolerance. It
    // previously allowed two, sized for `browser.session.create`/`.close` — the only headline verbs
    // that ever took the escape — and kept that slack after both ids were contracted away.
    const reachable = REQUIRED_FLOORED_VERBS.filter((id) => !isInternalActionId(id));
    expect(reachable).toEqual([...REQUIRED_FLOORED_VERBS]);
  });

  it('floors EVERY danger+agent verb on agent and NEVER on ui (policy contract the executor consults)', () => {
    for (const id of FLOORED_DANGER_AGENT_VERBS) {
      expect(isApprovalRequiredByActionsSettings(id, EMPTY_SETTINGS, { surface: 'agent' })).toBe(true);
      // User-initiated dispatches never prompt by default.
      expect(isApprovalRequiredByActionsSettings(id, EMPTY_SETTINGS, { surface: 'ui' })).toBe(false);
    }
  });

  it('does NOT floor read-only agent verbs (the floor is a precise subset, not a blanket gate)', () => {
    for (const id of READ_ONLY_AGENT_VERBS) {
      expect(getActionSpec(id).safety).toBe('safe');
      expect(isApprovalRequiredByActionsSettings(id, EMPTY_SETTINGS, { surface: 'agent' })).toBe(false);
      expect(isApprovalRequiredByActionsSettings(id, EMPTY_SETTINGS, { surface: 'ui' })).toBe(false);
    }
  });

  it('gates a real danger verb behind approval on agent — rejected → runtime leaf never runs', async () => {
    let leafCalls = 0;
    let created = 0;
    let waited = 0;
    const executor = createProductionWiredExecutor({
      decision: 'reject',
      runtimeLeaf: async () => {
        leafCalls += 1;
        return EXECUTOR_DRIVE_LEAF_RESULT;
      },
      onApprovalsCreate: () => { created += 1; },
      onApprovalsWait: () => { waited += 1; },
    });

    const result = await executor.execute(EXECUTOR_DRIVE_ACTION_ID, EXECUTOR_DRIVE_INPUT, { surface: 'agent' });

    // OUTCOME: the agent dispatch was diverted into the approvals store BEFORE the leaf, and the
    // leaf is gated behind the (rejected) decision.
    expect(created).toBe(1);
    expect(waited).toBe(1);
    expect(leafCalls).toBe(0);
    expect(result).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
  });

  it('runs the same danger verb directly on ui — no approval prompt', async () => {
    let leafCalls = 0;
    let created = 0;
    const executor = createProductionWiredExecutor({
      decision: 'reject',
      runtimeLeaf: async () => {
        leafCalls += 1;
        return EXECUTOR_DRIVE_LEAF_RESULT;
      },
      onApprovalsCreate: () => { created += 1; },
      onApprovalsWait: () => {},
    });

    const result = await executor.execute(EXECUTOR_DRIVE_ACTION_ID, EXECUTOR_DRIVE_INPUT, { surface: 'ui' });

    expect(created).toBe(0);
    expect(leafCalls).toBe(1);
    // The leaf's payload survives the executor's declared-output projection, so `ok:true` here means
    // "the real launcher response reached the caller", not merely "no approval was demanded".
    expect(result).toMatchObject({ ok: true, result: { status: 'succeeded', targetId: EXECUTOR_DRIVE_INPUT.targetId } });
  });

  it('runs the danger verb on agent once approval is granted', async () => {
    let leafCalls = 0;
    let created = 0;
    let waited = 0;
    const executor = createProductionWiredExecutor({
      decision: 'approve',
      runtimeLeaf: async () => {
        leafCalls += 1;
        return EXECUTOR_DRIVE_LEAF_RESULT;
      },
      onApprovalsCreate: () => { created += 1; },
      onApprovalsWait: () => { waited += 1; },
    });

    const result = await executor.execute(EXECUTOR_DRIVE_ACTION_ID, EXECUTOR_DRIVE_INPUT, { surface: 'agent' });

    // OUTCOME: approval was still required (created + awaited), then the leaf ran post-approval.
    expect(created).toBe(1);
    expect(waited).toBe(1);
    expect(leafCalls).toBe(1);
    expect(result).toMatchObject({ ok: true, result: { status: 'succeeded', targetId: EXECUTOR_DRIVE_INPUT.targetId } });
  });
});
