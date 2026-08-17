import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    PluginUiCollectionQueryInput,
    PluginUiCollectionQueryPager,
    PluginUiCollectionQuerySnapshot,
    PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import { HappierListItem } from '@happier-dev/plugin-ui/presentation';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const {
    createActivePluginCollectionUiQueryPager,
} = vi.hoisted(() => ({
    createActivePluginCollectionUiQueryPager: vi.fn(() => {
        throw new Error('Declarative presentation must not construct a Data pager directly');
    }),
}));

vi.mock('@/sync/api/plugins/data/queryPluginCollectionUiQuery', () => ({
    createActivePluginCollectionUiQueryPager,
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => Object.freeze({
        serverId: 'collection-locality-server',
        serverUrl: 'https://collection-locality.example',
        generation: 1,
    }),
}));

import {
    DeclarativeCollectionList,
    type DeclarativeCollectionRowCommandContext,
} from './DeclarativeCollectionList';
import { DeclarativePluginSurface } from './DeclarativePluginSurface';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderScreen } from '@/dev/testkit';

const presentationTheme = Object.freeze({
    version: 1 as const,
    colors: Object.freeze({
        canvas: '#000000',
        surface: '#111111',
        elevatedSurface: '#222222',
        text: '#ffffff',
        secondaryText: '#cccccc',
        mutedText: '#999999',
        border: '#333333',
        divider: '#444444',
        focus: '#555555',
        accent: '#666666',
        onAccent: '#ffffff',
        success: '#00ff00',
        warning: '#ffff00',
        danger: '#ff0000',
        info: '#0000ff',
        control: '#777777',
        controlDisabled: '#888888',
        overlay: '#00000088',
    }),
    spacing: Object.freeze({ xsmall: 2, small: 4, medium: 8, large: 12, xlarge: 16 }),
    radii: Object.freeze({ small: 2, control: 4, panel: 8, pill: 999 }),
    typography: Object.freeze({
        body: Object.freeze({ fontSize: 14, lineHeight: 20, fontWeight: '400' }),
        label: Object.freeze({ fontSize: 14, lineHeight: 20, fontWeight: '600' }),
        title: Object.freeze({ fontSize: 18, lineHeight: 24, fontWeight: '600' }),
        caption: Object.freeze({ fontSize: 12, lineHeight: 16, fontWeight: '400' }),
        code: Object.freeze({ fontSize: 12, lineHeight: 16, fontFamily: 'monospace' }),
    }),
});

const node = Object.freeze({
    kind: 'collectionList',
    path: 'root',
    source: Object.freeze({
        collectionId: 'tasks',
        uiQueryId: 'open',
        parameters: Object.freeze({ status: 'open' }),
    }),
    query: Object.freeze({
        collection: Object.freeze({ pluginId: 'acme.tasks', collectionId: 'tasks' }),
        id: 'open',
        indexId: 'by-status',
        parameters: Object.freeze({
            status: Object.freeze({ kind: 'string', maxUtf8Bytes: 16, enum: Object.freeze(['open']) }),
        }),
        prefix: Object.freeze([Object.freeze({ kind: 'parameter', parameterId: 'status' })]),
        order: 'asc',
        pageSize: 50,
        projectedFields: Object.freeze([
            Object.freeze({ field: 'status', kind: 'string' }),
            Object.freeze({ field: 'title', kind: 'string' }),
        ]),
    }),
    projection: Object.freeze({
        titleField: Object.freeze({ field: 'title', kind: 'string' }),
        badgeField: Object.freeze({ field: 'status', kind: 'string' }),
    }),
});

function accountLifetime() {
    return Object.freeze({
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

function surfaceAccountLifetime(): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({
            serverId: 'collection-locality-server',
            accountId: 'collection-locality-account',
        }),
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

type DataPagerSnapshot = Readonly<{
    rows: PluginUiCollectionQuerySnapshot['rows'];
    hasMore: boolean;
    status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
}>;

function CollectionListWithData(
    props: Omit<React.ComponentProps<typeof DeclarativeCollectionList>, 'modelGeneration'>,
) {
    return <DeclarativeCollectionList modelGeneration="generation-a" {...props} />;
}

function createTestDataClient(
    openCollectionQuery: PluginUiDataClient['openCollectionQuery'],
): PluginUiDataClient {
    return Object.freeze({
        collection: () => {
            throw new Error('Collection mutation is outside declarative list presentation');
        },
        openCollectionQuery,
    });
}

function installDataPager(initialSnapshot: DataPagerSnapshot) {
    let snapshot: PluginUiCollectionQuerySnapshot = Object.freeze({
        ...initialSnapshot,
        rows: Object.freeze([...initialSnapshot.rows]),
    });
    const listeners = new Set<() => void>();
    const getSnapshot = vi.fn(() => snapshot);
    const subscribe = vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    });
    const refresh = vi.fn(async () => {});
    const loadMore = vi.fn(async () => {});
    const dispose = vi.fn(() => { listeners.clear(); });
    const pager: PluginUiCollectionQueryPager = Object.freeze({
        getSnapshot,
        subscribe,
        refresh,
        loadMore,
        dispose,
    });
    const openCollectionQuery = vi.fn(async (
        _input: PluginUiCollectionQueryInput,
    ): Promise<PluginUiCollectionQueryPager> => pager);

    return Object.freeze({
        getSnapshot,
        subscribe,
        refresh,
        loadMore,
        dispose,
        openCollectionQuery,
        dataClient: createTestDataClient(openCollectionQuery),
        publish(next: DataPagerSnapshot): void {
            snapshot = Object.freeze({
                ...next,
                rows: Object.freeze([...next.rows]),
            });
            for (const listener of [...listeners]) listener();
        },
    });
}

beforeEach(() => {
    vi.resetAllMocks();
});

describe('DeclarativeCollectionList', () => {
    it('retains the Data-owned pager across an equivalent host node rematerialization', async () => {
        const account = accountLifetime();
        const pager = installDataPager({
            status: 'ready',
            rows: [{
                context: {
                    collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                    rowId: 'retained-task',
                    revision: 4,
                },
                fields: { title: 'Retain the current page', status: 'open' },
            }],
            hasMore: false,
        });
        // A host placement update reconstructs its normalized node object even
        // when the admitted Data query identity is unchanged. A second pager
        // would discard the Data-owned page/LKG and restart its opaque cursor.
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={account}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });
        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:retained-task',
        })).toBeTruthy();

        await act(async () => {
            tree.update(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={Object.freeze({ ...node })}
                    accountLifetime={account}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });

        expect(pager.openCollectionQuery).toHaveBeenCalledTimes(1);
        expect(pager.dispose).not.toHaveBeenCalled();
        expect(pager.refresh).toHaveBeenCalledTimes(1);
        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:retained-task',
        })).toBeTruthy();
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
    });

    it('consumes the canonical Data pager before its initial refresh, subscribes to live snapshots, and has no raw-query fallback', async () => {
        const rows = [{
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: 'observed-task',
                revision: 5,
            },
            fields: { title: 'Observed live data', status: 'open' },
        }];
        const pager = installDataPager({
            status: 'ready',
            rows,
            hasMore: false,
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });

        expect(pager.openCollectionQuery).toHaveBeenCalledWith({
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
            signal: expect.any(AbortSignal),
        });
        expect(pager.subscribe).toHaveBeenCalledTimes(1);
        expect(pager.refresh).toHaveBeenCalledTimes(1);
        expect(pager.subscribe.mock.invocationCallOrder[0])
            .toBeLessThan(pager.refresh.mock.invocationCallOrder[0]!);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:observed-task',
        })).toBeTruthy();

        await act(async () => {
            pager.publish({
                status: 'ready',
                rows: [{
                    context: {
                        collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                        rowId: 'changed-task',
                        revision: 6,
                    },
                    fields: { title: 'Changed through the Data pager', status: 'open' },
                }],
                hasMore: false,
            });
            await flushMicrotasks();
        });
        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:changed-task',
        })).toBeTruthy();
        expect(tree.root.findAllByProps({
            testID: 'plugin-declarative-collection-list:root:row:observed-task',
        })).toHaveLength(0);
    });

    it('maps a validated Data pager snapshot into list presentation', async () => {
        const rows = [{
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: 'task-1',
                revision: 3,
            },
            fields: { title: 'Ship direct data', status: 'open' },
        }];
        const pager = installDataPager({ status: 'ready', rows, hasMore: false });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });

        expect(pager.openCollectionQuery).toHaveBeenCalledWith({
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
            signal: expect.any(AbortSignal),
        });
        expect(pager.refresh).toHaveBeenCalledTimes(1);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
        const row = tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:task-1',
        });
        expect(row).toBeTruthy();
        const rendered = JSON.stringify(tree.toJSON());
        expect(rendered).toContain('Ship direct data');
        expect(rendered).toContain('open');
    });

    it('preserves same-row mounted state when Data publishes a newer CAS revision', async () => {
        const mountedIdentities: number[] = [];
        const unmountedIdentities: number[] = [];
        let nextIdentity = 1;
        function RowStateMarker(props: Readonly<{ revision: number }>) {
            const identity = React.useRef<number | null>(null);
            if (identity.current === null) identity.current = nextIdentity++;
            React.useEffect(() => {
                const currentIdentity = identity.current!;
                mountedIdentities.push(currentIdentity);
                return () => { unmountedIdentities.push(currentIdentity); };
            }, []);
            return React.createElement('RowStateMarker', {
                identity: identity.current,
                revision: props.revision,
            });
        }

        const resolveRowCommands: NonNullable<React.ComponentProps<typeof DeclarativeCollectionList>['resolveRowCommands']> = (context) => ({
            primary: {
                id: 'action:acme.tasks/inspect',
                label: 'Inspect task',
                disabled: false,
                icon: <RowStateMarker revision={context.revision} />,
            },
            secondary: [],
        });
        const pager = installDataPager({
            status: 'ready',
            rows: [{
                context: {
                    collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                    rowId: 'same-task',
                    revision: 1,
                },
                fields: { title: 'Before CAS update', status: 'open' },
            }],
            hasMore: false,
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                    resolveRowCommands={resolveRowCommands}
                />,
            );
            await flushMicrotasks();
        });
        expect(mountedIdentities).toEqual([1]);
        expect(unmountedIdentities).toEqual([]);

        await act(async () => {
            pager.publish({
                status: 'ready',
                rows: [{
                    context: {
                        collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                        rowId: 'same-task',
                        revision: 2,
                    },
                    fields: { title: 'After CAS update', status: 'open' },
                }],
                hasMore: false,
            });
            await flushMicrotasks();
        });

        expect(mountedIdentities).toEqual([1]);
        expect(unmountedIdentities).toEqual([]);
        expect(tree.root.findByType('RowStateMarker').props).toMatchObject({
            identity: 1,
            revision: 2,
        });
        expect(JSON.stringify(tree.toJSON())).toContain('After CAS update');
    });

    it('renders one semantic row and one bounded command surface for each row in a maximum Data page', async () => {
        // `DATA-UI-QUERY` owns the maximum 200-row page. This host list stays
        // inside DeclarativePluginSurface's one scroll owner rather than
        // adding a competing page/query or nested virtualizer here.
        const rows = Array.from({ length: 200 }, (_, index) => ({
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: `bounded-task-${index}`,
                revision: index + 1,
            },
            fields: { title: `Bounded task ${index}`, status: 'open' },
        }));
        const pager = installDataPager({ status: 'ready', rows, hasMore: false });
        const resolveRowCommands = vi.fn(() => ({
            primary: {
                id: 'action:acme.tasks/inspect',
                label: 'Inspect task',
                disabled: false,
            },
            secondary: [{
                id: 'destination:acme.tasks/task-details',
                label: 'Open task details',
                disabled: false,
            }],
        }));
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                    resolveRowCommands={resolveRowCommands}
                />,
            );
            await flushMicrotasks();
        });

        expect(resolveRowCommands).toHaveBeenCalledTimes(200);
        expect(tree.root.findAllByType(HappierListItem)).toHaveLength(200);
        expect(tree.root.findAllByType(DropdownMenu)).toHaveLength(200);
        expect(pager.openCollectionQuery).toHaveBeenCalledTimes(1);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
    });

    it('keeps actual embedded row command work local when one semantic row changes in a 200-row pager snapshot', async () => {
        // This exercises DeclarativeCollectionList's embedded branch itself,
        // rather than the plugin-ui hook fixture's test-authored memo row.
        // The Data pager may materialize a fresh snapshot, so unchanged rows
        // deliberately receive fresh object identities here. The changed row
        // keeps its command context and changes only a displayed field, which
        // rejects both shallow-reference and revision-only memo boundaries.
        const rows = Array.from({ length: 200 }, (_, index) => ({
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: `local-task-${index}`,
                revision: 1,
            },
            fields: { title: `Local task ${index}`, status: 'open' },
        }));
        const pager = installDataPager({ status: 'ready', rows, hasMore: false });
        const resolveRowCommands = vi.fn((context: DeclarativeCollectionRowCommandContext) => ({
            primary: {
                id: `action:acme.tasks/inspect:${context.rowId}`,
                label: 'Inspect task',
                disabled: false,
            },
            secondary: [],
        }));
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                    resolveRowCommands={resolveRowCommands}
                />,
            );
            await flushMicrotasks();
        });

        expect(resolveRowCommands).toHaveBeenCalledTimes(200);
        // Embedded lists retain their parent's scroll owner; this locality
        // boundary must not convert the branch into a nested FlatList.
        expect(tree.root.findAllByType('FlatList')).toHaveLength(0);
        resolveRowCommands.mockClear();

        await act(async () => {
            pager.publish({
                status: 'ready',
                rows: rows.map((row, index) => ({
                    context: {
                        collection: { ...row.context.collection },
                        rowId: row.context.rowId,
                        revision: row.context.revision,
                    },
                    fields: {
                        ...row.fields,
                        ...(index === 137 ? { title: 'Local task 137 updated' } : {}),
                    },
                })),
                hasMore: false,
            });
            await flushMicrotasks();
        });

        expect(resolveRowCommands).toHaveBeenCalledTimes(1);
        expect(resolveRowCommands).toHaveBeenCalledWith(expect.objectContaining({
            rowId: 'local-task-137',
            revision: 1,
        }), node);
        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:local-task-137',
        }).props.title).toBe('Local task 137 updated');
        expect(tree.root.findAllByType('FlatList')).toHaveLength(0);
    });

    it('keeps unaffected embedded row commands stable when one composed Action becomes pending', async () => {
        const generation = 'composed-locality-generation';
        const action = Object.freeze({
            identity: Object.freeze({ pluginId: 'acme.tasks', localId: 'inspect' }),
            qualifiedId: 'acme.tasks/inspect',
            generation,
        });
        const collectionNode = Object.freeze({
            ...node,
            primaryCommand: Object.freeze({ kind: 'action', action }),
        });
        const rows = Array.from({ length: 200 }, (_, index) => ({
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: `composed-task-${index}`,
                revision: 1,
            },
            fields: { title: `Composed task ${index}`, status: 'open' },
        }));
        const pager = installDataPager({ status: 'ready', rows, hasMore: false });
        let settlePendingAction!: () => void;
        const pendingAction = new Promise<null>((resolve) => {
            settlePendingAction = () => { resolve(null); };
        });
        const dispatchAction = vi.fn(async () => await pendingAction);
        const screen = await renderScreen(
            <DeclarativePluginSurface
                pluginId="acme.tasks"
                model={{
                    visible: true,
                    identity: {
                        pluginId: 'acme.tasks',
                        localId: 'tasks',
                        qualifiedId: 'acme.tasks/tasks',
                        generation,
                    },
                    requiredHostMethods: [],
                    declarativeInventory: {
                        actions: [{ ...action, enabled: true, title: 'Inspect task' }],
                        destinations: [],
                        settings: [],
                        uiQueries: [node.query],
                    },
                    nodes: [],
                    root: collectionNode,
                }}
                interactionEnabled={true}
                daemonInteractionEnabled={true}
                dispatchAction={dispatchAction}
                actionAvailable={true}
                openSurface={async () => null}
                openSurfaceAvailable={false}
                authorityGeneration={1}
                accountLifetime={surfaceAccountLifetime()}
                dataClient={pager.dataClient}
                embeddedPresentation="content"
            />,
        );
        await vi.waitFor(() => expect(pager.openCollectionQuery).toHaveBeenCalledTimes(1));

        const row = (rowId: string) => {
            const match = screen.findAllByType(HappierListItem).find((candidate) => (
                candidate.props.testID === `plugin-declarative-collection-list:root:row:${rowId}`
            ));
            if (!match) throw new Error(`missing_composed_collection_row:${rowId}`);
            return match;
        };
        const targetRowId = 'composed-task-137';
        const initialOnPressByRowId = new Map(rows.map(({ context }) => [
            context.rowId,
            row(context.rowId).props.onPress,
        ]));
        expect(screen.findAllByType('FlatList')).toHaveLength(0);
        expect(row(targetRowId).props).toMatchObject({ disabled: false, busy: false });

        await act(async () => {
            screen.pressByTestId(`plugin-declarative-collection-list:root:row:${targetRowId}`);
            await Promise.resolve();
        });

        expect(dispatchAction).toHaveBeenCalledWith(action.identity, {
            collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
            rowId: targetRowId,
            revision: 1,
        });
        expect(row(targetRowId).props).toMatchObject({ disabled: true, busy: true });
        expect(rows.filter(({ context }) => (
            row(context.rowId).props.onPress !== initialOnPressByRowId.get(context.rowId)
        )).map(({ context }) => context.rowId)).toEqual([targetRowId]);

        const pendingOnPressByRowId = new Map(rows.map(({ context }) => [
            context.rowId,
            row(context.rowId).props.onPress,
        ]));
        await act(async () => {
            settlePendingAction();
            await pendingAction;
            await Promise.resolve();
        });
        expect(row(targetRowId).props).toMatchObject({ disabled: false, busy: false });
        expect(rows.filter(({ context }) => (
            row(context.rowId).props.onPress !== pendingOnPressByRowId.get(context.rowId)
        )).map(({ context }) => context.rowId)).toEqual([targetRowId]);
    });

    it('hands a surface-owned maximum page to the public virtualizer with stable row identity', async () => {
        const rows = Array.from({ length: 200 }, (_, index) => ({
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: `virtual-task-${index}`,
                revision: index + 1,
            },
            fields: { title: `Virtual task ${index}`, status: 'open' },
        }));
        const pager = installDataPager({ status: 'ready', rows, hasMore: false });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                    ownsScrollViewport
                />,
            );
            await flushMicrotasks();
        });

        const virtualizedLists = tree.root.findAllByType('FlatList');
        expect(virtualizedLists).toHaveLength(1);
        const virtualizedList = virtualizedLists[0]!;
        expect(virtualizedList.props.data).toHaveLength(200);
        expect(virtualizedList.props.keyExtractor(virtualizedList.props.data[37], 37)).toBe('virtual-task-37');
        expect(tree.root.findAllByType(HappierListItem)).toHaveLength(0);
        expect(pager.openCollectionQuery).toHaveBeenCalledTimes(1);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
    });

    it('renders a successful empty Data page as empty rather than retaining a local loading state', async () => {
        const pager = installDataPager({ status: 'ready', rows: [], hasMore: false });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });

        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:empty',
        })).toBeTruthy();
        expect(tree.root.findAllByProps({
            testID: 'plugin-declarative-collection-list:root:loading',
        })).toHaveLength(0);
        expect(pager.refresh).toHaveBeenCalledTimes(1);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
    });

    it('retains same-scope rows during a retryable pager error and retries through the pager', async () => {
        const rows = [{
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: 'task-1',
                revision: 3,
            },
            fields: { title: 'Keep this row', status: 'open' },
        }];
        const pager = installDataPager({ status: 'ready', rows, hasMore: true });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });

        await act(async () => {
            pager.publish({ status: 'loading', rows, hasMore: false });
            pager.publish({ status: 'error', rows, hasMore: false });
            await flushMicrotasks();
        });

        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:task-1',
        })).toBeTruthy();
        const retry = tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:retry',
        });
        await act(async () => {
            retry.props.onPress();
            await flushMicrotasks();
        });
        expect(pager.refresh).toHaveBeenCalledTimes(2);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
    });

    it('delegates continuation to the pager without exposing a cursor to presentation', async () => {
        const pager = installDataPager({
            status: 'ready',
            rows: [{
                context: {
                    collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                    rowId: 'first-page-task',
                    revision: 1,
                },
                fields: { title: 'First page', status: 'open' },
            }],
            hasMore: true,
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });

        const loadMore = tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:load-more',
        });
        await act(async () => {
            loadMore.props.onPress();
            await flushMicrotasks();
        });
        expect(pager.loadMore).toHaveBeenCalledTimes(1);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();

        await act(async () => {
            pager.publish({
                status: 'ready',
                rows: [{
                    context: {
                        collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                        rowId: 'second-page-task',
                        revision: 2,
                    },
                    fields: { title: 'Second page', status: 'open' },
                }],
                hasMore: false,
            });
            await flushMicrotasks();
        });
        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:second-page-task',
        })).toBeTruthy();
    });

    it('binds row commands only through the supplied fixed row context and shared overflow surface', async () => {
        const row = {
            context: {
                collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                rowId: 'task-commands',
                revision: 9,
            },
            fields: { title: 'Commanded task', status: 'open' },
        };
        const pager = installDataPager({ status: 'ready', rows: [row], hasMore: false });
        const inspect = vi.fn();
        const openDetails = vi.fn();
        const resolveRowCommands = vi.fn((context: unknown) => ({
            primary: {
                id: 'action:acme.tasks/inspect',
                label: 'Inspect task',
                disabled: false,
                onPress: inspect,
            },
            secondary: [{
                id: 'destination:acme.tasks/task-details',
                label: 'Open task details',
                disabled: false,
                onPress: openDetails,
            }],
            context,
        }));
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountLifetime()}
                    dataClient={pager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                    resolveRowCommands={resolveRowCommands}
                />,
            );
            await flushMicrotasks();
        });

        expect(resolveRowCommands).toHaveBeenCalledWith(row.context, node);
        const primary = tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:task-commands',
        });
        await act(async () => {
            primary.props.onPress();
            await flushMicrotasks();
        });
        expect(inspect).toHaveBeenCalledTimes(1);

        const menu = tree.root.findByType(DropdownMenu);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'destination:acme.tasks/task-details', title: 'Open task details' }),
        ]));
        await act(async () => {
            menu.props.onSelect('destination:acme.tasks/task-details');
            await flushMicrotasks();
        });
        expect(openDetails).toHaveBeenCalledTimes(1);
        expect(pager.loadMore).not.toHaveBeenCalled();
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
    });

    it('does not let a disposed Account-A pager publish into its replacement', async () => {
        const accountA = accountLifetime();
        const accountB = accountLifetime();
        const accountAPager = installDataPager({ status: 'loading', rows: [], hasMore: false });
        const accountBPager = installDataPager({
            status: 'ready',
            rows: [{
                context: {
                    collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                    rowId: 'task-b',
                    revision: 1,
                },
                fields: { title: 'Account B task', status: 'open' },
            }],
            hasMore: false,
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountA}
                    dataClient={accountAPager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });

        await act(async () => {
            tree.update(
                <CollectionListWithData
                    pluginId="acme.tasks"
                    node={node}
                    accountLifetime={accountB}
                    dataClient={accountBPager.dataClient}
                    presentationTheme={presentationTheme}
                    minimumTouchTarget={44}
                />,
            );
            await flushMicrotasks();
        });
        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:task-b',
        })).toBeTruthy();

        await act(async () => {
            accountAPager.publish({
                status: 'ready',
                rows: [{
                    context: {
                        collection: { pluginId: 'acme.tasks', collectionId: 'tasks' },
                        rowId: 'task-a',
                        revision: 1,
                    },
                    fields: { title: 'Account A task', status: 'open' },
                }],
                hasMore: false,
            });
            await flushMicrotasks();
        });

        expect(tree.root.findByProps({
            testID: 'plugin-declarative-collection-list:root:row:task-b',
        })).toBeTruthy();
        expect(tree.root.findAllByProps({
            testID: 'plugin-declarative-collection-list:root:row:task-a',
        })).toHaveLength(0);
        expect(accountAPager.dispose).toHaveBeenCalledTimes(1);
        expect(accountBPager.refresh).toHaveBeenCalledTimes(1);
        expect(createActivePluginCollectionUiQueryPager).not.toHaveBeenCalled();
    });
});
