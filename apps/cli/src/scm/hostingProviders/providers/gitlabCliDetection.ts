import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';

export type GitlabCliCommandResult = Readonly<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}>;

export type GitlabCliCommandRunner = (request: Readonly<{
    args: readonly string[];
    timeoutMs: number;
}>) => Promise<GitlabCliCommandResult>;

export type GitlabCliAuthDetectionResult =
    | Readonly<{
        kind: 'authenticated';
        command: 'glab';
        host: string;
    }>
    | Readonly<{
        kind: 'missing-auth';
        command: 'glab';
        host: string;
    }>;

const DEFAULT_GITLAB_CLI_TIMEOUT_MS = 10_000;

function resolveGitlabCliTimeoutMs(): number {
    const parsed = Number(String(process.env.HAPPIER_GITLAB_CLI_TIMEOUT_MS ?? '').replaceAll('_', '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_GITLAB_CLI_TIMEOUT_MS;
}

export function resolveGitlabCliHost(providerBaseUrl: string): string {
    try {
        return new URL(providerBaseUrl).hostname;
    } catch {
        return 'gitlab.com';
    }
}

export const runGitlabCliCommand: GitlabCliCommandRunner = async (request) => {
    const result = await runCliCommandBestEffort({
        resolvedPath: 'glab',
        args: [...request.args],
        timeoutMs: request.timeoutMs,
    });
    return {
        success: result.ok,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
    };
};

export async function detectGitlabCliAuth(input: Readonly<{
    providerBaseUrl: string;
    runCommand?: GitlabCliCommandRunner;
}>): Promise<GitlabCliAuthDetectionResult> {
    const host = resolveGitlabCliHost(input.providerBaseUrl);
    const runCommand = input.runCommand ?? runGitlabCliCommand;
    const result = await runCommand({
        args: ['auth', 'status', '--hostname', host],
        timeoutMs: resolveGitlabCliTimeoutMs(),
    });
    return result.success
        ? { kind: 'authenticated', command: 'glab', host }
        : { kind: 'missing-auth', command: 'glab', host };
}
