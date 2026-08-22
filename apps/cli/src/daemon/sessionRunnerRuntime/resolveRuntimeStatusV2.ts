import type {
  SessionRunnerProcessIdentityV2,
  SessionRunnerRuntimeStateV1,
  SessionRunnerRuntimeStatusV2,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';

async function resolveRunnerProcessIdentity(
  tracked: TrackedSession | null | undefined,
  readProcessIdentityByPidFn: typeof readProcessIdentityByPid,
): Promise<SessionRunnerProcessIdentityV2 | null> {
  const pid = tracked?.sessionRunnerPid ?? tracked?.pid;
  if (
    typeof pid !== 'number'
    || !Number.isInteger(pid)
    || pid <= 0
  ) {
    return null;
  }

  let observedProcessIdentity: Awaited<
    ReturnType<typeof readProcessIdentityByPid>
  >;
  try {
    observedProcessIdentity = await readProcessIdentityByPidFn(pid);
  } catch {
    return null;
  }
  const processStartTimeMs = observedProcessIdentity?.processStartTimeMs;
  if (
    observedProcessIdentity?.pid !== pid
    || typeof processStartTimeMs !== 'number'
    || !Number.isInteger(processStartTimeMs)
    || processStartTimeMs < 0
  ) {
    return null;
  }
  return {
    pid,
    processStartTimeMs,
  };
}

export async function resolveSessionRunnerRuntimeStatusV2(input: Readonly<{
  state: SessionRunnerRuntimeStateV1;
  tracked: TrackedSession | null | undefined;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
}>): Promise<SessionRunnerRuntimeStatusV2> {
  return {
    v: 2,
    state: input.state,
    runnerProcessIdentity: await resolveRunnerProcessIdentity(
      input.tracked,
      input.readProcessIdentityByPidFn ?? readProcessIdentityByPid,
    ),
  };
}
