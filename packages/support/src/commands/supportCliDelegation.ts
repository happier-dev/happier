import { spawnSync } from 'node:child_process';

export type SupportDelegatedAction = Readonly<{
    command: string;
    reason: string;
}>;

export type SupportCommandRunnerResult = Readonly<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;

export function rewriteLeadingCliCommand(
    command: string,
    preferredCliCommand: 'happier' | 'hprev' | 'hdev' | null,
): string {
    if (!preferredCliCommand) return command;
    return command.startsWith('happier ') ? `${preferredCliCommand}${command.slice('happier'.length)}` : command;
}

export function splitDelegatedCommand(command: string): Readonly<{ cmd: string; args: readonly string[] }> {
    const tokens = command.split(/\s+/u).map((token) => token.trim()).filter(Boolean);
    const [cmd, ...args] = tokens;
    if (!cmd) {
        throw new Error('Delegated command is empty.');
    }
    return { cmd, args };
}

export function defaultRunSupportCommand(input: Readonly<{ cmd: string; args: readonly string[] }>): SupportCommandRunnerResult {
    const result = spawnSync(input.cmd, [...input.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
        encoding: 'utf8',
    });
    if (result.error) {
        throw result.error;
    }
    return {
        exitCode: typeof result.status === 'number' ? result.status : 1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
    };
}

export async function executeSupportDelegatedActions(
    actions: readonly SupportDelegatedAction[],
    runCommand: (input: Readonly<{ cmd: string; args: readonly string[] }>) => Promise<SupportCommandRunnerResult> | SupportCommandRunnerResult,
): Promise<void> {
    for (const action of actions) {
        const { cmd, args } = splitDelegatedCommand(action.command);
        const result = await runCommand({ cmd, args });
        if (result.exitCode !== 0) {
            const detail = result.stderr.trim() || result.stdout.trim() || `Command failed: ${action.command}`;
            throw new Error(detail);
        }
    }
}
