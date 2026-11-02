import {
  parseHomeTargetInput,
  type HomeTargetInput,
} from '../../homeTarget/homeTarget.js';
import type { HappierJsonExecutor, HappierTextResult } from '../executors/happierJsonExecutor.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { ManagedEnrollmentCorrelationV1Schema, type ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { formatRemoteEnrollmentCommandFailure, formatHomeAuthorityMismatchFacts, readGuestCliFailure,
  type GuestCliFailureFacts } from '@happier-dev/protocol/ssh/commandFailure';
import { projectRemoteHomeEnrollmentFailure } from './remoteHomeEnrollmentFailure.js';

export type RemoteHomeEnrollmentPairingRequest = Readonly<{
  publicKey: string;
  homeServerIdentityId: string;
  pairing: Readonly<{
    secretB64Url: string;
    createdAtMs: number;
    expiresAtMs: number;
  }>;
  supportsTokenOnly: true;
  pairingRequirement: 'v3';
  remoteProfileId?: string;
}>;

export type RemoteHomeEnrollmentResult = Readonly<{
  success: true;
  homeServerIdentityId: string;
  machineId: string;
  encryptionType: 'dataKey' | 'tokenOnly';
  pairingAuthentication: 'v3';
  remoteProfileId: string;
}>;

const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
const OLDER_AUTH_HELP_HEADING = 'happier auth - Authentication management';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function readNonEmptyString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/** cli-v0.2.16 request JSON or unsupported enroll-remote: refusal, never fallback auth. */
function readOlderEnrollmentError(value: unknown, commandResult?: HappierTextResult): SystemTaskExecutionError | null {
  if (commandResult) {
    if (commandResult.status !== 1
      || commandResult.stderr.trim() !== 'Unknown auth subcommand: enroll-remote'
      || commandResult.stdout.trimStart().split(/\r?\n/u)[0] !== OLDER_AUTH_HELP_HEADING) return null;
  } else {
    if (!isRecord(value) || value.kind !== undefined
      || !['publicKey', 'publicKeyB64Url', 'claimSecret', 'serverId', 'serverUrl', 'publicServerUrl', 'webappUrl', 'stateFile']
        .every((key) => readNonEmptyString(value[key]))
      || (value.pairingRequirement !== 'compatible' && value.pairingRequirement !== 'v3')) return null;
    const links = value.links;
    if (!isRecord(links)
      || !['configureWebUrl', 'configureMobileUrl', 'webUrl', 'mobileUrl'].every((key) => readNonEmptyString(links[key]))
      || !isRecord(value.pairing)) return null;
    const pairing = value.pairing;
    if (!readNonEmptyString(pairing.secretB64Url)
      || typeof pairing.createdAtMs !== 'number' || !Number.isSafeInteger(pairing.createdAtMs)
      || typeof pairing.expiresAtMs !== 'number' || !Number.isSafeInteger(pairing.expiresAtMs)
      || pairing.expiresAtMs <= pairing.createdAtMs) return null;
  }
  // Never attach the response: ordinary auth stdout contains claim/pairing secrets.
  return new SystemTaskExecutionError('remote_cli_update_required',
    'Update Happier CLI on the remote machine to connect it to this Home, then retry setup.');
}

function parsePairingRequest(value: unknown): RemoteHomeEnrollmentPairingRequest | null {
  if (!isRecord(value)
    || value.kind !== 'remote_home_enrollment_pairing_request'
    || value.protocolVersion !== 1
    || value.supportsTokenOnly !== true
    || value.pairingRequirement !== 'v3'
    || !hasOnlyKeys(value, [
      'kind',
      'protocolVersion',
      'publicKey',
      'homeServerIdentityId',
      'pairing',
      'supportsTokenOnly',
      'pairingRequirement',
      'remoteProfileId',
    ])) {
    return null;
  }
  const publicKey = readNonEmptyString(value.publicKey);
  const remoteProfileId = value.remoteProfileId === undefined ? undefined : readNonEmptyString(value.remoteProfileId);
  const homeServerIdentityId = normalizeServerIdentityIdCapability(value.homeServerIdentityId);
  const pairing = isRecord(value.pairing) ? value.pairing : null;
  if (!publicKey || remoteProfileId === null || !homeServerIdentityId || !pairing || !hasOnlyKeys(pairing, [
    'secretB64Url',
    'createdAtMs',
    'expiresAtMs',
  ])) {
    return null;
  }
  const secretB64Url = readNonEmptyString(pairing.secretB64Url);
  const createdAtMs = pairing.createdAtMs;
  const expiresAtMs = pairing.expiresAtMs;
  if (!secretB64Url
    || typeof createdAtMs !== 'number'
    || !Number.isSafeInteger(createdAtMs)
    || typeof expiresAtMs !== 'number'
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= createdAtMs) {
    return null;
  }
  return {
    publicKey,
    homeServerIdentityId,
    pairing: { secretB64Url, createdAtMs, expiresAtMs },
    supportsTokenOnly: true,
    pairingRequirement: 'v3',
    ...(remoteProfileId ? { remoteProfileId } : {}),
  };
}

function parseResult(value: unknown): RemoteHomeEnrollmentResult | null {
  if (!isRecord(value)
    || value.kind !== 'remote_home_enrollment_result'
    || value.protocolVersion !== 1
    || value.success !== true
    || value.pairingAuthentication !== 'v3'
    || (value.encryptionType !== 'dataKey' && value.encryptionType !== 'tokenOnly')
    || !hasOnlyKeys(value, [
      'kind',
      'protocolVersion',
      'success',
      'homeServerIdentityId',
      'machineId',
      'encryptionType',
      'pairingAuthentication',
      'remoteProfileId',
    ])) {
    return null;
  }
  const homeServerIdentityId = normalizeServerIdentityIdCapability(value.homeServerIdentityId);
  const machineId = readNonEmptyString(value.machineId);
  const remoteProfileId = readNonEmptyString(value.remoteProfileId);
  if (!homeServerIdentityId || !machineId || !remoteProfileId) return null;
  return {
    success: true,
    homeServerIdentityId,
    machineId,
    encryptionType: value.encryptionType,
    pairingAuthentication: 'v3',
    remoteProfileId,
  };
}

function createLinkedAbortController(signal: AbortSignal | undefined): Readonly<{
  controller: AbortController;
  dispose(): void;
}> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    controller,
    dispose: () => signal?.removeEventListener('abort', onAbort),
  };
}

/**
 * Runs normal Home enrollment using either the SSH stream or finite auth
 * request/wait commands for the base buffered native carrier.
 *
 * Claim/key secrets stay guest-owned: in memory for the SSH ceremony or in
 * normal protected pending state between buffered invocations. This coordinator
 * receives only the short-lived v3 approval context and non-secret completion.
 */
export async function runRemoteHomeEnrollmentFlow(params: Readonly<{
  executor: HappierJsonExecutor;
  homeTargetInput: HomeTargetInput;
  managedEnrollment?: ManagedEnrollmentCorrelationV1;
  machineDisplayName?: string;
  /** Native exec requires only buffered process results, never output observers. */
  processIO?: 'streaming' | 'buffered';
  approvePairingRequest(request: RemoteHomeEnrollmentPairingRequest): Promise<void>;
  signal?: AbortSignal;
  /** The pairing request supplies the enrollment deadline once it exists. */
  onEnrollmentDeadline?(deadlineMs: number): void;
}>): Promise<RemoteHomeEnrollmentResult> {
  let deadlineMs: number | undefined;
  let onDeadlineChanged: (() => void) | undefined;
  const pairingExpired = () => new SystemTaskExecutionError('auth_request_expired',
    'Remote machine pairing approval expired. Retry setup to request fresh approval.');
  const remainingMs = (): number | null => {
    params.signal?.throwIfAborted();
    if (deadlineMs === undefined) return null;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw pairingExpired();
    return remaining;
  };
  const approvePairingRequest = async (request: RemoteHomeEnrollmentPairingRequest, signal = params.signal): Promise<void> => {
    // Only the Home's issued pairing expiry bounds consent. Before this
    // request exists, setup remains under the caller's cancellation signal.
    deadlineMs = request.pairing.expiresAtMs;
    params.onEnrollmentDeadline?.(deadlineMs);
    onDeadlineChanged?.();
    const approvalDeadlineMs = deadlineMs;
    const expired = pairingExpired;
    signal?.throwIfAborted();
    if (Date.now() >= approvalDeadlineMs) throw expired();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        params.approvePairingRequest(request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(expired()), approvalDeadlineMs - Date.now());
          onAbort = () => reject(signal?.reason);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
      ]);
      signal?.throwIfAborted();
      if (Date.now() >= approvalDeadlineMs) throw expired();
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
  const homeTargetInput = parseHomeTargetInput(params.homeTargetInput);
  const managedEnrollment = params.managedEnrollment === undefined ? undefined
    : ManagedEnrollmentCorrelationV1Schema.parse(params.managedEnrollment);
  if (managedEnrollment && (homeTargetInput.kind !== 'descriptor'
    || homeTargetInput.descriptor.homeServerIdentityId !== managedEnrollment.homeId)) {
    throw new SystemTaskExecutionError('home_identity_mismatch', 'Managed enrollment requires its exact admitted Home.');
  }
  if (params.processIO === 'buffered') {
    const capture = async (args: readonly string[], input?: string): Promise<unknown> => {
      params.signal?.throwIfAborted();
      const result = await params.executor.runHappierText(args, {
        ...(input === undefined ? {} : { input }), signal: params.signal,
        timeoutMs: remainingMs(), includeStdoutInError: false,
      });
      params.signal?.throwIfAborted();
      if (Buffer.byteLength(result.stdout, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
        throw new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment protocol line was too large.');
      }
      let response: unknown;
      let parsed = false;
      try { response = JSON.parse(result.stdout); parsed = true; } catch {
        if (result.status === 0) throw new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment returned invalid JSON.');
      }
      if (result.status !== 0 || (isRecord(response) && response.ok === false)) {
        if (result.status === 137) {
          throw new SystemTaskExecutionError('remote_command_failed', formatRemoteEnrollmentCommandFailure({
            phase: args[1] === 'wait' ? 'auth.wait' : 'auth.request', exitStatus: result.status,
            stdoutPresent: Boolean(result.stdout.trim()), stderrPresent: Boolean(result.stderr.trim()),
          }));
        }
        const diagnostic = isRecord(response) && response.v === 1 && response.ok === false
          && response.kind === `auth_${args[1]}` && isRecord(response.error) ? response.error : null;
        const fields = [`exit ${result.status}`];
        const guestFailure = diagnostic ? readGuestCliFailure(response) : null;
        const guestCode = guestFailure?.guestCliCode;
        if (guestCode) fields.push(`code ${guestCode}`);
        if (args[1] === 'wait' && fields.length === 1) {
          // Native termination/startup can prevent the CLI envelope entirely.
          // The process failure is known; its authentication cause is not.
          // Distinguish absent output from an unreadable envelope without
          // revealing native stdout/stderr (which may contain credentials).
          fields.push('code AUTH_WAIT_PROCESS_FAILED');
          fields.push(`diagnostic ${result.stdout.trim() ? 'invalid' : 'absent'}`);
          if (result.stdout.trim()) {
            // Only the failed check name crosses the boundary. Never include
            // rejected values, output fragments or parser error messages.
            const check = !parsed ? 'parse'
              : !isRecord(response) || response.v !== 1 ? 'v'
              : response.ok !== false ? 'ok'
              : response.kind !== `auth_${args[1]}` ? 'kind' : 'code';
            fields.push(`check ${check}`);
          }
        }
        if (diagnostic && ['http_error', 'auth_error'].includes(String(diagnostic.category))) {
          fields.push(`category ${diagnostic.category}`);
        }
        if (typeof diagnostic?.status === 'number' && Number.isInteger(diagnostic.status) && diagnostic.status >= 100 && diagnostic.status <= 599) {
          fields.push(`HTTP ${diagnostic.status}`);
        }
        const serverCode = readUnexpectedActionErrorDiagnosticV1({ code: diagnostic?.serverCode }).errorCode;
        if (serverCode !== null) fields.push(`server code ${serverCode}`);
        if (guestFailure?.homeAuthority) fields.push(formatHomeAuthorityMismatchFacts(guestFailure.homeAuthority));
        throw new SystemTaskExecutionError('remote_command_failed', `Remote Home enrollment failed during auth ${args[1]} (${fields.join('; ')}).`);
      }
      return response;
    };
    const response = await capture(
      ['auth', 'request', '--json', '--remote-enrollment', '--home-target-stdin', ...(managedEnrollment ? ['--managed-enrollment-stdin'] : [])],
      JSON.stringify(managedEnrollment ? { homeTarget: homeTargetInput, managedEnrollment, machineDisplayName: params.machineDisplayName } : homeTargetInput),
    );
    const olderAuthRequestError = readOlderEnrollmentError(response);
    if (olderAuthRequestError) throw olderAuthRequestError;
    const request = parsePairingRequest(response);
    if (!request?.remoteProfileId) throw new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment did not return a pairing request.');
    if (homeTargetInput.kind === 'descriptor' && request.homeServerIdentityId !== homeTargetInput.descriptor.homeServerIdentityId) {
      throw new SystemTaskExecutionError('home_identity_mismatch', 'Remote enrollment request does not match the selected Home identity.');
    }
    await approvePairingRequest(request);
    params.signal?.throwIfAborted();
    const result = parseResult(await capture(['auth', 'wait', '--json', '--remote-enrollment', '--server', request.remoteProfileId, '--no-persist', '--public-key', request.publicKey]));
    if (!result) throw new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment did not return a valid completion result.');
    if (result.homeServerIdentityId !== request.homeServerIdentityId || result.remoteProfileId !== request.remoteProfileId) {
      throw new SystemTaskExecutionError('home_identity_mismatch', 'Remote enrollment changed Home identity during pairing.');
    }
    return result;
  }
  const linked = createLinkedAbortController(params.signal);
  let lineBuffer = '';
  const state: {
    pairingRequest: RemoteHomeEnrollmentPairingRequest | null;
    result: RemoteHomeEnrollmentResult | null;
    lineCount: number;
  } = { pairingRequest: null, result: null, lineCount: 0 };
  let guestFailure: GuestCliFailureFacts | null = null;
  const processStartedAtMs = Date.now();
  let approvalPromise: Promise<void> | null = null;
  let approvalError: unknown = null;
  let authHelpOutput = false;
  let streamDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const processFailure = (code: Parameters<typeof projectRemoteHomeEnrollmentFailure>[0]['code'], result?: HappierTextResult) =>
    projectRemoteHomeEnrollmentFailure({ code, result, startedAtMs: processStartedAtMs, guestFailure,
      requestEventSeen: state.pairingRequest !== null, finalResultEventSeen: state.result !== null,
      signal: params.signal });
  const projectControllerFailure = (error: unknown, result?: HappierTextResult): unknown => {
    // Preserve the controller's causal refusal code; diagnostics never decide a
    // new deadline, cancellation, approval or authentication outcome.
    if (!(error instanceof SystemTaskExecutionError)
      || error.code !== 'auth_enrollment_timeout' && error.code !== 'auth_request_expired' && error.code !== 'cancelled') return error;
    return processFailure(error.code, result);
  };

  const armStreamDeadline = (): void => {
    clearTimeout(streamDeadlineTimer);
    if (deadlineMs === undefined) return;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      approvalError = pairingExpired();
      linked.controller.abort();
      return;
    }
    streamDeadlineTimer = setTimeout(() => {
      approvalError = pairingExpired();
      linked.controller.abort();
    }, remaining);
  };
  onDeadlineChanged = armStreamDeadline;

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      approvalError = new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment protocol line was too large.');
      linked.controller.abort();
      return;
    }
    // Released CLI help must finish before status/stderr can qualify it. It
    // cannot supply pairing events.
    if (state.lineCount === 0 && trimmed === OLDER_AUTH_HELP_HEADING) authHelpOutput = true;
    if (authHelpOutput) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      approvalError = new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment returned invalid JSON lines.');
      linked.controller.abort();
      return;
    }
    const diagnostic = readGuestCliFailure(parsed);
    if (isRecord(parsed) && parsed.kind === 'auth_enroll_remote' && diagnostic && !guestFailure
      && (state.lineCount === 0 || state.lineCount === 1 && state.pairingRequest)) {
      guestFailure = diagnostic;
      state.lineCount += 1;
      return;
    }
    state.lineCount += 1;
    const olderAuthRequestError = state.lineCount === 1 ? readOlderEnrollmentError(parsed) : null;
    if (olderAuthRequestError) {
      approvalError = olderAuthRequestError;
      linked.controller.abort();
      return;
    }
    const request = parsePairingRequest(parsed);
    if (state.lineCount === 1 && request) {
      if (
        homeTargetInput.kind === 'descriptor'
        && request.homeServerIdentityId !== homeTargetInput.descriptor.homeServerIdentityId
      ) {
        approvalError = new SystemTaskExecutionError(
          'home_identity_mismatch',
          'Remote enrollment request does not match the selected Home identity.',
        );
        linked.controller.abort();
        return;
      }
      state.pairingRequest = request;
      approvalPromise = approvePairingRequest(request, linked.controller.signal).catch((error: unknown) => {
        approvalError ??= error;
        linked.controller.abort();
      });
      return;
    }
    const result = parseResult(parsed);
    if (state.lineCount === 2 && state.pairingRequest && result) {
      state.result = result;
      return;
    }
    if (!approvalError) {
      approvalError = new SystemTaskExecutionError(
        'invalid_cli_response',
        'Remote enrollment returned an invalid event sequence.',
      );
    }
    linked.controller.abort();
  };

  try {
    let commandResult;
    try {
      commandResult = await params.executor.runHappierText(
        ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin', ...(managedEnrollment ? ['--managed-enrollment-stdin'] : [])],
        {
          input: JSON.stringify(managedEnrollment ? { homeTarget: homeTargetInput, managedEnrollment, machineDisplayName: params.machineDisplayName } : homeTargetInput),
          signal: linked.controller.signal,
          // This process spans request creation and consent. The flow owns a
          // re-armable deadline because the pairing expiry is learned on stdout.
          timeoutMs: null,
          includeStdoutInError: false,
          onStdoutChunk: (chunk) => {
            lineBuffer += chunk;
            if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
              approvalError = new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment protocol line was too large.');
              linked.controller.abort();
              return;
            }
            let newline = lineBuffer.indexOf('\n');
            while (newline >= 0) {
              consumeLine(lineBuffer.slice(0, newline));
              lineBuffer = lineBuffer.slice(newline + 1);
              newline = lineBuffer.indexOf('\n');
            }
          },
        },
      );
    } catch (error) {
      if (params.signal?.aborted) throw projectControllerFailure(new SystemTaskExecutionError('cancelled', 'Remote Home enrollment was cancelled.'));
      if (approvalError) throw projectControllerFailure(approvalError);
      throw error;
    }
    consumeLine(lineBuffer);
    if (params.signal?.aborted) throw projectControllerFailure(new SystemTaskExecutionError('cancelled', 'Remote Home enrollment was cancelled.'), commandResult);
    if (approvalError) throw projectControllerFailure(approvalError, commandResult);
    const olderEnrollmentError = readOlderEnrollmentError(undefined, commandResult);
    if (olderEnrollmentError) throw olderEnrollmentError;
    const processFacts = `exit ${commandResult.status}; stdout ${commandResult.stdout.trim() ? 'present' : 'absent'}; stderr ${commandResult.stderr.trim() ? 'present' : 'absent'}`;
    if (commandResult.status !== 0) {
      throw processFailure('remote_command_failed', commandResult);
    }
    const pairingRequest = state.pairingRequest;
    if (!pairingRequest) {
      throw new SystemTaskExecutionError('invalid_cli_response', `Remote enrollment did not return a pairing request (${processFacts}).`);
    }
    const result = state.result;
    if (!result) {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment did not return a valid completion result.');
    }
    if (state.lineCount !== 2) {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment returned an invalid event count.');
    }
    if (result.homeServerIdentityId !== pairingRequest.homeServerIdentityId) {
      throw new SystemTaskExecutionError('home_identity_mismatch', 'Remote enrollment changed Home identity during pairing.');
    }
    // Only a valid completion can still depend on consent. A terminal failure
    // must leave the task lifetime free to retire its unanswered prompt.
    await approvalPromise;
    if (approvalError) throw projectControllerFailure(approvalError, commandResult);
    return result;
  } finally {
    clearTimeout(streamDeadlineTimer);
    onDeadlineChanged = undefined;
    linked.controller.abort();
    await approvalPromise;
    linked.dispose();
  }
}
