export type GithubDefaultBranchMetadata = Readonly<{
  name: string;
  sha?: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function mapGithubDefaultBranch(raw: unknown): GithubDefaultBranchMetadata | null {
  if (!isRecord(raw)) return null;
  const defaultBranchRef = isRecord(raw.defaultBranchRef) ? raw.defaultBranchRef : null;
  const defaultBranchRefTarget = defaultBranchRef && isRecord(defaultBranchRef.target)
    ? defaultBranchRef.target
    : null;
  const name = readString(raw.default_branch)
    ?? (defaultBranchRef ? readString(defaultBranchRef.name) : null);
  if (!name) return null;
  const sha = isRecord(raw.default_branch_ref)
    ? readString(raw.default_branch_ref.sha)
    : defaultBranchRef
      ? readString(defaultBranchRefTarget?.oid) ?? readString(defaultBranchRef.oid)
      : null;
  return {
    name,
    ...(sha ? { sha } : {}),
  };
}
