import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { resolveConfiguredNativeHomePath } from '@happier-dev/plugin-sdk/fs';
import { CODEX_NATIVE_HOME } from '../../nativeHome.js';
import { readCodexNativeAuthCredentialsFromJson, type CodexNativeAuthCredentials } from './environment.js';

export class CodexNativeImportError extends Error {
    constructor(readonly code: 'credentials_unavailable' | 'reauthorization_required', message: string) {
        super(message);
        this.name = 'CodexNativeImportError';
    }
}

// Trusted provider authentication deliberately crosses the OS boundary only for explicit
// native-import acquisition on the chosen machine. Ordinary sessions use host-declared nativeHome.
type CodexKeyringReadOptions = Readonly<{
    service: string;
    account: string;
    platform: NodeJS.Platform;
    signal?: AbortSignal;
}>;

function assertImportNotCancelled(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw new DOMException('Credential import cancelled', 'AbortError');
}

function nativeCredentialsUnavailable(): CodexNativeImportError {
    return new CodexNativeImportError('credentials_unavailable', 'Codex native credentials are unavailable');
}

async function readCodexNativeKeyring(options: CodexKeyringReadOptions): Promise<string | null> {
    // Codex rust-v0.160.0 / keyring-rs 3.6.3: direct macOS item or Linux Secret Service.
    const command = options.platform === 'darwin' ? '/usr/bin/security' : 'secret-tool';
    const args = options.platform === 'darwin'
        ? ['find-generic-password', '-s', options.service, '-a', options.account, '-w']
        : ['search', '--all', '--unlock', 'service', options.service, 'username', options.account, 'target', 'default'];
    // Unit tests must inject/mock the OS boundary, never inspect an ambient native login.
    if (process.env.VITEST && !Object.prototype.hasOwnProperty.call(spawn, 'mock')) {
        throw nativeCredentialsUnavailable();
    }
    assertImportNotCancelled(options.signal);
    return await new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let settled = false;
        const settle = (action: () => void) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener('abort', abort);
            action();
        };
        const abort = () => {
            child.kill();
            settle(() => reject(new DOMException('Credential import cancelled', 'AbortError')));
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        child.stdout?.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        child.stderr?.resume(); // Never retain or surface keyring diagnostics containing private data.
        child.once('error', () => settle(() => reject(nativeCredentialsUnavailable())));
        child.once('close', (status) => settle(() => {
            if (options.platform === 'darwin' && status === 44) return resolvePromise(null);
            if (status !== 0) return reject(nativeCredentialsUnavailable());
            const output = Buffer.concat(chunks).toString('utf8').trim();
            if (options.platform === 'darwin') return resolvePromise(output || null);
            if (!output) return resolvePromise(null);
            // search --all preserves keyring-rs's refusal to pick an ambiguous login.
            const entries = output.match(/^\[[^\r\n]+\]$/gm) ?? [];
            const secrets = [...output.matchAll(/^secret = (.+)$/gm)];
            if (entries.length !== 1 || secrets.length !== 1) return reject(nativeCredentialsUnavailable());
            resolvePromise(secrets[0]?.[1] ?? null);
        }));
    });
}

async function readNativeFile(path: string, signal?: AbortSignal): Promise<string | null> {
    try {
        return await readFile(path, { encoding: 'utf8', signal });
    } catch (error) {
        assertImportNotCancelled(signal);
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw nativeCredentialsUnavailable();
    }
}

/** Read-only import of Codex's selected native ChatGPT login; never refreshes or writes. */
export async function readCodexNativeAuthCredentials(options: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    readKeyring?: (options: CodexKeyringReadOptions) => Promise<string | null>;
}> = {}): Promise<CodexNativeAuthCredentials> {
    assertImportNotCancelled(options.signal);
    const home = resolve(resolveConfiguredNativeHomePath(CODEX_NATIVE_HOME, options.env ?? process.env));
    const platform = options.platform ?? process.platform;
    const configText = await readNativeFile(join(home, 'config.toml'), options.signal);
    let config: Record<string, unknown> = {};
    try {
        if (configText !== null) config = parseToml(configText);
    } catch {
        throw nativeCredentialsUnavailable();
    }
    const mode = config.cli_auth_credentials_store ?? 'file';
    if (typeof mode !== 'string' || !['file', 'keyring', 'auto'].includes(mode)) throw nativeCredentialsUnavailable();
    let raw: string | null = null;
    if (mode !== 'file') {
        const features = config.features;
        if (features !== undefined && (!features || typeof features !== 'object' || Array.isArray(features))) {
            throw nativeCredentialsUnavailable();
        }
        const secretStorage = features && typeof features === 'object' && !Array.isArray(features)
            ? (features as Record<string, unknown>).secret_auth_storage : undefined;
        if (secretStorage !== undefined && typeof secretStorage !== 'boolean') throw nativeCredentialsUnavailable();
        const encryptedStorage = secretStorage ?? (platform === 'win32');
        // 0.160 Windows defaults to AGE-encrypted secrets/codex_auth.age, not direct auth JSON.
        // Unsupported encrypted stores cannot borrow a possibly stale file account.
        if (encryptedStorage || (platform !== 'darwin' && platform !== 'linux')) throw nativeCredentialsUnavailable();
        const canonicalHome = await realpath(home).catch(() => home);
        const account = `cli|${createHash('sha256').update(canonicalHome).digest('hex').slice(0, 16)}`;
        try {
            raw = await (options.readKeyring ?? readCodexNativeKeyring)({
                service: 'Codex Auth', account, platform, signal: options.signal,
            });
        } catch {
            assertImportNotCancelled(options.signal);
            // Import fails visibly on denied/unavailable storage rather than guessing another account.
            throw nativeCredentialsUnavailable();
        }
    }
    if (mode === 'file' || (mode === 'auto' && raw === null)) {
        raw = await readNativeFile(join(home, 'auth.json'), options.signal);
    }
    assertImportNotCancelled(options.signal);
    if (raw === null) throw nativeCredentialsUnavailable();
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new CodexNativeImportError('reauthorization_required', 'Sign in to Codex again before importing');
    }
    const credentials = readCodexNativeAuthCredentialsFromJson(parsed);
    if (!credentials) {
        throw new CodexNativeImportError('reauthorization_required', 'Sign in to Codex again before importing');
    }
    return credentials;
}
