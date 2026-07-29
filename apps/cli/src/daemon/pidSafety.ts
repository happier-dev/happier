import { findHappyProcessByPid } from './doctor';
import { readProcessIdentityByPid } from './processIdentity';
import { hashProcessCommand } from './sessionRegistry';

// IMPORTANT: keep this strict. A false positive here could cause us to adopt/kill an unrelated process.
export const ALLOWED_HAPPY_SESSION_PROCESS_TYPES = new Set([
  'daemon-spawned-session',
  'user-session',
  'dev-daemon-spawned',
  'dev-session',
]);

export async function isPidSafeHappySessionProcess(params: {
  pid: number;
  expectedProcessCommandHash?: string;
  expectedProcessStartTimeMs?: number;
}, dependencies: Readonly<{
  findHappyProcessByPidFn?: typeof findHappyProcessByPid;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
}> = {}): Promise<boolean> {
  const proc = await (
    dependencies.findHappyProcessByPidFn ?? findHappyProcessByPid
  )(params.pid);
  if (!proc || !ALLOWED_HAPPY_SESSION_PROCESS_TYPES.has(proc.type)) return false;

  if (params.expectedProcessStartTimeMs !== undefined) {
    const processIdentity = await (
      dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid
    )(params.pid);
    if (
      !processIdentity
      || processIdentity.processStartTimeMs !== params.expectedProcessStartTimeMs
      || (
        params.expectedProcessCommandHash !== undefined
        && hashProcessCommand(processIdentity.command) !== params.expectedProcessCommandHash
      )
    ) {
      return false;
    }
  }

  if (
    params.expectedProcessCommandHash
    && params.expectedProcessStartTimeMs === undefined
  ) {
    return hashProcessCommand(proc.command) === params.expectedProcessCommandHash;
  }

  return true;
}
