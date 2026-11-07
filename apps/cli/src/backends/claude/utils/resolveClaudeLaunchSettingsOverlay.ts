import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS, readClaudeCleanupPeriodDays } from '../settings/claudeSessionRetentionSettings';
import { resolveConfiguredClaudeConfigDir } from './resolveConfiguredClaudeConfigDir';

export const CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_KEY = 'HAPPIER_CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT';
export const CLAUDE_NATIVE_CONFIG_DIR_ENV_KEY = 'HAPPIER_CLAUDE_NATIVE_CONFIG_DIR';

function readHomeCleanupPeriodDays(home: string): Readonly<{ days: number | undefined }> | null {
    try {
        const settings: unknown = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
        const raw = (settings as Record<string, unknown>).cleanupPeriodDays;
        const days = readClaudeCleanupPeriodDays(raw);
        return raw !== undefined && days === undefined ? null : { days };
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { days: undefined } : null;
    }
}

function resolveSharedNativeTranscriptRetention(env: NodeJS.ProcessEnv, proposedDays: number | undefined): number | undefined {
    const nativeHome = env[CLAUDE_NATIVE_CONFIG_DIR_ENV_KEY]?.trim();
    if (!nativeHome) return undefined;
    const activeHome = resolveConfiguredClaudeConfigDir({ env });
    try {
        if (realpathSync(activeHome) === realpathSync(nativeHome)) return undefined;
        if (realpathSync(join(activeHome, 'projects')) !== realpathSync(join(nativeHome, 'projects'))) return undefined;
    } catch {
        // No shared store has been established, so its retention must not be inferred.
        return undefined;
    }
    try {
        if (realpathSync(join(activeHome, 'settings.json')) === realpathSync(join(nativeHome, 'settings.json'))) return undefined;
    } catch { /* A missing settings file is a distinct settings source. */ }
    const native = readHomeCleanupPeriodDays(nativeHome);
    const active = readHomeCleanupPeriodDays(activeHome);
    if (!native || !active) return undefined;
    const nativeDays = native.days;
    const activeDays = proposedDays ?? active.days ?? CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS;
    // An isolated settings home can otherwise apply its shorter policy to the native store.
    // Native's explicit choice is the authority; an unset native key adds no launch policy.
    return nativeDays !== undefined && nativeDays > activeDays ? nativeDays : undefined;
}

function chmodPrivateFileIfSupported(path: string): void {
    if (process.platform === 'win32') return;
    try {
        chmodSync(path, 0o600);
    } catch {
        // Best-effort hardening; write mode still applies on first creation.
    }
}

export function buildClaudePermissionModeLaunchSettings(
    permissionMode: string | undefined,
): Readonly<Record<string, unknown>> {
    // Claude Code treats bypass mode selection and acknowledgement as distinct inputs. Happier's
    // yolo selection is the user's explicit bypass choice, so carry it through Claude's trusted
    // per-launch settings tier. Never put this in project settings (Claude intentionally ignores
    // it there to prevent an untrusted repository from suppressing the safety confirmation).
    return permissionMode === 'bypassPermissions'
        ? { skipDangerousModePermissionPrompt: true }
        : {};
}

/**
 * Resolve Claude's single `--settings` overlay without mutating the generated base settings.
 *
 * Claude keeps only the first `--settings` value. When launch-only settings are needed, merge
 * them into a private sibling file so every launch path presents one authoritative overlay.
 * Keys listed in `unsafeInlineKeys` are omitted from the argv fallback if the sibling cannot be
 * written (the unified-terminal statusline command contains a path to a private secret file).
 */
export function resolveClaudeLaunchSettingsOverlayArg(params: Readonly<{
    settingsPath: string | undefined;
    cwd?: string;
    /** Existing launch arguments; settings entries are consumed into the single returned overlay. */
    args?: string[];
    launchSettings: Readonly<Record<string, unknown>>;
    unsafeInlineKeys?: readonly string[] | undefined;
    env: NodeJS.ProcessEnv;
}>): string | undefined {
    const env = params.env;
    const hasPool = (['claude-subscription', 'anthropic'] as const).some((serviceId) =>
        findConnectedServiceChildSelection(env, serviceId)?.kind === 'group');
    const launchSettings = {
        ...params.launchSettings,
        ...(hasPool ? { autoContinueAtUsageLimit: env[CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_KEY] === '1' } : {}),
    };
    let userSettingsValue: string | undefined;
    const args = params.args;
    if (args) {
        for (let index = 0; index < args.length;) {
            const arg = args[index];
            if (arg === '--settings') {
                userSettingsValue ??= args[index + 1];
                args.splice(index, typeof args[index + 1] === 'string' ? 2 : 1);
            } else if (arg.startsWith('--settings=')) {
                userSettingsValue ??= arg.slice('--settings='.length);
                args.splice(index, 1);
            } else index++;
        }
    }

    const settingsPath = params.settingsPath ? resolve(params.cwd ?? '.', params.settingsPath) : undefined;
    let base: Record<string, unknown> = {};
    if (settingsPath) {
        try {
            const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                base = { ...base, ...parsed as Record<string, unknown> };
            }
        } catch {
            // Unreadable base settings: fall through to the launch-only overlay. Passing the
            // broken file path would lose the launch settings and the base settings alike.
        }
    }

    if (userSettingsValue !== undefined) {
        try {
            let parsed: unknown;
            try { parsed = JSON.parse(userSettingsValue); }
            catch { parsed = JSON.parse(readFileSync(resolve(params.cwd ?? '.', userSettingsValue), 'utf8')); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            const user = parsed as Record<string, unknown>;
            const generatedPermissions = base.permissions;
            const userPermissions = user.permissions;
            base = { ...base, ...user };
            if (generatedPermissions && typeof generatedPermissions === 'object' && !Array.isArray(generatedPermissions)
                && userPermissions && typeof userPermissions === 'object' && !Array.isArray(userPermissions)) {
                const generated = generatedPermissions as Record<string, unknown>;
                const explicit = userPermissions as Record<string, unknown>;
                base.permissions = {
                    ...generated, ...explicit,
                    ...(Array.isArray(generated.allow) && Array.isArray(explicit.allow)
                        ? { allow: [...new Set([...generated.allow, ...explicit.allow])] } : {}),
                };
            }
        } catch {
            throw new Error('Unable to read Claude launch settings');
        }
    }

    const merged: Record<string, unknown> = {
        ...base,
        ...launchSettings,
    };

    const sharedNativeRetention = resolveSharedNativeTranscriptRetention(env, readClaudeCleanupPeriodDays(merged.cleanupPeriodDays));
    if (sharedNativeRetention !== undefined) merged.cleanupPeriodDays = sharedNativeRetention;
    if (!settingsPath && Object.keys(launchSettings).length === 0 && sharedNativeRetention === undefined) return userSettingsValue;
    if (Object.keys(launchSettings).length === 0 && userSettingsValue === undefined && sharedNativeRetention === undefined) return params.settingsPath;

    if (settingsPath) {
        const overlayPath = settingsPath.replace(/\.json$/, '.overlay.json');
        try {
            writeFileSync(overlayPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
            chmodPrivateFileIfSupported(overlayPath);
            return overlayPath;
        } catch {
            // The non-secret launch settings remain safe to pass as inline JSON.
        }
    }

    const inlineSettings = { ...merged };
    for (const key of params.unsafeInlineKeys ?? []) {
        delete inlineSettings[key];
    }
    return JSON.stringify(inlineSettings);
}
