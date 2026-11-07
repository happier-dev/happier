import * as React from 'react';
import { Banner, defineUiSurface, usePluginTranslation, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { TriageListShell } from './shell/root.js';
import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { readTriageTaskDraftLaunch } from './taskDraftHandoff.js';
import { TriageTaskDraftLaunchV1Schema } from '../actions/tasksProtocol.js';

/** A page of the same plugin, using its sole list, route, selection and detail owners. */
export const renderSurface: RenderSurface = defineUiSurface((context) => {
  const scope = usePluginUiEphemeralSharedScope();
  const text = usePluginTranslation();
  const launch = React.useMemo(() => {
    const parsed = parseTriageEntryDetailLaunchInput(context.launchInput);
    return parsed.status === 'valid' ? parsed.input : undefined;
  }, [context.launchInput]);
  const parsedDraft = TriageTaskDraftLaunchV1Schema.safeParse(context.launchInput);
  const draftId = parsedDraft.success ? parsedDraft.data.draftId : null;
  const [dismissedDraftId, setDismissedDraftId] = React.useState<string | null>(null);
  const activeDraftId = draftId === dismissedDraftId ? null : draftId;
  // A committed host binding may change its facade without retiring the
  // Account/plugin occurrence. Keep the handoff until the person closes it.
  const createDraft = React.useMemo(() => readTriageTaskDraftLaunch(scope,
    activeDraftId === null ? undefined : { v: 1, kind: 'createTask', draftId: activeDraftId }), [scope, activeDraftId]);
  const closeDraft = React.useCallback(() => {
    if (createDraft.status !== 'ready') return;
    createDraft.discard();
    setDismissedDraftId(draftId);
  }, [createDraft, draftId]);
  if (createDraft.status === 'unavailable') return <Banner tone="warning"
    title={text('plugins.triage.tasks.draftUnavailable', 'This task draft is no longer available. Open it again from the message or action.')} />;
  return <TriageListShell tasksPage {...(context.subPath === undefined ? {} : { subPath: context.subPath })}
    {...(context.launch === undefined ? {} : { pageLaunch: context.launch })}
    {...(launch === undefined ? {} : { launch })}
    {...(createDraft.status === 'ready' ? { createDraft: createDraft.fields, createDraftId: activeDraftId ?? undefined, onCreateDraftClose: closeDraft } : {})} />;
});
