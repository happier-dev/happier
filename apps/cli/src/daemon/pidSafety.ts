import { findHappyProcessByPid } from './doctor';
import { processGenerationMatches, readProcessIdentityByPid } from './processIdentity';
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
  const expectedProcessCommandHash =
    params.expectedProcessCommandHash?.trim() ?? '';
  const expectedProcessStartTimeMs = params.expectedProcessStartTimeMs;
  if (!Number.isInteger(params.pid) || params.pid <= 0) {
    return false;
  }

  if (Number.isInteger(expectedProcessStartTimeMs) && (expectedProcessStartTimeMs ?? -1) >= 0) {
    const processIdentity = await (
      dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid
    )(params.pid);
    return processGenerationMatches(
      expectedProcessStartTimeMs,
      processIdentity?.processStartTimeMs,
    );
  }

  if (!/^[a-f0-9]{64}$/.test(expectedProcessCommandHash)) return false;

  const proc = await (
    dependencies.findHappyProcessByPidFn ?? findHappyProcessByPid
  )(params.pid);
  return !!proc
    && ALLOWED_HAPPY_SESSION_PROCESS_TYPES.has(proc.type)
    && hashProcessCommand(proc.command) === expectedProcessCommandHash;
}
