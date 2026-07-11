import { AZ_DEP_ID } from '@happier-dev/plugin-sdk/experimental/managedDependencies';
import type {
  ScmHostingProviderDefaultBranchInput,
  ScmHostingProviderDefaultBranchMetadata,
  ScmHostingProviderPullRequestCreateInput,
  ScmHostingProviderPullRequestGetInput,
  ScmHostingProviderPullRequestListInput,
  ScmHostingProviderRepositoryCreateInput,
  ScmHostingProviderRepositoryDescribePublishTargetsInput,
  ScmHostingProviderRepositoryDescribePublishTargetsResult,
  ScmHostingProviderRepositoryGetInput,
  ScmHostingProviderRuntimeAdapter,
  ScmHostingProviderRuntimeCommandResult,
  ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';
import type {
  ScmHostingProviderRef,
  ScmHostingRepositoryAuthSummary,
  ScmHostingRepositoryPublishTarget,
  ScmHostingRepositorySummary,
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
  readAzureDevopsRepositoryCoordinates,
} from '../parsing/azureDevopsCoordinates.js';
import {
  createAzureAuthRequiredError,
  createAzureCommandFailedError,
  createAzureDuplicatePullRequestError,
  createAzureNotFoundError,
  createAzureUnsupportedError,
} from './errors.js';
import {
  mapAzurePullRequest,
  mapAzureRepositorySummary,
} from './mapping.js';

export type AzureDevopsOperationsAdapter = typeof azureDevopsHostingProviderAdapter & ScmHostingProviderRuntimeAdapter & Readonly<{
  listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]>;
  getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null>;
  createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary>;
  openOrReusePullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<Readonly<{
    pullRequest: ScmPullRequestSummary;
    reused: boolean;
  }>>;
  getDefaultBranch(input: ScmHostingProviderDefaultBranchInput): Promise<ScmHostingProviderDefaultBranchMetadata>;
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
  if (state === 'closed' || state === 'merged') return 'completed';
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

async function resolveAz(input: Readonly<{
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>): Promise<string> {
  const resolved = await input.runtimeServices?.resolveInstallableCommand?.({ capabilityId: AZ_DEP_ID });
  if (!resolved || resolved.kind !== 'available') {
    throw createAzureUnsupportedError('Azure CLI dependency dep.az is unavailable');
  }
  return resolved.binPath;
}

async function runAzJson(input: Readonly<{
  args: readonly string[];
  runtimeServices?: ScmHostingProviderRuntimeServices;
  timeoutMs?: number;
}>): Promise<unknown> {
  const binPath = await resolveAz(input);
  const runner = input.runtimeServices?.runCommand;
  if (!runner) throw createAzureUnsupportedError('Azure CLI command runner is unavailable');
  const result = await runner({
    binPath,
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

function targetOwner(input: Readonly<{
  provider: ScmHostingProviderRef;
  owner?: string;
}>): Readonly<{
  owner: string;
  project: string;
}> {
  const coordinates = readAzureDevopsRepositoryCoordinates(input.provider);
  const owner = input.owner?.trim() || `${coordinates.organization}/${coordinates.project}`;
  const parts = owner.split('/').map((part) => part.trim());
  if (parts.length === 1 && parts[0] === coordinates.project) {
    return { owner: `${coordinates.organization}/${coordinates.project}`, project: coordinates.project };
  }
  if (parts.length === 2 && parts[0] === coordinates.organization && parts[1] === coordinates.project) {
    return { owner: `${coordinates.organization}/${coordinates.project}`, project: coordinates.project };
  }
  throw createAzureCommandFailedError('Azure DevOps repository owner must be organization/project');
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
  auth?: ScmHostingRepositoryAuthSummary;
}>): ScmHostingRepositoryPublishTarget {
  const provider = input.provider;
  const coordinates = readAzureDevopsRepositoryCoordinates(provider);
  return {
    provider,
    owner: `${coordinates.organization}/${coordinates.project}`,
    ownerKind: 'org',
    label: `${coordinates.organization}/${coordinates.project}`,
    isDefault: true,
    supportedVisibilities: ['private', 'public'],
    supportedRemoteUrlKinds: ['https', 'ssh'],
    auth: input.auth ?? authSummary(),
  };
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
    async getDefaultBranch(input: ScmHostingProviderDefaultBranchInput) {
      const coordinates = readAzureDevopsRepositoryCoordinates(input.provider);
      const raw = await runAzJson({
        args: [
          'repos',
          'show',
          ...baseArgs(input.provider),
          '--output',
          'json',
        ],
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      const repository = mapAzureRepositorySummary({
        provider: input.provider,
        raw,
        repositoryName: coordinates.repository,
      });
      return { name: repository?.defaultBranch ?? 'main' };
    },
    async describePublishTargets(input: ScmHostingProviderRepositoryDescribePublishTargetsInput) {
      const auth = authSummary(await detectAzureDevopsCliAuth({
        provider: input.provider,
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      }));
      return {
        auth,
        targets: [publishTarget({ provider: input.provider, auth })],
      };
    },
    async createRepository(input: ScmHostingProviderRepositoryCreateInput) {
      const coordinates = readAzureDevopsRepositoryCoordinates(input.provider);
      const owner = targetOwner({
        provider: input.provider,
        owner: input.owner,
      });
      const raw = await runAzJson({
        args: [
          'repos',
          'create',
          '--organization',
          coordinates.organizationUrl,
          '--project',
          owner.project,
          '--name',
          input.repositoryName,
          '--output',
          'json',
        ],
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      const mapped = mapAzureRepositorySummary({
        provider: input.provider,
        raw,
        repositoryName: input.repositoryName,
        visibility: input.visibility,
      });
      if (!mapped) throw createAzureCommandFailedError('Azure CLI returned an invalid repository payload');
      return mapped;
    },
    async getRepository(input: ScmHostingProviderRepositoryGetInput) {
      const coordinates = readAzureDevopsRepositoryCoordinates(input.provider);
      const owner = targetOwner({
        provider: input.provider,
        owner: input.owner,
      });
      const raw = await runAzJson({
        args: [
          'repos',
          'show',
          '--organization',
          coordinates.organizationUrl,
          '--project',
          owner.project,
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
        raw,
        repositoryName: input.repositoryName,
      });
      if (!mapped) throw createAzureCommandFailedError('Azure CLI returned an invalid repository payload');
      return mapped;
    },
  });
}

export const azureDevopsOperationsAdapter = createAzureDevopsOperationsAdapter();
