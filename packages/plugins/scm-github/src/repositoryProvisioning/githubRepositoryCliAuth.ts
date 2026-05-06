export type GithubRepositoryCliCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

export type GithubRepositoryCliCommandRunner = (request: Readonly<{
  binPath: string;
  args: readonly string[];
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}>) => Promise<GithubRepositoryCliCommandResult>;

export type GithubRepositoryCliCommandResolution =
  | Readonly<{
    kind: 'available';
    source: 'system' | 'managed';
    binPath: string;
  }>
  | Readonly<{
    kind: 'missing';
  }>;

export type GithubRepositoryCliCommandResolver = () => Promise<GithubRepositoryCliCommandResolution>;

export type GithubRepositoryDepGhStatus = Readonly<{
  capabilityId: 'dep.gh';
  installed: boolean;
  resolvedSource: 'system' | 'managed' | null;
  binPath: string | null;
}>;

export type GithubRepositoryCliAuthDetectionResult =
  | Readonly<{
    kind: 'authenticated';
    source: 'system' | 'managed';
    binPath: string;
    host: string;
  }>
  | Readonly<{
    kind: 'missing-auth';
    source: 'system' | 'managed';
    binPath: string;
    host: string;
  }>
  | Readonly<{
    kind: 'missing-cli';
    host: string;
  }>;

const DEFAULT_GITHUB_REPOSITORY_CLI_AUTH_TIMEOUT_MS = 10_000;

function defaultMissingCommandResolver(): Promise<GithubRepositoryCliCommandResolution> {
  return Promise.resolve({ kind: 'missing' });
}

export function resolveGithubRepositoryCliCommandFromDepGhStatus(
  status: GithubRepositoryDepGhStatus,
): GithubRepositoryCliCommandResolution {
  if (!status.installed || !status.binPath || !status.resolvedSource) {
    return { kind: 'missing' };
  }
  return {
    kind: 'available',
    source: status.resolvedSource,
    binPath: status.binPath,
  };
}

export function resolveGithubRepositoryCliHost(providerBaseUrl: string): string {
  try {
    return new URL(providerBaseUrl).hostname.toLowerCase();
  } catch {
    return 'github.com';
  }
}

export async function detectGithubRepositoryCliAuth(input: Readonly<{
  providerBaseUrl: string;
  resolveCommand?: GithubRepositoryCliCommandResolver;
  runCommand: GithubRepositoryCliCommandRunner;
  timeoutMs?: number;
}>): Promise<GithubRepositoryCliAuthDetectionResult> {
  const host = resolveGithubRepositoryCliHost(input.providerBaseUrl);
  const resolved = await (input.resolveCommand ?? defaultMissingCommandResolver)();
  if (resolved.kind === 'missing') {
    return { kind: 'missing-cli', host };
  }

  const result = await input.runCommand({
    binPath: resolved.binPath,
    // Audit fence: provider-owned gh auth status --hostname for host-scoped authentication.
    args: ['auth', 'status', '--hostname', host],
    timeoutMs: input.timeoutMs ?? DEFAULT_GITHUB_REPOSITORY_CLI_AUTH_TIMEOUT_MS,
  });
  return result.ok
    ? {
      kind: 'authenticated',
      source: resolved.source,
      binPath: resolved.binPath,
      host,
    }
    : {
      kind: 'missing-auth',
      source: resolved.source,
      binPath: resolved.binPath,
      host,
    };
}
