
/** Action identity leaf: schema modules and the registry share these constants. */
export const WORKFLOW_LIBRARY_VIEW_ACTION_IDS = {
  get: 'workflow.library.view.get',
  set: 'workflow.library.view.set',
  reset: 'workflow.library.view.reset',
} as const;

export const WORKFLOW_RUN_VIEW_ACTION_IDS = {
  get: 'workflow.run.view.get',
  set: 'workflow.run.view.set',
  reset: 'workflow.run.view.reset',
} as const;

const libraryViewIds = Object.values(WORKFLOW_LIBRARY_VIEW_ACTION_IDS);
const runViewIds = Object.values(WORKFLOW_RUN_VIEW_ACTION_IDS);

export function isWorkflowLibraryViewActionId(id: string): id is typeof libraryViewIds[number] {
  return libraryViewIds.some(candidate => candidate === id);
}

export function isWorkflowRunViewActionId(id: string): id is typeof runViewIds[number] {
  return runViewIds.some(candidate => candidate === id);
}

/** Client view controls; these never change a Session's access or ownership. */
export const SCOPE_ACTION_IDS = [
  'session.list.view.get', 'session.list.view.set', 'session.list.view.reset',
  ...libraryViewIds, ...runViewIds,
  'discussion.list.view.get', 'discussion.list.view.set', 'discussion.list.view.reset',
  'settings.column.filter.get', 'settings.column.filter.set', 'settings.column.filter.clear',
  'shell.column.get', 'shell.column.set',
  'file.view.get', 'file.view.set', 'file.view.preference.set',
  'file.editor.save', 'file.editor.resolve',
] as const;
