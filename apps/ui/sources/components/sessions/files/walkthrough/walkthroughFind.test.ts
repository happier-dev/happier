import { describe, expect, it, vi } from 'vitest';

import {
  SPECIMEN_ANALYSIS_COMPLETE,
  SPECIMEN_COMPARISON,
  SPECIMEN_WALKTHROUGH,
} from '@/components/dev/changes/walkthroughSpecimenFixture';
import {
  createChangedFilesReviewFind,
  type ReviewFindTarget,
} from '@/components/workspaces/scm/review/useChangedFilesReviewFind';

import { buildWalkthroughReading } from './walkthroughReading';
import {
  connectWalkthroughFind,
  walkthroughOtherFindKey,
  walkthroughStopFindKey,
} from './walkthroughFind';

const reading = buildWalkthroughReading({
  comparison: SPECIMEN_COMPARISON,
  walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
  analysis: SPECIMEN_ANALYSIS_COMPLETE,
  reviewed: null,
});
const MODAL = 'apps/ui/sources/components/settings/SettingsModal.tsx';
const LAYOUT = 'apps/ui/sources/components/ui/modal/useModalLayout.ts';
const COPY = 'apps/ui/sources/text/en.ts';

function walk(query: string) {
  const model = createChangedFilesReviewFind();
  const reveals: (ReviewFindTarget | null)[] = [];
  connectWalkthroughFind(model, reading, (target) => reveals.push(target));
  model.open();
  model.setQuery(query);
  const visited = [reveals.at(-1)?.filePath];
  const status = model.getSnapshot().status;
  const total = status.kind === 'results' ? status.total : 0;
  for (let index = 1; index < total; index += 1) {
    model.step(1);
    visited.push(reveals.at(-1)?.filePath);
  }
  return { model, status, visited };
}

describe('Find across a walkthrough', () => {
  it('admits a thousand captured files without publishing a snapshot per file', () => {
    const file = reading.stops[0]!.files[0]!;
    const fileCount = 1_000;
    const stops = [{ ...reading.stops[0]!, files: Array.from({ length: fileCount }, (_, index) => ({
        ...file, path: `file-${index}.ts`, unifiedDiff: '@@ -1 +1 @@\n-old\n+needle\n',
      })) }];
    const largeReading = {
      ...reading,
      stops,
      others: [],
      code: { stops, others: [] },
    };
    const model = createChangedFilesReviewFind();
    const iterate = Map.prototype[Symbol.iterator];
    let copiedEntries = 0;
    // Instrument the real native Map iteration; no projection or Find logic is substituted.
    const iteration = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
      copiedEntries += this.size;
      return iterate.call(this);
    });
    let disconnect: (() => void) | undefined;
    try {
      disconnect = connectWalkthroughFind(model, largeReading, () => {});
      expect(copiedEntries).toBeLessThanOrEqual(fileCount);
    } finally {
      iteration.mockRestore();
      disconnect?.();
    }
    model.open();
    const dispose = connectWalkthroughFind(model, largeReading, () => {});
    model.setQuery('needle');
    expect(model.getSnapshot().status).toMatchObject({ kind: 'results', files: fileCount, coverage: 'complete' });
    dispose();
  });

  it('enumerates matches through every stop in reading order and then the changes outside stops', () => {
    // "compact" is in stop 4 (SettingsModal hunk 3 and useModalLayout) and in en.ts, which no stop explains.
    const { status, visited } = walk('compact');
    expect(status).toMatchObject({
      kind: 'results',
      coverage: 'complete',
      current: 1,
    });
    expect(visited[0]).toBe(walkthroughStopFindKey('compact', MODAL));
    expect(visited).toContain(walkthroughStopFindKey('compact', LAYOUT));
    expect(visited.at(-1)).toBe(walkthroughOtherFindKey(COPY));
    // The same file in two stops is two places to read, yet one file in the count.
    const files = status.kind === 'results' ? status.files : 0;
    expect(files).toBe(3);
  });

  it('finds code that only the uncovered tail holds and reveals that place', () => {
    const { status, visited } = walk('0.4.2');
    expect(status).toMatchObject({ kind: 'results', total: 2, files: 1 });
    expect(new Set(visited)).toEqual(
      new Set([walkthroughOtherFindKey('yarn.lock')]),
    );
  });
});
