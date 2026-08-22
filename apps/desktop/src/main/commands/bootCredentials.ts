import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Port of `apps/ui/src-tauri/src/desktop_boot_credentials.rs`.
 *
 * When the desktop app is launched by a Happier stack, the stack exports its CLI home through the
 * environment and the host hands the already-issued access key to the renderer so the user is not
 * asked to sign in again. Outside a stack launch there is nothing to read and the command answers
 * `null`, which is exactly what the Tauri implementation does.
 */

export type DesktopBootEncryption = Readonly<{
    publicKey: string;
    machineKey: string;
}>;

export type DesktopBootCredentials = Readonly<{
    token: string;
    encryption: DesktopBootEncryption | null;
}>;

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

export function parseBootCredentials(raw: string): DesktopBootCredentials | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const record = parsed as Record<string, unknown>;
    const token = typeof record.token === 'string' ? record.token : '';
    if (token.trim().length === 0) return null;

    const encryption = record.encryption;
    if (encryption === undefined || encryption === null) {
        return { token, encryption: null };
    }
    if (typeof encryption !== 'object') return null;

    const encryptionRecord = encryption as Record<string, unknown>;
    const publicKey = typeof encryptionRecord.publicKey === 'string' ? encryptionRecord.publicKey : '';
    const machineKey = typeof encryptionRecord.machineKey === 'string' ? encryptionRecord.machineKey : '';
    if (publicKey.trim().length === 0 || machineKey.trim().length === 0) return null;

    return { token, encryption: { publicKey, machineKey } };
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

export function buildCandidatePaths(cliHome: string, activeServerId: string | null): string[] {
    const paths: string[] = [];
    const trimmed = activeServerId?.trim() ?? '';
    if (trimmed) {
        paths.push(join(cliHome, 'servers', trimmed, 'access.key'));
    }
    paths.push(join(cliHome, 'access.key'));
    return paths;
}

export async function readStackBootCredentials(
    readEnv: EnvironmentReader = (key) => process.env[key],
): Promise<DesktopBootCredentials | null> {
    if (!hasStackContext(readEnv)) return null;

    const cliHome = resolveCliHome(readEnv);
    if (cliHome === null) return null;

    const activeServerId =
        readNonEmptyEnv(readEnv, 'HAPPIER_ACTIVE_SERVER_ID')
        ?? (await readSettingsActiveServerId(cliHome));

    for (const candidate of buildCandidatePaths(cliHome, activeServerId)) {
        try {
            const credentials = parseBootCredentials(await readFile(candidate, 'utf8'));
            if (credentials !== null) return credentials;
        } catch {
            // A missing or unreadable candidate simply means the next one is tried.
        }
    }

    return null;
}
