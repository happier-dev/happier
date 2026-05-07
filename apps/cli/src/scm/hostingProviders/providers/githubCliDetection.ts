import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { resolveGithubCliCommandPath } from '@/capabilities/deps/gh';

export type GithubCliCommandResult = Readonly<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}>;

export type GithubCliCommandRunner = (request: Readonly<{
    args: readonly string[];
    timeoutMs: number;
}>) => Promise<GithubCliCommandResult>;

export type GithubCliAuthDetectionResult =
    | Readonly<{
        kind: 'authenticated';
        command: 'gh';
        host: string;
    }>
    | Readonly<{
        kind: 'missing-auth';
        command: 'gh';
        host: string;
    }>;

const DEFAULT_GITHUB_CLI_TIMEOUT_MS = 10_000;

function resolveGithubCliTimeoutMs(): number {
    const parsed = Number(String(process.env.HAPPIER_GITHUB_CLI_TIMEOUT_MS ?? '').replaceAll('_', '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_GITHUB_CLI_TIMEOUT_MS;
}

export function resolveGithubCliHost(providerBaseUrl: string): string {
    try {
        return new URL(providerBaseUrl).hostname;
    } catch {
        return 'github.com';
    }
}

export const runGithubCliCommand: GithubCliCommandRunner = async (request) => {
    const result = await runCliCommandBestEffort({
        resolvedPath: resolveGithubCliCommandPath(),
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

export async function detectGithubCliAuth(input: Readonly<{
    providerBaseUrl: string;
    runCommand?: GithubCliCommandRunner;
}>): Promise<GithubCliAuthDetectionResult> {
    const host = resolveGithubCliHost(input.providerBaseUrl);
    const runCommand = input.runCommand ?? runGithubCliCommand;
    const result = await runCommand({
        args: ['auth', 'status', '--hostname', host],
        timeoutMs: resolveGithubCliTimeoutMs(),
    });
    return result.success
        ? { kind: 'authenticated', command: 'gh', host }
        : { kind: 'missing-auth', command: 'gh', host };
}
