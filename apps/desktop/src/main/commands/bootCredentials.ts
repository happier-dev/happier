import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Port of `apps/ui/src-tauri/src/desktop_boot_credentials.rs`.
 *
 * When the desktop app is launched by a Happier stack, the stack exports its CLI home through the
 * environment and the host hands that Home's already-issued access key to the renderer so the user
 * is not asked to sign in again. The host reads exactly `servers/<id>/access.key` for the selected
 * server and passes its JSON through unread: the UI's `parseDesktopBootCredentials` is the only
 * decoder. Outside a stack launch, or without a selected server or readable key, the answer is `null`
 * and the renderer falls back to ordinary sign-in.
 */

export type EnvironmentReader = (key: string) => string | undefined;

function readNonEmptyEnv(readEnv: EnvironmentReader, key: string): string | null {
    const value = readEnv(key)?.trim();
    return value ? value : null;
}

export function hasStackContext(readEnv: EnvironmentReader): boolean {
    return (
        readNonEmptyEnv(readEnv, 'HAPPIER_STACK_STACK') !== null
        || readNonEmptyEnv(readEnv, 'HAPPIER_STACK_CLI_HOME_DIR') !== null
        || readNonEmptyEnv(readEnv, 'HAPPIER_HOME_DIR') !== null
    );
}

function resolveCliHome(readEnv: EnvironmentReader): string | null {
    return (
        readNonEmptyEnv(readEnv, 'HAPPIER_HOME_DIR')
        ?? readNonEmptyEnv(readEnv, 'HAPPIER_STACK_CLI_HOME_DIR')
    );
}

async function readSettingsActiveServerId(cliHome: string): Promise<string | null> {
    try {
        const raw = await readFile(join(cliHome, 'settings.json'), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        const value = (parsed as Record<string, unknown> | null)?.activeServerId;
        const trimmed = typeof value === 'string' ? value.trim() : '';
        return trimmed ? trimmed : null;
    } catch {
        return null;
    }
}

export async function readStackBootCredentials(
    readEnv: EnvironmentReader = (key) => process.env[key],
): Promise<unknown> {
    if (!hasStackContext(readEnv)) return null;

    const cliHome = resolveCliHome(readEnv);
    if (cliHome === null) return null;

    const activeServerId =
        readNonEmptyEnv(readEnv, 'HAPPIER_ACTIVE_SERVER_ID')
        ?? (await readSettingsActiveServerId(cliHome));
    if (activeServerId === null) return null;

    try {
        return JSON.parse(await readFile(join(cliHome, 'servers', activeServerId, 'access.key'), 'utf8'));
    } catch {
        // A missing, unreadable or unparseable key means ordinary sign-in.
        return null;
    }
}
