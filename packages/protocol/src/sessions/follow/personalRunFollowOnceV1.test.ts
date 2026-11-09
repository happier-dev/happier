import { describe, expect, it } from 'vitest';
import { matchesPersonalRunFollowOnceOccurrenceV1, parsePersistedPersonalRunFollowOnceV1,
  projectPersonalRunFollowCustodyV1, OtherAccountFollowV1Schema } from './accountFollow.js';
import { resolveExecutionRunFollowOccurrenceV1 } from './sessionFollowInputV1.js';

describe('personal Run one-shot custody', () => {
  const source = { kind: 'execution_run' as const, machineId: 'machine-a', runId: 'run-a' };
  const outputRef = { kind: 'scm_diff_summary' as const, output: 'walkthrough' as const, comparisonId: 'comparison-a', resultId: 'result-a' };
  const outputOccurrence = { original: { source, output: { outputRef, revision: 4, state: 'complete' as const } }, event: { kind: 'update_posted' as const } };

  it('matches an exact output revision while its Run is still running', () => {
    const frontier = { machineId: source.machineId, sessionId: null, runId: source.runId, status: 'running', terminalEventId: null,
      outputs: [outputOccurrence.original.output] };
    expect(resolveExecutionRunFollowOccurrenceV1(frontier, outputRef)).toEqual(outputOccurrence);
    expect(resolveExecutionRunFollowOccurrenceV1(frontier)).toBeNull();
    const once = { kind: 'output_ready' as const, outputRef };
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once, baseline: { original: null, outputRevision: 3 }, occurrence: outputOccurrence })).toBe(true);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once, baseline: { original: null, outputRevision: 4 }, occurrence: outputOccurrence })).toBe(false);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once: { ...once, outputRef: { ...outputRef, resultId: 'different' } },
      baseline: { original: null }, occurrence: outputOccurrence })).toBe(false);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once: { ...once, afterRevision: 4 }, baseline: { original: null }, occurrence: outputOccurrence })).toBe(false);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once, baseline: { original: null }, occurrence: outputOccurrence })).toBe(true);
  });

  it('keeps independently armed Workflow controls and only exposes armed intents', () => {
    const baseline = { original: { source: { kind: 'workflow_run' as const, runId: 'workflow-a' }, revision: 2 } };
    const occurrence = { original: { ...baseline.original, revision: 3 }, event: { kind: 'needs_you' as const, type: 'decision' as const } };
    const value = JSON.stringify({ v: 1, intents: [
      { state: 'armed', once: { kind: 'run_settled' }, baseline },
      { state: 'fulfilled', once: { kind: 'first_needs_you' }, baseline, occurrence },
    ] });
    expect(parsePersistedPersonalRunFollowOnceV1(value)?.intents).toHaveLength(2);
    expect(projectPersonalRunFollowCustodyV1({ notifyOnce: value }).once).toEqual([{ kind: 'run_settled' }]);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once: { kind: 'first_needs_you' }, baseline, occurrence })).toBe(true);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once: { kind: 'first_needs_you' }, baseline: { original: occurrence.original }, occurrence })).toBe(false);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once: { kind: 'run_settled' }, baseline, occurrence })).toBe(false);
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once: { kind: 'run_settled' }, baseline,
      occurrence: { ...occurrence, event: { kind: 'finished' } } })).toBe(true);
  });

  it('keeps projected receipts bound to their exact Run relation', () => {
    const relation = { source, following: false, persistent: false, policy: { preset: 'custom', events: {} },
      once: null, onceDeliveries: [outputOccurrence] };
    expect(OtherAccountFollowV1Schema.safeParse(relation).success).toBe(true);
    expect(OtherAccountFollowV1Schema.safeParse({ ...relation, source: { ...source, machineId: 'different-machine' } }).success).toBe(false);
  });

  it('settles a timed-out Run through its canonical terminal original', () => {
    const occurrence = resolveExecutionRunFollowOccurrenceV1({ source, runId: source.runId,
      status: 'timeout', terminalEventId: 'timed-out-original' });
    expect(occurrence).toEqual({ original: { source, terminalEventId: 'timed-out-original' }, event: { kind: 'failed_or_stopped' } });
    if (!occurrence) throw new Error('Timed-out Run must have a settled occurrence');
    expect(matchesPersonalRunFollowOnceOccurrenceV1({ once: { kind: 'run_settled' }, baseline: { original: occurrence.original }, occurrence })).toBe(true);
  });
});
