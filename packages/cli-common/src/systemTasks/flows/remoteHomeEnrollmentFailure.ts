import { formatRemoteEnrollmentCommandFailure, readGuestAuthErrorCode, readGuestCliFailureOutput,
  remoteEnrollmentElapsedBucket, type GuestCliFailureFacts, type RemoteEnrollmentFailureFacts } from '@happier-dev/protocol/ssh/commandFailure';

import { resolveDescriptorApplicationOrigin } from '../../homeEnrollment/homeCarrierPolicy.js';
import type { HomeTargetInput } from '../../homeTarget/homeTarget.js';

import type { HappierTextResult } from '../executors/happierJsonExecutor.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

/** Consume the guest's closed transport facts, never infer authentication from raw output. */
export function projectGuestHomeReachabilityFailure(target: HomeTargetInput, observed: GuestCliFailureFacts | null): SystemTaskExecutionError | null {
  if (!observed || observed.guestHttpStatus !== undefined || observed.homeAuthority
    || observed.guestAuthCategory === 'tls_error' || observed.guestAuthCategory === 'http_error'
    || observed.guestAuthCategory === 'cancelled') return null;
  const carrier = observed.carrierFailure;
  const unreachable = observed.guestAuthCategory === 'network_error' && (!carrier || carrier.attemptedCarrier === 'https')
    || carrier?.attemptedCarrier === 'https' && (carrier.reason === 'home_unreachable' || carrier.reason === 'transport_timeout');
  if (!unreachable) return null;
  const homeOrigin = target.kind === 'descriptor' ? resolveDescriptorApplicationOrigin(target.descriptor)
    : target.kind === 'https_url' ? target.url : null;
  if (!homeOrigin) return null;
  return new SystemTaskExecutionError('home_not_guest_reachable', `The new machine could not reach Home at ${homeOrigin}.`, {
    details: { kind: 'managedGuestHome', homeOrigin },
  });
}

/** Project terminal observations without acquiring authority over the enrollment lifetime. */
export function projectRemoteHomeEnrollmentFailure(params: Readonly<{
  code: 'remote_command_failed' | 'auth_enrollment_timeout' | 'auth_request_expired' | 'cancelled';
  result?: HappierTextResult;
  startedAtMs: number;
  homeTargetInput: HomeTargetInput;
  requestEventSeen: boolean;
  finalResultEventSeen: boolean;
  guestFailure: GuestCliFailureFacts | null;
  signal?: AbortSignal;
}>): SystemTaskExecutionError {
  const observed = params.guestFailure ?? (params.result ? readGuestCliFailureOutput(params.result.stdout, params.result.stderr) : null);
  const unreachable = params.code === 'remote_command_failed' && !params.signal?.aborted
    ? projectGuestHomeReachabilityFailure(params.homeTargetInput, observed) : null;
  if (unreachable) return unreachable;
  const category: RemoteEnrollmentFailureFacts['controllerAbortCategory'] = params.signal?.aborted || params.code === 'cancelled' ? 'caller_abort'
    : params.code === 'auth_enrollment_timeout' ? 'enrollment_deadline'
    : params.code === 'auth_request_expired' ? 'pairing_deadline' : 'none';
  return new SystemTaskExecutionError(params.code, formatRemoteEnrollmentCommandFailure({
    phase: 'auth.enroll-remote', ...(params.result ? { exitStatus: params.result.status,
      stdoutPresent: Boolean(params.result.stdout.trim()), stderrPresent: Boolean(params.result.stderr.trim()) } : {}),
    elapsedBucket: remoteEnrollmentElapsedBucket(Date.now() - params.startedAtMs),
    requestEventSeen: params.requestEventSeen, finalResultEventSeen: params.finalResultEventSeen,
    guestCliCode: readGuestAuthErrorCode(observed?.guestCliCode), guestAuthCategory: observed?.guestAuthCategory ?? 'unknown',
    ...(observed?.guestHttpStatus !== undefined ? { guestHttpStatus: observed.guestHttpStatus } : {}),
    ...(observed?.carrierFailure ? { carrierFailure: observed.carrierFailure } : {}),
    ...(observed?.homeAuthority ? { homeAuthority: observed.homeAuthority } : {}),
    controllerAbortCategory: category,
  }));
}
