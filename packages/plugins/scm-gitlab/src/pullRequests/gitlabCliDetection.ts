export type GitlabCliCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

export type GitlabCliCommandRunner = (request: Readonly<{
  binPath: string;
  args: readonly string[];
  timeoutMs: number;
}>) => Promise<GitlabCliCommandResult>;

export type GitlabCliAuthDetectionResult =
  | Readonly<{
    kind: 'authenticated';
    source: 'system';
    binPath: string;
    host: string;
  }>
  | Readonly<{
    kind: 'missing-auth';
    source: 'system';
    binPath: string;
    host: string;
  }>
  | Readonly<{
    kind: 'missing-cli';
    host: string;
  }>
  | Readonly<{
    kind: 'command-failed';
    host: string;
  }>;

const DEFAULT_GITLAB_CLI_AUTH_TIMEOUT_MS = 10_000;
const GITLAB_CLI_BIN = 'glab';

function defaultRunner(): Promise<GitlabCliCommandResult> {
  return Promise.resolve({
    ok: false,
    stdout: '',
    stderr: 'glab command runner is unavailable',
    exitCode: null,
  });
}

export function resolveGitlabCliHost(providerBaseUrl: string): string {
  try {
    return new URL(providerBaseUrl).hostname.toLowerCase();
  } catch {
    return 'gitlab.com';
  }
}

function isMissingCliFailure(result: GitlabCliCommandResult): boolean {
  return result.exitCode === null
    || /\b(enoent|not found|no such file|command not found)\b/i.test(result.stderr);
}

function isMissingAuthFailure(result: GitlabCliCommandResult): boolean {
  return /\b(not logged|not authenticated|authentication|authorization|auth required|credentials?)\b/i.test(result.stderr);
}

export async function detectGitlabCliAuth(input: Readonly<{
  providerBaseUrl: string;
  runCommand?: GitlabCliCommandRunner;
  timeoutMs?: number;
}>): Promise<GitlabCliAuthDetectionResult> {
  const host = resolveGitlabCliHost(input.providerBaseUrl);
  const result = await (input.runCommand ?? defaultRunner)({
    binPath: GITLAB_CLI_BIN,
    args: ['auth', 'status', '--hostname', host],
    timeoutMs: input.timeoutMs ?? DEFAULT_GITLAB_CLI_AUTH_TIMEOUT_MS,
  });

  if (result.ok) {
    return {
      kind: 'authenticated',
      source: 'system',
      binPath: GITLAB_CLI_BIN,
      host,
    };
  }
  if (isMissingCliFailure(result)) return { kind: 'missing-cli', host };
  if (isMissingAuthFailure(result)) {
    return {
      kind: 'missing-auth',
      source: 'system',
      binPath: GITLAB_CLI_BIN,
      host,
    };
  }
  return { kind: 'command-failed', host };
}
