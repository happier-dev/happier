
/** Action identity leaf: schema modules and the registry share these constants. */
export const WORKSPACE_ACTION_IDS = [
  'workspace.files.link.get',
  'workspace.tabs.list', 'workspace.tabs.open', 'workspace.tabs.activate', 'workspace.tabs.close',
  'workspace.tabs.close_others', 'workspace.tabs.close_left', 'workspace.tabs.close_right', 'workspace.tabs.close_all',
  'workspace.tabs.closed.list', 'workspace.tabs.reopen',
  'workspace.tabs.pin', 'workspace.tabs.move', 'workspace.tabs.reorder', 'workspace.groups.focus', 'workspace.groups.maximize',
  'workspace.groups.restore', 'workspace.split', 'workspace.resize',
] as const;
