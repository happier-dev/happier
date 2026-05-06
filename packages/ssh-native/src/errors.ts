import type { NativeSshUnavailableReason } from './HappierSshNative.types';

export type NativeSshErrorCode =
  | 'unavailable'
  | 'connection-failed'
  | 'host-key-mismatch'
  | 'authentication-failed'
  | 'exec-timeout'
  | 'exec-exit-failure'
  | 'cancellation'
  | 'engine-internal';

export type NativeSshErrorInit = Readonly<{
  code: NativeSshErrorCode;
  message: string;
  reason?: NativeSshUnavailableReason;
  detail?: string;
  cause?: unknown;
}>;

const ERROR_CODES = new Set<NativeSshErrorCode>([
  'unavailable',
  'connection-failed',
  'host-key-mismatch',
  'authentication-failed',
  'exec-timeout',
  'exec-exit-failure',
  'cancellation',
  'engine-internal',
]);

export class NativeSshError extends Error {
  readonly code: NativeSshErrorCode;
  readonly reason?: NativeSshUnavailableReason;
  readonly detail?: string;

  constructor(init: NativeSshErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'NativeSshError';
    this.code = init.code;
    this.reason = init.reason;
    this.detail = init.detail;
  }
}

export function normalizeNativeSshError(error: unknown): NativeSshError {
  if (error instanceof NativeSshError) return error;

  if (isStructuredNativeSshError(error)) {
    return new NativeSshError({
      code: error.code,
      message: sanitizeNativeSshErrorMessage(error.message),
      detail: typeof error.detail === 'string' ? error.detail : undefined,
      cause: error,
    });
  }

  return new NativeSshError({
    code: 'engine-internal',
    message: 'Native SSH engine failed.',
    cause: error,
  });
}

function isStructuredNativeSshError(value: unknown): value is Readonly<{ code: NativeSshErrorCode; message: string; detail?: unknown }> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === 'string' && ERROR_CODES.has(candidate.code as NativeSshErrorCode) && typeof candidate.message === 'string';
}

function sanitizeNativeSshErrorMessage(message: string): string {
  if (containsCredentialMarker(message)) return 'Native SSH engine failed.';
  return message.trim() || 'Native SSH engine failed.';
}

function containsCredentialMarker(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('password') ||
    lower.includes('passphrase') ||
    lower.includes('privatekey') ||
    lower.includes('private key') ||
    lower.includes('keyboardinteractive') ||
    value.includes('-----BEGIN')
  );
}
