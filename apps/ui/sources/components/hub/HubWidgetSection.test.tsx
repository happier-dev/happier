import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { WIDGET_SIZE_POLICY_V1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { normalizePluginUiProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { createNearViewportTracker } from '@/components/widgets/nearViewport';
import {
    PluginPageLaunchInputScope, usePluginPageLaunch, usePluginPageLaunchInputStaging,
} from '@/components/plugins/pages/pluginPageNavigation';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { HubWidgetSection } from './HubWidgetSection';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { storage } from '@/sync/domains/state/storage';
import { widgetExecutionOrigin, widgetInstalledPackage } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';

const boundary = vi.hoisted(() => ({ projection: null as PluginUiProjectionModel | null, pushed: [] as unknown[], stage: null as ((open: { pageId: string; subPath: string; input: { selection: string } }) => boolean) | null, moments: {} as Record<string, boolean> }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/', router: { push: (href: unknown) => boundary.pushed.push(href) } }).module);
// Unused HTTP envelope API is outside this navigation corridor. Throw if reached;
// the test must never perform Session key preparation or network mutation.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Envelope HTTP API is not part of Home widget navigation'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const initialState = storage.getState();

function Projection({ children, phase = 'current' }: React.PropsWithChildren<{ phase?: 'current' | 'establishing' }>) {
    return <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: phase === 'establishing' ? null : boundary.projection,
        pluginBrowserProjection: null, phase, interactionEnabled: phase === 'current', machineId: null,
        serverId: 'home-a', platform: 'web', accountLifetime: null,
        clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
        {children}
    </AppShellPluginUiProjectionValueProvider>;
}

function projection(availability: 'available' | 'disabled' = 'available', phase: 'current' | 'retainedOffline' = 'current', pageCount = 1) {
    const entries = Array.from({ length: pageCount }, (_, index) => {
        const localId = index === 0 ? 'notes' : `page-${index}`;
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.notes', destinationId: localId, rendererId: 'notes-native', container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('admitted page binding required');
        return { id: `surfacePlacement:acme.notes:${localId}`, pluginId: 'acme.notes', occurrenceId: 'acme.notes#1', contributionKind: 'surfacePlacement', descriptorId: localId, binding, target: binding.target, renderer: { kind: 'declarative', contributionId: 'notes-native' }, display: { title: 'Notes' }, availability: { state: availability, reason: availability === 'available' ? 'available' : 'plugin_disabled', diagnostics: [] } };
    });
    const executionOrigin = widgetExecutionOrigin('acme.notes', 'machine-a');
    const normalized = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { 'acme.notes': { ...widgetInstalledPackage('acme.notes', 'Notes'), occurrenceId: 'acme.notes#1', executionOrigin } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(entries.map((entry) => [entry.id, entry])) } } }));
    return unionPluginUiProjections([{ machineId: 'machine-a', serverId: 'home-a', projection: normalized, phase, interactionEnabled: phase === 'current' }], new Map([['acme.notes', executionOrigin]])).pluginUiProjection;
}
const widget = { sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize }, key: 'acme.notes/status', surface: { pluginId: 'acme.notes', localId: 'status' }, title: 'Notes status', pluginName: 'Notes', sharedPluginName: false, icon: 'note' as const, homeDefault: 'shown' as const, target: 'app' as const };
const instance = { v: 1 as const, id: 'notes-copy', definition: { kind: 'installed' as const, surface: widget.surface }, bindings: {} };
function LaunchProbe() {
    boundary.stage = usePluginPageLaunchInputStaging();
    const open = usePluginPageLaunch({ pluginId: 'acme.notes', localId: 'notes', subPath: '' });
    return <>{open ? JSON.stringify(open.input) ?? 'input-cleared' : 'no-open'}</>;
}
function home() {
    return <Projection><PluginPageLaunchInputScope target={{ kind: 'app' }} pluginUiProjection={boundary.projection}><LaunchProbe /><HubWidgetSection widget={widget} instance={instance} frameStyle="plain" menu={null} tracker={createNearViewportTracker({ quantum: 40, initialViewportHeight: 800 })} testID="home-widget" /></PluginPageLaunchInputScope></Projection>;
}
beforeEach(() => { boundary.projection = projection(); boundary.pushed = []; boundary.moments = {}; clearActiveUnsavedChangesGuard(); });
afterEach(() => { clearActiveUnsavedChangesGuard(); standardCleanup(); storage.setState(initialState, true); });

describe('Home widget Open', () => {
    it('opens through the catalog launch owner, clearing a previously staged plugin argument', async () => {
        const screen = await renderScreen(home());
        await act(async () => { boundary.stage?.({ pageId: 'plugin:acme.notes:notes', subPath: '', input: { selection: 'previous' } }); });
        expect(screen.getTextContent()).toContain('previous');
        await act(async () => { screen.pressByTestId('home-widget.frame.open'); });
        await flushHookEffects({ cycles: 3 });
        expect(boundary.pushed).toEqual(['/plugins/acme.notes/notes']);
        expect(screen.getTextContent()).toContain('input-cleared');
        expect(screen.getTextContent()).not.toContain('previous');
    });
    it('respects a declined dirty-navigation decision without clearing the prior launch', async () => {
        const screen = await renderScreen(home());
        await act(async () => { boundary.stage?.({ pageId: 'plugin:acme.notes:notes', subPath: '', input: { selection: 'previous' } }); });
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'home-widget-test' });
        await act(async () => { screen.pressByTestId('home-widget.frame.open'); });
        await flushHookEffects({ cycles: 3 });
        expect(boundary.pushed).toEqual([]);
        expect(screen.getTextContent()).toContain('previous');
    });
    it.each(['disabled', 'ambiguous'] as const)('offers no Open for an %s page', async (state) => {
        boundary.projection = state === 'disabled' ? projection('disabled') : projection('available', 'current', 2);
        const screen = await renderScreen(home());
        expect(screen.findByTestId('home-widget.frame.open')).toBeNull();
        expect(boundary.pushed).toEqual([]);
    });
});

describe('Home widget switched off by its atmosphere moment', () => {
    const yourHome = { v: 1 as const, id: 'your-home-copy', definition: { kind: 'builtin' as const, id: 'your_home' as const }, bindings: {} };
    // Far below the viewport: the frame is drawn, its body stays deferred.
    const section = () => {
        storage.setState({ settings: { ...storage.getState().settings, homeAtmosphere: {
            ...storage.getState().settings.homeAtmosphere, moments: boundary.moments,
        } } });
        return <HubWidgetSection instance={yourHome} frameStyle="plain" menu={null}
            tracker={createNearViewportTracker({ quantum: 40, initialViewportHeight: 0 })} testID="home-your-home" />;
    };

    it('keeps a placed Your Home copy on Home while the moment is on', async () => {
        boundary.moments = { yourHome: true };
        const screen = await renderScreen(section());
        expect(screen.findAllHostsByTestId('home-your-home')).toHaveLength(1);
    });

    it('draws nothing for a placed copy while the moment is off, without removing it from the layout', async () => {
        boundary.moments = { yourHome: false };
        const screen = await renderScreen(section());
        expect(screen.findAllHostsByTestId('home-your-home')).toHaveLength(0);
    });
});

describe('a widget that follows its group', () => {
    const follows = (groupNamesValue: boolean) => <HubWidgetSection widget={widget} instance={instance} frameStyle="plain" menu={null}
        followSource={{ value: 'devbox · 3ad2', wide: true, groupNamesValue }}
        tracker={createNearViewportTracker({ quantum: 40, initialViewportHeight: 800 })} testID="home-follow" />;

    it('says which value it follows only when its group has no header to name it', async () => {
        const untitled = await renderScreen(follows(false));
        expect(untitled.getTextContent()).toContain('devbox · 3ad2');
        standardCleanup();
        const titled = await renderScreen(follows(true));
        expect(titled.getTextContent()).not.toContain('devbox · 3ad2');
        expect(titled.getTextContent()).not.toContain('Following group');
    });
});

describe('a card that owns its row', () => {
    const presentedSize = async (props: Readonly<{ size: 'small' | 'medium'; ownsRow?: boolean; sizes?: readonly ('small' | 'medium' | 'wide' | 'full')[] }>) => {
        const declared = props.sizes ? { sizeDeclaration: { sizes: [...props.sizes], defaultSize: props.sizes[0]! } } : {};
        const screen = await renderScreen(<HubWidgetSection widget={{ ...widget, ...declared }} instance={instance} frameStyle="card" menu={null}
            size={props.size} ownsRow={props.ownsRow === true} tracker={createNearViewportTracker({ quantum: 40, initialViewportHeight: 0 })} testID="home-lone" />);
        const frame = screen.root.findAll(node => node.props.testID === 'home-lone.frame' && node.props.widgetPresentation)[0]!;
        const size = frame.props.widgetPresentation.size;
        standardCleanup();
        return size;
    };

    it('presents at its full-row size of the same height instead of a stretched half-row card, keeping the saved size otherwise', async () => {
        expect(await presentedSize({ size: 'small', ownsRow: true })).toBe('wide');
        expect(await presentedSize({ size: 'medium', ownsRow: true })).toBe('full');
        expect(await presentedSize({ size: 'small' })).toBe('small');
        // A widget that declares no full-row size keeps the size it was saved at.
        expect(await presentedSize({ size: 'small', ownsRow: true, sizes: ['small', 'medium'] })).toBe('small');
    });
});

describe('a card whose definition has not arrived', () => {
    it.each(['home', 'board'] as const)('settles an unnamed Artifact title after the %s body read fails, without another read', async (host) => {
        await import('@/sync/syncEngine');
        const { createHomeHubArtifactHttpBoundary } = await import('@/dev/testkit/harness/homeHubArtifactHttpBoundary');
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { WidgetFrame } = await import('@/components/widgets/frame/WidgetFrame');
        const { BoardWidgetCard } = await import('@/components/boards/cards/BoardWidgetCard');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const http = createHomeHubArtifactHttpBoundary('title-viewer');
        let release: (() => void) | undefined;
        const pendingResponse = new Promise<void>(resolve => { release = resolve; });
        let reads = 0;
        const connection = await restoreServerAccountForTest({
            serverUrl: `https://widget-title-${host}.test`, accountId: 'title-viewer',
            request: async (input, init) => {
                if (new URL(String(input)).pathname === '/v1/artifacts/missing-title') {
                    reads++;
                    await pendingResponse;
                }
                return http.request(input, init);
            },
        });
        try {
            const unnamed: WidgetInstanceV1 = { v: 1, id: 'private-instance-id',
                definition: { kind: 'artifact', artifactId: 'missing-title' }, bindings: {} };
            const scope = { serverId: connection.home.id, accountId: 'title-viewer', owner: { kind: 'workBoard' as const, boardId: 'board' } };
            const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}><Projection>
                {host === 'home' ? <HubWidgetSection instance={unnamed} frameStyle="card" menu={null} tracker={null} testID="terminal-title" />
                    : <BoardWidgetCard boardId="board" placement={{ kind: 'widget', ref: { surface: scope, instanceId: unnamed.id }, instance: unnamed, size: 'medium' }}
                        scope={scope} descriptor={null} size="medium" index={0} count={1} dispatch={async () => { throw new Error('Title reads must not mutate the Board'); }} active testID="terminal-title" />}
            </Projection></InjectedAuthProvider>);
            const frame = () => screen.findAllByType(WidgetFrame)[0]!;
            await vi.waitFor(() => expect(reads).toBe(1));
            expect(React.isValidElement(frame().props.title)).toBe(true);
            await act(async () => { release!(); });
            await vi.waitFor(() => expect(frame().props.title).toBe('composerReferences.kindWidget'));
            await flushHookEffects({ cycles: 3 });
            expect(reads).toBe(1);
            expect(screen.getTextContent()).not.toContain(unnamed.id);
            await screen.unmount();
        } finally { release?.(); await connection.dispose(); }
    });

    const frameTitle = async (node: React.ReactElement) => {
        const screen = await renderScreen(node);
        const frame = screen.root.findAll(node => node.props.testID === 'home-pending.frame' && 'title' in node.props)[0]!;
        const result = { title: frame.props.title as unknown, text: screen.getTextContent() };
        standardCleanup();
        return result;
    };
    const pending = (extra: Partial<React.ComponentProps<typeof HubWidgetSection>>, nameless: WidgetInstanceV1 = instance) => <HubWidgetSection
        instance={nameless} frameStyle="card" menu={null} tracker={createNearViewportTracker({ quantum: 40, initialViewportHeight: 0 })}
        testID="home-pending" {...extra} />;

    it('draws a skeleton title rather than the word "Widget", and uses the first name it knows', async () => {
        // Only an establishing app-shell projection is a name still to come (d490e2e3c1); a settled one names the card.
        const unknown = await frameTitle(<Projection phase="establishing">{pending({})}</Projection>);
        expect(React.isValidElement(unknown.title)).toBe(true);
        expect(unknown.text).not.toContain('boards.widgets.kind');
        // A settled installed widget whose surface cannot mount is named by the plugin it belongs to, not a placeholder word.
        const settled = await frameTitle(<Projection>{pending({})}</Projection>);
        expect(settled.title).toBe('Notes');
        // With the plugin unknown to the app there is no name to wait for: the generic word, not a skeleton.
        boundary.projection = null;
        expect((await frameTitle(<Projection>{pending({})}</Projection>)).title).toBe('sessionBoard.item.pluginUnavailable.title');
        expect((await frameTitle(<Projection>{pending({}, { ...instance, definition: { kind: 'artifact', artifactId: 'definition-1' } })}</Projection>)).title)
            .toSatisfy((title: unknown) => React.isValidElement(title));
        expect((await frameTitle(pending({ widget }))).title).toBe('Notes status');
        expect((await frameTitle(pending({}, { ...instance, displayName: 'Ops table' }))).title).toBe('Ops table');
    });
});

describe('Home widget projection subscription', () => {
    it('does not redraw a built card or its body when only executable activation or Connected Account facts change', async () => {
        const base = { pluginUiProjection: boundary.projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: null, serverId: 'home-a', platform: 'web' as const, accountLifetime: null,
            clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} };
        type Value = React.ComponentProps<typeof AppShellPluginUiProjectionValueProvider>['value'];
        let renders = 0;
        let publish!: (next: Value) => void;
        // One element for the whole run: only a subscriber inside the card can report a render.
        const card = <React.Profiler id="home-quiet" onRender={() => { renders++; }}>
            <HubWidgetSection widget={widget} instance={instance} frameStyle="plain" menu={null} tracker={null} testID="home-quiet" />
        </React.Profiler>;
        function Host(props: React.PropsWithChildren) {
            const [value, setValue] = React.useState<Value>(base);
            publish = setValue;
            return <AppShellPluginUiProjectionValueProvider value={value}>{props.children}</AppShellPluginUiProjectionValueProvider>;
        }
        const screen = await renderScreen(<Host>{card}</Host>);
        await flushHookEffects({ cycles: 3 });
        expect(screen.findAllHostsByTestId('home-quiet.body')).toHaveLength(1);
        const before = renders;
        await act(async () => { publish({ ...base, clientExecutableActivation: { status: 'establishing' } }); });
        await act(async () => { publish({ ...base, connectedAccountProjectionRevision: 2 }); });
        await flushHookEffects({ cycles: 3 });
        expect(renders - before).toBe(0);
    });
});
