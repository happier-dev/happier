import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isPluginError, PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import { type PluginDynamicResourceInvocationOptionsV1, type ResourceDescriptor as PluginResourceDescriptor, type PluginResourceKind, type ResourcesService as PluginResourcesService } from '@happier-dev/plugin-sdk/resources';
import type { PluginRuntimeRegistration } from '@happier-dev/plugin-sdk/host/registration';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { isDynamicPluginResourceContributionV2, PluginDynamicResourceScopeV1Schema, PluginResourceKindV2Schema, PluginResourceContextV1Schema, PluginResourceSourceV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { PluginProjectionBrandAssetV2, PluginDynamicResourceScopeV1, JsonValue, PluginResourceContextV1, PluginUiResourceBindingCapabilityV1, PluginResourceContributionV2, PluginResourceSourceV2, SessionAccessWitnessV1 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import {
    resolveContainedPluginResourcePath,
    resolvePluginResourcePath,
} from '@/plugins/projection/resources/package/resolve';
import { logger } from '@/ui/logger';
import type { ResolvedManifestHostAccessRequest } from '@/plugins/runtime/hostAccess/manifestRequests';
import {
    getActiveAccountSettingsSnapshotLifetimeToken,
    subscribeActiveAccountSettingsKeys,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ImmutablePluginGenerationRecord } from '@/plugins/store/registry/generationStore';

export const MAX_PLUGIN_RESOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_BRAND_ICON_BYTES = 256 * 1024;
const MIN_PLUGIN_BRAND_ICON_DIMENSION = 64;
const MAX_PLUGIN_BRAND_ICON_DIMENSION = 512;

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
    brandMonochrome?: boolean;
}>;

type BindPluginResources = Readonly<{
    pluginId: string;
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean;
    /** Host-stamped exact target context; required only by contextual Resources. */
    context?: PluginResourceContextV1;
    /** Host-private one-shot proof; only `bindForResource` can mint it. */
    sessionAccessAdmission?: SessionResourceAccessAdmission;
    /** Host-private exact proof; only `bindForResource` can mint it for a mounted surface. */
    surfaceAccessAdmission?: SurfaceResourceAccessAdmission;
    /** Host-private terminal callback for one bound Session Resource watch. */
    onSessionResourceUnavailable?: () => void;
    /** Host-private withdrawal of bytes admitted under this watch's former read authority. */
    onReadAuthorityRetired?: () => void;
    /** Host-private dependency chain of invocation-bound own Resource reads. */
    readChain?: readonly DynamicResourceContextState[];
    /** Only producer composition consumes an already demanded snapshot. Host reads stay fresh. */
    preferDemandedSnapshot?: boolean;
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
 * keeps `describe` honest. Bytes are retained only by a live demanded watch or
 * in-flight read; ending that demand clears them while descriptor metadata
 * remains occurrence-owned.
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
    demandedSnapshot: Readonly<{ bytes: Uint8Array; digest: string }> | null;
    inFlight: {
        promise: Promise<Readonly<{ bytes: Uint8Array; digest: string }>>;
        controller: AbortController;
        consumers: Set<() => boolean>;
    } | null;
    readonly readDependencies: Set<DynamicResourceContextState>;
    producer: {
        controller: AbortController;
        runtime: Promise<ContextDynamicResourceProducer>;
        unsubscribe: (() => void) | null;
        accountLifetimeToken: number | null;
    } | null;
};

type AdmittedDynamicResource = {
    readonly source: 'dynamic';
    readonly pluginId: string;
    readonly id: string;
    readonly kind: PluginResourceKind;
    readonly contentType: string;
    readonly maxBytes: number;
    readonly scope: PluginDynamicResourceScopeV1;
    readonly occurrenceId: string;
    readonly hostAccessRequests: readonly ResolvedManifestHostAccessRequest[];
    readonly runtime: PluginDynamicResourceRuntime;
    /** Cold runtime registrations are prepared by the existing activation owner. */
    readonly prepareRuntime?: () => Promise<void>;
    preparation: Promise<void> | null;
    /** A failed initial global read makes only this declaration unavailable for its occurrence. */
    admissionFailure: PluginError | null;
    /** Global Resources retain the original admission observation for the occurrenceId. */
    globalContext: DynamicResourceContextState | null;
    /** Contextual state is nested under its Resource, never a global Session registry. */
    readonly sessionContexts: Map<string, DynamicResourceContextState>;
    /** Mounted surface state is nested under its Resource and keyed by host mount identity. */
    readonly surfaceContexts: Map<string, DynamicResourceContextState>;
};

type AdmittedResource = AdmittedPackagedResource | AdmittedDynamicResource;

function deepFreezeJson<T extends JsonValue>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreezeJson(nested);
    return Object.freeze(value);
}

function resourceContextSessionId(context: PluginResourceContextV1): string | null {
    return context.kind === 'session' ? context.sessionId
        : context.kind === 'surface' && context.target?.kind === 'session' ? context.target.sessionId
            : null;
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
            ? Object.freeze({ kind: 'session' as const, sessionId: context.sessionId,
                ...(context.target ? { target: deepFreezeJson(context.target) } : {}) })
            : context.kind === 'surface'
                ? Object.freeze({
                    kind: 'surface' as const,
                    mountInstanceKey: context.mountInstanceKey,
                    launchInput: deepFreezeJson(normalizeStrictJsonValue(context.launchInput)),
                    ...(context.target ? { target: deepFreezeJson(context.target) } : {}),
                })
                : Object.freeze({ kind: 'global' as const }),
        sessionAccessAccountId: sessionAccess?.accountId ?? null,
        sessionAccessWitnessCursor: sessionAccess?.throughCursor ?? null,
        sessionAccessAdmission: sessionAccess?.admission ?? null,
        observedAccountLifetimeToken: null,
        observedDigest: '',
        observedSize: 0,
        surfaceBindingReferences: 0,
        demandedSnapshot: null,
        inFlight: null,
        readDependencies: new Set(),
        producer: null,
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
type ContextDynamicResourceProducer = Awaited<ReturnType<NonNullable<PluginDynamicResourceRuntime['createProducer']>>>;

export type StableDynamicPluginResourceProducer = Readonly<{
    pluginId: string;
    localId: string;
    hostAccessRequests?: readonly ResolvedManifestHostAccessRequest[];
    runtime: PluginDynamicResourceRuntime;
    /** Omission retains eager admission for an already-applied producer. */
    prepareRuntime?: () => Promise<void>;
}>;

export type BindDynamicResourceAccountStorage = (input: Readonly<{
    pluginId: string;
    resourceId: string;
    occurrenceId: string;
    hostAccessRequests: readonly ResolvedManifestHostAccessRequest[];
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean | Promise<boolean>;
}>) => PluginAccountStorageScope | undefined;

export type BindDynamicResourceActions = (input: Readonly<{
    pluginId: string;
    resourceId: string;
    occurrenceId: string;
    context: PluginResourceContextV1;
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean | Promise<boolean>;
    /** Retire this exact callback authority; live observation also reattaches its existing demand. */
    retireObservation?(): void;
}>) => Pick<PluginDynamicResourceInvocationOptionsV1, 'readAction' | 'observeAction'>;

const unavailableResourceActions: Pick<PluginDynamicResourceInvocationOptionsV1, 'readAction' | 'observeAction'> = Object.freeze({
    async readAction() { return fail('plugin_action_registry_unavailable', 'Resource Action reads are unavailable'); },
    async observeAction() { return fail('plugin_action_registry_unavailable', 'Resource Action observation is unavailable'); },
});

/**
 * The one bounded Resource availability fact a bound UI surface may consume.
 * It is derived from this full admitted registry only after its caller has
 * already selected the exact origin/occurrenceId binding; it deliberately carries
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
    /** Settle the plugin's Resource descriptors before exposing synchronous services. */
    preparePlugin(pluginId: string): Promise<void>;
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

function fail(code: string, message: string, details?: Readonly<{ field: string; reason: string }>): never {
    if (details) {
        // Preparation deliberately sanitizes the cross-process failure. Keep
        // its field diagnosis in the local file without declaration values.
        logger.warnLocalFile(JSON.stringify({ kind: 'plugin_resource_admission_invalid', code, ...details }));
    }
    throw new PluginError({ code, message, ...(details ? { details } : {}) });
}

async function withStableResourceErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (isPluginError(error)) throw error;
        throw new PluginError({ code: 'plugin_resource_io_failed', message: 'Resource operation failed', retryable: true }, { cause: error });
    }
}

function ownData(value: unknown, key: string): unknown {
    if (typeof value !== 'object' || value === null) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid', { field: key, reason: 'not_object' });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid', { field: key, reason: 'prototype' });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid', { field: key, reason: descriptor ? 'accessor' : 'missing' });
    }
    return descriptor.value;
}

function boundedString(value: unknown, maxLength: number | null = 2_048, field?: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
        || (maxLength !== null && value.length > maxLength)) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid',
            field ? { field, reason: 'invalid_string' } : undefined);
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
                null,
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
                    null,
                ),
            contentType: boundedString(
                ownData(params.declaration, 'contentType'),
                null,
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
    brandMonochrome: boolean;
}> {
    try {
        const pluginId = boundedString(ownData(raw, 'pluginId'), 256);
        // This slot also carries attested retained-source identities containing
        // runner/plugin paths. Managed-store id bounds belong to their producer.
        const immutableGenerationId = boundedString(ownData(raw, 'immutableGenerationId'), null, 'immutableGenerationId');
        const rootPath = boundedString(ownData(raw, 'rootPath'), 4_096);
        const brandIconResourceIdDescriptor = Object.getOwnPropertyDescriptor(raw, 'brandIconResourceId');
        if (brandIconResourceIdDescriptor && !('value' in brandIconResourceIdDescriptor)) {
            return fail('plugin_resource_generation_invalid', 'Resource occurrenceId is invalid');
        }
        const brandIconResourceId = brandIconResourceIdDescriptor
            ? boundedString(brandIconResourceIdDescriptor.value, 256)
            : null;
        const brandMonochromeDescriptor = Object.getOwnPropertyDescriptor(raw, 'brandMonochrome');
        if (brandMonochromeDescriptor && (!('value' in brandMonochromeDescriptor)
            || typeof brandMonochromeDescriptor.value !== 'boolean')) {
            return fail('plugin_resource_generation_invalid', 'Resource occurrenceId is invalid');
        }
        const brandMonochrome = brandMonochromeDescriptor?.value === true;
        const files = ownData(raw, 'files');
        if (!Array.isArray(files)) {
            return fail('plugin_resource_generation_invalid', 'Resource occurrenceId is invalid');
        }
        const filesByPath = new Map<string, ImmutablePluginGenerationRecord['files'][number]>();
        for (const rawFile of files) {
            const relativePath = boundedString(ownData(rawFile, 'relativePath'), 512);
            const byteLength = ownData(rawFile, 'byteLength');
            if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
                return fail('plugin_resource_generation_invalid', 'Resource occurrenceId is invalid');
            }
            if (filesByPath.has(relativePath)) {
                return fail('plugin_resource_generation_invalid', 'Resource occurrenceId is invalid');
            }
            filesByPath.set(relativePath, Object.freeze({ relativePath, byteLength: byteLength as number }));
        }
        return Object.freeze({
            pluginId,
            immutableGenerationId,
            rootPath,
            filesByPath: Object.freeze(filesByPath),
            brandIconResourceId,
            brandMonochrome,
        });
    } catch (error) {
        if (isPluginError(error)) throw error;
        return fail('plugin_resource_generation_invalid', 'Resource occurrenceId is invalid');
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

export async function decodePortablePluginBrandPng(
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
    const canonicalRoot = await realpath(resolve(rootPath)).catch(() => fail('plugin_resource_generation_invalid', 'Resource occurrenceId root is unavailable'));
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
            return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted occurrenceId');
        }
        const bytes = new Uint8Array(await handle.readFile());
        guard();
        if (bytes.byteLength !== expectedSize) {
            return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted occurrenceId');
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
        return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted occurrenceId');
    }
    return bytes;
}

function copyUint8ArrayAcrossRealm(value: unknown): Uint8Array | null {
    if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') return null;
    return Uint8Array.from(value as Uint8Array);
}

function normalizeProducedBytes(value: unknown): Uint8Array {
    if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'utf8'));
    const bytes = copyUint8ArrayAcrossRealm(value);
    if (bytes) return bytes;
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
    isOccurrenceCurrent: () => boolean | Promise<boolean>,
    resources: PluginResourcesService,
    retireObservation: () => void,
    bindAccountStorage?: BindDynamicResourceAccountStorage,
    bindActions?: BindDynamicResourceActions,
    runtime: Pick<PluginDynamicResourceRuntime, 'read' | 'observe'> = resource.runtime,
): Promise<Readonly<{ bytes: Uint8Array; digest: string }>> {
    guard();
    if (!await isOccurrenceCurrent()) {
        return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
    }
    const limit = Math.min(maxBytes, resource.maxBytes);
    const accountStorage = bindAccountStorage?.({
        pluginId: resource.pluginId,
        resourceId: resource.id,
        occurrenceId: resource.occurrenceId,
        hostAccessRequests: resource.hostAccessRequests,
        signal,
        isOccurrenceCurrent,
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
        resources,
        ...(accountStorage === undefined ? {} : { accountStorage }),
        ...(bindActions?.({ pluginId: resource.pluginId, resourceId: resource.id,
            occurrenceId: resource.occurrenceId, context: context.context, signal, isOccurrenceCurrent,
            retireObservation }) ?? unavailableResourceActions),
    });
    const produced = await withStableResourceErrors(async () => await runtime.read(
        runtimeOptions,
    ));
    if (!await isOccurrenceCurrent()) {
        return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
    }
    guard();
    const bytes = normalizeProducedBytes(produced);
    if (bytes.byteLength > limit) {
        return fail('plugin_resource_too_large', 'Resource read exceeds its byte limit');
    }
    return Object.freeze({ bytes, digest: computePluginResourceDigest(bytes) });
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
    dynamicOccurrenceIdsByPluginId?: ReadonlyMap<string, string>;
    isDynamicOccurrenceCurrent?: (pluginId: string, occurrenceId: string) => boolean | Promise<boolean>;
    dynamicProducers?: readonly StableDynamicPluginResourceProducer[];
    bindDynamicResourceAccountStorage?: BindDynamicResourceAccountStorage;
    bindDynamicResourceActions?: BindDynamicResourceActions;
    resolveSessionResourceAccess?: ResolveSessionResourceAccess;
    isPluginCurrent?: (pluginId: string) => boolean | Promise<boolean>;
}>): Promise<StablePluginResourcesOwner> {
    if (!Array.isArray(params.registry.resources)) {
        return fail('plugin_resource_capacity_exceeded', 'Resource occurrenceId exceeds its declaration bound');
    }
    const contributions = params.registry.resources.map(normalizeContribution);

    return await createStablePluginResourcesOwnerFromNormalized({
        contributions,
        generations: params.generations,
        ...(params.dynamicOccurrenceIdsByPluginId
            ? { dynamicOccurrenceIdsByPluginId: params.dynamicOccurrenceIdsByPluginId }
            : {}),
        ...(params.isDynamicOccurrenceCurrent
            ? { isDynamicOccurrenceCurrent: params.isDynamicOccurrenceCurrent }
            : {}),
        dynamicProducers: params.dynamicProducers ?? [],
        ...(params.bindDynamicResourceAccountStorage
            ? { bindDynamicResourceAccountStorage: params.bindDynamicResourceAccountStorage }
            : {}),
        ...(params.bindDynamicResourceActions ? { bindDynamicResourceActions: params.bindDynamicResourceActions } : {}),
        ...(params.resolveSessionResourceAccess
            ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
            : {}),
        ...(params.isPluginCurrent
            ? {
                isPluginCurrent: params.isPluginCurrent,
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
        brandMonochrome?: boolean;
        dynamicProducers?: readonly StableDynamicPluginResourceProducer[];
        bindDynamicResourceAccountStorage?: BindDynamicResourceAccountStorage;
        bindDynamicResourceActions?: BindDynamicResourceActions;
        resolveSessionResourceAccess?: ResolveSessionResourceAccess;
        isOccurrenceCurrent?: () => boolean | Promise<boolean>;
    }>,
): Promise<StablePluginResourcesOwner> {
    if (!Array.isArray(params.declarations)) {
        return fail(
            'plugin_resource_capacity_exceeded',
            'Resource occurrenceId exceeds its declaration bound',
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
                ...(params.brandMonochrome === undefined
                    ? {}
                    : { brandMonochrome: params.brandMonochrome }),
            }),
        ]]),
        dynamicProducers: params.dynamicProducers ?? [],
        ...(params.bindDynamicResourceAccountStorage
            ? { bindDynamicResourceAccountStorage: params.bindDynamicResourceAccountStorage }
            : {}),
        ...(params.bindDynamicResourceActions ? { bindDynamicResourceActions: params.bindDynamicResourceActions } : {}),
        ...(params.resolveSessionResourceAccess
            ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
            : {}),
        ...(params.isOccurrenceCurrent
            ? {
                isPluginCurrent: params.isOccurrenceCurrent,
            }
            : {}),
    });
}

/**
 * Admits packaged Resources from an already-attested retained source root.
 * Unlike the managed-occurrenceId owner, this seam does not require or invent a
 * occurrenceId-store inventory for bundled first-party runtime snapshots. It
 * snapshots only the manifest-declared Resource files through the same
 * containment and regular-file checks used by Resource reads.
 */
export async function createStableRetainedPluginResourcesOwner(
    params: Readonly<{
        sourceIdentity: string;
        pluginId: string;
        rootPath: string;
        declarations: readonly PluginResourceContributionV2[];
        brandIconResourceId?: string;
        brandMonochrome?: boolean;
        isSourceCurrent?: () => boolean | Promise<boolean>;
    }>,
): Promise<StablePluginResourcesOwner> {
    if (!Array.isArray(params.declarations)) {
        return fail(
            'plugin_resource_capacity_exceeded',
            'Resource source exceeds its declaration bound',
        );
    }
    const filesByPath = new Map<
        string,
        ImmutablePluginGenerationRecord['files'][number]
    >();
    for (const declaration of params.declarations) {
        const normalized = normalizeImmutableContribution({
            pluginId: params.pluginId,
            pluginRootPath: params.rootPath,
            declaration,
        });
        if (normalized.source === 'dynamic') continue;
        const declaredPath = normalized.path
            ?? fail(
                'plugin_resource_declaration_invalid',
                'Resource declaration is invalid',
            );
        // Inventory keys use the same canonical relative path as their reader,
        // including declarations spelled './resources/prompt.md'.
        const relativePath = resolvePluginResourcePath({
            pluginRootPath: params.rootPath,
            resourcePath: declaredPath,
        })?.relativePath ?? fail('plugin_resource_path_denied', 'Resource path is denied');
        if (filesByPath.has(relativePath)) continue;
        const absolutePath = await resolveAdmittedPath(
            params.rootPath,
            relativePath,
        );
        const info = await lstat(absolutePath);
        filesByPath.set(relativePath, Object.freeze({
            relativePath,
            byteLength: info.size,
        }));
    }
    return await createStableImmutablePluginResourcesOwner({
        generationId: params.sourceIdentity,
        pluginId: params.pluginId,
        rootPath: params.rootPath,
        files: [...filesByPath.values()],
        declarations: params.declarations,
        ...(params.brandIconResourceId === undefined
            ? {}
            : { brandIconResourceId: params.brandIconResourceId }),
        ...(params.brandMonochrome === undefined
            ? {}
            : { brandMonochrome: params.brandMonochrome }),
        ...(params.isSourceCurrent
            ? { isOccurrenceCurrent: params.isSourceCurrent }
            : {}),
    });
}

async function createStablePluginResourcesOwnerFromNormalized(
    params: Readonly<{
        contributions: readonly NormalizedResourceContribution[];
        generations: ReadonlyMap<string, ResourceGeneration>;
        dynamicOccurrenceIdsByPluginId?: ReadonlyMap<string, string>;
        isDynamicOccurrenceCurrent?: (pluginId: string, occurrenceId: string) => boolean | Promise<boolean>;
        dynamicProducers: readonly StableDynamicPluginResourceProducer[];
        bindDynamicResourceAccountStorage?: BindDynamicResourceAccountStorage;
        bindDynamicResourceActions?: BindDynamicResourceActions;
        resolveSessionResourceAccess?: ResolveSessionResourceAccess;
        isPluginCurrent?: (pluginId: string) => boolean | Promise<boolean>;
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
    const dynamicOccurrenceIdsByPluginId = new Map(
        [...(params.dynamicOccurrenceIdsByPluginId ?? [])].map(([pluginId, occurrenceId]) => [
            boundedString(pluginId, 256),
            boundedString(occurrenceId, 160),
        ]),
    );

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
    for (const contribution of params.contributions) {
        if (
            contribution.source === 'dynamic'
                ? !dynamicOccurrenceIdsByPluginId.has(contribution.pluginId)
                : !immutableGenerationIdsByPluginId.has(contribution.pluginId)
        ) {
            return fail('plugin_resource_generation_invalid', 'Resource currentness binding is unavailable');
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
                occurrenceId: dynamicOccurrenceIdsByPluginId.get(contribution.pluginId)
                    ?? fail('plugin_resource_generation_invalid', 'Resource occurrenceId is unavailable'),
                hostAccessRequests,
                runtime: producer.runtime,
                ...(producer.prepareRuntime ? { prepareRuntime: producer.prepareRuntime } : {}),
                preparation: null,
                admissionFailure: null,
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
                    ...(generation.brandMonochrome ? { monochrome: true } : {}),
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
    function captureDynamicResourceAccountLifetime(
        resource: AdmittedDynamicResource,
    ): number | null {
        return resource.hostAccessRequests.length > 0 || params.bindDynamicResourceActions !== undefined
            ? getActiveAccountSettingsSnapshotLifetimeToken()
            : null;
    }

    function isDynamicResourceAccountLifetimeCurrent(
        resource: AdmittedDynamicResource,
        accountLifetimeToken: number | null,
    ): boolean {
        return resource.hostAccessRequests.length === 0 && params.bindDynamicResourceActions === undefined
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
        context.observedAccountLifetimeToken = null;
        context.observedSize = 0;
        context.observedDigest = '';
        clearDemandedDynamicBytes(context);
    }

    function admitDynamicObservation(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        observed: Readonly<{ bytes: Uint8Array; digest: string }>,
        accountLifetimeToken: number | null,
    ): boolean {
        if (!isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)) return false;
        context.observedAccountLifetimeToken = accountLifetimeToken;
        context.observedDigest = observed.digest;
        context.observedSize = observed.bytes.byteLength;
        if (dynamicWatches.has(context)) context.demandedSnapshot = observed;
        return true;
    }

    // Initial admission follows producer and occurrence lifetime, not the
    // starter's readiness observation timeout.
    async function admitGlobalDynamicResource(dynamic: AdmittedDynamicResource): Promise<void> {
        const context = dynamic.globalContext;
        if (!context) return;
        const accountLifetimeToken = captureDynamicResourceAccountLifetime(dynamic);
        const isAdmissionCurrent = async (): Promise<boolean> => {
            if (!isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken)) return false;
            if (
                params.isDynamicOccurrenceCurrent
                && !await params.isDynamicOccurrenceCurrent(dynamic.pluginId, dynamic.occurrenceId)
            ) return false;
            return isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken);
        };
        let observed: Readonly<{ bytes: Uint8Array; digest: string }>;
        const admissionStartedAt = Date.now();
        try {
            const controller = new AbortController();
            try {
                observed = await readSharedDynamicBytes(dynamic, context, controller.signal, () => {
                    if (!isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken)) {
                        return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
                    }
                });
                if (!await isAdmissionCurrent()) return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
            } finally {
                controller.abort();
            }
        } catch (error) {
            // The sole active Account lifetime changed while this callback was
            // in flight. Its old bytes are not an admission failure for B and
            // must not become a B descriptor.
            if (!isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken)) return;
            // A fresh Account can publish its declaration before Account Data
            // is readable. This case remains retryable through the Resource
            // watch; other initial failures are isolated to this declaration.
            if (isPendingInitialAccountDataUnavailable(dynamic, error)) return;
            // A retired occurrence invalidates the registry attempt itself;
            // it is not evidence that this producer is unavailable.
            if (isPluginError(error) && error.code === 'plugin_generation_stale') throw error;
            const abortReason = isPluginError(error) && error.code === 'plugin_resource_producer_timed_out'
                ? 'admission_timeout'
                : 'producer_failure';
            dynamic.admissionFailure = isPluginError(error) ? error : new PluginError({
                code: 'plugin_resource_admission_unavailable',
                message: `Resource '${dynamic.pluginId}/${dynamic.id}' is unavailable after admission failure`,
            });
            logger.warn('[PLUGIN RUNTIME] Dynamic Resource admission failed', {
                pluginId: dynamic.pluginId,
                localId: dynamic.id,
                elapsedMs: Date.now() - admissionStartedAt,
                abortReason,
            });
            if (generationsByPluginId.get(dynamic.pluginId)?.brandIconResourceId === dynamic.id) {
                brandAssetsByPluginId.set(dynamic.pluginId, brandAssetFallback('invalid'));
            }
            return;
        }
        if (!isDynamicResourceAccountLifetimeCurrent(dynamic, accountLifetimeToken)) return;
        if (!admitDynamicObservation(dynamic, context, observed, accountLifetimeToken)) {
            return fail('plugin_resource_context_unavailable', 'Resource Account context is unavailable');
        }
    }
    async function prepareDynamicResource(dynamic: AdmittedDynamicResource): Promise<void> {
        if (!dynamic.prepareRuntime) return;
        if (!dynamic.preparation) {
            const prepareRuntime = dynamic.prepareRuntime;
            dynamic.preparation = (async () => {
                await prepareRuntime();
            })();
        }
        const preparation = dynamic.preparation;
        try {
            await preparation;
        } catch (error) {
            // Activation's existing preparation failures may be retryable. A
            // retired occurrence still fails its exact witness on the retry.
            if (dynamic.preparation === preparation) dynamic.preparation = null;
            throw error;
        }
    }
    // Session and surface declarations remain structural until an exact host
    // binding requests them; only global declarations run here.
    const retiredPluginIds = new Set<string>();
    const admittedPluginIds = new Set([
        ...immutableGenerationIdsByPluginId.keys(),
        ...dynamicOccurrenceIdsByPluginId.keys(),
    ]);

    type DynamicWatcher = {
        readonly listener: (change: { digest: string }) => void;
        readonly isCurrent: () => boolean;
        /** Drops this watch's ownership of a session context exactly once. */
        readonly releaseContext: () => void;
        /** Ends the exact host watch when its Session context is retired. */
        readonly onSessionResourceUnavailable?: () => void;
        readonly onReadAuthorityRetired?: () => void;
        deliveredDigest: string;
    };
    type DynamicWatch = {
        readonly resource: AdmittedDynamicResource;
        readonly context: DynamicResourceContextState;
        readonly watchers: Set<DynamicWatcher>;
        readonly dependencies: Map<DynamicResourceContextState, number>;
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
        producerAttachment: Promise<Disposable> | null;
        /** The final release result, retained for aborted and repeatedly disposed handles. */
        cleanupPromise: Promise<void> | null;
        settling: boolean;
        pending: boolean;
        /** One same-digest wake drives stale LKG; success wakes recovery once. */
        failureWakeDelivered: boolean;
        retryTimer: ReturnType<typeof setTimeout> | null;
        resolveRetry: (() => void) | null;
    };
    /** One producer observation per exact Resource context, never per plugin/session globally. */
    const dynamicWatches = new Map<DynamicResourceContextState, DynamicWatch>();

    function clearDemandedDynamicBytes(context: DynamicResourceContextState): void {
        context.demandedSnapshot = null;
        context.inFlight?.controller.abort();
        context.inFlight = null;
        context.readDependencies.clear();
    }

    function retireContextProducer(context: DynamicResourceContextState): void {
        const held = context.producer;
        if (!held) return;
        context.producer = null;
        held.controller.abort();
        held.unsubscribe?.();
        void held.runtime.then(producer => producer.dispose(), () => undefined).catch(() => undefined);
    }

    async function contextRuntime(resource: AdmittedDynamicResource, context: DynamicResourceContextState): Promise<Pick<PluginDynamicResourceRuntime, 'read' | 'observe'>> {
        const createProducer = resource.runtime.createProducer;
        if (!createProducer) return resource.runtime;
        if (context.producer && !isDynamicResourceAccountLifetimeCurrent(resource, context.producer.accountLifetimeToken)) {
            retireContextProducer(context);
        }
        if (!context.producer) {
            const controller = new AbortController();
            const accountLifetimeToken = captureDynamicResourceAccountLifetime(resource);
            const isCurrent = () => !controller.signal.aborted && !retiredPluginIds.has(resource.pluginId)
                && isDynamicContextCurrent(resource, context)
                && isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken);
            const retireAuthority = () => {
                if (context.producer?.controller !== controller) return;
                const watch = dynamicWatches.get(context);
                if (watch) {
                    rebindDynamicResourceAccountStorageWatch(watch);
                    return;
                }
                retireContextProducer(context);
                clearDemandedDynamicBytes(context);
            };
            // Publish custody before invoking plugin code, including synchronous
            // factories. Late asynchronous creation is disposed by the same owner.
            const runtime = Promise.resolve().then(async () => {
                if (!isCurrent()) return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
                const producer = await createProducer.call(resource.runtime, {
                    signal: controller.signal, context: context.context,
                    ...(params.bindDynamicResourceActions?.({ pluginId: resource.pluginId,
                        resourceId: resource.id, occurrenceId: resource.occurrenceId, context: context.context,
                        signal: controller.signal, isOccurrenceCurrent: composeAccountStorageCurrentness(resource, isCurrent),
                        retireObservation: retireAuthority }) ?? unavailableResourceActions),
                });
                if (!producer || typeof producer.read !== 'function' || typeof producer.observe !== 'function'
                    || typeof producer.dispose !== 'function') {
                    return fail('plugin_resource_producer_invalid', 'Resource context producer is invalid');
                }
                return producer;
            });
            const held = { controller, runtime, unsubscribe: null as (() => void) | null, accountLifetimeToken };
            context.producer = held;
            held.unsubscribe = subscribeActiveAccountSettingsKeys({}, () => {
                if (!isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)) retireAuthority();
            });
            void runtime.catch(() => {
                if (context.producer === held) retireContextProducer(context);
            });
        }
        const held = context.producer;
        const runtime = await withStableResourceErrors(() => held.runtime);
        if (held.controller.signal.aborted || context.producer !== held) {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
        return runtime;
    }

    function bindOwnResources(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        signal: AbortSignal,
        readChain: readonly DynamicResourceContextState[],
    ): PluginResourcesService {
        const bind = (id: string): PluginResourcesService => {
            const target = admittedByPlugin.get(resource.pluginId)?.get(id);
            const binding: BindPluginResources = {
                pluginId: resource.pluginId,
                signal,
                isOccurrenceCurrent: () => !signal.aborted
                    && !retiredPluginIds.has(resource.pluginId)
                    && isDynamicContextCurrent(resource, context),
                context: context.context,
                ...(context.sessionAccessAdmission ? { sessionAccessAdmission: context.sessionAccessAdmission } : {}),
                readChain,
                preferDemandedSnapshot: true,
                onReadAuthorityRetired() {
                    const parent = dynamicWatches.get(context);
                    if (!parent || parent.callbackController.signal !== signal || !isDynamicWatchCurrent(parent)) return;
                    rebindDynamicResourceAccountStorageWatch(parent);
                },
            };
            if (target?.source === 'dynamic' && context.context.kind === 'surface') {
                return resourceOwner.bind({ ...binding,
                    surfaceAccessAdmission: admitSurfaceResourceBinding(binding, target, context.context) });
            }
            return resourceOwner.bind(binding);
        };
        return Object.freeze({
            describe(id) { return bind(id).describe(id); },
            async read(id, options) { return await bind(id).read(id, options); },
            async watch(id, listener) { return await bind(id).watch(id, listener); },
        } satisfies PluginResourcesService);
    }

    function reachesReadDependency(from: DynamicResourceContextState, target: DynamicResourceContextState,
        visited = new Set<DynamicResourceContextState>()): boolean {
        if (from === target) return true;
        if (visited.has(from)) return false;
        visited.add(from);
        return [...from.readDependencies].some((dependency) => reachesReadDependency(dependency, target, visited));
    }

    function reachesWatchDependency(from: DynamicResourceContextState, target: DynamicResourceContextState,
        visited = new Set<DynamicResourceContextState>()): boolean {
        if (from === target) return true;
        if (visited.has(from)) return false;
        visited.add(from);
        return [...(dynamicWatches.get(from)?.dependencies.keys() ?? [])]
            .some((dependency) => reachesWatchDependency(dependency, target, visited));
    }

    async function readSharedDynamicBytes(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        signal: AbortSignal,
        guard: () => void,
        preferDemandedSnapshot = false,
        readChain: readonly DynamicResourceContextState[] = [],
    ): Promise<Readonly<{ bytes: Uint8Array; digest: string }>> {
        guard();
        const parent = readChain.at(-1);
        if (readChain.includes(context) || (parent && reachesReadDependency(context, parent))) {
            return fail('plugin_resource_dependency_cycle', 'Resource dependency contains a cycle');
        }
        parent?.readDependencies.add(context);
        if (!context.inFlight && preferDemandedSnapshot && context.demandedSnapshot) {
            return context.demandedSnapshot;
        }
        const consumerCurrent = () => {
            try { guard(); return true; } catch { return false; }
        };
        if (!context.inFlight) {
            const controller = new AbortController();
            const accountLifetimeToken = captureDynamicResourceAccountLifetime(resource);
            const consumers = new Set([consumerCurrent]);
            const isCurrent = () => !controller.signal.aborted
                && !retiredPluginIds.has(resource.pluginId)
                && isDynamicContextCurrent(resource, context)
                && isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)
                && [...consumers].some((isConsumerCurrent) => isConsumerCurrent());
            const assertCurrent = () => {
                if (!isCurrent()) return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
            };
            const promise = contextRuntime(resource, context).then(runtime => readDynamicBytes(resource, context, MAX_PLUGIN_RESOURCE_BYTES,
                assertCurrent, controller.signal, composeAccountStorageCurrentness(resource, isCurrent),
                bindOwnResources(resource, context, controller.signal, [...readChain, context]),
                () => controller.abort(),
                params.bindDynamicResourceAccountStorage, params.bindDynamicResourceActions, runtime)).then((observed) => {
                    assertCurrent();
                    // Publish to the demanded owner before releasing in-flight
                    // custody, so a dependent read cannot fall between them.
                    admitDynamicObservation(resource, context, observed, accountLifetimeToken);
                    return observed;
                });
            const held = { promise, controller, consumers };
            context.inFlight = held;
            void promise.finally(() => {
                if (context.inFlight === held) {
                    context.inFlight = null;
                    context.readDependencies.clear();
                }
                controller.abort();
            }).catch(() => undefined);
        }
        const held = context.inFlight;
        held.consumers.add(consumerCurrent);
        const releaseConsumer = () => {
            held.consumers.delete(consumerCurrent);
            if (held.consumers.size === 0 && context.inFlight === held) {
                held.controller.abort();
                context.inFlight = null;
                context.readDependencies.clear();
            }
        };
        let onAbort: (() => void) | undefined;
        try {
            const observed = await Promise.race([held.promise, new Promise<never>((_resolve, reject) => {
                onAbort = () => {
                    releaseConsumer();
                    reject(new PluginError({ code: 'plugin_resource_aborted', message: 'Resource operation was aborted' }));
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            })]);
            guard();
            return observed;
        } catch (error) {
            // A joined acquisition has several callers; preserve this exact
            // caller's cancellation/currentness result at its own boundary.
            guard();
            throw error;
        } finally {
            if (onAbort) signal.removeEventListener('abort', onAbort);
            releaseConsumer();
        }
    }
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
     * Resource/watch edge and the exact plugin occurrence. Rechecking
     * local currentness after the async witness closes replacement races.
     */
    function composeAccountStorageCurrentness(
        resource: AdmittedDynamicResource,
        isLocalCurrent: () => boolean,
    ): () => boolean | Promise<boolean> {
        const isDynamicOccurrenceCurrent = params.isDynamicOccurrenceCurrent;
        if (!isDynamicOccurrenceCurrent) return isLocalCurrent;
        return async (): Promise<boolean> => (
            isLocalCurrent()
            && await isDynamicOccurrenceCurrent(resource.pluginId, resource.occurrenceId)
            && isLocalCurrent()
        );
    }

    /**
     * A settled dynamic observation owns more than an Account-storage call:
     * it can replace this context's last-known-good bytes and wake consumers.
     * Check the exact occurrence witness around the producer await so an
     * ignored producer result cannot cross that owner boundary after retirement.
     */
    async function isDynamicWatchSettlementCurrent(
        watch: DynamicWatch,
        callbackController: AbortController,
    ): Promise<boolean> {
        if (!isDynamicWatchCurrent(watch, callbackController)) return false;
        if (
            params.isDynamicOccurrenceCurrent
            && !await params.isDynamicOccurrenceCurrent(
                watch.resource.pluginId,
                watch.resource.occurrenceId,
            )
        ) return false;
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
        return pluginJsonValuesEqual(left.launchInput, right.launchInput)
            && pluginJsonValuesEqual(left.target ?? null, right.target ?? null);
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
                || !isDynamicContextCurrent(resource, surfaceAccessAdmission.context)
            ) {
                return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
            }
            return surfaceAccessAdmission.context;
        }
        if (!boundContext || boundContext.kind !== 'session') {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
        const existing = resource.sessionContexts.get(boundContext.sessionId);
        if (existing && !pluginJsonValuesEqual(existing.context, boundContext)) {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
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
        const created = createDynamicContextState(boundContext, admission);
        resource.sessionContexts.set(boundContext.sessionId, created);
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
            if (context.context.kind !== 'surface'
                || resource.surfaceContexts.get(context.context.mountInstanceKey) !== context) return false;
            if (resourceContextSessionId(context.context) === null) return true;
        } else if (context.context.kind !== 'session'
            || resource.sessionContexts.get(context.context.sessionId) !== context) return false;
        if (
            !sessionAccessWitnessAvailable
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
        retireContextProducer(context);
        clearDemandedDynamicBytes(context);
        if (context.sessionAccessAdmission) context.sessionAccessAdmission.revoked = true;
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
        retireContextProducer(context);
        clearDemandedDynamicBytes(context);
        if (context.sessionAccessAdmission) context.sessionAccessAdmission.revoked = true;
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
        // Exact Session state is occurrenceId-owned rather than UI-owner-owned:
        // releasing a read or watch stops that operation, but it must retain the
        // Session LKG until the Session is permanently removed or the occurrenceId
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

    async function retryDynamicWatchAfterSettlementFailure(
        watch: DynamicWatch,
        context: DynamicResourceContextState,
        callbackController: AbortController,
        error?: unknown,
    ): Promise<boolean> {
        if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return false;
        if (!watch.failureWakeDelivered && context.observedDigest !== '') {
            watch.failureWakeDelivered = true;
            if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return false;
            deliverDynamicWatchers(watch, context.observedDigest, true);
        }
        if (!isDynamicWatchCurrent(watch, callbackController)) return false;
        // A typed refusal settles this refresh. Keep the producer observation
        // for a real readiness/change signal instead of polling the same read.
        if (isPluginError(error) && !error.retryable) return false;
        await waitForDynamicResettlementRetry(watch);
        return isDynamicWatchCurrent(watch, callbackController);
    }

    function settleDynamicInvalidation(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): void {
        const watch = dynamicWatches.get(context);
        if (!watch || watch.resource !== resource || !isDynamicWatchCurrent(watch)) return;
        context.demandedSnapshot = null;
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
                            await ensureDynamicProducer(watch);
                            if (!isDynamicWatchCurrent(watch, callbackController)) return;
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
                            observed = await readSharedDynamicBytes(
                                resource,
                                context,
                                AbortSignal.any([
                                    watch.settlementController.signal,
                                    callbackController.signal,
                                    settlementReadController.signal,
                                ]),
                                () => guardDynamicWatchCurrent(watch, callbackController),
                            );
                        } finally {
                            settlementReadController.abort();
                        }
                    } catch (error) {
                        // Surface one stale/LKG episode; only transient failures
                        // use the watch owner's retry cadence.
                        if (!await retryDynamicWatchAfterSettlementFailure(
                            watch,
                            context,
                            callbackController,
                            error,
                        )) return;
                        continue;
                    }
                    // Fence ignored-abort producer results before every state
                    // mutation and delivery, not only at the read boundary.
                    if (!await isDynamicWatchSettlementCurrent(watch, callbackController)) return;
                    // Awaiting the exact-occurrence witness above yields
                    // before this continuation resumes. A Session witness can
                    // retire this exact context in that gap, so the local
                    // context/watch owner is the last synchronous authority
                    // before mutating its observed descriptor.
                    if (!isDynamicWatchCurrent(watch, callbackController)) return;
                    if (!isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)) return;
                    if (!admitDynamicObservation(resource, context, observed, accountLifetimeToken)) {
                        // Retain the LKG, but surface the same stale episode and
                        // retry through the existing watch convergence owner.
                        if (!await retryDynamicWatchAfterSettlementFailure(
                            watch,
                            context,
                            callbackController,
                        )) return;
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
    ): Promise<void> {
        if (watch.cleanupPromise) return watch.cleanupPromise;
        let completeCleanup!: () => void;
        let rejectCleanup!: (error: unknown) => void;
        const cleanup = new Promise<void>((resolve, reject) => {
            completeCleanup = resolve;
            rejectCleanup = reject;
        });
        watch.cleanupPromise = cleanup;
        // Synchronous retirement starts cleanup without awaiting it. Keep its
        // rejection observed while returning the original result to awaiters.
        void cleanup.catch(() => undefined);
        watch.accountChangeUnsubscribe?.();
        watch.accountChangeUnsubscribe = null;
        watch.callbackController.abort();
        watch.settlementController.abort();
        if (dynamicWatches.get(context) === watch) dynamicWatches.delete(context);
        context.demandedSnapshot = null;
        cancelDynamicResettlementRetry(watch);
        const subscription = watch.producerSubscription;
        watch.producerSubscription = null;
        watch.producerAttachment = null;
        try {
            void Promise.resolve(subscription?.dispose()).then(completeCleanup, rejectCleanup);
        } catch (error) {
            rejectCleanup(error);
        }
        return cleanup;
    }

    function retireDynamicSessionContext(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
    ): void {
        const watch = dynamicWatches.get(context);
        // Delete the exact context before a producer's disposal callback can
        // run. A producer that ignores abort therefore loses both its signal
        // and the Resource-map identity needed to mutate/deliver after await.
        if (!(resource.scope === 'surface'
            ? releaseSurfaceDynamicContext(resource, context)
            : releaseSessionDynamicContext(resource, context))) return;
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
            const context = resource.sessionContexts.get(sessionId);
            if (context) retireDynamicSessionContext(resource, context);
            for (const surface of [...resource.surfaceContexts.values()]) {
                if (resourceContextSessionId(surface.context) === sessionId) retireDynamicSessionContext(resource, surface);
            }
        }
    }

    function retireAllSessionContexts(): void {
        for (const resource of admittedDynamicResources) {
            for (const context of [...resource.sessionContexts.values()]) {
                retireDynamicSessionContext(resource, context);
            }
            for (const context of [...resource.surfaceContexts.values()]) {
                if (resourceContextSessionId(context.context) !== null) retireDynamicSessionContext(resource, context);
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
    ): Promise<void> | void {
        if (!watch.watchers.delete(watcher)) return watch.cleanupPromise ?? undefined;
        const cleanup = watch.watchers.size === 0 ? releaseDynamicWatch(context, watch) : undefined;
        watcher.releaseContext();
        return cleanup;
    }

    /**
     * The `observe()` boundary. A producer is trusted but not assumed
     * well-formed: an attachment rejection becomes a typed resource failure, a
     * subscription that is not disposable is refused rather than stored, and
     * the returned handle makes repeated or late disposal harmless.
     */
    async function observeDynamicProducer(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        notify: () => void,
        watch: DynamicWatch,
        callbackController: AbortController,
    ): Promise<Disposable> {
        let produced: unknown;
        try {
            const accountStorage = params.bindDynamicResourceAccountStorage?.({
                pluginId: resource.pluginId,
                resourceId: resource.id,
                occurrenceId: resource.occurrenceId,
                hostAccessRequests: resource.hostAccessRequests,
                signal: callbackController.signal,
                isOccurrenceCurrent: composeAccountStorageCurrentness(
                    resource,
                    () => isDynamicWatchCurrent(watch, callbackController),
                ),
            });
            if (
                accountStorage === undefined
                && resource.hostAccessRequests.some((request) => request.required)
            ) {
                return fail('plugin_account_storage_unavailable', 'Plugin Account storage is unavailable');
            }
            const runtime = await contextRuntime(resource, context);
            produced = await runtime.observe(
                notify,
                Object.freeze({
                    signal: callbackController.signal,
                    context: context.context,
                    resources: bindOwnResources(resource, context, callbackController.signal, [context]),
                    ...(accountStorage === undefined ? {} : { accountStorage }),
                    ...(params.bindDynamicResourceActions?.({
                        pluginId: resource.pluginId, resourceId: resource.id, occurrenceId: resource.occurrenceId,
                        context: context.context, signal: callbackController.signal,
                        isOccurrenceCurrent: composeAccountStorageCurrentness(resource, () => isDynamicWatchCurrent(watch, callbackController)),
                        retireObservation() {
                            if (!isDynamicWatchCurrent(watch, callbackController)) return;
                            rebindDynamicResourceAccountStorageWatch(watch);
                        },
                    }) ?? unavailableResourceActions),
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
        if (!await isDynamicWatchSettlementCurrent(watch, callbackController)
            || !isDynamicWatchCurrent(watch, callbackController)) {
            try { await subscription.dispose(); } catch { /* Retirement still owns cleanup. */ }
            return fail('plugin_resource_aborted', 'Resource observation was aborted');
        }
        let disposed = false;
        return Object.freeze({
            dispose() {
                if (disposed) return;
                disposed = true;
                try {
                    return subscription.dispose();
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
    ): Promise<Disposable> {
        const callbackController = watch.callbackController;
        return observeDynamicProducer(resource, context, () => {
            // A producer can retain and invoke an old callback after its
            // Account binding was replaced. It has no authority to settle the
            // new Account edge or wake its consumers.
            if (!isDynamicWatchCurrent(watch, callbackController)) return;
            settleDynamicInvalidation(resource, context);
        }, watch, callbackController);
    }

    function ensureDynamicProducer(watch: DynamicWatch): Promise<Disposable> {
        if (watch.producerSubscription) return Promise.resolve(watch.producerSubscription);
        if (watch.producerAttachment) return watch.producerAttachment;
        const callbackController = watch.callbackController;
        const pending = observeCurrentDynamicProducer(watch.resource, watch.context, watch).then(async (subscription) => {
            if (!isDynamicWatchCurrent(watch, callbackController)) {
                try { await subscription.dispose(); } catch { /* Retirement still owns cleanup. */ }
                return fail('plugin_resource_aborted', 'Resource observation was aborted');
            }
            watch.producerSubscription = subscription;
            return subscription;
        }).finally(() => {
            if (watch.producerAttachment === pending) watch.producerAttachment = null;
        });
        watch.producerAttachment = pending;
        return pending;
    }

    function rebindDynamicResourceAccountStorageWatch(watch: DynamicWatch): void {
        if (!isDynamicWatchCurrent(watch)) return;
        retireAccountBoundDynamicObservation(watch);
        const previousCallbackController = watch.callbackController;
        previousCallbackController.abort();
        retireContextProducer(watch.context);
        const previousSubscription = watch.producerSubscription;
        watch.producerSubscription = null;
        watch.producerAttachment = null;
        try {
            void Promise.resolve(previousSubscription?.dispose()).catch(() => {
                // Cleanup cannot restore the retired authority or block its replacement.
            });
        } catch {
            // The old callback is already aborted and fenced, even if disposal throws.
        }
        watch.callbackController = new AbortController();
        for (const watcher of [...watch.watchers]) {
            if (!watcher.isCurrent()) continue;
            try {
                watcher.onReadAuthorityRetired?.();
            } catch {
                // Withdrawal remains authoritative if a consumer has already retired.
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
        // An Account switch or admitted Action-authority retirement revokes
        // this callback's descriptor and delivery baseline. Its replacement
        // must not inherit those facts even if its first read is unavailable.
        context.observedAccountLifetimeToken = null;
        context.observedSize = 0;
        context.observedDigest = '';
        watch.failureWakeDelivered = false;
        clearDemandedDynamicBytes(context);
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

    async function watchDynamic(
        resource: AdmittedDynamicResource,
        context: DynamicResourceContextState,
        watcher: DynamicWatcher,
        signal: AbortSignal,
    ): Promise<Disposable> {
        const existing = dynamicWatches.get(context);
        const held: DynamicWatch = existing ?? {
            resource,
            context,
            watchers: new Set(),
            dependencies: new Map(),
            settlementController: new AbortController(),
            callbackController: new AbortController(),
            accountChangeUnsubscribe: null,
            producerSubscription: null,
            producerAttachment: null,
            cleanupPromise: null,
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
            if (!resource.runtime.createProducer
                && (resource.hostAccessRequests.length > 0 || params.bindDynamicResourceActions !== undefined)) {
                held.accountChangeUnsubscribe = subscribeActiveAccountSettingsKeys({}, (previous, next) => {
                    if ((previous?.scopeKey ?? null) === (next?.scopeKey ?? null)) return;
                    rebindDynamicResourceAccountStorageWatch(held);
                });
            }
        }
        const attachmentSignal = AbortSignal.any([signal, held.settlementController.signal, held.callbackController.signal]);
        let onAbort: (() => void) | undefined;
        try {
            await Promise.race([ensureDynamicProducer(held), new Promise<never>((_resolve, reject) => {
                onAbort = () => {
                    releaseDynamicWatcher(context, held, watcher);
                    reject(new PluginError({ code: 'plugin_resource_aborted', message: 'Resource observation was aborted' }));
                };
                if (attachmentSignal.aborted) onAbort();
                else attachmentSignal.addEventListener('abort', onAbort, { once: true });
            })]);
            if (!isDynamicWatchCurrent(held) || !watcher.isCurrent()) {
                return fail('plugin_resource_aborted', 'Resource observation was aborted');
            }
        } catch (error) {
            releaseDynamicWatcher(context, held, watcher);
            throw error;
        } finally {
            if (onAbort) attachmentSignal.removeEventListener('abort', onAbort);
        }
        let disposed = false;
        let cleanup: Promise<void> | void;
        const subscription = Object.freeze({
            dispose() {
                if (disposed) return cleanup;
                disposed = true;
                cleanup = releaseDynamicWatcher(context, held, watcher);
                return cleanup;
            },
        });
        // Establishment resynchronizes only when this exact context already
        // has a snapshot. A newly-created session context is opened before the
        // transport's baseline read; asking its producer here would duplicate
        // that authoritative read. A synchronous/early producer notification
        // still settles through the callback above, so this does not create a
        // read→watch gap.
        if (!existing && !held.settling && (held.producerSubscription === null || context.observedDigest !== '')) {
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
                retireContextProducer(global);
                global.observedAccountLifetimeToken = null;
                global.observedSize = 0;
                global.observedDigest = '';
                clearDemandedDynamicBytes(global);
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
            || !bindParams.isOccurrenceCurrent()
        ) {
            return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
        }
        if (bindParams.signal.aborted) {
            return fail('plugin_resource_aborted', 'Resource operation was aborted');
        }
    }

    async function admitSessionResourceBinding(
        bindParams: BindPluginResources,
        sessionId: string,
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
                sessionId,
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
            sessionId,
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
        const sessionId = resourceContextSessionId(context);
        const sessionAccess = sessionId === null ? undefined
            : requireSessionAccessAdmission(sessionId, bindParams.sessionAccessAdmission);
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
            candidate = createDynamicContextState(context, sessionAccess);
        } catch {
            return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
        }
        if (existing) retireDynamicSurfaceContext(resource, existing);
        resource.surfaceContexts.set(context.mountInstanceKey, candidate);
        return Object.freeze({
            [surfaceResourceAccessAdmissionBrand]: true as const,
            resource,
            context: candidate,
        });
    }

    let resourceOwner!: StablePluginResourcesOwner;
    resourceOwner = Object.freeze({
        async preparePlugin(pluginId: string): Promise<void> {
            for (const dynamic of admittedDynamicResources) {
                if (dynamic.pluginId !== pluginId) continue;
                await prepareDynamicResource(dynamic);
                const context = dynamic.globalContext;
                // An existing watch owns its baseline acquisition. A producer
                // preparing same-plugin Action services must also not await
                // its own in-flight read through global descriptor admission.
                if (context?.observedDigest === '' && !dynamic.admissionFailure
                    && !dynamicWatches.has(context) && context.inFlight === null) {
                    await admitGlobalDynamicResource(dynamic);
                }
            }
        },
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
            const available = [...resources.values()].filter((resource) => (
                resource.source !== 'dynamic' || resource.admissionFailure === null
            ));
            return Object.freeze({
                readable: available.length > 0,
                dynamic: available.some((resource) => resource.source === 'dynamic'),
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
            if (resource.source === 'dynamic' && resource.prepareRuntime) {
                await prepareDynamicResource(resource);
                guardSessionResourceBinding(bindParams);
            }
            if (resource.source !== 'dynamic' || resource.scope === 'global') {
                return resourceOwner.bind(bindParams);
            }
            const context = normalizeBoundContext(bindParams.context);
            if (!context || context.kind !== resource.scope) {
                return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
            }
            if (context.kind === 'session') {
                const sessionAccessAdmission = await admitSessionResourceBinding(bindParams, context.sessionId);
                const existing = resource.sessionContexts.get(context.sessionId);
                if (existing && !pluginJsonValuesEqual(existing.context, context)) retireDynamicSessionContext(resource, existing);
                if (!resource.sessionContexts.has(context.sessionId)) {
                    const admission = requireSessionAccessAdmission(context.sessionId, sessionAccessAdmission);
                    resource.sessionContexts.set(context.sessionId, createDynamicContextState(context, admission));
                }
                return resourceOwner.bind({ ...bindParams, context, sessionAccessAdmission });
            }
            const sessionId = resourceContextSessionId(context);
            const sessionAccessAdmission = sessionId === null ? undefined
                : await admitSessionResourceBinding(bindParams, sessionId);
            const surfaceAccessAdmission = admitSurfaceResourceBinding({ ...bindParams,
                ...(sessionAccessAdmission ? { sessionAccessAdmission } : {}) }, resource, context);
            return resourceOwner.bind({
                ...bindParams,
                context: surfaceAccessAdmission.context.context,
                surfaceAccessAdmission,
                ...(sessionAccessAdmission ? { sessionAccessAdmission } : {}),
            });
        },
        bind(bindParams): PluginResourcesService {
            if (!admittedPluginIds.has(bindParams.pluginId)) {
                return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
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
                if (retiredPluginIds.has(bindParams.pluginId) || !bindParams.isOccurrenceCurrent()) {
                    return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
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
                const resource = resources.get(id) ?? fail('plugin_resource_not_found', 'Resource is not declared for this plugin');
                if (resource.source === 'dynamic' && resource.admissionFailure) throw resource.admissionFailure;
                return resource;
            }
            async function guardPluginCurrent(): Promise<void> {
                if (params.isPluginCurrent && !await params.isPluginCurrent(bindParams.pluginId)) {
                    return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
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
                            if (bindParams.readChain?.includes(acquired.context)) {
                                return fail('plugin_resource_dependency_cycle', 'Resource dependency contains a cycle');
                            }
                            if (resource.prepareRuntime) {
                                await prepareDynamicResource(resource);
                                guard(normalizedOptions.signal);
                            }
                            const attachment = dynamicWatches.get(acquired.context)?.producerAttachment;
                            if (attachment) {
                                await attachment;
                                guard(normalizedOptions.signal);
                            }
                            retireStaleAccountBoundDynamicObservation(resource, acquired.context);
                            const accountLifetimeToken = captureDynamicResourceAccountLifetime(resource);
                            const operationSignal = normalizedOptions.signal
                                ? AbortSignal.any([bindParams.signal, normalizedOptions.signal])
                                : bindParams.signal;
                            const guardDynamicRead = (): void => {
                                guard(normalizedOptions.signal);
                                if (!isDynamicContextCurrent(resource, acquired.context)) {
                                    return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
                                }
                                if (!isDynamicResourceAccountLifetimeCurrent(resource, accountLifetimeToken)) {
                                    return fail('plugin_resource_context_unavailable', 'Resource context is unavailable');
                                }
                            };
                            const observed = await withStableResourceErrors(() => readSharedDynamicBytes(
                                resource,
                                acquired.context,
                                operationSignal,
                                guardDynamicRead,
                                bindParams.preferDemandedSnapshot,
                                bindParams.readChain,
                            ));
                            if (observed.bytes.byteLength > normalizedOptions.maxBytes) {
                                return fail('plugin_resource_too_large', 'Resource read exceeds its byte limit');
                            }
                            // The inner producer guard is deliberately not
                            // the final authority: this outer `await` yields
                            // before we mutate the context's observed descriptor
                            // state or disclose bytes to the caller.
                            guardDynamicRead();
                            if (!admitDynamicObservation(
                                resource,
                                acquired.context,
                                observed,
                                accountLifetimeToken,
                            )) {
                                return fail('plugin_resource_context_unavailable', 'Resource Account context is unavailable');
                            }
                            guardDynamicRead();
                            return Object.freeze({
                                kind: resource.kind,
                                contentType: resource.contentType,
                                digest: observed.digest,
                                bytes: observed.bytes.slice(),
                            });
                        } finally {
                            acquired.release();
                        }
                    }
                    const bytes = await withStableResourceErrors(async () => {
                        await guardPluginCurrent();
                        const verified = await verifyBytes(
                            resource,
                            normalizedOptions.maxBytes,
                            () => guard(normalizedOptions.signal),
                        );
                        await guardPluginCurrent();
                        return verified;
                    });
                    return Object.freeze({
                        kind: resource.descriptor.kind,
                        contentType: resource.descriptor.contentType,
                        digest: resource.descriptor.digest,
                        bytes,
                    });
                },
                async watch(id: string, listener: (change: { digest: string }) => void) {
                    const resource = find(id);
                    if (resource.source !== 'dynamic') {
                        // A packaged resource is a file of an immutable
                        // occurrenceId: it cannot change, so watching it is not a
                        // missing feature (§3.6.1).
                        return fail('plugin_resource_watch_unavailable', 'Resource watch is unavailable for this immutable occurrenceId');
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
                    if (bindParams.readChain?.includes(acquired.context)) {
                        acquired.release();
                        return fail('plugin_resource_dependency_cycle', 'Resource dependency contains a cycle');
                    }
                    const sourceContext = bindParams.readChain?.at(-1);
                    const sourceWatch = sourceContext ? dynamicWatches.get(sourceContext) : undefined;
                    if (sourceContext && sourceWatch && reachesWatchDependency(acquired.context, sourceContext)) {
                        acquired.release();
                        return fail('plugin_resource_dependency_cycle', 'Resource dependency contains a cycle');
                    }
                    if (sourceWatch) sourceWatch.dependencies.set(acquired.context,
                        (sourceWatch.dependencies.get(acquired.context) ?? 0) + 1);
                    const releaseDependency = () => {
                        if (!sourceWatch) return;
                        const remaining = (sourceWatch.dependencies.get(acquired.context) ?? 1) - 1;
                        if (remaining === 0) sourceWatch.dependencies.delete(acquired.context);
                        else sourceWatch.dependencies.set(acquired.context, remaining);
                    };
                    let producer: Disposable;
                    try {
                        producer = await watchDynamic(resource, acquired.context, {
                            listener,
                            isCurrent: () => (
                                !bindingRetired
                                && !bindParams.signal.aborted
                                && !retiredPluginIds.has(bindParams.pluginId)
                                && bindParams.isOccurrenceCurrent()
                            ),
                            releaseContext: acquired.release,
                            ...(bindParams.onReadAuthorityRetired
                                ? { onReadAuthorityRetired: bindParams.onReadAuthorityRetired }
                                : {}),
                            ...(
                                resourceContextSessionId(acquired.context.context) !== null && bindParams.onSessionResourceUnavailable
                                    ? { onSessionResourceUnavailable: bindParams.onSessionResourceUnavailable }
                                    : {}
                            ),
                            // Delivery starts from this exact context's current
                            // snapshot. Establishment immediately re-reads to
                            // close the read→watch handoff race.
                            deliveredDigest: acquired.context.observedDigest,
                        }, bindParams.signal);
                    } catch (error) {
                        releaseDependency();
                        acquired.release();
                        throw error;
                    }
                    let disposed = false;
                    let cleanup: ReturnType<Disposable['dispose']>;
                    let tracked!: Disposable;
                    tracked = Object.freeze({
                        dispose() {
                            if (disposed) return cleanup;
                            disposed = true;
                            bindingSubscriptions.delete(tracked);
                            releaseDependency();
                            cleanup = producer.dispose();
                            return cleanup;
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
    // The owner must exist before an admitted global producer can compose an
    // own Resource. Production cold producers still use prepareRuntime.
    const globalDynamicResources = admittedDynamicResources.filter((dynamic) => (
        dynamic.globalContext && !dynamic.prepareRuntime
    ));
    const admissions = await Promise.allSettled(globalDynamicResources.map(admitGlobalDynamicResource));
    const rejectedAdmission = admissions.find((result) => result.status === 'rejected');
    if (rejectedAdmission?.status === 'rejected') throw rejectedAdmission.reason;
    return resourceOwner;
}
