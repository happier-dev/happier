import { stripAnsi } from '../ui/text.mjs';

function looksLikeDaemonAuthNoticeFirstLine(line) {
  const first = stripAnsi(String(line ?? '')).trim().toLowerCase();
  return first === 'sign-in required' || first === 'daemon status pending' || first === 'daemon not running';
}

function normalizeDaemonPaneLine(line) {
  return stripAnsi(String(line ?? ''))
    .trim()
    .replace(/^\[daemon\]\s*/i, '')
    .toLowerCase();
}

function looksLikeStaleDaemonStartLine(line) {
  const text = normalizeDaemonPaneLine(line);
  return (
    text === 'another running daemon is already using the selected relay.' ||
    text === 'current release channel: unknown' ||
    text === 'current cli version: unknown' ||
    text === 'started by: unknown' ||
    text.startsWith('stop the current daemon before starting another one.') ||
    text.startsWith('exited (code=') ||
    text.startsWith('daemon start failed before the relay came up;') ||
    text.startsWith('installed background service conflict detected;')
  );
}

function hasStaleDaemonStartLines(lines) {
  if (!Array.isArray(lines)) return false;
  return lines.slice(0, 12).some((line) => looksLikeStaleDaemonStartLine(line));
}

function looksLikeNoticeTitle(title) {
  const t = String(title ?? '').trim();
  return (
    t === 'daemon (SIGN-IN REQUIRED)' ||
    t === 'daemon (WAITING FOR SERVER)' ||
    t === 'daemon (NOT RUNNING)' ||
    t === 'daemon (STARTING)' ||
    t === 'daemon (STARTED)' ||
    t === 'daemon (ALREADY RUNNING)'
  );
}

/**
 * The daemon pane is used for both log routing and auth guidance.
 *
 * When the daemon transitions from "sign-in required" -> running, the TUI should
 * clear stale guidance so users don't think auth failed.
 */
export function reconcileDaemonPaneAfterDaemonStarts({ title, lines, daemonPid, daemonRunning = null }) {
  const pid = Number(daemonPid);
  const isRunning = typeof daemonRunning === 'boolean'
    ? daemonRunning
    : Number.isFinite(pid) && pid > 1;
  if (!isRunning) {
    return { title, lines };
  }

  const nextTitle = looksLikeNoticeTitle(title) ? 'daemon (RUNNING)' : title;
  const hasNoticeFirstLine = looksLikeDaemonAuthNoticeFirstLine(Array.isArray(lines) ? lines[0] : '');
  if (!hasNoticeFirstLine && !hasStaleDaemonStartLines(lines)) {
    return { title: nextTitle, lines };
  }

  return {
    title: nextTitle,
    lines: Number.isFinite(pid) && pid > 1 ? [`Daemon is running`, `PID: ${pid}`] : ['Daemon is running'],
  };
}
