import { formatRemoteEnrollmentCommandFailure, readGuestAuthErrorCode, readGuestCliFailureOutput,
  remoteEnrollmentElapsedBucket, type GuestCliFailureFacts, type RemoteEnrollmentFailureFacts } from '@happier-dev/protocol/ssh/commandFailure';

import type { HappierTextResult } from '../executors/happierJsonExecutor.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

/** Project terminal observations without acquiring authority over the enrollment lifetime. */
export function projectRemoteHomeEnrollmentFailure(params: Readonly<{
  code: 'remote_command_failed' | 'auth_enrollment_timeout' | 'auth_request_expired' | 'cancelled';
  result?: HappierTextResult;
  startedAtMs: number;
  requestEventSeen: boolean;
  finalResultEventSeen: boolean;
  guestFailure: GuestCliFailureFacts | null;
  signal?: AbortSignal;
}>): SystemTaskExecutionError {
  const observed = params.guestFailure ?? (params.result ? readGuestCliFailureOutput(params.result.stdout, params.result.stderr) : null);
  const category: RemoteEnrollmentFailureFacts['controllerAbortCategory'] = params.signal?.aborted || params.code === 'cancelled' ? 'caller_abort'
    : params.code === 'auth_enrollment_timeout' ? 'enrollment_deadline'
    : params.code === 'auth_request_expired' ? 'pairing_deadline' : 'none';
  return new SystemTaskExecutionError(params.code, formatRemoteEnrollmentCommandFailure({
    phase: 'auth.enroll-remote', ...(params.result ? { exitStatus: params.result.status,
      stdoutPresent: Boolean(params.result.stdout.trim()), stderrPresent: Boolean(params.result.stderr.trim()) } : {}),
    elapsedBucket: remoteEnrollmentElapsedBucket(Date.now() - params.startedAtMs),
    requestEventSeen: params.requestEventSeen, finalResultEventSeen: params.finalResultEventSeen,
    guestCliCode: readGuestAuthErrorCode(observed?.guestCliCode), guestAuthCategory: observed?.guestAuthCategory ?? 'unknown',
    ...(observed?.carrierFailure ? { carrierFailure: observed.carrierFailure } : {}),
    ...(observed?.homeAuthority ? { homeAuthority: observed.homeAuthority } : {}),
    controllerAbortCategory: category,
  }));
}
