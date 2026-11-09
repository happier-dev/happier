import * as React from 'react';

import {
  RowStatusLine,
  type RowStatusTone,
} from '@/components/ui/status/RowStatusLine';
import { t } from '@/text';
import {
  presentWorkspaceSyncFailure,
  resolveWorkspaceSyncErrorTranslationKey,
  type WorkspaceSyncRelationshipStateLabelKey,
} from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import type { WorkspaceSyncStatusV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

export type WorkspaceSyncStatusLineModel = Readonly<{
  text: string;
  tone: RowStatusTone;
  busy: boolean;
  /** The one next step the state calls for: review conflicts, or ask the managing machine again. */
  action: 'review' | 'retry' | null;
}>;

const BUSY_STATES: ReadonlySet<WorkspaceSyncRelationshipStateLabelKey> =
  new Set([
    'workspaceSync.state.loading',
    'workspaceSync.state.starting',
    'workspaceSync.state.flushing',
  ]);

/**
 * A sync link's one status line, from the facts its owners already decided: the state label
 * (`resolveWorkspaceSyncSummaryStateLabel`), the daemon's error code, the status read's failure and the
 * conflict count. Routine states are quiet; trouble names its reason in tone and offers its one next step.
 */
export function presentWorkspaceSyncStatusLine(
  input: Readonly<{
    stateKey: WorkspaceSyncRelationshipStateLabelKey;
    status: WorkspaceSyncStatusV1 | null;
    /** The status read's failure when the managing machine did not answer (`phase: 'error'`). */
    readError: unknown;
    pending: boolean;
    lastCheckedLabel: string | null;
  }>,
): WorkspaceSyncStatusLineModel {
  if (input.pending)
    return {
      text: t('workspaceSync.state.working'),
      tone: 'quiet',
      busy: true,
      action: null,
    };
  const conflictCount = input.status?.conflictCount ?? 0;
  if (
    conflictCount > 0 ||
    input.stateKey === 'workspaceSync.state.conflicted'
  ) {
    return {
      text:
        conflictCount > 0
          ? t('workspaceSync.conflictCount', { count: conflictCount })
          : t(input.stateKey),
      tone: 'warn',
      busy: false,
      action: 'review',
    };
  }
  switch (input.stateKey) {
    case 'workspaceSync.state.controllerUnavailable':
      return {
        text: presentWorkspaceSyncFailure(input.readError) ?? t(input.stateKey),
        tone: 'warn',
        busy: false,
        action: 'retry',
      };
    case 'workspaceSync.state.engineUnavailable':
      return {
        text: t('workspaceSync.error.componentUnavailable'),
        tone: 'bad',
        busy: false,
        action: null,
      };
  }
  // A daemon error code names its cause in any state; an unmapped one still says the link needs attention.
  const offline = input.stateKey === 'workspaceSync.state.peerOffline';
  if (input.status?.errorCode || input.stateKey === 'workspaceSync.state.error') {
    const errorKey = input.status?.errorCode
      ? resolveWorkspaceSyncErrorTranslationKey(input.status.errorCode)
      : null;
    return {
      text: t(errorKey ?? 'workspaceSync.error.needsAttention'),
      tone: offline ? 'warn' : 'bad',
      busy: false,
      action: offline ? null : 'retry',
    };
  }
  switch (input.stateKey) {
    case 'workspaceSync.state.peerOffline':
      return { text: t(input.stateKey), tone: 'warn', busy: false, action: null };
    default:
      return {
        text: [t(input.stateKey), input.lastCheckedLabel]
          .filter(Boolean)
          .join(' · '),
        tone: 'quiet',
        busy: BUSY_STATES.has(input.stateKey),
        action: null,
      };
  }
}

/** The status line under a sync link's title (plan 02 §5.2): Watching, Syncing, Paused, Offline, Conflicts or Needs attention. */
export const WorkspaceSyncStatusLine = React.memo(
  function WorkspaceSyncStatusLine(
    props: Readonly<{
      model: WorkspaceSyncStatusLineModel;
      onReview: () => void;
      onRetry: () => void;
      testID?: string;
    }>,
  ) {
    const { model } = props;
    const action =
      model.action === 'review'
        ? {
            label: t('workspaceSync.actions.review'),
            onPress: props.onReview,
            testID: props.testID ? `${props.testID}-review` : undefined,
          }
        : model.action === 'retry'
          ? {
              label: t('common.retry'),
              onPress: props.onRetry,
              testID: props.testID ? `${props.testID}-retry` : undefined,
            }
          : null;
    return (
      <RowStatusLine
        testID={props.testID}
        text={model.text}
        tone={model.tone}
        busy={model.busy}
        action={action}
        numberOfLines={model.tone === 'quiet' ? 1 : 2}
      />
    );
  },
);
