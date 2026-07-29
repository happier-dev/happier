import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmod, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    decryptSecretValueV1,
    encryptSecretStringV1,
    SecretStringV1Schema,
    type SecretStringV1,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { type PluginSecretsService } from '@happier-dev/plugin-sdk/runtime';

import type { PluginStorePaths } from '@/plugins/store/paths';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { PluginContextServiceError } from './errors';
import { normalizePluginStorageNamespace } from './pluginNamespace';
import { preparePluginOwnedDataDirectoryRemoval } from './pluginOwnedDataDirectory';
import { setOwnRecordValue } from './recordOwnProperties';

type PersistedPluginSecretV1 = Readonly<{
    _isSecretValue: true;
    encryptedValue: NonNullable<SecretStringV1['encryptedValue']>;
}>;

type SecretsFileV1 = Readonly<{
    t: 'happier_plugin_secrets_v1';
    secrets: Record<string, PersistedPluginSecretV1>;
}>;

const SECRETS_FILE_LOCK_TIMEOUT_MS = 5_000;
const SECRETS_FILE_LOCK_STALE_AFTER_MS = 30_000;

export type PluginSecretsOwnerParams = Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    secretKey?: Uint8Array | null;
    randomBytes?: (length: number) => Uint8Array;
    enforceLocalKeyFileProtection?: boolean;
}>;

export type StablePluginSecretAccess = 'read' | 'write' | 'delete';

export type StablePluginSecretAccessCheck = Readonly<{
    pluginId: string;
    secretId: string;
    access: 'status' | StablePluginSecretAccess;
    signal?: AbortSignal;
}>;

export type CreateStablePluginSecretsServiceParams = PluginSecretsOwnerParams & Readonly<{
    declaredScopes: readonly Readonly<{
        secretIds: readonly string[];
        access: readonly StablePluginSecretAccess[];
    }>[];
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
    /** Re-evaluates the canonical package/generation/resource decision at each terminal operation. */
    authorize(check: StablePluginSecretAccessCheck): boolean | Promise<boolean>;
    registerForRedaction(value: string): void;
}>;

export async function preparePluginSecretsDataRemoval(params: Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    removeDirectory?: (directoryPath: string) => Promise<void>;
}>): Promise<Readonly<{
    hadSecrets: boolean;
    remove: () => Promise<void>;
}>> {
    const prepared = await preparePluginOwnedDataDirectoryRemoval({
        pluginId: params.pluginId,
        rootDir: params.paths.secretsDir,
        errorCode: 'PLUGIN_SECRETS_DATA_PATH_INVALID',
        ...(params.removeDirectory ? { removeDirectory: params.removeDirectory } : {}),
    });
    return Object.freeze({
        hadSecrets: prepared.existed,
        remove: prepared.remove,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nodeRandomBytesUint8(length: number): Uint8Array {
    return new Uint8Array(nodeRandomBytes(length));
}

function keyFilePath(paths: PluginStorePaths): string {
    return join(paths.secretsDir, 'plugin-secrets-key.v1');
}

async function readOrCreateLocalSecretsKey(params: Readonly<{
    paths: PluginStorePaths;
    randomBytes: (length: number) => Uint8Array;
    enforceProtection: boolean;
}>): Promise<Uint8Array> {
    const path = keyFilePath(params.paths);
    return await withJsonOwnerFileLock({
        lockPath: `${path}.lock`,
        timeoutMs: SECRETS_FILE_LOCK_TIMEOUT_MS,
        staleAfterMs: SECRETS_FILE_LOCK_STALE_AFTER_MS,
        errorCode: 'PLUGIN_SECRETS_KEY_LOCK_UNAVAILABLE',
    }, async () => {
        try {
            if (params.enforceProtection) {
                const keyStat = await lstat(path);
                if (!keyStat.isFile() || keyStat.isSymbolicLink()) {
                    throw new PluginContextServiceError('PLUGIN_SECRETS_KEY_INVALID', 'Plugin secrets key must be a regular file');
                }
                if (process.platform !== 'win32' && (keyStat.mode & 0o077) !== 0) {
                    throw new PluginContextServiceError('PLUGIN_SECRETS_KEY_INVALID', 'Plugin secrets key permissions are too broad');
                }
            }
            const raw = await readFile(path, 'utf8');
            const parsed = JSON.parse(raw) as unknown;
            if (!isRecord(parsed) || parsed.t !== 'happier_plugin_secret_key_v1' || typeof parsed.key !== 'string') {
                throw new PluginContextServiceError('PLUGIN_SECRETS_KEY_INVALID', 'Invalid plugin secrets key file');
            }
            const key = new Uint8Array(Buffer.from(parsed.key, 'base64'));
            if (key.byteLength !== 32) {
                throw new PluginContextServiceError('PLUGIN_SECRETS_KEY_INVALID', 'Invalid plugin secrets key length');
            }
            return key;
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
                throw error;
            }
            const key = params.randomBytes(32);
            await writeJsonAtomic(path, {
                t: 'happier_plugin_secret_key_v1',
                key: Buffer.from(key).toString('base64'),
            });
            if (params.enforceProtection) {
                await chmod(path, 0o600);
            } else {
                await chmod(path, 0o600).catch(() => undefined);
            }
            return key;
        }
    });
}

function createSecretsFile(secrets: Record<string, PersistedPluginSecretV1> = {}): SecretsFileV1 {
    return Object.freeze({
        t: 'happier_plugin_secrets_v1',
        secrets: Object.freeze({ ...secrets }),
    });
}

function parseSecretsFile(value: unknown, pluginId: string): SecretsFileV1 {
    if (!isRecord(value) || value.t !== 'happier_plugin_secrets_v1' || !isRecord(value.secrets)) {
        throw new PluginContextServiceError(
            'PLUGIN_SECRETS_FILE_INVALID',
            `Invalid plugin secrets file for '${pluginId}'`,
        );
    }
    const secrets: Record<string, PersistedPluginSecretV1> = {};
    for (const [name, rawSecret] of Object.entries(value.secrets)) {
        const parsed = SecretStringV1Schema.safeParse(rawSecret);
        if (!parsed.success || parsed.data.value !== undefined || parsed.data.encryptedValue === undefined) {
            throw new PluginContextServiceError(
                'PLUGIN_SECRETS_FILE_INVALID',
                `Invalid plugin secret entry '${pluginId}/${name}'`,
            );
        }
        setOwnRecordValue(secrets, name, Object.freeze({
            _isSecretValue: true,
            encryptedValue: parsed.data.encryptedValue,
        }));
    }
    return createSecretsFile(secrets);
}

function assertValidSecretName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
        throw new PluginContextServiceError('PLUGIN_SECRETS_INVALID_NAME', 'Plugin secret names must be non-empty path segments');
    }
    return trimmed;
}

type PluginSecretsMutation<T> = (
    secrets: Record<string, PersistedPluginSecretV1>,
) => Promise<Readonly<{ write: boolean; result: T }>> | Readonly<{ write: boolean; result: T }>;

type PluginSecretsEncryptedOwner = Readonly<{
    read(): Promise<Record<string, PersistedPluginSecretV1>>;
    decrypt(secret: PersistedPluginSecretV1): Promise<string>;
    encrypt(value: string): Promise<PersistedPluginSecretV1>;
    mutate<T>(operation: PluginSecretsMutation<T>): Promise<T>;
}>;

function createPluginSecretsEncryptedOwner(params: PluginSecretsOwnerParams): PluginSecretsEncryptedOwner {
    const randomBytes = params.randomBytes ?? nodeRandomBytesUint8;
    const pluginNamespace = normalizePluginStorageNamespace(params.pluginId);
    const filePath = join(params.paths.secretsDir, pluginNamespace, 'secrets.v1.json');
    let localKeyPromise: Promise<Uint8Array> | null = null;

    async function getSecretKey(): Promise<Uint8Array> {
        if (params.secretKey) {
            return params.secretKey;
        }
        localKeyPromise ??= readOrCreateLocalSecretsKey({
            paths: params.paths,
            randomBytes,
            enforceProtection: params.enforceLocalKeyFileProtection === true,
        });
        return await localKeyPromise;
    }

    async function readSecrets(): Promise<Record<string, PersistedPluginSecretV1>> {
        try {
            const raw = await readFile(filePath, 'utf8');
            return { ...parseSecretsFile(JSON.parse(raw) as unknown, params.pluginId).secrets };
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                return {};
            }
            throw error;
        }
    }

    async function writeSecrets(secrets: Record<string, PersistedPluginSecretV1>): Promise<void> {
        await writeJsonAtomic(filePath, createSecretsFile(secrets));
    }

    async function mutate<T>(
        operation: PluginSecretsMutation<T>,
    ): Promise<T> {
        return await withJsonOwnerFileLock({
            lockPath: `${filePath}.lock`,
            timeoutMs: SECRETS_FILE_LOCK_TIMEOUT_MS,
            staleAfterMs: SECRETS_FILE_LOCK_STALE_AFTER_MS,
            errorCode: 'PLUGIN_SECRETS_LOCK_UNAVAILABLE',
        }, async () => {
            const secrets = await readSecrets();
            const outcome = await operation(secrets);
            if (outcome.write) await writeSecrets(secrets);
            return outcome.result;
        });
    }

    return Object.freeze({
        read: readSecrets,
        async decrypt(secret): Promise<string> {
            const value = decryptSecretValueV1(secret, await getSecretKey());
            if (value === null) {
                throw new PluginContextServiceError(
                    'PLUGIN_SECRETS_FILE_INVALID',
                    `Invalid plugin secret entry for '${params.pluginId}'`,
                );
            }
            return value;
        },
        async encrypt(value): Promise<PersistedPluginSecretV1> {
            return Object.freeze({
                _isSecretValue: true,
                encryptedValue: encryptSecretStringV1(value, await getSecretKey(), randomBytes),
            });
        },
        mutate,
    });
}

function readSecret(
    secrets: Record<string, PersistedPluginSecretV1>,
    name: string,
): PersistedPluginSecretV1 | null {
    return Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name]! : null;
}

export interface PluginSecretStore {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
    list(): Promise<readonly Readonly<{ name: string }>[]>;
}

export function createPluginSecretStore(params: PluginSecretsOwnerParams): PluginSecretStore {
    const owner = createPluginSecretsEncryptedOwner(params);

    return Object.freeze({
        async get(name: string): Promise<string | null> {
            const normalizedName = assertValidSecretName(name);
            const secret = readSecret(await owner.read(), normalizedName);
            return secret ? await owner.decrypt(secret) : null;
        },
        async set(name: string, value: string): Promise<void> {
            const normalizedName = assertValidSecretName(name);
            const encryptedSecret = await owner.encrypt(value);
            await owner.mutate((secrets) => {
                setOwnRecordValue(secrets, normalizedName, encryptedSecret);
                return { write: true, result: undefined };
            });
        },
        async delete(name: string): Promise<void> {
            const normalizedName = assertValidSecretName(name);
            await owner.mutate((secrets) => {
                delete secrets[normalizedName];
                return { write: true, result: undefined };
            });
        },
        async list(): Promise<readonly Readonly<{ name: string }>[]> {
            return Object.freeze(Object.keys(await owner.read()).sort().map((name) => Object.freeze({ name })));
        },
    });
}

function stableSecretError(code: string, message: string, details?: JsonValue): PluginError {
    return new PluginError({ code, message, ...(details === undefined ? {} : { details }) });
}

function revisionForSecret(secret: PersistedPluginSecretV1 | null): string {
    const hash = createHash('sha256');
    hash.update(secret === null ? 'missing' : JSON.stringify(secret));
    return `secret-r1:${hash.digest('hex')}`;
}

const DENIED_SECRET_REVISION = `secret-r1:${createHash('sha256').update('denied').digest('hex')}`;

export function createStablePluginSecretsService(
    params: CreateStablePluginSecretsServiceParams,
): PluginSecretsService {
    const owner = createPluginSecretsEncryptedOwner(params);
    const declaredScopes = params.declaredScopes.map((scope) => Object.freeze({
        secretIds: new Set(scope.secretIds.map(assertValidSecretName)),
        access: new Set(scope.access),
    }));

    function assertCurrent(signal?: AbortSignal): void {
        if (signal?.aborted || params.signal.aborted || !params.isGenerationCurrent()) {
            throw stableSecretError('plugin_generation_stale', 'Plugin secrets invocation generation is stale');
        }
    }

    function assertDeclared(id: string, access: 'status' | StablePluginSecretAccess): string {
        const normalizedId = assertValidSecretName(id);
        const declared = declaredScopes.some((scope) => (
            scope.secretIds.has(normalizedId)
            && (access === 'status' || scope.access.has(access))
        ));
        if (!declared) {
            throw stableSecretError(
                'plugin_secret_undeclared',
                `Plugin secret '${normalizedId}' is not declared for '${access}' access`,
            );
        }
        return normalizedId;
    }

    async function isAuthorized(
        secretId: string,
        access: 'status' | StablePluginSecretAccess,
        signal?: AbortSignal,
    ): Promise<boolean> {
        assertCurrent(signal);
        const authorized = await params.authorize(Object.freeze({
            pluginId: params.pluginId,
            secretId,
            access,
            ...(signal ? { signal } : {}),
        }));
        assertCurrent(signal);
        return authorized;
    }

    async function assertAuthorized(
        secretId: string,
        access: StablePluginSecretAccess,
        signal?: AbortSignal,
    ): Promise<void> {
        if (!await isAuthorized(secretId, access, signal)) {
            throw stableSecretError(
                'plugin_secret_access_denied',
                `Plugin secret '${secretId}' is not authorized for '${access}' access`,
            );
        }
    }

    function assertExpectedRevision(
        secret: PersistedPluginSecretV1 | null,
        expectedRevision?: string,
    ): string {
        const revision = revisionForSecret(secret);
        if (expectedRevision !== undefined && expectedRevision !== revision) {
            throw stableSecretError(
                'plugin_secret_revision_conflict',
                'Plugin secret revision does not match the expected revision',
                { currentRevision: revision },
            );
        }
        return revision;
    }

    return Object.freeze({
        async status(id: string) {
            assertCurrent();
            const secretId = assertDeclared(id, 'status');
            const secret = readSecret(await owner.read(), secretId);
            if (!await isAuthorized(secretId, 'status')) {
                return Object.freeze({ state: 'denied' as const, revision: DENIED_SECRET_REVISION });
            }
            return Object.freeze({
                state: secret ? 'configured' as const : 'missing' as const,
                revision: revisionForSecret(secret),
            });
        },
        async get(id: string, options?: { reason?: string; signal?: AbortSignal }) {
            assertCurrent(options?.signal);
            const secretId = assertDeclared(id, 'read');
            const secret = readSecret(await owner.read(), secretId);
            await assertAuthorized(secretId, 'read', options?.signal);
            if (!secret) {
                throw stableSecretError('plugin_secret_missing', `Plugin secret '${secretId}' is not configured`);
            }
            const value = await owner.decrypt(secret);
            params.registerForRedaction(value);
            assertCurrent(options?.signal);
            return value;
        },
        async set(id: string, value: string, options?: { expectedRevision?: string; signal?: AbortSignal }) {
            assertCurrent(options?.signal);
            const secretId = assertDeclared(id, 'write');
            return await owner.mutate(async (secrets) => {
                await assertAuthorized(secretId, 'write', options?.signal);
                const current = readSecret(secrets, secretId);
                assertExpectedRevision(current, options?.expectedRevision);
                const encrypted = await owner.encrypt(value);
                assertCurrent(options?.signal);
                setOwnRecordValue(secrets, secretId, encrypted);
                return Object.freeze({
                    write: true,
                    result: Object.freeze({ revision: revisionForSecret(encrypted) }),
                });
            });
        },
        async delete(id: string, options?: { expectedRevision?: string; signal?: AbortSignal }) {
            assertCurrent(options?.signal);
            const secretId = assertDeclared(id, 'delete');
            return await owner.mutate(async (secrets) => {
                await assertAuthorized(secretId, 'delete', options?.signal);
                const current = readSecret(secrets, secretId);
                assertExpectedRevision(current, options?.expectedRevision);
                delete secrets[secretId];
                assertCurrent(options?.signal);
                return Object.freeze({
                    write: current !== null,
                    result: Object.freeze({ revision: revisionForSecret(null) }),
                });
            });
        },
    });
}
