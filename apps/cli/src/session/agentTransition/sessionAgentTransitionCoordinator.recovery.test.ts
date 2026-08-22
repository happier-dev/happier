import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1,
  SESSION_AGENT_TRANSITION_REJECTED_CODES_V1,
  SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1,
  SessionAgentTransitionResultV1Schema,
  type SessionAgentTransitionResultV1,
} from '@happier-dev/protocol';

import { runSessionAgentTransition } from './sessionAgentTransitionCoordinator';
import {
  buildTransitionRequest,
  createTransitionDepsHarness,
  TEST_CREDENTIALS,
  TEST_LOCAL_ID,
  type TransitionDepsHarness,
} from './sessionAgentTransitionTestkit';

/**
 * The section 7.5 facts -> meaning -> result projection, one discriminating
 * case per row, plus the invariant that makes the whole partition safe.
 */

const TARGET_CURRENT_METADATA = {
  flavor: 'codex',
  machineId: 'machine-1',
  codexSessionId: 'codex-1',
} as const;

function foundDivider(
  payload: Readonly<{ fromAgentId: string; toAgentId: string; sourceCutoffSeqInclusive?: number }>,
  storedRecord: Readonly<{ role?: string; contentType?: string }> = {},
) {
  return {
    type: 'found' as const,
    message: {
      id: 'm1',
      seq: 77,
      localId: `agent-transition:${TEST_LOCAL_ID}`,
      sidechainId: null,
      createdAt: 1,
      updatedAt: 1,
      content: {
        t: 'plain',
        v: {
          role: storedRecord.role ?? 'agent',
          content: {
            type: storedRecord.contentType ?? 'event',
            id: `agent-transition:${TEST_LOCAL_ID}`,
            data: {
              type: 'message',
              message: 'Continued with another Agent.',
              sessionAgentTransitionV1: { v: 1, sourceCutoffSeqInclusive: 29_979, ...payload },
            },
          },
        },
      },
    },
  };
}

async function runTransition(harness: TransitionDepsHarness): Promise<SessionAgentTransitionResultV1> {
  const result = await runSessionAgentTransition({
    credentials: TEST_CREDENTIALS,
    request: buildTransitionRequest(),
    deps: harness.deps,
  });
  // Every produced result must satisfy the frozen partitioned union.
  return SessionAgentTransitionResultV1Schema.parse(result);
}

describe('section 7.5 recovery projection', () => {
  it('row 1 — source still current and still running, no divider: rejected with sourceEffect none', async () => {
    const harness = createTransitionDepsHarness({
      requestSessionStop: vi.fn(async () => ({
        ok: false as const,
        code: 'session_not_found' as const,
      })) as never,
    });

    expect(await runTransition(harness)).toEqual({
      type: 'rejected',
      code: 'source_stop_failed',
      sourceEffect: 'none',
    });
  });

  it('row 2 — stopped with nothing committed: partially_applied at source_stopped', async () => {
    const harness = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: vi.fn(async () => ({
        ok: false as const,
        effect: 'none' as const,
        error: 'session-active' as const,
      })),
    });

    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'source_stopped',
      code: 'cutover_conflict',
    });
  });

  it('row 3 — target current, divider absent: divider_missing', async () => {
    const harness = createTransitionDepsHarness();
    harness.setMetadata({ ...TARGET_CURRENT_METADATA });

    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'divider_missing',
    });
  });

  it('row 4 — target current with a matching divider, admission missing: input_admission_failed', async () => {
    const harness = createTransitionDepsHarness({
      findTranscriptMessageByLocalId: vi.fn(async () => foundDivider({
        fromAgentId: 'claude',
        toAgentId: 'codex',
      })) as never,
      sendSessionMessage: vi.fn(async () => ({
        ok: false as const,
        code: 'timeout' as const,
        admissionResult: {
          status: 'outcomeUnknown' as const,
          localId: TEST_LOCAL_ID,
          code: 'account_admission_acknowledgement_failed' as const,
        },
      })) as never,
    });
    harness.setMetadata({ ...TARGET_CURRENT_METADATA });

    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'input_admission_failed',
    });
  });

  it('row 5 — target current, matching divider, input admitted: accepted', async () => {
    const harness = createTransitionDepsHarness({
      findTranscriptMessageByLocalId: vi.fn(async () => foundDivider({
        fromAgentId: 'claude',
        toAgentId: 'codex',
      })) as never,
    });
    harness.setMetadata({ ...TARGET_CURRENT_METADATA });

    expect(await runTransition(harness)).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
  });

  it('refuses a reserved-localId row whose stored payload is not an agent event', async () => {
    // The server's cutover owner will not call a stored row this transition's
    // divider unless it is a `role:'agent'` / `content.type:'event'` record.
    // The daemon reader is the only other party that decides the same question
    // — over a row it decrypts itself — so it must apply the same two checks.
    // A planted user-role (or non-event) row carrying a matching sidecar must
    // never be read as this operation's own divider.
    for (const forged of [
      { role: 'user', contentType: 'event' },
      { role: 'agent', contentType: 'output' },
    ] as const) {
      const harness = createTransitionDepsHarness({
        findTranscriptMessageByLocalId: vi.fn(async () => foundDivider(
          { fromAgentId: 'claude', toAgentId: 'codex' },
          forged,
        )) as never,
      });
      harness.setMetadata({ ...TARGET_CURRENT_METADATA });

      expect(await runTransition(harness)).toEqual({
        type: 'partially_applied',
        localId: TEST_LOCAL_ID,
        applied: 'current_view_committed',
        code: 'divider_unknown',
      });
    }
  });

  it('row 6 — target current, matching divider, target not running: target_start_failed', async () => {
    const harness = createTransitionDepsHarness({
      findTranscriptMessageByLocalId: vi.fn(async () => foundDivider({
        fromAgentId: 'claude',
        toAgentId: 'codex',
      })) as never,
      requestInactiveSessionResume: vi.fn(async () => ({
        ok: false as const,
        code: 'unsupported' as const,
        message: 'resume rejected',
      })),
    });
    harness.setMetadata({ ...TARGET_CURRENT_METADATA });

    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'target_start_failed',
    });
  });

  it('row 7 — a divider carrying a different transition payload is never overwritten', async () => {
    const harness = createTransitionDepsHarness({
      findTranscriptMessageByLocalId: vi.fn(async () => foundDivider({
        fromAgentId: 'gemini',
        toAgentId: 'codex',
      })) as never,
    });
    harness.setMetadata({ ...TARGET_CURRENT_METADATA });

    // Known, not indeterminate: the view is committed and the reserved localId
    // is occupied by a different transition. Preserve the draft, do not retry
    // the switch, and never overwrite the row.
    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'divider_conflict',
    });
    expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
    expect(harness.deps.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('row 8 — an indeterminate transport outcome carries no code', async () => {
    const harness = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: vi.fn(async () => ({
        ok: false as const,
        effect: 'unknown' as const,
        error: 'transport' as const,
      })),
    });

    expect(await runTransition(harness)).toEqual({ type: 'outcome_unknown', localId: TEST_LOCAL_ID });
  });

  it('retries the current-view CAS exactly once before reporting cutover_conflict', async () => {
    const attempts: string[] = [];
    const harness = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: vi.fn(async () => {
        attempts.push('cutover');
        return { ok: false as const, effect: 'none' as const, error: 'version-mismatch' as const };
      }),
    });

    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'source_stopped',
      code: 'cutover_conflict',
    });
    expect(attempts).toHaveLength(2);
  });

  it('reports a committed view with a refused divider as divider_conflict, not divider_missing', async () => {
    const harness = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: vi.fn(async () => ({
        ok: false as const,
        effect: 'current_view_committed' as const,
        error: 'divider-conflict' as const,
      })),
    });

    // A row EXISTS at the reserved localId carrying a different payload. Naming
    // it `divider_missing` would send the client into resume-and-send recovery,
    // let a retry re-derive the same conflict forever, and let the bounded
    // context pass trust a divider naming the wrong target.
    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'divider_conflict',
    });
  });

  it('row 9 — target current, divider unreadable: still a committed-depth result', async () => {
    const harness = createTransitionDepsHarness({
      findTranscriptMessageByLocalId: vi.fn(async () => ({
        type: 'protocol_error' as const,
        error: null,
      })) as never,
    });
    harness.setMetadata({ ...TARGET_CURRENT_METADATA });

    // The Session ALREADY NAMES THE TARGET — this operation's own cutover seen
    // again — and only the divider row could not be read. `outcome_unknown`
    // claims the daemon cannot establish whether the cutover happened, which is
    // false here, and the UI answers it by KEEPING the armed switch in front of
    // a Session that has already switched. The depth is known; only the
    // boundary row is not.
    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'divider_unknown',
    });
  });

  it('still reports a genuinely failed divider write as divider_missing', async () => {
    const harness = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: vi.fn(async () => ({
        ok: false as const,
        effect: 'current_view_committed' as const,
        error: 'divider-rejected' as const,
      })),
    });

    expect(await runTransition(harness)).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'divider_missing',
    });
  });
});

describe('no code reachable after a confirmed stop rides `rejected`', () => {
  it('partitions the frozen code lists so the two sets never overlap', () => {
    const postStopCodes = new Set<string>([
      ...SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1,
      ...SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1,
    ]);
    const overlapping = SESSION_AGENT_TRANSITION_REJECTED_CODES_V1.filter(
      (code) => postStopCodes.has(code),
    );

    expect(overlapping).toEqual([]);
  });

  it('never produces a `rejected` result once requestSessionStop has confirmed the stop', async () => {
    // Every failure that can occur AFTER a confirmed stop, exercised through the
    // real mapper. None may claim an untouched source.
    const postStopFailures: readonly Partial<Parameters<typeof createTransitionDepsHarness>[0]>[] = [
      { buildActivationBrief: vi.fn(() => ({ status: 'unavailable' as const })) },
      {
        applySessionAgentTransitionCutover: vi.fn(async () => ({
          ok: false as const, effect: 'none' as const, error: 'archived' as const,
        })),
      },
      {
        applySessionAgentTransitionCutover: vi.fn(async () => ({
          ok: false as const, effect: 'none' as const, error: 'forbidden' as const,
        })),
      },
      {
        applySessionAgentTransitionCutover: vi.fn(async () => ({
          ok: false as const, effect: 'current_view_committed' as const, error: 'divider-rejected' as const,
        })),
      },
      {
        applySessionAgentTransitionCutover: vi.fn(async () => ({
          ok: false as const, effect: 'unknown' as const, error: 'transport' as const,
        })),
      },
      {
        requestInactiveSessionResume: vi.fn(async () => ({
          ok: false as const, code: 'timeout' as const, message: 'no start',
        })),
      },
      { sendSessionMessage: vi.fn(async () => ({ ok: false as const, code: 'timeout' as const })) as never },
      {
        sendSessionMessage: vi.fn(async () => ({
          ok: false as const,
          code: 'admission_rejected' as const,
          admissionResult: { status: 'rejected' as const, code: 'session_input_invalid' as const },
        })) as never,
      },
    ];

    for (const overrides of postStopFailures) {
      const harness = createTransitionDepsHarness(overrides as never);
      const result = await runTransition(harness);

      expect(harness.deps.requestSessionStop).toHaveBeenCalledTimes(1);
      expect(result.type).not.toBe('rejected');
    }
  });
});
