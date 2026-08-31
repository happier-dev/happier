import { setPriority as setOsPriority } from 'node:os';

const RESCUE_SESSION_NICE = 5;

function isDeniedLinuxPriorityRaise(cause: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux' || typeof cause !== 'object' || cause === null) return false;
  const systemError = cause as { code?: unknown; errno?: unknown };
  return systemError.code === 'ERR_SYSTEM_ERROR' && systemError.errno === -13;
}

export function applyStackSessionPriority({
  env = process.env,
  platform = process.platform,
  setPriority = setOsPriority,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  setPriority?: (pid: number, priority: number) => void;
} = {}): boolean {
  const isRescueSession = env.HAPPIER_STACK_RESCUE === '1'
    && env.HAPPIER_STACK_PROCESS_KIND === 'session';
  if (!isRescueSession || (platform !== 'darwin' && platform !== 'linux')) return false;

  try {
    setPriority(0, RESCUE_SESSION_NICE);
  } catch (cause) {
    // A session can inherit a lower priority from its parent. Unprivileged Linux
    // processes cannot raise it again, but the session remains safe to run as-is.
    if (isDeniedLinuxPriorityRaise(cause, platform)) return false;
    throw new Error('Could not normalize rescue-mode agent session priority', { cause });
  }
  return true;
}
