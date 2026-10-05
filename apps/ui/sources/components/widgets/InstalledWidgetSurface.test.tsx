import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { WIDGET_ROLE } from '@/sync/domains/plugins/ui/widgetContract';

/**
 * The installed arm every widget host shares (Board and Home).
 *
 * These adapter checks capture the forwarded mount props; they do not prove
 * controller admission, Host API execution, or renderer lifecycle. The composed
 * public-widget case in `PluginSurfaceHost.test.tsx` exercises this component
 * through the real inline host, controller, and public native renderer.
 *
 * The three failures pinned here are all silent in the product: a widget that
 * loses the bounded input the person saved, two placements that collapse onto one
 * physical mount, and a Session widget evaluated with weaker policy facts than
 * the equivalent Agent inline surface.
 */

const state = vi.hoisted(() => ({
    mounts: [] as Record<string, unknown>[],
    legacyIdOnlySession: null as ReturnType<typeof createSessionFixture> | null,
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginInlineSurfaceHost: (props: Record<string, unknown>) => {
        state.mounts.push(props);
        return React.createElement('PluginInlineSurfaceHost');
    },
}));

// Store hooks are a process boundary for this focused mount test. Keep the mock
// closed so importing an unrelated generated Artifact inventory cannot decide
// whether the Session-widget lifecycle test can run on a remote executor.
vi.mock('@/sync/store/hooks', () => ({
    useSession: () => state.legacyIdOnlySession,
    useSessionServerId: () => state.legacyIdOnlySession?.serverId ?? 'home-a',
    useSettings: () => ({}),
    useLocalSetting: () => null,
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    useSessionStatus: () => ({ state: 'waiting' }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({ status: 'ready', features: {} }),
    resolveRuntimeFeatureDecisionFromSnapshot: () => ({ state: 'enabled' }),
}));

function projection() {
    const binding = normalizePluginUiInlineSurfaceBindingV1({
        pluginId: 'acme.review',
        surfaceId: 'review-status-widget',
        rendererId: 'review-native',
        role: WIDGET_ROLE,
        target: { kind: 'session' },
    });
    if (!binding) throw new Error('fixture must use an admitted inline binding');
    const entry = {
        id: 'surfacePlacement:acme.review:review-status-widget',
        pluginId: 'acme.review',
        occurrenceId: 'acme-review-widget-occurrence-a',
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-status-widget',
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'review-native' },
        display: { title: 'Review status' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    };
    return normalizePluginUiProjection({
        v: 2,
        generation: 1,
        installedPackagesById: {
            'acme.review': {
                id: 'acme.review',
                occurrenceId: 'acme-review-widget-occurrence-a',
                displayName: 'Review Assistant',
                enabled: true,
                source: { kind: 'local', path: '/plugins/acme.review' },
            },
        },
        actionsById: {},
        familiesById: { pluginUi: { entriesById: { [entry.id]: entry } } },
    } as unknown as PluginProjectionV2);
}

function runtime(overrides: Partial<SessionPluginRuntimeState> = {}): SessionPluginRuntimeState {
    return {
        pluginUiProjection: projection(),
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: true,
        machineId: 'machine-a',
        serverId: 'home-a',
        platform: 'web',
        ...overrides,
    } as SessionPluginRuntimeState;
}

const source = {
    kind: 'installedSurface' as const,
    surface: { pluginId: 'acme.review', localId: 'review-status-widget' },
};

describe('InstalledWidgetSurface', () => {
    it('retires the mounted lifetime when an exact Session target changes under the same instance revision', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const current = runtime();
        const render = (sessionId: string) => React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId, session: createSessionFixture({ id: sessionId, serverId: 'home-a' }) },
            recordRevision: 'same-instance-revision', source, presentation: 'content' as const,
            runtime: current, testID: 'widget',
        });
        const screen = await renderScreen(render('session-a'));
        const firstKey = state.mounts.at(-1)!.mountInstanceKey;
        await act(async () => { screen.tree.update(render('session-b')); });
        const mountedB = state.mounts.at(-1)!;
        expect(mountedB.sessionId).toBe('session-b');
        expect(mountedB.mountInstanceKey).not.toBe(firstKey);
    });

    it('mounts an App widget with the app target and no Session facts', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const appProjection = widgetProjectionOf(
            [{ pluginId: 'acme.review', localId: 'latest', title: 'Latest', target: 'app', homeDefault: 'shown' }],
            { 'acme.review': widgetInstalledPackage('acme.review', 'Review Assistant') },
        );
        await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'app' as const },
            recordRevision: 'acme.review/latest',
            source: { kind: 'installedSurface' as const, surface: { pluginId: 'acme.review', localId: 'latest' } },
            presentation: 'content' as const,
            runtime: runtime({ pluginUiProjection: appProjection }),
            testID: 'widget',
        }));

        expect(state.mounts).toHaveLength(1);
        expect(state.mounts[0]!.sessionId).toBeUndefined();
        expect(state.mounts[0]!.policyContext).toBeUndefined();
        expect(state.mounts[0]!.inlineMount).toEqual({ role: WIDGET_ROLE, presentation: 'content' });
    });

    it('never mounts a Session widget on the App host, or an App widget on a Session', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const appProjection = widgetProjectionOf(
            [{ pluginId: 'acme.review', localId: 'latest', title: 'Latest', target: 'app' }],
            { 'acme.review': widgetInstalledPackage('acme.review', 'Review Assistant') },
        );
        const onApp = await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'app' as const },
            recordRevision: 'r',
            source,
            presentation: 'content' as const,
            runtime: runtime(),
            testID: 'app-widget',
        }));
        const onSession = await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
            recordRevision: 'r',
            source: { kind: 'installedSurface' as const, surface: { pluginId: 'acme.review', localId: 'latest' } },
            presentation: 'content' as const,
            runtime: runtime({ pluginUiProjection: appProjection }),
            testID: 'session-widget',
        }));

        expect(state.mounts).toHaveLength(0);
        expect(onApp.findByTestId('app-widget-state')).toBeTruthy();
        expect(onSession.findByTestId('session-widget-state')).toBeTruthy();
    });

    beforeEach(() => {
        standardCleanup();
        state.mounts = [];
        state.legacyIdOnlySession = createSessionFixture({ id: 'session-1', serverId: 'home-a' });
    });

    it('forwards the item\'s exact persisted bounded input as the plugin launch input', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const onIntrinsicHeightChange = vi.fn();
        await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
            recordRevision: 'revision-a',
            source,
            input: { view: 'summary', limit: 5 },
            presentation: 'content' as const,
            runtime: runtime(),
            onIntrinsicHeightChange,
            testID: 'widget',
        }));

        expect(state.mounts).toHaveLength(1);
        // Verbatim: recomputing or substituting host metadata would silently change
        // what the person saved on the Board.
        expect(state.mounts[0]!.launchInput).toEqual({ view: 'summary', limit: 5 });
        expect(state.mounts[0]!.sessionId).toBe('session-1');
        expect(state.mounts[0]!.inlineMount).toEqual({ role: WIDGET_ROLE, presentation: 'content' });
        expect(state.mounts[0]!.onIntrinsicHeightChange).toBe(onIntrinsicHeightChange);
    });

    it('gives two simultaneous physical placements distinct mount identities', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const current = runtime();
        await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(InstalledWidgetSurface, {
                key: 'board',
                target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
                recordRevision: 'revision-a',
                source,
                presentation: 'content' as const,
                runtime: current,
                testID: 'widget-board',
            }),
            React.createElement(InstalledWidgetSurface, {
                key: 'companion',
                target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
                recordRevision: 'revision-a',
                source,
                presentation: 'fill' as const,
                runtime: current,
                testID: 'widget-companion',
            }),
        ));

        expect(state.mounts).toHaveLength(2);
        const keys = state.mounts.map((mount) => mount.mountInstanceKey);
        expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
        // Reusing one key is how simultaneous placements collapse onto the legacy
        // singleton mount and start cancelling each other's lifetime.
        expect(new Set(keys).size).toBe(2);
    });

    it('allocates a fresh physical mount identity after availability retires the prior mount', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const renderWidget = (current: SessionPluginRuntimeState) => React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
            recordRevision: 'revision-a',
            source,
            presentation: 'content' as const,
            runtime: current,
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget(runtime()));
        const firstMountKey = state.mounts[0]!.mountInstanceKey;

        await act(async () => {
            screen.tree.update(renderWidget(runtime({ pluginUiProjection: null, phase: 'establishing' })));
        });
        expect(state.mounts).toHaveLength(1);

        await act(async () => {
            screen.tree.update(renderWidget(runtime()));
        });
        expect(state.mounts).toHaveLength(2);
        expect(state.mounts[1]!.mountInstanceKey).not.toBe(firstMountKey);
    });

    it('retires the physical mount identity when the persisted item revision changes', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const renderWidget = (recordRevision: string) => React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
            recordRevision,
            source,
            input: { view: recordRevision },
            presentation: 'content' as const,
            runtime: runtime(),
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget('revision-a'));
        const firstMountKey = state.mounts[0]!.mountInstanceKey;

        await act(async () => {
            screen.tree.update(renderWidget('revision-b'));
        });

        expect(state.mounts).toHaveLength(2);
        expect(state.mounts[1]!.launchInput).toEqual({ view: 'revision-b' });
        expect(state.mounts[1]!.mountInstanceKey).not.toBe(firstMountKey);
    });

    it('keeps the physical mount across unrelated projection and custody changes and remounts only on its own occurrence', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const projectionWithExact = (coarseGeneration: number, exactGeneration: string, occurrenceId: string) => {
            const binding = normalizePluginUiInlineSurfaceBindingV1({
                pluginId: 'acme.review',
                surfaceId: 'review-status-widget',
                rendererId: 'review-native',
                role: WIDGET_ROLE,
                target: { kind: 'session' },
            });
            if (!binding) throw new Error('fixture must use an admitted inline binding');
            const entry = {
                id: 'surfacePlacement:acme.review:review-status-widget',
                pluginId: 'acme.review',
                occurrenceId,
                contributionKind: 'surfacePlacement',
                descriptorId: 'review-status-widget',
                binding,
                target: binding.target,
                renderer: { kind: 'declarative', contributionId: 'review-native' },
                display: { title: 'Review status' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            };
            return normalizePluginUiProjection({
                v: 2,
                generation: coarseGeneration,
                installedPackagesById: {
                    'acme.review': {
                        id: 'acme.review',
                        displayName: 'Review Assistant',
                        enabled: true,
                        immutableGenerationId: exactGeneration,
                        occurrenceId,
                        source: { kind: 'local', path: '/plugins/acme.review' },
                    },
                },
                actionsById: {},
                familiesById: { pluginUi: { entriesById: { [entry.id]: entry } } },
            } as unknown as PluginProjectionV2);
        };
        const renderWidget = (current: SessionPluginRuntimeState) => React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
            recordRevision: 'revision-a',
            source,
            presentation: 'content' as const,
            runtime: current,
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget(runtime({
            pluginUiProjection: projectionWithExact(7, 'gen-exact-1', 'occurrence-1'),
        })));
        const firstMountKey = state.mounts[0]!.mountInstanceKey;
        expect(state.mounts).toHaveLength(1);

        // An unrelated plugin bumps the coarse projection generation while this
        // widget's immutable generation is unchanged: the live mount must survive
        // without losing transient plugin state. The host re-renders (so the
        // mount spy observes another render) but the physical lifetime key must
        // stay identical.
        await act(async () => {
            screen.tree.update(renderWidget(runtime({
                pluginUiProjection: projectionWithExact(8, 'gen-exact-2', 'occurrence-1'),
            })));
        });
        expect(state.mounts.at(-1)!.mountInstanceKey).toBe(firstMountKey);

        await act(async () => {
            screen.tree.update(renderWidget(runtime({
                pluginUiProjection: projectionWithExact(9, 'gen-exact-2', 'occurrence-2'),
            })));
        });
        expect(state.mounts.at(-1)!.mountInstanceKey).not.toBe(firstMountKey);

    });

    it('mounts with a real Session policy context rather than none', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
            recordRevision: 'revision-a',
            source,
            presentation: 'content' as const,
            runtime: runtime(),
            testID: 'widget',
        }));

        const policyContext = state.mounts[0]!.policyContext as Record<string, unknown> | undefined;
        expect(policyContext).toBeDefined();
        expect(typeof policyContext!.isFeatureEnabled).toBe('function');
    });

    it('renders a typed state instead of mounting when no exact placement resolves', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const screen = await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-a' }) },
            recordRevision: 'revision-a',
            source: {
                kind: 'installedSurface' as const,
                surface: { pluginId: 'acme.review', localId: 'removed-widget' },
            },
            presentation: 'content' as const,
            runtime: runtime(),
            testID: 'widget',
        }));

        expect(state.mounts).toHaveLength(0);
        expect(screen.findByTestId('widget-state')).toBeTruthy();
    });

    it('uses the admitted runtime Home for a legacy-shaped Session instead of a same-id store entry', async () => {
        state.legacyIdOnlySession = createSessionFixture({ id: 'session-1', serverId: 'home-b' });
        const exactSession = createSessionFixture({ id: 'session-1', serverId: undefined });
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: exactSession },
            recordRevision: 'revision-a',
            source,
            presentation: 'content' as const,
            runtime: runtime({ serverId: 'home-a' }),
            testID: 'widget',
        }));

        expect(state.mounts).toHaveLength(1);
        expect(state.mounts[0]!.serverId).toBe('home-a');
    });

    it('fails closed when the shell Session projection belongs to another Home', async () => {
        const { InstalledWidgetSurface } = await import('./InstalledWidgetSurface');
        const screen = await renderScreen(React.createElement(InstalledWidgetSurface, {
            target: { kind: 'session' as const, sessionId: 'session-1', session: createSessionFixture({ id: 'session-1', serverId: 'home-b' }) },
            recordRevision: 'revision-a',
            source,
            presentation: 'content' as const,
            runtime: runtime({ serverId: 'home-a' }),
            testID: 'widget',
        }));

        expect(state.mounts).toHaveLength(0);
        expect(screen.findByTestId('widget-state')).toBeTruthy();
    });
});
