export function resolveHasTTY(params: {
  stdoutIsTTY: unknown;
  stdinIsTTY: unknown;
  startedBy?: 'daemon' | 'terminal';
}): boolean {
  // Allow TUI whenever we have a real TTY (stdin + stdout), including daemon-spawned
  // tmux sessions. This lets users resume locally after starting from phone/web.
  return Boolean(params.stdoutIsTTY) && Boolean(params.stdinIsTTY);
}

