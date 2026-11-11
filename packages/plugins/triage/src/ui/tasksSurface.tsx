import * as React from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { TriageListShell } from './shell/root.js';
import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { useTriageTaskDraftLaunch } from './taskDraftLaunch.js';

/** A page of the same plugin, using its sole list, route, selection and detail owners. */
export const renderSurface: RenderSurface = defineUiSurface((context) => {
  const launch = React.useMemo(() => {
    const parsed = parseTriageEntryDetailLaunchInput(context.launchInput);
    return parsed.status === 'valid' ? parsed.input : undefined;
  }, [context.launchInput]);
  const draft = useTriageTaskDraftLaunch(context.launchInput);
  if (draft.status === 'unavailable') return draft.notice;
  return <TriageListShell tasksPage {...(context.subPath === undefined ? {} : { subPath: context.subPath })}
    {...(context.launch === undefined ? {} : { pageLaunch: context.launch })}
    {...(launch === undefined ? {} : { launch })}
    {...(draft.status === 'ready' ? draft.shellProps : {})} />;
});
