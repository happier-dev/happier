import { describeJsonOwnerLockOwner } from './jsonOwnerFileLock.mjs';

function parseNoticeInterval(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Called by existing lock/import wait loops; this reporter owns no timer or budget.
export function createWorkspaceBuildWaitNotifier({ env = process.env, label, kind }) {
  const noticeAfterMs = parseNoticeInterval(env.HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS, 5_000);
  const noticeEveryMs = parseNoticeInterval(env.HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS, 30_000);
  let lastNoticeMs = null;

  return (event = {}) => {
    const waitedMs = Number(event.waitedMs ?? 0);
    if (!Number.isFinite(waitedMs) || waitedMs < noticeAfterMs) return;
    if (lastNoticeMs != null && waitedMs - lastNoticeMs < noticeEveryMs) return;
    lastNoticeMs = waitedMs;

    let message;
    if (kind === 'lock') {
      message = `[local] waiting for ${label} lock (${Math.ceil(waitedMs / 1000)}s): ${event.lockPath} (${describeJsonOwnerLockOwner(event.owner, Date.now())})`;
    } else if (kind === 'imports') {
      const attempt = Number(event.attempt ?? 0);
      const attempts = Number(event.attempts ?? 0);
      const attemptLabel = Number.isFinite(attempts) && attempts > 0 ? `${attempt + 1}/${attempts}` : `${attempt + 1}/?`;
      message = `[local] waiting for ${label} local imports to settle (${Math.ceil(waitedMs / 1000)}s, attempt ${attemptLabel}): ${event.entryPath}`;
    } else {
      message = `[local] waiting for ${label} (${Math.ceil(waitedMs / 1000)}s)`;
    }
    try { process.stderr.write(`${message}\n`); } catch {}
  };
}
