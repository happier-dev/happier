import type { TrackedSession } from '../types';
import type { createStopSession, StopSessionOptions } from './stopSession';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';

export interface RequesterMachineSessionCleanupInput {
  requesterAccountId: string;
  machineId: string;
  installationId: string;
  /** Host-private exact signed-Home request currentness, never transported in a DTO. */
  verifyCurrentMachineAdmission: () => Promise<boolean>;
}

export type RequesterMachineSessionCleanupResult = Readonly<{ kind: 'settled' | 'incomplete' }>;

export function createRequesterMachineSessionAccessLossCleanup(params: Readonly<{
  serverId: string;
  machineId: string;
  pidToTrackedSession: Map<number, TrackedSession>;
  stopSession: ReturnType<typeof createStopSession>;
  beforeSignalExactTrackedRunner?: StopSessionOptions['beforeSignalExactTrackedRunner'];
  retireRequesterCredentials?: (input: Readonly<{ sessionId: string; attribution: RequesterWorkAttributionV1 }>) => Promise<boolean>;
}>) {
  return async (input: RequesterMachineSessionCleanupInput): Promise<RequesterMachineSessionCleanupResult> => {
    if (input.machineId !== params.machineId) return { kind: 'incomplete' };
    const matches = (tracked: TrackedSession): boolean => {
      const stamp = tracked.requesterWorkAttributionV1;
      return stamp?.serverId === params.serverId && stamp.accountId === input.requesterAccountId
        && stamp.machineId === input.machineId && stamp.installationId === input.installationId;
    };
    // The verified ingress proves custody; the existing C42 stamp alone selects
    // requester work. Missing legacy facts are unknown, never the custodian.
    let incomplete = [...params.pidToTrackedSession.values()].some(tracked => !tracked.requesterWorkAttributionV1);
    const captured = [...params.pidToTrackedSession.entries()].filter(([, tracked]) => matches(tracked))
      .map(([pid, tracked]) => ({ pid, tracked, sessionId: tracked.happySessionId,
        attribution: tracked.requesterWorkAttributionV1,
        sessionRunnerPid: tracked.sessionRunnerPid, processStartTimeMs: tracked.processStartTimeMs,
        processCommandHash: tracked.processCommandHash }));
    for (const witness of captured) {
      if (!witness.sessionId || params.pidToTrackedSession.get(witness.pid) !== witness.tracked) {
        incomplete = true;
        continue;
      }
      try {
        if (!await input.verifyCurrentMachineAdmission() || params.pidToTrackedSession.get(witness.pid) !== witness.tracked) {
          incomplete = true;
          continue;
        }
        const result = await params.stopSession(witness.sessionId, {
          expectedTrackedRunner: { tracked: witness.tracked, sessionRunnerPid: witness.sessionRunnerPid,
            processStartTimeMs: witness.processStartTimeMs, processCommandHash: witness.processCommandHash },
          beforeSignalExactTrackedRunner: async tracked => {
            try {
              if (!await input.verifyCurrentMachineAdmission()) return false;
              return await params.beforeSignalExactTrackedRunner?.(tracked) !== false;
            } catch { return false; }
          },
        });
        if (result.status !== 'stopped') { incomplete = true; continue; }
        if (params.retireRequesterCredentials && witness.attribution) {
          // A newly adopted occurrence still owns its Session's private file.
          const replaced = [...params.pidToTrackedSession.values()].some(tracked => tracked !== witness.tracked
            && tracked.happySessionId === witness.sessionId);
          if (replaced || !await input.verifyCurrentMachineAdmission()
            || !await params.retireRequesterCredentials({ sessionId: witness.sessionId, attribution: witness.attribution })) {
            incomplete = true;
          }
        }
      } catch {
        // One failed physical retirement must not prevent independent exact work
        // from reaching the existing stop owner. No requested stop is settlement.
        incomplete = true;
      }
    }
    const capturedObjects = new Set(captured.map(witness => witness.tracked));
    for (const tracked of params.pidToTrackedSession.values()) {
      if (!tracked.requesterWorkAttributionV1 || (matches(tracked) && !capturedObjects.has(tracked))) incomplete = true;
    }
    return { kind: incomplete ? 'incomplete' : 'settled' };
  };
}
