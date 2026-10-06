#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PluginUiBuildError } from './errors.js';
import {
    buildUniversalPluginUiArtifacts,
    type BuildUniversalPluginUiArtifactsResult,
} from './buildUniversalUiArtifacts.js';

export type RunPluginBuildUiCliInputV1 = Readonly<{
    argv: readonly string[];
    cwd?: string;
    onError?: (message: string) => void;
    onInfo?: (message: string) => void;
    onSuccess?: (result: BuildUniversalPluginUiArtifactsResult) => void;
}>;

type ParsedArgs = Readonly<{ projectRoot: string; manifestPath?: string; help: boolean }>;

function helpText(): string {
    return [
        'happier-plugin-build-ui',
        '',
        'Builds universal CommonJS Plugin UI artifacts under dist/happier-plugin-ui.',
        '',
        'Usage:',
        '  happier-plugin-build-ui [--project-root <dir>] [--manifest-path <file>]',
        '  happier-plugin-build-ui --help',
        '',
        'Executable artifacts are discovered from the emitted plugin manifest and exact',
        './happier-plugin-ui/<artifactId> package exports. Plugin-owned build config is unsupported.',
    ].join('\n');
}

function parseArgs(argv: readonly string[], cwd: string): ParsedArgs {
    let projectRoot = cwd;
    let manifestPath: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === '--help' || arg === '-h') return { projectRoot: cwd, help: true };
        if (arg !== '--project-root' && arg !== '--manifest-path') {
            throw new PluginUiBuildError('unknown_flag', `Unknown argument: ${arg}`);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new PluginUiBuildError('missing_flag_value', `Missing value for ${arg}`);
        }
        if (arg === '--project-root') projectRoot = value;
        else manifestPath = value;
        index += 1;
    }
    return {
        projectRoot: isAbsolute(projectRoot) ? projectRoot : resolve(cwd, projectRoot),
        ...(manifestPath ? { manifestPath: resolve(cwd, manifestPath) } : {}),
        help: false,
    };
}

export async function runPluginBuildUiCli(input: RunPluginBuildUiCliInputV1): Promise<number> {
    const reportError = input.onError ?? ((message: string) => process.stderr.write(`${message}\n`));
    const reportInfo = input.onInfo ?? ((message: string) => process.stdout.write(`${message}\n`));
    let parsed: ParsedArgs;
    try {
        parsed = parseArgs(input.argv, input.cwd ?? process.cwd());
    } catch (cause) {
        reportError(`happier-plugin-build-ui: ${(cause as Error).message}`);
        return 2;
    }
    if (parsed.help) {
        reportInfo(helpText());
        return 0;
    }
    try {
        const result = await buildUniversalPluginUiArtifacts(parsed.projectRoot, parsed.manifestPath);
        input.onSuccess?.(result);
        return 0;
    } catch (cause) {
        const code = cause && typeof cause === 'object' && 'code' in cause
            ? `[${String((cause as { code: unknown }).code)}] `
            : '';
        reportError(`happier-plugin-build-ui: ${code}${(cause as Error).message}`);
        return 1;
    }
}

export function isBinDirectInvocation(params: Readonly<{
    argvEntry: string | undefined;
    moduleUrl: string;
}>): boolean {
    if (!params.argvEntry) return false;
    try {
        return realpathSync(params.argvEntry) === realpathSync(fileURLToPath(params.moduleUrl));
    } catch {
        return params.moduleUrl === pathToFileURL(params.argvEntry).href;
    }
}

if (isBinDirectInvocation({ argvEntry: process.argv[1], moduleUrl: import.meta.url })) {
    void runPluginBuildUiCli({ argv: process.argv.slice(2) }).then((exitCode) => {
        process.exitCode = exitCode;
    });
}
