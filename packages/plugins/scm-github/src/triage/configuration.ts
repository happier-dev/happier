import { GITHUB_TRIAGE_SORT_FIELDS_V1 } from './scan/query.js';
import {
  MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
  TriageSourceScopeSelectionV1Schema,
  TriageSourceScopeUnitV1Schema,
  type TriageSourceScopeSelectionV1,
  type TriageListSortV1,
  type TriageSourceScopeUnitV1,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import { createProtocolStoredReadSchema, defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import { buildGithubRepositoryKey, parseGithubRoutingToken } from './locator.js';
import type { GithubTriageFailureV1 } from './types.js';

/**
 * The GitHub source-private configured-instance token.
 *
 * The target bounds, copies and returns these bytes without parsing them, so this
 * module is the ONLY decoder: a malformed, foreign or truncated token is an
 * `unsupportedContract` failure rather than a guessed scope. It carries no
 * credential, no origin, no account ref and no filesystem path — the Connected
 * Account binding is a separate member of the configured instance, and re-encoding
 * it here would create a second account-identity carrier.
 */

/**
 * GitHub's only admitted deployment today is `github.com`, so a configured GitHub
 * instance includes all reachable repositories or a selected set. The retired
 * single-scope type remains an encoder ingress for historical callers: writes
 * normalize to the shared selection shape. Retained repository paths stay
 * locator-shaped inputs, never immutable entry identity.
 */
export type GithubTriageInstanceScopeV1 =
  | Readonly<{ kind: 'account' }>
  | Readonly<{ kind: 'repository'; repositoryKey: string }>;

export type GithubTriageConfigurationV1 = Readonly<{
  v: 1;
  selection: TriageSourceScopeSelectionV1;
  units?: readonly TriageSourceScopeUnitV1[];
  alerts?: GithubTriageAlertFamiliesV1;
}>;

export type GithubTriageAlertFamiliesV1 = Readonly<{ dependabot: boolean; codeScanning: boolean }>;
const NO_ALERTS: GithubTriageAlertFamiliesV1 = Object.freeze({ dependabot: false, codeScanning: false });

export function readGithubTriageAlertFamilies(configuration: GithubTriageConfigurationV1): GithubTriageAlertFamiliesV1 {
  return configuration.alerts ?? NO_ALERTS;
}

/** All-repository alert heads cannot be ordered by the repository directory. */
export function readGithubTriageSortFields(configuration: GithubTriageConfigurationV1): readonly TriageListSortV1['field'][] {
  const alerts = readGithubTriageAlertFamilies(configuration);
  return configuration.selection.kind === 'all' && (alerts.dependabot || alerts.codeScanning)
    ? [] : GITHUB_TRIAGE_SORT_FIELDS_V1;
}

/** Extra fields stay inside the shared Settings draft and its one Save/Cancel. */
export function writeGithubTriageAlertFamiliesDraft(
  draft: TriageSourceInstanceDraftV1,
  alerts: GithubTriageAlertFamiliesV1,
): TriageSourceInstanceDraftV1 | null {
  const decoded = decodeGithubTriageConfiguration(draft.configuration.token);
  if (!decoded.ok) return null;
  const token = encodeGithubTriageConfiguration({ ...decoded.configuration, alerts });
  return token === null ? null : { ...draft, configuration: { v: 1, token } };
}

const booleanValue = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const configurationSchema = createProtocolStoredReadSchema(defineProtocolObject({
  v: defineProtocolLiteral(1),
  selection: TriageSourceScopeSelectionV1Schema,
  units: defineProtocolArray(TriageSourceScopeUnitV1Schema).optional(),
  alerts: defineProtocolObject({ dependabot: booleanValue, codeScanning: booleanValue }, { policy: 'closed' }).optional(),
}, { policy: 'closed' }));

export type GithubTriageConfigurationDecodeV1 =
  | Readonly<{ ok: true; configuration: GithubTriageConfigurationV1 }>
  | Readonly<{ ok: false; failure: GithubTriageFailureV1 }>;

/**
 * The source-native instance/scope key. GitHub's deployment host is the whole
 * source-native scope of a candidate: the repository selection is a later explicit
 * Settings reconfiguration, not a discovery fact. It never re-encodes the purpose or
 * the account ref, so two accounts observing github.com stay two configured
 * instances that share one canonical entry identity.
 */
export const GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1 = 'github.com';

/** The deployment-derived key contract shared by discovery and retained Settings edits. */
export const GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1 = 'locatorDerived' as const;

/**
 * The forge DEPLOYMENT an entry from this source belongs to.
 *
 * Derived from the admitted deployment above rather than written twice: if
 * GitHub Enterprise is ever admitted, this constant is one of the two places
 * that must move together, and a per-instance deployment becomes a configured
 * fact instead of a constant. It is the same string a project's resolved
 * `ScmHostingProviderRef.baseUrl` canonicalizes to, which is what makes the two
 * halves of launch placement comparable by equality.
 */
export const GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 = `https://${GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1}`;

const CONFIGURATION_DECODE_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_configuration_invalid',
});

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The account-wide GitHub scope every discovery candidate proposes. */
export const GITHUB_TRIAGE_ACCOUNT_SCOPE_V1: GithubTriageConfigurationV1 = Object.freeze({
  v: 1,
  selection: Object.freeze({ kind: 'all' }),
});

export function encodeGithubTriageConfiguration(
  configuration: GithubTriageConfigurationV1 | Readonly<{ v: 1; scope: GithubTriageInstanceScopeV1 }>,
): string | null {
  const normalized = readConfiguration(configuration);
  if (normalized === null) return null;
  const token = JSON.stringify(normalized);
  return utf8ByteLength(token) <= MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 ? token : null;
}

function normalizeUnitId(id: string): string | null {
  const trimmed = id.trim();
  const route = parseGithubRoutingToken(trimmed);
  return route === null ? null : buildGithubRepositoryKey(route);
}

function readConfiguration(value: unknown): GithubTriageConfigurationV1 | null {
  if (!isRecord(value) || value.v !== 1) return null;
  let current = value;
  // Only the old token reader translates the retired single-repository shape.
  // A malformed known selection never falls back to account-wide inclusion.
  if (!Object.hasOwn(value, 'selection')) {
    if (!isRecord(value.scope)) return null;
    if (value.scope.kind === 'account') return GITHUB_TRIAGE_ACCOUNT_SCOPE_V1;
    if (value.scope.kind !== 'repository' || typeof value.scope.repositoryKey !== 'string') return null;
    current = { v: 1, selection: { kind: 'selected', unitIds: [value.scope.repositoryKey] } };
  }
  const parsed = configurationSchema.safeParse(current);
  if (!parsed.success) return null;
  const alerts = parsed.data.alerts;
  if (parsed.data.selection.kind === 'all') return alerts === undefined ? GITHUB_TRIAGE_ACCOUNT_SCOPE_V1
    : { ...GITHUB_TRIAGE_ACCOUNT_SCOPE_V1, alerts };
  const ids = parsed.data.selection.unitIds.map(normalizeUnitId);
  if (ids.some((id) => id === null)) return null;
  const selection = TriageSourceScopeSelectionV1Schema.safeParse({ kind: 'selected', unitIds: ids });
  if (!selection.success) return null;
  const units: TriageSourceScopeUnitV1[] = [];
  for (const unit of parsed.data.units ?? []) {
    const id = normalizeUnitId(unit.id);
    if (id === null) return null;
    if (!ids.includes(id)) continue;
    units.push({ ...unit, id });
  }
  return { v: 1, selection: selection.data, ...(parsed.data.units === undefined ? {} : { units }),
    ...(alerts === undefined ? {} : { alerts }) };
}

export function decodeGithubTriageConfiguration(token: unknown): GithubTriageConfigurationDecodeV1 {
  const failure = Object.freeze({ ok: false as const, failure: CONFIGURATION_DECODE_FAILURE });
  if (typeof token !== 'string' || utf8ByteLength(token) > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    return failure;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return failure;
  }
  const configuration = readConfiguration(parsed);
  return configuration === null ? failure : { ok: true, configuration };
}

