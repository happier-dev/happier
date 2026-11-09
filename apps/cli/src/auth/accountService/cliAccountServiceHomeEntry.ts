/**
 * Thin CLI coordinator for Account Service Home entry.
 *
 * Authentication/session persistence and the shared deterministic Directory
 * journey are injected owners. This module owns only CLI sequencing and never
 * returns credentials or approval material in its public result.
 */

import { enrollmentPollingBackoffMs } from '@happier-dev/cli-common/homeEnrollment';
import type { AccountServiceDirectoryAdoptionTarget } from '@happier-dev/cli-common/accountService';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';

export type CliAccountServiceRequestedMethod =
  | Readonly<{ kind: 'key'; action?: 'login' | 'provision'; mode?: 'keyed' }>
  | Readonly<{
      kind: 'provider';
      providerId: string;
      action: 'login' | 'provision';
      mode: 'keyed' | 'keyless';
    }>;

export type CliAccountServiceSelection = Readonly<{
  endpoint: string;
  expectedServerIdentityId?: string;
}>;

export type CliAccountServiceTarget = Readonly<{
  endpoint: string;
  serverIdentityId: string;
}>;

export type CliAccountServiceRestrictedCredential = Readonly<{
  token: string;
}>;

export type CliAccountServiceHomeEntryOutcome =
  | Readonly<{
      kind: 'home_entered';
      homeServerIdentityId: string;
      profileId: string;
      selection: 'explicit' | 'preferred' | 'sole';
      directoryAdoptionFailures?: readonly AccountServiceDirectoryAdoptionTarget[];
    }>
  | Readonly<{
      kind: 'choose_home';
      homes: readonly AccountServiceDirectoryAdoptionTarget[];
      directoryAdoptionFailures?: readonly AccountServiceDirectoryAdoptionTarget[];
    }>
  | Readonly<{
      kind: 'account_connected_no_homes';
      /**
       * Present only when the signed-in service is itself a Home (the dual-role
       * deployment), so the no-Homes state can offer it as a destination.
       */
      availableHome?: Readonly<{ canonicalServerUrl: string }>;
    }>
  | Readonly<{ kind: 'explicit_target_not_linked'; homeServerIdentityId: string }>
  | Readonly<{ kind: 'direct_home_selected' }>
  | Readonly<{ kind: 'home_material_required'; homeServerIdentityId: string; profileId: string; reason: 'missing_material' | 'invalid_material' }>
  | Readonly<{
      kind: 'failure';
      stage: 'refresh' | 'material' | 'enter';
      homeServerIdentityId?: string;
      profileId?: string;
      homeCredentialCommitted: boolean;
      recovery: 'retry_stage' | 'use_home_auth';
      retry?: () => Promise<CliAccountServiceHomeEntryOutcome>;
    }>
  | Readonly<{ kind: 'key_required' }>
  | Readonly<{ kind: 'update_required' }>
  | Readonly<{ kind: 'account_service_unavailable' }>
  | Readonly<{ kind: 'home_unavailable' }>
  | CliAccountServiceApprovalContinuation
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'timed_out' }>
  | Readonly<{ kind: 'identity_mismatch' }>
  | Readonly<{ kind: 'destination_mismatch' }>
  | Readonly<{ kind: 'failed' }>;

export type CliAccountServiceAuthenticationOutcome =
  | Readonly<{
      kind: 'authenticated';
      target: CliAccountServiceTarget;
      credential: CliAccountServiceRestrictedCredential;
    }>
  | Exclude<CliAccountServiceHomeEntryOutcome, { kind: 'home_entered' | 'choose_home' | 'account_connected_no_homes' | 'explicit_target_not_linked' | 'direct_home_selected' | 'home_material_required' | 'failure' | 'home_unavailable' | 'awaiting_approval' }>;

export type CliAccountServiceDirectoryJourneyOutcome =
  | Extract<CliAccountServiceHomeEntryOutcome, {
      kind:
        | 'home_entered'
        | 'choose_home'
        | 'account_connected_no_homes'
        | 'explicit_target_not_linked'
        | 'direct_home_selected'
        | 'home_material_required'
        | 'failure'
        | 'update_required'
        | 'account_service_unavailable'
        | 'home_unavailable'
        | 'awaiting_approval'
        | 'cancelled'
        | 'timed_out'
        | 'identity_mismatch'
        | 'destination_mismatch'
        | 'failed';
    }>;

export type CliAccountServiceApprovalContinuation = Readonly<{
  kind: 'awaiting_approval';
  homeServerIdentityId: string;
  expiresAtMs: number;
  resume(input: Readonly<{ signal: AbortSignal }>): Promise<CliAccountServiceDirectoryAttemptOutcome>;
}>;

export type CliAccountServiceDirectoryAttemptOutcome =
  | Exclude<CliAccountServiceDirectoryJourneyOutcome, { kind: 'awaiting_approval' }>
  | CliAccountServiceApprovalContinuation;

export type CliAccountServiceHomeEntryPorts = Readonly<{
  authenticateExactMethod(input: Readonly<{
    service: CliAccountServiceSelection;
    method: CliAccountServiceRequestedMethod;
    key?: Uint8Array;
    signal?: AbortSignal;
    timeoutMs?: number;
  }>): Promise<CliAccountServiceAuthenticationOutcome>;
  runDirectoryJourney(input: Readonly<{
    target: CliAccountServiceTarget;
    credential: CliAccountServiceRestrictedCredential;
    signal?: AbortSignal;
    timeoutMs?: number;
  }>): Promise<CliAccountServiceDirectoryAttemptOutcome>;
  openSelectedHome(input: Readonly<{
    homeServerIdentityId: string;
    profileId: string;
  }>): Promise<
    | Readonly<{ kind: 'opened' }>
    | Extract<CliAccountServiceHomeEntryOutcome, {
        kind: 'home_unavailable' | 'cancelled' | 'timed_out' | 'identity_mismatch' | 'failed';
      }>
  >;
  /**
   * Reports that the journey has entered the existing-device approval wait.
   * The wait is a poll loop inside this coordinator, so the composing CLI
   * surface cannot otherwise tell the user what is happening or when the
   * request expires.
   */
  reportApprovalWait?(input: Readonly<{
    homeServerIdentityId: string;
    expiresAtMs: number;
  }>): void;
  continueMachineAndService(input: Readonly<{
    homeServerIdentityId: string;
    profileId: string;
  }>): Promise<
    | Readonly<{ kind: 'continued' }>
    | Extract<CliAccountServiceHomeEntryOutcome, {
        kind: 'home_unavailable' | 'cancelled' | 'timed_out' | 'identity_mismatch' | 'failed';
      }>
  >;
}>;

type CliAccountServiceHomeEntryInputBase = Readonly<{
  service: CliAccountServiceSelection;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type CliAccountServiceHomeEntryInput = CliAccountServiceHomeEntryInputBase & (
  | Readonly<{
      existingAuthentication: Extract<CliAccountServiceAuthenticationOutcome, { kind: 'authenticated' }>;
      method?: never;
      key?: never;
    }>
  | Readonly<{
      existingAuthentication?: never;
      method: CliAccountServiceRequestedMethod;
      key?: Uint8Array;
    }>
);


async function waitForApprovalPoll(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type CliAccountServiceHomeEnteredOutcome = Extract<CliAccountServiceHomeEntryOutcome, { kind: 'home_entered' }>;
type CliAccountServiceFailureOutcome = Extract<CliAccountServiceHomeEntryOutcome, { kind: 'failure' }>;

function committedEnterFailure(home: Readonly<{
  homeServerIdentityId: string;
  profileId: string;
}>): CliAccountServiceFailureOutcome {
  return {
    kind: 'failure',
    stage: 'enter',
    ...home,
    homeCredentialCommitted: true,
    recovery: 'retry_stage',
  };
}

async function finalizeHomeEntered(
  entered: CliAccountServiceHomeEnteredOutcome,
  ports: CliAccountServiceHomeEntryPorts,
  signal: AbortSignal,
): Promise<CliAccountServiceHomeEntryOutcome> {
  if (signal.aborted) return { kind: 'cancelled' };
  const home = {
    homeServerIdentityId: entered.homeServerIdentityId,
    profileId: entered.profileId,
  };
  const opened = await ports.openSelectedHome(home);
  if (opened.kind !== 'opened') return opened;
  let continued: Awaited<ReturnType<CliAccountServiceHomeEntryPorts['continueMachineAndService']>>;
  try {
    continued = await ports.continueMachineAndService(home);
  } catch (error) {
    if (error instanceof CredentialRequestRedirectError) throw error;
    return committedEnterFailure(home);
  }
  if (continued.kind !== 'continued') {
    return committedEnterFailure(home);
  }
  return entered;
}

async function finalizeDeferredOutcome(
  outcome: CliAccountServiceHomeEntryOutcome,
  ports: CliAccountServiceHomeEntryPorts,
  callerSignal?: AbortSignal,
): Promise<CliAccountServiceHomeEntryOutcome> {
  if (outcome.kind === 'home_entered') {
    const signal = callerSignal ?? new AbortController().signal;
    return await finalizeHomeEntered(outcome, ports, signal);
  }
  if (outcome.kind === 'failure' && outcome.retry) {
    return decorateFailureRetry(outcome, ports, callerSignal);
  }
  return outcome;
}

function decorateFailureRetry(
  failure: CliAccountServiceFailureOutcome,
  ports: CliAccountServiceHomeEntryPorts,
  callerSignal?: AbortSignal,
): CliAccountServiceFailureOutcome {
  if (!failure.retry) return failure;
  const originalRetry = failure.retry;
  return {
    ...failure,
    retry: async (): Promise<CliAccountServiceHomeEntryOutcome> => {
      if (callerSignal?.aborted) return { kind: 'cancelled' };
      const retried = await originalRetry();
      if (callerSignal?.aborted) return { kind: 'cancelled' };
      return await finalizeDeferredOutcome(retried, ports, callerSignal);
    },
  };
}

async function runCliAccountServiceHomeEntryWithSignal(
  input: CliAccountServiceHomeEntryInput,
  ports: CliAccountServiceHomeEntryPorts,
): Promise<CliAccountServiceHomeEntryOutcome> {
  const signal = input.signal ?? new AbortController().signal;
  const entryDeadlineMs = input.timeoutMs === undefined
    ? Number.POSITIVE_INFINITY
    : Date.now() + input.timeoutMs;
  if (signal.aborted) return { kind: 'cancelled' };
  if (!input.existingAuthentication
    && input.method.kind === 'key'
    && input.method.action !== 'provision'
    && input.key === undefined) {
    return { kind: 'key_required' };
  }

  const authentication = input.existingAuthentication ?? await ports.authenticateExactMethod({
    service: input.service,
    method: input.method,
    ...(input.key ? { key: input.key } : {}),
    signal,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (authentication.kind !== 'authenticated') return authentication;
  if (signal.aborted) return { kind: 'cancelled' };

  let journey = await ports.runDirectoryJourney({
    target: authentication.target,
    credential: authentication.credential,
    signal,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  let approvalPollCount = 1;
  let approvalWaitReported = false;
  while (journey.kind === 'awaiting_approval') {
    if (signal.aborted) return { kind: 'cancelled' };
    if (!approvalWaitReported) {
      approvalWaitReported = true;
      ports.reportApprovalWait?.({
        homeServerIdentityId: journey.homeServerIdentityId,
        expiresAtMs: journey.expiresAtMs,
      });
    }
    const nowMs = Date.now();
    const deadlineMs = Math.min(
      journey.expiresAtMs,
      entryDeadlineMs,
    );
    if (deadlineMs <= nowMs) return { kind: 'timed_out' };
    const elapsed = await waitForApprovalPoll(
      signal,
      Math.min(enrollmentPollingBackoffMs(approvalPollCount), deadlineMs - nowMs),
    );
    if (!elapsed) return { kind: 'cancelled' };
    if (Date.now() >= deadlineMs) return { kind: 'timed_out' };
    journey = await journey.resume({ signal });
    approvalPollCount += 1;
  }
  if (journey.kind !== 'home_entered') return journey;
  return await finalizeHomeEntered(journey, ports, signal);
}

export async function runCliAccountServiceHomeEntry(
  input: CliAccountServiceHomeEntryInput,
  ports: CliAccountServiceHomeEntryPorts,
): Promise<CliAccountServiceHomeEntryOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort();
  input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timer = input.timeoutMs === undefined
    ? null
    : setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, input.timeoutMs);
  try {
    const result = await runCliAccountServiceHomeEntryWithSignal({
      ...input,
      signal: controller.signal,
    }, ports);
    // Opening the Home and continuing machine/service setup are deliberately
    // non-cancellable. Once both report success, that completed terminal fact
    // must win over a timeout or caller abort that raced during continuation.
    if (result.kind !== 'home_entered') {
      if (result.kind === 'failure' && result.homeCredentialCommitted) {
        return result.retry ? decorateFailureRetry(result, ports, input.signal) : result;
      }
      if (timedOut) return { kind: 'timed_out' };
      if (input.signal?.aborted) return { kind: 'cancelled' };
      if (result.kind === 'failure' && result.retry) {
        return decorateFailureRetry(result, ports, input.signal);
      }
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}
