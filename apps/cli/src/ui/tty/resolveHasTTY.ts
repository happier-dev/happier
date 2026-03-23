export function resolveHasTTY(params: {
  stdoutIsTTY: unknown;
  stdinIsTTY: unknown;
  startedBy?: 'daemon' | 'terminal';
}): boolean {
  const hasBothTtys = Boolean(params.stdoutIsTTY) && Boolean(params.stdinIsTTY);
  if (!hasBothTtys) {
    return false;
  }

  if (params.startedBy !== 'daemon') {
    return true;
  }

  const allowDaemonTmux = process.env.HAPPIER_CLI_ALLOW_DAEMON_TTY_IN_TMUX === '1';
  if (!allowDaemonTmux) {
    return false;
  }

  return Boolean(process.env.TMUX) || Boolean(process.env.TMUX_PANE);
}
