import {
  readProcessRunState,
  type ProcessRunState,
} from './processRunState';
import { isPidSafeHappySessionProcess } from './pidSafety';
import type { DaemonSessionMarker } from './sessionRegistry';

export type ProcessIdentityVerification = 'verified' | 'mismatch' | 'unknown';

export type VerifiedProcessLiveness = Readonly<{
  status: 'verified_running' | 'verified_stopped' | 'unknown';
  pid: number;
  processStartTimeMs?: number;
}>;

type ReadProcessRunState = (pid: number) => Promise<ProcessRunState>;

export async function verifyProcessLiveness(params: Readonly<{
  pid: number;
  processStartTimeMs?: number;
  verifyIdentity: (pid: number) => Promise<ProcessIdentityVerification>;
  readRunState?: ReadProcessRunState;
}>): Promise<VerifiedProcessLiveness> {
  const processStartTimeMs = params.processStartTimeMs;
  const processIdentity = {
    pid: params.pid,
    ...(processStartTimeMs === undefined ? {} : { processStartTimeMs }),
  };
  if (
    !Number.isInteger(params.pid)
    || params.pid <= 0
    || !Number.isInteger(processStartTimeMs)
    || (processStartTimeMs ?? -1) < 0
  ) {
    return { status: 'unknown', ...processIdentity };
  }

  const readRunState = params.readRunState ?? readProcessRunState;
  let runState: ProcessRunState;
  try {
    runState = await readRunState(params.pid);
  } catch {
    return { status: 'unknown', ...processIdentity };
  }

  if (runState === 'dead' || runState === 'zombie') {
    return { status: 'verified_stopped', ...processIdentity };
  }
  if (runState !== 'servable') {
    return { status: 'unknown', ...processIdentity };
  }

  try {
    return await params.verifyIdentity(params.pid) === 'verified'
      ? { status: 'verified_running', ...processIdentity }
      : { status: 'unknown', ...processIdentity };
  } catch {
    return { status: 'unknown', ...processIdentity };
  }
}

type VerifyHappyProcessIdentity = typeof isPidSafeHappySessionProcess;

export async function verifySessionMarkerProcessLiveness(
  marker: Pick<DaemonSessionMarker, 'pid' | 'processCommandHash' | 'processStartTimeMs'>,
  deps: Readonly<{
    readRunState?: ReadProcessRunState;
    verifyHappyProcessIdentity?: VerifyHappyProcessIdentity;
  }> = {},
): Promise<VerifiedProcessLiveness> {
  const processCommandHash = marker.processCommandHash;
  const processStartTimeMs = marker.processStartTimeMs;
  return await verifyProcessLiveness({
    pid: marker.pid,
    processStartTimeMs,
    readRunState: deps.readRunState,
    verifyIdentity: async (pid) => {
      if (!processCommandHash || processStartTimeMs === undefined) return 'unknown';
      const verifyHappyProcessIdentity =
        deps.verifyHappyProcessIdentity ?? isPidSafeHappySessionProcess;
      return await verifyHappyProcessIdentity({
        pid,
        expectedProcessCommandHash: processCommandHash,
        expectedProcessStartTimeMs: processStartTimeMs,
      })
        ? 'verified'
        : 'mismatch';
    },
  });
}
