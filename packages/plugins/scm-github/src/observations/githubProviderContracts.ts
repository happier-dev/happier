import { QualifiedConnectedAccountRefJsonSchema, type ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../connectedAccounts/service.js';

export { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../connectedAccounts/service.js';
export const GITHUB_PLUGIN_ID = GITHUB_CONNECTED_ACCOUNT_SERVICE.pluginId;
export const GITHUB_CONNECTED_ACCOUNT_ID = GITHUB_CONNECTED_ACCOUNT_SERVICE.localId;
/** Declared host-access purpose for materializing the selected GitHub account. */
export const GITHUB_CONNECTED_ACCOUNT_PURPOSE = 'github-connected-account';
export const GITHUB_WEBHOOK_CONTRIBUTION_ID = 'github-events';
export const GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID = 'automation/setup-repository-event-v1';
export const GITHUB_DEPLOYMENT_REVIEW_SETUP_ACTION_ID = 'automation/setup-deployment-review-event-v1';
/** Host target-Action boundary for one repository-scoped checkpointed-pull attempt. */
export const GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID = 'automation/run-repository-event-source-attempt-v1';
/** Explicit user/host Action for replacing a pull history-gap marker with a current-head baseline. */
export const GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID = 'automation/reset-repository-event-baseline-v1';
/** The single long-lived checkpointed-pull observer for GitHub Automation Events. */
export const GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID = 'automation-repository-event-checkpointed-pull';
export const GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION = 1;
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_API_VERSION = '2026-03-10';
export const GITHUB_REPOSITORY_SOURCE_CONFIG_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    repositoryId: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
    owner: { type: 'string', minLength: 1, maxLength: 256 },
    name: { type: 'string', minLength: 1, maxLength: 256 },
    nameWithOwner: { type: 'string', minLength: 3, maxLength: 512 },
  }, required: ['v', 'repositoryId', 'owner', 'name', 'nameWithOwner'],
} satisfies PluginJsonSchema;
/** Source setup, observation and receipt publication retain one exact provider contract. */
export const GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { v: { type: 'integer', const: 1 }, credentialRef: QualifiedConnectedAccountRefJsonSchema,
    repository: GITHUB_REPOSITORY_SOURCE_CONFIG_SCHEMA }, required: ['v', 'credentialRef', 'repository'],
} satisfies PluginJsonSchema;
/** Known media locations for cooperative network disclosure, not a redirect allowlist. */
export const GITHUB_PRIVATE_MEDIA_HOST_SUFFIXES_V1 = Object.freeze([
  'actions.githubusercontent.com', 'blob.core.windows.net', 'release-assets.githubusercontent.com',
]);
export type GithubRepositorySourceConfigV1 = Readonly<{
  v: 1;
  repositoryId: string;
  owner: string;
  name: string;
  nameWithOwner: string;
}>;

/** Provider-private source facts retained by an Automation Event definition. */
export type GithubAutomationRepositoryEventSourceConfigV1 = Readonly<{
  v: 1;
  credentialRef: ConnectedAccountRef | null;
  repository: GithubRepositorySourceConfigV1;
  checks?: Readonly<{ pullRequestNumber: number; headSha: string; selection: 'all' | 'required' }>;
  deploymentReview?: Readonly<{
    monitoringMachineId: string;
    /** Omission preserves existing enrollments and selects Automatic. */
    deliveryMode?: 'automatic' | 'webhook' | 'polling';
    pollingIntervalMs?: number;
  }>;
}>;

/** Exact placement retained by the Automation definition, never a plugin setting. */
export const GithubDeploymentMonitoringSelectionV1Schema = defineProtocolObject({
  monitoringMachineId: defineProtocolString({ minLength: 1, pattern: '^\\S(?:.*\\S)?$' }),
  deliveryMode: defineProtocolUnion([defineProtocolLiteral('automatic'), defineProtocolLiteral('webhook'), defineProtocolLiteral('polling')]).optional(),
  pollingIntervalMs: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }).optional(),
}, { policy: 'closed' });
export function parseGithubDeploymentMonitoringSelection(value: unknown): NonNullable<GithubAutomationRepositoryEventSourceConfigV1['deploymentReview']> {
  const parsed = GithubDeploymentMonitoringSelectionV1Schema.safeParse(value);
  if (!parsed.success) throw new RangeError('GitHub deployment monitoring requires one exact Machine');
  return parsed.data;
}

/** One parser for the deployment source used by observation and app-page admission. */
export function parseGithubDeploymentMonitoringSourceConfig(value: unknown): GithubAutomationRepositoryEventSourceConfigV1 & Readonly<{ deploymentReview: NonNullable<GithubAutomationRepositoryEventSourceConfigV1['deploymentReview']> }> {
  if (!isRecord(value) || Object.keys(value).length !== 4 || value.v !== 1 || (value.credentialRef !== null && !isGithubConnectedAccountRef(value.credentialRef))) {
    throw new RangeError('GitHub deployment source configuration is incompatible');
  }
  return { v: 1, credentialRef: value.credentialRef, repository: parseGithubRepositorySourceConfig(value.repository),
    deploymentReview: parseGithubDeploymentMonitoringSelection(value.deploymentReview) };
}

export type GithubChannelProviderConfigV1 = Readonly<{
  v: 1;
  repository: GithubRepositorySourceConfigV1;
  integrationPrincipal: Readonly<{
    id: string;
    label: string;
  }>;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RangeError(`GitHub ${label} must be a nonempty string`);
  }
  return value.trim();
}

/** Native numeric identifiers share this grammar across tolerant and strict readers. */
export function tryReadGithubPositiveDecimal(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return /^[1-9][0-9]*$/u.test(candidate) ? candidate : null;
}

export function readGithubPositiveDecimal(value: unknown, label: string): string {
  const parsed = tryReadGithubPositiveDecimal(value);
  if (parsed !== null) return parsed;
  if (typeof value === 'number') {
    throw new RangeError(`GitHub ${label} must be a positive safe integer`);
  }
  readNonEmptyString(value, label);
  throw new RangeError(`GitHub ${label} must be a canonical positive decimal string`);
}

export function parseGithubRepositorySpecifier(value: unknown): Readonly<{
  owner: string;
  name: string;
}> {
  const source = readNonEmptyString(value, 'repository').replace(/^https:\/\/github\.com\//iu, '');
  const segments = source.replace(/\.git$/iu, '').split('/');
  if (segments.length !== 2 || segments.some((segment) => !segment.trim() || /[?#\s]/u.test(segment))) {
    throw new RangeError('GitHub repository must use the canonical owner/repository form');
  }
  return Object.freeze({ owner: segments[0]!.trim(), name: segments[1]!.trim() });
}

export function createGithubRepositorySourceConfig(value: unknown): GithubRepositorySourceConfigV1 {
  if (!isRecord(value)) throw new RangeError('GitHub repository response must be an object');
  const ownerRecord = isRecord(value.owner) ? value.owner : null;
  const owner = ownerRecord === null ? '' : readNonEmptyString(ownerRecord.login, 'repository owner login');
  const name = readNonEmptyString(value.name, 'repository name');
  const nameWithOwner = readNonEmptyString(value.full_name, 'repository full name');
  if (nameWithOwner.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    throw new RangeError('GitHub repository response has an inconsistent immutable identity');
  }
  return Object.freeze({
    v: 1,
    repositoryId: readGithubPositiveDecimal(value.id, 'repository ID'),
    owner,
    name,
    nameWithOwner,
  });
}

export function parseGithubRepositorySourceConfig(value: unknown): GithubRepositorySourceConfigV1 {
  if (!isRecord(value)) throw new RangeError('GitHub repository configuration must be an object');
  if (value.v !== 1) throw new RangeError('GitHub repository configuration must use V1');
  const repositoryId = readGithubPositiveDecimal(value.repositoryId, 'repository ID');
  const owner = readNonEmptyString(value.owner, 'repository owner');
  const name = readNonEmptyString(value.name, 'repository name');
  const nameWithOwner = readNonEmptyString(value.nameWithOwner, 'repository full name');
  if (nameWithOwner.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    throw new RangeError('GitHub repository configuration has an inconsistent identity');
  }
  return Object.freeze({ v: 1, repositoryId, owner, name, nameWithOwner });
}

export function parseGithubChannelProviderConfig(value: unknown): GithubChannelProviderConfigV1 {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.integrationPrincipal)) {
    throw new RangeError('GitHub Channel configuration must use V1');
  }
  return Object.freeze({
    v: 1,
    repository: parseGithubRepositorySourceConfig(value.repository),
    integrationPrincipal: Object.freeze({
      id: readGithubPositiveDecimal(value.integrationPrincipal.id, 'integration principal ID'),
      label: readNonEmptyString(value.integrationPrincipal.label, 'integration principal label'),
    }),
  });
}

export function isGithubConnectedAccountRef(
  value: unknown,
  pluginId = GITHUB_PLUGIN_ID,
): value is ConnectedAccountRef {
  if (!isRecord(value) || !isRecord(value.service)) return false;
  return value.service.pluginId === pluginId
    && value.service.localId === GITHUB_CONNECTED_ACCOUNT_ID
    && typeof value.accountId === 'string'
    && value.accountId.trim().length > 0;
}
