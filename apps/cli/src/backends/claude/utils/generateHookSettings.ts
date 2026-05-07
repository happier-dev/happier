/**
 * Generate temporary hook artifacts for a Claude CLI session.
 *
 * Hooks are registered via `--plugin-dir <dir>` (an ephemeral session-only plugin
 * whose only payload is a `hooks/hooks.json`). Non-hook configuration (for now just
 * the `mcp__happier__change_title*` allow rules) still rides on `--settings <file>`.
 *
 * Why not put the hooks in the `--settings` overlay like we used to?
 *
 * Claude Code's CLI treats `--settings` as a single overlay: when two `--settings`
 * flags are passed, only the first wins and subsequent ones are silently dropped
 * for hooks. Any PATH-resident wrapper that prepends its own `--settings` (cmux's
 * `/Applications/cmux.app/.../bin/claude` is the case we hit) causes Happier's
 * hooks to be silently discarded — no SessionStart fires, no transcript sync,
 * empty mobile UI.
 *
 * `--plugin-dir` is in a different, additive channel: multiple plugin dirs compose
 * without collision, and our hooks fire regardless of what else is in the spawn
 * chain. This module produces both artifacts so the caller can pass
 *   claude --plugin-dir <pluginDir> --settings <settingsFile> ...
 * and have hooks register reliably.
 *
 * Set `HAPPIER_CLAUDE_HOOKS_DISABLED=1` in the environment to suppress plugin-dir
 * generation entirely (for debugging Happier-spawned Claude without hook mirroring).
 * The non-hook settings file is still written in that mode.
 */

import { join } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';

export interface GenerateHookSettingsOptions {
    enableLocalPermissionBridge?: boolean;
    permissionHookSecret?: string;
}

type ClaudeSettingsOverlay = Readonly<{
    permissions?: Readonly<{
        allow?: readonly string[];
    }>;
}>;

const HOOKS_DISABLED_ENV_VAR = 'HAPPIER_CLAUDE_HOOKS_DISABLED';

function areHappierHooksDisabled(): boolean {
    const raw = process.env[HOOKS_DISABLED_ENV_VAR];
    if (typeof raw !== 'string') return false;
    const trimmed = raw.trim().toLowerCase();
    return trimmed === '1' || trimmed === 'true' || trimmed === 'yes';
}

function resolveNodeExecutable(): string {
    const nodeExecutable = resolveJavaScriptRuntimeExecutable({ isBunRuntime: isBun() });
    if (!nodeExecutable) {
        throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('claude session hook plugin'));
    }
    return nodeExecutable;
}

function resolveTmpRoot(subdirName: 'hooks' | 'hook-plugins'): string {
    const root = join(
        configuration.happyHomeDir,
        'tmp',
        resolveReleaseRingScopedBasename(subdirName, configuration.publicReleaseRing),
    );
    mkdirSync(root, { recursive: true });
    return root;
}

/**
 * Generate a temporary settings JSON file with non-hook configuration only
 * (currently: MCP change_title allow rules). Hooks are no longer carried here;
 * see `generateHookPluginDir` for those.
 */
export function generateHookSettingsFile(_port: number, _options: GenerateHookSettingsOptions = {}): string {
    const hooksDir = resolveTmpRoot('hooks');

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    const settings: ClaudeSettingsOverlay = {
        permissions: {
            allow: [
                'mcp__happier__change_title',
                'mcp__happier__session_title_set',
            ],
        },
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created settings file: ${filepath}`);

    return filepath;
}

/**
 * Generate a temporary plugin directory containing `hooks/hooks.json`.
 * Claude is launched with `--plugin-dir <returned path>` so the session registers
 * these hooks as an additive, session-only plugin.
 *
 * Returns `null` when `HAPPIER_CLAUDE_HOOKS_DISABLED=1` is set — callers should
 * then skip passing `--plugin-dir` and proceed without hook mirroring.
 */
export function generateHookPluginDir(port: number, options: GenerateHookSettingsOptions = {}): string | null {
    if (areHappierHooksDisabled()) {
        logger.debug(`[generateHookSettings] ${HOOKS_DISABLED_ENV_VAR} is set; skipping hook plugin generation`);
        return null;
    }

    const pluginsRoot = resolveTmpRoot('hook-plugins');
    const pluginDir = join(pluginsRoot, `session-${process.pid}`);
    const hooksDir = join(pluginDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const nodeExecutable = resolveNodeExecutable();
    const sessionForwarderScript = resolveCliRuntimeAssetPath('scripts', 'session_hook_forwarder.cjs');
    const buildSessionHookCommand = (hookEventName: string): string =>
        `${JSON.stringify(nodeExecutable)} ${JSON.stringify(sessionForwarderScript)} ${port} ${JSON.stringify(hookEventName)}`;

    const buildSessionHook = (hookEventName: string): unknown[] => [
        {
            matcher: '',
            hooks: [
                {
                    type: 'command',
                    command: buildSessionHookCommand(hookEventName),
                },
            ],
        },
    ];

    const hooks: Record<string, unknown> = {
        SessionStart: buildSessionHook('SessionStart'),
        UserPromptSubmit: buildSessionHook('UserPromptSubmit'),
        Stop: buildSessionHook('Stop'),
        StopFailure: buildSessionHook('StopFailure'),
        SessionEnd: buildSessionHook('SessionEnd'),
    };

    if (options.enableLocalPermissionBridge) {
        const permissionForwarderScript = resolveCliRuntimeAssetPath('scripts', 'permission_hook_forwarder.cjs');
        const secretPart =
            typeof options.permissionHookSecret === 'string' && options.permissionHookSecret.length > 0
                ? ` ${JSON.stringify(options.permissionHookSecret)}`
                : '';
        const permissionCommand = `${JSON.stringify(nodeExecutable)} ${JSON.stringify(permissionForwarderScript)} ${port}${secretPart}`;

        hooks.PermissionRequest = [
            {
                matcher: '',
                hooks: [
                    {
                        type: 'command',
                        command: permissionCommand,
                    },
                ],
            },
        ];
    }

    const hooksJson = { hooks };
    const hooksFile = join(hooksDir, 'hooks.json');
    writeFileSync(hooksFile, JSON.stringify(hooksJson, null, 2));
    logger.debug(`[generateHookSettings] Created hook plugin dir: ${pluginDir}`);

    return pluginDir;
}

/**
 * Remove the settings file produced by `generateHookSettingsFile`.
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup settings file: ${error}`);
    }
}

/**
 * Remove the plugin directory produced by `generateHookPluginDir`.
 */
export function cleanupHookPluginDir(dirpath: string | null | undefined): void {
    if (typeof dirpath !== 'string' || dirpath.length === 0) return;
    try {
        if (existsSync(dirpath)) {
            rmSync(dirpath, { recursive: true, force: true });
            logger.debug(`[generateHookSettings] Cleaned up hook plugin dir: ${dirpath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook plugin dir: ${error}`);
    }
}
