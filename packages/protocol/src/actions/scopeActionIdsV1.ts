
/** Action identity leaf: schema modules and the registry share these constants. */
/** Client view controls; these never change a Session's access or ownership. */
export const SCOPE_ACTION_IDS = [
  'session.list.view.get', 'session.list.view.set', 'session.list.view.reset',
  'workflow.library.view.get', 'workflow.library.view.set', 'workflow.library.view.reset',
  'discussion.list.view.get', 'discussion.list.view.set', 'discussion.list.view.reset',
  'settings.column.filter.get', 'settings.column.filter.set', 'settings.column.filter.clear',
  'shell.column.get', 'shell.column.set',
  'file.view.get', 'file.view.set', 'file.view.preference.set',
  'file.editor.save', 'file.editor.resolve',
] as const;
