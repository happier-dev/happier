import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, type PluginJsonSchemaV2 } from '@happier-dev/protocol';
import { createPluginWidgetAreaHostPortV1 } from '@happier-dev/protocol/plugins/ui';
import {
    createWidgetActionInputResolverV1, createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1,
    type WidgetInstanceV1, type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import { PluginHostApiProvider, PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { WidgetSurface } from '@happier-dev/plugin-ui';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';

import { DeclarativePluginSurface } from '@/components/plugins/surfaces/DeclarativePluginSurface';
import { createDeclarativeWidgetAreaRender } from '@/components/plugins/surfaces/declarativeWidgetArea';
import { PluginDeclarativeProjectedModelV1Schema } from '@happier-dev/protocol';

import { PluginPageWidgetArea } from './PluginPageWidgetArea';
import { ProjectAsideWidgets } from './ProjectWidgetArea';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The signed-in viewer is the area's Account: a widget never reads for another viewer.
const viewer = vi.hoisted(() => Object.freeze({ serverId: 'home', accountId: 'viewer' }));
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
    useActiveServerAccountScope: () => viewer,
}));
vi.mock('@/sync/store/hooks', async () => await import('@/sync/domains/state/storage'));
vi.mock('@react-navigation/native', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    useIsFocused: () => true,
}));
// The plugin surface host is the plugin runtime boundary: past it the widget runs its own code. This
// stand-in shows the input the host admitted for it, so a page/pin binding is observable.
vi.mock('@/components/plugins/surfaces', () => ({
    PluginInlineSurfaceHost: (props: { placement: { binding: { surface: { localId: string } } }; launchInput?: Readonly<Record<string, unknown>> }) => (
        `widget:${props.placement.binding.surface.localId} repository:${String(props.launchInput?.repository)};`
    ),
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
    const transport = { ...boundary.transport, read: async (id: string) => {
        const row = await boundary.transport.read(id);
        return row ? { ...row, ownerAccountId: scope.accountId } : null;
    } };
    const store = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
    const widgetInputs = createWidgetActionInputResolverV1({
        readDescriptor: async () => ({ inputs: { fields }, inputSchema }),
        readContext: async request => request.context.widgetAreaContext?.values ?? {}, readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    });
    const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area }, widgetInputs } as ActionExecutorDeps);
    const hostPort = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'acme.prs', pageId: 'overview', declarations, isCurrent: () => true,
        execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
    // The mounted Host API's area method: the same port the native, declarative and hosted bridges reach.
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

function page(hostApi: PluginUiHostApi, repository: unknown) {
    return (
        <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
            interactionEnabled: true, machineId: 'machine-1', serverId: scope.serverId, platform: 'web',
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
            <PluginHostApiProvider hostApi={hostApi}>
                <PluginUiHostPresentationScope environment={environment} presentationHost={presentationHost}>
                    <WidgetSurface area="pinned" context={{ repository: repository as string }} testID="prs.pinned" />
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
    await act(async () => { action.onPress(); });
    await flushHookEffects({ cycles: 4 });
}

afterEach(() => { standardCleanup(); });

describe('a plugin page widget area', () => {
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
        await runAction(screen, 'pin', 'moveUp');
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
        expect(menuOf(reloaded, 'follow').props.actions.find((entry: { id: string }) => entry.id === 'width-half').selected).toBe(true);
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
