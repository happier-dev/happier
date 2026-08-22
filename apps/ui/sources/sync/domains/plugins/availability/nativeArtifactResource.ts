import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
    createHostedWebAssetNativePolicyTableV1,
    type HostedWebAssetNativePolicyTableV1,
    type HostedWebAssetPolicyInput,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
    type PluginUiPersistentArtifactIdentity,
    type PluginUiPersistentArtifactNativeResourceDescriptor,
    type PluginUiPersistentArtifactNativeResourceStore,
    type PluginUiPersistentArtifactNativeStorageLocator,
    type PluginUiPersistentArtifactRecord,
} from '@/sync/domains/plugins/ui/artifactByteCache';

import type { PluginSelectedArtifactLease } from './artifactLease';

const OPAQUE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,255}$/u;
const STORED_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export type PluginNativeArtifactPersistentStore = PluginUiPersistentArtifactNativeResourceStore;

export type PluginNativeArtifactResourceProfileIsolationCapability =
    | 'MULTI_PROFILE'
    | 'DOCUMENT_START_SCRIPT'
    /** Sender-bound document bridge; a global JS interface would be unsafe. */
    | 'WEB_MESSAGE_LISTENER';

type PluginNativeArtifactResourceRegistrationUnavailable =
    | Readonly<{
        kind: 'unavailable';
        code: 'hosted_web_profile_isolation_unavailable';
        capability: PluginNativeArtifactResourceProfileIsolationCapability;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'native_artifact_resource_registration_failed';
    }>;

/** The native admission result belongs to the one registrar/registry seam. */
export type PluginNativeArtifactResourceRegistrationResult =
    | Readonly<{
        kind: 'registered';
        /**
         * Exact transport-origin fact returned only by a native adapter whose
         * runtime origin differs from the Protocol default. Artifact preserves
         * it without deriving, interpreting, or making it a cache identity.
         */
        frameOrigin?: string;
    }>
    | PluginNativeArtifactResourceRegistrationUnavailable;

/**
 * A Protocol-owned table is intentionally opaque here. Artifact validates only
 * that its private bindings name verified declared files; Protocol continues to
 * own request-path, fallback, MIME, and response-header decisions.
 */
export type PluginNativeArtifactResponseTable = Readonly<{
    table: HostedWebAssetNativePolicyTableV1;
    resourceBindings: readonly Readonly<{
        resourceId: string;
        relativePath: string;
    }>[];
}>;

export type PluginNativeArtifactResourceRegistrar = Readonly<{
    /**
     * This is the sole JS-to-native registration seam. It receives no raw path
     * or bytes: the native module resolves its own app-private cache root from
     * the opaque locator and only maps protocol resource IDs to stored files.
     */
    register: (input: Readonly<{
        token: string;
        storagePartitionId: string;
        storageLocator: PluginUiPersistentArtifactNativeStorageLocator;
        resources: readonly Readonly<{
            resourceId: string;
            storedFileName: string;
            digest: PluginUiArtifactDigestV1;
            byteSize: number;
        }>[];
        policyTable: HostedWebAssetNativePolicyTableV1;
    }>) => Promise<PluginNativeArtifactResourceRegistrationResult>;
    /**
     * Synchronous logical-retirement acknowledgement. It returns true only
     * when the native adapter has synchronously accepted (or enqueued through
     * its already-admitted transport) token denial; Artifact then retracts JS
     * currentness before returning. Native handlers must fail closed as soon
     * as that denial is observed; adapters with a direct tombstone may retain
     * the stronger immediate rejection guarantee.
     */
    unregister: (token: string) => boolean;
}>;

export type PluginNativeArtifactResourceHandle = Readonly<{
    token: string;
    /** A stable opaque native-frame origin partition for this Account/plugin/version. */
    storagePartitionId: string;
    /**
     * An adapter-validated actual native frame origin, when its local transport
     * cannot use the platform's Protocol default. This is bridge routing only;
     * Artifact custody/currentness remains unchanged.
     */
    frameOrigin?: string;
    /** The Protocol-native-frame table; Artifact never interprets it. */
    policyTable: HostedWebAssetNativePolicyTableV1;
    isCurrent: () => boolean;
    onRevoke: (listener: () => void) => Readonly<{ dispose: () => void }>;
    dispose: () => void;
}>;

export type PluginNativeArtifactResourceAcquireResult =
    | Readonly<{ kind: 'available'; handle: PluginNativeArtifactResourceHandle }>
    | PluginNativeArtifactResourceRegistrationUnavailable
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'artifact_lease_revoked'
            | 'native_artifact_store_unavailable'
            | 'native_artifact_response_table_invalid'
            | 'native_artifact_revocation_pending';
    }>;

export type PluginNativeArtifactResourceRegistry = Readonly<{
    materialize: (input: Readonly<{
        lease: PluginSelectedArtifactLease;
        persistent: Readonly<{
            scope: ServerAccountScope;
            store: PluginNativeArtifactPersistentStore;
            /** Existing Artifact-cache/lifetime currentness, never a new owner. */
            isCurrent: () => boolean;
        }>;
        accountLifetime: ActiveServerAccountScopeLifetime;
        /** Bound frame/controller currentness; it never becomes cache authority. */
        isCurrent: () => boolean;
        /** Policy facts consumed by Protocol's sole hosted-web table owner. */
        hostedWebPolicy: HostedWebAssetPolicyInput;
    }>) => Promise<PluginNativeArtifactResourceAcquireResult>;
    /** Called before one persistent entry is overwritten or physically removed. */
    revokePersistentArtifact: (identity: PluginUiPersistentArtifactIdentity) => boolean;
    /** Called before one Account cache root is physically removed. */
    revokeAccount: (scope: ServerAccountScope) => boolean;
}>;

type Registration = {
    token: string;
    scope: ServerAccountScope;
    persistentIdentity: PluginUiPersistentArtifactIdentity;
    nativeRegistered: boolean;
    nativeRegistrationPending: boolean;
    revoked: boolean;
    subscriptions: Array<Readonly<{ dispose: () => void }>>;
    listeners: Set<() => void>;
    isCurrent: () => boolean;
    revoke: () => void;
};

function sha256Hex(value: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function opaqueIdFromPlatformCrypto(): string | null {
    const getRandomValues = globalThis.crypto?.getRandomValues;
    if (typeof getRandomValues !== 'function') return null;
    const bytes = new Uint8Array(32);
    getRandomValues.call(globalThis.crypto, bytes);
    return `hpat_${bytesToHex(bytes)}`;
}

function isOpaqueId(value: string | null | undefined): value is string {
    return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

function cloneIdentity(input: PluginUiPersistentArtifactIdentity): PluginUiPersistentArtifactIdentity {
    return Object.freeze({
        ...input,
        accountScope: Object.freeze({ ...input.accountScope }),
    });
}

function persistentIdentityFor(input: Readonly<{
    scope: ServerAccountScope;
    lease: PluginSelectedArtifactLease;
}>): PluginUiPersistentArtifactIdentity {
    return Object.freeze({
        accountScope: Object.freeze({ ...input.scope }),
        releaseVersion: input.lease.artifact.releaseVersion,
        pluginId: input.lease.artifact.pluginId,
        contributionId: input.lease.artifact.contributionId,
        tier: input.lease.artifact.tier,
        platform: input.lease.artifact.platform,
        artifactDigest: input.lease.artifact.digest,
    });
}

function storagePartitionId(identity: PluginUiPersistentArtifactIdentity): string {
    // The native host name may reveal this value, so hash its Account/plugin/
    // version qualification rather than placing any semantic coordinate in it.
    const bytes = [
        derivePluginUiPersistentArtifactAccountKey(identity.accountScope),
        `${new TextEncoder().encode(identity.pluginId).byteLength}:${identity.pluginId}`,
        `${new TextEncoder().encode(identity.releaseVersion).byteLength}:${identity.releaseVersion}`,
    ].join('\n');
    return `hpa_${sha256Hex(bytes)}`;
}

function leaseAndConsumerAreCurrent(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    persistentScope: ServerAccountScope;
    persistentIsCurrent: () => boolean;
    accountLifetime: ActiveServerAccountScopeLifetime;
    consumerIsCurrent: () => boolean;
}>): boolean {
    try {
        return areServerAccountScopesEqual(input.persistentScope, input.accountLifetime.scope)
            && input.lease.isCurrent()
            && input.persistentIsCurrent()
            && input.accountLifetime.isCurrent()
            && input.consumerIsCurrent();
    } catch {
        return false;
    }
}

async function readVerifiedLeaseFiles(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    isCurrent: () => boolean;
}>): Promise<readonly Readonly<{
    relativePath: string;
    digest: PluginUiArtifactDigestV1;
    byteSize: number;
    bytes: Uint8Array;
}>[] | null> {
    const files: Array<Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
        bytes: Uint8Array;
    }>> = [];
    for (const declared of input.lease.files) {
        if (!input.isCurrent()) return null;
        const read = await input.lease.readFile(declared.relativePath);
        if (!input.isCurrent()) return null;
        if (
            read.kind !== 'available'
            || read.file.relativePath !== declared.relativePath
            || read.file.digest !== declared.digest
            || read.file.byteSize !== declared.byteSize
        ) {
            return null;
        }
        files.push(Object.freeze({
            relativePath: read.file.relativePath,
            digest: read.file.digest,
            byteSize: read.file.byteSize,
            bytes: new Uint8Array(read.bytes),
        }));
    }
    return Object.freeze(files);
}

function recordFor(input: Readonly<{
    identity: PluginUiPersistentArtifactIdentity;
    lease: PluginSelectedArtifactLease;
    files: readonly Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
        bytes: Uint8Array;
    }>[];
}>): PluginUiPersistentArtifactRecord | null {
    const entry = input.files.find((file) => file.relativePath === input.lease.artifactGraph.entry);
    if (!entry) return null;
    return Object.freeze({
        persistentIdentity: cloneIdentity(input.identity),
        bytes: new Uint8Array(entry.bytes),
        entryRelativePath: input.lease.artifactGraph.entry,
        files: Object.freeze(input.files.map((file) => Object.freeze({
            relativePath: file.relativePath,
            digest: file.digest,
            byteSize: file.byteSize,
            bytes: new Uint8Array(file.bytes),
        }))),
    });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.byteLength === right.byteLength
        && left.every((byte, index) => byte === right[index]);
}

/**
 * Source selection may already have atomically persisted the exact verified
 * file graph before native materialization begins. The native adapter remains
 * able to materialize a direct lease itself, but must not overwrite that same
 * canonical record merely to obtain a native descriptor.
 */
async function persistentStoreAlreadyContainsVerifiedLease(input: Readonly<{
    store: PluginNativeArtifactPersistentStore;
    identity: PluginUiPersistentArtifactIdentity;
    lease: PluginSelectedArtifactLease;
    files: readonly Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
        bytes: Uint8Array;
    }>[];
}>): Promise<boolean> {
    let record: PluginUiPersistentArtifactRecord | null;
    try {
        record = await input.store.read(input.identity);
    } catch {
        return false;
    }
    if (!record || derivePluginUiPersistentArtifactKey(record.persistentIdentity)
        !== derivePluginUiPersistentArtifactKey(input.identity)) {
        return false;
    }
    if (record.entryRelativePath !== input.lease.artifactGraph.entry || !record.files) return false;
    if (record.files.length !== input.files.length) return false;
    const storedByPath = new Map(record.files.map((file) => [file.relativePath, file] as const));
    if (storedByPath.size !== input.files.length) return false;
    for (const file of input.files) {
        const stored = storedByPath.get(file.relativePath);
        if (
            !stored
            || stored.digest !== file.digest
            || stored.byteSize !== file.byteSize
            || !bytesEqual(stored.bytes, file.bytes)
        ) {
            return false;
        }
    }
    const entry = input.files.find((file) => file.relativePath === input.lease.artifactGraph.entry);
    return entry !== undefined && bytesEqual(record.bytes, entry.bytes);
}

function nativeDescriptorMatchesLease(input: Readonly<{
    descriptor: PluginUiPersistentArtifactNativeResourceDescriptor;
    files: readonly Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
    }>[];
}>): boolean {
    return input.descriptor.resources.length === input.files.length
        && input.descriptor.resources.every((resource, index) => {
            const file = input.files[index];
            return file !== undefined
                && STORED_FILE_NAME_PATTERN.test(resource.storedFileName)
                && resource.digest === file.digest
                && resource.byteSize === file.byteSize;
        });
}

function bindResponseTable(input: Readonly<{
    responseTable: PluginNativeArtifactResponseTable;
    files: readonly Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
    }>[];
    descriptor: PluginUiPersistentArtifactNativeResourceDescriptor;
}>): readonly Readonly<{
    resourceId: string;
    storedFileName: string;
    digest: PluginUiArtifactDigestV1;
    byteSize: number;
}>[] | null {
    const byRelativePath = new Map(input.files.map((file, index) => [file.relativePath, {
        file,
        resource: input.descriptor.resources[index]!,
    }] as const));
    const resourceIds = new Set<string>();
    const relativePaths = new Set<string>();
    const resources: Array<Readonly<{
        resourceId: string;
        storedFileName: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
    }>> = [];
    for (const binding of input.responseTable.resourceBindings) {
        if (
            !isOpaqueId(binding.resourceId)
            || resourceIds.has(binding.resourceId)
            || relativePaths.has(binding.relativePath)
        ) return null;
        const found = byRelativePath.get(binding.relativePath);
        if (!found) return null;
        resourceIds.add(binding.resourceId);
        relativePaths.add(binding.relativePath);
        resources.push(Object.freeze({
            resourceId: binding.resourceId,
            storedFileName: found.resource.storedFileName,
            digest: found.file.digest,
            byteSize: found.file.byteSize,
        }));
    }
    return Object.freeze(resources);
}

/**
 * Wrap a native-capable persistent store so physical cache replacement/removal
 * first kills every live opaque native token. It retains no bytes and does not
 * decide cache identity, source order, or Artifact currentness.
 */
export function createPluginNativeArtifactResourcePersistentStore(input: Readonly<{
    store: PluginNativeArtifactPersistentStore;
    registry: PluginNativeArtifactResourceRegistry;
}>): PluginNativeArtifactPersistentStore {
    return Object.freeze({
        read: (identity) => input.store.read(identity),
        write: async (record) => {
            if (!input.registry.revokePersistentArtifact(record.persistentIdentity)) {
                throw new Error('native_artifact_revocation_pending');
            }
            await input.store.write(record);
        },
        remove: async (identity) => {
            if (!input.registry.revokePersistentArtifact(identity)) {
                throw new Error('native_artifact_revocation_pending');
            }
            await input.store.remove(identity);
        },
        removeAccount: async (scope) => {
            if (!input.registry.revokeAccount(scope)) {
                throw new Error('native_artifact_revocation_pending');
            }
            await input.store.removeAccount(scope);
        },
        describeNativeResource: (descriptor) => input.store.describeNativeResource(descriptor),
    });
}

export function createPluginNativeArtifactResourceRegistry(input: Readonly<{
    registrar: PluginNativeArtifactResourceRegistrar;
    /** Test seam only; production fails closed rather than weakening entropy. */
    createOpaqueId?: () => string | null;
    /** A native rejection remains indexed and is retried, never silently lost. */
    onNativeTeardownDiagnostic?: (code: 'native_artifact_unregister_not_acknowledged') => void;
}>): PluginNativeArtifactResourceRegistry {
    const registrationsByToken = new Map<string, Registration>();
    const tokensByPersistentIdentity = new Map<string, Set<string>>();
    const opaqueId = input.createOpaqueId ?? opaqueIdFromPlatformCrypto;

    const removeRegistration = (registration: Registration) => {
        registrationsByToken.delete(registration.token);
        const identityKey = derivePluginUiPersistentArtifactKey(registration.persistentIdentity);
        const tokens = tokensByPersistentIdentity.get(identityKey);
        if (!tokens) return;
        tokens.delete(registration.token);
        if (tokens.size === 0) tokensByPersistentIdentity.delete(identityKey);
    };

    const revokeRegistration = (registration: Registration): boolean => {
        if (!registration.revoked) {
            registration.revoked = true;
            for (const subscription of registration.subscriptions) subscription.dispose();
            registration.subscriptions.length = 0;
            for (const listener of registration.listeners) {
                try {
                    listener();
                } catch {
                    // One consumer cannot prevent revocation of the remaining ones.
                }
            }
            registration.listeners.clear();
        }
        // A register call can resolve after a lease event. Keep this existing
        // token indexed until it establishes whether native accepted it.
        if (registration.nativeRegistrationPending) return false;
        if (registration.nativeRegistered) {
            let acknowledged = false;
            try {
                acknowledged = input.registrar.unregister(registration.token) === true;
            } catch {
                acknowledged = false;
            }
            if (!acknowledged) {
                input.onNativeTeardownDiagnostic?.('native_artifact_unregister_not_acknowledged');
                return false;
            }
            registration.nativeRegistered = false;
        }
        removeRegistration(registration);
        return true;
    };

    const revokePersistentArtifact = (identity: PluginUiPersistentArtifactIdentity): boolean => {
        const key = derivePluginUiPersistentArtifactKey(identity);
        const tokens = [...(tokensByPersistentIdentity.get(key) ?? [])];
        let revoked = true;
        for (const token of tokens) {
            const registration = registrationsByToken.get(token);
            if (registration && !revokeRegistration(registration)) revoked = false;
        }
        return revoked;
    };

    const revokeAccount = (accountScope: ServerAccountScope): boolean => {
        let revoked = true;
        for (const registration of [...registrationsByToken.values()]) {
            if (areServerAccountScopesEqual(registration.scope, accountScope)) {
                if (!revokeRegistration(registration)) revoked = false;
            }
        }
        return revoked;
    };

    const retryRevokedPersistentArtifact = (identity: PluginUiPersistentArtifactIdentity): boolean => {
        const key = derivePluginUiPersistentArtifactKey(identity);
        const tokens = [...(tokensByPersistentIdentity.get(key) ?? [])];
        let clear = true;
        for (const token of tokens) {
            const registration = registrationsByToken.get(token);
            if (registration?.revoked && !revokeRegistration(registration)) clear = false;
        }
        return clear;
    };

    return Object.freeze({
        revokePersistentArtifact,
        revokeAccount,
        materialize: async (materialization) => {
            const current = () => leaseAndConsumerAreCurrent({
                lease: materialization.lease,
                persistentScope: materialization.persistent.scope,
                persistentIsCurrent: materialization.persistent.isCurrent,
                accountLifetime: materialization.accountLifetime,
                consumerIsCurrent: materialization.isCurrent,
            });
            if (!current()) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            const identity = persistentIdentityFor({
                scope: materialization.persistent.scope,
                lease: materialization.lease,
            });
            if (!retryRevokedPersistentArtifact(identity)) {
                return Object.freeze({ kind: 'unavailable', code: 'native_artifact_revocation_pending' });
            }
            const files = await readVerifiedLeaseFiles({ lease: materialization.lease, isCurrent: current });
            if (!files || !current()) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            if (materialization.lease.sourceKind !== 'persistentCache') {
                const record = recordFor({ identity, lease: materialization.lease, files });
                if (!record) {
                    return Object.freeze({ kind: 'unavailable', code: 'native_artifact_store_unavailable' });
                }
                const alreadyPersisted = await persistentStoreAlreadyContainsVerifiedLease({
                    store: materialization.persistent.store,
                    identity,
                    lease: materialization.lease,
                    files,
                });
                if (!alreadyPersisted) {
                    // An operation-fenced store turns a stale existence read
                    // into a miss. Re-check its captured lifecycle before a
                    // write so that miss cannot become a fresh Account write.
                    if (!current()) {
                        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
                    }
                    try {
                        await materialization.persistent.store.write(record);
                    } catch {
                        return Object.freeze({ kind: 'unavailable', code: 'native_artifact_store_unavailable' });
                    }
                }
                if (!current()) {
                    return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
                }
            }
            let descriptor: PluginUiPersistentArtifactNativeResourceDescriptor | null;
            try {
                descriptor = await materialization.persistent.store.describeNativeResource({
                    identity,
                    files: files.map(({ relativePath, digest, byteSize }) => ({ relativePath, digest, byteSize })),
                });
            } catch {
                descriptor = null;
            }
            if (!descriptor || !nativeDescriptorMatchesLease({ descriptor, files }) || !current()) {
                return Object.freeze({
                    kind: 'unavailable',
                    code: current() ? 'native_artifact_store_unavailable' : 'artifact_lease_revoked',
                });
            }
            let responseTable: PluginNativeArtifactResponseTable;
            try {
                const built = createHostedWebAssetNativePolicyTableV1(materialization.hostedWebPolicy);
                if (!built.ok) {
                    return Object.freeze({ kind: 'unavailable', code: 'native_artifact_response_table_invalid' });
                }
                responseTable = Object.freeze({
                    table: built.table,
                    resourceBindings: built.resourceBindings,
                });
            } catch {
                return Object.freeze({ kind: 'unavailable', code: 'native_artifact_response_table_invalid' });
            }
            const resources = bindResponseTable({ responseTable, files, descriptor });
            if (!resources || !current()) {
                return Object.freeze({
                    kind: 'unavailable',
                    code: current() ? 'native_artifact_response_table_invalid' : 'artifact_lease_revoked',
                });
            }
            const token = opaqueId();
            if (!isOpaqueId(token) || registrationsByToken.has(token)) {
                return Object.freeze({ kind: 'unavailable', code: 'native_artifact_resource_registration_failed' });
            }
            const registration: Registration = {
                token,
                scope: Object.freeze({ ...materialization.persistent.scope }),
                persistentIdentity: identity,
                nativeRegistered: false,
                nativeRegistrationPending: false,
                revoked: false,
                subscriptions: [],
                listeners: new Set(),
                isCurrent: () => !registration.revoked && current(),
                revoke: () => revokeRegistration(registration),
            };
            registrationsByToken.set(token, registration);
            const identityKey = derivePluginUiPersistentArtifactKey(identity);
            const tokens = tokensByPersistentIdentity.get(identityKey) ?? new Set<string>();
            tokens.add(token);
            tokensByPersistentIdentity.set(identityKey, tokens);
            registration.subscriptions.push(materialization.lease.onRevoke(registration.revoke));
            registration.subscriptions.push(materialization.accountLifetime.onRetire(registration.revoke));
            if (!registration.isCurrent()) {
                registration.revoke();
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            let registrationResult: PluginNativeArtifactResourceRegistrationResult = Object.freeze({
                kind: 'unavailable',
                code: 'native_artifact_resource_registration_failed',
            });
            registration.nativeRegistrationPending = true;
            try {
                registrationResult = await input.registrar.register(Object.freeze({
                    token,
                    storagePartitionId: storagePartitionId(identity),
                    storageLocator: descriptor.locator,
                    resources,
                    policyTable: responseTable.table,
                }));
            } catch {
                // The registrar's result union remains fail-closed on a bridge error.
            } finally {
                registration.nativeRegistrationPending = false;
            }
            if (registrationResult.kind === 'registered') registration.nativeRegistered = true;
            if (registration.revoked) {
                registration.revoke();
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            if (registrationResult.kind !== 'registered') {
                registration.revoke();
                return registrationResult;
            }
            if (!registration.isCurrent()) {
                registration.revoke();
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            const handle: PluginNativeArtifactResourceHandle = Object.freeze({
                token,
                storagePartitionId: storagePartitionId(identity),
                ...(registrationResult.frameOrigin === undefined
                    ? {}
                    : { frameOrigin: registrationResult.frameOrigin }),
                policyTable: responseTable.table,
                isCurrent: () => {
                    if (!registration.isCurrent()) registration.revoke();
                    return !registration.revoked;
                },
                onRevoke: (listener) => {
                    if (registration.revoked) {
                        listener();
                        return Object.freeze({ dispose: () => {} });
                    }
                    registration.listeners.add(listener);
                    return Object.freeze({ dispose: () => registration.listeners.delete(listener) });
                },
                dispose: registration.revoke,
            });
            return Object.freeze({ kind: 'available', handle });
        },
    });
}
