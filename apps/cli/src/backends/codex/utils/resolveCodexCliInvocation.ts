import { existsSync, readFileSync } from 'node:fs';

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

function resolveOverrideCommand(processEnv: NodeJS.ProcessEnv, overrideEnvVarKeys: readonly string[]): string | null {
    for (const key of overrideEnvVarKeys) {
        const value = typeof processEnv[key] === 'string' ? processEnv[key].trim() : '';
        if (value) return value;
    }
    return null;
}

export async function resolveCodexCliInvocation(params: Readonly<{
    args: string[];
    processEnv?: NodeJS.ProcessEnv;
    overrideEnvVarKeys?: readonly string[];
    targetLabel?: string;
}>): Promise<Readonly<{ command: string; args: string[] }>> {
    const processEnv = params.processEnv ?? process.env;
    const command =
        resolveOverrideCommand(processEnv, params.overrideEnvVarKeys ?? [])
        ?? requireProviderCliCommand('codex');

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
