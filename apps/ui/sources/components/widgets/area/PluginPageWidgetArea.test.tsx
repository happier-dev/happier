import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, StrictJsonValueSchema, type PluginJsonSchemaV2 } from '@happier-dev/protocol';
import { createPluginWidgetAreaHostPortV1, PluginUiWidgetAreaRequestV1Schema, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import {
    createWidgetActionInputResolverV1, createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1,
    buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, WIDGET_SURFACE_ARTIFACT_KIND_V1,
    type WidgetAreaLayoutV1, type WidgetInstanceV1, type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import { createPluginUiResourceStore, PluginHostApiProvider, PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { ScrollArea, WidgetSurface } from '@happier-dev/plugin-ui';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WidgetSetupStep } from '@/components/widgets/add/WidgetSetupStep';
import type { WidgetSetup, WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';

import { DeclarativePluginSurface } from '@/components/plugins/surfaces/DeclarativePluginSurface';
import { createDeclarativeWidgetAreaRender } from '@/components/plugins/surfaces/declarativeWidgetArea';
import { PluginDeclarativeProjectedModelV1Schema } from '@happier-dev/protocol';

import { PluginPageWidgetArea } from './PluginPageWidgetArea';
import { ProjectAsideWidgets, ProjectWidgetArea } from './ProjectWidgetArea';
import { SessionSurfaceEntityDragHandle } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { storage } from '@/sync/domains/state/storage';
import { projectWidgetEntityMovementResult, readWidgetEntityMovementAdmission } from '@/sync/ops/actions/widgetEntityMovement';
import type { WidgetAreaPort } from './useWidgetAreaLayout';
import { createLayoutArtifactHttpBoundary, createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

installDisconnectedServerSocketBoundary();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The signed-in viewer is the area's Account: a widget never reads for another viewer.
const viewer = vi.hoisted(() => ({ serverId: 'home', accountId: 'viewer' }));
const widgetDemand = vi.hoisted(() => ({ active: new Set<string>(), reads: [] as string[], opens: 0, releases: 0 }));
vi.mock('@/sync/domains/state/storage', async importOriginal => (await import('@/dev/testkit/mocks/storage')).createPartialStorageModuleMock(importOriginal, {
    useActiveServerAccountScope: () => viewer,
}));
vi.mock('@react-navigation/native', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    useIsFocused: () => true,
}));
// The plugin surface host is the plugin runtime boundary: past it the widget runs its own code. This
// stand-in shows the input the host admitted for it, so a page/pin binding is observable.
vi.mock('@/components/plugins/surfaces', () => ({
    PluginInlineSurfaceHost: (props: { placement: { binding: { surface: { localId: string } } }; launchInput?: Readonly<Record<string, unknown>> }) => {
        const identity = String(props.launchInput?.repository);
        React.useEffect(() => {
            // Plugin execution is a system boundary. Its mounted consumer uses the real Resource
            // lifecycle; only the external read/watch transport is controlled by this fixture.
            const store = createPluginUiResourceStore({ pluginId: 'acme.ci', client: {
                readResource: async () => {
                    widgetDemand.reads.push(identity);
                    return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`, bytes: new TextEncoder().encode('{}') };
                },
                watchResource: async () => {
                    widgetDemand.active.add(identity); widgetDemand.opens++;
                    return { dispose: () => { widgetDemand.active.delete(identity); widgetDemand.releases++; } };
                },
            } });
            const unsubscribe = store.getEntry('checks').subscribe(() => {}, true);
            return () => { unsubscribe(); store.dispose(); };
        }, [identity]);
        return `widget:${props.placement.binding.surface.localId} repository:${identity};`;
    },
}));
// Popover positioning/portal and modal placement are platform overlay boundaries; their content renders.
vi.mock('@/components/ui/popover', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Popover: (props: { open: boolean; children: React.ReactNode | ((p: { maxHeight: number; maxWidth: number }) => React.ReactNode) }) => (
        props.open ? <>{typeof props.children === 'function' ? props.children({ maxHeight: 640, maxWidth: 800 }) : props.children}</> : null
    ),
}));
vi.mock('@/components/ui/overlays/FloatingOverlay', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    FloatingOverlay: (props: { children: React.ReactNode }) => <>{props.children}</>,
}));
vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

const scope = { serverId: 'home', accountId: 'viewer' };
const surface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'pluginArea', pluginId: 'acme.prs', pageId: 'overview', area: 'pinned' } };
const declarations = [{ name: 'pinned', contextSchema: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'], additionalProperties: false } satisfies PluginJsonSchemaV2 }];
const checks = { pluginId: 'acme.ci', localId: 'checks' };
const fields = [{ path: 'repository', title: 'Repository', widget: 'text' as const, required: true }];
const inputSchema = { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'], additionalProperties: false } satisfies PluginJsonSchemaV2;
const projection = widgetProjectionOf([{ ...checks, target: 'app', title: 'Checks', inputs: { fields }, inputSchema }], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
const follow: WidgetInstanceV1 = { v: 1, id: 'follow', definition: { kind: 'installed', surface: checks }, bindings: { repository: { kind: 'context', slot: 'repository' } } };
const pin: WidgetInstanceV1 = { v: 1, id: 'pin', definition: { kind: 'installed', surface: checks }, bindings: { repository: { kind: 'value', value: 'website' } } };

/**
 * Persistence (the Account Artifact transport) and the widget's own descriptor read are the external
 * boundaries; the area Action executor, the mounted area host port with its declared context schema,
 * the Artifact reducer/CAS, the public author component and the host presentation bridge are real.
 */
function createArea() {
    const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
    const transport = boundary.forAccount(scope.accountId);
    const store = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
    const widgetInputs = createWidgetActionInputResolverV1({
        readDescriptor: async () => ({ inputs: { fields }, inputSchema }),
        readContext: async request => request.context.widgetAreaContext?.values ?? {}, readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area }, widgetInputs }));
    const hostPort = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'acme.prs', pageId: 'overview', declarations, isCurrent: () => true,
        execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
    // The mounted Host API's area method: the same port the native and declarative bindings reach.
    // A narrow boundary fixture: only the method this surface calls exists.
    const hostApi = {
        widgetArea: (request: unknown, options?: { signal?: AbortSignal }) => hostPort.execute(request, options?.signal),
        readResource: async () => { throw new Error('the page reads no Resource here'); },
    } as unknown as PluginUiHostApi;
    return { store, hostApi };
}

const environment = projectHappierUiEnvironment({ theme: projectPluginUiTheme(resolveThemeProfile({ mode: 'light', profile: null })),
    locale: 'en', direction: 'ltr', translations: {}, textScale: 1, reducedMotion: false, screenReaderEnabled: false,
    contrast: 'normal', platform: 'web', colorScheme: 'light', safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } });
const presentationHost = createPluginUiPrivatePresentationHost({ displayName: 'PRs & Issues' }, {
    renderWidgetArea: input => <PluginPageWidgetArea {...input} surfaceName="PRs & Issues" />,
});

function page(hostApi: PluginUiHostApi, repository: unknown, content?: React.ReactNode) {
    return (
        <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
            interactionEnabled: true, machineId: 'machine-1', serverId: scope.serverId, platform: 'web',
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
            <PluginHostApiProvider hostApi={hostApi}>
                <PluginUiHostPresentationScope environment={environment} presentationHost={presentationHost}>
                    {content ?? <WidgetSurface area="pinned" context={{ repository: repository as string }} testID="prs.pinned" />}
                </PluginUiHostPresentationScope>
            </PluginHostApiProvider>
        </AppShellPluginUiProjectionValueProvider>
    );
}

function menuOf(screen: Awaited<ReturnType<typeof renderScreen>>, id: string) {
    return screen.findByTestId(`prs.pinned.widget.${id}.menu`)!.findByType(ItemRowActions);
}
async function runAction(screen: Awaited<ReturnType<typeof renderScreen>>, id: string, actionId: string) {
    const action = menuOf(screen, id).props.actions.find((entry: { id: string }) => entry.id === actionId);
    const onPress = action?.onPress;
    if (!onPress) throw new Error(`Missing widget action handler: ${actionId}`);
    await act(async () => { onPress(); });
    await flushHookEffects({ cycles: 4 });
}

afterEach(() => { standardCleanup(); storage.setState({ artifacts: {} }); });

/**
 * Public Project-aside fixture: explicit portable identities and the already-injected upstream
 * Artifact/Action owner, not a Workspace pretending to be the production Project Source producer.
 */
function projectMovementFixture() {
    const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
    const accountTransport = boundary.forAccount(scope.accountId);
    const publish = async (id: string) => {
        const row = await accountTransport.read(id);
        if (row) storage.getState().updateArtifact({ id, title: null, headerVersion: row.revision.headerVersion,
            bodyVersion: row.revision.bodyVersion, seq: row.revision.bodyVersion, createdAt: 0, updatedAt: row.revision.bodyVersion,
            isDecrypted: true, access: 'owner', ownerAccountId: scope.accountId });
    };
    const transport = { ...accountTransport,
        create: async (input: Parameters<typeof accountTransport.create>[0]) => { const row = await accountTransport.create(input); await publish(input.artifactId); return row; },
        update: async (input: Parameters<typeof accountTransport.update>[0]) => { const result = await accountTransport.update(input); if (result.ok) await publish(input.artifactId); return result; },
    };
    const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
    const widgetInputs = createWidgetActionInputResolverV1({
        readDescriptor: async () => ({ inputs: { fields }, inputSchema }), readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    });
    const deps = createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope, widgetSurfaceActions: { project: area }, widgetInputs });
    const executor = createActionExecutor(deps);
    const context = { surface: 'ui' as const, bypassApprovals: true, serverId: scope.serverId, expectedAccountId: scope.accountId };
    const bind = (projectId: string) => {
        const ref: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'project', projectId } };
        const port: WidgetAreaPort = {
            execute: async (operation, signal) => {
                if (operation.actionId !== 'widgets.instance.list') throw new Error('fixture layout writes use its real Artifact owner');
                return PluginUiWidgetAreaResultV1Schema.parse(await executor.execute(operation.actionId, { surface: ref }, { ...context, signal }));
            },
            movement: {
                readAdmission: (source, destination, signal) => readWidgetEntityMovementAdmission(deps, source, destination, { ...context, signal }),
                execute: async effect => {
                    if (effect.actionId !== 'widgets.instance.move') throw new Error('fixture movement only admits the canonical widget move Action');
                    return projectWidgetEntityMovementResult(await executor.execute(effect.actionId, effect.input, context), effect);
                },
            },
        };
        return { surface: ref, port, store: createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }) };
    };
    return { first: bind('portable-project-a'), second: bind('portable-project-b') };
}

describe('a plugin page widget area', () => {
    it.each(['approvalPending', 'refused'] as const)('keeps the real area %s acknowledgement truthful through add and input editing', async kind => {
        const area = createArea();
        await area.store.apply({ kind: 'add', instance: pin });
        // The mounted plugin Host API is the transport boundary; the area write/read owner and setup adapters remain real.
        const hostApi: PluginUiHostApi = { ...area.hostApi, widgetArea: async (raw, options) => {
            const request = PluginUiWidgetAreaRequestV1Schema.parse(raw);
            const actionId = request.operation.actionId;
            if (actionId === 'widgets.instance.add' || actionId === 'widgets.instance.inputs.set') {
                return PluginUiWidgetAreaResultV1Schema.parse(kind === 'approvalPending'
                    ? { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-area', actionId } }
                    : { ok: false, errorCode: 'permission_denied', error: 'permission_denied' });
            }
            return area.hostApi.widgetArea(raw, options);
        } };
        const screen = await renderScreen(page(hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        await act(async () => { screen.pressByTestId('prs.pinned.add'); });
        await flushHookEffects({ cycles: 3 });
        await act(async () => { screen.pressByTestId('prs.pinned.addPopover.entry.plugin-acme.ci/checks'); });
        await flushHookEffects({ cycles: 4 });
        expect(screen.getTextContent()).not.toContain('widgetAdd.justAdded');
        expect(screen.getTextContent()).toContain(kind === 'approvalPending' ? 'widgetAdd.areaApprovalPending' : 'widgetAdd.addFailed');
        expect((await area.store.read()).instances.map(entry => entry.instance)).toEqual([pin]);
        await runAction(screen, 'pin', 'editInputs');
        const setup: WidgetSetup = screen.root.findByType(WidgetSetupStep).props.setup;
        let result: WidgetSetupSubmitResult | undefined;
        await act(async () => { result = await setup.submit({ bindings: { repository: { kind: 'value', value: 'edited' } } }); });
        expect(result).toEqual(kind === 'approvalPending' ? { ok: true, approvalPending: true } : { ok: false, message: 'widgetAdd.saveFailed' });
        expect((await area.store.read()).instances.map(entry => entry.instance)).toEqual([pin]);
    });
    it.each(['plugin', 'declarative', 'project'] as const)('releases offscreen %s widget demand, retains geometry and resumes on scroll reentry', async kind => {
        widgetDemand.active.clear(); widgetDemand.reads = []; widgetDemand.opens = 0; widgetDemand.releases = 0;
        const plugin = createArea();
        const project = projectMovementFixture().first;
        const store = kind === 'project' ? project.store : plugin.store;
        await store.apply({ kind: 'add', instance: follow });
        await store.apply({ kind: 'add', instance: pin });
        let scrollY = 0;
        const contentNode = { getBoundingClientRect: () => ({ left: 0, top: -scrollY, width: 800, height: 6000 }) };
        const areaId = kind === 'plugin' ? 'prs.pinned' : kind === 'project' ? 'project-scroll' : 'plugin-declarative-widget-area:root.children[0]';
        const model = PluginDeclarativeProjectedModelV1Schema.parse({
            identity: { pluginId: 'acme.prs', localId: 'overview', qualifiedId: 'acme.prs/overview', occurrenceId: 'prs-1' }, visible: true, requiredHostMethods: [],
            declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [], dragSources: [], dropTargets: [] },
            root: { kind: 'stack', path: 'root', order: 0, children: [
                { kind: 'widgetArea', path: 'root.children[0]', order: 1, area: 'pinned', context: { repository: 'happier' } },
            ] },
        });
        const scroller = kind === 'plugin'
            ? <ScrollArea testID="area-scroll"><WidgetSurface area="pinned" context={{ repository: 'happier' }} testID={areaId} /></ScrollArea>
            : kind === 'declarative' ? <DeclarativePluginSurface pluginId="acme.prs" model={model} environment={environment} interactionEnabled daemonInteractionEnabled
                dispatchAction={async () => null} actionAvailable={false} openSurface={async () => null} openSurfaceAvailable={false} authorityGeneration={1}
                renderWidgetArea={createDeclarativeWidgetAreaRender({ dispatch: async (request, options) => StrictJsonValueSchema.parse(await plugin.hostApi.widgetArea(request as never, options)), surfaceName: 'PRs & Issues' })} />
            : <ItemList testID="area-scroll"><ProjectWidgetArea projectName="Project" port={project.port}
                context={{ slots: { repository: { label: 'Repository', value: { value: 'happier', label: 'happier' } } } }} testID={areaId} /></ItemList>;
        const screen = await renderScreen(page(plugin.hostApi, 'happier', scroller), { createNodeMock: element => {
            const props = element.props;
            const id = props && typeof props === 'object' && 'testID' in props ? props.testID : undefined;
            if (id === 'area-scroll' || element.type === 'ScrollView') return { getInnerViewNode: () => contentNode };
            if (id === `${areaId}.widget.follow` || id === `${areaId}.widget.pin`) {
                const top = id.endsWith('.pin') ? 4000 : 200;
                return { getBoundingClientRect: () => ({ left: 0, top: top - scrollY, width: 400, height: 260 }) };
            }
            return null;
        } });
        const scroll = kind === 'declarative' ? screen.root.findByType('ScrollView') : screen.findHostByTestId('area-scroll')!;
        await act(async () => { scroll.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 600 } } }); });
        await flushHookEffects({ cycles: 4 });
        expect(widgetDemand.active).toEqual(new Set(['happier']));
        expect(widgetDemand.opens).toBe(1);
        expect(new Set(widgetDemand.reads)).toEqual(new Set(['happier']));
        const firstReads = widgetDemand.reads.length;
        await act(async () => { screen.findHostByTestId(`${areaId}.widget.follow.bodyHeight`)!.props.onLayout({ nativeEvent: { layout: { height: 220 } } }); });
        await act(async () => {
            scrollY = 4000;
            scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: scrollY } } });
        });
        await flushHookEffects({ cycles: 4 });
        expect(widgetDemand.active).toEqual(new Set(['website']));
        expect(widgetDemand.releases).toBe(1);
        expect(new Set(widgetDemand.reads.slice(firstReads))).toEqual(new Set(['website']));
        const secondReads = widgetDemand.reads.length;
        expect(screen.findHostByTestId(`${areaId}.widget.follow.deferred`)!.props.style).toEqual({ minHeight: 220 });
        await act(async () => {
            scrollY = 0;
            scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: scrollY } } });
        });
        await flushHookEffects({ cycles: 4 });
        expect(widgetDemand.active).toEqual(new Set(['happier']));
        expect(widgetDemand.opens).toBe(3);
        expect(new Set(widgetDemand.reads.slice(secondReads))).toEqual(new Set(['happier']));
        expect(widgetDemand.releases).toBe(2);
    });
    it('moves a context-following widget between declared page areas through default admission and release with the current admitted page context', async () => {
        await import('@/sync/syncEngine');
        const previous = storage.getState();
        const fallback = createHomeHubArtifactHttpBoundary('viewer');
        const areas = new Map<string, ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>>>();
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://page-widget-movement.test', accountId: 'viewer', request: (input, init) => {
            const path = new URL(String(input)).pathname;
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            const id = path === '/v1/artifacts' && body && typeof body === 'object' ? Reflect.get(body, 'id') : path.split('/').at(-1);
            return (typeof id === 'string' ? areas.get(id) : undefined)?.request(input, init) ?? fallback.request(input, init);
        } });
        const restoreLoader = await installRealActionExecutorModuleLoader();
        viewer.serverId = connection.home.id;
        try {
            const currentScope = { ...viewer };
            const bind = (name: string, instances: WidgetAreaLayoutV1['instances']) => {
                const ref: WidgetSurfaceRefV1 = { ...currentScope, owner: { kind: 'pluginArea', pluginId: 'acme.prs', pageId: 'overview', area: name } };
                const http = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(ref),
                    kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: { v: 1, surface: ref, instances: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value) });
                http.seed({ v: 1, surface: ref, instances });
                areas.set(http.artifactId, http);
                return http;
            };
            const first = bind('pinned', [{ instance: follow }]);
            const second = bind('secondary', []);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            const hostPort = createPluginWidgetAreaHostPortV1({ scope: currentScope, pluginId: 'acme.prs', pageId: 'overview',
                declarations: [declarations[0]!, { ...declarations[0]!, name: 'secondary' }], isCurrent: () => true,
                execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', expectedAccountId: 'viewer', bypassApprovals: true }) });
            const hostApi = {
                widgetArea: (request: unknown, options?: { signal?: AbortSignal }) => hostPort.execute(request, options?.signal),
                readResource: async () => { throw new Error('the page reads no Resource here'); },
            } as unknown as PluginUiHostApi;
            const pagePresentation = createPluginUiPrivatePresentationHost({ displayName: 'PRs & Issues' }, {
                renderWidgetArea: input => <PluginPageWidgetArea {...input} surfaceName={input.title ?? 'PRs & Issues'} />,
            });
            const pages = (repository: string | number) => (
                <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
                    interactionEnabled: true, machineId: 'machine-1', serverId: currentScope.serverId, platform: 'web',
                    clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}>
                    <PluginHostApiProvider hostApi={hostApi}><PluginUiHostPresentationScope environment={environment} presentationHost={pagePresentation}>
                        <WidgetSurface area="pinned" context={{ repository: 'happier' }} testID="page-a" title="Page A" />
                        <WidgetSurface area="secondary" context={{ repository }} testID="page-b" title="Page B" />
                    </PluginUiHostPresentationScope></PluginHostApiProvider>
                </AppShellPluginUiProjectionValueProvider>
            );
            const screen = await renderScreen(pages('website'));
            await flushHookEffects({ cycles: 4 });
            const drag = screen.root.findByType(SessionSurfaceEntityDragHandle).props.drag;
            let carry: ReturnType<typeof drag.runtime.begin>;
            await act(async () => { carry = drag.runtime.begin(drag.sourceId, 'keyboard'); });
            await flushHookEffects({ cycles: 4 });
            const destination = () => drag.runtime.getDestinations(drag.sourceId).find((entry: { group?: string }) => entry.group === 'Page B');
            expect(destination()?.admission, JSON.stringify(destination()?.admission)).toMatchObject({ status: 'allowed' });
            await act(async () => { carry?.choose(destination()!.targetId, destination()!.destination); screen.update(pages(42)); });
            await flushHookEffects({ cycles: 4 });
            expect(screen.findByTestId('page-b.unavailable')).not.toBeNull();
            await act(async () => { expect((await carry?.release())?.status).not.toBe('applied'); });
            expect(first.layout().instances.map(entry => entry.instance)).toEqual([follow]);
            expect(second.layout().instances).toEqual([]);
            await act(async () => { screen.update(pages('website')); });
            await flushHookEffects({ cycles: 4 });
            await act(async () => { carry = drag.runtime.begin(drag.sourceId, 'keyboard'); });
            await flushHookEffects({ cycles: 4 });
            expect(destination()?.admission).toMatchObject({ status: 'allowed' });
            await act(async () => { carry?.choose(destination()!.targetId, destination()!.destination); screen.update(pages('current-repository')); });
            await flushHookEffects({ cycles: 4 });
            expect(destination()?.admission).toMatchObject({ status: 'allowed' });
            await act(async () => { expect((await carry?.release())?.status).toBe('applied'); });
            await flushHookEffects({ cycles: 4 });
            expect(first.layout().instances).toEqual([]);
            expect(second.layout().instances.map(entry => entry.instance)).toEqual([follow]);
            expect(screen.getTextContent()).toContain('widget:checks repository:current-repository;');
        } finally {
            standardCleanup(); restoreLoader(); await connection.dispose(); viewer.serverId = scope.serverId; storage.setState(previous, true);
        }
    });
    it('revalidates the Project-aside anchor against publication during a carry and cancellation never writes', async () => {
        const fixture = projectMovementFixture();
        const tail = { ...pin, id: 'tail' };
        for (const instance of [pin, follow, tail]) await fixture.first.store.apply({ kind: 'add', instance });
        const screen = await renderScreen(<ProjectWidgetArea projectName="Project A" port={fixture.first.port} context={{ slots: {} }} testID="project-a" />);
        await flushHookEffects({ cycles: 4 });
        const drag = screen.root.findAllByType(SessionSurfaceEntityDragHandle)[0]!.props.drag;
        let carry: ReturnType<typeof drag.runtime.begin>;
        await act(async () => { carry = drag.runtime.begin(drag.sourceId, 'keyboard'); });
        await flushHookEffects({ cycles: 4 });
        const destination = drag.runtime.getDestinations(drag.sourceId).find(entry => {
            const value = entry.destination;
            return value !== null && typeof value === 'object' && 'anchorId' in value && 'placement' in value
                && value.anchorId === follow.id && value.placement === 'after';
        });
        expect(destination?.admission).toMatchObject({ status: 'allowed' });
        await act(async () => {
            carry?.choose(destination!.targetId, destination!.destination);
            await fixture.first.store.apply({ kind: 'move', instanceId: follow.id, toIndex: 2 });
        });
        await flushHookEffects({ cycles: 4 });
        await act(async () => { expect((await carry?.release())?.status).toBe('applied'); });
        await flushHookEffects({ cycles: 4 });
        expect((await fixture.first.store.read()).instances.map(entry => entry.instance.id)).toEqual(['tail', 'follow', 'pin']);
        const mounted = screen.root.findAllByType(SessionSurfaceEntityDragHandle)[0]!.props.drag;
        await act(async () => {
            const cancelled = mounted.runtime.begin(mounted.sourceId, 'keyboard');
            cancelled?.choose(destination!.targetId, destination!.destination);
            cancelled?.cancel();
            await cancelled?.release();
        });
        expect((await fixture.first.store.read()).instances.map(entry => entry.instance.id)).toEqual(['tail', 'follow', 'pin']);
    });
    it('moves a public Project-aside copy through chooser admission and the upstream owner, refreshing both mounted areas', async () => {
        const fixture = projectMovementFixture();
        await fixture.first.store.apply({ kind: 'add', instance: pin });
        const screen = await renderScreen(<>
            <ProjectWidgetArea projectName="Project A" port={fixture.first.port} context={{ slots: {} }} testID="project-a" />
            <ProjectWidgetArea projectName="Project B" port={fixture.second.port} context={{ slots: {} }} testID="project-b" />
        </>);
        await flushHookEffects({ cycles: 4 });
        const drag = screen.root.findByType(SessionSurfaceEntityDragHandle).props.drag;
        await act(async () => {
            const menu = screen.findByTestId('project-a.widget.pin.menu')!.findByType(ItemRowActions);
            const onPress = menu.props.actions.find((entry: { id: string }) => entry.id === 'moveTo')?.onPress;
            if (!onPress) throw new Error('Missing widget move chooser handler');
            onPress();
            // The real overlay waits for menu teardown before beginning its chooser carry.
            await vi.waitFor(() => expect(drag.runtime.getSnapshot().phase).toBe('carrying'));
        });
        await flushHookEffects({ cycles: 4 });
        const destinations = drag.runtime.getDestinations(drag.sourceId);
        const index = destinations.findIndex((entry: { group?: string }) => entry.group === 'Project B');
        const destination = destinations[index];
        expect(destination?.admission).toMatchObject({ status: 'allowed' });
        await act(async () => {
            const chooser = screen.root.findByType(SessionSurfaceEntityDragHandle).findByType(DropdownMenu);
            const onSelect = chooser.props.onSelect;
            if (!onSelect) throw new Error('Missing widget destination selection handler');
            await onSelect(String(index));
        });
        await flushHookEffects({ cycles: 4 });
        expect((await fixture.first.store.read()).instances).toEqual([]);
        expect((await fixture.second.store.read()).instances.map(entry => entry.instance)).toEqual([pin]);
        expect(drag.runtime.getSnapshot().phase).toBe('idle');
        expect(screen.findByTestId('project-a.widget.pin')).toBeNull();
        expect(screen.findByTestId('project-b.widget.pin')).not.toBeNull();
        const destinationDrag = screen.root.findByType(SessionSurfaceEntityDragHandle).props.drag;
        await act(async () => { destinationDrag.runtime.begin(destinationDrag.sourceId, 'keyboard'); });
        standardCleanup();
        expect(destinationDrag.runtime.getSnapshot().phase).toBe('idle');
        expect((await fixture.second.store.read()).instances.map(entry => entry.instance)).toEqual([pin]);
    });
    it('mounts a qualified shared carry and retires it when the public page area unmounts', async () => {
        const area = createArea();
        await area.store.apply({ kind: 'add', instance: pin });
        const screen = await renderScreen(page(area.hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        const handles = screen.root.findAllByType(SessionSurfaceEntityDragHandle);
        expect(handles).toHaveLength(1);
        const drag = handles[0]!.props.drag;
        await act(async () => { expect(drag.runtime.begin(drag.sourceId, 'keyboard')).not.toBeNull(); });
        expect(drag.runtime.getSnapshot().item).toEqual({ kind: 'widget-area-instance', scope, ref: { surface, instanceId: pin.id } });
        standardCleanup();
        expect(drag.runtime.getSnapshot().phase).toBe('idle');
        expect((await area.store.read()).instances.map(entry => entry.instance)).toEqual([pin]);
    });
    it('refuses a generic placement width that the canonical area layout cannot persist', async () => {
        const area = createArea();
        // The mounted Host API transport is the external boundary; its generic DTO can carry Board widths.
        const hostApi: PluginUiHostApi = { ...area.hostApi, widgetArea: async () => ({ ok: true, result: {
            surface, instances: [{ instance: follow, width: 'wide' }], canEdit: true,
        } }) };
        const screen = await renderScreen(page(hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('prs.pinned.unavailable')).not.toBeNull();
        expect(screen.findByTestId('prs.pinned.widget.follow')).toBeNull();
    });

    it('opens the shared About flow for a saved definition while keeping the placement removable', async () => {
        const area = createArea();
        await area.store.apply({ kind: 'add', instance: { v: 1, id: 'saved', definition: { kind: 'artifact', artifactId: 'saved-checks' }, bindings: {} } });
        const screen = await renderScreen(page(area.hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        expect(menuOf(screen, 'saved').props.actions.some((action: { id: string }) => action.id === 'about')).toBe(true);
        await runAction(screen, 'saved', 'about');
        expect(screen.findByTestId('prs.pinned.widget.saved.about')).not.toBeNull();
        expect(menuOf(screen, 'saved').props.actions.some((action: { id: string }) => action.id === 'remove')).toBe(true);
    });

    it('follows This page while a pinned sibling keeps its own value, and a page change re-reads only the follower', async () => {
        const area = createArea();
        await area.store.apply({ kind: 'add', instance: follow });
        await area.store.apply({ kind: 'add', instance: pin });
        const screen = await renderScreen(page(area.hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        expect(screen.getTextContent()).toContain('widget:checks repository:happier;');
        expect(screen.getTextContent()).toContain('widget:checks repository:website;');
        // Copies are named by their binding: the follower says it follows the page.
        expect(screen.findByTestId('prs.pinned.widget.follow')!.findAll(node => node.props.children === 'widgetAdd.thisPage').length).toBeGreaterThan(0);

        await act(async () => { await screen.update(page(area.hostApi, 'infra')); });
        await flushHookEffects({ cycles: 4 });
        expect(screen.getTextContent()).toContain('widget:checks repository:infra;');
        expect(screen.getTextContent()).toContain('widget:checks repository:website;');
        expect(screen.getTextContent()).not.toContain('repository:happier;');
        expect((await area.store.read()).instances.map(entry => entry.instance)).toEqual([follow, pin]);
    });

    it('persists width and order through the area owner, and a fresh mount draws the saved layout', async () => {
        const area = createArea();
        await area.store.apply({ kind: 'add', instance: follow });
        await area.store.apply({ kind: 'add', instance: pin });
        const screen = await renderScreen(page(area.hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        await runAction(screen, 'pin', 'width-full');
        // Movement from the ⋯ is one Move… (the Organize chooser; its carry through real default
        // admission is the cross-area case above) and no step that does nothing.
        const menuIds = menuOf(screen, 'pin').props.actions.map((entry: { id: string }) => entry.id);
        expect(menuIds).toContain('moveTo');
        expect(menuIds).not.toContain('moveUp');
        expect(menuIds).not.toContain('moveDown');
        expect(menuIds.at(-1)).toBe('remove');
        await act(async () => { await area.store.apply({ kind: 'move', instanceId: 'pin', toIndex: 0 }); });
        await flushHookEffects({ cycles: 4 });
        expect((await area.store.read()).instances).toEqual([{ instance: pin, width: 'full' }, { instance: follow, width: 'half' }]);
        standardCleanup();

        const reloaded = await renderScreen(page(area.hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        const ids = reloaded.findAll(node => typeof node.props.testID === 'string' && /^prs\.pinned\.widget\.[a-z]+$/.test(node.props.testID))
            .map(node => node.props.testID as string);
        expect([...new Set(ids)]).toEqual(['prs.pinned.widget.pin', 'prs.pinned.widget.follow']);
        expect(reloaded.root.findAllByType(CardGridCell).some(cell => cell.props.span === 'row'
            && cell.findAll(node => node.props.testID === 'prs.pinned.widget.pin').length > 0)).toBe(true);
        // Width is one of the area's own steps; the follower keeps half.
        expect(menuOf(reloaded, 'follow').props.actions.find((entry: { id: string }) => entry.id === 'width-half')?.selected).toBe(true);
    });

    it('adds a contributed widget from the shared gallery that follows the page without a Set up step', async () => {
        const area = createArea();
        const screen = await renderScreen(page(area.hostApi, 'happier'));
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('prs.pinned.empty')).not.toBeNull();
        await act(async () => { screen.pressByTestId('prs.pinned.add'); });
        await flushHookEffects({ cycles: 3 });
        await act(async () => { screen.pressByTestId('prs.pinned.addPopover.entry.plugin-acme.ci/checks'); });
        await flushHookEffects({ cycles: 4 });
        const saved = (await area.store.read()).instances;
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ instance: { definition: { kind: 'installed', surface: checks }, bindings: { repository: { kind: 'context', slot: 'repository' } } }, width: 'half' });
        expect(screen.getTextContent()).toContain('widget:checks repository:happier;');
    });

    it('is refused by the area’s declared context schema rather than reading with an undeclared page value', async () => {
        const area = createArea();
        await area.store.apply({ kind: 'add', instance: follow });
        const screen = await renderScreen(page(area.hostApi, 42));
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('prs.pinned.unavailable')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('widget:checks');
    });
});

describe('a declarative page’s widget area node', () => {
    it('reaches the same area owner through the mounted facade and follows the node’s page context', async () => {
        const area = createArea();
        await area.store.apply({ kind: 'add', instance: follow });
        const model = PluginDeclarativeProjectedModelV1Schema.parse({
            identity: { pluginId: 'acme.prs', localId: 'overview', qualifiedId: 'acme.prs/overview', occurrenceId: 'prs-1' }, visible: true, requiredHostMethods: [],
            declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [], dragSources: [], dropTargets: [] },
            root: { kind: 'stack', path: 'root', order: 0, children: [
                { kind: 'widgetArea', path: 'root.children[0]', order: 1, area: 'pinned', context: { repository: 'happier' } },
            ] },
        });
        // The controller's widgetArea facade: one envelope per request into the installed area handler.
        const dispatch = (request: unknown, options?: { signal?: AbortSignal }) => area.hostApi.widgetArea(request as never, options);
        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
                interactionEnabled: true, machineId: 'machine-1', serverId: scope.serverId, platform: 'web',
                clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
                <DeclarativePluginSurface pluginId="acme.prs" model={model} environment={environment} interactionEnabled daemonInteractionEnabled
                    dispatchAction={async () => null} actionAvailable={false} openSurface={async () => null} openSurfaceAvailable={false} authorityGeneration={1}
                    renderWidgetArea={createDeclarativeWidgetAreaRender({ dispatch: dispatch as never, surfaceName: 'PRs & Issues' })} />
            </AppShellPluginUiProjectionValueProvider>,
        );
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('plugin-declarative-widget-area:root.children[0].widget.follow')).not.toBeNull();
        expect(screen.getTextContent()).toContain('widget:checks repository:happier;');
    });
});

describe('the Project aside adapter', () => {
    it('says the project source is unavailable instead of keeping a layout under an exact checkout', async () => {
        const screen = await renderScreen(
            <ProjectAsideWidgets serverId="home" projectName="happier"
                activeCheckout={{ id: 'w1', serverId: 'home', machineId: 'm1', rootPath: '/code/happier', createdAtMs: 1 }}
                activeCheckoutLabel="MacBook Pro · main" testID="project.widgets" />,
        );
        expect(screen.findByTestId('project.widgets.unavailable')).not.toBeNull();
        expect(screen.findByTestId('project.widgets.add')).toBeNull();
    });
});
