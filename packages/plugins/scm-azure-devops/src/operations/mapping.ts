import type {
  ScmHostingProviderRef,
  ScmHostingRepositorySummary,
  ScmHostingRepositoryVisibility,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import {
  buildAzureRepositoryWebUrl,
  readAzureDevopsRepositoryCoordinates,
  stripAzureBranchRef,
} from '../parsing/azureDevopsCoordinates.js';

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readNestedString(source: Record<string, unknown>, ...keys: readonly string[]): string | null {
  let current: unknown = source;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return readString(current);
}

function isSafeCoordinateSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('?')
    && !value.includes('#');
}

function normalizeAzureRepositoryCoordinate(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split('/').map((part) => part.trim());
  return parts.length === 3 && parts.every(isSafeCoordinateSegment) ? parts.join('/') : null;
}

function readRepositoryCoordinateFromRecord(
  coordinates: ReturnType<typeof readAzureDevopsRepositoryCoordinates>,
  repository: Record<string, unknown>,
): string | null {
  const direct = normalizeAzureRepositoryCoordinate(readString(repository.nameWithOwner));
  if (direct) return direct;

  const repositoryName = readString(repository.name);
  const projectName = readNestedString(repository, 'project', 'name');
  if (!repositoryName || !projectName) return null;
  return normalizeAzureRepositoryCoordinate(`${coordinates.organization}/${projectName}/${repositoryName}`);
}

function readAzurePullRequestHeadRepository(input: Readonly<{
  raw: Record<string, unknown>;
  coordinates: ReturnType<typeof readAzureDevopsRepositoryCoordinates>;
}>): string | null {
  const forkSource = readNestedRecord(input.raw, 'forkSource');
  const forkRepository = forkSource ? readNestedRecord(forkSource, 'repository') : null;
  if (forkSource || forkRepository) {
    return forkRepository ? readRepositoryCoordinateFromRecord(input.coordinates, forkRepository) : null;
  }

  const sourceRepository = readNestedRecord(input.raw, 'sourceRepository');
  if (sourceRepository) {
    return readRepositoryCoordinateFromRecord(input.coordinates, sourceRepository);
  }

  return input.coordinates.nameWithOwner;
}

function mapAzurePullRequestState(raw: Record<string, unknown>): ScmPullRequestState {
  if (raw.isDraft === true) return 'draft';
  const status = readString(raw.status)?.toLowerCase();
  if (status === 'active') return 'open';
  if (status === 'completed') return 'merged';
  if (status === 'abandoned') return 'closed';
  return 'unknown';
}

function readAzurePullRequestUrl(raw: Record<string, unknown>): string | null {
  return readNestedString(raw, '_links', 'web', 'href') ?? readString(raw.url);
}

function readAuthor(raw: Record<string, unknown>): ScmPullRequestSummary['author'] | undefined {
  const createdBy = readNestedRecord(raw, 'createdBy');
  if (!createdBy) return undefined;
  const login = readString(createdBy.uniqueName);
  const displayName = readString(createdBy.displayName);
  const url = readString(createdBy.url);
  if (!login && !displayName && !url) return undefined;
  return {
    ...(login ? { login } : {}),
    ...(displayName ? { displayName } : {}),
    ...(url ? { url } : {}),
  };
}

export function mapAzurePullRequest(
  provider: ScmHostingProviderRef,
  raw: unknown,
): ScmPullRequestSummary | null {
  if (!isRecord(raw)) return null;
  const number = readPositiveInt(raw.pullRequestId);
  const title = readString(raw.title);
  const url = readAzurePullRequestUrl(raw);
  const baseBranch = stripAzureBranchRef(raw.targetRefName);
  const headBranch = stripAzureBranchRef(raw.sourceRefName);
  if (!number || !title || !url || !baseBranch || !headBranch) return null;

  const coordinates = readAzureDevopsRepositoryCoordinates(provider);
  const headRepositoryNameWithOwner = readAzurePullRequestHeadRepository({ raw, coordinates });
  if (!headRepositoryNameWithOwner) return null;
  const headSha = readNestedString(raw, 'lastMergeSourceCommit', 'commitId');
  const baseSha = readNestedString(raw, 'lastMergeTargetCommit', 'commitId');
  const isDraft = typeof raw.isDraft === 'boolean' ? raw.isDraft : undefined;
  const author = readAuthor(raw);

  return {
    provider,
    number,
    providerNativeId: String(number),
    title,
    url,
    baseBranch,
    headBranch,
    headRepositoryNameWithOwner,
    isCrossRepository: headRepositoryNameWithOwner.toLowerCase() !== coordinates.nameWithOwner.toLowerCase(),
    ...(headSha !== null ? { headSha } : {}),
    ...(baseSha !== null ? { baseSha } : {}),
    state: mapAzurePullRequestState(raw),
    ...(typeof isDraft === 'boolean' ? { isDraft } : {}),
    ...(author ? { author } : {}),
  };
}

function normalizeDefaultBranch(value: unknown): string | null {
  return stripAzureBranchRef(value);
}

export function mapAzureRepositorySummary(input: Readonly<{
  provider: ScmHostingProviderRef;
  raw: unknown;
  repositoryName: string;
  visibility?: ScmHostingRepositoryVisibility;
}>): ScmHostingRepositorySummary | null {
  if (!isRecord(input.raw)) return null;
  const baseCoordinates = readAzureDevopsRepositoryCoordinates(input.provider);
  const repository = readString(input.raw.name) ?? input.repositoryName;
  const coordinates = {
    ...baseCoordinates,
    repository,
    nameWithOwner: `${baseCoordinates.organization}/${baseCoordinates.project}/${repository}`,
  };
  const webUrl = readString(input.raw.webUrl)
    ?? readString(input.raw.url)
    ?? buildAzureRepositoryWebUrl(coordinates);
  if (!webUrl) return null;
  const cloneUrl = readString(input.raw.remoteUrl) ?? readString(input.raw.cloneUrl);
  const sshUrl = readString(input.raw.sshUrl);
  const defaultBranch = normalizeDefaultBranch(input.raw.defaultBranch);

  return {
    provider: {
      ...input.provider,
      nameWithOwner: coordinates.nameWithOwner,
    },
    nameWithOwner: coordinates.nameWithOwner,
    webUrl,
    ...(cloneUrl ? { cloneUrl } : {}),
    ...(sshUrl ? { sshUrl } : {}),
    visibility: input.visibility ?? 'private',
    defaultBranch,
  };
}
