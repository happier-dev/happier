import type { PersonalHomeRuntimeLayout } from './layout.js';

/** The managed runtime purpose carried through the existing relay-host seam. */
export type ManagedRelayPurpose =
  | Readonly<{ kind: 'generic' }>
  | Readonly<{ kind: 'personal-home'; canonicalServerUrl: string }>;

export type PersonalHomeRuntimeSpec = Readonly<{
  purpose: 'personal-home';
  bindAddress: '127.0.0.1';
  canonicalServerUrl: string;
  encryptionStoragePolicy: 'plaintext_only';
  defaultAccountMode: 'plain';
  anonymousSignupPhase: 'loopback-bootstrap-then-disabled';
}>;

export type PersonalHomeRuntimeEnvironment = Readonly<{
  HAPPIER_SERVER_HOST: '127.0.0.1';
  PORT: string;
  HAPPIER_PUBLIC_SERVER_URL: string;
  HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only';
  HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain';
  AUTH_ANONYMOUS_SIGNUP_ENABLED: '1' | '0';
}>;

const FIXED_ENVIRONMENT_KEYS = new Set([
  'HAPPIER_SERVER_HOST',
  'PORT',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY',
  'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE',
  'AUTH_ANONYMOUS_SIGNUP_ENABLED',
]);

function requireCanonicalServerUrl(value: unknown): string {
  const canonicalServerUrl = typeof value === 'string' ? value.trim().replace(/\/+$/u, '') : '';
  if (!canonicalServerUrl) {
    throw new Error('Personal Home canonicalServerUrl must be a non-empty URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(canonicalServerUrl);
  } catch {
    throw new Error('Personal Home canonicalServerUrl must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Personal Home canonicalServerUrl must use http or https');
  }
  return canonicalServerUrl;
}

function requirePort(value: unknown): string {
  const raw = String(value ?? '').trim();
  const port = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Personal Home PORT must be an integer between 1 and 65535: ${raw}`);
  }
  return String(port);
}

export function createPersonalHomeRuntimeSpec(params: Readonly<{ canonicalServerUrl: string }>): PersonalHomeRuntimeSpec {
  return Object.freeze({
    purpose: 'personal-home' as const,
    bindAddress: '127.0.0.1' as const,
    canonicalServerUrl: requireCanonicalServerUrl(params.canonicalServerUrl),
    encryptionStoragePolicy: 'plaintext_only' as const,
    defaultAccountMode: 'plain' as const,
    anonymousSignupPhase: 'loopback-bootstrap-then-disabled' as const,
  });
}

/** Alias used by callers that resolve a purpose from runtime facts. */
export const resolvePersonalHomeRuntimeSpec = createPersonalHomeRuntimeSpec;

export function parsePersonalHomeRuntimePurpose(value: unknown): PersonalHomeRuntimeSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Personal Home runtime purpose');
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== 'personal-home') {
    throw new Error('Invalid Personal Home runtime purpose');
  }
  for (const key of Object.keys(record)) {
    if (key === 'kind' || key === 'canonicalServerUrl' || key === 'env') continue;
    throw new Error(`Unknown Personal Home purpose field: ${key}`);
  }
  if (record.env !== undefined) {
    assertPersonalHomeEnvironmentKeys(record.env);
  }
  return createPersonalHomeRuntimeSpec({ canonicalServerUrl: String(record.canonicalServerUrl ?? '') });
}

export function assertPersonalHomeEnvironmentKeys(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Personal Home environment must be an object');
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!FIXED_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`unsupported Personal Home environment key: ${key}`);
    }
  }
}

export function renderPersonalHomeRuntimeEnv(params: Readonly<{
  spec: PersonalHomeRuntimeSpec;
  port: number | string;
  anonymousSignupEnabled?: boolean;
  /** Only fixed purpose keys may be overridden; arbitrary env editing is forbidden. */
  overrides?: Readonly<Record<string, string>>;
  /** Existing generic installer values are kept by the adapter, not interpreted here. */
  baseEnv?: Readonly<Record<string, string>>;
}>): PersonalHomeRuntimeEnvironment {
  assertPersonalHomeEnvironmentKeys(params.overrides ?? {});
  const port = requirePort(params.port);
  const signup = params.anonymousSignupEnabled === false ? '0' : '1';
  const overrides = params.overrides ?? {};
  const rendered: {
    HAPPIER_SERVER_HOST: '127.0.0.1';
    PORT: string;
    HAPPIER_PUBLIC_SERVER_URL: string;
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only';
    HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain';
    AUTH_ANONYMOUS_SIGNUP_ENABLED: '1' | '0';
  } = {
    HAPPIER_SERVER_HOST: '127.0.0.1',
    PORT: port,
    HAPPIER_PUBLIC_SERVER_URL: params.spec.canonicalServerUrl,
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
    AUTH_ANONYMOUS_SIGNUP_ENABLED: signup,
  };
  for (const key of FIXED_ENVIRONMENT_KEYS) {
    if (key in overrides) {
      const value = String(overrides[key] ?? '');
      if (key === 'HAPPIER_SERVER_HOST' && value !== '127.0.0.1') {
        throw new Error('Personal Home bind address must remain loopback');
      }
      if (key === 'PORT') {
        if (requirePort(value) !== port) throw new Error('Personal Home PORT cannot change its stable origin');
      }
      if (key === 'HAPPIER_PUBLIC_SERVER_URL') {
        if (requireCanonicalServerUrl(value) !== params.spec.canonicalServerUrl) {
          throw new Error('Personal Home canonicalServerUrl cannot be overridden');
        }
      }
      if (key === 'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY' && value !== 'plaintext_only') {
        throw new Error('Personal Home storage policy is fixed to plaintext_only');
      }
      if (key === 'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE' && value !== 'plain') {
        throw new Error('Personal Home account mode is fixed to plain');
      }
      if (key === 'AUTH_ANONYMOUS_SIGNUP_ENABLED' && value !== '0' && value !== '1') {
        throw new Error('Personal Home anonymous signup value must be 0 or 1');
      }
      if (key === 'AUTH_ANONYMOUS_SIGNUP_ENABLED') {
        rendered.AUTH_ANONYMOUS_SIGNUP_ENABLED = value === '0' ? '0' : '1';
      }
    }
  }
  // baseEnv is deliberately not merged into the returned fixed map. The installer combines
  // this map with its canonical generic defaults and then writes the service environment.
  void params.baseEnv;
  return Object.freeze(rendered) satisfies PersonalHomeRuntimeEnvironment;
}

export type PersonalHomeRuntimeLayoutFacts = Readonly<{
  layout: PersonalHomeRuntimeLayout;
  canonicalServerUrl: string;
  localServerUrl: string;
}>;
