import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';

export type MaterializedClaudeMcpConfigArgs = Readonly<{
    args: string[];
    cleanup: () => Promise<void>;
}>;

function isInlineMcpConfig(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return false;

    try {
        const parsed: unknown = JSON.parse(trimmed);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
        return false;
    }
}

export function assertClaudeMcpConfigArgsSafeForDirectSpawn(inputArgs: readonly string[]): void {
    for (let index = 0; index < inputArgs.length; index += 1) {
        const arg = inputArgs[index] ?? '';
        const value = arg === '--mcp-config'
            ? inputArgs[index + 1]
            : arg.startsWith('--mcp-config=')
                ? arg.slice('--mcp-config='.length)
                : undefined;
        if (typeof value === 'string' && isInlineMcpConfig(value)) {
            throw new Error('Inline Claude MCP configuration is not allowed for direct terminal launch; provide an MCP config file path instead.');
        }
        if (arg === '--mcp-config') index += 1;
    }
}

/**
 * Replaces inline Claude `--mcp-config` JSON with private temporary files.
 *
 * Claude accepts JSON or a file path for this flag. Existing file paths remain untouched; only
 * inline JSON is materialized so secret-bearing MCP configuration never reaches process argv.
 */
export function materializeClaudeMcpConfigArgsForSpawn(
    inputArgs: readonly string[],
): MaterializedClaudeMcpConfigArgs {
    const args = [...inputArgs];
    const createdDirectories: string[] = [];

    const materializeValue = (value: string): string => {
        if (!isInlineMcpConfig(value)) return value;
        const path = writeSecureTempTextFileSync({
            prefix: 'happier-claude-mcp-config',
            suffix: '.json',
            contents: value,
        });
        createdDirectories.push(dirname(path));
        return path;
    };

    try {
        for (let index = 0; index < args.length; index += 1) {
            const arg = args[index] ?? '';
            if (arg === '--mcp-config') {
                const valueIndex = index + 1;
                const value = args[valueIndex];
                if (typeof value === 'string') {
                    args[valueIndex] = materializeValue(value);
                    index = valueIndex;
                }
                continue;
            }
            if (arg.startsWith('--mcp-config=')) {
                args[index] = `--mcp-config=${materializeValue(arg.slice('--mcp-config='.length))}`;
            }
        }
    } catch (error) {
        for (const directory of createdDirectories) {
            try {
                rmSync(directory, { recursive: true, force: true });
            } catch {
                // Best effort: preserve the materialization error that prevented launch.
            }
        }
        throw error;
    }

    let cleanupPromise: Promise<void> | null = null;
    return {
        args,
        cleanup: () => {
            cleanupPromise ??= Promise.allSettled(
                createdDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
            ).then(() => undefined);
            return cleanupPromise;
        },
    };
}
