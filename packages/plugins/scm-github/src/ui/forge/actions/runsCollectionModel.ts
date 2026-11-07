import * as React from 'react';
import { useForgeCiRunAnatomyV1 } from '@happier-dev/forge-ci/ui';
import {
  useHappierCollection,
  type HappierCollectionKey,
} from '@happier-dev/plugin-ui';
import type { ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import {
  githubActionsRunGroupKeyV1,
  githubActionsRunGroupsV1,
  githubActionsRunsWindowV1,
  useGithubLocalDayStartMsV1,
} from './runGroups.js';

type Translate = (key: string, fallback: string) => string;
type RunsPage = Readonly<{
  rows: readonly ForgeCiRunV1[];
  continuation: string | null;
  incomplete: string | null;
}>;

const NO_RUNS: readonly ForgeCiRunV1[] = [];

/** A run's Collection key: the run and the attempt the row shows. */
export function githubRunCollectionKeyV1(run: ForgeCiRunV1): string {
  return `${run.ref.runId}/${run.currentAttempt?.attemptId ?? '1'}`;
}

/**
 * The one runs Collection model for every runs list on the Actions page (all runs, and the selected workflow's
 * runs): the shared run anatomy, calendar groups that advance at local midnight, the window's honesty line and
 * caller-owned narrowing and opening. Nothing here depends on a clock tick; only the anatomy's time leaf ticks.
 */
export function useGithubRunsCollectionV1(
  input: Readonly<{
    page: RunsPage | null;
    translate: Translate;
    workflowNames?: ReadonlyMap<string, string>;
    filter?: (run: ForgeCiRunV1) => boolean;
    openKey: HappierCollectionKey | null;
    onOpenChange: (key: HappierCollectionKey | null) => void;
    /** The runs lease's next page and whether a read is running; omitted, older runs stay on GitHub. */
    more?: Readonly<{ loadMore: () => unknown; busy: boolean }> | null;
  }>,
) {
  const { page, translate } = input;
  const anatomy = useForgeCiRunAnatomyV1(
    input.workflowNames === undefined
      ? {}
      : { workflowNames: input.workflowNames },
  );
  const dayStartMs = useGithubLocalDayStartMsV1();
  const groups = React.useMemo(
    () => ({
      axis: githubActionsRunGroupsV1(translate),
      groupOf: (run: ForgeCiRunV1) =>
        githubActionsRunGroupKeyV1(run, dayStartMs),
    }),
    [translate, dayStartMs],
  );
  const loadMore = input.more?.loadMore;
  const busy = input.more?.busy === true;
  const window = React.useMemo(
    () => githubActionsRunsWindowV1(page, translate, loadMore === undefined ? null : { loadMore, busy }),
    [page, translate, loadMore, busy],
  );
  const model = useHappierCollection({
    items: page?.rows ?? NO_RUNS,
    keyOf: githubRunCollectionKeyV1,
    groups,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    window,
    openKey: input.openKey,
    onOpenChange: input.onOpenChange,
  });
  return { anatomy, model };
}
