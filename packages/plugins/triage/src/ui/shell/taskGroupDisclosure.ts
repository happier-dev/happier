import * as React from 'react';
import type { TriageMountedUiResultV1 } from '../../actions/mountedUiProtocol.js';

const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set();
const TASKS_DONE_COLLAPSED: ReadonlySet<string> = new Set(['completed']);

/** Page-local disclosure, shared by the mounted Action and Collection control. */
export function useTriageTaskGroupDisclosure(enabled: boolean) {
  const [doneOpen, setDoneOpen] = React.useState(false);
  const chooseDoneExpanded = React.useCallback((expanded: boolean): TriageMountedUiResultV1 => {
    if (!enabled) return { status: 'unavailable' };
    setDoneOpen(expanded);
    return { status: 'applied' };
  }, [enabled]);
  return { doneOpen, chooseDoneExpanded,
    collapsedGroups: doneOpen ? NO_COLLAPSED_GROUPS : TASKS_DONE_COLLAPSED };
}
