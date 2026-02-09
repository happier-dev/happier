import type { TmuxControlSequence, TmuxWindowOperation } from './types';

/**
 * Complete WIN_OPS dispatch dictionary for tmux operations
 * Maps operation names to tmux commands with proper typing
 */
export const WIN_OPS: Record<TmuxWindowOperation, string> = {
  // Navigation and window management
  'new-window': 'new-window',
  new: 'new-window',
  nw: 'new-window',

  'select-window': 'select-window -t',
  sw: 'select-window -t',
  window: 'select-window -t',
  w: 'select-window -t',

  'next-window': 'next-window',
  n: 'next-window',
  'prev-window': 'previous-window',
  p: 'previous-window',
  pw: 'previous-window',

  // Pane management
  'split-window': 'split-window',
  split: 'split-window',
  sp: 'split-window',
  vsplit: 'split-window -h',
  vsp: 'split-window -h',

  'select-pane': 'select-pane -t',
  pane: 'select-pane -t',

  'next-pane': 'select-pane -t :.+',
  np: 'select-pane -t :.+',
  'prev-pane': 'select-pane -t :.-',
  pp: 'select-pane -t :.-',

  // Session management
  'new-session': 'new-session',
  ns: 'new-session',
  'new-sess': 'new-session',

  'attach-session': 'attach-session -t',
  attach: 'attach-session -t',
  as: 'attach-session -t',

  'detach-client': 'detach-client',
  detach: 'detach-client',
  dc: 'detach-client',

  // Layout and display
  'select-layout': 'select-layout',
  layout: 'select-layout',
  sl: 'select-layout',

  'clock-mode': 'clock-mode',
  clock: 'clock-mode',

  // Copy mode
  'copy-mode': 'copy-mode',
  copy: 'copy-mode',

  // Search and navigation in copy mode
  'search-forward': 'search-forward',
  'search-backward': 'search-backward',

  // Misc operations
  'list-windows': 'list-windows',
  lw: 'list-windows',
  'list-sessions': 'list-sessions',
  ls: 'list-sessions',
  'list-panes': 'list-panes',
  lp: 'list-panes',

  'rename-window': 'rename-window',
  rename: 'rename-window',

  'kill-window': 'kill-window',
  kw: 'kill-window',
  'kill-pane': 'kill-pane',
  kp: 'kill-pane',
  'kill-session': 'kill-session',
  ks: 'kill-session',

  // Display and info
  'display-message': 'display-message',
  display: 'display-message',
  dm: 'display-message',

  'show-options': 'show-options',
  show: 'show-options',
  so: 'show-options',

  // Control and scripting
  'send-keys': 'send-keys',
  send: 'send-keys',
  sk: 'send-keys',

  'capture-pane': 'capture-pane',
  capture: 'capture-pane',
  cp: 'capture-pane',

  'pipe-pane': 'pipe-pane',
  pipe: 'pipe-pane',

  // Buffer operations
  'list-buffers': 'list-buffers',
  lb: 'list-buffers',
  'save-buffer': 'save-buffer',
  sb: 'save-buffer',
  'delete-buffer': 'delete-buffer',
  db: 'delete-buffer',

  // Advanced operations
  'resize-pane': 'resize-pane',
  resize: 'resize-pane',
  rp: 'resize-pane',

  'swap-pane': 'swap-pane',
  swap: 'swap-pane',

  'join-pane': 'join-pane',
  join: 'join-pane',
  'break-pane': 'break-pane',
  break: 'break-pane',
};

// Commands that support session targeting
export const COMMANDS_SUPPORTING_TARGET = new Set([
  'send-keys',
  'capture-pane',
  'new-window',
  'kill-window',
  'select-window',
  'split-window',
  'select-pane',
  'kill-pane',
  'select-layout',
  'display-message',
  'attach-session',
  'detach-client',
  // NOTE: `new-session -t` targets a *group name*, not a session/window target.
  'kill-session',
  'list-windows',
  'list-panes',
]);

// Control sequences that must be separate arguments with proper typing
export const CONTROL_SEQUENCES: Set<TmuxControlSequence> = new Set([
  'C-m',
  'C-c',
  'C-l',
  'C-u',
  'C-w',
  'C-a',
  'C-b',
  'C-d',
  'C-e',
  'C-f',
  'C-g',
  'C-h',
  'C-i',
  'C-j',
  'C-k',
  'C-n',
  'C-o',
  'C-p',
  'C-q',
  'C-r',
  'C-s',
  'C-t',
  'C-v',
  'C-x',
  'C-y',
  'C-z',
  'C-\\',
  'C-]',
  'C-[',
  'C-]',
]);
