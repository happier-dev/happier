import { projectSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { rmdirSync, unlinkSync } from 'node:fs';
import { rmdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';

export type MaterializedClaudeMcpConfigArgs = Readonly<{
    args: string[];
    cleanup: () => Promise<void>;
}>;

export function buildClaudeMcpConfigArgs(mcpServers: Readonly<Record<string, unknown>> | null | undefined): string[] {
    return mcpServers && Object.keys(mcpServers).length > 0 ? ['--mcp-config', JSON.stringify({ mcpServers })] : [];
}

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
    reportCleanupFailure: (message: string) => void = (message) => console.warn(message),
): MaterializedClaudeMcpConfigArgs {
    const args = [...inputArgs];
    const createdPaths: string[] = [];
    const recordFailure = (errors: unknown[], error: unknown) => {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') errors.push(error);
    };
    const throwCleanupFailure = (errors: unknown[]) => {
        if (errors.length === 0) return;
        reportCleanupFailure('[Claude] MCP private file cleanup incomplete (claude_mcp_cleanup_incomplete)');
        throw new AggregateError(errors, 'Claude MCP private file cleanup incomplete');
    };

    const materializeValue = (value: string): string => {
        if (!isInlineMcpConfig(value)) return value;
        const path = writeSecureTempTextFileSync({
            prefix: 'happier-claude-mcp-config',
            suffix: '.json',
            contents: value,
        });
        createdPaths.push(path);
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
        const errors: unknown[] = [];
        for (const path of createdPaths) {
            try { unlinkSync(path); } catch (cleanupError) { recordFailure(errors, cleanupError); }
            try { rmdirSync(dirname(path)); } catch (cleanupError) { recordFailure(errors, cleanupError); }
        }
        try { throwCleanupFailure(errors); } catch (cleanupError) {
            throw Object.assign(new AggregateError([error, cleanupError], 'Claude MCP materialization failed with incomplete cleanup', { cause: error }), {
          failureCause: projectSessionRuntimeFailureCause(error, 'client_start', 'agent.launch'),
        });
        }
        throw error;
    }

    let cleanupPromise: Promise<void> | null = null;
    return {
        args,
        cleanup: () => {
            cleanupPromise ??= (async () => {
                const errors: unknown[] = [];
                await Promise.all(createdPaths.map(async (path) => {
                    await unlink(path).catch((error) => recordFailure(errors, error));
                    await rmdir(dirname(path)).catch((error) => recordFailure(errors, error));
                }));
                throwCleanupFailure(errors);
            })();
            return cleanupPromise;
        },
    };
}
