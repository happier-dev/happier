import { spawn } from 'node:child_process';

const CMD_META_CHARS_REGEXP = /([()\][%!^"`<>&|;, *?])/g;

type CommandInvocation = Readonly<{
    command: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
}>;

type ResolveCommandOptions = Readonly<{
    platform?: NodeJS.Platform;
    processExecPath?: string;
    comspec?: string | null;
}>;

function escapeCmdCommand(arg: string): string {
    return String(arg).replace(CMD_META_CHARS_REGEXP, '^$1');
}

function escapeCmdArgument(arg: string): string {
    let value = String(arg);
    value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
    value = value.replace(/(?=(\\+?)?)\1$/, '$1$1');
    value = `"${value}"`;
    return value.replace(CMD_META_CHARS_REGEXP, '^$1');
}

function buildWindowsCmdShimInvocation(
    command: string,
    args: readonly string[],
    options: Readonly<{ comspec?: string | null }> = {},
): CommandInvocation {
    const comspec =
        String(options.comspec ?? process.env.comspec ?? process.env.ComSpec ?? process.env.COMSPEC ?? '').trim() ||
        'cmd.exe';
    const shellCommand = [escapeCmdCommand(command), ...args.map((arg) => escapeCmdArgument(arg))].join(' ');
    return {
        command: comspec,
        args: ['/d', '/s', '/c', `"${shellCommand}"`],
        windowsVerbatimArguments: true,
    };
}

export function resolveServerScriptCommandInvocation(
    cmd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    options: ResolveCommandOptions = {},
): CommandInvocation {
    const normalized = cmd.trim().toLowerCase();
    if (normalized === 'yarn' || normalized === 'yarn.cmd') {
        const platform = options.platform ?? process.platform;
        const processExecPath = options.processExecPath ?? process.execPath;
        const npmExecPath = String(env.npm_execpath ?? '').trim();
        const yarnCommand = platform === 'win32' ? 'yarn.cmd' : 'yarn';
        const isNpmCliPath = /(^|[\\/])npm-cli\.js$/i.test(npmExecPath);
        const invocation = npmExecPath.length > 0 && !isNpmCliPath
            ? { command: processExecPath, args: [npmExecPath, ...args] }
            : { command: yarnCommand, args: [...args] };

        if (platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command)) {
            return buildWindowsCmdShimInvocation(invocation.command, invocation.args, {
                comspec: options.comspec ?? env.COMSPEC ?? env.ComSpec ?? env.comspec,
            });
        }

        return invocation;
    }
    return { command: cmd, args: [...args] };
}

export function runCommand(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        const invocation = resolveServerScriptCommandInvocation(cmd, args, env);
        const child = spawn(invocation.command, invocation.args, {
            env,
            stdio: 'inherit',
            shell: false,
            ...(invocation.windowsVerbatimArguments
                ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
                : {}),
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}
