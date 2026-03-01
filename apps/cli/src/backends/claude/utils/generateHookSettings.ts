/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings overlay file passed to Claude Code via `--settings`.
 *
 * IMPORTANT:
 * We intentionally do NOT read or merge Claude's `~/.claude/settings.json` (or project/local variants).
 * Claude Code merges `--settings` additively with settings loaded from its configured sources, including hooks.
 *
 * This was validated by running real `claude -p` processes:
 * - Project settings hooks + `--settings` hooks both fired (additive).
 * - Therefore, reading/merging user settings here is redundant and can introduce bugs (stale merges, invalid JSON).
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import { isBun } from '@/utils/runtime';

export interface GenerateHookSettingsOptions {
    enableLocalPermissionBridge?: boolean;
    permissionHookSecret?: string;
}

type ClaudeHookSettingsOverlay = Readonly<{
    hooks: Record<string, unknown>;
}>;

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, options: GenerateHookSettingsOptions = {}): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    // Prefer the current Node binary when available to avoid PATH-related failures on Windows.
    const nodeExecutable = isBun() ? 'node' : process.execPath;
    const hookCommand = `${JSON.stringify(nodeExecutable)} ${JSON.stringify(forwarderScript)} ${port}`;

    const hooks: Record<string, unknown> = {
        SessionStart: [
            {
                matcher: "*",
                hooks: [
                    {
                        type: "command",
                        command: hookCommand
                    }
                ]
            }
        ]
    };

    if (options.enableLocalPermissionBridge) {
        const permissionForwarderScript = resolve(projectPath(), 'scripts', 'permission_hook_forwarder.cjs');
        const secretPart =
            typeof options.permissionHookSecret === 'string' && options.permissionHookSecret.length > 0
                ? ` ${JSON.stringify(options.permissionHookSecret)}`
                : '';
        const permissionCommand = `${JSON.stringify(nodeExecutable)} ${JSON.stringify(permissionForwarderScript)} ${port}${secretPart}`;

        hooks.PermissionRequest = [
            {
                matcher: "*",
                hooks: [
                    {
                        type: "command",
                        command: permissionCommand
                    }
                ]
            }
        ];
    }

    const settings: ClaudeHookSettingsOverlay = { hooks };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}
