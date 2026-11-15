import { act } from 'react-test-renderer';
import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

// The real pane scope owner (tab selection, per-tab state) — not a mock of it.

import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
const runtime = installSessionPaneRuntimeTestHarness();
const { PluginProjectionV2Schema} = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
const { normalizePluginUiDestinationBindingV1 } = await import('@happier-dev/protocol/plugins/ui');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
const { SessionRightPanel } = await import('./SessionRightPanel');
const initialTabId = 'git';
async function renderScreen(element: React.ReactElement) {
    const screen = await renderPanelScreen(<runtime.Wrapper>{element}</runtime.Wrapper>);
    await act(async () => runtime.pane.openRight({ tabId: initialTabId }));
    return screen;
}

describe('SessionRightPanel (keep mounted tabs)', () => {
    it('retains a visited plugin pane across an unrelated plugin declaration change and delivers same-generation replacement props', async () => {
        const pluginId = 'acme.review';
        const localId = 'review-panel';
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: localId,
            rendererId: 'review-renderer', container: 'rightSidebarTab', target: { kind: 'session' } });
        const otherBinding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.other', destinationId: 'other-panel',
            rendererId: 'other-renderer', container: 'rightSidebarTab', target: { kind: 'session' } });
        if (!binding || !otherBinding) throw new Error('Expected canonical Session sidebar destinations');
        const projected = (generation: number, occurrenceId = 'review#1', previous?: ReturnType<typeof normalizePluginUiProjection>) => normalizePluginUiProjection(PluginProjectionV2Schema.parse({
            v: 2, generation, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                [localId]: { id: localId, pluginId, occurrenceId, contributionKind: 'surfacePlacement',
                    descriptorId: localId, binding, target: binding.target,
                    renderer: { kind: 'declarative', contributionId: 'review-renderer' },
                    display: { developerFallback: 'Review' },
                    availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
                    executionOrigin: { serverIdentityId: runtime.serverIdentityId,
                        materializationRef: { pluginId, machineId: 'm1', materializationId: occurrenceId } } },
                'other-panel': { id: 'other-panel', pluginId: 'acme.other', occurrenceId: 'other#1',
                    contributionKind: 'surfacePlacement', descriptorId: 'other-panel', binding: otherBinding,
                    target: otherBinding.target, renderer: { kind: 'declarative', contributionId: 'other-renderer' },
                    display: { developerFallback: `Other panel ${generation}` },
                    availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [] },
            } } },
        }), 'web', previous);
        const panel = (projection: ReturnType<typeof projected>) => <runtime.Wrapper>
            <SessionRightPanel sessionId="s1" scopeId="session:s1" paneSurfaceScope={{ targetKind: 'session',
                sessionId: 's1', machineId: 'm1', serverId: runtime.serverId, pluginUiProjection: projection,
                projectionPhase: 'current', interactionEnabled: true, platform: 'web' }} />
        </runtime.Wrapper>;
        const screen = await renderPanelScreen(<runtime.Wrapper />);
        await act(async () => runtime.pane.selectRightDestination({ kind: 'plugin', destination: { pluginId, localId } }));
        const initial = projected(4);
        await screen.update(panel(initial));
        const retainedHost = screen.findByType(PluginSurfacePlacementHost);
        await act(async () => runtime.pane.setRightTabState(`plugin:${pluginId}:${localId}`, { draft: 'keep my review' }));
        await screen.pressByTestIdAsync('session-rightpanel-tab:git');
        expect(screen.findAllByType(PluginSurfacePlacementHost)).toHaveLength(1);

        const unrelatedChange = projected(5, 'review#1', initial);
        expect(unrelatedChange.surfacePlacementsById[localId]).toBe(initial.surfacePlacementsById[localId]);
        expect(unrelatedChange.surfacePlacementsById['other-panel']).not.toBe(initial.surfacePlacementsById['other-panel']);
        await screen.update(panel(unrelatedChange));
        expect(screen.findAllByType(PluginSurfacePlacementHost),
            'An unrelated acme.other label change must not retire the visited acme.review pane').toHaveLength(1);
        expect(screen.findByType(PluginSurfacePlacementHost)).toBe(retainedHost);
        expect(runtime.pane.scopeState?.right.tabState[`plugin:${pluginId}:${localId}`]).toEqual({ draft: 'keep my review' });

        await act(async () => runtime.pane.selectRightDestination({ kind: 'plugin', destination: { pluginId, localId } }));
        await screen.update(panel(projected(5, 'review#2', unrelatedChange)));
        expect(screen.findByType(PluginSurfacePlacementHost)).toBe(retainedHost);
        expect(screen.findByType(PluginSurfacePlacementHost).props.placement).toMatchObject({ occurrenceId: 'review#2',
            executionOrigin: { materializationRef: { materializationId: 'review#2' } } });
    });

    it('presents the Companion when its opener selects the Companion tab beside an open Git panel', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { SessionCompanionScreen } = await import('@/components/sessions/companion/SessionCompanionScreen');
        const { SessionCompanionRevealPortProvider } = await import('@/components/sessions/companion/presentation/SessionCompanionRevealPort');
        const noop = () => {};
        // The Session shell's reveal port, as SessionView mounts it around the panel.
        const screen = await renderScreen(<SessionCompanionRevealPortProvider address={{ serverId: runtime.serverId, sessionId: 's1' }}
            openFullSurface={noop} revealAfterMutation={noop} revealBoardItem={noop}>
            <SessionRightPanel sessionId="s1" scopeId="session:s1" />
        </SessionCompanionRevealPortProvider>);
        const opacity = (testID: string) => {
            const node = screen.findByTestId(testID)!;
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            return styles.find((entry: unknown) => entry && typeof entry === 'object' && 'opacity' in entry)?.opacity;
        };
        expect(screen.findAllByType(SessionCompanionScreen)).toHaveLength(0);

        // The pane call the Session ⋯ → Companion opener makes (SessionView openCompanionFullSurface).
        await act(async () => runtime.pane.openRight({ tabId: 'companion' }));
        await flushHookEffects({ cycles: 10 });

        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'companion' });
        expect(screen.findAllByType(SessionCompanionScreen)).toHaveLength(1);
        expect(screen.findByTestId('session-rightpanel-surface-companion')!.props.pointerEvents).toBe('auto');
        expect(opacity('session-rightpanel-surface-companion')).toBe(1);
        expect(screen.findByTestId('session-rightpanel-surface-git')!.props.pointerEvents).toBe('none');
        expect(opacity('session-rightpanel-surface-git')).toBe(0);
        // One ⋯ in the panel header: the Companion's own options, and no "Add to Companion" for the Companion itself.
        const menus = screen.findAll((node) => node.props.testID === 'session-rightpanel-header.menu' && Array.isArray(node.props.actions));
        expect(menus).toHaveLength(1);
        const ids = (menus[0]!.props.actions as ReadonlyArray<{ id: string }>).map((action) => action.id);
        expect(ids).toContain('hide');
        expect(ids).not.toContain('add-to-companion');
        expect(screen.findAll((node) => node.props.overflowTriggerTestID === 'session-companion-screen-menu')).toHaveLength(0);
    });

    it('keeps Git and Files tab surfaces mounted so switching tabs preserves state', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { SessionGitSurface } = await import('./surfaces/SessionGitSurface');
        const { SessionBrowseFilesSurface } = await import('./surfaces/SessionBrowseFilesSurface');

        const screen = await renderScreen(
            <>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
            </>,
        );

        const getStyleValue = (node: ReactTestInstance, key: string) => {
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            for (const entry of styles) {
                if (entry && typeof entry === 'object' && key in entry) {
                    return (entry as Record<string, unknown>)[key];
                }
            }
            return undefined;
        };

        expect(screen.findAllByType(SessionGitSurface)).toHaveLength(1);
        // Lazy-mount inactive tabs for faster initial open.
        expect(screen.findAllByType(SessionBrowseFilesSurface)).toHaveLength(0);

        await screen.pressByTestIdAsync('session-rightpanel-tab:files');

        expect(screen.findAllByType(SessionGitSurface)).toHaveLength(1);
        expect(screen.findAllByType(SessionBrowseFilesSurface)).toHaveLength(1);
        expect(screen.findByType(SessionBrowseFilesSurface)).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-surface-git')!.props.pointerEvents).toBe('none');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-git')!, 'opacity')).toBe(0);
        expect(screen.findByTestId('session-rightpanel-surface-files')!.props.pointerEvents).toBe('auto');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-files')!, 'opacity')).toBe(1);

        // Switching back keeps both mounted.
        await screen.pressByTestIdAsync('session-rightpanel-tab:git');
        expect(screen.findAllByType(SessionGitSurface)).toHaveLength(1);
        expect(screen.findAllByType(SessionBrowseFilesSurface)).toHaveLength(1);
        expect(screen.findByTestId('session-rightpanel-surface-git')!.props.pointerEvents).toBe('auto');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-git')!, 'opacity')).toBe(1);
        expect(screen.findByTestId('session-rightpanel-surface-files')!.props.pointerEvents).toBe('none');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-files')!, 'opacity')).toBe(0);
    });
});
