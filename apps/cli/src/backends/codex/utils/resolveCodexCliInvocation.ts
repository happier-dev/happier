import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { requireProviderCliCommand } from '@/runtime/managedTools/requireProviderCliCommand';
import { isBun } from '@/utils/runtime';

const JAVA_SCRIPT_ENTRYPOINT_EXTENSION = /\.(?:c?js|mjs)$/i;
const JAVA_SCRIPT_SHEBANG = /^#!.*\b(?:env\s+)?(?:node|bun)(?:\s|$)/;

function isJavaScriptBackedCodexCommand(command: string): boolean {
    if (JAVA_SCRIPT_ENTRYPOINT_EXTENSION.test(command)) {
        return true;
    }
    if (!existsSync(command)) {
        return false;
    }
    try {
        const header = readFileSync(command, 'utf8').slice(0, 256);
        const firstLine = header.split(/\r?\n/u, 1)[0] ?? '';
        return JAVA_SCRIPT_SHEBANG.test(firstLine);
    } catch {
        return false;
    }
}

function looksLikePath(value: string): boolean {
    return value.includes('/') || value.includes('\\') || value.startsWith('.') || value.startsWith('~');
}

function expandHomeDir(value: string): string {
    if (value === '~') {
        return homedir();
    }
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return resolve(homedir(), value.slice(2));
    }
    // Fall back to a conservative expansion for any other "~" prefix.
    return resolve(homedir(), value.slice(1));
}

function resolveOverrideCommand(
    processEnv: NodeJS.ProcessEnv,
    overrideEnvVarKeys: readonly string[],
    cwd: string,
): string | null {
    for (const key of overrideEnvVarKeys) {
        const value = typeof processEnv[key] === 'string' ? processEnv[key].trim() : '';
        if (!value) continue;

        if (!looksLikePath(value)) {
            return value;
        }

        const expanded = value.startsWith('~')
            ? expandHomeDir(value)
            : resolve(cwd, value);
        const accessMode =
            JAVA_SCRIPT_ENTRYPOINT_EXTENSION.test(expanded)
                ? fsConstants.R_OK
                : process.platform === 'win32'
                    ? fsConstants.F_OK
                    : fsConstants.X_OK;
        try {
            accessSync(expanded, accessMode);
            if (!statSync(expanded).isFile()) {
                continue;
            }
            return expanded;
        } catch {
            continue;
        }
    }
    return null;
}

export async function resolveCodexCliInvocation(params: Readonly<{
    args: string[];
    cwd?: string;
    processEnv?: NodeJS.ProcessEnv;
    overrideEnvVarKeys?: readonly string[];
    targetLabel?: string;
}>): Promise<Readonly<{ command: string; args: string[] }>> {
    const processEnv = params.processEnv ?? process.env;
    const cwd = params.cwd ?? process.cwd();
    const command =
        resolveOverrideCommand(processEnv, params.overrideEnvVarKeys ?? [], cwd)
        ?? requireProviderCliCommand('codex', { processEnv });

    if (!isJavaScriptBackedCodexCommand(command)) {
        return { command, args: [...params.args] };
    }

    const javaScriptRuntime = await requireJavaScriptRuntimeExecutable({
        isBunRuntime: isBun(),
        processEnv,
        targetLabel: params.targetLabel ?? 'Codex CLI',
    });

    return {
        command: javaScriptRuntime,
        args: [command, ...params.args],
    };
}
