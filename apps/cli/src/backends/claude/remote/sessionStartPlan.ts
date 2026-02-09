import { claudeCheckSession } from '@/backends/claude/utils/claudeCheckSession';
import { claudeFindLastSession } from '@/backends/claude/utils/claudeFindLastSession';

export type ClaudeRemoteSessionStartPlan = {
  startFrom: string | null;
  shouldContinue: boolean;
};

type ResolveClaudeRemoteSessionStartPlanDeps = {
  checkSession: (sessionId: string, path: string, transcriptPath: string | null) => boolean;
  findLastSession: (path: string, configDir: string | null) => string | null;
  logDebug: (message: string) => void;
  logPrefix: string;
};

export function resolveClaudeRemoteSessionStartPlan(
  opts: {
    sessionId: string | null;
    transcriptPath: string | null;
    path: string;
    claudeConfigDir: string | null;
    claudeArgs?: string[];
  },
  deps?: Partial<ResolveClaudeRemoteSessionStartPlanDeps>,
): ClaudeRemoteSessionStartPlan {
  const effectiveDeps: ResolveClaudeRemoteSessionStartPlanDeps = {
    checkSession: deps?.checkSession ?? claudeCheckSession,
    findLastSession: deps?.findLastSession ?? claudeFindLastSession,
    logDebug: deps?.logDebug ?? (() => undefined),
    logPrefix: deps?.logPrefix ?? 'claudeRemote',
  };

  let startFrom = opts.sessionId;
  let shouldContinue = false;

  if (opts.sessionId && !effectiveDeps.checkSession(opts.sessionId, opts.path, opts.transcriptPath)) {
    effectiveDeps.logDebug(
      `[${effectiveDeps.logPrefix}] Session ${opts.sessionId} did not pass transcript validation yet; attempting resume anyway`,
    );
  }

  if (!startFrom && opts.claudeArgs) {
    if (opts.claudeArgs.includes('--continue') || opts.claudeArgs.includes('-c')) {
      shouldContinue = true;
    }

    for (let i = 0; i < opts.claudeArgs.length; i++) {
      const arg = opts.claudeArgs[i];
      if (arg !== '--resume' && arg !== '-r') continue;

      const maybeValue = i + 1 < opts.claudeArgs.length ? opts.claudeArgs[i + 1] : undefined;
      if (maybeValue && !maybeValue.startsWith('-')) {
        startFrom = maybeValue;
        effectiveDeps.logDebug(`[${effectiveDeps.logPrefix}] Found ${arg} with session ID: ${startFrom}`);
      } else {
        const lastSession = effectiveDeps.findLastSession(opts.path, opts.claudeConfigDir);
        if (lastSession) {
          startFrom = lastSession;
          effectiveDeps.logDebug(
            `[${effectiveDeps.logPrefix}] Found ${arg} without id; using last session: ${startFrom}`,
          );
        } else {
          effectiveDeps.logDebug(
            `[${effectiveDeps.logPrefix}] Found ${arg} without id but no valid last session was found`,
          );
        }
      }

      shouldContinue = false;
      break;
    }
  }

  return { startFrom, shouldContinue };
}
