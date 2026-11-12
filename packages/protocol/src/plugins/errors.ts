import { readActionFailureCauseV1, type ActionFailureCauseV1 } from '../actions/actionExecutionResult.js';

/**
 * The canonical serialized PluginError payload. Recognition only needs the
 * closed identity and consistency fields; the SDK owns the author vocabulary
 * (`details`, `remediation`, `diagnostics`) that rides alongside them.
 */
export type PluginErrorContractData = Readonly<{
  name: 'PluginError';
  code: string;
  message?: string;
  retryable?: boolean;
  failureCause?: ActionFailureCauseV1;
}>;

/**
 * The structural projection of a thrown canonical PluginError. Protocol
 * deliberately models only what the contract guarantees rather than the SDK
 * class, so no realm has to import the SDK to prove the contract.
 */
export type PluginErrorContract = Error & Readonly<{
  code: string;
  retryable: boolean;
  data: PluginErrorContractData;
}>;

type PluginErrorCandidate = Error & Readonly<{
  code?: unknown;
  retryable?: unknown;
  data?: unknown;
}>;

type PluginErrorIdentityData = Pick<PluginErrorContractData, 'name' | 'code' | 'message' | 'retryable'>;

/** The serialized public identity, shared by thrown-error proof and RPC restoration. */
export function isPluginErrorData(value: unknown): value is PluginErrorIdentityData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Readonly<Record<string, unknown>>;
  return data.name === 'PluginError' && typeof data.code === 'string'
    && (data.message === undefined || typeof data.message === 'string')
    && (data.retryable === undefined || typeof data.retryable === 'boolean');
}

/** Restore only the public RPC projection, without importing an SDK class or author details. */
export function restorePluginErrorFromWire(data: PluginErrorIdentityData): PluginErrorContract & Readonly<{
  failureCause?: ActionFailureCauseV1;
}> {
  const failureCause = 'failureCause' in data && data.failureCause !== undefined ? readActionFailureCauseV1(data.failureCause) : undefined;
  const projected: PluginErrorContractData = {
    name: 'PluginError', code: data.code,
    ...(data.message === undefined ? {} : { message: data.message }),
    ...(data.retryable === undefined ? {} : { retryable: data.retryable }),
    ...(failureCause === undefined ? {} : { failureCause }),
  };
  return Object.assign(new Error(data.message ?? data.code), {
    name: 'PluginError', code: data.code, retryable: data.retryable ?? false, data: projected,
    ...(failureCause === undefined ? {} : { failureCause }),
  });
}

/**
 * The one recognizer for the canonical public PluginError contract. It lives
 * in Protocol because both the plugin SDK (which publishes it to authors) and
 * the Action invocation owner (which classifies a handler rejection) need the
 * same proof; a second, weaker "name looks right" check is a split brain that
 * lets an ordinary Error borrow an author-chosen failure code.
 *
 * The Error intrinsic distinguishes a thrown error from a spread data copy;
 * `data` is the stable public representation rather than a class identity, so
 * separately bundled SDK copies in one realm still recognize each other.
 */
export function isPluginError(value: unknown): value is PluginErrorContract {
  if (!(value instanceof Error)) return false;
  const candidate = value as PluginErrorCandidate;
  if (candidate.name !== 'PluginError') return false;
  if (typeof candidate.code !== 'string' || typeof candidate.retryable !== 'boolean') return false;
  if (!isPluginErrorData(candidate.data)) return false;
  const data = candidate.data;
  if (data.code !== candidate.code) return false;
  return candidate.message === (data.message ?? candidate.code)
    && candidate.retryable === (data.retryable ?? false);
}
