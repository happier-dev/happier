import * as React from 'react';

import {
    buildQualifiedPluginContributionKey,
    normalizePluginDeclarativeDocumentV1,
    parsePluginDeclarativeDocumentResourceBytesV1,
    PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
    PluginContributionIdentityV1Schema,
    PluginDeclarativeSettingsInventoryEntryV1Schema,
    NormalizedPluginCollectionUiQueryDescriptorV1Schema,
    type PluginContributionIdentityV1,
    type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1,
    type PluginDeclarativeSettingsInventoryEntryV1,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
} from '@happier-dev/protocol';
import {
    useLivePluginResource,
    usePluginHostApi,
    type PluginUiResourceError,
    type PluginUiResourceSnapshot,
} from '@happier-dev/plugin-ui/hostApi';
import type { PreparedDaemonPluginUiTargetedSurfaceMountV1 } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

type RecordValue = Readonly<Record<string, unknown>>;

type DeclarativeDocumentSourceAccountLifetime = Readonly<{
    isCurrent(): boolean;
}>;

/** The incumbent physical mount's private currentness observation. */
type DeclarativeDocumentSourceMountLifetime = Readonly<{
    isCurrent(): boolean;
}>;

/**
 * Host-private identity for a mounted declarative Resource. It carries only
 * currentness, never Account identity, and lets the document adapter preserve
 * its adopted LKG across a reconnect that replaces the transport facade.
 */
export type DeclarativeDocumentSourceMountScope = Readonly<{
    pluginId: string;
    generation: string;
    accountLifetime: DeclarativeDocumentSourceAccountLifetime | null;
    /** Captured from the one mounted surface controller; never a new owner. */
    mountLifetime: DeclarativeDocumentSourceMountLifetime;
}>;

type DeclarativeDocumentSourceScope = Readonly<{
    hostApi: ReturnType<typeof usePluginHostApi> | null;
    accountLifetime: DeclarativeDocumentSourceAccountLifetime | null;
    mountLifetime: DeclarativeDocumentSourceMountLifetime | null;
    mountGeneration: string | null;
    mountPluginId: string | null;
    pluginId: string;
    staticModel: RecordValue;
    sourceId: string;
    generation: string | null;
    /** Exact mounted-target inventory for dynamic symbolic surface admission. */
    preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[];
}>;

type DeclarativeDocumentSourceState = Readonly<{
    scope: DeclarativeDocumentSourceScope;
    model: RecordValue;
    digest: string | undefined;
    invalidDocument: boolean;
}>;

/**
 * The declarative adapter's one presentation decision over the Resource
 * owner's independent facts. It never replaces Resource freshness, pending or
 * subscription state, which remain exposed below for consumers that need the
 * exact transport/lifecycle detail.
 */
export type DeclarativeDocumentSourcePresentation =
    | 'initialLoading'
    | 'fresh'
    | 'refreshingLkg'
    | 'staleReconnectingLkg'
    | 'terminalUnavailable'
    | 'invalidDocument';

export type DeclarativeDocumentSourceInput = Readonly<{
    pluginId: string;
    staticModel: RecordValue;
    /** Projection carries only the declared Resource reference, never copied MIME metadata. */
    documentSource: unknown;
    /** Host-private mounted Resource currentness; absent callers use host identity as a safe fallback. */
    mountScope?: DeclarativeDocumentSourceMountScope | null;
    /**
     * The exact host-private mounts from the same target-scoped daemon response
     * as this parent surface. Protocol remains the sole normalizer and rejects
     * absent, stale, ambiguous, or cross-target entries.
     */
    preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[];
}>;

export type DeclarativeDocumentSourceResult = Readonly<{
    /** Static or atomically adopted dynamic last-known-good model. */
    model: RecordValue;
    /** True only when the latest Resource bytes fail the document contract. */
    invalidDocument: boolean;
    /** Invalid bytes or the mounted Resource owner's current read/watch error. */
    sourceError: boolean;
    /** One semantic presentation decision over the current Resource snapshot. */
    presentation: DeclarativeDocumentSourcePresentation;
    /** The mounted Resource owner's independent freshness fact. */
    freshness: PluginUiResourceSnapshot['freshness'];
    /** The mounted Resource owner's independent pending-work fact. */
    pending: PluginUiResourceSnapshot['pending'];
    /** The mounted Resource owner's independent subscription fact. */
    subscription: PluginUiResourceSnapshot['subscription'];
    /** The mounted Resource owner's bounded transport/protocol failure, if any. */
    resourceError?: PluginUiResourceError;
    /** Re-read through the mounted L1 Resource owner. */
    retry: () => void;
}>;

function resolveDeclarativeDocumentSourcePresentation(input: Readonly<{
    hasDynamicLkg: boolean;
    invalidDocument: boolean;
    resource: PluginUiResourceSnapshot;
}>): DeclarativeDocumentSourcePresentation {
    if (input.invalidDocument) return 'invalidDocument';
    if (!input.hasDynamicLkg) {
        return input.resource.error !== undefined || input.resource.subscription === 'ended'
            ? 'terminalUnavailable'
            : 'initialLoading';
    }
    if (input.resource.pending === 'refresh') return 'refreshingLkg';
    if (
        input.resource.freshness === 'stale'
        || input.resource.subscription === 'reconnecting'
        || input.resource.error !== undefined
    ) {
        return 'staleReconnectingLkg';
    }
    return 'fresh';
}

/**
 * Project only the normalizer's declared inventory view of a correlated
 * daemon mount response. It preserves every candidate and leaves exactness,
 * schema, target scope, duplicate handling, and normalization to Protocol.
 */
export function projectDeclarativeTargetedSurfaceInventory(
    mounts: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] | undefined,
): readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[] | undefined {
    if (mounts === undefined) return undefined;
    return Object.freeze(mounts.map((mount) => Object.freeze({
        targetPluginId: mount.target.pluginId,
        handle: Object.freeze({
            point: Object.freeze({
                pointId: mount.point.pointId,
                protocol: Object.freeze({
                    id: mount.point.protocol.id,
                    version: mount.point.protocol.version,
                }),
            }),
            contributor: Object.freeze({
                pluginId: mount.contributor.pluginId,
                contributionId: mount.contributor.contributionId,
                immutableGenerationId: mount.contributor.immutableGenerationId,
            }),
            role: mount.role,
            presentation: mount.presentation,
        }),
        inputSchema: mount.inputSchema,
        inputValidation: mount.inputValidation,
    })));
}

type StaticActionBinding = Readonly<{
    identity: PluginContributionIdentityV1;
    enabled: boolean;
}>;

type StaticFieldBinding = Readonly<{
    setting: RecordValue;
}>;

type StaticDocumentBindings = Readonly<{
    actions: ReadonlyMap<string, StaticActionBinding>;
    destinations: ReadonlyMap<string, PluginContributionIdentityV1>;
    fields: ReadonlyMap<string, StaticFieldBinding>;
    settings: readonly PluginDeclarativeSettingsInventoryEntryV1[];
    uiQueries: ReadonlyMap<string, NormalizedPluginCollectionUiQueryDescriptorV1>;
}>;

function readRecord(value: unknown): RecordValue | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readDocumentSourceId(value: unknown): string | null {
    const source = readRecord(value);
    return source?.kind === 'resource' ? readString(source.resourceId) : null;
}

function hasMatchingMountScope(input: Readonly<{
    scope: DeclarativeDocumentSourceMountScope | null | undefined;
    pluginId: string;
    generation: string | null;
}>): boolean {
    if (
        !input.scope
        || input.scope.pluginId !== input.pluginId
        || input.scope.generation !== input.generation
        || !input.scope.accountLifetime
        || !input.scope.mountLifetime
    ) {
        return false;
    }
    return true;
}

/**
 * L1 owns Resource currentness; this adapter also fences the short interval
 * between a delivered snapshot and its passive whole-document adoption. It
 * deliberately consumes the mount's existing lifetime rather than creating a
 * second generation or publication authority.
 */
function isCurrentDocumentSourceScope(scope: DeclarativeDocumentSourceScope): boolean {
    if (!scope.accountLifetime || !scope.mountLifetime) {
        // A caller without the host-private mount scope retains the existing
        // host-identity fallback. A matched mount can never take this arm.
        return scope.accountLifetime === null && scope.mountLifetime === null;
    }
    try {
        return scope.accountLifetime.isCurrent() && scope.mountLifetime.isCurrent();
    } catch {
        return false;
    }
}

function collectionUiQueryKey(collectionId: string, uiQueryId: string): string {
    return `${collectionId}\u0000${uiQueryId}`;
}

function samePlainValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((entry, index) => samePlainValue(entry, right[index]));
    }
    const leftRecord = readRecord(left);
    const rightRecord = readRecord(right);
    if (!leftRecord || !rightRecord) return false;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index]
            && Object.prototype.hasOwnProperty.call(rightRecord, key)
            && samePlainValue(leftRecord[key], rightRecord[key]));
}

/**
 * The declarative source scope is semantic, not an object-identity cache key.
 * Registry/Settings updates may rematerialize the same admitted static model
 * while a dynamic Resource document is still valid. A material static contract
 * change remains a replacement boundary so its new fallback and bindings take
 * effect before another document candidate is adopted.
 */
function areDeclarativeDocumentSourceScopesEquivalent(
    left: DeclarativeDocumentSourceScope,
    right: DeclarativeDocumentSourceScope,
): boolean {
    return left.hostApi === right.hostApi
        && left.accountLifetime === right.accountLifetime
        && left.mountLifetime === right.mountLifetime
        && left.mountGeneration === right.mountGeneration
        && left.mountPluginId === right.mountPluginId
        && left.pluginId === right.pluginId
        && left.sourceId === right.sourceId
        && left.generation === right.generation
        && samePlainValue(left.preparedTargetedSurfaces, right.preparedTargetedSurfaces)
        && samePlainValue(left.staticModel, right.staticModel);
}

function readAdmittedBindings(input: Readonly<{
    pluginId: string;
    generation: string;
    staticModel: RecordValue;
}>): StaticDocumentBindings {
    const actions = new Map<string, StaticActionBinding>();
    const destinations = new Map<string, PluginContributionIdentityV1>();
    const fields = new Map<string, StaticFieldBinding>();
    const settings: PluginDeclarativeSettingsInventoryEntryV1[] = [];
    const uiQueries = new Map<string, NormalizedPluginCollectionUiQueryDescriptorV1>();
    const duplicatedUiQueryKeys = new Set<string>();
    const inventory = readRecord(input.staticModel.declarativeInventory);
    const actionEntries = Array.isArray(inventory?.actions) ? inventory.actions : [];
    const destinationEntries = Array.isArray(inventory?.destinations) ? inventory.destinations : [];
    const settingEntries = Array.isArray(inventory?.settings) ? inventory.settings : [];
    const uiQueryEntries = Array.isArray(inventory?.uiQueries) ? inventory.uiQueries : [];

    for (const actionValue of actionEntries) {
        const action = readRecord(actionValue);
        const identity = PluginContributionIdentityV1Schema.safeParse(action?.identity);
        const qualifiedId = readString(action?.qualifiedId);
        if (
            identity.success
            && identity.data.pluginId === input.pluginId
            && action?.generation === input.generation
            && qualifiedId === buildQualifiedPluginContributionKey(identity.data)
        ) {
            const prior = actions.get(qualifiedId);
            // A duplicate projection entry can only widen a dynamic candidate
            // when every canonical inventory occurrence admits it. Divergence
            // remains fail-closed.
            actions.set(qualifiedId, Object.freeze({
                identity: identity.data,
                enabled: prior ? prior.enabled && action?.enabled === true : action?.enabled === true,
            }));
        }
    }

    for (const destinationValue of destinationEntries) {
        const destination = readRecord(destinationValue);
        const identity = PluginContributionIdentityV1Schema.safeParse(destination?.identity);
        const qualifiedId = readString(destination?.qualifiedId);
        if (
            identity.success
            && identity.data.pluginId === input.pluginId
            && destination?.generation === input.generation
            && qualifiedId === buildQualifiedPluginContributionKey(identity.data)
            && !destinations.has(qualifiedId)
        ) {
            destinations.set(qualifiedId, identity.data);
        }
    }

    for (const settingValue of settingEntries) {
        const entry = readRecord(settingValue);
        const setting = readRecord(entry?.setting);
        const descriptor = readRecord(setting?.descriptor);
        const parsed = PluginDeclarativeSettingsInventoryEntryV1Schema.safeParse({
            pluginId: entry?.pluginId,
            id: entry?.id,
            qualifiedId: entry?.qualifiedId,
            schema: entry?.schema,
            secret: entry?.secret,
        });
        if (
            !parsed.success
            || parsed.data.pluginId !== input.pluginId
            || !setting
            || setting.id !== parsed.data.id
            || setting.qualifiedId !== parsed.data.qualifiedId
            || !descriptor
            || !samePlainValue(descriptor.schema, parsed.data.schema)
            || (descriptor.secret === true) !== parsed.data.secret
        ) {
            continue;
        }
        settings.push(parsed.data);
        const prior = fields.get(parsed.data.qualifiedId);
        // The UI adapter reattaches only the exact Settings projection supplied
        // by the static model. A duplicate qualified binding is never a source
        // of field authority.
        if (!prior) fields.set(parsed.data.qualifiedId, Object.freeze({ setting }));
        else if (!samePlainValue(prior.setting, setting)) fields.delete(parsed.data.qualifiedId);
    }

    for (const uiQueryValue of uiQueryEntries) {
        const parsed = NormalizedPluginCollectionUiQueryDescriptorV1Schema.safeParse(uiQueryValue);
        if (!parsed.success || parsed.data.collection.pluginId !== input.pluginId) continue;
        const key = collectionUiQueryKey(parsed.data.collection.collectionId, parsed.data.id);
        // A duplicate descriptor must never turn a malformed projection into
        // an admitted query. Keep the key poisoned after the first collision:
        // deleting only its second occurrence would let an odd third one
        // silently become authority again.
        if (uiQueries.has(key) || duplicatedUiQueryKeys.has(key)) {
            uiQueries.delete(key);
            duplicatedUiQueryKeys.add(key);
        } else {
            uiQueries.set(key, parsed.data);
        }
    }

    return Object.freeze({ actions, destinations, fields, settings: Object.freeze(settings), uiQueries });
}

function collectionCommandIsAdmitted(
    commandValue: unknown,
    bindings: StaticDocumentBindings,
): boolean {
    const command = readRecord(commandValue);
    if (command?.kind === 'action') {
        const action = readRecord(command.action);
        const qualifiedId = readString(action?.qualifiedId);
        return qualifiedId !== null && bindings.actions.has(qualifiedId);
    }
    if (command?.kind === 'openSurface') {
        const destination = readRecord(command.destination);
        const qualifiedId = readString(destination?.qualifiedId);
        return qualifiedId !== null && bindings.destinations.has(qualifiedId);
    }
    return false;
}

function projectNormalizedNode(input: Readonly<{
    node: unknown;
    bindings: StaticDocumentBindings;
    cache: Map<object, RecordValue>;
}>): RecordValue {
    const node = readRecord(input.node);
    if (!node) throw new Error('plugin_declarative_document_projection_invalid');
    const cached = input.cache.get(node);
    if (cached) return cached;

    const projected: Record<string, unknown> = { ...node };
    const children = node.children;
    if (Array.isArray(children)) {
        projected.children = Object.freeze(children.map((child) => projectNormalizedNode({
            node: child,
            bindings: input.bindings,
            cache: input.cache,
        })));
    }

    if (node.kind === 'action' && readRecord(node.effect)?.kind === 'composerApply') {
        // The Protocol normalizer already accepted the closed transaction. The
        // mounted renderer supplies its private Composer scope later, so this
        // dynamic-document projection has no Composer ref/currentness owner.
        projected.enabled = true;
    } else if (node.kind === 'action' || (node.kind === 'item' && node.action !== undefined)) {
        const action = readRecord(node.action);
        const qualifiedId = readString(action?.qualifiedId);
        const binding = qualifiedId ? input.bindings.actions.get(qualifiedId) : undefined;
        if (!action || !binding) throw new Error('plugin_declarative_document_action_unprojectable');
        projected.action = action;
        projected.enabled = binding.enabled;
    }

    if (node.kind === 'field') {
        const control = readRecord(node.control);
        const setting = readRecord(node.setting);
        const qualifiedId = readString(setting?.qualifiedId);
        const binding = qualifiedId ? input.bindings.fields.get(qualifiedId) : undefined;
        if (
            !control
            || !setting
            || !binding
            || setting.id !== binding.setting.id
            || setting.qualifiedId !== binding.setting.qualifiedId
        ) {
            throw new Error('plugin_declarative_document_field_unprojectable');
        }
        projected.setting = binding.setting;
    }

    if (node.kind === 'collectionList') {
        const source = readRecord(node.source);
        const query = readRecord(node.query);
        const collectionId = readString(source?.collectionId);
        const uiQueryId = readString(source?.uiQueryId);
        const binding = collectionId && uiQueryId
            ? input.bindings.uiQueries.get(collectionUiQueryKey(collectionId, uiQueryId))
            : undefined;
        if (!binding || !query || !samePlainValue(binding, query)) {
            throw new Error('plugin_declarative_document_collection_query_unprojectable');
        }
        if (
            (node.primaryCommand !== undefined && !collectionCommandIsAdmitted(node.primaryCommand, input.bindings))
            || (Array.isArray(node.secondaryCommands)
                && node.secondaryCommands.some((command) => !collectionCommandIsAdmitted(command, input.bindings)))
        ) {
            throw new Error('plugin_declarative_document_collection_command_unprojectable');
        }
        projected.query = binding;
    }

    const frozen = Object.freeze(projected);
    input.cache.set(node, frozen);
    return frozen;
}

function parseResourceDocument(bytes: Uint8Array): unknown {
    const parsed = parsePluginDeclarativeDocumentResourceBytesV1(bytes);
    if (!parsed.ok) throw new Error(parsed.code);
    return parsed.document;
}

function normalizeLiveDocument(input: Readonly<{
    pluginId: string;
    generation: string;
    staticModel: RecordValue;
    preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[];
    resource: Readonly<{
        contentType: string;
        bytes: Uint8Array;
    }>;
}>): RecordValue {
    const document = parseResourceDocument(input.resource.bytes);
    const bindings = readAdmittedBindings({
        pluginId: input.pluginId,
        generation: input.generation,
        staticModel: input.staticModel,
    });
    const normalized = normalizePluginDeclarativeDocumentV1({
        pluginId: input.pluginId,
        generation: input.generation,
        document,
        actions: [...bindings.actions.values()].map(({ identity }) => identity),
        destinations: [...bindings.destinations.values()],
        settings: bindings.settings,
        uiQueries: [...bindings.uiQueries.values()],
        ...(input.preparedTargetedSurfaces === undefined
            ? {}
            : { preparedTargetedSurfaces: input.preparedTargetedSurfaces }),
        // Manifest ingestion is the declaration owner and only projects the
        // Resource id. Passing the Protocol literal here verifies the returned
        // Resource bytes against that already-admitted exact declaration; this
        // adapter never derives or persists a second content-type decision.
        resourceContentTypes: {
            declaredContentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
            returnedContentType: input.resource.contentType,
        },
    });
    const cache = new Map<object, RecordValue>();
    const project = (node: unknown) => projectNormalizedNode({ node, bindings, cache });
    return Object.freeze({
        ...input.staticModel,
        root: project(normalized.root),
        nodes: Object.freeze(normalized.nodes.map(project)),
    });
}

/**
 * Adopts a declared whole-document Resource into the incumbent declarative
 * model. Resource reads, watches, cancellation, currentness and retirement all
 * belong to the mounted plugin-ui L1 store. This hook owns only document decode,
 * neutral normalization and atomic whole-model adoption.
 */
export function useDeclarativeDocumentSource(input: DeclarativeDocumentSourceInput): DeclarativeDocumentSourceResult {
    const sourceId = readDocumentSourceId(input.documentSource);
    if (!sourceId) {
        throw new Error('plugin_declarative_document_source_invalid');
    }
    const hostApi = usePluginHostApi();
    const { resource, refresh } = useLivePluginResource(sourceId);
    const identity = readRecord(input.staticModel.identity);
    const generation = readString(identity?.generation);
    const matchedMountScope = hasMatchingMountScope({
        scope: input.mountScope,
        pluginId: input.pluginId,
        generation,
    })
        ? input.mountScope!
        : null;
    const fallbackHostApi = matchedMountScope ? null : hostApi;
    const candidateSourceScope = React.useMemo<DeclarativeDocumentSourceScope>(() => Object.freeze({
        // A reconnect may replace the transport/controller facade while the
        // mounted Account and projection generation remain current. The L1
        // store owns the new read; this document owner retains its valid LKG
        // until that store publishes a replacement. Without a canonical mount
        // scope, retain host identity as the fail-closed replacement boundary.
        hostApi: fallbackHostApi,
        accountLifetime: matchedMountScope?.accountLifetime ?? null,
        mountLifetime: matchedMountScope?.mountLifetime ?? null,
        mountGeneration: matchedMountScope?.generation ?? null,
        mountPluginId: matchedMountScope?.pluginId ?? null,
        pluginId: input.pluginId,
        staticModel: input.staticModel,
        sourceId,
        generation,
        ...(input.preparedTargetedSurfaces === undefined
            ? {}
            : { preparedTargetedSurfaces: input.preparedTargetedSurfaces }),
    }), [
        matchedMountScope?.accountLifetime,
        matchedMountScope?.mountLifetime,
        matchedMountScope?.generation,
        matchedMountScope?.pluginId,
        generation,
        fallbackHostApi,
        input.pluginId,
        input.staticModel,
        input.preparedTargetedSurfaces,
        sourceId,
    ]);
    const sourceScopeRef = React.useRef<DeclarativeDocumentSourceScope | null>(null);
    if (
        sourceScopeRef.current === null
        || !areDeclarativeDocumentSourceScopesEquivalent(sourceScopeRef.current, candidateSourceScope)
    ) {
        sourceScopeRef.current = candidateSourceScope;
    }
    const sourceScope = sourceScopeRef.current;
    const [state, setState] = React.useState<DeclarativeDocumentSourceState>(() => Object.freeze({
        scope: sourceScope,
        model: input.staticModel,
        digest: undefined as string | undefined,
        invalidDocument: false,
    }));

    // A changed Account/generation (or a mount that lacks a current semantic
    // scope) reverts to static before its new store can publish a fresh
    // candidate. A reconnect-only controller replacement deliberately keeps
    // the same scope and therefore retains its adopted dynamic LKG.
    if (state.scope !== sourceScope) {
        setState(Object.freeze({
            scope: sourceScope,
            model: input.staticModel,
            digest: undefined,
            invalidDocument: false,
        }));
    }

    React.useEffect(() => {
        const value = resource.value;
        if (!isCurrentDocumentSourceScope(sourceScope) || !sourceScope.generation || !value) {
            return;
        }
        // The canonical Resource store retains authenticated last-known-good
        // bytes while it starts an invalidation refresh. Those bytes are still
        // a complete, admitted document; waiting for an idle/fresh snapshot can
        // skip the only publish React observes when the refresh is queued in
        // the same turn.
        let candidate: RecordValue;
        try {
            candidate = normalizeLiveDocument({
                pluginId: sourceScope.pluginId,
                generation: sourceScope.generation,
                staticModel: sourceScope.staticModel,
                ...(sourceScope.preparedTargetedSurfaces === undefined
                    ? {}
                    : { preparedTargetedSurfaces: sourceScope.preparedTargetedSurfaces }),
                resource: value,
            });
        } catch {
            // Invalid bytes, MIME, inventory, normalizer and decode failures
            // deliberately preserve the static/dynamic last-known-good model,
            // while reporting one bounded presentation error. The Resource
            // owner retains transport diagnostics/currentness independently.
            setState((current) => (
                current.scope === sourceScope
                    && isCurrentDocumentSourceScope(sourceScope)
                    && !current.invalidDocument
                    ? Object.freeze({ ...current, invalidDocument: true })
                    : current
            ));
            return;
        }
        setState((current) => (
            current.scope === sourceScope
                && isCurrentDocumentSourceScope(sourceScope)
                && current.digest !== resource.digest
                ? Object.freeze({
                    scope: sourceScope,
                    model: candidate,
                    digest: resource.digest,
                    invalidDocument: false,
                })
                : current.scope === sourceScope
                    && isCurrentDocumentSourceScope(sourceScope)
                    && current.invalidDocument
                    ? Object.freeze({ ...current, invalidDocument: false })
                : current
        ));
    }, [resource.digest, resource.value, sourceScope]);

    // An adopted model is last-known-good only for its captured mount
    // lifetime. Resource retirement publishes the terminal snapshot, while
    // this projection prevents already-adopted bytes from remaining visible
    // during the brief interval before the replacement mount takes over.
    const currentSourceScopeIsCurrent = isCurrentDocumentSourceScope(sourceScope);
    const currentState = state.scope === sourceScope && currentSourceScopeIsCurrent
        ? state
        : Object.freeze({
            scope: sourceScope,
            model: input.staticModel,
            digest: undefined as string | undefined,
            invalidDocument: false,
        });
    const presentation = resolveDeclarativeDocumentSourcePresentation({
        hasDynamicLkg: currentState.digest !== undefined,
        invalidDocument: currentState.invalidDocument,
        resource,
    });
    return React.useMemo(() => Object.freeze({
        model: currentState.model,
        invalidDocument: currentState.invalidDocument,
        sourceError: currentState.invalidDocument || resource.error !== undefined,
        presentation,
        freshness: resource.freshness,
        pending: resource.pending,
        subscription: resource.subscription,
        ...(resource.error === undefined ? {} : { resourceError: resource.error }),
        retry: refresh,
    }), [
        currentState.invalidDocument,
        currentState.model,
        presentation,
        refresh,
        resource.error,
        resource.freshness,
        resource.pending,
        resource.subscription,
    ]);
}
