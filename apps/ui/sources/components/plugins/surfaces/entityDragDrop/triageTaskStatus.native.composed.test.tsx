// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { DragSourceProps, DropTargetProps } from '@happier-dev/plugin-ui';
import type { EntityDropOutcomeV1, PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PluginDragSourceContributionV1Schema, PluginDropTargetContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/entityDragDrop';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { TriageSourceDescriptorV1Schema, TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/triage-protocol/v1';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { storage as accountStorage } from '@/sync/domains/state/storageStore';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { renderCoreDestinationRow } from '@/components/appShell/workspace/usePluginDestinationRowRenderer';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { createPluginUiClientExecutableRegistrationIndex, resolvePluginUiClientDragSourceRegistration, resolvePluginUiClientDropTargetRegistration } from '../../reactNative/clientExecutableContributions';
import { createPluginEntityDragDropBinding, settlePluginEntityDropActionResult } from './pluginEntityDragDropBinding';
import { PluginEntityDragSourceView, PluginEntityDropTargetView } from './PluginEntityDragDropView';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../../../../../../../packages/plugins/triage/src/manifest';
import { activate, TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1 } from '../../../../../../../packages/plugins/triage/src/ui/list/entryDragDrop';
import { createTestkitCorpusCollections } from '../../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support';
import { createTestkitAccountKv } from '../../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support';
import { createTriageEphemeralSharedScopeFixture } from '../../../../../../../packages/plugins/triage/src/ui/window/ephemeralSharedScope.test-support';
import { TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../../../../../../../packages/plugins/triage/src/actions/tasksProtocol';
import type { PluginUiProviderInternalProps } from '../../../../../../../packages/plugin-ui/src/components/PluginUiProvider';
import { PluginUiPresentationHostProviderInternal, useOptionalPluginUiPresentationHost } from '../../../../../../../packages/plugin-ui/src/presentationHost/context';

// Native presentation and cross-process persistence are the substituted system boundaries.
vi.mock('react-native', async () => { const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web'); return { ...actual, Platform: { ...actual.Platform, OS: 'web' } }; });
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

it('carries the actual Tasks Board card entity through native DOM drag and releases one transition, preserving cancellation and secondary controls', async () => {
    const scope = { serverId: 'home', accountId: 'account' };
    const rows = new Map<string, { value: unknown; version: number }>();
    const taskIds = ['a', 'b'];
    const reset = () => {
        rows.set('todo.index', { value: { undoneOrder: taskIds, completedOrder: [] }, version: 1 });
        rows.set('todo.a', { value: { id: 'a', title: 'Finish the task', done: false, state: 'unstarted', createdAt: 1, updatedAt: 1 }, version: 1 });
        rows.set('todo.b', { value: { id: 'b', title: 'Work in progress', done: false, state: 'started', createdAt: 2, updatedAt: 2 }, version: 1 });

    };
    reset();
    // Account persistence and cross-process Action transport are the only substituted boundaries.
    const port: AccountJsonKvCollectionPort = {
        read: async key => rows.get(key) ?? { value: null, version: -1 },
        list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, row]) => ({ key, ...row })),
        mutate: async mutations => {
            const errors = mutations.filter(row => (rows.get(row.key)?.version ?? -1) !== row.version)
                .map(row => ({ key: row.key, ...(rows.get(row.key) ?? { value: null, version: -1 }) }));
            if (errors.length) return { success: false, errors };
            return { success: true, results: mutations.map(row => {
                const version = row.version + 1; rows.set(row.key, { value: row.value, version }); return { key: row.key, version };
            }) };
        },
    };
    const hostWrites: string[] = [];
    const actions = { execute: async (actionId: string, input: unknown) => {
        if (actionId !== 'tasks.internal.list' && actionId !== 'tasks.internal.read' && actionId !== 'tasks.internal.transition') throw new Error(`Unexpected Action ${actionId}`);
        if (actionId === 'tasks.internal.transition') hostWrites.push(actionId);
        return executeInternalTaskAction({ actionId, input, scope, port, requireCurrent: () => {}, createId: () => { throw new Error('No create expected'); } });
    } } as unknown as PluginServices['actions'];
    const corpus = createTestkitCorpusCollections();
    const storage = { account: { kv: createTestkitAccountKv().kv, collection: (definition: { id: string }) => {
        if (definition.id === 'source-instances') return corpus.collections.sourceInstances;
        if (definition.id === 'session-links') return corpus.collections.sessionLinks;
        if (definition.id === 'user-marks') return corpus.collections.userMarks;
        throw new Error(`Unexpected Collection ${definition.id}`);
    } } } as unknown as PluginServices['storage'];
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN,
        services: { actions, storage }, resolveCurrentPluginMaterializationRef: () => null });
    const readContributions = async () => {
            const snapshot = kit.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
            return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry,
                descriptor: TriageSourceDescriptorV1Schema.parse(PLUGIN_MANIFEST.contributes.targetedPluginContributions
                    .find(candidate => candidate.id === entry.contributor.contributionId)?.descriptor), surfaces: {},
            })) };
    };
    const invocation = (surface: 'ui' | 'agent') => ({ surface, services: {
        targetedContributions: { observeForSelf: () => ({ readCurrent: readContributions, dispose() {} }) } as unknown as PluginServices['targetedContributions'],
    } });
    const registrations = createPluginUiClientExecutableRegistrationIndex();
    const activation = registrations.createScope({ pluginId: PLUGIN_MANIFEST.id, pluginVersion: PLUGIN_MANIFEST.version,
        contributes: PLUGIN_MANIFEST.contributes, target: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate', platform: 'web' },
        executionOrigin: null, occurrenceId: 'triage-status', lifecycle: { signal: new AbortController().signal, isCurrent: () => true } });
    activate(activation.api); activation.commit();
    const sourceDefinition = PluginDragSourceContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.dragSources.find(value => value.id === 'entry-reference'));
    const definitions = new Map(PLUGIN_MANIFEST.contributes.dropTargets.map(value => { const definition = PluginDropTargetContributionV1Schema.parse(value); return [definition.id, definition] as const; }));
    const domainWrites: unknown[] = [];
    const runtime = useEntityDragDropRuntime();
    const binding = createPluginEntityDragDropBinding({ runtime, pluginId: PLUGIN_MANIFEST.id, mountKey: 'status', scope, isCurrent: activation.isCurrent,
        readSource: () => {
            const registration = resolvePluginUiClientDragSourceRegistration({ source: { id: `${PLUGIN_MANIFEST.id}/${sourceDefinition.id}`, pluginId: PLUGIN_MANIFEST.id,
                pluginVersion: PLUGIN_MANIFEST.version, occurrenceId: 'triage-status', definition: sourceDefinition }, platform: 'web', reader: registrations });
            return registration ? { descriptor: sourceDefinition, describe: registration.runtime.describe, isCurrent: registration.registration.lifecycle.isCurrent } : null;
        },
        readTarget: id => {
            const definition = definitions.get(id);
            if (!definition) return null;
            const registration = resolvePluginUiClientDropTargetRegistration({ target: { id: `${PLUGIN_MANIFEST.id}/${definition.id}`, pluginId: PLUGIN_MANIFEST.id,
                pluginVersion: PLUGIN_MANIFEST.version, occurrenceId: 'triage-status', definition }, platform: 'web', reader: registrations });
            return registration ? { descriptor: definition, resolve: registration.runtime.resolve, settle: registration.runtime.settle,
                isCurrent: registration.registration.lifecycle.isCurrent } : null;
        },
        executeAction: async (action, input, settle) => {
            domainWrites.push(action);
            expect(action).toEqual({ pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 });
            return settlePluginEntityDropActionResult(await kit.invokeAction(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, input, invocation('ui')), action, settle);
        },
    });
    // The host admits/activates the manifest before loading an author UI Artifact.
    const { renderSurface } = await import('@happier-dev/plugins-triage/happier-plugin-ui/triage-list-page-native');
    const previousScope = accountStorage.getState().profileScope;
    accountStorage.setState({ profileScope: scope });
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    const snapshot = await readContributions();
    let workspaceState = createWorkspaceState({ id: 'tasks', target: { kind: 'session', params: { id: 'a' } }, pinned: false, preview: false });
    let nextTab = 0;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => workspaceState, getCatalog: () => [],
        dispatch: action => { workspaceState = reduceWorkspaceState(workspaceState, action); },
        transport: { commit() {} }, createId: () => `task-tab:${++nextTab}`, onChange() {},
    });
    const workspace: WorkspaceNavigationContextValue = {
        active: true, get state() { return workspaceState; }, canGoBack: false, canGoForward: false,
        openHref: navigation.openHref, activateTab: navigation.activateTab, closeTab: navigation.closeTab, closeTabs: navigation.closeTabs,
        dispatch: navigation.dispatch, findOpenHref: navigation.findOpenHref,
        navigationForTab: () => { throw new Error('No instance navigation expected'); }, registerBackStep: () => () => {},
        back: () => navigation.step(-1), forward: () => navigation.step(1),
    };
    function NativeSlots({ children }: React.PropsWithChildren) {
        const inherited = useOptionalPluginUiPresentationHost();
        const host = React.useMemo(() => ({ ...inherited,
            renderDragSource: (props: DragSourceProps) => <PluginEntityDragSourceView {...props} binding={binding} />,
            renderDropTarget: (props: DropTargetProps) => <PluginEntityDropTargetView {...props} binding={binding} />,
            // This fixture supplies the already admitted App destination at the genuine host route boundary.
            renderDestinationRow: (input: Parameters<typeof renderCoreDestinationRow>[0]) => {
                const href = 'href' in input ? input.href : typeof input.destination === 'string' ? null
                    : buildPluginAppPageRoutePath({ ...input.destination, subPath: input.subPath });
                return renderCoreDestinationRow({ ...input, href });
            },
        }), [inherited]);
        return <PluginUiPresentationHostProviderInternal host={host}>{children}</PluginUiPresentationHostProviderInternal>;
    }
    let page: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    let stopObserving: (() => void) | undefined;
    const nativeEvent = (kind: string, x = 20, y = 20) => {
        const event = new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y });
        Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, setDragImage() {}, effectAllowed: '', dropEffect: '' } });
        return event;
    };
    try {
        await act(async () => {
            page = await createPluginUiTestkit({ identity: { instanceId: 'native-task-board', mountNonce: 'native-task-board' },
                authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, subPath: 'tasks,everyone',
                surface: context => {
                    const entry = renderSurface(context);
                    expect(Reflect.get(entry.type, Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'))).toBe(true);
                    return <WorkspaceNavigationProvider value={workspace}><NativeSlots>{React.cloneElement(entry as React.ReactElement<PluginUiProviderInternalProps>, { ephemeralSharedScope })}</NativeSlots></WorkspaceNavigationProvider>;
                },
                surfaceContext: createSurfaceContextFixture({ targetedContributions: {
                    target: { pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'triage-generation', sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
                    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol: {
                        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
                    }, contributions: snapshot.contributions.map(source => ({ contributor: source.contributor, protocol: source.protocol,
                        descriptor: source.descriptor, operations: [], surfaces: [] })) }] }],
                } }),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, sessions: true, overlays: true }),
                handlers: { publishCurrentUiContext: () => undefined, replacePageLocation: ({ subPath }) => subPath,
                    executeAction: ({ action, input }) => kit.invokeAction(action, input, invocation('ui')) },
            });
        });
        await vi.waitFor(() => expect(document.body.textContent).toContain('Finish the task'));
        const stage = document.querySelector('[data-testid="triage-shell-fill:stage"]')!;
        const layout: unknown = Reflect.get(stage, '__reactLayoutHandler');
        if (typeof layout !== 'function') throw new Error('Missing native Collection layout boundary');
        await act(async () => layout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 1000 } } }));
        await act(async () => page!.press(await page!.getByRole('radio', { name: 'Board' })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="triage-shell-fill:column:started"]')).not.toBeNull());
        const row = [...document.querySelectorAll<HTMLElement>('[data-testid^="triage-entry-row:"]')]
            .find(element => !element.dataset.testid?.endsWith(':peek') && element.textContent?.includes('Finish the task'))!;
        expect(row).toBeTruthy();
        const entitySource = row.closest<HTMLElement>('[data-testid^="triage-entry-drag:"]');
        expect(entitySource?.getAttribute('draggable')).toBe('true');
        expect(row.closest('[draggable="true"]')).not.toBeNull();
        const target = document.querySelector<HTMLElement>('[data-testid="triage-shell-fill:column:started"]')!;
        const drop = target.firstElementChild as HTMLElement;
        // DOM geometry is the platform boundary. All target choice and admission are real.
        vi.spyOn(drop, 'getBoundingClientRect').mockReturnValue(new DOMRect(500, 0, 250, 800));
        const start = async () => { await act(async () => row.dispatchEvent(nativeEvent('dragstart'))); };
        await start();
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', item: { kind: 'plugin', contribution: { pluginId: PLUGIN_MANIFEST.id, localId: 'entry-reference' } } });
        await act(async () => row.dispatchEvent(nativeEvent('dragend')));
        expect(domainWrites).toEqual([]); expect(hostWrites).toEqual([]);
        const secondary = entitySource?.querySelector<HTMLElement>('[aria-label^="More actions"]');
        expect(secondary).not.toBeNull();
        const secondaryDrag = nativeEvent('dragstart');
        await act(async () => secondary!.dispatchEvent(secondaryDrag));
        expect(secondaryDrag.defaultPrevented).toBe(true);
        expect(runtime.getSnapshot().phase).not.toBe('carrying');
        expect(domainWrites).toEqual([]);
        const selection = window.getSelection()!;
        const selectedText = vi.spyOn(selection, 'toString').mockReturnValue('selected task text');
        const rejectedDrag = nativeEvent('dragstart');
        await act(async () => row.dispatchEvent(rejectedDrag));
        expect(rejectedDrag.defaultPrevented).toBe(true);
        expect(runtime.getSnapshot().phase).not.toBe('carrying');
        expect(domainWrites).toEqual([]); expect(hostWrites).toEqual([]);
        selectedText.mockRestore();
        const outcomes: EntityDropOutcomeV1[] = [];
        stopObserving = runtime.subscribe(() => {
            const outcome = runtime.getSnapshot().outcome;
            if (outcome) outcomes.push(outcome);
        });
        await start();
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', item: { kind: 'plugin' } });
        expect(drop.isConnected).toBe(true);
        await act(async () => { drop.dispatchEvent(nativeEvent('dragover', 600, 500)); });
        await vi.waitFor(() => expect(runtime.getSnapshot()).toMatchObject({ admission: { status: 'allowed', effect: {
            actionId: `plugin:${PLUGIN_MANIFEST.id}/${TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1}`,
        } } }));
        await act(async () => { drop.dispatchEvent(nativeEvent('drop', 600, 500)); });
        // Moving groups retires the old row after settlement; observe that settlement as it occurs.
        await vi.waitFor(() => expect(outcomes).toContainEqual({ status: 'applied' }));
        expect(domainWrites).toEqual([{ pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 }]);
        expect(hostWrites).toEqual(['tasks.internal.transition']);
        expect(rows.get('todo.a')?.value).toMatchObject({ state: 'started' });
    } finally {
        stopObserving?.();
        await act(async () => { await page?.dispose(); runtime.cancel(); accountStorage.setState({ profileScope: previousScope }); });
        binding.dispose(); await activation.unwind(); await kit.dispose(); vi.restoreAllMocks();
    }
});
