import { useEffect, useState } from 'react';
import type { HappierCollectionGroup, HappierCollectionWindow } from '@happier-dev/plugin-ui';
import type { ForgeCiRunV1, ForgeCiWorkflowV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiMountedViewStateV1 } from '@happier-dev/forge-ci/ui';

export type GithubActionsRunScopeV1 = ForgeCiMountedViewStateV1['runScope'];

/** Runs still moving lead; finished runs follow by the local calendar day they started. */
export function githubActionsRunGroupKeyV1(
  run: ForgeCiRunV1,
  nowMs: number,
): string {
  if (run.state.phase !== 'completed' && run.state.phase !== 'unknown')
    return 'active';
  const at = run.createdAtMs ?? run.startedAtMs;
  if (at === undefined) return 'earlier';
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (at >= today) return 'today';
  if (at >= today - 86_400_000) return 'yesterday';
  // The week a reader means: the six days before yesterday.
  if (at >= today - 7 * 86_400_000) return 'week';
  return 'earlier';
}

export function githubActionsRunGroupsV1(
  translate: (key: string, fallback: string) => string,
): readonly HappierCollectionGroup[] {
  return [
    {
      key: 'active',
      title: translate(
        'plugins.github.actions.runs.group.active',
        'In progress',
      ),
    },
    {
      key: 'today',
      title: translate('plugins.github.actions.runs.group.today', 'Today'),
    },
    {
      key: 'yesterday',
      title: translate(
        'plugins.github.actions.runs.group.yesterday',
        'Yesterday',
      ),
    },
    {
      key: 'week',
      title: translate(
        'plugins.github.actions.runs.group.week',
        'Earlier this week',
      ),
    },
    {
      key: 'earlier',
      title: translate('plugins.github.actions.runs.group.earlier', 'Earlier'),
    },
  ];
}

/** Window-local narrowing over the loaded runs; coverage stays the window's. */
export function matchesGithubActionsRunV1(
  run: ForgeCiRunV1,
  scope: GithubActionsRunScopeV1,
  query: string,
): boolean {
  if (
    scope === 'active' &&
    (run.state.phase === 'completed' || run.state.phase === 'unknown')
  )
    return false;
  if (scope === 'failed' && run.state.outcomeBucket !== 'failed') return false;
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return [
    run.title,
    run.headRef,
    run.number === undefined ? undefined : `#${run.number}`,
    run.workflow?.path,
  ].some(
    (value) =>
      value !== undefined && value.toLocaleLowerCase().includes(needle),
  );
}

/** The search over the loaded workflows, the same narrowing the runs lens has. */
export function matchesGithubWorkflowV1(workflow: ForgeCiWorkflowV1, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return [workflow.name, workflow.path].some((value) => value !== undefined && value.toLocaleLowerCase().includes(needle));
}

/** The newest run per workflow in the loaded window (provider order is newest first). */
export function latestGithubRunByWorkflowV1(
  runs: readonly ForgeCiRunV1[],
): ReadonlyMap<string, ForgeCiRunV1> {
  const latest = new Map<string, ForgeCiRunV1>();
  for (const run of runs) {
    const id = run.workflow?.id;
    if (id !== undefined && !latest.has(id)) latest.set(id, run);
  }
  return latest;
}

/** The start of the reader's local day, advancing at the next local midnight; never a per-second tick. */
export function useGithubLocalDayStartMsV1(): number {
  const [dayStartMs, setDayStartMs] = useState(() => localDayStart(Date.now()));
  useEffect(() => {
    const timer = setTimeout(() => setDayStartMs(localDayStart(Date.now())), Math.max(1000, dayStartMs + 86_400_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [dayStartMs]);
  return dayStartMs;
}

function localDayStart(nowMs: number): number {
  const day = new Date(nowMs); day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** One honesty line for any runs window: provider ceiling or more pages mean older runs live on GitHub. */
/**
 * Runs per page on the Actions page (owner decision, 2026-11-06): the list opens with 25 and
 * reads the next 25 as the reader reaches its end. 100 runs were 1.29 MB and 2.0–2.3 s per
 * open on happier-dev/happier; 25 were 320 KB and 0.73–0.80 s.
 */
export const GITHUB_ACTIONS_RUNS_PAGE_SIZE_V1 = 25;

export function githubActionsRunsWindowV1(
  page: Readonly<{ continuation: string | null; incomplete: string | null }> | null,
  translate: (key: string, fallback: string) => string,
  /** The read owner's next page: offered only while GitHub returned a cursor. */
  more: Readonly<{ loadMore: () => unknown; busy: boolean }> | null,
): HappierCollectionWindow {
  if (page === null || (page.incomplete === null && page.continuation === null)) return { kind: 'complete' };
  if (page.continuation !== null && more !== null) {
    return {
      kind: 'partial',
      continuations: [{
        key: 'older',
        label: translate('plugins.github.actions.runs.older', 'Show older runs'),
        busy: more.busy,
        // Reaching the end of the runs reads the next page; the control stays for keyboard and assistive use.
        whenVisible: true,
        load: () => { void more.loadMore(); },
      }],
    };
  }
  return { kind: 'unavailable', reason: translate('plugins.github.actions.runs.window', 'Showing the latest runs GitHub returned. Older runs are on GitHub.') };
}
