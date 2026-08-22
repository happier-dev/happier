import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    decryptSecretValueV1,
    encryptSecretStringV1,
    PluginDirectSecretDeclarationV1Schema,
    readManagedServiceEndpointUrl,
    SecretStringV1Schema,
    type PluginSettingManagedServiceOriginV1,
    type SecretStringV1,
} from '@happier-dev/protocol';
import { isPluginError, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { type SecretsService } from '@happier-dev/plugin-sdk/secrets';

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
}>;

/**
 * A file-backed secret namespace with caller-owned key material.  Runtime
 * callers must obtain that material from the canonical custody owner rather
 * than creating the retired shared plugin-secret key beside the data file.
 */
export type PurposeKeyedPluginSecretStoreParams = Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    secretKey: Uint8Array;
    randomBytes?: (length: number) => Uint8Array;
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

/**
 * The encrypted file's host-private keys are opaque JSON object keys, not
 * public manifest identifiers. Keep their existing storage grammar separate
 * from declared plugin-secret IDs so distribution credentials retain their
 * own persisted-key contract.
 */
function assertValidSecretStorageKey(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
        throw new PluginContextServiceError('PLUGIN_SECRETS_INVALID_NAME', 'Plugin secret names must be non-empty path segments');
    }
    return trimmed;
}

/**
 * Reuses the manifest's direct-secret declaration parser, which in turn owns
 * the public Settings field-ID grammar. A declared ID is an opaque key in the
 * encrypted namespace; it is never joined into a filesystem path.
 */
function assertValidDeclaredPluginSecretId(id: string): string {
    const parsed = PluginDirectSecretDeclarationV1Schema.safeParse({ id });
    if (!parsed.success) {
        throw new PluginContextServiceError(
            'PLUGIN_SECRETS_INVALID_NAME',
            'Plugin secret identifiers must use the declared Settings identifier grammar',
        );
    }
    return parsed.data.id;
}

const MANAGED_SERVICE_ORIGIN_STORAGE_KEY_PREFIX = 'managed-service-origin-v1:';

/**
 * An attached managed service has a credential scope that is narrower than
 * the SDK's ordinary declared-secret surface. The plugin's encrypted file is
 * already the canonical daemon custody owner, so retain that one file and
 * select a distinct opaque entry only when the host supplies an exact
 * canonical origin. There is deliberately no lookup of the unscoped entry.
 */
function managedServiceOriginStorageKey(
    secretId: string,
    canonicalOrigin: string | undefined,
): string {
    const normalizedSecretId = assertValidDeclaredPluginSecretId(secretId);
    if (canonicalOrigin === undefined) return normalizedSecretId;
    const read = readManagedServiceEndpointUrl(canonicalOrigin, {
        hostPolicy: 'userDeclaredAttach',
    });
    if (!read.ok || new URL(read.endpoint.baseUrl).origin !== canonicalOrigin) {
        throw new PluginContextServiceError(
            'PLUGIN_SECRETS_INVALID_ORIGIN',
            'Managed-service secret origin must be an exact canonical endpoint origin',
        );
    }
    return assertValidSecretStorageKey(
        `${MANAGED_SERVICE_ORIGIN_STORAGE_KEY_PREFIX}${Buffer.from(
            `${normalizedSecretId}\u0000${canonicalOrigin}`,
            'utf8',
        ).toString('base64url')}`,
    );
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

    function getSecretKey(): Uint8Array {
        if (!params.secretKey) {
            throw new PluginContextServiceError(
                'PLUGIN_SECRETS_KEY_REQUIRED',
                'Plugin secret storage requires caller-owned key material',
            );
        }
        if (params.secretKey.byteLength !== 32) {
            throw new PluginContextServiceError(
                'PLUGIN_SECRETS_KEY_INVALID',
                'Plugin secret storage key must contain 32 bytes',
            );
        }
        return params.secretKey;
    }

    async function readSecrets(): Promise<Record<string, PersistedPluginSecretV1>> {
        // Listing encrypted metadata is itself access to this custody domain.
        // Do not let a caller without the owner-provided key distinguish an
        // empty namespace from a populated one.
        getSecretKey();
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
            const value = decryptSecretValueV1(secret, getSecretKey());
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
                encryptedValue: encryptSecretStringV1(value, getSecretKey(), randomBytes),
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
            const normalizedName = assertValidSecretStorageKey(name);
            const secret = readSecret(await owner.read(), normalizedName);
            return secret ? await owner.decrypt(secret) : null;
        },
        async set(name: string, value: string): Promise<void> {
            const normalizedName = assertValidSecretStorageKey(name);
            const encryptedSecret = await owner.encrypt(value);
            await owner.mutate((secrets) => {
                setOwnRecordValue(secrets, normalizedName, encryptedSecret);
                return { write: true, result: undefined };
            });
        },
        async delete(name: string): Promise<void> {
            const normalizedName = assertValidSecretStorageKey(name);
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

export function createPurposeKeyedPluginSecretStore(
    params: PurposeKeyedPluginSecretStoreParams,
): PluginSecretStore {
    return createPluginSecretStore(params);
}

/**
 * Atomically re-encrypts one explicit plugin namespace under replacement
 * caller-owned key material. This is intentionally a migration-only primitive:
 * the caller selects the bounded namespace and retains authority for retiring
 * its source key after this owner has completed the file rewrite.
 */
export async function resealPurposeKeyedPluginSecretStore(params: Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    sourceKey: Uint8Array;
    destinationKey: Uint8Array;
}>): Promise<void> {
    const source = createPluginSecretsEncryptedOwner({
        pluginId: params.pluginId,
        paths: params.paths,
        secretKey: params.sourceKey,
    });
    const destination = createPluginSecretsEncryptedOwner({
        pluginId: params.pluginId,
        paths: params.paths,
        secretKey: params.destinationKey,
    });
    await source.mutate(async (secrets) => {
        const entries = await Promise.all(Object.entries(secrets).map(async ([name, secret]) => {
            const plaintext = await source.decrypt(secret);
            return [name, await destination.encrypt(plaintext)] as const;
        }));
        for (const [name, secret] of entries) setOwnRecordValue(secrets, name, secret);
        return { write: entries.length > 0, result: undefined };
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

export type DeclaredPluginSecretCustody = 'account' | 'daemon';

export type DeclaredPluginSecret = Readonly<{
    id: string;
    custody: DeclaredPluginSecretCustody;
    /**
     * Declarative Account-endpoint metadata for an exact origin partition.
     * The secret remains daemon-custodied and never becomes an Account value.
     */
    managedServiceOrigin?: PluginSettingManagedServiceOriginV1;
}>;

/**
 * Host-private, operation-scoped raw access for a declared daemon secret.
 * Consumers receive this only after their exact generation declaration has
 * been bound by the canonical custody router.
 */
export type DeclaredPluginSecretReadResult = Readonly<{
    /** The configured value, or the current missing/empty credential state. */
    value: string | null;
    /** Exact canonical-custody revision observed with this value. */
    revision: string;
    /**
     * Rechecks this read against the same daemon custody owner immediately
     * before a host-private consumer dispatches it.
     */
    isCurrent(signal?: AbortSignal): Promise<boolean>;
}>;

export type DeclaredPluginSecretReadPort = (input: Readonly<{
    secretId: string;
    /** `new URL(normalizedEndpointUrl).origin`, supplied by the attach owner. */
    canonicalOrigin: string;
    signal?: AbortSignal;
}>) => Promise<DeclaredPluginSecretReadResult | null>;

/**
 * Host-private, secret-native administration for one declared daemon secret.
 * It intentionally has no `get`: raw material is available only to the
 * generation-bound managed-service read port after that service has resolved
 * its own canonical endpoint origin.
 */
export type DeclaredDaemonPluginSecretAdministrationPort = Readonly<{
    status(input: Readonly<{
        secretId: string;
        canonicalOrigin?: string;
        signal?: AbortSignal;
    }>): Promise<Readonly<{
        state: 'configured' | 'missing' | 'unavailable';
        revision: string;
    }>>;
    set(input: Readonly<{
        secretId: string;
        value: string;
        canonicalOrigin?: string;
        expectedRevision?: string;
        signal?: AbortSignal;
    }>): Promise<Readonly<{ revision: string }>>;
    delete(input: Readonly<{
        secretId: string;
        canonicalOrigin?: string;
        expectedRevision?: string;
        signal?: AbortSignal;
    }>): Promise<Readonly<{ revision: string }>>;
}>;

type SecretMutationCurrentnessCheck = () => void;

export type PluginSecretCustody = Readonly<{
    status(secretId: string, scope?: Readonly<{
        canonicalOrigin?: string;
    }>): Promise<Readonly<{
        state: 'configured' | 'missing';
        revision: string;
    }>>;
    get(secretId: string, scope?: Readonly<{
        canonicalOrigin?: string;
    }>): Promise<Readonly<{
        value: string;
        revision: string;
    }> | null>;
    set(input: Readonly<{
        secretId: string;
        value: string;
        /** Host-private explicit binding; absent means the legacy unscoped key. */
        canonicalOrigin?: string;
        expectedRevision?: string;
        assertCurrent?: SecretMutationCurrentnessCheck;
    }>): Promise<Readonly<{ revision: string }>>;
    delete(input: Readonly<{
        secretId: string;
        /** Host-private explicit binding; absent means the legacy unscoped key. */
        canonicalOrigin?: string;
        expectedRevision?: string;
        assertCurrent?: SecretMutationCurrentnessCheck;
    }>): Promise<Readonly<{ revision: string }>>;
}>;

export type PluginSecretCustodyResolver = (input: Readonly<{
    pluginId: string;
    declaration: DeclaredPluginSecret;
    /** Invocation lifetime for custody bindings that must release observers. */
    signal?: AbortSignal;
}>) => PluginSecretCustody | null;

/**
 * The only declaration-routed decision point between Account and daemon
 * secret custody.  A declared custody selects exactly one owner; absence is
 * unavailable, never a fallback to the other owner.
 */
export function createPluginSecretCustodyRouter(params: Readonly<{
    account?: PluginSecretCustodyResolver;
    daemon?: PluginSecretCustodyResolver;
}>): Readonly<{
    resolve: PluginSecretCustodyResolver;
}> {
    return Object.freeze({
        resolve(input) {
            const resolver = input.declaration.custody === 'account'
                ? params.account
                : params.daemon;
            return resolver?.(input) ?? null;
        },
    });
}

type DeviceLocalPluginSecretsKeyOwner = Readonly<{
    deriveSecretKey(input: Readonly<{
        purpose: 'plugin_secrets';
    }>): Uint8Array;
}>;

function assertExpectedSecretRevision(
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

/**
 * The one daemon-local plugin-secret owner.  Its key is derived from the
 * existing device-local root under a purpose distinct from memory settings and
 * npm distribution credentials; it never reads or creates a separate shared
 * plugin-secret key file.
 */
export function createDaemonPluginSecretCustodyRouter(params: Readonly<{
    paths: PluginStorePaths;
    resolveDeviceLocalSecretStorage(): Promise<DeviceLocalPluginSecretsKeyOwner>;
    randomBytes?: (length: number) => Uint8Array;
}>): Readonly<{
    resolve: PluginSecretCustodyResolver;
}> {
    const ownersByPluginId = new Map<string, Promise<PluginSecretsEncryptedOwner>>();

    const resolveOwner = (pluginId: string): Promise<PluginSecretsEncryptedOwner> => {
        let owner = ownersByPluginId.get(pluginId);
        if (!owner) {
            owner = params.resolveDeviceLocalSecretStorage().then((storage) => (
                createPluginSecretsEncryptedOwner({
                    pluginId,
                    paths: params.paths,
                    secretKey: storage.deriveSecretKey({ purpose: 'plugin_secrets' }),
                    ...(params.randomBytes ? { randomBytes: params.randomBytes } : {}),
                })
            ));
            ownersByPluginId.set(pluginId, owner);
        }
        return owner;
    };

    const resolve: PluginSecretCustodyResolver = ({ pluginId, declaration }) => {
        if (declaration.custody !== 'daemon') return null;
        const normalizedPluginId = normalizePluginStorageNamespace(pluginId);
        const secretId = assertValidDeclaredPluginSecretId(declaration.id);
        const owner = resolveOwner(normalizedPluginId);
        return Object.freeze({
            async status(_requestedSecretId, scope) {
                const storageKey = managedServiceOriginStorageKey(
                    secretId,
                    scope?.canonicalOrigin,
                );
                const secret = readSecret(await (await owner).read(), storageKey);
                return Object.freeze({
                    state: secret ? 'configured' as const : 'missing' as const,
                    revision: revisionForSecret(secret),
                });
            },
            async get(_requestedSecretId, scope) {
                const storageKey = managedServiceOriginStorageKey(
                    secretId,
                    scope?.canonicalOrigin,
                );
                const secret = readSecret(await (await owner).read(), storageKey);
                if (!secret) return null;
                return Object.freeze({
                    value: await (await owner).decrypt(secret),
                    revision: revisionForSecret(secret),
                });
            },
            async set(input) {
                const storageKey = managedServiceOriginStorageKey(
                    secretId,
                    input.canonicalOrigin,
                );
                return await (await owner).mutate(async (secrets) => {
                    input.assertCurrent?.();
                    const current = readSecret(secrets, storageKey);
                    assertExpectedSecretRevision(current, input.expectedRevision);
                    const encrypted = await (await owner).encrypt(input.value);
                    input.assertCurrent?.();
                    setOwnRecordValue(secrets, storageKey, encrypted);
                    return Object.freeze({
                        write: true,
                        result: Object.freeze({ revision: revisionForSecret(encrypted) }),
                    });
                });
            },
            async delete(input) {
                const storageKey = managedServiceOriginStorageKey(
                    secretId,
                    input.canonicalOrigin,
                );
                return await (await owner).mutate((secrets) => {
                    input.assertCurrent?.();
                    const current = readSecret(secrets, storageKey);
                    assertExpectedSecretRevision(current, input.expectedRevision);
                    delete secrets[storageKey];
                    input.assertCurrent?.();
                    return Object.freeze({
                        write: current !== null,
                        result: Object.freeze({ revision: revisionForSecret(null) }),
                    });
                });
            },
        });
    };

    return Object.freeze({ resolve });
}

/**
 * Binds the SDK secret surface to declarations, a single custody router, and
 * the invocation lifetime.  Secret declarations replace HostAccess grants:
 * plugin code can act only on identifiers from its own manifest.
 */
export function createDeclaredPluginSecretsService(params: Readonly<{
    pluginId: string;
    declarations: readonly DeclaredPluginSecret[];
    resolveCustody: PluginSecretCustodyResolver;
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
    registerRawForRedaction(value: string): void;
}>): SecretsService {
    const declarations = new Map<string, DeclaredPluginSecret>();
    for (const declaration of params.declarations) {
        const id = assertValidDeclaredPluginSecretId(declaration.id);
        if (declarations.has(id)) {
            throw stableSecretError(
                'plugin_secret_declaration_invalid',
                `Plugin secret '${id}' is declared more than once`,
            );
        }
        declarations.set(id, Object.freeze({
            id,
            custody: declaration.custody,
            ...(declaration.managedServiceOrigin
                ? {
                    managedServiceOrigin: Object.freeze({
                        endpointSettingId: declaration.managedServiceOrigin.endpointSettingId,
                    }),
                }
                : {}),
        }));
    }
    // Bind Account declarations once for this invocation. An Account-backed
    // service must not begin under one Account and resolve a different Account
    // after a switch before its first secret operation. Daemon custody remains
    // lazy so an unused declaration cannot initialize device-local storage.
    const accountCustodyBySecretId = new Map<string, PluginSecretCustody | null>();
    for (const declaration of declarations.values()) {
        if (declaration.custody !== 'account') continue;
        accountCustodyBySecretId.set(declaration.id, params.resolveCustody({
            pluginId: params.pluginId,
            declaration,
            signal: params.signal,
        }) ?? null);
    }

    function assertCurrent(signal?: AbortSignal): void {
        if (signal?.aborted || params.signal.aborted || !params.isGenerationCurrent()) {
            throw stableSecretError('plugin_generation_stale', 'Plugin secrets invocation generation is stale');
        }
    }

    function resolveDeclaration(secretId: string): DeclaredPluginSecret {
        const normalizedId = assertValidDeclaredPluginSecretId(secretId);
        const declaration = declarations.get(normalizedId);
        if (!declaration) {
            throw stableSecretError(
                'plugin_secret_undeclared',
                `Plugin secret '${normalizedId}' is not declared`,
            );
        }
        return declaration;
    }

    function readInvocationCustody(declaration: DeclaredPluginSecret): PluginSecretCustody | null {
        if (declaration.custody === 'account') {
            return accountCustodyBySecretId.get(declaration.id) ?? null;
        }
        return params.resolveCustody({
            pluginId: params.pluginId,
            declaration,
            signal: params.signal,
        }) ?? null;
    }

    function requireInvocationCustody(declaration: DeclaredPluginSecret): PluginSecretCustody {
        const custody = readInvocationCustody(declaration);
        if (!custody) {
            throw stableSecretError(
                'plugin_secret_custody_unavailable',
                `Plugin secret '${declaration.id}' has no available '${declaration.custody}' custody owner`,
            );
        }
        return custody;
    }

    function requiresManagedServiceOrigin(declaration: DeclaredPluginSecret): boolean {
        return declaration.managedServiceOrigin !== undefined;
    }

    function unavailableOriginBoundStatus(): Readonly<{
        state: 'unavailable';
        revision: string;
    }> {
        return Object.freeze({
            state: 'unavailable' as const,
            revision: `secret-r1:${createHash('sha256').update('origin-required').digest('hex')}`,
        });
    }

    function rejectSdkUnscopedAccess(declaration: DeclaredPluginSecret): void {
        if (!requiresManagedServiceOrigin(declaration)) return;
        throw stableSecretError(
            'plugin_secret_origin_required',
            `Plugin secret '${declaration.id}' requires its declared managed-service origin`,
        );
    }

    return Object.freeze({
        async status(id: string) {
            assertCurrent();
            const declaration = resolveDeclaration(id);
            // The public SDK contract has no origin input. Returning
            // unavailable avoids selecting the legacy unscoped slot from an
            // origin-bound declaration while keeping status non-material.
            if (requiresManagedServiceOrigin(declaration)) {
                return unavailableOriginBoundStatus();
            }
            const custody = readInvocationCustody(declaration);
            if (!custody) {
                return Object.freeze({
                    state: 'unavailable' as const,
                    revision: `secret-r1:${createHash('sha256').update('unavailable').digest('hex')}`,
                });
            }
            const status = await custody.status(declaration.id);
            assertCurrent();
            return status;
        },
        async get(id: string, options?: { reason?: string; signal?: AbortSignal }) {
            assertCurrent(options?.signal);
            const declaration = resolveDeclaration(id);
            rejectSdkUnscopedAccess(declaration);
            const resolved = await requireInvocationCustody(declaration).get(declaration.id);
            assertCurrent(options?.signal);
            if (!resolved) {
                throw stableSecretError('plugin_secret_missing', `Plugin secret '${declaration.id}' is not configured`);
            }
            params.registerRawForRedaction(resolved.value);
            return resolved.value;
        },
        async set(id: string, value: string, options?: { expectedRevision?: string; signal?: AbortSignal }) {
            assertCurrent(options?.signal);
            const declaration = resolveDeclaration(id);
            rejectSdkUnscopedAccess(declaration);
            const result = await requireInvocationCustody(declaration).set({
                secretId: declaration.id,
                ...(options?.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
                value,
                assertCurrent: () => assertCurrent(options?.signal),
            });
            return result;
        },
        async delete(id: string, options?: { expectedRevision?: string; signal?: AbortSignal }) {
            assertCurrent(options?.signal);
            const declaration = resolveDeclaration(id);
            rejectSdkUnscopedAccess(declaration);
            const result = await requireInvocationCustody(declaration).delete({
                secretId: declaration.id,
                ...(options?.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
                assertCurrent: () => assertCurrent(options?.signal),
            });
            return result;
        },
    });
}

export type StableDeclaredPluginSecretsHost = Readonly<{
    bind(input: Readonly<{
        pluginId: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
        registerRawForRedaction(value: string): void;
    }>): SecretsService | null;
    /**
     * Secret-native daemon administration. This does not materialize a
     * Settings service or expose a raw secret read operation.
     */
    bindDaemonPluginSecretAdministrationPort(input: Readonly<{
        pluginId: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
    }>): DeclaredDaemonPluginSecretAdministrationPort | null;
    /**
     * Managed services may consume only an exact generation-bound daemon
     * declaration. This remains host-private and does not expose the SDK
     * Secrets service or allow Account custody into daemon attachment flows.
     */
    bindManagedServiceSecretReadPort(input: Readonly<{
        pluginId: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
        registerRawForRedaction(value: string): void;
    }>): DeclaredPluginSecretReadPort | null;
}>;

/**
 * Keeps declaration lookup outside individual consumers.  A plugin with no
 * declared secret has no SDK secrets service; a declared Account secret keeps
 * the service surface so `status()` can truthfully report unavailable until
 * the Account custody port is present.
 */
export function createStableDeclaredPluginSecretsHost(params: Readonly<{
    declarations: readonly Readonly<{
        pluginId: string;
        declaration: DeclaredPluginSecret;
    }>[];
    resolveCustody: PluginSecretCustodyResolver;
}>): StableDeclaredPluginSecretsHost {
    const declarationsByPluginId = new Map<string, DeclaredPluginSecret[]>();
    for (const entry of params.declarations) {
        const declarations = declarationsByPluginId.get(entry.pluginId) ?? [];
        declarations.push(entry.declaration);
        declarationsByPluginId.set(entry.pluginId, declarations);
    }
    const declarationsForPlugin = (pluginId: string): readonly DeclaredPluginSecret[] | null => (
        declarationsByPluginId.get(pluginId) ?? null
    );
    const bind = (input: Readonly<{
        pluginId: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
        registerRawForRedaction(value: string): void;
    }>): Readonly<{
        declarations: readonly DeclaredPluginSecret[];
        service: SecretsService;
    }> | null => {
        const declarations = declarationsForPlugin(input.pluginId);
        if (!declarations || declarations.length === 0) return null;
        return Object.freeze({
            declarations,
            service: createDeclaredPluginSecretsService({
                pluginId: input.pluginId,
                declarations,
                resolveCustody: params.resolveCustody,
                signal: input.signal,
                isGenerationCurrent: input.isGenerationCurrent,
                registerRawForRedaction: input.registerRawForRedaction,
            }),
        });
    };
    const bindDaemonPluginSecretAdministrationPort = (input: Readonly<{
        pluginId: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
    }>): DeclaredDaemonPluginSecretAdministrationPort | null => {
        const declarations = declarationsForPlugin(input.pluginId);
        if (!declarations || declarations.length === 0) return null;

        const assertCurrent = (signal?: AbortSignal): void => {
            if (signal?.aborted || input.signal.aborted || !input.isGenerationCurrent()) {
                throw stableSecretError(
                    'plugin_generation_stale',
                    'Plugin daemon-secret administration generation is stale',
                );
            }
        };
        const resolveDeclaration = (request: Readonly<{
            secretId: string;
            canonicalOrigin?: string;
            signal?: AbortSignal;
        }>): Readonly<{
            declaration: DeclaredPluginSecret;
            canonicalOrigin?: string;
        }> => {
            assertCurrent(request.signal);
            const secretId = assertValidDeclaredPluginSecretId(request.secretId);
            const declaration = declarations.find((candidate) => candidate.id === secretId);
            if (!declaration) {
                throw stableSecretError(
                    'plugin_secret_undeclared',
                    `Plugin secret '${secretId}' is not declared`,
                );
            }
            if (declaration.custody !== 'daemon') {
                throw stableSecretError(
                    'plugin_secret_custody_unavailable',
                    `Plugin secret '${secretId}' is not daemon-custodied`,
                );
            }
            if (declaration.managedServiceOrigin) {
                if (request.canonicalOrigin === undefined) {
                    throw stableSecretError(
                        'plugin_secret_origin_required',
                        `Plugin secret '${secretId}' requires its declared managed-service origin`,
                    );
                }
                return Object.freeze({ declaration, canonicalOrigin: request.canonicalOrigin });
            }
            if (request.canonicalOrigin !== undefined) {
                throw stableSecretError(
                    'plugin_secret_origin_unexpected',
                    `Plugin secret '${secretId}' has no declared managed-service origin`,
                );
            }
            return Object.freeze({ declaration });
        };
        const resolveCustody = (declaration: DeclaredPluginSecret): PluginSecretCustody => {
            const custody = params.resolveCustody({
                pluginId: input.pluginId,
                declaration,
                signal: input.signal,
            });
            if (!custody) {
                throw stableSecretError(
                    'plugin_secret_custody_unavailable',
                    `Plugin secret '${declaration.id}' has no available daemon custody owner`,
                );
            }
            return custody;
        };
        const unavailableStatus = (): Readonly<{
            state: 'unavailable';
            revision: string;
        }> => Object.freeze({
            state: 'unavailable' as const,
            revision: `secret-r1:${createHash('sha256').update('unavailable').digest('hex')}`,
        });

        return Object.freeze({
            async status(request) {
                const resolved = resolveDeclaration(request);
                let custody: PluginSecretCustody;
                try {
                    custody = resolveCustody(resolved.declaration);
                } catch (error) {
                    if (isPluginError(error) && error.code === 'plugin_secret_custody_unavailable') {
                        return unavailableStatus();
                    }
                    throw error;
                }
                const status = await custody.status(
                    resolved.declaration.id,
                    resolved.canonicalOrigin === undefined
                        ? undefined
                        : Object.freeze({ canonicalOrigin: resolved.canonicalOrigin }),
                );
                assertCurrent(request.signal);
                return status;
            },
            async set(request) {
                const resolved = resolveDeclaration(request);
                const result = await resolveCustody(resolved.declaration).set({
                    secretId: resolved.declaration.id,
                    value: request.value,
                    ...(resolved.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: resolved.canonicalOrigin }),
                    ...(request.expectedRevision === undefined
                        ? {}
                        : { expectedRevision: request.expectedRevision }),
                    assertCurrent: () => assertCurrent(request.signal),
                });
                // A mutation already acknowledged by custody is authoritative
                // even if its generation retires immediately afterwards.
                return result;
            },
            async delete(request) {
                const resolved = resolveDeclaration(request);
                const result = await resolveCustody(resolved.declaration).delete({
                    secretId: resolved.declaration.id,
                    ...(resolved.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: resolved.canonicalOrigin }),
                    ...(request.expectedRevision === undefined
                        ? {}
                        : { expectedRevision: request.expectedRevision }),
                    assertCurrent: () => assertCurrent(request.signal),
                });
                // See the acknowledged mutation rule in `set` above.
                return result;
            },
        });
    };
    return Object.freeze({
        bind(input) {
            return bind(input)?.service ?? null;
        },
        bindDaemonPluginSecretAdministrationPort,
        bindManagedServiceSecretReadPort(input) {
            const declarations = declarationsForPlugin(input.pluginId);
            if (!declarations || declarations.length === 0) return null;
            return async ({ secretId, canonicalOrigin, signal }) => {
                // This private port is exclusively for a managed attach. An
                // omitted origin must never silently select the legacy global
                // secret key; ordinary SDK Secrets access is a different
                // explicit surface.
                if (typeof canonicalOrigin !== 'string') return null;
                const declaration = declarations.find((candidate) => (
                    candidate.id === secretId
                ));
                if (
                    !declaration
                    || declaration.custody !== 'daemon'
                    || !declaration.managedServiceOrigin
                ) return null;
                const custody = params.resolveCustody({
                    pluginId: input.pluginId,
                    declaration,
                    signal: input.signal,
                });
                if (!custody) return null;
                const isBoundCurrent = (
                    revalidationSignal?: AbortSignal,
                ): boolean => (
                    !signal?.aborted
                    && !revalidationSignal?.aborted
                    && !input.signal.aborted
                    && input.isGenerationCurrent()
                );
                try {
                    if (!isBoundCurrent()) return null;
                    const originScope = Object.freeze({ canonicalOrigin });
                    const observed = await custody.status(
                        declaration.id,
                        originScope,
                    );
                    if (!isBoundCurrent()) return null;
                    let value: string | null = null;
                    if (observed.state === 'configured') {
                        const resolved = await custody.get(
                            declaration.id,
                            originScope,
                        );
                        if (!isBoundCurrent()) return null;
                        // A mutation between status and get must retain the
                        // first revision so the caller's pre-dispatch check
                        // rejects it rather than treating it as an ordinary
                        // unauthenticated request.
                        if (resolved?.revision === observed.revision) {
                            value = resolved.value;
                            input.registerRawForRedaction(value);
                        }
                    }
                    return Object.freeze({
                        value,
                        revision: observed.revision,
                        async isCurrent(revalidationSignal?: AbortSignal) {
                            if (!isBoundCurrent(revalidationSignal)) {
                                return false;
                            }
                            const current = await custody.status(
                                declaration.id,
                                originScope,
                            );
                            return isBoundCurrent(revalidationSignal)
                                && current.revision === observed.revision;
                        },
                    });
                } catch (error) {
                    if (
                        isPluginError(error)
                        && (
                            error.code === 'plugin_secret_missing'
                            || error.code === 'plugin_secret_undeclared'
                            || error.code === 'plugin_secret_custody_unavailable'
                            || error.code === 'plugin_generation_stale'
                        )
                    ) return null;
                    throw error;
                }
            };
        },
    });
}
