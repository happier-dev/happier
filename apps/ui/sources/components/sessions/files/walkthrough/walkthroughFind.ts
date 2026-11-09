import * as React from 'react';

import { createChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import type { ReviewDiffState } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffBlock';
import {
  useChangedFilesReviewFind,
  type ChangedFilesReviewFindModel,
  type ReviewFindTarget,
} from '@/components/workspaces/scm/review/useChangedFilesReviewFind';

import type { WalkthroughReading } from './walkthroughReading';

/**
 * Find across a walkthrough's captured code, through the Files review's Find owner. Each place the reading
 * shows code is one Find key: a stop's hunks of one file, or a file's hunks left outside every stop. Keys keep
 * reading order, so stepping walks the stops and then the other changes.
 */
const SEPARATOR = '\u0000';
export function walkthroughStopFindKey(stopId: string, path: string): string {
  return `stop${SEPARATOR}${stopId}${SEPARATOR}${path}`;
}
export function walkthroughOtherFindKey(path: string): string {
  return `other${SEPARATOR}${path}`;
}
export function isWalkthroughOtherFindKey(key: string): boolean { return key.startsWith(`other${SEPARATOR}`); }
function filePathOf(key: string): string {
  return key.slice(key.lastIndexOf(SEPARATOR) + 1);
}

type Connection = Parameters<ChangedFilesReviewFindModel['connect']>[0];

function walkthroughFindInput(
  code: WalkthroughReading['code'],
  reveal: (target: ReviewFindTarget | null) => void,
): Connection {
  const states: Array<readonly [string, ReviewDiffState]> = [];
  const keys: string[] = [];
  const add = (key: string, diff: string, unavailableReason: string | null) => {
    keys.push(key);
    // Captured evidence is already here; code the reading cannot show counts against Find's coverage.
    states.push([
      key,
      diff
        ? { status: 'loaded', diff, error: null }
        : {
            status: 'error',
            diff: '',
            error: unavailableReason ?? 'unavailable',
          },
    ]);
  };
  for (const stop of code.stops)
    for (const file of stop.files)
      add(
        walkthroughStopFindKey(stop.id, file.path),
        file.unifiedDiff,
        file.unavailableReason,
      );
  for (const other of code.others)
    add(
      walkthroughOtherFindKey(other.path),
      other.unifiedDiff,
      other.unavailableReason,
    );
  return { paths: keys, diffStateSource: createChangedFilesReviewDiffStateSource(states), reveal, filePathOf };
}

/** Connects the canonical review Find model to one reading (tests and the view use the same projection). */
export function connectWalkthroughFind(
  model: ChangedFilesReviewFindModel,
  reading: WalkthroughReading,
  reveal: (target: ReviewFindTarget | null) => void,
): () => void {
  return model.connect(walkthroughFindInput(reading.code, reveal));
}

export function useWalkthroughFind(
  reading: WalkthroughReading,
  reveal: (target: ReviewFindTarget | null) => void,
): ChangedFilesReviewFindModel {
  const code = reading.code;
  const input = React.useMemo(
    () => walkthroughFindInput(code, reveal),
    [code, reveal],
  );
  return useChangedFilesReviewFind(input);
}
