import {
  parseHomeTargetInput,
  type HomeTargetInput,
} from '../../homeTarget/homeTarget.js';
import type { HappierJsonExecutor } from '../executors/happierJsonExecutor.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

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
    ])) {
    return null;
  }
  const publicKey = readNonEmptyString(value.publicKey);
  const homeServerIdentityId = normalizeServerIdentityIdCapability(value.homeServerIdentityId);
  const pairing = isRecord(value.pairing) ? value.pairing : null;
  if (!publicKey || !homeServerIdentityId || !pairing || !hasOnlyKeys(pairing, [
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
 * Runs the SSH-only, single-process Home enrollment ceremony.
 *
 * The remote process owns every claim/key secret in memory and persists only
 * its final Home credential. This coordinator receives only the short-lived
 * v3 approval context and a strict non-secret completion projection.
 */
export async function runRemoteHomeEnrollmentRecipe(params: Readonly<{
  executor: HappierJsonExecutor;
  homeTargetInput: HomeTargetInput;
  approvePairingRequest(request: RemoteHomeEnrollmentPairingRequest): Promise<void>;
  signal?: AbortSignal;
  timeoutMs: number;
}>): Promise<RemoteHomeEnrollmentResult> {
  const homeTargetInput = parseHomeTargetInput(params.homeTargetInput);
  const linked = createLinkedAbortController(params.signal);
  let lineBuffer = '';
  const state: {
    pairingRequest: RemoteHomeEnrollmentPairingRequest | null;
    result: RemoteHomeEnrollmentResult | null;
    lineCount: number;
  } = { pairingRequest: null, result: null, lineCount: 0 };
  let approvalPromise: Promise<void> | null = null;
  let approvalError: unknown = null;

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      approvalError = new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment protocol line was too large.');
      linked.controller.abort();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      approvalError = new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment returned invalid JSON lines.');
      linked.controller.abort();
      return;
    }
    state.lineCount += 1;
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
      approvalPromise = params.approvePairingRequest(request).catch((error: unknown) => {
        approvalError = error;
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
        ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
        {
          input: JSON.stringify(homeTargetInput),
          signal: linked.controller.signal,
          timeoutMs: params.timeoutMs,
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
      await approvalPromise;
      if (approvalError) throw approvalError;
      throw error;
    }
    consumeLine(lineBuffer);
    await approvalPromise;
    if (approvalError) throw approvalError;
    const pairingRequest = state.pairingRequest;
    if (!pairingRequest) {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Remote enrollment did not return a pairing request.');
    }
    if (commandResult.status !== 0) {
      throw new SystemTaskExecutionError('remote_command_failed', 'Remote Home enrollment failed.');
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
    return result;
  } finally {
    linked.dispose();
  }
}
