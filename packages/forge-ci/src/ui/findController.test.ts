import { describe, expect, it } from 'vitest';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { buildForgeCiLogIndexV1 } from '../runtime/logs/index.js';
import { createForgeCiMountedViewV1 } from './mountedCiIntent.js';
import { createForgeCiLogFindControllerV1 } from './findController.js';

const job = createForgeCiConformanceVectorsV1().github.job;

function indexFor(text: string, complete = true, startLine = 1) {
  return buildForgeCiLogIndexV1({
    log: { kind: 'available', job: job.ref, logId: 'log-1', text, startLine, startByte: 0, complete, continuation: complete ? null : 'more' },
    steps: [{ id: 'step-7', name: 'Test', state: job.state,
      startedAtMs: Date.parse('2026-10-24T10:00:00Z'), completedAtMs: Date.parse('2026-10-24T10:00:10Z') }],
  });
}

async function mounted(applyOperation?: Parameters<typeof createForgeCiMountedViewV1>[0]['applyOperation']) {
  const view = createForgeCiMountedViewV1({ mountId: 'ci-find', phone: false,
    ...(applyOperation === undefined ? {} : { applyOperation }) });
  await view.invoke({ mountId: view.mountId, operation: { kind: 'selectAttempt', selection: job.ref.selection } });
  await view.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job: job.ref } });
  return view;
}

describe('shared CI log Find', () => {
  it('reveals a loaded match outside the selected tail through the same mounted selection', async () => {
    const index = indexFor('first\nsecond\nlast');
    const view = await mounted();
    await view.invoke({ mountId: view.mountId, operation: { kind: 'setTailLines', lines: 1 } });
    const find = createForgeCiLogFindControllerV1({ index, view });
    find.setQuery('first');
    expect(view.getSnapshot()?.revealedLine).toBe(1);
    expect(view.getSnapshot()?.tailLines).toBe(3);
    expect(find.getSnapshot().index).toBe(index);
  });

  it('reveals original Unicode/ANSI line positions and proven steps, then refolds only temporary groups', async () => {
    const index = indexFor([
      '2026-10-24T10:00:01Z ##[group]Outer',
      '2026-10-24T10:00:02Z ##[group]Inner',
      '2026-10-24T10:00:03Z 🙂 \u001b[31mfail\u001b[0m first',
      '2026-10-24T10:00:04Z ##[endgroup]',
      '2026-10-24T10:00:05Z fail second',
      '2026-10-24T10:00:06Z ##[endgroup]',
    ].join('\n'), true, 40);
    const view = await mounted();
    await view.invoke({ mountId: view.mountId, operation: { kind: 'setGroupExpanded', groupId: index.groups[0]!.id, expanded: true } });
    const revealed: number[] = [];
    let restoredFocus = 0;
    const find = createForgeCiLogFindControllerV1({ index, view, onRevealLine: line => revealed.push(line.number),
      onClose: () => { restoredFocus++; } });
    const unsubscribe = find.subscribe(() => undefined);
    find.open();
    find.setQuery('fail');
    expect(find.status).toEqual({ kind: 'results', current: 1, total: 2, coverage: 'loaded' });
    expect(find.getLineRanges(index.lines[2]!.id)).toEqual([{ start: 3, end: 7, current: true }]);
    expect(view.getSnapshot()?.step).toEqual({ job: job.ref, stepId: 'step-7' });
    expect(view.getSnapshot()?.groupExpanded[index.groups[1]!.id]).toBe(true);
    find.step(1);
    expect(revealed).toEqual([42, 44]);
    expect(view.getSnapshot()?.revealedLine).toBe(44);
    expect(find.refold()).toBe('refolded');
    expect(view.getSnapshot()?.groupExpanded[index.groups[0]!.id]).toBe(true);
    expect(view.getSnapshot()?.groupExpanded[index.groups[1]!.id]).toBe(false);
    find.close();
    expect(find.getSnapshot().isOpen).toBe(false);
    expect(restoredFocus).toBe(1);
    unsubscribe();
  });

  it('keeps incomplete and failed coverage honest and handles invalid patterns without changing selection', async () => {
    const index = indexFor('first\nsecond', false, 120);
    const view = await mounted();
    const find = createForgeCiLogFindControllerV1({ index, view });
    find.setQuery('absent');
    expect(find.status).toEqual({ kind: 'results', current: null, total: 0, coverage: 'loaded' });
    find.setIndex(index, { partialErrors: true });
    expect(find.status).toEqual({ kind: 'results', current: null, total: 0, coverage: 'partialErrors' });
    find.setOptions({ regex: true, matchCase: false });
    find.setQuery('[');
    expect(find.status).toEqual({ kind: 'invalidPattern' });
    find.step(1);
    expect(view.getSnapshot()?.revealedLine).toBeNull();
  });

  it('maps multiline matches to their original rows and preserves explicit user fold changes', async () => {
    const index = indexFor('##[group]Fold\nfirst\nsecond\n##[endgroup]');
    const view = await mounted();
    const find = createForgeCiLogFindControllerV1({ index, view });
    const unsubscribe = find.subscribe(() => undefined);
    find.setOptions({ regex: true, matchCase: false });
    find.setQuery('first\\nsecond');
    expect(find.getLineRanges(index.lines[1]!.id)).toEqual([{ start: 0, end: 5, current: true }]);
    expect(find.getLineRanges(index.lines[2]!.id)).toEqual([{ start: 0, end: 6, current: true }]);
    await view.invoke({ mountId: view.mountId, operation: { kind: 'setGroupExpanded', groupId: index.groups[0]!.id, expanded: false } });
    await view.invoke({ mountId: view.mountId, operation: { kind: 'setGroupExpanded', groupId: index.groups[0]!.id, expanded: true } });
    expect(find.refold()).toBe('noRevealedFold');
    expect(view.getSnapshot()?.groupExpanded[index.groups[0]!.id]).toBe(true);
    unsubscribe();
  });

  it('does not manufacture an adjacent-line match across an unloaded original range', async () => {
    const index = buildForgeCiLogIndexV1({ log: { kind: 'available', job: job.ref, logId: 'fragmented',
      fragments: [{ text: 'first', startLine: 1, startByte: 0 }, { text: 'second', startLine: 20, startByte: 100 }],
      startLine: 1, startByte: 0, complete: false, continuation: 'unloaded-range' } });
    const find = createForgeCiLogFindControllerV1({ index, view: await mounted() });
    find.setOptions({ regex: true, matchCase: false });
    find.setQuery('first\\nsecond');
    expect(find.status).toEqual({ kind: 'results', current: null, total: 0, coverage: 'loaded' });
  });

  it('keeps held matches and unaffected highlight rows stable across 100k-line presentation changes', async () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => i === 10 || i === 50_000 || i === 99_990 ? 'needle' : 'quiet');
    const index = indexFor(lines.join('\n'));
    const view = await mounted();
    const find = createForgeCiLogFindControllerV1({ index, view });
    let publications = 0;
    const unsubscribe = find.subscribe(() => { publications++; });
    find.setQuery('needle');
    const snapshot = find.getSnapshot();
    const untouchedRanges = find.getLineRanges(index.lines[99_990]!.id);
    const before = publications;
    for (let i = 0; i < 20; i++) {
      find.setIndex(index);
      find.setOptions({ regex: false, matchCase: false });
      await view.invoke({ mountId: view.mountId, operation: { kind: 'setTimestampsVisible', visible: i % 2 === 0 } });
    }
    expect(publications - before).toBe(0);
    expect(find.getSnapshot()).toBe(snapshot);
    find.step(1);
    expect(publications - before).toBe(1);
    expect(find.getSnapshot().matches).toBe(snapshot.matches);
    expect(find.getLineRanges(index.lines[99_990]!.id)).toBe(untouchedRanges);
    expect(find.getSnapshot().index).toBe(index);
    unsubscribe();
  });

  it('reveals and refolds synchronously when the mounted page admits a local operation', async () => {
    const index = indexFor('##[group]Fold\nneedle\n##[endgroup]');
    const view = await mounted(() => true);
    const revealed: number[] = [];
    const find = createForgeCiLogFindControllerV1({ index, view, onRevealLine: line => revealed.push(line.number) });
    const unsubscribe = find.subscribe(() => undefined);
    find.setQuery('needle');
    expect(revealed).toEqual([2]);
    expect(view.getSnapshot()?.groupExpanded[index.groups[0]!.id]).toBe(true);
    expect(find.refold()).toBe('refolded');
    expect(view.getSnapshot()?.groupExpanded[index.groups[0]!.id]).toBe(false);
    expect(find.getSnapshot().index).toBe(index);
    unsubscribe();
  });
});
