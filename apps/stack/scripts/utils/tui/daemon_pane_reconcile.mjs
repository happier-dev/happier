import { stripAnsi } from '../ui/text.mjs';

function looksLikeDaemonAuthNoticeFirstLine(line) {
  const first = stripAnsi(String(line ?? '')).trim().toLowerCase();
  return first === 'sign-in required' || first === 'daemon status pending' || first === 'daemon not running';
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
export function reconcileDaemonPaneAfterDaemonStarts({ title, lines, daemonPid }) {
  const pid = Number(daemonPid);
  if (!Number.isFinite(pid) || pid <= 1) {
    return { title, lines };
  }

  const nextTitle = looksLikeNoticeTitle(title) ? 'daemon (RUNNING)' : title;
  const hasNoticeFirstLine = looksLikeDaemonAuthNoticeFirstLine(Array.isArray(lines) ? lines[0] : '');
  if (!hasNoticeFirstLine) {
    return { title: nextTitle, lines };
  }

  return {
    title: nextTitle,
    lines: [`Daemon is running`, `PID: ${pid}`],
  };
}

