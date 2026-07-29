import type {
  ScmHostingProviderRef,
  ScmHostingRepositorySummary,
  ScmHostingRepositoryVisibility,
} from '@happier-dev/plugin-sdk/experimental/scm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeVisibility(value: unknown): ScmHostingRepositoryVisibility {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'private' || normalized === 'public' || normalized === 'internal') {
      return normalized;
    }
  }
  return 'private';
}

function readDefaultBranch(raw: Record<string, unknown>): string | null {
  const defaultBranch = readString(raw, 'default_branch') ?? readString(raw, 'defaultBranch');
  if (defaultBranch) return defaultBranch;
  const defaultBranchRef = raw.defaultBranchRef;
  if (isRecord(defaultBranchRef)) {
    return readString(defaultBranchRef, 'name');
  }
  return null;
}

export function mapGithubRepositorySummary(input: Readonly<{
  provider: ScmHostingProviderRef;
  raw: unknown;
  fallbackNameWithOwner?: string;
  fallbackWebUrl?: string;
  fallbackVisibility?: ScmHostingRepositoryVisibility;
}>): ScmHostingRepositorySummary | null {
  if (!isRecord(input.raw)) return null;
  const nameWithOwner = readString(input.raw, 'full_name')
    ?? readString(input.raw, 'nameWithOwner')
    ?? input.fallbackNameWithOwner
    ?? null;
  const webUrl = readString(input.raw, 'html_url')
    ?? readString(input.raw, 'url')
    ?? input.fallbackWebUrl
    ?? null;
  if (!nameWithOwner || !webUrl) return null;

  const cloneUrl = readString(input.raw, 'clone_url') ?? readString(input.raw, 'cloneUrl');
  const sshUrl = readString(input.raw, 'ssh_url') ?? readString(input.raw, 'sshUrl');
  const visibility = normalizeVisibility(input.raw.visibility ?? input.fallbackVisibility);
  const defaultBranch = readDefaultBranch(input.raw);

  return {
    provider: {
      ...input.provider,
      nameWithOwner,
    },
    nameWithOwner,
    webUrl,
    ...(cloneUrl ? { cloneUrl } : {}),
    ...(sshUrl ? { sshUrl } : {}),
    visibility,
    defaultBranch,
  };
}
