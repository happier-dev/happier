import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isPluginError, PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import { type ResourceDescriptor as PluginResourceDescriptor, type PluginResourceKind, type ResourcesService as PluginResourcesService } from '@happier-dev/plugin-sdk/resources';
import type { PluginRuntimeRegistration } from '@happier-dev/plugin-sdk/host/registration';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import {
    createPluginContributionIdentity,
    isDynamicPluginResourceContributionV2,
    normalizeStrictJsonValue,
    pluginJsonValuesEqual,
    PluginDynamicResourceScopeV1Schema,
    PluginResourceKindV2Schema,
    PluginResourceContextV1Schema,
    PluginResourceSourceV2Schema,
    type PluginProjectionBrandAssetV2,
    type PluginDynamicResourceScopeV1,
    type JsonValue,
    type PluginResourceContextV1,
    type PluginUiResourceBindingCapabilityV1,
    type PluginResourceContributionV2,
    type PluginResourceSourceV2,
    type SessionAccessWitnessV1,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import {
    resolveContainedPluginResourcePath,
    resolvePluginResourcePath,
} from '@/plugins/projection/resources/package/resolve';
import { runWithOptionalTimeout } from '@/plugins/runtime/lifecycle/utils';
import type { ResolvedManifestHostAccessRequest } from '@/plugins/runtime/hostAccess/manifestRequests';
import {
    getActiveAccountSettingsSnapshotLifetimeToken,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    MAXIMUM_IMMUTABLE_GENERATION_FILES,
    type ImmutablePluginGenerationRecord,
} from '@/plugins/store/registry/generationStore';

export const MAX_PLUGIN_RESOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES = 64 * 1024 * 1024;
export const MAX_PLUGIN_RESOURCES_PER_GENERATION = 512;
// Exact dynamic Resource contexts are transient generation-owned state,
// so they use the incumbent generation Resource bound rather than a second
// externally configurable quota.
const MAX_PLUGIN_RESOURCE_ACTIVE_CONTEXTS = MAX_PLUGIN_RESOURCES_PER_GENERATION;
export const MAX_PLUGIN_BRAND_ICON_BYTES = 256 * 1024;
const MIN_PLUGIN_BRAND_ICON_DIMENSION = 64;
const MAX_PLUGIN_BRAND_ICON_DIMENSION = 512;

/**
 * Budget for the admission read of one dynamic producer, matching the other
 * plugin-callback budgets this runtime already applies (activation cleanup and
 * retirement both use 5s through the same owner). Plugins are trusted, but a
 * `read()` that never answers must not hold generation admission or reload
 * open forever. The mechanism is the shared plugin-callback timeout owner
 * (`runWithOptionalTimeout`); only the budget is named here.
 */
const DYNAMIC_RESOURCE_ADMISSION_TIMEOUT_MS = 5_000;

/**
 * A failed dynamic-watch settlement must not consume the only producer
 * invalidation forever. This is deliberately a modest bounded rate, kept in
 * the existing per-watch owner rather than a UI poller or another broker.
 */
const DYNAMIC_RESOURCE_SETTLE_RETRY_DELAY_MS = 250;

function computePluginResourceDigest(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

type ResourceGeneration = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    rootPath: string;
    files: ImmutablePluginGenerationRecord['files'];
    /** Optional manifest-declared local Resource id for the portable brand mark. */
    brandIconResourceId?: string;
}>;

type BindPluginResources = Readonly<{
    pluginId: string;
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
    /** Host-stamped exact target context; required only by contextual Resources. */
    context?: PluginResourceContextV1;
    /** Host-private one-shot proof; only `bindForResource` can mint it. */
    sessionAccessAdmission?: SessionResourceAccessAdmission;
    /** Host-private exact proof; only `bindForResource` can mint it for a mounted surface. */
    surfaceAccessAdmission?: SurfaceResourceAccessAdmission;
    /** Host-private terminal callback for one bound Session Resource watch. */
    onSessionResourceUnavailable?: () => void;
}>;

const sessionResourceAccessAdmissionBrand = Symbol('sessionResourceAccessAdmission');
const surfaceResourceAccessAdmissionBrand = Symbol('surfaceResourceAccessAdmission');

type SessionResourceAccessAdmission = Readonly<{
    readonly [sessionResourceAccessAdmissionBrand]: true;
    readonly accountId: string;
    readonly sessionId: string;
    readonly throughCursor: number;
}> & {
    revoked: boolean;
};

/**
 * A surface-context binding exists only while its exact mount is admitted by
 * the host Resource path. The opaque proof prevents raw service callers from
 * fabricating an otherwise valid-looking surface context.
 */
type SurfaceResourceAccessAdmission = Readonly<{
    readonly [surfaceResourceAccessAdmissionBrand]: true;
    readonly resource: AdmittedDynamicResource;
    readonly context: DynamicResourceContextState;
}>;

type AdmittedPackagedResource = Readonly<{
    source: 'packaged';
    descriptor: PluginResourceDescriptor;
    rootPath: string;
    relativePath: string;
    expectedSize: number;
    expectedDigest: string;
}>;

/**
 * A dynamic resource has no package file. Its observed digest/size are the
 * last bytes its producer returned through this owner — a *read* fact that
 * keeps `describe` honest and keeps the aggregate byte bound accurate.
 *
 * It is deliberately **not** the delivery fact: what each watcher has been
 * told lives on that watcher (`deliveredDigest`), because an ordinary read by
 * an unrelated caller must never satisfy or suppress an invalidation still
 * owed to an observer.
 */
type DynamicResourceContextState = {
    readonly context: PluginResourceContextV1;
    /** The Account-change access witness that admitted this exact Session context. */
    readonly sessionAccessAccountId: string | null;
    readonly sessionAccessWitnessCursor: number | null;
    /** Revoked with this exact Resource context; never retained as a Session inventory. */
    readonly sessionAccessAdmission: SessionResourceAccessAdmission | null;
    /** The sole active-Account lifetime that admitted this observed snapshot. */
    observedAccountLifetimeToken: number | null;
    observedDigest: string;
    observedSize: number;
    /** Exact live host bindings retaining a surface mount context. */
    surfaceBindingReferences: number;
};

type AdmittedDynamicResource = {
    readonly source: 'dynamic';
    readonly pluginId: string;
    readonly id: string;
    readonly kind: PluginResourceKind;
    readonly contentType: string;
    readonly maxBytes: number;
    readonly scope: PluginDynamicResourceScopeV1;
    readonly generation: string;
    readonly hostAccessRequests: readonly ResolvedManifestHostAccessRequest[];
    readonly runtime: PluginDynamicResourceRuntime;
    /** Global Resources retain the original admission observation for the generation. */
    globalContext: DynamicResourceContextState | null;
    /** Contextual state is nested under its Resource, never a global Session registry. */
    readonly sessionContexts: Map<string, DynamicResourceContextState>;
    /** Mounted surface state is nested under its Resource and keyed by host mount identity. */
    readonly surfaceContexts: Map<string, DynamicResourceContextState>;
};

type AdmittedResource = AdmittedPackagedResource | AdmittedDynamicResource;

function deepFreezeJson(value: JsonValue): JsonValue {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreezeJson(nested);
    return Object.freeze(value);
}

function createDynamicContextState(
    context: PluginResourceContextV1,
    sessionAccess?: Readonly<{
        accountId: string;
        throughCursor: number;
        admission: SessionResourceAccessAdmission;
    }>,
): DynamicResourceContextState {
    return {
        context: context.kind === 'session'
            ? Object.freeze({ kind: 'session' as const, sessionId: context.sessionId })
            : context.kind === 'surface'
                ? Object.freeze({
                    kind: 'surface' as const,
                    mountInstanceKey: context.mountInstanceKey,
                    launchInput: deepFreezeJson(normalizeStrictJsonValue(context.launchInput)),
                })
                : Object.freeze({ kind: 'global' as const }),
        sessionAccessAccountId: context.kind === 'session'
            ? sessionAccess?.accountId ?? null
            : null,
        sessionAccessWitnessCursor: context.kind === 'session'
            ? sessionAccess?.throughCursor ?? null
            : null,
        sessionAccessAdmission: context.kind === 'session'
            ? sessionAccess?.admission ?? null
            : null,
        observedAccountLifetimeToken: null,
        observedDigest: '',
        observedSize: 0,
        surfaceBindingReferences: 0,
    };
}

function resourceDescriptor(
    resource: AdmittedResource,
    dynamicContext?: DynamicResourceContextState,
): PluginResourceDescriptor {
    return resource.source === 'packaged'
        ? resource.descriptor
        : dynamicContext && dynamicContext.observedDigest !== ''
            ? Object.freeze({
            id: resource.id,
            kind: resource.kind,
            contentType: resource.contentType,
            digest: dynamicContext.observedDigest,
            size: dynamicContext.observedSize,
        })
            : fail('plugin_resource_context_unavailable', 'Resource context has no observed snapshot');
}

/**
 * One manifest-declared dynamic resource bound to the runtime producer its
 * plugin registered during activation (§3.6.1). Packaged resources have no
 * producer and never appear here.
 */
/** The registered runtime behind one dynamic resource, derived from the canonical registration union. */
type PluginDynamicResourceRuntime = Extract<PluginRuntimeRegistration, { family: 'resources' }>['value'];

export type StableDynamicPluginResourceProducer = Readonly<{
    pluginId: string;
    localId: string;
    hostAccessRequests?: readonly ResolvedManifestHostAccessRequest[];
    runtime: PluginDynamicResourceRuntime;
}>;

export type BindDynamicResourceAccountStorage = (input: Readonly<{
    pluginId: string;
    resourceId: string;
    generation: string;
    hostAccessRequests: readonly ResolvedManifestHostAccessRequest[];
    signal: AbortSignal;
    isGenerationCurrent(): boolean | Promise<boolean>;
}>) => PluginAccountStorageScope | undefined;

/**
 * The one bounded Resource availability fact a bound UI surface may consume.
 * It is derived from this full admitted registry only after its caller has
 * already selected the exact origin/generation binding; it deliberately carries
 * neither a Resource inventory nor that binding's identity.
 */
export type PluginUiResourceBindingCapability = PluginUiResourceBindingCapabilityV1;

/**
 * The Account-change carrier's one current Session-access proof. Omitting the
 * additive witness represents a supported older server and fails closed only
 * Session-scoped Resource operations.
 */
export type ResourceSessionAccessWitness = Readonly<{
    accountId: string;
    witness?: SessionAccessWitnessV1;
}>;

/**
 * Exact server-owned Session access proof for one new contextual Resource
 * admission. It is not a Resource inventory: the caller asks only for the
 * Session it is about to bind, and the resulting proof is consumed by that
 * binding rather than retained as a cross-session cache.
 */
export type ResolveSessionResourceAccess = (params: Readonly<{
    accountId: string;
    sessionId: string;
    signal: AbortSignal;
}>) => Promise<Readonly<{
    accountId: string;
    throughCursor: number;
    status: 'available' | 'unavailable';
}>>;

export type StablePluginResourcesOwner = Readonly<{
    hasPlugin(pluginId: string): boolean;
    getPluginUiResourceCapability(pluginId: string): PluginUiResourceBindingCapability;
    /** Immutable metadata only; never a byte, path, URL, or cache authority. */
    getPluginBrandAsset(pluginId: string): PluginProjectionBrandAssetV2 | undefined;
    bind(params: BindPluginResources): PluginResourcesService;
    /**
     * Asynchronously binds the exact Resource requested by a host surface.
     * Contextual dynamic Resources receive the host-private proof their scope
     * requires; other Resource kinds keep the ordinary synchronous bind path.
     */
    bindForResource(params: BindPluginResources & Readonly<{ resourceId: string }>): Promise<PluginResourcesService>;
    /** Applies the canonical Account-change Session-access witness before its cursor is acknowledged. */
    applySessionAccessWitness(params: ResourceSessionAccessWitness): void;
    retirePlugin(pluginId: string): void;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

async function withStableResourceErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (isPluginError(error)) throw error;
        throw new PluginError({ code: 'plugin_resource_io_failed', message: 'Resource operation failed' }, { cause: error });
    }
}

function ownData(value: unknown, key: string): unknown {
    if (typeof value !== 'object' || value === null) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return descriptor.value;
}

function boundedString(value: unknown, maxLength = 2_048): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maxLength) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return value;
}

function resourceKind(value: unknown): PluginResourceKind {
    const parsed = PluginResourceKindV2Schema.safeParse(value);
    if (!parsed.success) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return parsed.data;
}

function optionalDigest(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const digest = boundedString(value, 256);
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return digest;
}

type NormalizedResourceContribution = Readonly<{
    pluginId: string;
    pluginRootPath: string;
    id: string;
    kind: PluginResourceKind;
    source: PluginResourceSourceV2;
    scope: PluginDynamicResourceScopeV1 | null;
    hostAccess: readonly string[];
    path: string | null;
    contentType: string;
    digest: string | null;
    maxBytes: number | null;
}>;

function resourceSource(value: unknown): PluginResourceSourceV2 {
    if (value === undefined || value === null) return 'packaged';
    const parsed = PluginResourceSourceV2Schema.safeParse(value);
    if (!parsed.success) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return parsed.data;
}

function dynamicScope(value: unknown): PluginDynamicResourceScopeV1 {
    if (value === undefined || value === null) return 'global';
    const parsed = PluginDynamicResourceScopeV1Schema.safeParse(value);
    if (!parsed.success) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return parsed.data;
}

function dynamicReadLimit(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value <= 0
        || value > MAX_PLUGIN_RESOURCE_BYTES) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return value;
}

function dynamicHostAccess(value: unknown): readonly string[] {
    if (value === undefined || value === null) return Object.freeze([]);
    if (!Array.isArray(value) || value.length === 0) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    const ids = value.map((entry) => boundedString(entry, 256));
    if (new Set(ids).size !== ids.length) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return Object.freeze(ids);
}

function normalizeContribution(
    raw: ResolvedResourceContribution,
): NormalizedResourceContribution {
    try {
        const pluginId = boundedString(ownData(raw, 'pluginId'), 256);
        const pluginRootPath = boundedString(ownData(raw, 'pluginRootPath'), 4_096);
        boundedString(ownData(raw, 'manifestPath'), 4_096);
        const provenance = ownData(raw, 'provenance');
        if (provenance !== 'first_party' && provenance !== 'external') {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const source = ownData(raw, 'source');
        const sourceKind = boundedString(ownData(source, 'kind'), 32);
        if (!['bundled', 'path', 'archive', 'marketplace', 'package'].includes(sourceKind)) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const sourceSpec = ownData(raw, 'sourceSpec');
        if (boundedString(ownData(sourceSpec, 'kind'), 32) !== sourceKind) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        boundedString(ownData(sourceSpec, 'locator'), 4_096);
        const trustPolicy = boundedString(ownData(sourceSpec, 'trustPolicy'), 32);
        const installPolicy = boundedString(ownData(sourceSpec, 'installPolicy'), 32);
        if (!['local_trusted', 'prompt', 'untrusted'].includes(trustPolicy)
            || !['link', 'copy', 'managed_install'].includes(installPolicy)) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const definition = ownData(raw, 'definition');
        if (ownData(definition, 'kindVersion') !== 1) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const identity = createPluginContributionIdentity({
            pluginId,
            localId: boundedString(ownData(definition, 'id'), 256),
        });
        const declaredSource: PluginResourceSourceV2 = resourceSource(
            Object.getOwnPropertyDescriptor(definition, 'source')?.value,
        );
        return Object.freeze({
            pluginId: identity.pluginId,
            pluginRootPath,
            id: identity.localId,
            kind: resourceKind(ownData(definition, 'type')),
            source: declaredSource,
            scope: declaredSource === 'dynamic'
                ? dynamicScope(Object.getOwnPropertyDescriptor(definition, 'scope')?.value)
                : null,
            hostAccess: declaredSource === 'dynamic'
                ? dynamicHostAccess(Object.getOwnPropertyDescriptor(definition, 'hostAccess')?.value)
                : Object.freeze([]),
            path: declaredSource === 'dynamic' ? null : boundedString(ownData(definition, 'path'), 4_096),
            contentType: boundedString(ownData(definition, 'contentType'), 512),
            digest: declaredSource === 'dynamic'
                ? null
                : optionalDigest(Object.getOwnPropertyDescriptor(definition, 'digest')?.value),
            maxBytes: declaredSource === 'dynamic'
                ? dynamicReadLimit(Object.getOwnPropertyDescriptor(definition, 'maxBytes')?.value)
                : null,
        });
    } catch (error) {
        if (isPluginError(error)) throw error;
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
}

function normalizeImmutableContribution(params: Readonly<{
    pluginId: string;
    pluginRootPath: string;
    declaration: PluginResourceContributionV2;
}>): NormalizedResourceContribution {
    try {
        const identity = createPluginContributionIdentity({
            pluginId: boundedString(params.pluginId, 256),
            localId: boundedString(
                ownData(params.declaration, 'id'),
                256,
            ),
        });
        const declaredSource: PluginResourceSourceV2 = resourceSource(
            Object.getOwnPropertyDescriptor(params.declaration, 'source')?.value,
        );
        return Object.freeze({
            pluginId: identity.pluginId,
            pluginRootPath: boundedString(
                params.pluginRootPath,
                4_096,
            ),
            id: identity.localId,
            kind: resourceKind(
                ownData(params.declaration, 'kind'),
            ),
            source: declaredSource,
            scope: declaredSource === 'dynamic'
                ? dynamicScope(Object.getOwnPropertyDescriptor(params.declaration, 'scope')?.value)
                : null,
            hostAccess: declaredSource === 'dynamic'
                ? dynamicHostAccess(Object.getOwnPropertyDescriptor(params.declaration, 'hostAccess')?.value)
                : Object.freeze([]),
            path: declaredSource === 'dynamic'
                ? null
                : boundedString(
                    ownData(params.declaration, 'path'),
                    4_096,
                ),
            contentType: boundedString(
                ownData(params.declaration, 'contentType'),
                512,
            ),
            digest: declaredSource === 'dynamic'
                ? null
                : optionalDigest(
                    Object.getOwnPropertyDescriptor(
                        params.declaration,
                        'digest',
                    )?.value,
                ),
            maxBytes: declaredSource === 'dynamic'
                ? dynamicReadLimit(
                    Object.getOwnPropertyDescriptor(
                        params.declaration,
                        'maxBytes',
                    )?.value,
                )
                : null,
        });
    } catch (error) {
        if (isPluginError(error)) throw error;
        return fail(
            'plugin_resource_declaration_invalid',
            'Resource declaration is invalid',
        );
    }
}

function normalizeGeneration(raw: ResourceGeneration): Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    rootPath: string;
    filesByPath: ReadonlyMap<string, ImmutablePluginGenerationRecord['files'][number]>;
    brandIconResourceId: string | null;
}> {
    try {
        const pluginId = boundedString(ownData(raw, 'pluginId'), 256);
        const immutableGenerationId = boundedString(ownData(raw, 'immutableGenerationId'), 160);
        const rootPath = boundedString(ownData(raw, 'rootPath'), 4_096);
        const brandIconResourceIdDescriptor = Object.getOwnPropertyDescriptor(raw, 'brandIconResourceId');
        if (brandIconResourceIdDescriptor && !('value' in brandIconResourceIdDescriptor)) {
            return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
        }
        const brandIconResourceId = brandIconResourceIdDescriptor
            ? boundedString(brandIconResourceIdDescriptor.value, 256)
            : null;
        const files = ownData(raw, 'files');
        if (!Array.isArray(files) || files.length > MAXIMUM_IMMUTABLE_GENERATION_FILES) {
            return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
        }
        const filesByPath = new Map<string, ImmutablePluginGenerationRecord['files'][number]>();
        for (const rawFile of files) {
            const relativePath = boundedString(ownData(rawFile, 'relativePath'), 512);
            const byteLength = ownData(rawFile, 'byteLength');
            if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
                return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
            }
            if (filesByPath.has(relativePath)) {
                return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
            }
            filesByPath.set(relativePath, Object.freeze({ relativePath, byteLength: byteLength as number }));
        }
        return Object.freeze({
            pluginId,
            immutableGenerationId,
            rootPath,
            filesByPath: Object.freeze(filesByPath),
            brandIconResourceId,
        });
    } catch (error) {
        if (isPluginError(error)) throw error;
        return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
    }
}

function brandAssetFallback(
    state: 'missing' | 'invalid' | 'retired',
): PluginProjectionBrandAssetV2 {
    switch (state) {
        case 'missing':
            return Object.freeze({ state: 'missing' });
        case 'invalid':
            return Object.freeze({ state: 'invalid' });
        case 'retired':
            return Object.freeze({ state: 'retired' });
    }
}

function brandAssetFallbackForAdmissionError(error: unknown): PluginProjectionBrandAssetV2 {
    if (
        isPluginError(error)
        && (error.code === 'plugin_resource_missing' || error.code === 'plugin_resource_file_not_declared')
    ) {
        return brandAssetFallback('missing');
    }
    return brandAssetFallback('invalid');
}

async function decodePortablePluginBrandPng(
    bytes: Uint8Array,
): Promise<Readonly<{ width: number; height: number }> | null> {
    if (bytes.byteLength > MAX_PLUGIN_BRAND_ICON_BYTES) return null;
    try {
        const sharp = (await import('sharp')).default;
        const image = sharp(Buffer.from(bytes), {
            failOn: 'error',
            limitInputPixels: MAX_PLUGIN_BRAND_ICON_DIMENSION ** 2,
        });
        const metadata = await image.metadata();
        const width = metadata.width;
        const height = metadata.height;
        if (
            metadata.format !== 'png'
            || !Number.isSafeInteger(width)
            || !Number.isSafeInteger(height)
            || width !== height
            || width < MIN_PLUGIN_BRAND_ICON_DIMENSION
            || width > MAX_PLUGIN_BRAND_ICON_DIMENSION
        ) {
            return null;
        }
        // Metadata alone need not prove the compressed image data is decodable.
        // Decode the bounded image through the package's existing image owner.
        const decoded = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (decoded.info.width !== width || decoded.info.height !== height) return null;
        return Object.freeze({ width, height });
    } catch {
        return null;
    }
}

async function resolveAdmittedPath(rootPath: string, relativePath: string): Promise<string> {
    const lexical = resolvePluginResourcePath({ pluginRootPath: rootPath, resourcePath: relativePath });
    if (!lexical) return fail('plugin_resource_path_denied', 'Resource path is denied');
    const contained = await resolveContainedPluginResourcePath({ pluginRootPath: rootPath, resourcePath: relativePath });
    if (!contained) {
        try {
            const info = await lstat(lexical.absolutePath);
            if (info.isSymbolicLink()) return fail('plugin_resource_path_denied', 'Resource path is denied');
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                return fail('plugin_resource_missing', 'Resource bytes are missing');
            }
        }
        return fail('plugin_resource_path_denied', 'Resource path is denied');
    }
    const canonicalRoot = await realpath(resolve(rootPath)).catch(() => fail('plugin_resource_generation_invalid', 'Resource generation root is unavailable'));
    if (contained.absolutePath !== resolve(canonicalRoot, ...contained.relativePath.split('/'))) {
        return fail('plugin_resource_path_denied', 'Resource path is denied');
    }
    const info = await lstat(contained.absolutePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return fail('plugin_resource_missing', 'Resource bytes are missing');
        }
        throw error;
    });
    if (info.isSymbolicLink()) return fail('plugin_resource_path_denied', 'Resource path is denied');
    if (!info.isFile()) return fail('plugin_resource_unsupported_kind', 'Resource entry kind is unsupported');
    return contained.absolutePath;
}

async function readPackagedResourceBytes(
    rootPath: string,
    relativePath: string,
    expectedSize: number,
    maxBytes: number,
    guard: () => void,
): Promise<Uint8Array> {
    guard();
    const absolutePath = await resolveAdmittedPath(rootPath, relativePath);
    const handle = await open(absolutePath, 'r').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return fail('plugin_resource_missing', 'Resource bytes are missing');
        }
        throw error;
    });
    try {
        const info = await handle.stat();
        if (!info.isFile()) return fail('plugin_resource_unsupported_kind', 'Resource entry kind is unsupported');
        if (expectedSize > maxBytes || info.size > maxBytes) {
            return fail('plugin_resource_too_large', 'Resource read exceeds its byte limit');
        }
        if (info.size !== expectedSize) {
            return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted generation');
        }
        const bytes = new Uint8Array(await handle.readFile());
        guard();
        if (bytes.byteLength !== expectedSize) {
            return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted generation');
        }
        return bytes;
    } finally {
        await handle.close();
    }
}

async function verifyBytes(resource: AdmittedPackagedResource, maxBytes: number, guard: () => void): Promise<Uint8Array> {
    const bytes = await readPackagedResourceBytes(
        resource.rootPath,
        resource.relativePath,
        resource.expectedSize,
        maxBytes,
        guard,
    );
    if (computePluginResourceDigest(bytes) !== resource.expectedDigest) {
        return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted generation');
    }
    return bytes;
}

function normalizeProducedBytes(value: unknown): Uint8Array {
    if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'utf8'));
    if (value instanceof Uint8Array) return new Uint8Array(value);
    return fail('plugin_resource_producer_invalid', 'Dynamic resource producer returned unsupported bytes');
}

/**
 * The one bytes path for a dynamic resource. It applies the same byte ceiling
 * and canonical digest the packaged arm gets, so `readResource` stays the
 * single snapshot authority for both arms.
 */
async function readDynamicBytes(
    resource: AdmittedDynamicResource,
    context: DynamicResourceContextState,
    maxBytes: number,
    guard: () => void,
    signal: AbortSignal,
    isGenerationCurrent: () => boolean | Promise<boolean>,
    bindAccountStorage?: BindDynamicResourceAccountStorage,
): Promise<Readonly<{ bytes: Uint8Array; digest: string }>> {
    guard();
    const limit = Math.min(maxBytes, resource.maxBytes);
    const accountStorage = bindAccountStorage?.({
        pluginId: resource.pluginId,
        resourceId: resource.id,
        generation: resource.generation,
        hostAccessRequests: resource.hostAccessRequests,
        signal,
        isGenerationCurrent,
    });
    if (
        accountStorage === undefined
        && resource.hostAccessRequests.some((request) => request.required)
    ) {
        return fail('plugin_account_storage_unavailable', 'Plugin Account storage is unavailable');
    }
    const runtimeOptions = Object.freeze({
        signal,
        context: context.context,
        ...(accountStorage === undefined ? {} : { accountStorage }),
    });
    const produced = await withStableResourceErrors(async () => await resource.runtime.read(
        runtimeOptions,
    ));
    guard();
    const bytes = normalizeProducedBytes(produced);
    if (bytes.byteLength > limit) {
        return fail('plugin_resource_too_large', 'Resource read exceeds its byte limit');
    }
    return Object.freeze({ bytes, digest: computePluginResourceDigest(bytes) });
}

/**
 * The admission read of one dynamic producer, bounded through the shared
 * plugin-callback timeout owner. Cancellation is delivered to the producer as
 * an abort signal rather than only abandoned, so a well-behaved `read()` can
 * release whatever it was waiting on.
 */
async function readAdmissionBytes(
    resource: AdmittedDynamicResource,
    context: DynamicResourceContextState,
    bindAccountStorage?: BindDynamicResourceAccountStorage,
    isCommittedGenerationCurrent?: () => boolean | Promise<boolean>,
): Promise<Readonly<{ bytes: Uint8Array; digest: string }>> {
    const controller = new AbortController();
    let committedGenerationCurrent = true;
    const isLiveCommittedGenerationCurrent = async (): Promise<boolean> => (
        !controller.signal.aborted
        && (isCommittedGenerationCurrent === undefined || await isCommittedGenerationCurrent())
    );
    const assertCommittedGenerationCurrent = async (): Promise<void> => {
        committedGenerationCurrent = await isLiveCommittedGenerationCurrent();
        if (!committedGenerationCurrent) {
            return fail('plugin_generation_stale', 'Plugin generation is stale');
        }
    };
    try {
        await assertCommittedGenerationCurrent();
        return await runWithOptionalTimeout(
            DYNAMIC_RESOURCE_ADMISSION_TIMEOUT_MS,
            async () => {
                const observed = await readDynamicBytes(
                    resource,
                    context,
                    MAX_PLUGIN_RESOURCE_BYTES,
                    () => {
                        if (!committedGenerationCurrent || controller.signal.aborted) {
                            return fail('plugin_generation_stale', 'Plugin generation is stale');
                        }
                    },
                    controller.signal,
                    isLiveCommittedGenerationCurrent,
                    bindAccountStorage,
                );
                await assertCommittedGenerationCurrent();
                return observed;
            },
            () => new PluginError({
                code: 'plugin_resource_producer_timed_out',
                message: 'Dynamic resource producer did not answer within its admission budget',
            }),
        );
    } catch (error) {
        controller.abort(error);
        throw error;
    } finally {
        // Account storage is vended only for this admission callback. Any
        // scope retained by plugin code becomes unusable as soon as it settles.
        controller.abort();
    }
}

function readLimit(value: unknown): number {
    if (value === undefined) return MAX_PLUGIN_RESOURCE_BYTES;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_PLUGIN_RESOURCE_BYTES) {
        return fail('plugin_resource_limit_invalid', 'Resource byte limit is invalid');
    }
    return value;
}

function normalizeReadOptions(options: { maxBytes?: number; signal?: AbortSignal } | undefined): Readonly<{
    maxBytes: number;
    signal?: AbortSignal;
}> {
    if (options === undefined) return Object.freeze({ maxBytes: MAX_PLUGIN_RESOURCE_BYTES });
    try {
        if (typeof options !== 'object' || options === null) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        const prototype = Object.getPrototypeOf(options);
        if (prototype !== Object.prototype && prototype !== null) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        const maxBytesDescriptor = Object.getOwnPropertyDescriptor(options, 'maxBytes');
        const signalDescriptor = Object.getOwnPropertyDescriptor(options, 'signal');
        if (
            (maxBytesDescriptor && !('value' in maxBytesDescriptor))
            || (signalDescriptor && !('value' in signalDescriptor))
        ) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        const maxBytes = readLimit(maxBytesDescriptor?.value);
        const signal = signalDescriptor?.value;
        if (signal !== undefined && !(signal instanceof AbortSignal)) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        return Object.freeze({ maxBytes, ...(signal ? { signal } : {}) });
    } catch (error) {
        if (isPluginError(error)) throw error;
        return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
    }
}

export async function createStablePluginResourcesOwner(params: Readonly<{
    registry: Pick<ResolvedContributionRegistry, 'resources'>;
    generations: ReadonlyMap<string, ResourceGeneration>;
    immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
    dynamicProducers?: readonly StableDynamicPluginResourceProducer[];
    bindDynamicResourceAccountStorage?: BindDynamicResourceAccountStorage;
    resolveSessionResourceAccess?: ResolveSessionResourceAccess;
    isCommittedGenerationCurrent?: () => boolean | Promise<boolean>;
}>): Promise<StablePluginResourcesOwner> {
    if (!Array.isArray(params.registry.resources) || params.registry.resources.length > MAX_PLUGIN_RESOURCES_PER_GENERATION) {
        return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its declaration bound');
    }

    return await createStablePluginResourcesOwnerFromNormalized({
        contributions: params.registry.resources.map(
            normalizeContribution,
        ),
        generations: params.generations,
        ...(params.immutableGenerationIdsByPluginId
            ? { immutableGenerationIdsByPluginId: params.immutableGenerationIdsByPluginId }
            : {}),
        dynamicProducers: params.dynamicProducers ?? [],
        ...(params.bindDynamicResourceAccountStorage
            ? { bindDynamicResourceAccountStorage: params.bindDynamicResourceAccountStorage }
            : {}),
        ...(params.resolveSessionResourceAccess
            ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
            : {}),
        ...(params.isCommittedGenerationCurrent
            ? {
                isCommittedGenerationCurrent:
                    params.isCommittedGenerationCurrent,
            }
            : {}),
    });
}

export async function createStableImmutablePluginResourcesOwner(
    params: Readonly<{
        generationId: string;
        pluginId: string;
        rootPath: string;
        files: ImmutablePluginGenerationRecord['files'];
        declarations: readonly PluginResourceContributionV2[];
        brandIconResourceId?: string;
        dynamicProducers?: readonly StableDynamicPluginResourceProducer[];
        bindDynamicResourceAccountStorage?: BindDynamicResourceAccountStorage;
        resolveSessionResourceAccess?: ResolveSessionResourceAccess;
        isGenerationCurrent?: () => boolean | Promise<boolean>;
    }>,
): Promise<StablePluginResourcesOwner> {
    if (
        !Array.isArray(params.declarations)
        || params.declarations.length
            > MAX_PLUGIN_RESOURCES_PER_GENERATION
    ) {
        return fail(
            'plugin_resource_capacity_exceeded',
            'Resource generation exceeds its declaration bound',
        );
    }
    return await createStablePluginResourcesOwnerFromNormalized({
        contributions: params.declarations.map((declaration) =>
            normalizeImmutableContribution({
                pluginId: params.pluginId,
                pluginRootPath: params.rootPath,
                declaration,
            }),
        ),
        generations: new Map([[
            params.pluginId,
            Object.freeze({
                pluginId: params.pluginId,
                immutableGenerationId: params.generationId,
                rootPath: params.rootPath,
                files: params.files,
                ...(params.brandIconResourceId === undefined
                    ? {}
                    : { brandIconResourceId: params.brandIconResourceId }),
            }),
        ]]),
        dynamicProducers: params.dynamicProducers ?? [],
        ...(params.bindDynamicResourceAccountStorage
            ? { bindDynamicResourceAccountStorage: params.bindDynamicResourceAccountStorage }
            : {}),
        ...(params.resolveSessionResourceAccess
            ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
            : {}),
        ...(params.isGenerationCurrent
            ? {
                isCommittedGenerationCurrent:
                    params.isGenerationCurrent,
            }
            : {}),
    });
}

async function createStablePluginResourcesOwnerFromNormalized(
    params: Readonly<{
        contributions: readonly NormalizedResourceContribution[];
        generations: ReadonlyMap<string, ResourceGeneration>;
        immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
        dynamicProducers: readonly StableDynamicPluginResourceProducer[];
        bindDynamicResourceAccountStorage?: BindDynamicResourceAccountStorage;
        resolveSessionResourceAccess?: ResolveSessionResourceAccess;
        isCommittedGenerationCurrent?:
            () => boolean | Promise<boolean>;
    }>,
): Promise<StablePluginResourcesOwner> {
    const generationsByPluginId = new Map<string, ReturnType<typeof normalizeGeneration>>();
    const immutableGenerationIdsByPluginId = new Map<string, string>();
    for (const [pluginId, rawGeneration] of params.generations) {
        const generation = normalizeGeneration(rawGeneration);
        if (generation.pluginId !== pluginId) {
            return fail('plugin_resource_generation_invalid', 'Resource generation identity does not match its declaration');
        }
        generationsByPluginId.set(pluginId, generation);
        immutableGenerationIdsByPluginId.set(pluginId, generation.immutableGenerationId);
    }
    for (const [pluginId, immutableGenerationId] of params.immutableGenerationIdsByPluginId ?? []) {
        const normalizedPluginId = boundedString(pluginId, 256);
        const normalizedGenerationId = boundedString(immutableGenerationId, 160);
        const existingGenerationId = immutableGenerationIdsByPluginId.get(normalizedPluginId);
        if (existingGenerationId && existingGenerationId !== normalizedGenerationId) {
            return fail('plugin_resource_generation_invalid', 'Resource generation identity does not match its declaration');
        }
        immutableGenerationIdsByPluginId.set(normalizedPluginId, normalizedGenerationId);
    }

    const admittedByPlugin = new Map<string, Map<string, AdmittedResource>>();
    const brandAssetsByPluginId = new Map<string, PluginProjectionBrandAssetV2>();
    for (const [pluginId, generation] of generationsByPluginId) {
        if (generation.brandIconResourceId !== null) {
            // A declaration without an admitted matching file remains a
            // display-only fallback; it must not make the plugin unavailable.
            brandAssetsByPluginId.set(pluginId, brandAssetFallback('missing'));
        }
    }
    const admittedDynamicResources: AdmittedDynamicResource[] = [];
    const producersByKey = new Map<string, StableDynamicPluginResourceProducer>();
    for (const producer of params.dynamicProducers) {
        producersByKey.set(`${producer.pluginId}\u0000${producer.localId}`, producer);
    }
    let aggregateBytes = 0;
    let activeDynamicResourceContexts = 0;
    for (const contribution of params.contributions) {
        if (!immutableGenerationIdsByPluginId.has(contribution.pluginId)) {
            return fail('plugin_resource_generation_invalid', 'Resource generation is unavailable');
        }
        const generation = generationsByPluginId.get(contribution.pluginId);
        const isBrandResource = generation?.brandIconResourceId === contribution.id;
        if (contribution.source === 'dynamic') {
            if (isBrandResource) {
                brandAssetsByPluginId.set(contribution.pluginId, brandAssetFallback('invalid'));
            }
            const producer = producersByKey.get(`${contribution.pluginId}\u0000${contribution.id}`);
            if (!producer) {
                return fail(
                    'plugin_resource_producer_unavailable',
                    'Dynamic resource has no registered runtime producer',
                );
            }
            const hostAccessRequests = Object.freeze([...(producer.hostAccessRequests ?? [])]);
            if (
                hostAccessRequests.some((entry) => entry.request.capability !== 'storage.account')
                || hostAccessRequests.length !== contribution.hostAccess.length
                || hostAccessRequests.some((entry, index) => (
                    entry.request.id !== contribution.hostAccess[index]
                ))
            ) {
                return fail(
                    'plugin_resource_declaration_invalid',
                    'Dynamic Resource HostAccess does not match its admitted declaration',
                );
            }
            const dynamic: AdmittedDynamicResource = {
                source: 'dynamic',
                pluginId: contribution.pluginId,
                id: contribution.id,
                kind: contribution.kind,
                contentType: contribution.contentType,
                maxBytes: contribution.maxBytes ?? MAX_PLUGIN_RESOURCE_BYTES,
                scope: contribution.scope ?? fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid'),
                generation: immutableGenerationIdsByPluginId.get(contribution.pluginId)
                    ?? fail('plugin_resource_generation_invalid', 'Resource generation is unavailable'),
                hostAccessRequests,
                runtime: producer.runtime,
                globalContext: contribution.scope === 'global'
                    ? createDynamicContextState({ kind: 'global' })
                    : null,
                sessionContexts: new Map(),
                surfaceContexts: new Map(),
            };
            admittedDynamicResources.push(dynamic);
            const dynamicById = admittedByPlugin.get(contribution.pluginId) ?? new Map<string, AdmittedResource>();
            if (dynamicById.has(contribution.id)) {
                return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
            }
            dynamicById.set(contribution.id, dynamic);
            admittedByPlugin.set(contribution.pluginId, dynamicById);
            continue;
        }
        if (!generation) return fail('plugin_resource_generation_invalid', 'Resource generation is unavailable');
        try {
            let qualifiesAsBrand = isBrandResource;
            if (
                isBrandResource
                && (contribution.kind !== 'asset' || contribution.contentType !== 'image/png')
            ) {
                brandAssetsByPluginId.set(contribution.pluginId, brandAssetFallback('invalid'));
                qualifiesAsBrand = false;
            }
            if (resolve(generation.rootPath) !== resolve(contribution.pluginRootPath)) {
                return fail('plugin_resource_generation_invalid', 'Resource generation provenance does not match its declaration');
            }
            const lexical = resolvePluginResourcePath({ pluginRootPath: generation.rootPath, resourcePath: contribution.path ?? '' });
            if (!lexical) return fail('plugin_resource_path_denied', 'Resource path is denied');
            const file = generation.filesByPath.get(lexical.relativePath);
            if (!file) {
                await resolveAdmittedPath(generation.rootPath, lexical.relativePath);
                return fail('plugin_resource_file_not_declared', 'Resource path is not part of the admitted generation');
            }
            if (qualifiesAsBrand && file.byteLength > MAX_PLUGIN_BRAND_ICON_BYTES) {
                brandAssetsByPluginId.set(contribution.pluginId, brandAssetFallback('invalid'));
                qualifiesAsBrand = false;
            }
            if (file.byteLength > MAX_PLUGIN_RESOURCE_BYTES) {
                return fail('plugin_resource_capacity_exceeded', 'Resource exceeds its admitted byte bound');
            }
            if (aggregateBytes + file.byteLength > MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES) {
                return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its aggregate byte bound');
            }
            const admittedBytes = await withStableResourceErrors(() => readPackagedResourceBytes(
                generation.rootPath,
                lexical.relativePath,
                file.byteLength,
                MAX_PLUGIN_RESOURCE_BYTES,
                () => undefined,
            ));
            const expectedDigest = computePluginResourceDigest(admittedBytes);
            if (contribution.digest && contribution.digest !== expectedDigest) {
                return fail('plugin_resource_integrity_mismatch', 'Resource digest does not match the admitted generation');
            }
            const dimensions = qualifiesAsBrand
                ? await decodePortablePluginBrandPng(admittedBytes)
                : null;
            if (qualifiesAsBrand && !dimensions) {
                brandAssetsByPluginId.set(contribution.pluginId, brandAssetFallback('invalid'));
            }
            const descriptor = Object.freeze({
                id: contribution.id,
                kind: contribution.kind,
                contentType: contribution.contentType,
                digest: expectedDigest,
                size: file.byteLength,
            });
            const admitted: AdmittedPackagedResource = Object.freeze({
                source: 'packaged' as const,
                descriptor,
                rootPath: generation.rootPath,
                relativePath: lexical.relativePath,
                expectedSize: file.byteLength,
                expectedDigest,
            });
            const byId = admittedByPlugin.get(contribution.pluginId) ?? new Map<string, AdmittedResource>();
            if (byId.has(contribution.id)) {
                return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
            }
            byId.set(contribution.id, admitted);
            admittedByPlugin.set(contribution.pluginId, byId);
            aggregateBytes += file.byteLength;
            if (dimensions) {
                brandAssetsByPluginId.set(contribution.pluginId, Object.freeze({
                    state: 'available',
                    resource: Object.freeze({
                        pluginId: contribution.pluginId,
                        localId: contribution.id,
                    }),
                    width: dimensions.width,
                    height: dimensions.height,
                    digest: expectedDigest,
                }));
            }
        } catch (error) {
            if (isBrandResource) {
                brandAssetsByPluginId.set(
                    contribution.pluginId,
                    brandAssetFallbackForAdmissionError(error),
                );
                continue;
            }
            throw error;
        }
    }
    /**
     * The aggregate byte bound is a live fact, not an admission-time snapshot:
     * a dynamic producer can grow after admission. Every observation of dynamic
     * bytes is admitted here by size delta, and a breach retains the last known
     * good observation rather than publishing a descriptor this generation is
     * not allowed to hold.
     */
    function captureDynamicResourceAccountLifetime(
        resource: AdmittedDynamicResource,
    ): number | null {
        return resource.hostAccessRequests.length > 0
            ? getActiveAccountSettingsSnapshotLifetimeToken()
            : null;
    }

    function isDynamicResourceAccountLifetimeCurrent(
        resource: AdmittedDynamicResource,
        accountLifetimeToken: number | null,
    ): boolean {
        return resource.hostAccessRequests.length === 0
            || (
                accountLifetimeToken !== null
                && accountLifetimeToken === getActiveAccountSettingsSnapshotLifetimeToken()
            );
    }

    function retireStaleAccountBoundDynamicObservation(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): void {
        if (
            context.observedDigest === ''
            || isDynamicResourceAccountLifetimeCurrent(resource, context.observedAccountLifetimeToken)
        ) {
            return;
        }
        aggregateBytes -= context.observedSize;
        context.observedAccountLifetimeToken = null;
        context.observedSize = 0;
        context.observedDigest = '';
    }

    function admitDynamicObservation(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        observed: Readonly<{ bytes: Uint8Array; digest: string }>,
        accountLifetimeToken: number | null,
    ): boolean {
        if (!isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)) return false;
        const delta = observed.bytes.byteLength - context.observedSize;
        if (delta > 0 && aggregateBytes + delta > MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES) {
            return false;
        }
        aggregateBytes += delta;
        context.observedAccountLifetimeToken = accountLifetimeToken;
        context.observedDigest = observed.digest;
        context.observedSize = observed.bytes.byteLength;
        return true;
    }

    // Global dynamic Resources retain their established admission behavior. A
    // session-scoped declaration is structural only: its producer receives no
    // call until an exact host Session binding owns a read or watch.
    for (const dynamic of admittedDynamicResources) {
        const context = dynamic.globalContext;
        if (!context) continue;
        const accountLifetimeToken = captureDynamicResourceAccountLifetime(dynamic);
        const isAdmissionCurrent = async (): Promise<boolean> => {
            if (!isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken)) return false;
            if (params.isCommittedGenerationCurrent && !await params.isCommittedGenerationCurrent()) {
                return false;
            }
            return isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken);
        };
        let observed: Readonly<{ bytes: Uint8Array; digest: string }>;
        try {
            observed = await readAdmissionBytes(
                dynamic,
                context,
                params.bindDynamicResourceAccountStorage,
                isAdmissionCurrent,
            );
        } catch (error) {
            // The sole active Account lifetime changed while this callback was
            // in flight. Its old bytes are not an admission failure for B and
            // must not become a B descriptor.
            if (!isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken)) continue;
            // A fresh Account can publish the admitted declaration before its
            // Account Data contract is readable. Keep the declaration and its
            // truthful method capability, but do not manufacture an initial
            // descriptor/snapshot. Every other admission failure stays fatal.
            if (!isPendingInitialAccountDataUnavailable(dynamic, error)) throw error;
            continue;
        }
        if (!isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken)) continue;
        if (!admitDynamicObservation(dynamic, context, observed, accountLifetimeToken)) {
            return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its aggregate byte bound');
        }
    }

    const retiredPluginIds = new Set<string>();
    const admittedPluginIds = new Set(immutableGenerationIdsByPluginId.keys());

    type DynamicWatcher = {
        readonly listener: (change: { digest: string }) => void;
        readonly isCurrent: () => boolean;
        /** Drops this watch's ownership of a session context exactly once. */
        readonly releaseContext: () => void;
        /** Ends the exact host watch when its Session context is retired. */
        readonly onSessionResourceUnavailable?: () => void;
        deliveredDigest: string;
    };
    type DynamicWatch = {
        readonly resource: AdmittedDynamicResource;
        readonly context: DynamicResourceContextState;
        readonly watchers: Set<DynamicWatcher>;
        /** Cancels every settlement read when this exact watch loses ownership. */
        readonly settlementController: AbortController;
        /**
         * Owns the current producer callback edge. An Account transition
         * retires this edge while keeping the one Resource watch/LKG owner
         * alive for its existing consumers.
         */
        callbackController: AbortController;
        /** Present only while this Account-backed Resource watch is active. */
        accountChangeUnsubscribe: (() => void) | null;
        producerSubscription: Disposable | null;
        settling: boolean;
        pending: boolean;
        /** One same-digest wake drives stale LKG; success wakes recovery once. */
        failureWakeDelivered: boolean;
        retryTimer: ReturnType<typeof setTimeout> | null;
        resolveRetry: (() => void) | null;
    };
    /** One producer observation per exact Resource context, never per plugin/session globally. */
    const dynamicWatches = new Map<DynamicResourceContextState, DynamicWatch>();
    let sessionAccessAccountId: string | null = null;
    let sessionAccessWitnessCursor: number | null = null;
    let sessionAccessWitnessAvailable = false;

    function requireSessionAccessCarrier(): Readonly<{
        accountId: string;
        throughCursor: number;
    }> {
        if (
            !sessionAccessWitnessAvailable
            || sessionAccessAccountId === null
            || sessionAccessWitnessCursor === null
        ) {
            return fail(
                'plugin_resource_session_access_unavailable',
                'Session-scoped Resource access is unavailable until the Account change witness is available',
            );
        }
        return Object.freeze({
            accountId: sessionAccessAccountId,
            throughCursor: sessionAccessWitnessCursor,
        });
    }

    function requireSessionAccessAdmission(
        sessionId: string,
        admission: SessionResourceAccessAdmission | undefined,
    ): Readonly<{
        accountId: string;
        throughCursor: number;
        admission: SessionResourceAccessAdmission;
    }> {
        const carrier = requireSessionAccessCarrier();
        if (
            !admission
            || admission[sessionResourceAccessAdmissionBrand] !== true
            || admission.revoked
            || admission.accountId !== carrier.accountId
            || admission.sessionId !== sessionId
            // An admission authorizes only the exact Account witness it was
            // proved against. A newer carrier may have retired this Session
            // after binding but before its first Resource operation.
            || admission.throughCursor !== carrier.throughCursor
        ) {
            return fail(
                'plugin_resource_session_access_unavailable',
                'Session-scoped Resource access is unavailable',
            );
        }
        return Object.freeze({ ...carrier, admission });
    }

    /**
     * Settlement is owned by this exact watch, not merely by its Resource
     * context. A producer is allowed to ignore abort; this fence prevents its
     * late result from being admitted, retried, or delivered after ownership
     * has gone away.
     */
    function isDynamicWatchCurrent(
        watch: DynamicWatch,
        callbackController: AbortController = watch.callbackController,
    ): boolean {
        if (
            watch.settlementController.signal.aborted
            || callbackController.signal.aborted
            || watch.callbackController !== callbackController
            || dynamicWatches.get(watch.context) !== watch
            || !isDynamicContextCurrent(watch.resource, watch.context)
            || retiredPluginIds.has(watch.resource.pluginId)
        ) {
            return false;
        }
        for (const watcher of [...watch.watchers]) {
            if (!watcher.isCurrent()) releaseDynamicWatcher(watch.context, watch, watcher);
        }
        return (
            !watch.settlementController.signal.aborted
            && !callbackController.signal.aborted
            && watch.callbackController === callbackController
            && dynamicWatches.get(watch.context) === watch
            && isDynamicContextCurrent(watch.resource, watch.context)
            && !retiredPluginIds.has(watch.resource.pluginId)
            && watch.watchers.size > 0
        );
    }

    /**
     * Account storage already owns operation-time currentness. Resource must
     * give that owner both facts that define one live callback: the local
     * Resource/watch edge and the durable committed generation. Rechecking
     * local currentness after the async witness closes replacement races.
     */
    function composeAccountStorageCurrentness(
        isLocalCurrent: () => boolean,
    ): () => boolean | Promise<boolean> {
        const isCommittedGenerationCurrent = params.isCommittedGenerationCurrent;
        if (!isCommittedGenerationCurrent) return isLocalCurrent;
        return async (): Promise<boolean> => {
            if (!isLocalCurrent()) return false;
            if (!await isCommittedGenerationCurrent()) return false;
            return isLocalCurrent();
        };
    }

    /**
     * A settled dynamic observation owns more than an Account-storage call:
     * it can replace this context's last-known-good bytes and wake consumers.
     * Check the committed-generation witness around the producer await so an
     * ignored producer result cannot cross that owner boundary after retirement.
     */
    async function isDynamicWatchSettlementCurrent(
        watch: DynamicWatch,
        callbackController: AbortController,
    ): Promise<boolean> {
        if (!isDynamicWatchCurrent(watch, callbackController)) return false;
        const isCommittedGenerationCurrent = params.isCommittedGenerationCurrent;
        if (isCommittedGenerationCurrent) {
            try {
                if (!await isCommittedGenerationCurrent()) return false;
            } catch {
                return false;
            }
        }
        return isDynamicWatchCurrent(watch, callbackController);
    }

    function guardDynamicWatchCurrent(watch: DynamicWatch, callbackController: AbortController): void {
        if (!isDynamicWatchCurrent(watch, callbackController)) {
            return fail('plugin_resource_aborted', 'Resource observation was aborted');
        }
    }

    function deliverDynamicWatchers(
        watch: DynamicWatch,
        digest: string,
        force: boolean,
    ): void {
        for (const watcher of [...watch.watchers]) {
            if (!watcher.isCurrent()) {
                releaseDynamicWatcher(watch.context, watch, watcher);
                continue;
            }
            if (!force && watcher.deliveredDigest === digest) continue;
            watcher.deliveredDigest = digest;
            try {
                watcher.listener({ digest });
            } catch {
                // Listener failures are isolated from the producer.
            }
        }
    }

    function normalizeBoundContext(value: unknown): PluginResourceContextV1 | undefined {
        if (value === undefined) return undefined;
        const parsed = PluginResourceContextV1Schema.safeParse(value);
        if (!parsed.success) {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
        return parsed.data;
    }

    function surfaceContextsMatch(
        left: Extract<PluginResourceContextV1, { kind: 'surface' }>,
        right: Extract<PluginResourceContextV1, { kind: 'surface' }>,
    ): boolean {
        if (left.mountInstanceKey !== right.mountInstanceKey) return false;
        return pluginJsonValuesEqual(left.launchInput, right.launchInput);
    }

    function requireContextForDynamicResource(
        resource: AdmittedDynamicResource,
        boundContext: PluginResourceContextV1 | undefined,
        sessionAccessAdmission: SessionResourceAccessAdmission | undefined,
        surfaceAccessAdmission: SurfaceResourceAccessAdmission | undefined,
        createSessionState: boolean,
    ): DynamicResourceContextState {
        if (resource.scope === 'global') {
            if (boundContext !== undefined && boundContext.kind !== 'global') {
                return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
            }
            const context = resource.globalContext
                ?? fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
            return context;
        }
        if (resource.scope === 'surface') {
            if (
                !boundContext
                || boundContext.kind !== 'surface'
                || !surfaceAccessAdmission
                || surfaceAccessAdmission[surfaceResourceAccessAdmissionBrand] !== true
                || surfaceAccessAdmission.resource !== resource
                || surfaceAccessAdmission.context.context.kind !== 'surface'
                || resource.surfaceContexts.get(boundContext.mountInstanceKey) !== surfaceAccessAdmission.context
                || !surfaceContextsMatch(surfaceAccessAdmission.context.context, boundContext)
            ) {
                return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
            }
            return surfaceAccessAdmission.context;
        }
        if (!boundContext || boundContext.kind !== 'session') {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
        const existing = resource.sessionContexts.get(boundContext.sessionId);
        // A context already held by this exact admission continues through
        // later carrier pages until its own Session is retired. A page is not
        // an inventory, so its omission cannot invalidate another live
        // Session; a new or replacement context still requires the exact
        // current carrier admission below.
        if (existing && existing.sessionAccessAdmission === sessionAccessAdmission) return existing;
        const admission = requireSessionAccessAdmission(boundContext.sessionId, sessionAccessAdmission);
        // A separately admitted current binding joins the existing exact
        // Resource/Session owner instead of allocating a second context.
        if (existing) return existing;
        if (!createSessionState) {
            return fail('plugin_resource_context_unavailable', 'Resource context has no observed snapshot');
        }
        if (activeDynamicResourceContexts >= MAX_PLUGIN_RESOURCE_ACTIVE_CONTEXTS) {
            return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its active context bound');
        }
        const created = createDynamicContextState(boundContext, admission);
        resource.sessionContexts.set(boundContext.sessionId, created);
        activeDynamicResourceContexts += 1;
        return created;
    }

    /**
     * The exact Resource map owns contextual currentness. A removed Session
     * leaves no retained context identity for a late producer/read to admit.
     */
    function isDynamicContextCurrent(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): boolean {
        if (resource.scope === 'global') return resource.globalContext === context;
        if (resource.scope === 'surface') {
            return context.context.kind === 'surface'
                && resource.surfaceContexts.get(context.context.mountInstanceKey) === context;
        }
        if (
            context.context.kind !== 'session'
            || resource.sessionContexts.get(context.context.sessionId) !== context
            || !sessionAccessWitnessAvailable
            || context.sessionAccessAccountId === null
            || context.sessionAccessWitnessCursor === null
            || context.sessionAccessAccountId !== sessionAccessAccountId
            || context.sessionAccessAdmission === null
            || context.sessionAccessAdmission.revoked
        ) {
            return false;
        }
        return true;
    }

    function releaseSurfaceDynamicContext(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): boolean {
        if (
            resource.scope !== 'surface'
            || context.context.kind !== 'surface'
            || resource.surfaceContexts.get(context.context.mountInstanceKey) !== context
        ) {
            return false;
        }
        resource.surfaceContexts.delete(context.context.mountInstanceKey);
        activeDynamicResourceContexts -= 1;
        aggregateBytes -= context.observedSize;
        context.observedAccountLifetimeToken = null;
        context.observedSize = 0;
        context.observedDigest = '';
        return true;
    }

    function releaseSessionDynamicContext(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): boolean {
        if (
            resource.scope !== 'session'
            || context.context.kind !== 'session'
            || resource.sessionContexts.get(context.context.sessionId) !== context
        ) {
            return false;
        }
        resource.sessionContexts.delete(context.context.sessionId);
        if (context.sessionAccessAdmission) context.sessionAccessAdmission.revoked = true;
        activeDynamicResourceContexts -= 1;
        aggregateBytes -= context.observedSize;
        context.observedAccountLifetimeToken = null;
        context.observedSize = 0;
        context.observedDigest = '';
        return true;
    }

    function acquireDynamicContext(
        resource: AdmittedDynamicResource,
        boundContext: PluginResourceContextV1 | undefined,
        sessionAccessAdmission: SessionResourceAccessAdmission | undefined,
        surfaceAccessAdmission: SurfaceResourceAccessAdmission | undefined,
    ): Readonly<{ context: DynamicResourceContextState; release: () => void }> {
        const context = requireContextForDynamicResource(
            resource,
            boundContext,
            sessionAccessAdmission,
            surfaceAccessAdmission,
            true,
        );
        // Exact Session state is generation-owned rather than UI-owner-owned:
        // releasing a read or watch stops that operation, but it must retain the
        // Session LKG until the Session is permanently removed or the generation
        // retires. This owner currently observes the latter lifecycle directly.
        return Object.freeze({ context, release: () => undefined });
    }

    function waitForDynamicResettlementRetry(watch: DynamicWatch): Promise<void> {
        return new Promise((resolve) => {
            // The only caller is the sole `settling` loop for this watch. A
            // later producer signal marks `pending` and joins that loop rather
            // than scheduling a second timer.
            watch.resolveRetry = resolve;
            watch.retryTimer = setTimeout(() => {
                watch.retryTimer = null;
                watch.resolveRetry = null;
                resolve();
            }, DYNAMIC_RESOURCE_SETTLE_RETRY_DELAY_MS);
        });
    }

    function cancelDynamicResettlementRetry(watch: DynamicWatch): void {
        const timer = watch.retryTimer;
        watch.retryTimer = null;
        if (timer) clearTimeout(timer);
        const resolveRetry = watch.resolveRetry;
        watch.resolveRetry = null;
        resolveRetry?.();
    }

    function settleDynamicInvalidation(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): void {
        const watch = dynamicWatches.get(context);
        if (!watch || watch.resource !== resource || !isDynamicWatchCurrent(watch)) return;
        if (watch.settling) {
            watch.pending = true;
            return;
        }
        const callbackController = watch.callbackController;
        watch.settling = true;
        void (async () => {
            try {
                while (isDynamicWatchCurrent(watch, callbackController)) {
                    if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return;
                    watch.pending = false;
                    if (watch.producerSubscription === null) {
                        try {
                            watch.producerSubscription = observeCurrentDynamicProducer(
                                resource,
                                context,
                                watch,
                            );
                        } catch (error) {
                            if (!isPendingInitialAccountDataUnavailable(resource, error)) {
                                terminateDynamicWatchAfterProducerFailure(watch);
                                return;
                            }
                            await waitForDynamicResettlementRetry(watch);
                            continue;
                        }
                    }
                    const accountLifetimeToken = captureDynamicResourceAccountLifetime(resource);
                    let observed: Readonly<{ bytes: Uint8Array; digest: string }>;
                    try {
                        // One shared watch owns its producer callback edge, but
                        // every re-read is a separate Account-bearing callback.
                        // Do not let a scope captured by `read()` outlive that
                        // settlement merely because `observe()` remains live.
                        const settlementReadController = new AbortController();
                        try {
                            observed = await readDynamicBytes(
                                resource,
                                context,
                                MAX_PLUGIN_RESOURCE_BYTES,
                                () => guardDynamicWatchCurrent(watch, callbackController),
                                AbortSignal.any([
                                    watch.settlementController.signal,
                                    callbackController.signal,
                                    settlementReadController.signal,
                                ]),
                                composeAccountStorageCurrentness(() => (
                                    !settlementReadController.signal.aborted
                                    && isDynamicWatchCurrent(watch, callbackController)
                                    && isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)
                                )),
                                params.bindDynamicResourceAccountStorage,
                            );
                        } finally {
                            settlementReadController.abort();
                        }
                    } catch {
                        // An ignored abort can resolve after this watch has lost
                        // ownership. Fence it before it can retry or wake a
                        // consumer through a replacement watch/context.
                        if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return;
                        // A failed settlement has no new bytes to publish, but
                        // its existing LKG must become stale at the generic
                        // digest-only consumer. One forced same-digest wake
                        // represents the whole failure episode; recovery gets
                        // one matching wake even when the digest is unchanged.
                        if (!watch.failureWakeDelivered && context.observedDigest !== '') {
                            watch.failureWakeDelivered = true;
                            if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return;
                            deliverDynamicWatchers(watch, context.observedDigest, true);
                        }
                        if (!isDynamicWatchCurrent(watch, callbackController)) return;
                        await waitForDynamicResettlementRetry(watch);
                        if (!isDynamicWatchCurrent(watch, callbackController)) return;
                        continue;
                    }
                    // Fence ignored-abort producer results before every state
                    // mutation and delivery, not only at the read boundary.
                    if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return;
                    // Awaiting the committed-generation witness above yields
                    // before this continuation resumes. A Session witness can
                    // retire this exact context in that gap, so the local
                    // context/watch owner is the last synchronous authority
                    // before mutating its LKG and aggregate accounting.
                    if (!isDynamicWatchCurrent(watch, callbackController)) return;
                    if (!isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)) return;
                    if (!admitDynamicObservation(resource, context, observed, accountLifetimeToken)) {
                        // Bytes this generation is not allowed to hold are not a
                        // change it may publish: retain the last known good
                        // observation and tell nobody.
                        if (!watch.pending) return;
                        continue;
                    }
                    if (!isDynamicWatchCurrent(watch, callbackController)) return;
                    const recoveredFromFailure = watch.failureWakeDelivered;
                    if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return;
                    watch.failureWakeDelivered = false;
                    deliverDynamicWatchers(watch, observed.digest, recoveredFromFailure);
                    if (!isDynamicWatchCurrent(watch, callbackController)) return;
                    if (!watch.pending) return;
                }
            } finally {
                watch.settling = false;
                // An Account switch can abort an ignored producer read while
                // this sole settlement loop is still marked active. Its new
                // callback edge marks `pending`; restart through the same
                // watch owner once the old edge has fenced itself out.
                if (watch.pending && isDynamicWatchCurrent(watch)) {
                    settleDynamicInvalidation(resource, context);
                }
            }
        })();
    }

    function releaseDynamicWatch(
        context: DynamicResourceContextState,
        watch: DynamicWatch,
    ): void {
        watch.accountChangeUnsubscribe?.();
        watch.accountChangeUnsubscribe = null;
        watch.callbackController.abort();
        watch.settlementController.abort();
        if (dynamicWatches.get(context) === watch) dynamicWatches.delete(context);
        cancelDynamicResettlementRetry(watch);
        const subscription = watch.producerSubscription;
        watch.producerSubscription = null;
        subscription?.dispose();
    }

    function retireDynamicSessionContext(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): void {
        const watch = dynamicWatches.get(context);
        // Delete the exact context before a producer's disposal callback can
        // run. A producer that ignores abort therefore loses both its signal
        // and the Resource-map identity needed to mutate/deliver after await.
        if (!releaseSessionDynamicContext(resource, context)) return;
        if (!watch || watch.resource !== resource) return;
        const watchers = [...watch.watchers];
        // The public Resource watch API is digest-only, but the host UI watch
        // already owns its terminal event and subscription cleanup. Notify its
        // exact host-private lifetime before releasing the producer so a parked
        // long poll cannot retain an authorized Session snapshot indefinitely.
        for (const watcher of watchers) {
            try {
                watcher.onSessionResourceUnavailable?.();
            } catch {
                // Resource retirement is authoritative even if the host's
                // terminal delivery has already been torn down.
            }
        }
        watch.watchers.clear();
        releaseDynamicWatch(context, watch);
        for (const watcher of watchers) watcher.releaseContext();
    }

    function retireDynamicSurfaceContext(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): void {
        const watch = dynamicWatches.get(context);
        // Delete the exact mount context before disposing its producer edge.
        // A producer that ignores abort consequently cannot mutate the
        // replacement mount's snapshot or notify its consumers.
        if (!releaseSurfaceDynamicContext(resource, context)) return;
        if (!watch || watch.resource !== resource) return;
        const watchers = [...watch.watchers];
        watch.watchers.clear();
        releaseDynamicWatch(context, watch);
        for (const watcher of watchers) watcher.releaseContext();
    }

    function retireSessionContexts(sessionId: string): void {
        for (const resource of admittedDynamicResources) {
            if (resource.scope !== 'session') continue;
            const context = resource.sessionContexts.get(sessionId);
            if (context) retireDynamicSessionContext(resource, context);
        }
    }

    function retireAllSessionContexts(): void {
        for (const resource of admittedDynamicResources) {
            if (resource.scope !== 'session') continue;
            for (const context of [...resource.sessionContexts.values()]) {
                retireDynamicSessionContext(resource, context);
            }
            for (const context of [...resource.surfaceContexts.values()]) {
                retireDynamicSurfaceContext(resource, context);
            }
        }
    }

    /**
     * The Account-change carrier calls this before acknowledging its cursor.
     * It is the only path that converts an Account-authorized Session fact into
     * Resource-context retirement; callers never enumerate Resource Sessions.
     */
    function applySessionAccessWitness(input: ResourceSessionAccessWitness): void {
        const accountId = input.accountId.trim();
        if (accountId.length === 0) {
            return fail(
                'plugin_resource_session_access_unavailable',
                'Session-scoped Resource access is unavailable',
            );
        }
        const accountChanged = sessionAccessAccountId !== null
            && sessionAccessAccountId !== accountId;
        if (accountChanged) {
            retireAllSessionContexts();
            sessionAccessWitnessCursor = null;
            sessionAccessWitnessAvailable = false;
        }
        sessionAccessAccountId = accountId;

        if (input.witness === undefined) {
            // A predecessor server can advance the general Account cursor but
            // cannot prove Session access. Stop only Session-scoped Resources;
            // Account-global Resources retain their own authority and state.
            retireAllSessionContexts();
            sessionAccessWitnessCursor = null;
            sessionAccessWitnessAvailable = false;
            return;
        }

        if (
            sessionAccessWitnessAvailable
            && sessionAccessWitnessCursor !== null
            && input.witness.throughCursor < sessionAccessWitnessCursor
        ) {
            // A late page cannot re-open a Session after a newer proof has
            // retired it. The carrier remains the cursor/currentness owner.
            return;
        }

        sessionAccessWitnessAvailable = true;
        sessionAccessWitnessCursor = input.witness.throughCursor;
        for (const entry of input.witness.entries) {
            if (entry.status === 'unavailable') {
                retireSessionContexts(entry.sessionId);
            }
        }
    }

    function releaseDynamicWatcher(
        context: DynamicResourceContextState,
        watch: DynamicWatch,
        watcher: DynamicWatcher,
    ): void {
        if (!watch.watchers.delete(watcher)) return;
        if (watch.watchers.size === 0) releaseDynamicWatch(context, watch);
        watcher.releaseContext();
    }

    /**
     * The `observe()` boundary. A producer is trusted but not assumed
     * well-formed: a synchronous throw becomes a typed resource failure, a
     * subscription that is not disposable is refused rather than stored, and
     * the returned handle makes repeated or late disposal harmless.
     */
    function observeDynamicProducer(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        notify: () => void,
        watch: DynamicWatch,
        callbackController: AbortController,
    ): Disposable {
        let produced: unknown;
        try {
            const accountStorage = params.bindDynamicResourceAccountStorage?.({
                pluginId: resource.pluginId,
                resourceId: resource.id,
                generation: resource.generation,
                hostAccessRequests: resource.hostAccessRequests,
                signal: callbackController.signal,
                isGenerationCurrent: composeAccountStorageCurrentness(
                    () => isDynamicWatchCurrent(watch, callbackController),
                ),
            });
            if (
                accountStorage === undefined
                && resource.hostAccessRequests.some((request) => request.required)
            ) {
                return fail('plugin_account_storage_unavailable', 'Plugin Account storage is unavailable');
            }
            produced = resource.runtime.observe(
                notify,
                Object.freeze({
                    signal: callbackController.signal,
                    context: context.context,
                    ...(accountStorage === undefined ? {} : { accountStorage }),
                }),
            );
        } catch (error) {
            if (isPluginError(error)) throw error;
            throw new PluginError(
                {
                    code: 'plugin_resource_producer_invalid',
                    message: 'Dynamic resource producer could not be observed',
                },
                { cause: error },
            );
        }
        if (
            typeof produced !== 'object'
            || produced === null
            || typeof (produced as Disposable).dispose !== 'function'
        ) {
            return fail('plugin_resource_producer_invalid', 'Dynamic resource producer returned an invalid subscription');
        }
        const subscription = produced as Disposable;
        let disposed = false;
        return Object.freeze({
            dispose() {
                if (disposed) return;
                disposed = true;
                try {
                    subscription.dispose();
                } catch {
                    // Producer disposal failures never block retirement.
                }
            },
        });
    }

    function observeCurrentDynamicProducer(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        watch: DynamicWatch,
    ): Disposable {
        const callbackController = watch.callbackController;
        return observeDynamicProducer(resource, context, () => {
            // A producer can retain and invoke an old callback after its
            // Account binding was replaced. It has no authority to settle the
            // new Account edge or wake its consumers.
            if (!isDynamicWatchCurrent(watch, callbackController)) return;
            settleDynamicInvalidation(resource, context);
        }, watch, callbackController);
    }

    function rebindDynamicResourceAccountStorageWatch(watch: DynamicWatch): void {
        if (!isDynamicWatchCurrent(watch)) return;
        retireAccountBoundDynamicObservation(watch);
        const previousCallbackController = watch.callbackController;
        previousCallbackController.abort();
        const previousSubscription = watch.producerSubscription;
        watch.producerSubscription = null;
        previousSubscription?.dispose();
        watch.callbackController = new AbortController();
        try {
            watch.producerSubscription = observeCurrentDynamicProducer(
                watch.resource,
                watch.context,
                watch,
            );
        } catch (error) {
            // Account availability is represented by the existing settlement
            // failure/LKG path. An Account publication must not throw out of
            // its owner or leave an old producer binding alive.
            if (!isPendingInitialAccountDataUnavailable(watch.resource, error)) {
                terminateDynamicWatchAfterProducerFailure(watch);
                return;
            }
        }
        settleDynamicInvalidation(watch.resource, watch.context);
    }

    function terminateDynamicWatchAfterProducerFailure(watch: DynamicWatch): void {
        for (const watcher of [...watch.watchers]) {
            releaseDynamicWatcher(watch.context, watch, watcher);
        }
    }

    function retireAccountBoundDynamicObservation(watch: DynamicWatch): void {
        const context = watch.context;
        // This is called only from the Account-scope subscription held by an
        // Account-backed Resource watch. Account B must never inherit A's
        // descriptor or delivery baseline, even if its first B read is typed
        // unavailable. Same-Account retries never enter this path.
        aggregateBytes -= context.observedSize;
        context.observedAccountLifetimeToken = null;
        context.observedSize = 0;
        context.observedDigest = '';
        watch.failureWakeDelivered = false;
        for (const watcher of watch.watchers) watcher.deliveredDigest = '';
    }

    function isPendingInitialAccountDataUnavailable(
        resource: AdmittedDynamicResource,
        error: unknown,
    ): boolean {
        return (
            resource.hostAccessRequests.length > 0
            && isPluginError(error)
            && (
                error.code === 'plugin_account_storage_unavailable'
                || error.code === 'collection_unavailable'
            )
        );
    }

    function watchDynamic(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        watcher: DynamicWatcher,
    ): Disposable {
        const existing = dynamicWatches.get(context);
        const held: DynamicWatch = existing ?? {
            resource,
            context,
            watchers: new Set(),
            settlementController: new AbortController(),
            callbackController: new AbortController(),
            accountChangeUnsubscribe: null,
            producerSubscription: null,
            settling: false,
            pending: false,
            failureWakeDelivered: false,
            retryTimer: null,
            resolveRetry: null,
        };
        // The watch is registered — and carries its first watcher — before the
        // producer can notify. Nothing in the producer contract forbids a
        // synchronous first invalidation, and one that lands on an unregistered
        // watch would be silently dropped.
        if (!existing) dynamicWatches.set(context, held);
        held.watchers.add(watcher);
        if (!existing) {
            if (resource.hostAccessRequests.length > 0) {
                held.accountChangeUnsubscribe = subscribeActiveAccountSettingsSnapshot((previous, next) => {
                    if ((previous?.scopeKey ?? null) === (next?.scopeKey ?? null)) return;
                    rebindDynamicResourceAccountStorageWatch(held);
                });
            }
            try {
                held.producerSubscription = observeCurrentDynamicProducer(resource, context, held);
            } catch (error) {
                // Account publication is asynchronous during daemon startup.
                // Keep the exact watch and its Account-change subscription so
                // the existing rebind owner can attach the producer once the
                // first Account becomes available. Other producer failures
                // remain establishment failures and cannot poison a watch.
                if (!isPendingInitialAccountDataUnavailable(resource, error)) {
                    held.watchers.delete(watcher);
                    releaseDynamicWatch(context, held);
                    throw error;
                }
            }
        }
        let disposed = false;
        const subscription = Object.freeze({
            dispose() {
                if (disposed) return;
                disposed = true;
                releaseDynamicWatcher(context, held, watcher);
            },
        });
        // Establishment resynchronizes only when this exact context already
        // has a snapshot. A newly-created session context is opened before the
        // transport's baseline read; asking its producer here would duplicate
        // that authoritative read. A synchronous/early producer notification
        // still settles through the callback above, so this does not create a
        // read→watch gap.
        if (held.producerSubscription === null || context.observedDigest !== '') {
            settleDynamicInvalidation(resource, context);
        }
        return subscription;
    }

    function retireDynamicWatches(pluginId: string): void {
        for (const [context, watch] of [...dynamicWatches.entries()]) {
            const resource = watch.resource;
            if (resource.pluginId !== pluginId) continue;
            const watchers = [...watch.watchers];
            watch.watchers.clear();
            releaseDynamicWatch(context, watch);
            for (const watcher of watchers) watcher.releaseContext();
        }
    }

    function retireDynamicContexts(pluginId: string): void {
        const resources = admittedByPlugin.get(pluginId);
        if (!resources) return;
        for (const resource of resources.values()) {
            if (resource.source !== 'dynamic') continue;
            const global = resource.globalContext;
            if (global) {
                aggregateBytes -= global.observedSize;
                global.observedAccountLifetimeToken = null;
                global.observedSize = 0;
                global.observedDigest = '';
            }
            for (const context of [...resource.sessionContexts.values()]) {
                retireDynamicSessionContext(resource, context);
            }
            for (const context of [...resource.surfaceContexts.values()]) {
                retireDynamicSurfaceContext(resource, context);
            }
        }
    }

    function guardSessionResourceBinding(bindParams: BindPluginResources): void {
        if (
            retiredPluginIds.has(bindParams.pluginId)
            || !admittedPluginIds.has(bindParams.pluginId)
            || !bindParams.isGenerationCurrent()
        ) {
            return fail('plugin_generation_stale', 'Plugin generation is stale');
        }
        if (bindParams.signal.aborted) {
            return fail('plugin_resource_aborted', 'Resource operation was aborted');
        }
    }

    async function admitSessionResourceBinding(
        bindParams: BindPluginResources,
        context: Extract<PluginResourceContextV1, { kind: 'session' }>,
    ): Promise<SessionResourceAccessAdmission> {
        guardSessionResourceBinding(bindParams);
        const carrier = requireSessionAccessCarrier();
        const resolveAccess = params.resolveSessionResourceAccess;
        if (!resolveAccess) {
            return fail(
                'plugin_resource_session_access_unavailable',
                'Session-scoped Resource access is unavailable',
            );
        }
        let resolved: Awaited<ReturnType<ResolveSessionResourceAccess>>;
        try {
            resolved = await resolveAccess({
                accountId: carrier.accountId,
                sessionId: context.sessionId,
                signal: bindParams.signal,
            });
        } catch {
            guardSessionResourceBinding(bindParams);
            return fail(
                'plugin_resource_session_access_unavailable',
                'Session-scoped Resource access is unavailable',
            );
        }
        guardSessionResourceBinding(bindParams);
        const currentCarrier = requireSessionAccessCarrier();
        if (
            resolved.status !== 'available'
            || resolved.accountId !== carrier.accountId
            || currentCarrier.accountId !== carrier.accountId
            // A probe is an authorization proof for the precise carrier fact
            // it began under. An Account update can retire this Session while
            // the probe awaits; accepting that older proof against the newer
            // carrier would create a fresh context after retirement.
            || currentCarrier.throughCursor !== carrier.throughCursor
            || !Number.isSafeInteger(resolved.throughCursor)
            || resolved.throughCursor < carrier.throughCursor
        ) {
            return fail(
                'plugin_resource_session_access_unavailable',
                'Session-scoped Resource access is unavailable',
            );
        }
        return {
            [sessionResourceAccessAdmissionBrand]: true,
            accountId: carrier.accountId,
            sessionId: context.sessionId,
            // The server proof may cover a later page, but the admission is
            // anchored to the exact local carrier whose liveness it checked.
            throughCursor: carrier.throughCursor,
            revoked: false,
        };
    }

    function admitSurfaceResourceBinding(
        bindParams: BindPluginResources,
        resource: AdmittedDynamicResource,
        context: Extract<PluginResourceContextV1, { kind: 'surface' }>,
    ): SurfaceResourceAccessAdmission {
        guardSessionResourceBinding(bindParams);
        if (resource.scope !== 'surface') {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
        const existing = resource.surfaceContexts.get(context.mountInstanceKey);
        if (
            existing
            && existing.context.kind === 'surface'
            && surfaceContextsMatch(existing.context, context)
        ) {
            return Object.freeze({
                [surfaceResourceAccessAdmissionBrand]: true as const,
                resource,
                context: existing,
            });
        }
        // Normalize and freeze the bounded host input before retiring a live
        // mount. An invalid replacement must leave the current mount alone.
        let candidate: DynamicResourceContextState;
        try {
            candidate = createDynamicContextState(context);
        } catch {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
        if (existing) retireDynamicSurfaceContext(resource, existing);
        if (activeDynamicResourceContexts >= MAX_PLUGIN_RESOURCE_ACTIVE_CONTEXTS) {
            return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its active context bound');
        }
        resource.surfaceContexts.set(context.mountInstanceKey, candidate);
        activeDynamicResourceContexts += 1;
        return Object.freeze({
            [surfaceResourceAccessAdmissionBrand]: true as const,
            resource,
            context: candidate,
        });
    }

    let resourceOwner!: StablePluginResourcesOwner;
    resourceOwner = Object.freeze({
        hasPlugin(pluginId: string): boolean {
            return !retiredPluginIds.has(pluginId) && admittedPluginIds.has(pluginId);
        },
        getPluginUiResourceCapability(pluginId: string): PluginUiResourceBindingCapability {
            if (retiredPluginIds.has(pluginId) || !admittedPluginIds.has(pluginId)) {
                return Object.freeze({ readable: false, dynamic: false });
            }
            const resources = admittedByPlugin.get(pluginId);
            if (!resources || resources.size === 0) {
                return Object.freeze({ readable: false, dynamic: false });
            }
            return Object.freeze({
                readable: true,
                dynamic: [...resources.values()].some((resource) => resource.source === 'dynamic'),
            });
        },
        getPluginBrandAsset(pluginId: string): PluginProjectionBrandAssetV2 | undefined {
            const asset = brandAssetsByPluginId.get(pluginId);
            if (!asset) return undefined;
            return retiredPluginIds.has(pluginId)
                ? brandAssetFallback('retired')
                : asset;
        },
        applySessionAccessWitness,
        async bindForResource(bindParams) {
            guardSessionResourceBinding(bindParams);
            const resources = admittedByPlugin.get(bindParams.pluginId)
                ?? new Map<string, AdmittedResource>();
            const resourceId = bindParams.resourceId;
            if (
                typeof resourceId !== 'string'
                || resourceId.length === 0
                || resourceId.trim() !== resourceId
                || resourceId.length > 256
            ) {
                return fail('plugin_resource_not_found', 'Resource is not declared for this plugin');
            }
            const resource = resources.get(resourceId)
                ?? fail('plugin_resource_not_found', 'Resource is not declared for this plugin');
            if (resource.source !== 'dynamic' || resource.scope === 'global') {
                return resourceOwner.bind(bindParams);
            }
            const context = normalizeBoundContext(bindParams.context);
            if (!context || context.kind !== resource.scope) {
                return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
            }
            if (context.kind === 'session') {
                const sessionAccessAdmission = await admitSessionResourceBinding(bindParams, context);
                return resourceOwner.bind({ ...bindParams, context, sessionAccessAdmission });
            }
            const surfaceAccessAdmission = admitSurfaceResourceBinding(bindParams, resource, context);
            return resourceOwner.bind({
                ...bindParams,
                context: surfaceAccessAdmission.context.context,
                surfaceAccessAdmission,
            });
        },
        bind(bindParams): PluginResourcesService {
            if (!admittedPluginIds.has(bindParams.pluginId)) {
                return fail('plugin_generation_stale', 'Plugin generation is stale');
            }
            const resources = admittedByPlugin.get(bindParams.pluginId) ?? new Map<string, AdmittedResource>();
            const boundContext = normalizeBoundContext(bindParams.context);
            const surfaceBinding = bindParams.surfaceAccessAdmission;
            if (surfaceBinding) {
                if (
                    surfaceBinding[surfaceResourceAccessAdmissionBrand] !== true
                    || surfaceBinding.resource.pluginId !== bindParams.pluginId
                    || surfaceBinding.context.context.kind !== 'surface'
                    || surfaceBinding.resource.surfaceContexts.get(
                        surfaceBinding.context.context.mountInstanceKey,
                    ) !== surfaceBinding.context
                ) {
                    return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
                }
                surfaceBinding.context.surfaceBindingReferences += 1;
            }
            const bindingSubscriptions = new Set<Disposable>();
            let bindingRetired = false;
            const retireBinding = (): void => {
                if (bindingRetired) return;
                bindingRetired = true;
                for (const subscription of [...bindingSubscriptions]) subscription.dispose();
                bindingSubscriptions.clear();
                if (surfaceBinding && surfaceBinding.context.surfaceBindingReferences > 0) {
                    surfaceBinding.context.surfaceBindingReferences -= 1;
                    if (surfaceBinding.context.surfaceBindingReferences === 0) {
                        retireDynamicSurfaceContext(surfaceBinding.resource, surfaceBinding.context);
                    }
                }
            };
            if (bindParams.signal.aborted) retireBinding();
            else bindParams.signal.addEventListener('abort', retireBinding, { once: true });
            function guard(signal?: AbortSignal): void {
                if (retiredPluginIds.has(bindParams.pluginId) || !bindParams.isGenerationCurrent()) {
                    return fail('plugin_generation_stale', 'Plugin generation is stale');
                }
                if (bindingRetired || bindParams.signal.aborted || signal?.aborted) {
                    return fail('plugin_resource_aborted', 'Resource operation was aborted');
                }
            }
            function find(id: string): AdmittedResource {
                guard();
                if (typeof id !== 'string' || id.length === 0 || id.trim() !== id || id.length > 256) {
                    return fail('plugin_resource_not_found', 'Resource is not declared for this plugin');
                }
                return resources.get(id) ?? fail('plugin_resource_not_found', 'Resource is not declared for this plugin');
            }
            async function guardCommittedGeneration(): Promise<void> {
                if (params.isCommittedGenerationCurrent && !await params.isCommittedGenerationCurrent()) {
                    return fail('plugin_generation_stale', 'Plugin generation is stale');
                }
            }
            return Object.freeze({
                describe(id: string) {
                    const resource = find(id);
                    if (resource.source !== 'dynamic') return resourceDescriptor(resource);
                    const context = requireContextForDynamicResource(
                        resource,
                        boundContext,
                        bindParams.sessionAccessAdmission,
                        bindParams.surfaceAccessAdmission,
                        false,
                    );
                    retireStaleAccountBoundDynamicObservation(resource, context);
                    return resourceDescriptor(resource, context);
                },
                async read(id: string, options?: { maxBytes?: number; signal?: AbortSignal }) {
                    const resource = find(id);
                    const normalizedOptions = normalizeReadOptions(options);
                    if (resource.source === 'dynamic') {
                        const acquired = acquireDynamicContext(
                            resource,
                            boundContext,
                            bindParams.sessionAccessAdmission,
                            bindParams.surfaceAccessAdmission,
                        );
                        try {
                            retireStaleAccountBoundDynamicObservation(resource, acquired.context);
                            const accountLifetimeToken = captureDynamicResourceAccountLifetime(resource);
                            const operationSignal = normalizedOptions.signal
                                ? AbortSignal.any([bindParams.signal, normalizedOptions.signal])
                                : bindParams.signal;
                            const callbackController = new AbortController();
                            const callbackSignal = AbortSignal.any([
                                operationSignal,
                                callbackController.signal,
                            ]);
                            const guardDynamicRead = (): void => {
                                guard(normalizedOptions.signal);
                                if (!isDynamicContextCurrent(resource, acquired.context)) {
                                    return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
                                }
                                if (!isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)) {
                                    return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
                                }
                            };
                            const observed = await withStableResourceErrors(async () => {
                                try {
                                    await guardCommittedGeneration();
                                    const value = await readDynamicBytes(
                                        resource,
                                        acquired.context,
                                        normalizedOptions.maxBytes,
                                        guardDynamicRead,
                                        callbackSignal,
                                        composeAccountStorageCurrentness(() => (
                                            !callbackController.signal.aborted
                                            && bindParams.isGenerationCurrent()
                                            && isDynamicContextCurrent(resource, acquired.context)
                                            && isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)
                                        )),
                                        params.bindDynamicResourceAccountStorage,
                                    );
                                    await guardCommittedGeneration();
                                    guardDynamicRead();
                                    return value;
                                } finally {
                                    // A read callback cannot retain Account authority
                                    // for the surrounding UI/service binding lifetime.
                                    callbackController.abort();
                                }
                            });
                            // The inner producer guard is deliberately not
                            // the final authority: this outer `await` yields
                            // before we mutate the context's LKG/aggregate
                            // state or disclose bytes to the caller.
                            guardDynamicRead();
                            if (!admitDynamicObservation(
                                resource,
                                acquired.context,
                                observed,
                                accountLifetimeToken,
                            )) {
                                return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its aggregate byte bound');
                            }
                            guardDynamicRead();
                            return Object.freeze({
                                kind: resource.kind,
                                contentType: resource.contentType,
                                digest: observed.digest,
                                bytes: observed.bytes,
                            });
                        } finally {
                            acquired.release();
                        }
                    }
                    const bytes = await withStableResourceErrors(async () => {
                        await guardCommittedGeneration();
                        const verified = await verifyBytes(
                            resource,
                            normalizedOptions.maxBytes,
                            () => guard(normalizedOptions.signal),
                        );
                        await guardCommittedGeneration();
                        return verified;
                    });
                    return Object.freeze({
                        kind: resource.descriptor.kind,
                        contentType: resource.descriptor.contentType,
                        digest: resource.descriptor.digest,
                        bytes,
                    });
                },
                watch(id: string, listener: (change: { digest: string }) => void) {
                    const resource = find(id);
                    if (resource.source !== 'dynamic') {
                        // A packaged resource is a file of an immutable
                        // generation: it cannot change, so watching it is not a
                        // missing feature (§3.6.1).
                        return fail('plugin_resource_watch_unavailable', 'Resource watch is unavailable for this immutable generation');
                    }
                    if (typeof listener !== 'function') {
                        return fail('plugin_resource_options_invalid', 'Resource watch listener is invalid');
                    }
                    const acquired = acquireDynamicContext(
                        resource,
                        boundContext,
                        bindParams.sessionAccessAdmission,
                        bindParams.surfaceAccessAdmission,
                    );
                    retireStaleAccountBoundDynamicObservation(resource, acquired.context);
                    let producer: Disposable;
                    try {
                        producer = watchDynamic(resource, acquired.context, {
                            listener,
                            isCurrent: () => (
                                !bindingRetired
                                && !bindParams.signal.aborted
                                && !retiredPluginIds.has(bindParams.pluginId)
                                && bindParams.isGenerationCurrent()
                            ),
                            releaseContext: acquired.release,
                            ...(
                                resource.scope === 'session' && bindParams.onSessionResourceUnavailable
                                    ? { onSessionResourceUnavailable: bindParams.onSessionResourceUnavailable }
                                    : {}
                            ),
                            // Delivery starts from this exact context's current
                            // snapshot. Establishment immediately re-reads to
                            // close the read→watch handoff race.
                            deliveredDigest: acquired.context.observedDigest,
                        });
                    } catch (error) {
                        acquired.release();
                        throw error;
                    }
                    let disposed = false;
                    let tracked!: Disposable;
                    tracked = Object.freeze({
                        dispose() {
                            if (disposed) return;
                            disposed = true;
                            bindingSubscriptions.delete(tracked);
                            producer.dispose();
                        },
                    });
                    bindingSubscriptions.add(tracked);
                    if (bindingRetired) tracked.dispose();
                    return tracked;
                },
            });
        },
        retirePlugin(pluginId) {
            if (!admittedPluginIds.has(pluginId)) return;
            retiredPluginIds.add(pluginId);
            retireDynamicWatches(pluginId);
            retireDynamicContexts(pluginId);
        },
    });
    return resourceOwner;
}
