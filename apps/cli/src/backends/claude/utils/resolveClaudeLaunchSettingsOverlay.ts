import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

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
    launchSettings: Readonly<Record<string, unknown>>;
    unsafeInlineKeys?: readonly string[] | undefined;
}>): string | undefined {
    if (Object.keys(params.launchSettings).length === 0) return params.settingsPath;

    let base: Record<string, unknown> = {};
    if (params.settingsPath) {
        try {
            const parsed = JSON.parse(readFileSync(params.settingsPath, 'utf8')) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                base = parsed as Record<string, unknown>;
            }
        } catch {
            // Unreadable base settings: fall through to the launch-only overlay. Passing the
            // broken file path would lose the launch settings and the base settings alike.
        }
    }

    const merged: Record<string, unknown> = {
        ...base,
        ...params.launchSettings,
    };

    if (params.settingsPath) {
        const overlayPath = params.settingsPath.replace(/\.json$/, '.overlay.json');
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
