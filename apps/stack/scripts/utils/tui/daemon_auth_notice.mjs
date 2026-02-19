function isTruthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

export function buildDaemonAuthNotice({
  stackName,
  internalServerUrl = '',
  daemonPid = null,
  authed = false,
  // Let callers opt out if daemon isn't intended to run.
  startDaemon = true,
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const pid = Number(daemonPid);
  const isRunning = Number.isFinite(pid) && pid > 1;
  if (!startDaemon) return { show: false, summaryLines: [], paneTitle: null, paneLines: [] };
  if (isRunning) return { show: false, summaryLines: [], paneTitle: null, paneLines: [] };

  const url = String(internalServerUrl ?? '').trim();
  if (!url) {
    return {
      show: true,
      summaryLines: ['Daemon status pending', 'waiting for the stack server to start...'],
      paneTitle: 'daemon (WAITING FOR SERVER)',
      paneLines: [
        'Daemon status pending',
        '',
        'The stack is still starting up, and the server URL is not known yet.',
        '',
        'Once the server is ready, this pane will update with sign-in guidance if needed.',
      ],
    };
  }

  if (!authed) {
    return {
      show: true,
      summaryLines: ['Daemon sign-in required', `action: press "a" to sign in for stack "${name}"`],
      paneTitle: 'daemon (SIGN-IN REQUIRED)',
      paneLines: [
        'Sign-in required',
        `stack:  ${name}`,
        `server: ${url}`,
        '',
        'Without daemon sign-in, the UI may show "no machine" for this stack.',
        '',
        `press "a" to run: hstack stack auth ${name} login`,
      ],
    };
  }

  return {
    show: true,
    summaryLines: ['Daemon not running', 'starting automatically when ready...'],
    paneTitle: 'daemon (NOT RUNNING)',
    paneLines: [
      'daemon not running',
      `stack:  ${name}`,
      `server: ${url}`,
      '',
      'This TUI will try to start the daemon automatically.',
      '',
      `manual: hstack stack daemon ${name} start`,
    ],
  };
}

export function parseStartDaemonFlagFromEnv(env = process.env) {
  // This mirrors dev.mjs default behavior: startDaemon is on unless explicitly disabled.
  const raw = String(env?.HAPPIER_STACK_START_DAEMON ?? '').trim();
  if (!raw) return true;
  return isTruthy(raw);
}
