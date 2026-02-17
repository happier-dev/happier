/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import { readClaudeSettings, type ClaudeSettings } from './claudeSettings';
import { isBun } from '@/utils/runtime';

export interface GenerateHookSettingsOptions {
    enableLocalPermissionBridge?: boolean;
    permissionHookSecret?: string;
    /**
     * Override Claude config directory when the subprocess uses a non-default CLAUDE_CONFIG_DIR.
     * This ensures our generated --settings overlay merges with the correct user settings.
     */
    claudeConfigDir?: string;
}

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

    const baseSettings: ClaudeSettings = readClaudeSettings(options.claudeConfigDir) ?? {};
    const baseHooks =
        baseSettings && typeof baseSettings === 'object' && baseSettings.hooks && typeof baseSettings.hooks === 'object'
            ? (baseSettings.hooks as Record<string, unknown>)
            : {};

    const mergedHooks: Record<string, unknown> = { ...baseHooks };
    for (const [hookName, requiredValue] of Object.entries(hooks)) {
        const requiredEntries = Array.isArray(requiredValue) ? requiredValue : [requiredValue];
        const existingEntries = Array.isArray(mergedHooks[hookName]) ? [...(mergedHooks[hookName] as unknown[])] : [];

        for (const requiredEntry of requiredEntries) {
            const requiredCommand = (() => {
                try {
                    const cmd = (requiredEntry as any)?.hooks?.[0]?.command;
                    return typeof cmd === 'string' ? cmd : null;
                } catch {
                    return null;
                }
            })();

            const alreadyPresent = requiredCommand
                ? existingEntries.some((entry: any) => Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => h?.command === requiredCommand))
                : false;

            if (!alreadyPresent) {
                existingEntries.push(requiredEntry);
            }
        }

        mergedHooks[hookName] = existingEntries;
    }

    const settings: ClaudeSettings = {
        ...baseSettings,
        hooks: mergedHooks,
    };

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
