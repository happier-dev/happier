import * as React from 'react';

import {
  publishPresentationNotice,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import { summarizeReplaceResults, type WorkspaceReplaceCloseOutcome, type WorkspaceReplaceModel } from '@/sync/domains/workspaces/files/workspaceFileReplace';
import { t } from '@/text';

const NOTICE_KEY = 'universal-search:replace-undo';

function publishClosedOutcome(outcome: WorkspaceReplaceCloseOutcome, machine: string) {
  // A deferred approval is known custody in its durable Artifact, not an unknown write or a failed Undo.
  if (outcome.approval) return;
  const summary = summarizeReplaceResults(outcome.results);
  const details = [
    summary.changed ? t('universalSearch.replace.summaryChanged', { count: summary.changed }) : null,
    summary.failed ? t('universalSearch.replace.summaryFailed', { count: summary.failed }) : null,
    summary.skipped ? t('universalSearch.replace.summarySkipped', { count: summary.skipped }) : null,
    summary.cancelled ? t('universalSearch.replace.summaryCancelled', { count: summary.cancelled }) : null,
  ].filter(Boolean).join(' ');
  if (!outcome.error && !summary.replacedFiles && !details) return;
  const undo = outcome.undo;
  publishPresentationNotice({
    key: NOTICE_KEY,
    severity: outcome.error || summary.failed ? 'error' : 'info',
    sticky: true,
    message: outcome.error === 'outcome_unknown'
      ? t('universalSearch.replace.outcomeUnknown', { machine })
      : outcome.error ? t('universalSearch.replace.applyFailed', { machine })
        : [summary.replacedFiles
          ? t('universalSearch.replace.replacedTitle', { matches: summary.replacedMatches, files: summary.replacedFiles })
          : t('universalSearch.replace.nothingReplaced'), details].filter(Boolean).join(' '),
    ...(undo ? { undo: {
      label: t('universalSearch.replace.undo'),
      run: () => {
        void undo(approval => {
          publishPresentationNotice({ key: NOTICE_KEY, severity: 'info', sticky: true,
            message: t('approvals.waitingForYou'), approval });
        }).then((result) => {
          if (!result) { retirePresentationNotice(NOTICE_KEY); return; }
          if (result.approval) return;
          publishPresentationNotice({
            key: NOTICE_KEY,
            severity: result.error ? 'error' : 'info',
            message: result.error === 'outcome_unknown'
              ? t('universalSearch.replace.outcomeUnknown', { machine })
              : result.error ? t('universalSearch.replace.undoFailed', { machine })
                : result.changed > 0 ? t('universalSearch.replace.undoneExceptChanged', { count: result.changed })
                  : t('universalSearch.replace.undoneTitle'),
          });
        });
      },
    } } : {}),
  });
}

/**
 * One Undo per state: while the surface is open its result row owns Undo; when the surface closes with
 * Undo still possible, the app's sticky presentation notice carries it. The recorded edits stay in this
 * closure only (no store); a newer notice replacing this one ends the offer, as for every notice.
 */
export function useReplaceUndoOnClose(
  model: WorkspaceReplaceModel,
  machineLabel: string,
): void {
  const latest = React.useRef({ model, machineLabel });
  latest.current = { model, machineLabel };
  React.useEffect(
    () => () => {
      const { model: closing, machineLabel: machine } = latest.current;
      void closing.settleOnClose().then(outcome => { if (outcome) publishClosedOutcome(outcome, machine); });
    },
    [],
  );
}
