import { deleteLightPublicFile, ensureLightFilesDir, getLightPublicUrl, readLightPublicFile, resolveLightPublicFilesDir, writeLightPublicFile } from '@/flavors/light/files';
import { createLocalPrivateFilesBackendFromEnv, resolveLocalPrivateFilesDir } from '@/storage/privateFiles/privateFilesLocal';
import { normalizePrivateFileKey } from '@/storage/privateFiles/privateFileKeys';
import type { PrivateFilesBackend } from '@/storage/privateFiles/privateFiles';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}

export type PublicFilesBackend = {
    init(): Promise<void>;
    getPublicUrl(path: string): string;
    writePublicFile(path: string, data: Uint8Array): Promise<void>;
    readPublicFile?(path: string): Promise<Uint8Array>;
    deletePublicFile(path: string): Promise<void>;
}

let backend: PublicFilesBackend | null = null;
let privateBackend: PrivateFilesBackend | null = null;

export class PrivateStorageUnavailableError extends Error {
    readonly code = 'private_storage_unavailable';
    constructor() { super('Private file storage is unavailable'); }
}

/** Reject public grants, including wildcard actions. Never change operator-owned bucket policy. */
function hasAnonymousGrant(policy: string): boolean {
    const parsed: unknown = JSON.parse(policy);
    if (!parsed || typeof parsed !== 'object' || !('Statement' in parsed)) return true;
    const statements = Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement];
    return statements.some((statement: unknown) => {
        if (!statement || typeof statement !== 'object') return true;
        if (!('Effect' in statement) || statement.Effect !== 'Allow') return false;
        if (!('Principal' in statement)) return true;
        const principal = statement.Principal;
        return principal === '*' || Boolean(principal && typeof principal === 'object' && 'AWS' in principal
            && (principal.AWS === '*' || (Array.isArray(principal.AWS) && principal.AWS.includes('*'))));
    });
}

export async function initFilesS3FromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const s3Host = requiredEnv(env, 'S3_HOST');
    const s3PortRaw = env.S3_PORT?.trim();
    let s3Port: number | undefined;
    if (s3PortRaw) {
        const parsed = parseInt(s3PortRaw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
            throw new Error(`Invalid S3_PORT: ${s3PortRaw}`);
        }
        s3Port = parsed;
    }
    const s3UseSSL = env.S3_USE_SSL ? env.S3_USE_SSL === 'true' : true;

    const s3bucket = requiredEnv(env, 'S3_BUCKET');
    const privateBucket = env.S3_PRIVATE_BUCKET?.trim();
    if (privateBucket === s3bucket) throw new Error('S3_PRIVATE_BUCKET must differ from the public bucket');
    const s3public = requiredEnv(env, 'S3_PUBLIC_URL');
    const s3Region = env.S3_REGION?.trim() ? env.S3_REGION.trim() : 'us-east-1';

    const Minio = await import('minio');
    const s3client = new Minio.Client({
        endPoint: s3Host,
        port: s3Port,
        useSSL: s3UseSSL,
        region: s3Region,
        accessKey: requiredEnv(env, 'S3_ACCESS_KEY'),
        secretKey: requiredEnv(env, 'S3_SECRET_KEY'),
    });

    backend = {
        async init() {
            const exists = await s3client.bucketExists(s3bucket);
            if (!exists) {
                throw new Error(`S3 bucket does not exist: ${s3bucket}`);
            }
        },
        getPublicUrl(path: string) {
            return `${s3public}/${path}`;
        },
        async writePublicFile(path: string, data: Uint8Array) {
            await s3client.putObject(s3bucket, path, Buffer.from(data));
        },
        async deletePublicFile(path: string) { await s3client.removeObject(s3bucket, path); },
    };
    privateBackend = null;
    if (privateBucket) {
        let available = false;
        privateBackend = {
            async init() {
                available = false;
                try {
                    if (!await s3client.bucketExists(privateBucket)) return;
                    const policy = await s3client.getBucketPolicy(privateBucket);
                    available = !hasAnonymousGrant(policy);
                } catch (error: unknown) {
                    // MinIO/S3 reports the absence of any bucket policy explicitly.
                    available = Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'NoSuchBucketPolicy');
                }
            },
            async writePrivateFile(key, data) {
                if (!available) throw new PrivateStorageUnavailableError();
                await s3client.putObject(privateBucket, normalizePrivateFileKey(key), Buffer.from(data));
            },
            async readPrivateFile(key) {
                if (!available) throw new PrivateStorageUnavailableError();
                const stream = await s3client.getObject(privateBucket, normalizePrivateFileKey(key));
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                return new Uint8Array(Buffer.concat(chunks));
            },
            async deletePrivateFile(key) {
                if (!available) throw new PrivateStorageUnavailableError();
                await s3client.removeObject(privateBucket, normalizePrivateFileKey(key));
            },
        };
    }
}

export function initFilesLocalFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const localPrivate = createLocalPrivateFilesBackendFromEnv(env);
    let available = false;
    privateBackend = {
        async init() {
            available = false;
            try {
                await localPrivate.init();
                const publicRoot = await realpath(resolveLightPublicFilesDir(env));
                const privateRoot = await realpath(resolveLocalPrivateFilesDir(env));
                const contains = (parent: string, child: string) => {
                    const path = relative(parent, child);
                    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
                };
                available = !contains(publicRoot, privateRoot) && !contains(privateRoot, publicRoot);
            } catch { available = false; }
        },
        async writePrivateFile(key, data) {
            if (!available) throw new PrivateStorageUnavailableError();
            await localPrivate.writePrivateFile(key, data);
        },
        async readPrivateFile(key) {
            if (!available) throw new PrivateStorageUnavailableError();
            return localPrivate.readPrivateFile(key);
        },
        async deletePrivateFile(key) {
            if (!available || !localPrivate.deletePrivateFile) throw new PrivateStorageUnavailableError();
            await localPrivate.deletePrivateFile(key);
        },
    };
    backend = {
        async init() {
            await ensureLightFilesDir(env);
        },
        getPublicUrl(path: string) {
            return getLightPublicUrl(env, path);
        },
        async writePublicFile(path: string, data: Uint8Array) {
            await writeLightPublicFile(env, path, data);
        },
        async readPublicFile(path: string) {
            return await readLightPublicFile(env, path);
        },
        async deletePublicFile(path: string) { await deleteLightPublicFile(env, path); },
    };
}

export function hasPublicFileRead(): boolean {
    return Boolean(backend && backend.readPublicFile);
}

export async function loadFiles(): Promise<void> {
    if (!backend) {
        throw new Error('Files backend not initialized');
    }
    await backend.init();
    await privateBackend?.init();
}

export function getPublicUrl(path: string): string {
    if (!backend) {
        throw new Error('Files backend not initialized');
    }
    return backend.getPublicUrl(path);
}

export async function writePublicFile(path: string, data: Uint8Array): Promise<void> {
    if (!backend) {
        throw new Error('Files backend not initialized');
    }
    await backend.writePublicFile(path, data);
}

export async function readPublicFile(path: string): Promise<Uint8Array> {
    if (!backend?.readPublicFile) {
        throw new Error('Public file read is not supported');
    }
    return await backend.readPublicFile(path);
}
export async function deletePublicFile(path: string): Promise<void> {
    if (!backend) throw new Error('Files backend not initialized');
    await backend.deletePublicFile(path);
}

export async function writePrivateFile(key: string, data: Uint8Array): Promise<void> {
    if (!privateBackend) throw new PrivateStorageUnavailableError();
    await privateBackend.writePrivateFile(key, data);
}

export async function readPrivateFile(key: string): Promise<Uint8Array> {
    if (!privateBackend) throw new PrivateStorageUnavailableError();
    return await privateBackend.readPrivateFile(key);
}

export async function deletePrivateFile(key: string): Promise<void> {
    if (!privateBackend?.deletePrivateFile) throw new PrivateStorageUnavailableError();
    await privateBackend.deletePrivateFile(key);
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
    const v = env[key]?.trim();
    if (!v) {
        throw new Error(`Missing required env var: ${key}`);
    }
    return v;
}
