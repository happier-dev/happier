import { setPriority as setOsPriority } from 'node:os';

const RESCUE_SESSION_NICE = 5;

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
    throw new Error('Could not normalize rescue-mode agent session priority', { cause });
  }
  return true;
}
