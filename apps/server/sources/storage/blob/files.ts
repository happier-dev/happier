import type { ClientOptions } from 'minio';
import type { FileStorageCapability, PublicFileStorageUnavailable } from '@happier-dev/protocol/features/payload/capabilities/serverCapabilities';
import { PRIVATE_BINARY_STORAGE_UNAVAILABLE_CODE_V1, type PrivateBinaryStorageUnavailableResponseV1 } from '@happier-dev/protocol/storage/binaryBlobV1';

import { deleteLightPublicFile, ensureLightFilesDir, getLightPublicUrl, readLightPublicFile, resolveLightPublicFilesDir, writeLightPublicFile } from '@/flavors/light/files';
import { createLocalPrivateFilesBackendFromEnv, resolveLocalPrivateFilesDir } from '@/storage/privateFiles/privateFilesLocal';
import { ACCOUNT_PET_DISK_PRIVATE_FILE_PREFIX, ACCOUNT_PET_S3_PRIVATE_FILE_PREFIX, normalizePrivateFileKey } from '@/storage/privateFiles/privateFileKeys';
import type { PrivateFilesBackend } from '@/storage/privateFiles/privateFiles';
import { log } from '@/utils/logging/log';
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
    writePublicFile(path: string, data: Uint8Array): Promise<void>;
    readPublicFile?(path: string): Promise<Uint8Array>;
    deletePublicFile(path: string): Promise<void>;
}

let backend: PublicFilesBackend | PublicStorageUnavailableError | null = null;
let publicUrlForPath: ((path: string) => string) | undefined;
let initializePrivateBackend: (() => Promise<void>) | undefined;
let diskAccountPetFiles: PrivateFilesBackend | undefined;

class PublicStorageUnavailableError extends Error {
    readonly code = 'public_storage_unavailable';
    readonly statusCode = 503;
    readonly reason: PublicFileStorageUnavailable['reason'];
    readonly setting?: InvalidS3Setting;

    constructor(readonly availability: PublicFileStorageUnavailable) {
        super('Public file storage is unavailable');
        this.reason = availability.reason;
        if (availability.reason === 's3_configuration_invalid') this.setting = availability.setting;
    }
}

type InvalidS3Setting = Extract<PublicFileStorageUnavailable, { reason: 's3_configuration_invalid' }>['setting'];

function invalidS3Setting(setting: InvalidS3Setting): PublicStorageUnavailableError {
    return new PublicStorageUnavailableError({ status: 'unavailable', reason: 's3_configuration_invalid', setting });
}

function markPublicStorageUnavailable(error: PublicStorageUnavailableError): void {
    backend = error;
    log({ module: 'files', level: 'warn', ...error.availability }, 'Public S3 storage unavailable');
}

export class PrivateStorageUnavailableError extends Error {
    readonly code = PRIVATE_BINARY_STORAGE_UNAVAILABLE_CODE_V1;
    constructor(readonly reason: PrivateBinaryStorageUnavailableResponseV1['reason']) { super('Private file storage is unavailable'); }
}

type PrivateFileOperations = Omit<PrivateFilesBackend, 'init'>;
type ConfiguredPrivateFiles = PrivateFileOperations & { accountPetKeyPrefix: string };
let privateBackend: ConfiguredPrivateFiles | PrivateStorageUnavailableError = new PrivateStorageUnavailableError('backend_unavailable');

function configurePrivateBackend(candidate: ConfiguredPrivateFiles, isAvailable: () => Promise<boolean>): void {
    privateBackend = new PrivateStorageUnavailableError('backend_unavailable');
    initializePrivateBackend = async () => {
        privateBackend = await isAvailable() ? candidate : new PrivateStorageUnavailableError('backend_unavailable');
    };
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
    const s3bucket = env.S3_BUCKET?.trim();
    const privateBucket = env.S3_PRIVATE_BUCKET?.trim();
    const s3public = env.S3_PUBLIC_URL?.trim();
    publicUrlForPath = s3public ? (path) => `${s3public}/${path}` : undefined;
    // Disk-owned Pet locators remain on the original volume when the Home selects S3.
    diskAccountPetFiles = createLocalPrivateFilesBackendFromEnv(env);
    privateBackend = new PrivateStorageUnavailableError(privateBucket ? 'backend_unavailable' : 's3_private_bucket_missing');
    initializePrivateBackend = undefined;

    const Minio = await import('minio');
    let s3client: InstanceType<typeof Minio.Client>;
    try {
        if (privateBucket && privateBucket === s3bucket) throw invalidS3Setting('S3_PRIVATE_BUCKET');
        const endPoint = requiredEnv(env, 'S3_HOST');
        const portRaw = env.S3_PORT?.trim();
        const port = portRaw ? Number(portRaw) : undefined;
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw invalidS3Setting('S3_PORT');
        const credentials = resolveS3Credentials(env, Minio);
        try {
            s3client = new Minio.Client({
                endPoint,
                port,
                useSSL: env.S3_USE_SSL ? env.S3_USE_SSL === 'true' : true,
                region: env.S3_REGION?.trim() || 'us-east-1',
                ...credentials,
            });
        } catch (error) {
            if (error instanceof Minio.InvalidEndpointError) throw invalidS3Setting('S3_HOST');
            throw error;
        }
    } catch (error) {
        if (!(error instanceof PublicStorageUnavailableError)) throw error;
        markPublicStorageUnavailable(error);
        return;
    }

    if (!s3bucket || !s3public) {
        markPublicStorageUnavailable(invalidS3Setting(s3bucket ? 'S3_PUBLIC_URL' : 'S3_BUCKET'));
    } else backend = {
        async init() {
            try {
                if (await s3client.bucketExists(s3bucket)) return;
            } catch (error: unknown) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                if (error instanceof Minio.InvalidBucketNameError) {
                    markPublicStorageUnavailable(invalidS3Setting('S3_BUCKET'));
                    return;
                }
                const permission = code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch';
                markPublicStorageUnavailable(new PublicStorageUnavailableError({
                    status: 'unavailable', reason: permission ? 's3_access_denied' : 'backend_unavailable',
                }));
                return;
            }
            markPublicStorageUnavailable(new PublicStorageUnavailableError({ status: 'unavailable', reason: 's3_public_bucket_missing' }));
        },
        async writePublicFile(path: string, data: Uint8Array) {
            await s3client.putObject(s3bucket, path, Buffer.from(data));
        },
        async deletePublicFile(path: string) { await s3client.removeObject(s3bucket, path); },
    };
    if (privateBucket) {
        configurePrivateBackend({
            accountPetKeyPrefix: ACCOUNT_PET_S3_PRIVATE_FILE_PREFIX,
            async writePrivateFile(key, data) {
                await s3client.putObject(privateBucket, normalizePrivateFileKey(key), Buffer.from(data));
            },
            async readPrivateFile(key) {
                const stream = await s3client.getObject(privateBucket, normalizePrivateFileKey(key));
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                return new Uint8Array(Buffer.concat(chunks));
            },
            async deletePrivateFile(key) {
                await s3client.removeObject(privateBucket, normalizePrivateFileKey(key));
            },
        }, async () => {
            try {
                if (!await s3client.bucketExists(privateBucket)) return false;
                return !hasAnonymousGrant(await s3client.getBucketPolicy(privateBucket));
            } catch (error: unknown) {
                // MinIO/S3 reports the absence of any bucket policy explicitly.
                return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'NoSuchBucketPolicy');
            }
        });
    }
}

// Static keys win whenever either is set, so existing deployments keep their
// behavior. Without them, AWS web identity (EKS IRSA or any other projected
// token file) supplies credentials: MinIO's IamAwsProvider exchanges the token
// for temporary STS credentials and fetches new ones shortly before they
// expire. The provider reads AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE,
// AWS_ROLE_SESSION_NAME and AWS_REGION from process.env itself, and uses the
// global STS endpoint when AWS_REGION is unset.
function resolveS3Credentials(
    env: NodeJS.ProcessEnv,
    Minio: typeof import('minio'),
): Pick<ClientOptions, 'accessKey' | 'secretKey' | 'credentialsProvider'> {
    const hasStaticKey = Boolean(env.S3_ACCESS_KEY?.trim() || env.S3_SECRET_KEY?.trim());
    const hasWebIdentity = Boolean(env.AWS_ROLE_ARN?.trim() && env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim());
    if (!hasStaticKey && hasWebIdentity) {
        return { credentialsProvider: new Minio.IamAwsProvider({}) };
    }
    return {
        accessKey: requiredEnv(env, 'S3_ACCESS_KEY'),
        secretKey: requiredEnv(env, 'S3_SECRET_KEY'),
    };
}

export function initFilesLocalFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const localPrivate = createLocalPrivateFilesBackendFromEnv(env);
    diskAccountPetFiles = undefined;
    publicUrlForPath = (path) => getLightPublicUrl(env, path);
    configurePrivateBackend({ ...localPrivate, accountPetKeyPrefix: ACCOUNT_PET_DISK_PRIVATE_FILE_PREFIX }, async () => {
        try {
            await localPrivate.init();
            const publicRoot = await realpath(resolveLightPublicFilesDir(env));
            const privateRoot = await realpath(resolveLocalPrivateFilesDir(env));
            const contains = (parent: string, child: string) => {
                const path = relative(parent, child);
                return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
            };
            return !contains(publicRoot, privateRoot) && !contains(privateRoot, publicRoot);
        } catch { return false; }
    });
    backend = {
        async init() {
            await ensureLightFilesDir(env);
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
    return Boolean(backend && !(backend instanceof PublicStorageUnavailableError) && backend.readPublicFile);
}

export async function loadFiles(): Promise<void> {
    if (!backend) {
        throw new Error('Files backend not initialized');
    }
    if (!(backend instanceof PublicStorageUnavailableError)) await backend.init();
    await initializePrivateBackend?.();
}

export function readFileStorageAvailability(): FileStorageCapability | undefined {
    if (!backend) return undefined;
    return {
        public: backend instanceof PublicStorageUnavailableError ? backend.availability : { status: 'available' },
        private: privateBackend instanceof PrivateStorageUnavailableError
            ? { status: 'unavailable', reason: privateBackend.reason } : { status: 'available' },
    };
}

export function getPublicUrl(path: string): string | null {
    return publicUrlForPath?.(path) ?? null;
}

export function projectPublicImageRef(image: ImageRef | null | undefined): (ImageRef & { url: string }) | null {
    if (!image) return null;
    const { path, width, height, thumbhash } = image;
    const url = getPublicUrl(path);
    return url === null ? null : { path, width, height, thumbhash, url };
}

function requirePublicFilesBackend(): PublicFilesBackend {
    if (!backend) throw new Error('Files backend not initialized');
    if (backend instanceof PublicStorageUnavailableError) throw backend;
    return backend;
}

export async function writePublicFile(path: string, data: Uint8Array): Promise<void> {
    await requirePublicFilesBackend().writePublicFile(path, data);
}

export async function readPublicFile(path: string): Promise<Uint8Array> {
    const files = requirePublicFilesBackend();
    if (!files.readPublicFile) {
        throw new Error('Public file read is not supported');
    }
    return await files.readPublicFile(path);
}
export async function deletePublicFile(path: string): Promise<void> {
    await requirePublicFilesBackend().deletePublicFile(path);
}

function requirePrivateFilesBackend(): ConfiguredPrivateFiles {
    if (privateBackend instanceof PrivateStorageUnavailableError) throw privateBackend;
    return privateBackend;
}

export function assertPrivateStorageAvailable(): void {
    requirePrivateFilesBackend();
}

export async function writePrivateFile(key: string, data: Uint8Array): Promise<void> {
    try {
        await requirePrivateFilesBackend().writePrivateFile(key, data);
    } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error
            && (error.code === 'XMinioStorageFull' || error.code === 'ENOSPC')) {
            throw new PrivateStorageUnavailableError('backend_unavailable');
        }
        throw error;
    }
}

export async function readPrivateFile(key: string): Promise<Uint8Array> {
    return await requirePrivateFilesBackend().readPrivateFile(key);
}

export async function deletePrivateFile(key: string): Promise<void> {
    await deleteFromPrivateBackend(requirePrivateFilesBackend(), key);
}

async function deleteFromPrivateBackend(files: PrivateFileOperations, key: string): Promise<void> {
    if (!files.deletePrivateFile) throw new PrivateStorageUnavailableError('backend_unavailable');
    await files.deletePrivateFile(key);
}

function accountPetBackendForExistingLocator(key: string): PrivateFileOperations {
    return diskAccountPetFiles && key.startsWith(ACCOUNT_PET_DISK_PRIVATE_FILE_PREFIX)
        ? diskAccountPetFiles : requirePrivateFilesBackend();
}

export function createAccountPetPrivateFileKey(path: string): string {
    return `${requirePrivateFilesBackend().accountPetKeyPrefix}${path}`;
}

export const accountPetPrivateFiles = {
    init: loadFiles,
    writePrivateFile,
    readPrivateFile: (key: string) => accountPetBackendForExistingLocator(key).readPrivateFile(key),
    deletePrivateFile: (key: string) => deleteFromPrivateBackend(accountPetBackendForExistingLocator(key), key),
} satisfies PrivateFilesBackend;

function requiredEnv(env: NodeJS.ProcessEnv, key: InvalidS3Setting): string {
    const v = env[key]?.trim();
    if (!v) {
        throw invalidS3Setting(key);
    }
    return v;
}
