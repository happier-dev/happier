import type {
  HostingProviderPullRequestCreateInput as ScmHostingProviderPullRequestCreateInput,
  HostingProviderPullRequestGetInput as ScmHostingProviderPullRequestGetInput,
  HostingProviderPullRequestListInput as ScmHostingProviderPullRequestListInput,
  HostingProviderRepositoryCreateInput as ScmHostingProviderRepositoryCreateInput,
  HostingProviderRepositoryDescribePublishTargetsInput as ScmHostingProviderRepositoryDescribePublishTargetsInput,
  HostingProviderRepositoryDescribePublishTargetsResult as ScmHostingProviderRepositoryDescribePublishTargetsResult,
  HostingProviderRepositoryGetInput as ScmHostingProviderRepositoryGetInput,
  HostingProviderRuntimeAdapter as ScmHostingProviderRuntimeAdapter,
  HostingProviderRuntimeCommandResult as ScmHostingProviderRuntimeCommandResult,
  HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingRepositoryAuthSummary,
  ScmHostingRepositoryPublishTarget,
  ScmHostingRepositorySummary,
  ScmHostingRepositoryVisibility,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';

import { azureDevopsHostingProviderAdapter } from '../detection/adapter.js';
import {
  detectAzureDevopsCliAuth,
  type AzureDevopsCliAuthDetectionResult,
} from '../auth/azureDevopsAuth.js';
import {
  parseAzurePullRequestNumberFromUrl,
  readAzureDevopsOrganizationCoordinates,
  readAzureDevopsRepositoryPublicationCoordinates,
  readAzureDevopsRepositoryCoordinates,
} from '../parsing/azureDevopsCoordinates.js';
import {
  createAzureAuthRequiredError,
  createAzureCommandFailedError,
  createAzureDuplicatePullRequestError,
  createAzureInvalidRequestError,
  createAzureNotFoundError,
} from './errors.js';
import { decodeAzureProjectRow, readAzureCollectionRows, readRecord } from '../triage/decode.js';

const AZURE_CLI_EXECUTABLE = Object.freeze({ kind: 'systemTool' as const, id: 'azure-cli' });
import {
  mapAzurePullRequest,
  mapAzureRepositorySummary,
} from './mapping.js';

export type AzureDevopsOperationsAdapter = typeof azureDevopsHostingProviderAdapter & ScmHostingProviderRuntimeAdapter & Readonly<{
  getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>): string | null;
  listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]>;
  getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null>;
  createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary>;
  openOrReusePullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<Readonly<{
    pullRequest: ScmPullRequestSummary;
    reused: boolean;
  }>>;
  describePublishTargets(
    input: ScmHostingProviderRepositoryDescribePublishTargetsInput
  ): Promise<ScmHostingProviderRepositoryDescribePublishTargetsResult>;
  createRepository(input: ScmHostingProviderRepositoryCreateInput): Promise<ScmHostingRepositorySummary>;
  getRepository(input: ScmHostingProviderRepositoryGetInput): Promise<ScmHostingRepositorySummary | null>;
}>;

const DEFAULT_AZURE_DEVOPS_TIMEOUT_MS = 30_000;
const AZURE_DEVOPS_NONINTERACTIVE_ENV = Object.freeze({
  AZURE_CORE_NO_COLOR: '1',
  AZURE_CORE_ONLY_SHOW_ERRORS: '1',
  GIT_TERMINAL_PROMPT: '0',
});

function readJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw createAzureCommandFailedError('Azure CLI returned invalid JSON');
  }
}

function mapListStatus(state: ScmPullRequestState | undefined): string {
  if (state === 'closed') return 'abandoned';
  if (state === 'merged') return 'completed';
  return 'active';
}

function parseDuplicateHint(stderr: string): Readonly<{
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}> | null {
  const url = stderr
    .split(/\s+/)
    .map((part) => part.trim().replace(/[),.;]+$/u, ''))
    .find((part) => {
      try {
        const parsed = new URL(part);
        return parsed.protocol === 'https:';
      } catch {
        return false;
      }
    });
  const numberMatch = /\bpullrequest\/(\d+)\b/i.exec(stderr) ?? /\bPR\s+(\d+)\b/i.exec(stderr);
  const number = numberMatch ? Number(numberMatch[1]) : null;
  if (!url && (!Number.isInteger(number) || (number ?? 0) <= 0)) return null;
  return {
    ...(Number.isInteger(number) && (number ?? 0) > 0 ? { pullRequestNumber: number as number } : {}),
    ...(url ? { pullRequestUrl: url } : {}),
  };
}

function mapAzFailure(result: ScmHostingProviderRuntimeCommandResult): never {
  // A command that never exited has no verdict: its stderr is whatever it had written when it was
  // cut short, so reading "not found"/"login" out of it invents an answer the CLI never gave. The
  // host reports that as `exitCode: null` (see the SCM hosting `executeCommand` boundary).
  if (typeof result.exitCode !== 'number') {
    throw createAzureCommandFailedError('Azure CLI command did not complete');
  }
  const normalized = result.stderr.toLowerCase();
  if (/\b(login|authentication|authorization|not logged|credentials?)\b/.test(normalized)) {
    throw createAzureAuthRequiredError('Azure CLI authentication is required');
  }
  if (/\b(not found|404)\b/.test(normalized)) {
    throw createAzureNotFoundError();
  }
  if (/\b(already exists|already has active pull request|duplicate)\b/.test(normalized)) {
    const hint = parseDuplicateHint(result.stderr);
    throw createAzureDuplicatePullRequestError({
      message: 'Azure DevOps pull request already exists',
      ...(hint?.pullRequestNumber !== undefined ? { pullRequestNumber: hint.pullRequestNumber } : {}),
      ...(hint?.pullRequestUrl !== undefined ? { pullRequestUrl: hint.pullRequestUrl } : {}),
    });
  }
  throw createAzureCommandFailedError('Azure CLI operation failed');
}

async function runAzJson(input: Readonly<{
  args: readonly string[];
  runtimeServices?: ScmHostingProviderRuntimeServices;
  timeoutMs?: number;
}>): Promise<unknown> {
  const runner = input.runtimeServices?.executeCommand;
  if (!runner) throw createAzureCommandFailedError('Azure CLI command runner is unavailable');
  const result = await runner({
    executable: AZURE_CLI_EXECUTABLE,
    args: input.args,
    timeoutMs: input.timeoutMs ?? DEFAULT_AZURE_DEVOPS_TIMEOUT_MS,
    env: AZURE_DEVOPS_NONINTERACTIVE_ENV,
  });
  if (!result.ok) mapAzFailure(result);
  return readJson(result.stdout);
}

function baseArgs(provider: ScmHostingProviderRef): readonly string[] {
  const coordinates = readAzureDevopsRepositoryCoordinates(provider);
  return [
    '--organization',
    coordinates.organizationUrl,
    '--project',
    coordinates.project,
    '--repository',
    coordinates.repository,
  ];
}

function authSummary(
  detection?: AzureDevopsCliAuthDetectionResult,
): ScmHostingRepositoryAuthSummary {
  switch (detection?.kind) {
    case 'missing-cli':
      return {
        state: 'unsupported',
        profileKind: 'provider_cli',
        remediation: {
          kind: 'install_required',
          ...(detection.remediation.kind === 'install_required' ? { url: detection.remediation.setupUrl } : {}),
        },
      };
    case 'missing-auth':
      return {
        state: 'authentication_required',
        profileKind: 'provider_cli',
        remediation: {
          kind: 'auth_required',
          ...(detection.remediation.kind === 'auth_required' ? { action: detection.remediation.commandPreview.join(' ') } : {}),
        },
      };
    case 'undetermined':
      return {
        state: 'unknown',
        profileKind: 'provider_cli',
        remediation: { kind: 'retry' },
      };
    default:
      break;
  }
  return {
    state: 'authenticated',
    profileKind: 'provider_cli',
    ...(detection?.kind === 'authenticated' && detection.accountName ? { label: detection.accountName } : {}),
  };
}

function publishTarget(input: Readonly<{
  provider: ScmHostingProviderRef;
  owner: string;
  supportedVisibilities: readonly ScmHostingRepositoryVisibility[];
  isDefault: boolean;
  auth?: ScmHostingRepositoryAuthSummary;
}>): ScmHostingRepositoryPublishTarget {
  const provider = input.provider;
  return {
    provider,
    owner: input.owner,
    ownerKind: 'org',
    label: input.owner,
    isDefault: input.isDefault,
    supportedVisibilities: [...input.supportedVisibilities],
    supportedRemoteUrlKinds: ['https', 'ssh'],
    auth: input.auth ?? authSummary(),
  };
}

function readProjectVisibility(raw: unknown): 'private' | 'public' {
  const visibility = readRecord(raw)?.visibility;
  if (visibility !== 'private' && visibility !== 'public') {
    throw createAzureCommandFailedError('Azure CLI returned an unreadable project visibility');
  }
  return visibility;
}

function readReferenceNumber(input: ScmHostingProviderPullRequestGetInput): number | null {
  const reference = input.reference as Readonly<{
    number?: unknown;
    url?: unknown;
    headBranch?: unknown;
  }>;
  if (typeof reference.number === 'number' && Number.isInteger(reference.number) && reference.number > 0) {
    return reference.number;
  }
  if (typeof reference.url === 'string') {
    return parseAzurePullRequestNumberFromUrl(input.provider, reference.url);
  }
  return null;
}

function normalizeNameWithOwner(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  const segments = normalized.split('/');
  return segments.length >= 2 && segments.every((segment) => segment.length > 0) ? normalized : null;
}

function matchesAzureBranchHeadContext(input: Readonly<{
  pullRequest: ScmPullRequestSummary;
  provider: ScmHostingProviderRef;
  baseBranch: string;
  headBranch: string;
}>): boolean {
  if (input.pullRequest.provider.id !== input.provider.id) return false;
  if (input.pullRequest.provider.kind !== input.provider.kind) return false;
  if (input.pullRequest.provider.baseUrl !== input.provider.baseUrl) return false;
  if (input.pullRequest.state !== 'open') return false;
  if (input.pullRequest.baseBranch !== input.baseBranch) return false;
  if (input.pullRequest.headBranch !== input.headBranch) return false;
  const expected = normalizeNameWithOwner(input.provider.nameWithOwner);
  const actual = normalizeNameWithOwner(input.pullRequest.headRepositoryNameWithOwner);
  return Boolean(expected && actual && expected === actual);
}

function findMatchingAzurePullRequest(input: Readonly<{
  pullRequests: readonly ScmPullRequestSummary[];
  provider: ScmHostingProviderRef;
  baseBranch: string;
  headBranch: string;
}>): ScmPullRequestSummary | null {
  return input.pullRequests.find((pullRequest) => matchesAzureBranchHeadContext({
    pullRequest,
    provider: input.provider,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
  })) ?? null;
}

function isDuplicatePullRequestError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { errorCode?: unknown }).errorCode === 'REMOTE_ALREADY_EXISTS');
}

export function createAzureDevopsOperationsAdapter(): AzureDevopsOperationsAdapter {
  async function listPullRequests(
    input: ScmHostingProviderPullRequestListInput,
  ): Promise<readonly ScmPullRequestSummary[]> {
    const args = [
      'repos',
      'pr',
      'list',
      ...baseArgs(input.provider),
      '--source-branch',
      input.head,
      ...(input.base ? ['--target-branch', input.base] : []),
      '--status',
      mapListStatus(input.state),
      '--output',
      'json',
    ];
    const raw = await runAzJson({
      args,
      ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
    });
    return (Array.isArray(raw) ? raw : [])
      .map((item) => mapAzurePullRequest(input.provider, item))
      .filter((item): item is ScmPullRequestSummary => item !== null);
  }

  async function getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null> {
    const number = readReferenceNumber(input);
    if (number) {
      const raw = await runAzJson({
        args: [
          'repos',
          'pr',
          'show',
          ...baseArgs(input.provider),
          '--id',
          String(number),
          '--output',
          'json',
        ],
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      return mapAzurePullRequest(input.provider, raw);
    }
    const reference = input.reference as Readonly<{ headBranch?: unknown }>;
    if (typeof reference.headBranch === 'string') {
      const matches = await listPullRequests({
        provider: input.provider,
        head: reference.headBranch,
        state: 'open',
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      return matches[0] ?? null;
    }
    return null;
  }

  async function createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary> {
    const raw = await runAzJson({
      args: [
        'repos',
        'pr',
        'create',
        ...baseArgs(input.provider),
        '--source-branch',
        input.head,
        '--target-branch',
        input.base,
        '--title',
        input.title,
        '--description',
        input.body ?? '',
        '--draft',
        input.draft ? 'true' : 'false',
        '--output',
        'json',
      ],
      ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
    });
    const pullRequest = mapAzurePullRequest(input.provider, raw);
    if (!pullRequest) throw createAzureCommandFailedError('Azure CLI returned an invalid pull request payload');
    return pullRequest;
  }

  return Object.freeze({
    ...azureDevopsHostingProviderAdapter,
    getPullRequestAuthProfileKey() {
      return null;
    },
    listPullRequests,
    getPullRequest,
    createPullRequest,
    async openOrReusePullRequest(input: ScmHostingProviderPullRequestCreateInput) {
      const existing = findMatchingAzurePullRequest({
        pullRequests: await listPullRequests({
          provider: input.provider,
          base: input.base,
          head: input.head,
          state: 'open',
          ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
        }),
        provider: input.provider,
        baseBranch: input.base,
        headBranch: input.head,
      });
      if (existing) return { pullRequest: existing, reused: true };
      try {
        return { pullRequest: await createPullRequest(input), reused: false };
      } catch (error) {
        if (!isDuplicatePullRequestError(error)) throw error;
        const number = (error as { pullRequestNumber?: unknown }).pullRequestNumber;
        const url = (error as { pullRequestUrl?: unknown }).pullRequestUrl;
        let hintedPullRequest: ScmPullRequestSummary | null = null;
        if ((typeof number === 'number' && Number.isInteger(number) && number > 0) || typeof url === 'string') {
          hintedPullRequest = await getPullRequest({
            provider: input.provider,
            reference: typeof number === 'number' && Number.isInteger(number) && number > 0
              ? { number }
              : { url: url as string },
            ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
          }).catch(() => null);
        }
        if (hintedPullRequest && matchesAzureBranchHeadContext({
          pullRequest: hintedPullRequest,
          provider: input.provider,
          baseBranch: input.base,
          headBranch: input.head,
        })) {
          return { pullRequest: hintedPullRequest, reused: true };
        }
        const listedAfterDuplicate = findMatchingAzurePullRequest({
          pullRequests: await listPullRequests({
            provider: input.provider,
            base: input.base,
            head: input.head,
            state: 'open',
            ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
          }),
          provider: input.provider,
          baseBranch: input.base,
          headBranch: input.head,
        });
        if (listedAfterDuplicate) return { pullRequest: listedAfterDuplicate, reused: true };
        throw error;
      }
    },
    async describePublishTargets(input: ScmHostingProviderRepositoryDescribePublishTargetsInput) {
      const current = input.provider.nameWithOwner ? readAzureDevopsRepositoryCoordinates(input.provider) : null;
      const coordinates = current ?? readAzureDevopsOrganizationCoordinates(input.provider);
      const detection = await detectAzureDevopsCliAuth({
        provider: input.provider,
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      // A probe that could not answer is a failed discovery, never a publish form carrying a
      // sign-in instruction the user cannot act on.
      if (detection.kind === 'undetermined') throw createAzureCommandFailedError(detection.message);
      const auth = authSummary(detection);
      if (detection.kind !== 'authenticated') {
        return { auth, targets: current ? [publishTarget({ provider: input.provider, auth,
          owner: `${current.organization}/${current.project}`, isDefault: true,
          supportedVisibilities: ['private', 'public'] })] : [] };
      }
      const targets: ScmHostingRepositoryPublishTarget[] = [];
      let continuationToken: string | null = null;
      do {
        // Azure CLI's projects response publishes its own continuationToken. No local
        // project ceiling or guessed offset may hide an organization project.
        const raw = await runAzJson({ args: ['devops', 'project', 'list', '--organization', coordinates.organizationUrl,
          '--state-filter', 'wellFormed', ...(continuationToken ? ['--continuation-token', continuationToken] : []),
          '--output', 'json'], runtimeServices: input.runtimeServices });
        const rows = readAzureCollectionRows(raw);
        if (!rows) throw createAzureCommandFailedError('Azure CLI returned an invalid project list');
        for (const row of rows) {
          const project = decodeAzureProjectRow(row);
          if (!project) throw createAzureCommandFailedError('Azure CLI returned an invalid project');
          targets.push(publishTarget({ provider: input.provider, auth, owner: `${coordinates.organization}/${project.name}`,
            isDefault: current ? current.project === project.name : targets.length === 0,
            supportedVisibilities: [readProjectVisibility(row)] }));
        }
        const token = readRecord(raw)?.continuationToken;
        if (token !== undefined && token !== null && typeof token !== 'string') {
          throw createAzureCommandFailedError('Azure CLI returned an invalid project continuation');
        }
        continuationToken = typeof token === 'string' && token.length > 0 ? token : null;
      } while (continuationToken);
      return { auth, targets };
    },
    async createRepository(input: ScmHostingProviderRepositoryCreateInput) {
      const coordinates = readAzureDevopsRepositoryPublicationCoordinates(input);
      const project = await runAzJson({
        args: ['devops', 'project', 'show', '--organization', coordinates.organizationUrl,
          '--project', coordinates.project, '--output', 'json'],
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      const visibility = readProjectVisibility(project);
      if (visibility !== input.visibility) {
        throw createAzureInvalidRequestError('Repository visibility must match its Azure DevOps project');
      }
      const raw = await runAzJson({
        args: [
          'repos',
          'create',
          '--organization',
          coordinates.organizationUrl,
          '--project',
          coordinates.project,
          '--name',
          input.repositoryName,
          '--output',
          'json',
        ],
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      const mapped = mapAzureRepositorySummary({
        provider: input.provider,
        coordinates,
        raw,
        repositoryName: input.repositoryName,
        visibility,
      });
      if (!mapped) throw createAzureCommandFailedError('Azure CLI returned an invalid repository payload');
      return mapped;
    },
    async getRepository(input: ScmHostingProviderRepositoryGetInput) {
      const coordinates = readAzureDevopsRepositoryPublicationCoordinates(input);
      const raw = await runAzJson({
        args: [
          'repos',
          'show',
          '--organization',
          coordinates.organizationUrl,
          '--project',
          coordinates.project,
          '--repository',
          input.repositoryName,
          '--output',
          'json',
        ],
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      }).catch((error) => {
        if (Boolean(error)
          && typeof error === 'object'
          && (error as { errorCode?: unknown }).errorCode === 'REMOTE_NOT_FOUND') {
          return null;
        }
        throw error;
      });
      if (!raw) return null;
      const mapped = mapAzureRepositorySummary({
        provider: input.provider,
        coordinates,
        raw,
        repositoryName: input.repositoryName,
      });
      if (!mapped) throw createAzureCommandFailedError('Azure CLI returned an invalid repository payload');
      return mapped;
    },
  });
}

export const azureDevopsOperationsAdapter = createAzureDevopsOperationsAdapter();
