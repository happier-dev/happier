import { IrohEndpointDescriptorV1Schema } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import { DEFAULT_HAPPIER_CLOUD_SERVER_URL } from '../../happierCloud.js';
import type { PersonalHomeRuntimeLayout } from './layout.js';

/** Default managed-runtime port for a Personal Home. */
export const DEFAULT_PERSONAL_HOME_PORT = 3005;
/** Initial display name for the one canonical Team created during Personal Home bootstrap. */
export const DEFAULT_PERSONAL_HOME_TEAM_NAME = 'Personal Home';

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
  HAPPIER_CANONICAL_SERVER_URL: string;
  HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only';
  HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain';
  HAPPIER_FEATURE_TEAMS__ENABLED: '1';
  AUTH_ANONYMOUS_SIGNUP_ENABLED: '1' | '0';
  HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'external';
  HAPPIER_AUTH_SIGN_IN_SERVICE_URL: typeof DEFAULT_HAPPIER_CLOUD_SERVER_URL;
  HAPPIER_IROH_RELAY_POLICY?: 'automatic' | 'disabled';
  HAPPIER_IROH_RELAY_URLS?: string;
}>;

const FIXED_ENVIRONMENT_KEYS = new Set([
  'HAPPIER_SERVER_HOST',
  'PORT',
  'HAPPIER_CANONICAL_SERVER_URL',
  'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY',
  'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE',
  'HAPPIER_FEATURE_TEAMS__ENABLED',
  'AUTH_ANONYMOUS_SIGNUP_ENABLED',
  'HAPPIER_AUTH_SIGN_IN_SERVICE_MODE',
  'HAPPIER_AUTH_SIGN_IN_SERVICE_URL',
  'HAPPIER_IROH_RELAY_POLICY',
  'HAPPIER_IROH_RELAY_URLS',
]);

export function normalizePersonalHomeIrohRelayEnvironment(
  source: Readonly<Record<string, unknown>>,
): Readonly<{
  HAPPIER_IROH_RELAY_POLICY?: 'automatic' | 'disabled';
  HAPPIER_IROH_RELAY_URLS?: string;
}> {
  const rawPolicy = String(source.HAPPIER_IROH_RELAY_POLICY ?? '').trim().toLowerCase();
  const rawRelayUrls = String(source.HAPPIER_IROH_RELAY_URLS ?? '').trim();
  if (!rawPolicy && !rawRelayUrls) return {};
  if (rawPolicy && rawPolicy !== 'automatic' && rawPolicy !== 'disabled') {
    throw new Error('HAPPIER_IROH_RELAY_POLICY must be automatic or disabled');
  }
  const policy = rawPolicy === 'disabled' ? 'disabled' : 'automatic';
  if (policy === 'disabled' && rawRelayUrls) {
    throw new Error('HAPPIER_IROH_RELAY_POLICY=disabled cannot be combined with HAPPIER_IROH_RELAY_URLS');
  }
  if (!rawRelayUrls) return { HAPPIER_IROH_RELAY_POLICY: policy };
  const candidates = rawRelayUrls.split(',').map((entry) => entry.trim());
  if (candidates.some((entry) => !entry)) {
    throw new Error('HAPPIER_IROH_RELAY_URLS must not contain empty entries');
  }
  const parsed = IrohEndpointDescriptorV1Schema.shape.relayUrls.safeParse(candidates);
  if (!parsed.success || parsed.data === undefined) {
    throw new Error('HAPPIER_IROH_RELAY_URLS must contain unique absolute HTTP(S) relay URLs');
  }
  return {
    HAPPIER_IROH_RELAY_POLICY: policy,
    HAPPIER_IROH_RELAY_URLS: [...parsed.data].sort().join(','),
  };
}

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
  if (parsed.protocol !== 'http:') {
    throw new Error('Personal Home canonicalServerUrl must use the loopback http origin');
  }
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error('Personal Home canonicalServerUrl must use 127.0.0.1');
  }
  if (!parsed.port) {
    throw new Error('Personal Home canonicalServerUrl must include an explicit port');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Personal Home canonicalServerUrl must be an origin without credentials, path, query, or hash');
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
  normalizePersonalHomeIrohRelayEnvironment(value as Record<string, unknown>);
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
  const baseEnv = params.baseEnv ?? {};
  const relaySource = {
    HAPPIER_IROH_RELAY_POLICY:
      overrides.HAPPIER_IROH_RELAY_POLICY ?? baseEnv.HAPPIER_IROH_RELAY_POLICY,
    HAPPIER_IROH_RELAY_URLS:
      Object.prototype.hasOwnProperty.call(overrides, 'HAPPIER_IROH_RELAY_POLICY')
      && !Object.prototype.hasOwnProperty.call(overrides, 'HAPPIER_IROH_RELAY_URLS')
        ? undefined
        : overrides.HAPPIER_IROH_RELAY_URLS ?? baseEnv.HAPPIER_IROH_RELAY_URLS,
  };
  const relayEnvironment = normalizePersonalHomeIrohRelayEnvironment(relaySource);
  const rendered: {
    HAPPIER_SERVER_HOST: '127.0.0.1';
    PORT: string;
    HAPPIER_CANONICAL_SERVER_URL: string;
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only';
    HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain';
    HAPPIER_FEATURE_TEAMS__ENABLED: '1';
    AUTH_ANONYMOUS_SIGNUP_ENABLED: '1' | '0';
    HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'external';
    HAPPIER_AUTH_SIGN_IN_SERVICE_URL: typeof DEFAULT_HAPPIER_CLOUD_SERVER_URL;
    HAPPIER_IROH_RELAY_POLICY?: 'automatic' | 'disabled';
    HAPPIER_IROH_RELAY_URLS?: string;
  } = {
    HAPPIER_SERVER_HOST: '127.0.0.1',
    PORT: port,
    HAPPIER_CANONICAL_SERVER_URL: params.spec.canonicalServerUrl,
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
    AUTH_ANONYMOUS_SIGNUP_ENABLED: signup,
    HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'external',
    HAPPIER_AUTH_SIGN_IN_SERVICE_URL: DEFAULT_HAPPIER_CLOUD_SERVER_URL,
    ...relayEnvironment,
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
      if (key === 'HAPPIER_CANONICAL_SERVER_URL') {
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
      if (key === 'HAPPIER_FEATURE_TEAMS__ENABLED' && value !== '1') {
        throw new Error('Personal Home Teams availability must remain enabled');
      }
      if (key === 'AUTH_ANONYMOUS_SIGNUP_ENABLED' && value !== '0' && value !== '1') {
        throw new Error('Personal Home anonymous signup value must be 0 or 1');
      }
      if (key === 'HAPPIER_AUTH_SIGN_IN_SERVICE_MODE' && value !== 'external') {
        throw new Error('Personal Home sign-in service mode is fixed to external');
      }
      if (key === 'HAPPIER_AUTH_SIGN_IN_SERVICE_URL' && value !== DEFAULT_HAPPIER_CLOUD_SERVER_URL) {
        throw new Error('Personal Home sign-in service URL is fixed to the Happier Cloud endpoint');
      }
      if (key === 'AUTH_ANONYMOUS_SIGNUP_ENABLED') {
        rendered.AUTH_ANONYMOUS_SIGNUP_ENABLED = value === '0' ? '0' : '1';
      }
    }
  }
  // Only the two validated relay keys are projected from baseEnv. The installer
  // remains responsible for preserving every other operator-owned assignment.
  return Object.freeze(rendered) satisfies PersonalHomeRuntimeEnvironment;
}

export type PersonalHomeRuntimeLayoutFacts = Readonly<{
  layout: PersonalHomeRuntimeLayout;
  canonicalServerUrl: string;
  localServerUrl: string;
}>;
