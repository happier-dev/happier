import * as React from 'react';
import {
  ForgeCiStateNotice,
  readForgeOperationStateV1,
  useForgeCiMutationV1,
} from '@happier-dev/forge-ci/ui';
import { readForgeCiSelectionRunV1 } from '@happier-dev/forge-ci/runtime';
import { usePluginTranslation } from '@happier-dev/plugin-ui';

import type { GithubProjectedCheckRowV1 } from '../../triage/detail/projection.js';
import { readGithubCheckOutcomeV1 } from '../../triage/checkOutcome.js';
import { useGithubCiBindingV1 } from '../actions/useGithubCiBinding.js';

export type GithubChecksRerunV1 = Readonly<{
  /** Which re-run a check row offers: none (GitHub Actions did not run it, or it is still running). */
  offer: (row: GithubProjectedCheckRowV1) => 'failed' | 'all' | null;
  rerun: (row: GithubProjectedCheckRowV1) => void;
  /** The row whose re-run is out, for its busy control. */
  pendingKey: string | null;
  /** A re-run GitHub refused or did not answer, said once above the checks. */
  notice: React.ReactNode;
}>;

/**
 * A check's re-run from the PR Checks list: the workflow run behind a check GitHub Actions ran, re-run through the
 * one GitHub CI binding and the shared CI write owner (the same write the run drill-down's Re-run makes). A failed
 * check re-runs its run's failed jobs; any other finished one re-runs the whole run. An accepted re-run is read
 * back through the checks' own refresh.
 */
export function useGithubChecksRerunV1(
  rows: readonly GithubProjectedCheckRowV1[],
  onAccepted: () => void,
  signal?: AbortSignal,
): GithubChecksRerunV1 {
  const text = usePluginTranslation();
  const target = rows.find((row) => row.actions !== undefined)?.actions;
  const repository =
    target === undefined
      ? null
      : readForgeCiSelectionRunV1(target.selection).repository;
  const ci = useGithubCiBindingV1(
    repository,
    signal === undefined ? {} : { signal },
  );
  const accepted = React.useRef(onAccepted);
  accepted.current = onAccepted;
  const mutation = useForgeCiMutationV1(ci, (result) => {
    if (result.kind === 'accepted' || result.kind === 'confirmed')
      accepted.current();
  });
  const [rowKey, setRowKey] = React.useState<string | null>(null);
  const canWrite = ci.adapter !== null;
  const offer = React.useCallback(
    (row: GithubProjectedCheckRowV1): 'failed' | 'all' | null => {
      if (!canWrite || row.actions === undefined) return null;
      const outcome = readGithubCheckOutcomeV1(row);
      return outcome === 'pending'
        ? null
        : outcome === 'failed'
          ? 'failed'
          : 'all';
    },
    [canWrite],
  );
  const run = mutation.run;
  const rerun = React.useCallback(
    (row: GithubProjectedCheckRowV1) => {
      const kind = offer(row);
      if (kind === null || row.actions === undefined) return;
      const { selection } = row.actions;
      const ref = readForgeCiSelectionRunV1(selection);
      setRowKey(row.key);
      void run(kind === 'failed' ? 'rerunFailed' : 'rerunAll', {
        repository: ref.repository,
        runId: ref.runId,
        ...(selection.kind === 'attempt'
          ? { attempt: selection.attempt.attemptId }
          : {}),
      });
    },
    [offer, run],
  );
  const last = mutation.state.last;
  return {
    offer,
    rerun,
    pendingKey: mutation.state.pending === null ? null : rowKey,
    notice:
      last === null ||
      last.result.kind === 'accepted' ||
      last.result.kind === 'confirmed' ? null : (
        <ForgeCiStateNotice
          presentation="banner"
          about={{
            ...ci.about,
            subject: text('plugins.github.ui.checkRerunSubject', 'this re-run'),
          }}
          state={readForgeOperationStateV1({
            mutation: last.result,
            account: ci.account,
            hasRetainedValue: true,
            targetUrl:
              rows.find((row) => row.key === rowKey)?.detailsUrl ?? null,
          })}
        />
      ),
  };
}
