import { connectedServiceRuntimeAuthRecoveryCanOwnTurnFailure } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readRuntimeAuthRecoveryResult(error: unknown): Readonly<Record<string, unknown>> | null {
  return readRecord(readRecord(error)?.runtimeAuthRecoveryResult);
}

export function runtimeAuthRecoveryCanOwnPrimaryTurnFailure(error: unknown): boolean {
  return connectedServiceRuntimeAuthRecoveryCanOwnTurnFailure(readRuntimeAuthRecoveryResult(error));
}
