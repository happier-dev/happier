import { describe, expect, it, vi } from 'vitest';

import {
  SessionStopOutcomeSchema,
  isSessionStopConfirmed,
  type SessionStopOutcome,
} from '@happier-dev/protocol';

import { runSessionAgentTransition } from './sessionAgentTransitionCoordinator';
import {
  buildTransitionRequest,
  createTransitionDepsHarness,
  TEST_CREDENTIALS,
  TEST_LOCAL_ID,
} from './sessionAgentTransitionTestkit';

/**
 * QA-T-04: no target effect before a fully confirmed stop.
 *
 * The plan body (section 7.2) and the frozen result union supersede the QA
 * matrix row's older text: an UNCONFIRMED stop means the source may already be
 * gone, so `sourceEffect: 'none'` would be a lie and the outcome is
 * `outcome_unknown`. `source_stop_failed` is reserved for the one stop result
 * that PROVES the source is still running.
 */

/** Flattens a `z.literal` / `z.enum` / `z.union` of those into its string members. */
function readReasonLiterals(schema: unknown): readonly string[] {
  const node = schema as Readonly<{ value?: unknown; options?: unknown }>;
  if (typeof node.value === 'string') return [node.value];
  if (!Array.isArray(node.options)) return [];
  return node.options.flatMap((option: unknown) =>
    typeof option === 'string' ? [option] : readReasonLiterals(option));
}

/**
 * Every `{ status, reason }` an unconfirmed stop can carry, read out of
 * `SessionStopOutcomeSchema` rather than hand-listed, minus the outcomes the
 * stop owner's own predicate calls CONFIRMED. The union now carries one of
 * those (`already_stopped`), and asking `isSessionStopConfirmed` instead of
 * hand-excluding it keeps this suite derived: a future confirmed arm leaves
 * automatically and a future unconfirmed arm is pinned the day it exists.
 *
 * Section 7.2 step 6 is unconditional, and the shape of its recurring violation
 * is an allowlist of reason strings believed to prove "nothing was signalled"
 * (remote-dev shipped one; ten of its entries produced `rejected` here). Reason
 * strings cannot carry that proof: `stopSession.ts` emits `legacy_attachment`,
 * `attachment_mismatch`, `missing_topology_proof`,
 * `terminal_host_adapter_unavailable` and `disposition_in_progress` both from
 * its pre-signal gates AND from the terminal-host disposition that runs after
 * SIGTERM with the runner exit already proven. Deriving the cases from the
 * producing union means a reason added there is pinned the day it exists.
 */
function everyUnconfirmedStopOutcome(): ReadonlyArray<readonly [string, SessionStopOutcome]> {
  const cases = SessionStopOutcomeSchema.options.flatMap((option) => {
    const shape = (option as unknown as Readonly<{
      shape: Readonly<{ status: Readonly<{ value: string }>; reason: unknown }>;
    }>).shape;
    const status = shape.status.value;
    return readReasonLiterals(shape.reason).map((reason) => [
      `${status}/${reason}`,
      SessionStopOutcomeSchema.parse({ status, reason }),
    ] as const);
  }).filter(([, stopOutcome]) => !isSessionStopConfirmed({
    sessionId: 'session-1',
    stopped: false,
    stopOutcome,
  }));
  // A zod change that broke the introspection above would silently turn this
  // suite into a no-op.
  const reasons = new Set(cases.map(([, outcome]) => outcome.reason));
  if (!reasons.has('missing_topology_proof') || !reasons.has('runner_exit_timeout')) {
    throw new Error('SessionStopOutcomeSchema introspection produced no usable stop reasons');
  }
  // The confirmed arm must really have left, or the filter above is a no-op and
  // the positive case below would be contradicted by this suite.
  if (reasons.has('no_runtime_session_inactive')) {
    throw new Error('a confirmed stop outcome leaked into the unconfirmed cases');
  }
  return cases;
}

describe('runSessionAgentTransition — confirmed stop gates every target effect (QA-T-04)', () => {
  it.each(everyUnconfirmedStopOutcome())(
    'maps the unconfirmed stop outcome %s to outcome_unknown with no target effect',
    async (_label, stopOutcome) => {
      const harness = createTransitionDepsHarness({
        requestSessionStop: vi.fn(async () => ({
          ok: true as const,
          sessionId: 'session-1',
          stopped: false as const,
          stopOutcome,
        })) as never,
      });

      const result = await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: harness.deps,
      });

      expect(result).toEqual({ type: 'outcome_unknown', localId: TEST_LOCAL_ID });
      expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
      expect(harness.deps.requestInactiveSessionResume).not.toHaveBeenCalled();
      expect(harness.deps.sendSessionMessage).not.toHaveBeenCalled();
    },
  );

  /**
   * The reproduced user failure: a Session whose runtime is long gone could
   * never be switched. The stop owner answered `not_found`, the coordinator read
   * that as unconfirmed, and the transition ended at `outcome_unknown` before
   * cutover — three times in a row, with no divider and no spawn.
   *
   * A cold Session IS stopped. The owner now says so with a confirmed arm, and
   * the transition must run to completion on it exactly as it does after
   * signalling a live runtime — same order, same effects.
   */
  it('completes the transition for a cold Session the stop owner confirms is already stopped', async () => {
    const harness = createTransitionDepsHarness();
    harness.deps.requestSessionStop = vi.fn(async () => {
      harness.calls.push('stop');
      return {
        ok: true as const,
        sessionId: 'session-1',
        stopped: false as const,
        stopOutcome: SessionStopOutcomeSchema.parse({
          status: 'already_stopped',
          reason: 'no_runtime_session_inactive',
        }),
      };
    }) as never;

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    expect(harness.calls).toEqual([
      'resolveTransport',
      'waitForIdle',
      'admission:enforce',
      'resolveTransport',
      'stop',
      'resolveTransport',
      'cutover',
      'admission:clear',
      'send',
      'resolveTransport',
      'resume',
    ]);
  });

  it('maps a resolution failure before any stop attempt to source_stop_failed and reopens its fence', async () => {
    const harness = createTransitionDepsHarness({
      requestSessionStop: vi.fn(async () => ({
        ok: false as const,
        code: 'session_id_ambiguous' as const,
      })) as never,
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({
      type: 'rejected',
      code: 'source_stop_failed',
      sourceEffect: 'none',
    });
    expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
    // `ok: false` is produced by the stop owner's identity-resolution return,
    // before it can address a runner. Its exact admission epoch is therefore
    // reopened alongside the truthful untouched-source result.
    expect(harness.calls.filter((call) => call === 'admission:clear')).toHaveLength(1);
  });

  it('runs quiesce, confirmed stop, cutover, input custody and activation in that exact order', async () => {
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    // Input custody is taken BEFORE activation: `sendSessionMessage` is
    // enqueue-then-resume, so starting a runtime with no durable Pending row
    // behind it would create unrecoverable work if that window failed. This is
    // safe only because it happens AFTER cutover — the source is confirmed
    // stopped and the Session already IS the target, so the row can only ever be
    // claimed by the target. It is not the held carrier section 1.3 removed.
    expect(harness.calls).toEqual([
      'resolveTransport',
      'waitForIdle',
      'admission:enforce',
      'resolveTransport',
      'stop',
      'resolveTransport',
      'cutover',
      'admission:clear',
      'send',
      'resolveTransport',
      'resume',
    ]);
  });

  it('reconciles an already-committed cutover even when the target left this daemon catalog', async () => {
    // Whether the Session already IS the requested target is a fact about the
    // committed current view, not about what this daemon can currently launch.
    // Gating the reconcile on catalog resolution means an Agent that was
    // disabled or unloaded between the cutover and the retry sends the caller
    // back through `stale_selection` — `sourceEffect: 'none'` — although the
    // source is confirmed stopped and the view is committed. The reconcile
    // itself never needs the resolved target: it matches the divider against
    // the REQUESTED selection.
    const harness = createTransitionDepsHarness({
      readAgentCatalogSnapshot: vi.fn(() => ({
        agentDefinitionsById: new Map([
          ['claude', { id: 'claude', identity: { pluginId: 'claude', localId: 'claude' } }],
        ]),
        catalogEntriesById: {},
      })) as never,
    });
    harness.setMetadata({ flavor: 'codex', machineId: 'machine-1', path: '/home/u/project' });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).not.toMatchObject({ type: 'rejected' });
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
  });

  it('reopens the exact epoch when the fence call itself cannot prove it was not installed', async () => {
    // The enforce call is not atomic from the caller's side. `enforce` reaches
    // the session runtime over a session RPC and
    // `requestSessionProviderInputAdmission` THROWS for every non-`enforced`
    // outcome, including a transport error raised after the request was
    // delivered and applied. So a thrown enforce does not prove "no fence" — it
    // proves "no ANSWER".
    //
    // Returning `rejected` there asserts `sourceEffect: 'none'`, which the UI
    // turns into Keep editing, in front of a source whose local provider-input
    // admission may be closed. The user then types and sends into a runtime
    // that silently refuses the input. Section 7.2 requires every exit after
    // the fence step and before the confirmed stop to reopen that exact epoch
    // first; an unprovable enforce is such an exit.
    const harness = createTransitionDepsHarness();
    harness.deps.callSessionProviderInputAdmission = vi.fn(async (input: { action: string }) => {
      harness.calls.push(`admission:${input.action}`);
      if (input.action === 'enforce') throw new Error('provider_input_admission_not_enforced');
      return { status: 'cleared' as const };
    }) as never;

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' });
    expect(harness.calls.filter((call) => call === 'admission:clear')).toHaveLength(1);
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
  });

  it('takes custody only from the message owner, leaving one activation decision-maker', async () => {
    // `sendSessionMessage` activates an inactive Session itself unless the
    // caller opts out (`resumeInactiveSession: false`, the same opt-out the
    // connected-service continuation dispatcher already uses). Leaving it on
    // gives the transition TWO owners for one concept:
    //
    //  - the message owner spawns the target right after the enqueue, and
    //  - section 7.4's explicit activation spawns it AGAIN, because
    //    `requestInactiveSessionResume` returns as soon as the spawn RPC is
    //    acknowledged and the row's `active` flag has not flipped yet.
    //
    // It also mislabels the public result: an activation failure inside the
    // admission call returns `ok: false` from the SEND, which the coordinator
    // maps to `input_admission_failed` — sending the client to re-admit a
    // message that is already in durable custody instead of starting the
    // target, which is the recovery section 7.5 assigns to
    // `target_start_failed`.
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    expect(harness.calls).not.toContain('send:resume');
    expect(harness.calls.filter((call) => call === 'resume')).toHaveLength(1);
  });

  it('captures transcript head U only after the confirmed stop', async () => {
    const observed: number[] = [];
    const harness = createTransitionDepsHarness({
      buildActivationBrief: vi.fn((input: { transcriptHeadSeqInclusive: number }) => {
        observed.push(input.transcriptHeadSeqInclusive);
        return { status: 'available' as const, seed: null };
      }) as never,
    });

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(observed).toEqual([42]);
    expect(harness.calls.indexOf('stop')).toBeLessThan(harness.calls.indexOf('cutover'));
  });

  it('reports a failed post-stop source re-read as source_stopped/context_unavailable', async () => {
    // Section 6.1 partitions the post-stop, pre-write depth by CAUSE: a bounded
    // source read/decryption failure is `context_unavailable`, and
    // `cutover_conflict` is reserved for current-view active/archive/version
    // loss. The third `resolveSessionTransportContext` call is the post-stop
    // re-read, so its failure is a read failure and must not claim a conflict
    // the daemon never observed.
    let resolveCalls = 0;
    const harness = createTransitionDepsHarness();
    const resolveOk = harness.deps.resolveSessionTransportContext;
    harness.deps.resolveSessionTransportContext = (async (input: never) => {
      resolveCalls += 1;
      if (resolveCalls === 3) {
        harness.calls.push('resolveTransport');
        return { ok: false as const, code: 'session_not_found' as const };
      }
      return await resolveOk(input);
    }) as typeof harness.deps.resolveSessionTransportContext;

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'source_stopped',
      code: 'context_unavailable',
    });
    expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
  });

  it('reports an unavailable bounded context pass as source_stopped/context_unavailable', async () => {
    const harness = createTransitionDepsHarness({
      buildActivationBrief: vi.fn(() => ({ status: 'unavailable' as const })),
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'source_stopped',
      code: 'context_unavailable',
    });
    expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
  });
});
