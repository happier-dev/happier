import * as React from 'react';
import {
  Banner,
  usePluginTranslation,
  usePluginUiEphemeralSharedScope,
} from '@happier-dev/plugin-ui';
import {
  TriageTaskDraftLaunchV1Schema,
  type TriageTaskDraftV1,
} from '../actions/tasksProtocol.js';
import { readTriageTaskDraftLaunch } from './taskDraftHandoff.js';

/** What a Triage surface opened with a staged task draft hands its list shell (the draft as the open detail). */
export type TriageTaskDraftShellProps = Readonly<{
  createDraft: TriageTaskDraftV1;
  createDraftId?: string;
  onCreateDraftClose(): void;
}>;

export type TriageTaskDraftLaunchState =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'unavailable'; notice: React.ReactElement }>
  | Readonly<{ status: 'ready'; shellProps: TriageTaskDraftShellProps }>;

/**
 * The one adoption of a staged task draft by a mounted surface: the Tasks page and the Session's details tab read
 * the same address, keep the handoff until the person closes it, and say once when it is gone.
 */
export function useTriageTaskDraftLaunch(
  launchInput: unknown,
): TriageTaskDraftLaunchState {
  const scope = usePluginUiEphemeralSharedScope();
  const text = usePluginTranslation();
  const parsedDraft = TriageTaskDraftLaunchV1Schema.safeParse(launchInput);
  const draftId = parsedDraft.success ? parsedDraft.data.draftId : null;
  const [dismissedDraftId, setDismissedDraftId] = React.useState<string | null>(
    null,
  );
  const activeDraftId = draftId === dismissedDraftId ? null : draftId;
  // A committed host binding may change its facade without retiring the
  // Account/plugin occurrence. Keep the handoff until the person closes it.
  const createDraft = React.useMemo(
    () =>
      readTriageTaskDraftLaunch(
        scope,
        activeDraftId === null
          ? undefined
          : { v: 1, kind: 'createTask', draftId: activeDraftId },
      ),
    [scope, activeDraftId],
  );
  const closeDraft = React.useCallback(() => {
    if (createDraft.status !== 'ready') return;
    createDraft.discard();
    setDismissedDraftId(draftId);
  }, [createDraft, draftId]);
  if (createDraft.status === 'unavailable')
    return {
      status: 'unavailable',
      notice: (
        <Banner
          tone="warning"
          title={text(
            'plugins.triage.tasks.draftUnavailable',
            'This task draft is no longer available. Open it again from the message or action.',
          )}
        />
      ),
    };
  if (createDraft.status !== 'ready') return { status: 'none' };
  return {
    status: 'ready',
    shellProps: {
      createDraft: createDraft.fields,
      ...(activeDraftId === null ? {} : { createDraftId: activeDraftId }),
      onCreateDraftClose: closeDraft,
    },
  };
}
