import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { expandHomeDirPath, providerCliPathRequiresJavaScriptRuntime, resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';
import { resolveWindowsCommandPath } from '@happier-dev/cli-common/process';

import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { requireProviderCliCommand } from '@/runtime/managedTools/requireProviderCliCommand';
import { isBun } from '@/utils/runtime';

const JAVA_SCRIPT_ENTRYPOINT_EXTENSION = /\.(?:c?js|mjs)$/i;

/** Explicit binaries that launch the Codex App Server instead of the resolved Codex CLI. */
export const CODEX_APP_SERVER_OVERRIDE_ENV_KEYS = [
    'HAPPIER_CODEX_APP_SERVER_BIN',
    'HAPPIER_CODEX_TUI_BIN',
    'HAPPY_CODEX_TUI_BIN',
] as const;

function looksLikePath(value: string): boolean {
    return value.includes('/') || value.includes('\\') || value.startsWith('.') || value.startsWith('~');
}

function expandHomeDir(value: string): string {
    return resolve(value);
}

export function resolveCodexOverrideCommand(
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
            ? (() => {
                const expandedHome = expandHomeDirPath(value, processEnv);
                if (expandedHome.length > 0 && expandedHome !== value) {
                    return expandHomeDir(expandedHome);
                }
                return resolve(resolveHomeDirFromEnvironment(processEnv), value.slice(1));
            })()
            : resolve(cwd, value);
        const accessMode =
            JAVA_SCRIPT_ENTRYPOINT_EXTENSION.test(expanded)
                ? fsConstants.R_OK
                : process.platform === 'win32'
                    ? fsConstants.F_OK
                    : fsConstants.X_OK;
        if (process.platform === 'win32') {
            const normalizedExpanded = resolveWindowsCommandPath(expanded, processEnv);
            if (!normalizedExpanded) {
                continue;
            }
            return normalizedExpanded;
        }
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
        resolveCodexOverrideCommand(processEnv, params.overrideEnvVarKeys ?? [], cwd)
        ?? requireProviderCliCommand('codex', { processEnv });

    if (!providerCliPathRequiresJavaScriptRuntime(command)) {
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
