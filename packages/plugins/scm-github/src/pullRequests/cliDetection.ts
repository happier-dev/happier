export type GithubCliCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

export type GithubCliCommandRunner = (request: Readonly<{
  binPath: string;
  args: readonly string[];
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}>) => Promise<GithubCliCommandResult>;

export type GithubCliCommandResolution =
  | Readonly<{
    kind: 'available';
    source: 'system' | 'managed';
    binPath: string;
  }>
  | Readonly<{
    kind: 'missing';
  }>;

export type GithubCliCommandResolver = () => Promise<GithubCliCommandResolution>;

export type GithubDepGhStatus = Readonly<{
  capabilityId: 'dep.gh';
  installed: boolean;
  resolvedSource: 'system' | 'managed' | null;
  binPath: string | null;
}>;

export type GithubCliAuthDetectionResult =
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

const DEFAULT_GITHUB_CLI_AUTH_TIMEOUT_MS = 10_000;

function defaultMissingCommandResolver(): Promise<GithubCliCommandResolution> {
  return Promise.resolve({ kind: 'missing' });
}

export function resolveGithubCliCommandFromDepGhStatus(
  status: GithubDepGhStatus,
): GithubCliCommandResolution {
  if (!status.installed || !status.binPath || !status.resolvedSource) {
    return { kind: 'missing' };
  }
  return {
    kind: 'available',
    source: status.resolvedSource,
    binPath: status.binPath,
  };
}

export function resolveGithubCliHost(providerBaseUrl: string): string {
  try {
    return new URL(providerBaseUrl).hostname.toLowerCase();
  } catch {
    return 'github.com';
  }
}

export async function detectGithubCliAuth(input: Readonly<{
  providerBaseUrl: string;
  resolveCommand?: GithubCliCommandResolver;
  runCommand: GithubCliCommandRunner;
  timeoutMs?: number;
}>): Promise<GithubCliAuthDetectionResult> {
  const host = resolveGithubCliHost(input.providerBaseUrl);
  const resolved = await (input.resolveCommand ?? defaultMissingCommandResolver)();
  if (resolved.kind === 'missing') {
    return { kind: 'missing-cli', host };
  }

  const result = await input.runCommand({
    binPath: resolved.binPath,
    args: ['auth', 'status', '--hostname', host],
    timeoutMs: input.timeoutMs ?? DEFAULT_GITHUB_CLI_AUTH_TIMEOUT_MS,
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
