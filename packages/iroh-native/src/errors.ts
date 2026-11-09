export type IrohErrorCode =
  | 'unavailable'
  | 'invalid_descriptor'
  | 'endpoint_identity_invalid'
  | 'identity_mismatch'
  | 'endpoint_key_unavailable'
  | 'relay_auth_failed'
  | 'invalid_preamble'
  | 'unsupported_alpn'
  | 'endpoint_config_conflict'
  | 'loopback_bind_failed'
  | 'home_unreachable'
  | 'transport_timeout'
  | 'transport_closed'
  | 'resource_limit'
  | 'cancelled'
  | 'transport'
  | 'unknown';

export class IrohError extends Error {
  readonly code: IrohErrorCode;
  constructor(code: IrohErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IrohError';
    this.code = code;
  }
}

const NATIVE_ERROR_CODES: Readonly<Record<string, IrohErrorCode>> = {
  unavailable: 'unavailable',
  native_unavailable: 'unavailable',
  'engine-unavailable': 'unavailable',
  invalid_request: 'invalid_descriptor',
  'invalid-request': 'invalid_descriptor',
  invalid_descriptor: 'invalid_descriptor',
  'endpoint-identity-invalid': 'endpoint_identity_invalid',
  endpoint_identity_invalid: 'endpoint_identity_invalid',
  'endpoint-identity-mismatch': 'identity_mismatch',
  endpoint_identity_mismatch: 'identity_mismatch',
  identity_mismatch: 'identity_mismatch',
  endpoint_key_unavailable: 'endpoint_key_unavailable',
  'endpoint-key-unavailable': 'endpoint_key_unavailable',
  relay_auth_failed: 'relay_auth_failed',
  'relay-auth-failed': 'relay_auth_failed',
  invalid_preamble: 'invalid_preamble',
  'invalid-preamble': 'invalid_preamble',
  unsupported_alpn: 'unsupported_alpn',
  'unsupported-alpn': 'unsupported_alpn',
  endpoint_config_conflict: 'endpoint_config_conflict',
  loopback_bind_failed: 'loopback_bind_failed',
  'loopback-bind-failed': 'loopback_bind_failed',
  home_unreachable: 'home_unreachable',
  'home-unreachable': 'home_unreachable',
  transport_timeout: 'transport_timeout',
  'transport-timeout': 'transport_timeout',
  transport_closed: 'transport_closed',
  'transport-closed': 'transport_closed',
  resource_limit: 'resource_limit',
  'resource-limit': 'resource_limit',
  cancelled: 'cancelled',
  'transport-unavailable': 'transport',
  transport: 'transport',
  'machine-control-invalid': 'invalid_descriptor',
  'machine-admission-rejected': 'unknown',
};

/** Canonical native-code normalization shared by Node, Expo, and desktop. */
export function classifyIrohNativeErrorCode(nativeCode: string): IrohErrorCode {
  return NATIVE_ERROR_CODES[nativeCode] ?? 'unknown';
}

function readStringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function readNativeCode(error: unknown): string | null {
  return readStringField(error, 'nativeCode')
    ?? readStringField(error, 'code')
    ?? readStringField(
      typeof error === 'object' && error !== null
        ? (error as Record<string, unknown>).userInfo
        : null,
      'code',
    );
}

function readPrefixedNativeFailure(message: string): Readonly<{ code: string; message: string }> | null {
  const prefix = 'iroh_native_error:';
  if (!message.startsWith(prefix)) return null;
  const encoded = message.slice(prefix.length);
  const separator = encoded.indexOf(':');
  if (separator <= 0) return null;
  return { code: encoded.slice(0, separator), message: encoded.slice(separator + 1) };
}

/**
 * Normalizes real Expo CodedException/NSError/Java exception shapes without
 * serializing the error object (which could carry native/private fields).
 */
export function normalizeIrohNativeError(
  error: unknown,
  fallbackCode: IrohErrorCode = 'unavailable',
): IrohError {
  if (error instanceof IrohError) {
    return error.name === 'IrohError'
      ? error
      : new IrohError(error.code, error.message, { cause: error });
  }
  const message = error instanceof Error ? error.message : 'Iroh native operation failed';
  const prefixed = readPrefixedNativeFailure(message);
  if (prefixed) {
    return new IrohError(classifyIrohNativeErrorCode(prefixed.code), prefixed.message, { cause: error });
  }
  const nativeCode = readNativeCode(error);
  return new IrohError(
    nativeCode === null ? fallbackCode : classifyIrohNativeErrorCode(nativeCode),
    message,
    { cause: error },
  );
}

export const IROH_HOME_TUNNEL_SUSPENDED_ERROR = 'iroh_home_tunnel_suspended';
export const IROH_HOME_TUNNEL_PROBE_FAILED_ERROR = 'iroh_home_tunnel_probe_failed';
export const IROH_HOME_TUNNEL_STALE_GENERATION_ERROR = 'iroh_home_tunnel_stale_generation';
export const IROH_HOME_TUNNEL_STALE_FOCUS_ERROR = 'iroh_home_tunnel_stale_focus';
export const IROH_HOME_TUNNEL_INVALID_ENDPOINT_ERROR = 'iroh_home_tunnel_invalid_endpoint';

export type IrohHomeCarrierFailureClass =
  | 'carrier-unavailable'
  | 'identity-auth'
  | 'descriptor-integrity'
  | 'protocol'
  | 'endpoint-config'
  | 'stale-target'
  | 'verification-incomplete'
  | 'unclassified';

export type IrohHomeCarrierFailureClassification = Readonly<{
  fallbackAllowed: boolean;
  failureClass: IrohHomeCarrierFailureClass;
}>;

const FALLBACK_ALLOWED: IrohHomeCarrierFailureClassification = {
  fallbackAllowed: true,
  failureClass: 'carrier-unavailable',
};

function failClosed(failureClass: IrohHomeCarrierFailureClass): IrohHomeCarrierFailureClassification {
  return { fallbackAllowed: false, failureClass };
}

const IROH_ERROR_CLASSIFICATIONS: Readonly<Record<IrohErrorCode, IrohHomeCarrierFailureClassification>> = {
  unavailable: FALLBACK_ALLOWED,
  transport: FALLBACK_ALLOWED,
  home_unreachable: FALLBACK_ALLOWED,
  transport_timeout: FALLBACK_ALLOWED,
  transport_closed: FALLBACK_ALLOWED,
  invalid_descriptor: failClosed('descriptor-integrity'),
  endpoint_identity_invalid: failClosed('descriptor-integrity'),
  identity_mismatch: failClosed('identity-auth'),
  endpoint_key_unavailable: FALLBACK_ALLOWED,
  relay_auth_failed: failClosed('identity-auth'),
  invalid_preamble: FALLBACK_ALLOWED,
  unsupported_alpn: FALLBACK_ALLOWED,
  endpoint_config_conflict: FALLBACK_ALLOWED,
  loopback_bind_failed: FALLBACK_ALLOWED,
  resource_limit: FALLBACK_ALLOWED,
  cancelled: failClosed('unclassified'),
  unknown: FALLBACK_ALLOWED,
};

const PROBE_REASON_CLASSIFICATIONS: Readonly<Record<string, IrohHomeCarrierFailureClassification>> = {
  'health-unavailable': FALLBACK_ALLOWED,
  'probe-timeout': FALLBACK_ALLOWED,
  'auth-failed': failClosed('identity-auth'),
  'identity-mismatch': failClosed('identity-auth'),
  'features-unavailable': FALLBACK_ALLOWED,
};

function readIrohErrorCode(error: unknown): IrohErrorCode | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Readonly<{ name?: unknown; code?: unknown }>;
  if (
    (candidate.name !== 'IrohError' && candidate.name !== 'IrohNativeOperationError')
    || typeof candidate.code !== 'string'
  ) return null;
  return Object.prototype.hasOwnProperty.call(IROH_ERROR_CLASSIFICATIONS, candidate.code)
    ? candidate.code as IrohErrorCode
    : null;
}

/**
 * Classifies Home Iroh failure independently of the selected carrier's lifetime.
 * Non-security failures permit another descriptor-declared carrier, whose Home
 * identity the caller must verify independently. Identity/auth and descriptor
 * integrity refusals fail closed. Cancelled or retired operations do not acquire
 * another carrier.
 */
export function classifyIrohHomeCarrierFailure(error: unknown): IrohHomeCarrierFailureClassification {
  const code = readIrohErrorCode(error);
  if (code !== null) return IROH_ERROR_CLASSIFICATIONS[code];

  const message = error instanceof Error ? error.message : '';
  if (error instanceof Error && error.name === 'AbortError') return failClosed('unclassified');
  if (message === IROH_HOME_TUNNEL_SUSPENDED_ERROR) return FALLBACK_ALLOWED;
  if (message.startsWith(`${IROH_HOME_TUNNEL_PROBE_FAILED_ERROR}:`)) {
    const reason = message.slice(IROH_HOME_TUNNEL_PROBE_FAILED_ERROR.length + 1);
    return PROBE_REASON_CLASSIFICATIONS[reason] ?? { fallbackAllowed: true, failureClass: 'unclassified' };
  }
  if (message === IROH_HOME_TUNNEL_STALE_GENERATION_ERROR || message === IROH_HOME_TUNNEL_STALE_FOCUS_ERROR) {
    return failClosed('stale-target');
  }
  if (message === IROH_HOME_TUNNEL_INVALID_ENDPOINT_ERROR) return failClosed('descriptor-integrity');
  return { fallbackAllowed: true, failureClass: 'unclassified' };
}
