import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

export const GITHUB_PLUGIN_ID = 'happier.scm.forge.github';
export const GITHUB_CONNECTED_ACCOUNT_ID = 'github-account';
/** Declared host-access purpose for materializing the selected GitHub account. */
export const GITHUB_CONNECTED_ACCOUNT_PURPOSE = 'github-connected-account';
export const GITHUB_WEBHOOK_CONTRIBUTION_ID = 'github-events';
export const GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID = 'automation/setup-repository-event-v1';
/** Host target-Action boundary for one repository-scoped checkpointed-pull attempt. */
export const GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID = 'automation/run-repository-event-source-attempt-v1';
/** Explicit user/host Action for replacing a pull history-gap marker with a current-head baseline. */
export const GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID = 'automation/reset-repository-event-baseline-v1';
/** The single long-lived checkpointed-pull observer for GitHub Automation Events. */
export const GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID = 'automation-repository-event-checkpointed-pull';
export const GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION = 1;
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_API_VERSION = '2026-03-10';
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
  credentialRef: ConnectedAccountRef;
  repository: GithubRepositorySourceConfigV1;
}>;

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

export function readGithubPositiveDecimal(value: unknown, label: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`GitHub ${label} must be a positive safe integer`);
    }
    return String(value);
  }
  const candidate = readNonEmptyString(value, label);
  if (!/^[1-9][0-9]*$/u.test(candidate)) {
    throw new RangeError(`GitHub ${label} must be a canonical positive decimal string`);
  }
  return candidate;
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
