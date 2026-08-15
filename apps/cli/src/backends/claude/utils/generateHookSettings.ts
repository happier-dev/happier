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

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';
import { buildEncodedPowerShellCommand } from '@/utils/powerShellCommand';
import { resolveClaudePermissionHookTimeoutSeconds } from './permissionHookTimeout';

export { DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS } from './permissionHookTimeout';

export interface GenerateHookSettingsOptions {
    enableLocalPermissionBridge?: boolean;
    permissionHookSecret?: string;
    /**
     * Stable identity for the generated hook plugin directory.
     *
     * Claude can retain plugin references across `--resume` turns, so daemon-managed
     * resumes must not use a runner-PID-scoped path that disappears during auth
     * switches or planned restarts. When provided, the plugin dir is rewritten in
     * place and retained across runner cleanup; the next runner for the same session
     * overwrites the hook commands with its current port/secret.
     */
    sessionHookPluginId?: string;
    /**
     * Explicit Claude command-hook `timeout` (seconds) installed on the PermissionRequest /
     * PreToolUse(AskUserQuestion) permission hooks.
     *
     * This makes the provider-side hook ceiling explicit instead of silently relying on Claude's
     * undocumented default. The shared timeout resolver is also used by the local permission bridge's
     * expiry boundary so a late UI answer after the ceiling returns a typed expired result instead of a
     * false success.
     */
    permissionHookTimeoutSeconds?: number;
    /** Testable hook-launcher platform boundary; production defaults to the current platform. */
    platform?: NodeJS.Platform;
}

type ClaudeSettingsOverlay = Readonly<{
    permissions?: Readonly<{
        allow?: readonly string[];
    }>;
}>;

const HOOKS_DISABLED_ENV_VAR = 'HAPPIER_CLAUDE_HOOKS_DISABLED';
const RETAINED_HOOK_PLUGIN_MARKER_FILE = '.happier-hook-plugin.json';
const HOOK_RUNTIME_ASSETS_DIR = 'runtime-assets';
const SESSION_HOOK_FORWARDER_BASENAME = 'session_hook_forwarder.cjs';
const PERMISSION_HOOK_FORWARDER_BASENAME = 'permission_hook_forwarder.cjs';
const REQUIRED_RUNTIME_ACTIVITY_SESSION_HOOKS = ['PostToolUse', 'SubagentStart', 'SubagentStop'] as const;

function recordAt(values: readonly unknown[], index: number): Record<string, unknown> | null {
    const value = values[index];
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

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
    mkdirPrivateSync(root);
    return root;
}

function chmodIfSupported(path: string, mode: number): void {
    if (process.platform === 'win32') return;
    try {
        chmodSync(path, mode);
    } catch {
        // Best-effort hardening; write/mkdir mode still applies on creation.
    }
}

function mkdirPrivateSync(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodIfSupported(path, 0o700);
}

function writePrivateFileSync(path: string, contents: string): void {
    writeFileSync(path, contents, { mode: 0o600 });
    chmodIfSupported(path, 0o600);
}

function validateMaterializedForwarder(path: string, expectedContents: string): void {
    if (readFileSync(path, 'utf8') !== expectedContents) {
        throw new Error(`Claude hook forwarder materialization validation failed: ${path}`);
    }
}

function materializeHookRuntimeAssets(pluginDir: string): Readonly<{
    sessionForwarderScript: string;
    permissionForwarderScript: string;
}> {
    const sessionForwarderContents = readFileSync(
        resolveCliRuntimeAssetPath('scripts', SESSION_HOOK_FORWARDER_BASENAME),
        'utf8',
    );
    const permissionForwarderContents = readFileSync(
        resolveCliRuntimeAssetPath('scripts', PERMISSION_HOOK_FORWARDER_BASENAME),
        'utf8',
    );
    const assetVersion = createHash('sha256')
        .update(sessionForwarderContents)
        .update('\0')
        .update(permissionForwarderContents)
        .digest('hex')
        .slice(0, 24);
    const runtimeAssetsRoot = join(pluginDir, HOOK_RUNTIME_ASSETS_DIR);
    const versionedAssetsDir = join(runtimeAssetsRoot, assetVersion);
    const sessionForwarderScript = join(versionedAssetsDir, SESSION_HOOK_FORWARDER_BASENAME);
    const permissionForwarderScript = join(versionedAssetsDir, PERMISSION_HOOK_FORWARDER_BASENAME);
    mkdirPrivateSync(runtimeAssetsRoot);

    if (!existsSync(versionedAssetsDir)) {
        const stagingDir = join(runtimeAssetsRoot, `.staging-${process.pid}-${randomUUID()}`);
        try {
            mkdirPrivateSync(stagingDir);
            writePrivateFileSync(join(stagingDir, SESSION_HOOK_FORWARDER_BASENAME), sessionForwarderContents);
            writePrivateFileSync(join(stagingDir, PERMISSION_HOOK_FORWARDER_BASENAME), permissionForwarderContents);
            validateMaterializedForwarder(join(stagingDir, SESSION_HOOK_FORWARDER_BASENAME), sessionForwarderContents);
            validateMaterializedForwarder(join(stagingDir, PERMISSION_HOOK_FORWARDER_BASENAME), permissionForwarderContents);
            try {
                renameSync(stagingDir, versionedAssetsDir);
            } catch (error) {
                if (!existsSync(versionedAssetsDir)) throw error;
            }
        } finally {
            rmSync(stagingDir, { recursive: true, force: true });
        }
    }

    validateMaterializedForwarder(sessionForwarderScript, sessionForwarderContents);
    validateMaterializedForwarder(permissionForwarderScript, permissionForwarderContents);
    return { sessionForwarderScript, permissionForwarderScript };
}

function writeHookPluginConfiguration(params: Readonly<{
    pluginDir: string;
    port: number;
    nodeExecutable: string;
    enableLocalPermissionBridge: boolean;
    permissionHookTimeoutSeconds?: number;
    platform: NodeJS.Platform;
}>): void {
    const { sessionForwarderScript, permissionForwarderScript } = materializeHookRuntimeAssets(params.pluginDir);
    const secretFile = join(params.pluginDir, 'permission-hook-secret');
    const buildForwarderCommand = (scriptPath: string, hookEventName: string): string => {
        const secretFileExists = existsSync(secretFile);
        if (params.platform === 'win32') {
            const args = [params.nodeExecutable, scriptPath, String(params.port), hookEventName];
            if (secretFileExists) args.push('--secret-file', secretFile);
            return buildEncodedPowerShellCommand(args);
        }
        const secretPart = secretFileExists ? ` --secret-file ${JSON.stringify(secretFile)}` : '';
        return `${JSON.stringify(params.nodeExecutable)} ${JSON.stringify(scriptPath)} ${params.port} ${JSON.stringify(hookEventName)}${secretPart}`;
    };
    const buildSessionHookCommand = (hookEventName: string): string =>
        buildForwarderCommand(sessionForwarderScript, hookEventName);
    const buildSessionHook = (hookEventName: string): unknown[] => [{
        matcher: '',
        hooks: [{ type: 'command', command: buildSessionHookCommand(hookEventName) }],
    }];
    const hooks: Record<string, unknown> = {
        SessionStart: buildSessionHook('SessionStart'),
        UserPromptSubmit: buildSessionHook('UserPromptSubmit'),
        Stop: buildSessionHook('Stop'),
        StopFailure: buildSessionHook('StopFailure'),
        SessionEnd: buildSessionHook('SessionEnd'),
        PostToolUse: buildSessionHook('PostToolUse'),
        SubagentStart: buildSessionHook('SubagentStart'),
        SubagentStop: buildSessionHook('SubagentStop'),
    };

    if (params.enableLocalPermissionBridge) {
        const buildPermissionCommand = (hookEventName: 'PermissionRequest' | 'PreToolUse'): string =>
            buildForwarderCommand(permissionForwarderScript, hookEventName);
        const timeout = resolveClaudePermissionHookTimeoutSeconds({
            ...(params.permissionHookTimeoutSeconds === undefined
                ? {}
                : { permissionHookTimeoutSeconds: params.permissionHookTimeoutSeconds }),
        });
        hooks.PermissionRequest = [{
            matcher: '',
            hooks: [{ type: 'command', command: buildPermissionCommand('PermissionRequest'), timeout }],
        }];
        hooks.PreToolUse = [{
            matcher: 'AskUserQuestion',
            hooks: [{ type: 'command', command: buildPermissionCommand('PreToolUse'), timeout }],
        }];
    }

    // The versioned asset directory is complete before this one atomic activation point.
    // A failed refresh therefore leaves Claude's previous complete hook configuration intact.
    const hooksJsonPath = join(params.pluginDir, 'hooks', 'hooks.json');
    writeJsonAtomicSync(hooksJsonPath, { hooks });

    // An owned SessionStart/UserPromptSubmit proves Claude loaded this plugin. Pair that live
    // activation handshake with an exact readback of the activity hooks so supported idle cannot
    // be published from a partially generated observer configuration.
    const materialized = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as { hooks?: Record<string, unknown> };
    for (const hookName of REQUIRED_RUNTIME_ACTIVITY_SESSION_HOOKS) {
        const registrations = materialized.hooks?.[hookName];
        const registration = Array.isArray(registrations) ? recordAt(registrations, 0) : null;
        const hook = Array.isArray(registration?.hooks) ? recordAt(registration.hooks, 0) : null;
        if (
            registration?.matcher !== ''
            || hook?.type !== 'command'
            || hook.command !== buildSessionHookCommand(hookName)
        ) {
            throw new Error(`Claude runtime activity hook configuration is missing ${hookName}`);
        }
    }
}

export function refreshRetainedClaudeHookPlugin(params: Readonly<{
    pluginDir: string;
    port: number;
    permissionHookTimeoutSeconds?: number;
    platform?: NodeJS.Platform;
}>): void {
    writeHookPluginConfiguration({
        pluginDir: params.pluginDir,
        port: params.port,
        nodeExecutable: resolveNodeExecutable(),
        enableLocalPermissionBridge: true,
        platform: params.platform ?? process.platform,
        ...(params.permissionHookTimeoutSeconds === undefined
            ? {}
            : { permissionHookTimeoutSeconds: params.permissionHookTimeoutSeconds }),
    });
}

function sanitizeHookPluginId(value: string): string | null {
    const normalized = value.trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[-_.]+|[-_.]+$/g, '');
    if (normalized.length === 0) return null;
    return normalized.slice(0, 96);
}

function resolveHookPluginIdentity(options: GenerateHookSettingsOptions): Readonly<{
    id: string;
    retainAcrossRunnerRestarts: boolean;
}> {
    const stableId = typeof options.sessionHookPluginId === 'string'
        ? sanitizeHookPluginId(options.sessionHookPluginId)
        : null;
    if (stableId) {
        return { id: stableId, retainAcrossRunnerRestarts: true };
    }
    return { id: String(process.pid), retainAcrossRunnerRestarts: false };
}

function shouldRetainHookPluginDir(dirpath: string): boolean {
    try {
        const raw = readFileSync(join(dirpath, RETAINED_HOOK_PLUGIN_MARKER_FILE), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        return Boolean(
            parsed
            && typeof parsed === 'object'
            && (parsed as { retainAcrossRunnerRestarts?: unknown }).retainAcrossRunnerRestarts === true,
        );
    } catch {
        return false;
    }
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

    writePrivateFileSync(filepath, JSON.stringify(settings, null, 2));
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
    const pluginIdentity = resolveHookPluginIdentity(options);
    const pluginDir = join(pluginsRoot, `session-${pluginIdentity.id}`);
    const manifestDir = join(pluginDir, '.claude-plugin');
    const hooksDir = join(pluginDir, 'hooks');
    // hooks.json points at the private permission secret file; keep the whole session plugin dir
    // owner-only so other local users cannot read paths/settings or race the secret file.
    mkdirPrivateSync(pluginDir);
    mkdirPrivateSync(manifestDir);
    mkdirPrivateSync(hooksDir);

    const manifest = {
        name: `happier-session-hooks-${pluginIdentity.id}`,
        version: '1.0.0',
        description: 'Happier session-scoped Claude Code hooks.',
        author: {
            name: 'Happier',
        },
    };
    writePrivateFileSync(join(manifestDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
    writePrivateFileSync(join(pluginDir, RETAINED_HOOK_PLUGIN_MARKER_FILE), JSON.stringify({
        v: 1,
        retainAcrossRunnerRestarts: pluginIdentity.retainAcrossRunnerRestarts,
    }, null, 2));

    const nodeExecutable = resolveNodeExecutable();
    // The secret never rides on the command line (argv is world-visible via `ps`); it is written
    // to an owner-only file inside the 0700 plugin dir and forwarders read it via
    // `--secret-file <path>`. Shared by the session AND permission forwarders (A5-MED-2: the
    // session-start endpoint requires the same secret as the permission endpoint).
    if (typeof options.permissionHookSecret === 'string' && options.permissionHookSecret.length > 0) {
        const secretFile = join(pluginDir, 'permission-hook-secret');
        writePrivateFileSync(secretFile, options.permissionHookSecret);
    } else {
        const staleSecretFile = join(pluginDir, 'permission-hook-secret');
        if (existsSync(staleSecretFile)) {
            unlinkSync(staleSecretFile);
        }
    }
    writeHookPluginConfiguration({
        pluginDir,
        port,
        nodeExecutable,
        enableLocalPermissionBridge: options.enableLocalPermissionBridge === true,
        ...(options.permissionHookTimeoutSeconds === undefined
            ? {}
            : { permissionHookTimeoutSeconds: options.permissionHookTimeoutSeconds }),
        platform: options.platform ?? process.platform,
    });
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
        // The unified spawn writes merged --settings overlays (which may embed the hook secret)
        // to a 0600 sibling of this file; it rides the same cleanup lifecycle.
        const overlayPath = filepath.replace(/\.json$/, '.overlay.json');
        if (overlayPath !== filepath && existsSync(overlayPath)) {
            unlinkSync(overlayPath);
            logger.debug(`[generateHookSettings] Cleaned up settings overlay file: ${overlayPath}`);
        }
        const statuslineSecretPath = filepath.replace(/\.json$/, '.statusline-secret');
        if (statuslineSecretPath !== filepath && existsSync(statuslineSecretPath)) {
            unlinkSync(statuslineSecretPath);
            logger.debug(`[generateHookSettings] Cleaned up statusline secret file: ${statuslineSecretPath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup settings file: ${error}`);
    }
}

/**
 * Remove the plugin directory produced by `generateHookPluginDir`.
 */
export function cleanupHookPluginDir(
    dirpath: string | null | undefined,
    options: Readonly<{ force?: boolean }> = {},
): void {
    if (typeof dirpath !== 'string' || dirpath.length === 0) return;
    try {
        if (options.force !== true && shouldRetainHookPluginDir(dirpath)) {
            logger.debug(`[generateHookSettings] Retaining session-scoped hook plugin dir: ${dirpath}`);
            return;
        }
        if (existsSync(dirpath)) {
            rmSync(dirpath, { recursive: true, force: true });
            logger.debug(`[generateHookSettings] Cleaned up hook plugin dir: ${dirpath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook plugin dir: ${error}`);
    }
}
