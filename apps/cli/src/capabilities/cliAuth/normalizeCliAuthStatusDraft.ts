import type { CliAuthMethod, CliAuthReason, CliAuthSource, CliAuthStatusDraft } from './types';

const METHODS = new Set<CliAuthMethod>([
  'api_key_env',
  'auth_token_env',
  'credentials_file',
  'oauth_cli',
  'config_file',
  'gcloud_adc',
  'unknown',
]);
const REASONS = new Set<CliAuthReason>([
  'missing_credentials',
  'expired',
  'cli_missing',
  'probe_failed',
  'timeout',
  'unsupported',
  'interactive_blocked',
  'not_configured',
]);
const SOURCES = new Set<CliAuthSource>(['env', 'file', 'command', 'mixed']);

function isOptionalNullableMember<T extends string>(
  value: unknown,
  admitted: ReadonlySet<T>,
): value is T | null | undefined {
  return value === undefined || value === null || (typeof value === 'string' && admitted.has(value as T));
}

/** Normalizes the trusted callback boundary without projecting malformed status. */
export function normalizeCliAuthStatusDraft(value: unknown): CliAuthStatusDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.state !== 'logged_in' && record.state !== 'logged_out' && record.state !== 'unknown') return null;
  if (!isOptionalNullableMember(record.method, METHODS)) return null;
  if (record.accountLabel !== undefined && record.accountLabel !== null && typeof record.accountLabel !== 'string') return null;
  if (!isOptionalNullableMember(record.reason, REASONS)) return null;
  if (!isOptionalNullableMember(record.source, SOURCES)) return null;

  return {
    state: record.state,
    ...(record.method !== undefined ? { method: record.method } : {}),
    ...(record.accountLabel !== undefined ? { accountLabel: record.accountLabel } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.source !== undefined ? { source: record.source } : {}),
  };
}
