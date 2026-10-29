
/** Action identity leaf: schema modules and the registry share these constants. */
export const SESSION_TERMINAL_ACTION_IDS = [
  'session.terminals.list', 'session.terminals.open', 'session.terminals.split',
  'session.terminals.focus', 'session.terminals.restart', 'session.terminals.open_in_details', 'session.terminals.close', 'session.terminals.close_tab', 'session.terminals.close_others', 'session.terminals.resize',
  'session.terminals.rename', 'session.terminals.list_view', 'session.terminals.run_script', 'session.terminals.detach', 'session.terminals.reorder',
] as const;
