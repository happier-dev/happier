import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    decryptSecretValueV1,
    encryptSecretStringV1,
    SecretStringV1Schema,
    type SecretStringV1,
} from '@happier-dev/protocol';
import type { PluginSecretListEntryV1, PluginSecretsServiceV1 } from '@happier-dev/plugin-sdk';

import type { PluginStorePaths } from '@/plugins/store/paths';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { PluginContextServiceError } from './errors';
import { normalizePluginStorageNamespace } from './pluginNamespace';

type SecretsFileV1 = Readonly<{
    t: 'happier_plugin_secrets_v1';
    secrets: Record<string, SecretStringV1>;
}>;

export type CreatePluginSecretsServiceParams = Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    secretKey?: Uint8Array | null;
    randomBytes?: (length: number) => Uint8Array;
}>;

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
}>): Promise<Uint8Array> {
    const path = keyFilePath(params.paths);
    try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed) || parsed.t !== 'happier_plugin_secret_key_v1' || typeof parsed.key !== 'string') {
            throw new PluginContextServiceError('PLUGIN_SECRETS_KEY_INVALID', 'Invalid plugin secrets key file');
        }
        return new Uint8Array(Buffer.from(parsed.key, 'base64'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
            throw error;
        }
        const key = params.randomBytes(32);
        await writeJsonAtomic(path, {
            t: 'happier_plugin_secret_key_v1',
            key: Buffer.from(key).toString('base64'),
        });
        await chmod(path, 0o600).catch(() => undefined);
        return key;
    }
}

function createSecretsFile(secrets: Record<string, SecretStringV1> = {}): SecretsFileV1 {
    return Object.freeze({
        t: 'happier_plugin_secrets_v1',
        secrets: Object.freeze({ ...secrets }),
    });
}

function parseSecretsFile(value: unknown): SecretsFileV1 {
    if (!isRecord(value) || value.t !== 'happier_plugin_secrets_v1' || !isRecord(value.secrets)) {
        throw new PluginContextServiceError('PLUGIN_SECRETS_FILE_INVALID', 'Invalid plugin secrets file');
    }
    const secrets: Record<string, SecretStringV1> = {};
    for (const [name, rawSecret] of Object.entries(value.secrets)) {
        const parsed = SecretStringV1Schema.safeParse(rawSecret);
        if (parsed.success) {
            secrets[name] = parsed.data;
        }
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

export function createPluginSecretsService(params: CreatePluginSecretsServiceParams): PluginSecretsServiceV1 {
    const randomBytes = params.randomBytes ?? nodeRandomBytesUint8;
    const pluginNamespace = normalizePluginStorageNamespace(params.pluginId);
    const filePath = join(params.paths.secretsDir, pluginNamespace, 'secrets.v1.json');
    let localKeyPromise: Promise<Uint8Array> | null = null;

    async function getSecretKey(): Promise<Uint8Array> {
        if (params.secretKey) {
            return params.secretKey;
        }
        localKeyPromise ??= readOrCreateLocalSecretsKey({ paths: params.paths, randomBytes });
        return await localKeyPromise;
    }

    async function readSecrets(): Promise<Record<string, SecretStringV1>> {
        try {
            const raw = await readFile(filePath, 'utf8');
            return { ...parseSecretsFile(JSON.parse(raw) as unknown).secrets };
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                return {};
            }
            throw error;
        }
    }

    async function writeSecrets(secrets: Record<string, SecretStringV1>): Promise<void> {
        await writeJsonAtomic(filePath, createSecretsFile(secrets));
    }

    return Object.freeze({
        async get(name: string): Promise<string | null> {
            const normalizedName = assertValidSecretName(name);
            const secrets = await readSecrets();
            return decryptSecretValueV1(secrets[normalizedName], await getSecretKey());
        },
        async set(name: string, value: string): Promise<void> {
            const normalizedName = assertValidSecretName(name);
            const secrets = await readSecrets();
            secrets[normalizedName] = {
                _isSecretValue: true,
                encryptedValue: encryptSecretStringV1(value, await getSecretKey(), randomBytes),
            };
            await writeSecrets(secrets);
        },
        async delete(name: string): Promise<void> {
            const normalizedName = assertValidSecretName(name);
            const secrets = await readSecrets();
            delete secrets[normalizedName];
            await writeSecrets(secrets);
        },
        async list(): Promise<readonly PluginSecretListEntryV1[]> {
            return Object.freeze(Object.keys(await readSecrets()).sort().map((name) => Object.freeze({ name })));
        },
    });
}
