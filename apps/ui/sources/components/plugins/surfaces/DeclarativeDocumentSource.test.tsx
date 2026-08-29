import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
    preparePluginJsonSchema,
    rehydrateCanonicalProtocolComposableSchema,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol/plugins/ui';
import {
    MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
    type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1,
} from '@happier-dev/protocol';

import { PluginError } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import type {
    PluginUiHostApi,
    ResourceContent,
    ResourceSubscriptionEvent,
} from '@happier-dev/plugin-sdk/ui';
import { PluginHostApiProvider } from '@happier-dev/plugin-ui/advanced';

import {
    useDeclarativeDocumentSource,
    type DeclarativeDocumentSourceMountScope,
} from './DeclarativeDocumentSource';

const DOCUMENT_CONTENT_TYPE = 'application/vnd.happier.declarative-document+json;version=1';

type Model = Readonly<Record<string, unknown>>;
type HostMethods = ReturnType<PluginUiHostApi['version']>['methods'];
type ResourceDigest = Extract<ResourceSubscriptionEvent, { kind: 'invalidated' }>['digest'];

function prepareTargetedSurfaceInventoryEntry(
    input: Omit<PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1, 'inputValidation' | 'inputNormalizer'>,
): PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 {
    const inputValidation = preparePluginJsonSchema(input.inputSchema);
    const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(inputValidation.jsonSchema);
    if (!inputNormalizer) throw new Error('Expected canonical Surface schema to rehydrate');
    return Object.freeze({
        ...input,
        inputSchema: inputValidation.jsonSchema,
        inputValidation,
        inputNormalizer,
    });
}

function resourceDigest(value: string): ResourceDigest {
    return PluginUiArtifactDigestV1Schema.parse(value);
}

const staticModel: Model = Object.freeze({
    identity: Object.freeze({
        pluginId: 'acme.dashboard',
        localId: 'dashboard',
        qualifiedId: 'acme.dashboard/dashboard',
        generation: '7',
    }),
    visible: true,
    requiredHostMethods: Object.freeze([]),
    declarativeInventory: Object.freeze({
        actions: Object.freeze([]),
        destinations: Object.freeze([]),
        settings: Object.freeze([]),
        uiQueries: Object.freeze([]),
    }),
    nodes: Object.freeze([{ kind: 'text', path: 'root', order: 0, text: 'Static dashboard' }]),
    root: Object.freeze({ kind: 'text', path: 'root', order: 0, text: 'Static dashboard' }),
});

const staticModelWithRefreshAction: Model = Object.freeze({
    ...staticModel,
    declarativeInventory: Object.freeze({
        actions: Object.freeze([{
            identity: Object.freeze({ pluginId: 'acme.dashboard', localId: 'refresh' }),
            qualifiedId: 'acme.dashboard/refresh',
            generation: '7',
            enabled: true,
        }]),
        destinations: Object.freeze([]),
        settings: Object.freeze([]),
        uiQueries: Object.freeze([]),
    }),
});

const openTasksQuery = Object.freeze({
    collection: Object.freeze({ pluginId: 'acme.dashboard', collectionId: 'tasks' }),
    id: 'open-tasks',
    indexId: 'by-status',
    parameters: Object.freeze({
        status: Object.freeze({ kind: 'string', maxUtf8Bytes: 16, enum: Object.freeze(['open']) }),
    }),
    prefix: Object.freeze([{ kind: 'parameter', parameterId: 'status' }]),
    order: 'asc',
    pageSize: 20,
    projectedFields: Object.freeze([
        Object.freeze({ field: 'status', kind: 'string' }),
        Object.freeze({ field: 'title', kind: 'string' }),
    ]),
});

const staticModelWithOpenTasksQuery: Model = Object.freeze({
    ...staticModel,
    declarativeInventory: Object.freeze({
        actions: Object.freeze([]),
        destinations: Object.freeze([]),
        settings: Object.freeze([]),
        uiQueries: Object.freeze([openTasksQuery]),
    }),
});

const staticModelWithOpenTasksRowCommands: Model = Object.freeze({
    ...staticModel,
    declarativeInventory: Object.freeze({
        actions: Object.freeze([{
            identity: Object.freeze({ pluginId: 'acme.dashboard', localId: 'refresh' }),
            qualifiedId: 'acme.dashboard/refresh',
            generation: '7',
            enabled: true,
        }]),
        destinations: Object.freeze([{
            identity: Object.freeze({ pluginId: 'acme.dashboard', localId: 'task-details' }),
            qualifiedId: 'acme.dashboard/task-details',
            generation: '7',
        }]),
        settings: Object.freeze([]),
        uiQueries: Object.freeze([openTasksQuery]),
    }),
});

const staticModelWithOddDuplicateOpenTasksQuery: Model = Object.freeze({
    ...staticModel,
    declarativeInventory: Object.freeze({
        actions: Object.freeze([]),
        destinations: Object.freeze([]),
        settings: Object.freeze([]),
        // Three occurrences exercises the losing path where deleting only the
        // second duplicate allowed the third to become an invented authority.
        uiQueries: Object.freeze([openTasksQuery, openTasksQuery, openTasksQuery]),
    }),
});

function resourceRead(
    document: unknown,
    input: Readonly<{
        contentType?: string;
        digest?: ResourceDigest;
    }> = {},
): ResourceContent {
    return Object.freeze({
        contentType: input.contentType ?? DOCUMENT_CONTENT_TYPE,
        digest: input.digest ?? resourceDigest(`sha256:${'1'.repeat(64)}`),
        bytes: new TextEncoder().encode(JSON.stringify(document)),
    });
}

function readText(model: unknown): string | null {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    const root = (model as Readonly<Record<string, unknown>>).root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    return typeof (root as Readonly<Record<string, unknown>>).text === 'string'
        ? (root as Readonly<Record<string, unknown>>).text as string
        : null;
}

function readAction(model: unknown): string | null {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    const nodes = (model as Readonly<Record<string, unknown>>).nodes;
    if (!Array.isArray(nodes)) return null;
    for (const nodeValue of nodes) {
        if (!nodeValue || typeof nodeValue !== 'object' || Array.isArray(nodeValue)) continue;
        const node = nodeValue as Readonly<Record<string, unknown>>;
        const action = node.action;
        if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
        const qualifiedId = (action as Readonly<Record<string, unknown>>).qualifiedId;
        if (typeof qualifiedId === 'string') return qualifiedId;
    }
    return null;
}

function readCollectionQuery(model: unknown): string | null {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    const root = (model as Readonly<Record<string, unknown>>).root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    const record = root as Readonly<Record<string, unknown>>;
    if (record.kind !== 'collectionList') return null;
    const query = record.query;
    return query && typeof query === 'object' && !Array.isArray(query)
        && typeof (query as Readonly<Record<string, unknown>>).id === 'string'
        ? (query as Readonly<Record<string, unknown>>).id as string
        : null;
}

function readCollectionCommand(model: unknown, key: 'primaryCommand' | 'secondaryCommands'): string | null {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    const root = (model as Readonly<Record<string, unknown>>).root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    const record = root as Readonly<Record<string, unknown>>;
    if (record.kind !== 'collectionList') return null;
    const command = key === 'primaryCommand'
        ? record.primaryCommand
        : Array.isArray(record.secondaryCommands) ? record.secondaryCommands[0] : null;
    if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
    const target = (command as Readonly<Record<string, unknown>>).kind === 'action'
        ? (command as Readonly<Record<string, unknown>>).action
        : (command as Readonly<Record<string, unknown>>).destination;
    return target && typeof target === 'object' && !Array.isArray(target)
        && typeof (target as Readonly<Record<string, unknown>>).qualifiedId === 'string'
        ? (target as Readonly<Record<string, unknown>>).qualifiedId as string
        : null;
}

function readTargetedSurfaceInstanceKey(model: unknown): string | null {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    const root = (model as Readonly<Record<string, unknown>>).root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    const record = root as Readonly<Record<string, unknown>>;
    return record.kind === 'targetedSurface' && typeof record.instanceKey === 'string'
        ? record.instanceKey
        : null;
}

function readTargetedSurfaceGeneration(model: unknown): string | null {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    const root = (model as Readonly<Record<string, unknown>>).root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    const surface = (root as Readonly<Record<string, unknown>>).surface;
    if (!surface || typeof surface !== 'object' || Array.isArray(surface)) return null;
    const contributor = (surface as Readonly<Record<string, unknown>>).contributor;
    return contributor && typeof contributor === 'object' && !Array.isArray(contributor)
        && typeof (contributor as Readonly<Record<string, unknown>>).immutableGenerationId === 'string'
        ? (contributor as Readonly<Record<string, unknown>>).immutableGenerationId as string
        : null;
}

function unexpectedHostApiCall(method: string): never {
    throw new Error(`unexpected_plugin_ui_host_api_call:${method}`);
}

function createDocumentHost(input: Readonly<{
    readResource: PluginUiHostApi['readResource'];
    methods?: HostMethods;
    watchResource?: PluginUiHostApi['watchResource'];
}>): PluginUiHostApi {
    return {
        version: () => ({
            apiVersion: '1.0.0',
            wireVersion: 1,
            methods: input.methods ?? [],
        }),
        context: async () => unexpectedHostApiCall('context'),
        watchContext: async () => unexpectedHostApiCall('watchContext'),
        publishCurrentUiContext: () => unexpectedHostApiCall('publishCurrentUiContext'),
        settleEphemeralInput: async () => unexpectedHostApiCall('settleEphemeralInput'),
        activeComposer: async () => unexpectedHostApiCall('activeComposer'),
        readComposer: async () => unexpectedHostApiCall('readComposer'),
        watchComposer: async () => unexpectedHostApiCall('watchComposer'),
        applyComposer: async () => unexpectedHostApiCall('applyComposer'),
        focusComposer: async () => unexpectedHostApiCall('focusComposer'),
        setComposerDecorations: async () => unexpectedHostApiCall('setComposerDecorations'),
        acquireComposerInputLock: async () => unexpectedHostApiCall('acquireComposerInputLock'),
        pickComposerMedia: async () => unexpectedHostApiCall('pickComposerMedia'),
        inspectComposerContent: async () => unexpectedHostApiCall('inspectComposerContent'),
        releaseComposerContent: async () => unexpectedHostApiCall('releaseComposerContent'),
        executeAction: async () => unexpectedHostApiCall('executeAction'),
        selectActionInput: async () => unexpectedHostApiCall('selectActionInput'),
        openNewSession: async () => unexpectedHostApiCall('openNewSession'),
        openConnectedAccounts: async () => unexpectedHostApiCall('openConnectedAccounts'),
        readResource: input.readResource,
        statOpenableContent: async () => unexpectedHostApiCall('statOpenableContent'),
        readOpenableContent: async () => unexpectedHostApiCall('readOpenableContent'),
        openSurface: async () => unexpectedHostApiCall('openSurface'),
        replacePageLocation: async () => unexpectedHostApiCall('replacePageLocation'),
        notify: async () => unexpectedHostApiCall('notify'),
        confirm: async () => unexpectedHostApiCall('confirm'),
        // Both real transports refuse an unadvertised host method locally with
        // the typed `unsupported_method` failure rather than a generic throw,
        // and the Resource store reads exactly that code to decide `unsupported`
        // instead of a retryable reconnect. A fake that threw an untyped Error
        // could never reach the unsupported branch these mounts assert.
        watchResource: input.watchResource ?? (async () => {
            if ((input.methods ?? []).includes('watchResource')) {
                return unexpectedHostApiCall('watchResource');
            }
            throw new PluginError({
                code: 'unsupported_method',
                message: 'watchResource is not installed for this mount',
                retryable: false,
            });
        }),
        diagnostic: () => unexpectedHostApiCall('diagnostic'),
        readClipboard: async () => unexpectedHostApiCall('readClipboard'),
        writeClipboard: async () => unexpectedHostApiCall('writeClipboard'),
        openExternalLink: async () => unexpectedHostApiCall('openExternalLink'),
    };
}

type DocumentAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

type PluginHostApiProviderPrivateResourceProps = React.ComponentProps<typeof PluginHostApiProvider> & Readonly<{
    accountLifetime?: DocumentAccountLifetime | null;
    resourceStoreGeneration?: string;
    mountedPluginId?: string;
}>;

const PluginHostApiProviderWithPrivateResourceBinding = PluginHostApiProvider as unknown as React.ComponentType<
    PluginHostApiProviderPrivateResourceProps
>;

function attachDocumentResourceScope(
    hostApi: PluginUiHostApi,
    accountLifetime: DocumentAccountLifetime,
    generation = '7',
): PluginUiHostApi {
    Object.defineProperty(hostApi, Symbol.for('happier.pluginUi.privateResourceStoreScope.v1'), {
        value: Object.freeze({
            pluginId: 'acme.dashboard',
            accountLifetime,
            generation,
        }),
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return hostApi;
}

function createCurrentDocumentAccountLifetime(): DocumentAccountLifetime {
    return Object.freeze({
        isCurrent: (): boolean => true,
        onRetire: () => Object.freeze({ dispose(): void {} }),
    });
}

function createRetirableDocumentAccountLifetime(): Readonly<{
    lifetime: DocumentAccountLifetime;
    retire(): void;
}> {
    let current = true;
    const retirementListeners = new Set<() => void>();
    const lifetime: DocumentAccountLifetime = Object.freeze({
        isCurrent: (): boolean => current,
        onRetire: (cancel) => {
            if (!current) {
                cancel();
                return Object.freeze({ dispose(): void {} });
            }
            retirementListeners.add(cancel);
            return Object.freeze({ dispose: (): void => { retirementListeners.delete(cancel); } });
        },
    });
    return Object.freeze({
        lifetime,
        retire: (): void => {
            if (!current) return;
            current = false;
            for (const listener of [...retirementListeners]) listener();
            retirementListeners.clear();
        },
    });
}

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function Probe(props: Readonly<{
    staticModel?: Model;
    mountScope?: DeclarativeDocumentSourceMountScope;
    onCommit?: (value: string | null) => void;
    retireBeforePassiveAdoption?: () => void;
    preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[];
}>) {
    const source = useDeclarativeDocumentSource({
        pluginId: 'acme.dashboard',
        staticModel: props.staticModel ?? staticModel,
        documentSource: { kind: 'resource', resourceId: 'live-dashboard' },
        ...(props.mountScope ? { mountScope: props.mountScope } : {}),
        ...(props.preparedTargetedSurfaces === undefined
            ? {}
            : { preparedTargetedSurfaces: props.preparedTargetedSurfaces }),
    });
    const value = readText(source.model);
    React.useLayoutEffect(() => {
        props.retireBeforePassiveAdoption?.();
        props.onCommit?.(value);
    }, [
        props.onCommit,
        props.retireBeforePassiveAdoption,
        source.freshness,
        source.invalidDocument,
        source.pending,
        source.subscription,
        value,
    ]);
    return React.createElement('output', {
        value,
        action: readAction(source.model),
        query: readCollectionQuery(source.model),
        primaryCommand: readCollectionCommand(source.model, 'primaryCommand'),
        secondaryCommand: readCollectionCommand(source.model, 'secondaryCommands'),
        targetedSurfaceInstanceKey: readTargetedSurfaceInstanceKey(source.model),
        targetedSurfaceGeneration: readTargetedSurfaceGeneration(source.model),
        invalidDocument: source.invalidDocument,
        sourceError: source.sourceError,
        documentPresentation: source.presentation,
        freshness: source.freshness,
        pending: source.pending,
        subscription: source.subscription,
        resourceError: source.resourceError,
        retry: source.retry,
    });
}

function renderProbe(
    hostApi: PluginUiHostApi,
    model?: Model,
    mountScope?: DeclarativeDocumentSourceMountScope,
    onCommit?: (value: string | null) => void,
    preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[],
) {
    return (
        <PluginHostApiProvider hostApi={hostApi}>
            <Probe
                {...(model ? { staticModel: model } : {})}
                {...(mountScope ? { mountScope } : {})}
                {...(onCommit ? { onCommit } : {})}
                {...(preparedTargetedSurfaces === undefined ? {} : { preparedTargetedSurfaces })}
            />
        </PluginHostApiProvider>
    );
}

function renderProbeWithPrivateResourceBinding(
    hostApi: PluginUiHostApi,
    mountScope: DeclarativeDocumentSourceMountScope,
    accountLifetime: DocumentAccountLifetime,
) {
    return (
        <PluginHostApiProviderWithPrivateResourceBinding
            hostApi={hostApi}
            accountLifetime={accountLifetime}
            resourceStoreGeneration={mountScope.generation}
            mountedPluginId={mountScope.pluginId}
        >
            <Probe mountScope={mountScope} />
        </PluginHostApiProviderWithPrivateResourceBinding>
    );
}

describe('useDeclarativeDocumentSource', () => {
    it('keeps static first paint, then adopts a whole live Resource document through the mounted host API', async () => {
        const pendingRead = deferred<ResourceContent>();
        const readResource = vi.fn(() => pendingRead.promise);
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
        });

        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');
        expect(tree.root.findByType('output').props).toMatchObject({
            freshness: 'unknown',
            pending: 'initial',
            subscription: 'unsupported',
            resourceError: undefined,
        });
        expect(readResource).toHaveBeenCalledWith(
            'live-dashboard',
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );

        await act(async () => {
            pendingRead.resolve(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Live dashboard' },
            }));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Live dashboard',
            freshness: 'fresh',
            pending: 'idle',
            subscription: 'unsupported',
            resourceError: undefined,
        });
    });

    it('retains live document LKG while a refresh is pending and projects the Resource facts unchanged', async () => {
        const pendingRefresh = deferred<ResourceContent>();
        const readResource = vi.fn()
            .mockResolvedValueOnce(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Live dashboard' },
            }))
            .mockImplementationOnce(() => pendingRefresh.promise);
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
            await flushMicrotasks();
        });
        const output = tree.root.findByType('output');
        expect(output.props.value).toBe('Live dashboard');

        await act(async () => {
            output.props.retry();
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Live dashboard',
            freshness: 'stale',
            pending: 'refresh',
            subscription: 'unsupported',
            resourceError: undefined,
        });
    });

    it('maps Resource facts once while preserving dynamic LKG instead of replacing it with loading', async () => {
        const pendingRead = deferred<ResourceContent>();
        const pendingRefresh = deferred<ResourceContent>();
        const readResource = vi.fn()
            .mockImplementationOnce(() => pendingRead.promise)
            .mockImplementationOnce(() => pendingRefresh.promise);
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
        });
        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Static dashboard',
            documentPresentation: 'initialLoading',
        });

        await act(async () => {
            pendingRead.resolve(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Live dashboard' },
            }));
            await flushMicrotasks();
        });
        const output = tree.root.findByType('output');
        expect(output.props).toMatchObject({
            value: 'Live dashboard',
            documentPresentation: 'fresh',
        });

        await act(async () => {
            output.props.retry();
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Live dashboard',
            documentPresentation: 'refreshingLkg',
        });

        await act(async () => {
            pendingRefresh.resolve(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Replacement dashboard' },
            }, { digest: resourceDigest(`sha256:${'2'.repeat(64)}`) }));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Replacement dashboard',
            documentPresentation: 'fresh',
        });
    });

    it('does not adopt a delivered candidate after mount retirement before passive adoption', async () => {
        const pendingRead = deferred<ResourceContent>();
        const hostApi = createDocumentHost({ readResource: vi.fn(() => pendingRead.promise) });
        const retirement = createRetirableDocumentAccountLifetime();
        const mountScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime: retirement.lifetime,
            mountLifetime: retirement.lifetime,
        });
        let armRetirement = false;
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <PluginHostApiProvider hostApi={hostApi}>
                    <Probe
                        mountScope={mountScope}
                        retireBeforePassiveAdoption={() => {
                            if (armRetirement) retirement.retire();
                        }}
                    />
                </PluginHostApiProvider>,
            );
        });
        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');

        armRetirement = true;
        await act(async () => {
            pendingRead.resolve(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Stale delivered dashboard' },
            }));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Static dashboard',
            invalidDocument: false,
        });
    });

    it('does not adopt a delivered candidate after its exact mount retires while the Account remains current', async () => {
        const pendingRead = deferred<ResourceContent>();
        const hostApi = createDocumentHost({ readResource: vi.fn(() => pendingRead.promise) });
        const mountRetirement = createRetirableDocumentAccountLifetime();
        const accountLifetime = createCurrentDocumentAccountLifetime();
        const mountScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime,
            mountLifetime: mountRetirement.lifetime,
        });
        let armRetirement = false;
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <PluginHostApiProvider hostApi={hostApi}>
                    <Probe
                        mountScope={mountScope}
                        retireBeforePassiveAdoption={() => {
                            if (armRetirement) mountRetirement.retire();
                        }}
                    />
                </PluginHostApiProvider>,
            );
        });
        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');

        armRetirement = true;
        await act(async () => {
            pendingRead.resolve(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Stale mount dashboard' },
            }));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Static dashboard',
            invalidDocument: false,
        });
    });

    it('adopts canonical last-known-good bytes while the store resync remains pending', async () => {
        const pendingRefresh = deferred<ResourceContent>();
        const readResource = vi.fn()
            .mockResolvedValueOnce(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Live dashboard' },
            }))
            .mockImplementationOnce(() => pendingRefresh.promise);
        const hostApi = createDocumentHost({
            readResource,
            methods: ['watchResource'],
            watchResource: async () => ({
                dispose: vi.fn(),
                // The exact mounted watch says the daemon has advanced since
                // the baseline read, so L1 correctly starts one re-sync.
                admittedDigest: resourceDigest(`sha256:${'2'.repeat(64)}`),
            }),
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
            await flushMicrotasks();
        });

        // The baseline remains the declarative LKG while L1's admitted-digest
        // re-sync is pending. This adapter must preserve every Resource fact,
        // not locally clear the document into a spinner/loading state.
        expect(readResource).toHaveBeenCalledTimes(2);
        expect(tree.root.findByType('output').props.value).toBe('Live dashboard');
        expect(tree.root.findByType('output').props).toMatchObject({
            documentPresentation: 'refreshingLkg',
            freshness: 'stale',
            pending: 'refresh',
            subscription: 'live',
            resourceError: undefined,
        });
    });

    it('adopts a dynamic Action from the full admitted inventory even when the static root has no Action node', async () => {
        const readResource = vi.fn(async () => resourceRead({
            version: 1,
            root: {
                kind: 'stack',
                children: [
                    { kind: 'text', text: 'Live dashboard' },
                    { kind: 'action', action: 'refresh', label: 'Refresh' },
                ],
            },
        }));
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModelWithRefreshAction));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props.action).toBe('acme.dashboard/refresh');
    });

    it('adopts a dynamic targeted Surface only through the current mounted-target inventory', async () => {
        const readResource = vi.fn(async () => resourceRead({
            version: 1,
            root: {
                kind: 'targetedSurface',
                surface: {
                    point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
                    contributor: { pluginId: 'acme.review', contributionId: 'detail' },
                    role: 'detail',
                },
                input: { reviewId: 'review-42' },
                instanceKey: 'review-42',
            },
        }));
        const hostApi = createDocumentHost({ readResource });
        const preparedTargetedSurfaces = [prepareTargetedSurfaceInventoryEntry({
            targetPluginId: 'acme.dashboard',
            handle: {
                point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
                contributor: {
                    pluginId: 'acme.review',
                    contributionId: 'detail',
                    immutableGenerationId: 'review-generation-a',
                },
                role: 'detail',
                presentation: 'content',
            },
            inputSchema: defineProtocolObject({
                reviewId: defineProtocolString(),
            }, { policy: 'closed' }).jsonSchema,
        })];
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModel, undefined, undefined, preparedTargetedSurfaces));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: null,
            targetedSurfaceInstanceKey: expect.stringMatching(/^targeted-surface:v1:[a-f0-9]{64}$/u),
            targetedSurfaceGeneration: 'review-generation-a',
            invalidDocument: false,
        });
    });

    it('re-normalizes an adopted targeted Surface when its mounted-target generation changes', async () => {
        const dynamicDocument = {
            version: 1,
            root: {
                kind: 'targetedSurface',
                surface: {
                    point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
                    contributor: { pluginId: 'acme.review', contributionId: 'detail' },
                    role: 'detail',
                },
                input: { reviewId: 'review-42' },
                instanceKey: 'review-42',
            },
        };
        const inventoryFor = (immutableGenerationId: string) => [prepareTargetedSurfaceInventoryEntry({
            targetPluginId: 'acme.dashboard',
            handle: {
                point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
                contributor: {
                    pluginId: 'acme.review',
                    contributionId: 'detail',
                    immutableGenerationId,
                },
                role: 'detail',
                presentation: 'content',
            },
            inputSchema: defineProtocolObject({
                reviewId: defineProtocolString(),
            }, { policy: 'closed' }).jsonSchema,
        })];
        const hostApi = createDocumentHost({
            readResource: vi.fn(async () => resourceRead(dynamicDocument)),
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModel, undefined, undefined, inventoryFor('review-generation-a')));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.targetedSurfaceGeneration).toBe('review-generation-a');

        await act(async () => {
            tree.update(renderProbe(hostApi, staticModel, undefined, undefined, inventoryFor('review-generation-b')));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            targetedSurfaceGeneration: 'review-generation-b',
            invalidDocument: false,
        });
    });

    it('adopts a dynamic Collection query from the full Data inventory even when the static root is text only', async () => {
        const readResource = vi.fn(async () => resourceRead({
            version: 1,
            root: {
                kind: 'collectionList',
                source: {
                    collectionId: 'tasks',
                    uiQueryId: 'open-tasks',
                    parameters: { status: 'open' },
                },
                projection: {
                    titleField: { field: 'title', kind: 'string' },
                    badgeField: { field: 'status', kind: 'string' },
                },
            },
        }));
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModelWithOpenTasksQuery));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props.query).toBe('open-tasks');
    });

    it('adopts dynamic fixed row commands only when both targets are in the static inventory', async () => {
        const readResource = vi.fn(async () => resourceRead({
            version: 1,
            root: {
                kind: 'collectionList',
                source: {
                    collectionId: 'tasks',
                    uiQueryId: 'open-tasks',
                    parameters: { status: 'open' },
                },
                projection: {
                    titleField: { field: 'title', kind: 'string' },
                    badgeField: { field: 'status', kind: 'string' },
                },
                primaryCommand: { kind: 'action', action: 'refresh' },
                secondaryCommands: [{ kind: 'openSurface', destination: 'task-details' }],
            },
        }));
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModelWithOpenTasksRowCommands));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props.primaryCommand).toBe('acme.dashboard/refresh');
        expect(tree.root.findByType('output').props.secondaryCommand).toBe('acme.dashboard/task-details');
    });

    it('rejects a dynamic Collection query when the projected Data inventory has an odd duplicate key', async () => {
        const readResource = vi.fn(async () => resourceRead({
            version: 1,
            root: {
                kind: 'collectionList',
                source: {
                    collectionId: 'tasks',
                    uiQueryId: 'open-tasks',
                    parameters: { status: 'open' },
                },
                projection: {
                    titleField: { field: 'title', kind: 'string' },
                    badgeField: { field: 'status', kind: 'string' },
                },
            },
        }));
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModelWithOddDuplicateOpenTasksQuery));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');
        expect(tree.root.findByType('output').props.query).toBeNull();
    });

    it('rejects a dynamic Action that is absent from the full admitted inventory', async () => {
        const readResource = vi.fn(async () => resourceRead({
            version: 1,
            root: { kind: 'action', action: 'not-declared', label: 'Do not adopt' },
        }));
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModelWithRefreshAction));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');
        expect(tree.root.findByType('output').props.action).toBeNull();
    });

    it('rejects an otherwise valid document when the returned Resource MIME is not exact and retains static LKG', async () => {
        const readResource = vi.fn(async () => resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Rejected dashboard' },
        }, { contentType: `${DOCUMENT_CONTENT_TYPE}; charset=utf-8` }));
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
            await flushMicrotasks();
        });

        expect(readResource).toHaveBeenCalledWith('live-dashboard', expect.anything());
        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');
    });

    it('refuses an over-ceiling document before decoding it and retains static LKG', async () => {
        // The document is decoded, parsed and normalized synchronously on the UI
        // thread, so the declared per-read ceiling must be checked on the raw
        // byte length rather than after a full decode.
        const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
        // A document whose envelope and node tree are otherwise valid and which
        // fails ONLY the ceiling: the padding lives inside the root text node,
        // which carries no length bound of its own. Padding the envelope with an
        // extra top-level key instead would be rejected by the strict envelope
        // anyway, leaving the retained-LKG and invalid-document assertions below
        // unable to fail when the ceiling is removed.
        const oversized = resourceRead({
            version: 1,
            root: {
                kind: 'text',
                text: `Oversized dashboard${'x'.repeat(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1)}`,
            },
        }, { digest: resourceDigest(`sha256:${'2'.repeat(64)}`) });
        expect(oversized.bytes.byteLength)
            .toBeGreaterThan(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1);
        const readResource = vi.fn(async () => oversized);
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        try {
            await act(async () => {
                tree = create(renderProbe(hostApi));
                await flushMicrotasks();
            });

            expect(tree.root.findByType('output').props.value).toBe('Static dashboard');
            expect(tree.root.findByType('output').props.invalidDocument).toBe(true);
            expect(decodeSpy).not.toHaveBeenCalled();
        } finally {
            decodeSpy.mockRestore();
        }
    });

    it('retries an invalid Resource document through the mounted store and atomically adopts its replacement', async () => {
        const rejected = resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Rejected dashboard' },
        }, {
            contentType: 'application/json',
            digest: resourceDigest(`sha256:${'2'.repeat(64)}`),
        });
        const recovered = resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Recovered dashboard' },
        }, { digest: `sha256:${'3'.repeat(64)}` });
        const readResource = vi.fn()
            .mockResolvedValueOnce(rejected)
            .mockResolvedValueOnce(recovered);
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
            await flushMicrotasks();
        });
        const rejectedOutput = tree.root.findByType('output');
        expect(rejectedOutput.props.value).toBe('Static dashboard');
        expect(rejectedOutput.props.invalidDocument).toBe(true);
        expect(rejectedOutput.props).toMatchObject({
            freshness: 'fresh',
            pending: 'idle',
            subscription: 'unsupported',
            documentPresentation: 'invalidDocument',
            resourceError: undefined,
        });

        await act(async () => {
            rejectedOutput.props.retry();
            await flushMicrotasks();
        });

        expect(readResource).toHaveBeenCalledTimes(2);
        const recoveredOutput = tree.root.findByType('output');
        expect(recoveredOutput.props.value).toBe('Recovered dashboard');
        expect(recoveredOutput.props.invalidDocument).toBe(false);
    });

    it('reports an initial Resource read failure and retries without inventing a document', async () => {
        const recovered = resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Recovered dashboard' },
        }, { digest: `sha256:${'4'.repeat(64)}` });
        const readResource = vi.fn()
            .mockRejectedValueOnce(new Error('resource_unavailable'))
            .mockResolvedValueOnce(recovered);
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
            await flushMicrotasks();
        });
        const failedOutput = tree.root.findByType('output');
        expect(failedOutput.props).toMatchObject({
            value: 'Static dashboard',
            sourceError: true,
            documentPresentation: 'terminalUnavailable',
            freshness: 'unknown',
            pending: 'idle',
            subscription: 'unsupported',
            resourceError: { message: 'resource_unavailable' },
        });

        await act(async () => {
            failedOutput.props.retry();
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Recovered dashboard',
            sourceError: false,
        });
    });

    it('reports a failed Resource refresh while retaining dynamic LKG, then clears it after retry', async () => {
        const adopted = resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Adopted dashboard' },
        }, { digest: `sha256:${'5'.repeat(64)}` });
        const recovered = resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Recovered dashboard' },
        }, { digest: `sha256:${'6'.repeat(64)}` });
        const readResource = vi.fn()
            .mockResolvedValueOnce(adopted)
            .mockRejectedValueOnce(new Error('refresh_unavailable'))
            .mockResolvedValueOnce(recovered);
        const hostApi = createDocumentHost({ readResource });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.value).toBe('Adopted dashboard');

        await act(async () => {
            tree.root.findByType('output').props.retry();
            await flushMicrotasks();
        });
        const failedOutput = tree.root.findByType('output');
        expect(failedOutput.props).toMatchObject({
            value: 'Adopted dashboard',
            sourceError: true,
            documentPresentation: 'staleReconnectingLkg',
            freshness: 'stale',
            pending: 'idle',
            subscription: 'unsupported',
            resourceError: { message: 'refresh_unavailable' },
        });

        await act(async () => {
            failedOutput.props.retry();
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Recovered dashboard',
            sourceError: false,
        });
    });

    it('does not let a retired mounted host-API lifetime publish into its replacement', async () => {
        const accountALifetime = createCurrentDocumentAccountLifetime();
        const accountBLifetime = createCurrentDocumentAccountLifetime();
        const accountAScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime: accountALifetime,
            mountLifetime: accountALifetime,
        });
        const accountBScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime: accountBLifetime,
            mountLifetime: accountBLifetime,
        });
        const accountARead = deferred<ResourceContent>();
        const accountBRead = deferred<ResourceContent>();
        const accountAHostApi = attachDocumentResourceScope(
            createDocumentHost({
                readResource: vi.fn()
                    .mockResolvedValueOnce(resourceRead({
                        version: 1,
                        root: { kind: 'text', text: 'Account A dashboard' },
                    }, { digest: `sha256:${'a'.repeat(64)}` }))
                    .mockImplementationOnce(() => accountARead.promise),
            }),
            accountALifetime,
        );
        const accountBReadResource = vi.fn(() => accountBRead.promise);
        const accountBHostApi = attachDocumentResourceScope(
            createDocumentHost({ readResource: accountBReadResource }),
            accountBLifetime,
        );
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(accountAHostApi, undefined, accountAScope));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.value).toBe('Account A dashboard');

        await act(async () => {
            tree.update(renderProbe(accountBHostApi, undefined, accountBScope));
            await flushMicrotasks();
        });
        expect(accountBReadResource).toHaveBeenCalledTimes(1);
        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');

        await act(async () => {
            accountARead.resolve(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Account A dashboard' },
            }, { digest: `sha256:${'a'.repeat(64)}` }));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props.value).toBe('Static dashboard');
    });

    it('retires an adopted dynamic document with its Account lifetime before a replacement mounts', async () => {
        const account = createRetirableDocumentAccountLifetime();
        const mountScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime: account.lifetime,
            mountLifetime: account.lifetime,
        });
        const hostApi = createDocumentHost({
            readResource: vi.fn().mockResolvedValue(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Account A dashboard' },
            }, { digest: `sha256:${'a'.repeat(64)}` })),
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbeWithPrivateResourceBinding(hostApi, mountScope, account.lifetime));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.value).toBe('Account A dashboard');

        await act(async () => {
            account.retire();
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Static dashboard',
            documentPresentation: 'terminalUnavailable',
            freshness: 'unknown',
            pending: 'idle',
            subscription: 'ended',
        });
    });

    it('keeps an adopted dynamic document across a reconnect host replacement for the same current Account and generation', async () => {
        const accountLifetime = createCurrentDocumentAccountLifetime();
        const mountScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime,
            mountLifetime: accountLifetime,
        });
        const reconnectRead = deferred<ResourceContent>();
        const initialHostApi = attachDocumentResourceScope(
            createDocumentHost({
                readResource: vi.fn().mockResolvedValue(resourceRead({
                    version: 1,
                    root: { kind: 'text', text: 'Adopted dashboard' },
                }, { digest: `sha256:${'b'.repeat(64)}` })),
            }),
            accountLifetime,
        );
        const reconnectReadResource = vi.fn(() => reconnectRead.promise);
        const reconnectHostApi = attachDocumentResourceScope(
            createDocumentHost({ readResource: reconnectReadResource }),
            accountLifetime,
        );
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(initialHostApi, undefined, mountScope));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.value).toBe('Adopted dashboard');

        await act(async () => {
            tree.update(renderProbe(reconnectHostApi, undefined, mountScope));
            await flushMicrotasks();
        });

        expect(reconnectReadResource).toHaveBeenCalledWith(
            'live-dashboard',
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(tree.root.findByType('output').props.value).toBe('Adopted dashboard');

        await act(async () => {
            reconnectRead.resolve(resourceRead({
                version: 1,
                root: { kind: 'text', text: 'Reconnected dashboard' },
            }, { digest: `sha256:${'c'.repeat(64)}` }));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props.value).toBe('Reconnected dashboard');
    });

    it('retains dynamic LKG across an equivalent host static-model rematerialization', async () => {
        const accountLifetime = createCurrentDocumentAccountLifetime();
        const mountScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime,
            mountLifetime: accountLifetime,
        });
        const hostApi = attachDocumentResourceScope(
            createDocumentHost({
                readResource: vi.fn().mockResolvedValue(resourceRead({
                    version: 1,
                    root: { kind: 'text', text: 'Adopted dashboard' },
                }, { digest: `sha256:${'d'.repeat(64)}` })),
            }),
            accountLifetime,
        );
        const renderedValues: Array<string | null> = [];
        const onCommit = (value: string | null) => { renderedValues.push(value); };
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModel, mountScope, onCommit));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.value).toBe('Adopted dashboard');

        const updateStart = renderedValues.length;
        await act(async () => {
            // A daemon/settings placement update can reconstruct the same
            // admitted static model object. It is not a new document or
            // Account/generation lifetime, so it must not flash static LKG.
            tree.update(renderProbe(hostApi, Object.freeze({ ...staticModel }), mountScope, onCommit));
            await flushMicrotasks();
        });

        expect(renderedValues.slice(updateStart)).not.toContain('Static dashboard');
        expect(tree.root.findByType('output').props.value).toBe('Adopted dashboard');
    });

    it('treats a material static inventory replacement as a new document boundary', async () => {
        const accountLifetime = createCurrentDocumentAccountLifetime();
        const mountScope: DeclarativeDocumentSourceMountScope = Object.freeze({
            pluginId: 'acme.dashboard',
            generation: '7',
            accountLifetime,
            mountLifetime: accountLifetime,
        });
        const hostApi = attachDocumentResourceScope(
            createDocumentHost({
                readResource: vi.fn().mockResolvedValue(resourceRead({
                    version: 1,
                    root: { kind: 'action', action: 'refresh', label: 'Refresh' },
                }, { digest: `sha256:${'e'.repeat(64)}` })),
            }),
            accountLifetime,
        );
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi, staticModelWithRefreshAction, mountScope));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.action).toBe('acme.dashboard/refresh');

        await act(async () => {
            // This removes the Action from the admitted static inventory. It
            // must reset LKG before the unchanged Resource is reconsidered;
            // treating every placement update as equivalent would retain an
            // action the new static contract no longer admits.
            tree.update(renderProbe(hostApi, staticModel, mountScope));
            await flushMicrotasks();
        });

        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Static dashboard',
            action: null,
            invalidDocument: true,
        });
    });

    it('re-reads through the mounted Resource store on invalidation and retains the prior live document when that update is invalid', async () => {
        const liveResource = resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Live dashboard' },
        });
        const rejectedDigest = resourceDigest(`sha256:${'2'.repeat(64)}`);
        const rejectedResource = resourceRead({
            version: 1,
            root: { kind: 'text', text: 'Rejected replacement' },
        }, {
            contentType: 'application/json',
            digest: rejectedDigest,
        });
        let readCount = 0;
        const readResource = vi.fn(async () => {
            readCount += 1;
            return readCount === 1 ? liveResource : rejectedResource;
        });
        let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
        const watchResource: PluginUiHostApi['watchResource'] = async (_resource, listener) => {
            deliver = listener;
            return { dispose: vi.fn(), admittedDigest: liveResource.digest };
        };
        const hostApi = createDocumentHost({
            readResource,
            methods: ['watchResource'],
            watchResource,
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(renderProbe(hostApi));
            await flushMicrotasks();
        });
        expect(tree.root.findByType('output').props.value).toBe('Live dashboard');
        expect(readResource).toHaveBeenCalledTimes(1);
        if (!deliver) throw new Error('expected_live_resource_subscription');

        await act(async () => {
            deliver?.({
                version: 1,
                subscriptionId: 'live-dashboard-subscription',
                kind: 'invalidated',
                digest: rejectedDigest,
            });
            await flushMicrotasks();
        });

        expect(readResource).toHaveBeenCalledTimes(2);
        expect(tree.root.findByType('output').props).toMatchObject({
            value: 'Live dashboard',
            invalidDocument: true,
            documentPresentation: 'invalidDocument',
        });
    });
});
