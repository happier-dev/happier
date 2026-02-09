export enum TmuxControlState {
  /** Normal text processing mode */
  NORMAL = 'normal',
  /** Escape to tmux control mode */
  ESCAPE = 'escape',
  /** Literal character mode */
  LITERAL = 'literal',
}

/** Union type of valid tmux control sequences for better type safety */
export type TmuxControlSequence =
  | 'C-m'
  | 'C-c'
  | 'C-l'
  | 'C-u'
  | 'C-w'
  | 'C-a'
  | 'C-b'
  | 'C-d'
  | 'C-e'
  | 'C-f'
  | 'C-g'
  | 'C-h'
  | 'C-i'
  | 'C-j'
  | 'C-k'
  | 'C-n'
  | 'C-o'
  | 'C-p'
  | 'C-q'
  | 'C-r'
  | 'C-s'
  | 'C-t'
  | 'C-v'
  | 'C-x'
  | 'C-y'
  | 'C-z'
  | 'C-\\'
  | 'C-]'
  | 'C-['
  | 'C-]';

/** Union type of valid tmux window operations for better type safety */
export type TmuxWindowOperation =
  // Navigation and window management
  | 'new-window'
  | 'new'
  | 'nw'
  | 'select-window'
  | 'sw'
  | 'window'
  | 'w'
  | 'next-window'
  | 'n'
  | 'prev-window'
  | 'p'
  | 'pw'
  // Pane management
  | 'split-window'
  | 'split'
  | 'sp'
  | 'vsplit'
  | 'vsp'
  | 'select-pane'
  | 'pane'
  | 'next-pane'
  | 'np'
  | 'prev-pane'
  | 'pp'
  // Session management
  | 'new-session'
  | 'ns'
  | 'new-sess'
  | 'attach-session'
  | 'attach'
  | 'as'
  | 'detach-client'
  | 'detach'
  | 'dc'
  // Layout and display
  | 'select-layout'
  | 'layout'
  | 'sl'
  | 'clock-mode'
  | 'clock'
  | 'copy-mode'
  | 'copy'
  | 'search-forward'
  | 'search-backward'
  // Misc operations
  | 'list-windows'
  | 'lw'
  | 'list-sessions'
  | 'ls'
  | 'list-panes'
  | 'lp'
  | 'rename-window'
  | 'rename'
  | 'kill-window'
  | 'kw'
  | 'kill-pane'
  | 'kp'
  | 'kill-session'
  | 'ks'
  // Display and info
  | 'display-message'
  | 'display'
  | 'dm'
  | 'show-options'
  | 'show'
  | 'so'
  // Control and scripting
  | 'send-keys'
  | 'send'
  | 'sk'
  | 'capture-pane'
  | 'capture'
  | 'cp'
  | 'pipe-pane'
  | 'pipe'
  // Buffer operations
  | 'list-buffers'
  | 'lb'
  | 'save-buffer'
  | 'sb'
  | 'delete-buffer'
  | 'db'
  // Advanced operations
  | 'resize-pane'
  | 'resize'
  | 'rp'
  | 'swap-pane'
  | 'swap'
  | 'join-pane'
  | 'join'
  | 'break-pane'
  | 'break';

export interface TmuxEnvironment {
  /** tmux server socket path (TMUX env var first component) */
  socket_path: string;
  /** tmux server pid (TMUX env var second component) */
  server_pid: number;
  /** tmux pane identifier/index (TMUX env var third component) */
  pane: string;
}

export interface TmuxCommandResult {
  returncode: number;
  stdout: string;
  stderr: string;
  command: string[];
}

export interface TmuxSessionInfo {
  target_session: string;
  session: string;
  window: string;
  pane: string;
  socket_path?: string;
  tmux_active: boolean;
  current_session?: string;
  env_pane?: string;
  available_sessions: string[];
}

// Strongly typed tmux session identifier with validation
export interface TmuxSessionIdentifier {
  session: string;
  window?: string;
  pane?: string;
}
