import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

// Cold compilation belongs to collection, outside the per-test interaction timeout.
await import('./PluginSurfaceInteractionBoundary.web');

describe('PluginSurfaceInteractionBoundary.web', () => {
    it('shows owner-proven content on a cold offline mount while keeping it inert', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary surfaceId="cold-content" snapshotTitle="Saved content" enabled={false} hasContent>
                <span data-testid="saved-content">Saved content</span>
            </PluginSurfaceInteractionBoundary>,
        );
        expect(screen.findByTestId('saved-content')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:cold-content')?.props).toMatchObject({ inert: true, 'aria-hidden': true });
        expect(screen.findByTestId('plugin-surface-offline-state:cold-content')).toBeNull();
        expect(screen.findByTestId('plugin-surface-offline-summary:cold-content')).toBeTruthy();
    });
    it('stamps loaded runtime evidence without using it as interaction authority', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-loaded-runtime"
                snapshotTitle="Loaded runtime"
                enabled
                loadedRuntimeIdentity={{
                    pluginId: 'happier.inspector',
                    occurrenceId: '17',
                    artifactDigest: `sha256:${'a'.repeat(64)}`,
                    machineId: 'machine-a',
                    serverId: 'server-a',
                }}
            >
                <span>content</span>
            </PluginSurfaceInteractionBoundary>,
        );
        expect(screen.findByTestId('plugin-surface-interaction-boundary:surface-loaded-runtime')?.props)
            .toMatchObject({
                'data-plugin-id': 'happier.inspector',
                'data-plugin-occurrence-id': '17',
                'data-plugin-artifact-digest': `sha256:${'a'.repeat(64)}`,
                'data-plugin-machine-id': 'machine-a',
                'data-plugin-server-id': 'server-a',
            });
    });
    it('keeps an enabled but presentation-ineligible snapshot inert without an offline announcement', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-web-presentation-ineligible"
                snapshotTitle="Build summary"
                enabled
                focusEligible={false}
            >
                <button data-testid="plugin-web-presentation-ineligible-action">Run build</button>
            </PluginSurfaceInteractionBoundary>,
        );

        expect(screen.findByTestId('plugin-web-presentation-ineligible-action')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-interaction-boundary:surface-web-presentation-ineligible')?.props)
            .toMatchObject({ 'data-plugin-interaction-state': 'enabled' });
        expect(screen.findByTestId('plugin-surface-snapshot:surface-web-presentation-ineligible')?.props)
            .toMatchObject({
                inert: true,
                'aria-hidden': true,
                style: expect.objectContaining({ pointerEvents: 'none' }),
            });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-web-presentation-ineligible')).toBeNull();
    });

    it('blurs a focused descendant offline and returns focus after the same snapshot is re-enabled', async () => {
        const previousDocument = (globalThis as { document?: unknown }).document;
        const previousHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;
        class TestHTMLElement {
            isConnected = true;
            blur = vi.fn();
            focus = vi.fn();
        }
        const focusTarget = new TestHTMLElement();
        const container = {
            contains: (target: unknown) => target === focusTarget,
        };
        Object.assign(globalThis, {
            HTMLElement: TestHTMLElement,
            document: { activeElement: focusTarget },
        });

        try {
            const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
            const element = (enabled: boolean) => (
                <PluginSurfaceInteractionBoundary
                    surfaceId="surface-web"
                    snapshotTitle="Build summary"
                    enabled={enabled}
                >
                    <button data-testid="plugin-web-action">Action</button>
                </PluginSurfaceInteractionBoundary>
            );
            const screen = await renderScreen(element(true), {
                createNodeMock: (node) => node.type === 'div' ? container : null,
            });

            await screen.update(element(false));
            expect(focusTarget.blur).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-web-action')).toBeTruthy();

            await screen.update(element(true));
            expect(focusTarget.focus).toHaveBeenCalledWith({ preventScroll: true });
            expect(screen.findByTestId('plugin-web-action')).toBeTruthy();
        } finally {
            Object.assign(globalThis, {
                document: previousDocument,
                HTMLElement: previousHTMLElement,
            });
        }
    });

    it('lets a body with nothing cached claim the offline notice as its one line, and says nothing cached (owner 1111 B capture)', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const { PluginSurfaceMachineRecoveryContext } = await import('./pluginSurfaceInteractionAvailability');
        const { useClaimedPluginUiSurfaceNotice, PluginUiSurfaceNoticeContext } = await import('@happier-dev/plugin-ui/advanced');
        function Claimant(props: { failure: boolean }) {
            const sentence = useClaimedPluginUiSurfaceNotice(props.failure);
            const action = React.useContext(PluginUiSurfaceNoticeContext)?.action;
            return <span data-testid="claimant">{sentence ?? 'rows'}{action ? ` + ${action.label}` : ''}</span>;
        }
        const retry = { label: t('common.retry'), onPress: vi.fn() };
        const mount = (enabled: boolean, failure: boolean) => (
            <PluginSurfaceMachineRecoveryContext.Provider value={{ retry }}>
                <PluginSurfaceInteractionBoundary surfaceId="widget" snapshotTitle="New for you" enabled={enabled}>
                    <Claimant failure={failure} />
                </PluginSurfaceInteractionBoundary>
            </PluginSurfaceMachineRecoveryContext.Provider>
        );
        const screen = await renderScreen(mount(true, true));
        await screen.update(mount(false, true));
        // The body has nothing for this part: it says the host's one sentence with the host's Retry, the host nothing.
        expect(screen.findByTestId('plugin-surface-machine-unavailable:widget')).toBeNull();
        expect(screen.findByTestId('claimant')?.props.children.join('')).toBe(`${t('pluginSurfaces.state.offline.nothingCached')} + ${t('common.retry')}`);
        // A body that still shows its cached rows claims nothing: the host's offline line stays, above the rows.
        await screen.update(mount(false, false));
        expect(screen.findByTestId('plugin-surface-machine-unavailable:widget')).not.toBeNull();
        // Live B (owner 1111): the surface is still enabled while its Machine is unreachable, and the host draws the same
        // line; the body with nothing cached claims it there too.
        await screen.update(mount(true, true));
        expect(screen.findByTestId('plugin-surface-machine-unavailable:widget')).toBeNull();
        expect(screen.findByTestId('claimant')?.props.children.join('')).toBe(`${t('pluginSurfaces.state.offline.nothingCached')} + ${t('common.retry')}`);
    });

    it('keeps an offline summary perceivable while the executable snapshot is inert', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const offlineSnapshot = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-web-offline"
                snapshotTitle="Build summary"
                enabled={enabled}
            >
                <button data-testid="plugin-web-offline-action">Run build</button>
            </PluginSurfaceInteractionBoundary>
        );
        // A snapshot exists only once the surface was live; then its runtime goes offline.
        const screen = await renderScreen(offlineSnapshot(true));
        await screen.update(offlineSnapshot(false));

        expect(screen.findByTestId('plugin-web-offline-action')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-web-offline-freshness-text')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:surface-web-offline')?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-web-offline')?.props).toMatchObject({
            role: 'status',
            'aria-live': 'polite',
        });
        expect(
            screen.findByTestId('plugin-surface-offline-summary:surface-web-offline')?.props['aria-label'],
        ).toContain('Build summary');

        const captureEvent = {
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        screen.findByTestId('plugin-surface-snapshot:surface-web-offline')?.props.onClickCapture(captureEvent);
        expect(captureEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(captureEvent.stopPropagation).toHaveBeenCalledTimes(1);

        await screen.update(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-web-offline"
                snapshotTitle="Build summary"
                enabled
            >
                <button data-testid="plugin-web-offline-action">Run build</button>
            </PluginSurfaceInteractionBoundary>,
        );
        expect(screen.findByTestId('plugin-surface-snapshot:surface-web-offline')?.props).toMatchObject({
            inert: false,
            'aria-hidden': false,
        });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-web-offline')).toBeNull();
    });

    it('says nothing has loaded when the surface was offline from the start, and keeps the retained wording once it had been live', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const boundary = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary surfaceId="surface-web-copy" snapshotTitle="Build summary" enabled={enabled}>
                <span>content</span>
            </PluginSurfaceInteractionBoundary>
        );
        const neverLoaded = t('pluginSurfaces.state.offline.reasonNothingLoaded');
        const retained = t('pluginSurfaces.state.offline.reason');
        expect(neverLoaded).not.toBe(retained);

        const fromStart = await renderScreen(boundary(false));
        expect(fromStart.getTextContent()).toContain(neverLoaded);
        expect(fromStart.getTextContent()).not.toContain(retained);

        const wasLive = await renderScreen(boundary(true));
        await wasLive.update(boundary(false));
        expect(wasLive.getTextContent()).toContain(retained);
        expect(wasLive.getTextContent()).not.toContain(neverLoaded);
        expect(wasLive.findByTestId('plugin-surface-offline-summary:surface-web-copy')?.props['aria-label'])
            .toContain('Build summary');
    });

    it('replaces a surface that has loaded nothing with an offline state instead of its inert placeholder', async () => {
        // Live 2026-10-15: PRs & Issues on an offline Machine shimmered 18 skeleton rows forever, with the
        // reason in a footer line. With no snapshot there is nothing to retain; the state is the content.
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const boundary = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary surfaceId="surface-web-empty" snapshotTitle="PRs & Issues" enabled={enabled}>
                <span data-testid="plugin-placeholder">loading rows</span>
            </PluginSurfaceInteractionBoundary>
        );
        const fromStart = await renderScreen(boundary(false));
        expect(fromStart.findByTestId('plugin-placeholder')).toBeNull();
        expect(fromStart.findByTestId('plugin-surface-offline-state:surface-web-empty')).not.toBeNull();
        expect(fromStart.getTextContent()).toContain(t('pluginSurfaces.state.offline.reasonNothingLoaded'));

        await fromStart.update(boundary(true));
        expect(fromStart.findByTestId('plugin-placeholder')).not.toBeNull();
        expect(fromStart.findByTestId('plugin-surface-offline-state:surface-web-empty')).toBeNull();

        // Once live, going offline keeps the read-only snapshot.
        await fromStart.update(boundary(false));
        expect(fromStart.findByTestId('plugin-placeholder')).not.toBeNull();
        expect(fromStart.findByTestId('plugin-surface-offline-state:surface-web-empty')).toBeNull();
    });

    it('leaves the offline statement to the page when it is a companion column', async () => {
        // Live 2026-10-15: Channels on an offline Machine said "This machine is offline" twice, once in
        // its column and once in its page.
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const { PluginSurfaceCompanionContext } = await import('./pluginSurfaceInteractionAvailability');
        const screen = await renderScreen(
            <PluginSurfaceCompanionContext.Provider value>
                <PluginSurfaceInteractionBoundary surfaceId="surface-web-column" snapshotTitle="Channels" enabled={false}>
                    <span data-testid="plugin-column-placeholder">rows</span>
                </PluginSurfaceInteractionBoundary>
            </PluginSurfaceCompanionContext.Provider>,
        );
        expect(screen.findByTestId('plugin-column-placeholder')).toBeNull();
        expect(screen.findByTestId('plugin-surface-offline-state:surface-web-column')).toBeNull();
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-web-column')).toBeNull();
    });

    it('keeps the page identity above the cold state, and leaves a live page and nested surfaces to their own header', async () => {
        // Live 2026-10-16 (PLUGVIS r2k/r2l): a plugin page on a remembered offline machine lost its title and
        // identity; only a back arrow and a floating machine chip were left above "This machine is offline".
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const { PluginSurfacePageHeaderContext } = await import('./pluginSurfaceInteractionAvailability');
        const page = (enabled: boolean) => (
            <PluginSurfacePageHeaderContext.Provider value={{ header: <span data-testid="page-identity">GitHub</span>, loadingFrame: 'column' }}>
                <PluginSurfaceInteractionBoundary surfaceId="surface-web-page" snapshotTitle="GitHub" enabled={enabled}>
                    <PluginSurfaceInteractionBoundary surfaceId="surface-web-nested" snapshotTitle="Nested" enabled={false}>
                        <span>nested</span>
                    </PluginSurfaceInteractionBoundary>
                </PluginSurfaceInteractionBoundary>
            </PluginSurfacePageHeaderContext.Provider>
        );

        const cold = await renderScreen(page(false));
        expect(cold.findAllByTestId('page-identity')).toHaveLength(1);
        expect(cold.findByTestId('plugin-surface-offline-state:surface-web-page')).toBeTruthy();

        const live = await renderScreen(page(true));
        expect(live.findAllByTestId('page-identity')).toHaveLength(0);
        expect(live.findByTestId('plugin-surface-offline-state:surface-web-nested')).toBeTruthy();
    });

    it('names the source, not the machine, when the surface is cold because no source can run it', async () => {
        // Live 2026-10-15 (FX10): a page whose stored source was replaced said "This machine is offline"
        // while its machine was online. The cause is the source choice, and the state says that.
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const { PluginSurfaceSourceCauseContext } = await import('./pluginSurfaceInteractionAvailability');
        const coldWith = (cause: React.ContextType<typeof PluginSurfaceSourceCauseContext>) => (
            <PluginSurfaceSourceCauseContext.Provider value={cause}>
                <PluginSurfaceInteractionBoundary surfaceId="surface-web-source" snapshotTitle="PRs & Issues" enabled={false}>
                    <span data-testid="plugin-placeholder">loading rows</span>
                </PluginSurfaceInteractionBoundary>
            </PluginSurfaceSourceCauseContext.Provider>
        );
        const machineOffline = t('pluginSurfaces.state.offline.titleNothingLoaded');

        const unavailable = await renderScreen(coldWith('unavailable'));
        expect(unavailable.getTextContent()).toContain(t('pluginSurfaces.state.sourceUnavailable.title'));
        expect(unavailable.getTextContent()).not.toContain(machineOffline);

        const required = await renderScreen(coldWith('required'));
        expect(required.getTextContent()).toContain(t('pluginSurfaces.state.sourceRequired.title'));
        expect(required.getTextContent()).not.toContain(machineOffline);

        const presence = await renderScreen(coldWith(null));
        expect(presence.getTextContent()).toContain(machineOffline);

        // Live 2026-10-16 (UI2): with an online machine chosen, the frame before its view answers said
        // "This machine is offline". A chosen, admitted source is connecting, not offline.
        const connecting = await renderScreen(coldWith('connecting'));
        expect(connecting.getTextContent()).toContain(t('pluginSurfaces.state.connecting.title'));
        expect(connecting.getTextContent()).not.toContain(machineOffline);
        for (const cause of ['home_unreachable', 'non_portable', 'release_unavailable', 'source_not_ready',
            'daemon_unsupported', 'daemon_invalid_response', 'activation_refused', 'no_materialization'] as const) {
            const precise = await renderScreen(coldWith(cause));
            expect(precise.getTextContent()).toContain(t(`pluginSurfaces.originReason.${cause}`));
            expect(precise.getTextContent()).not.toContain(machineOffline);
            // A Home that cannot reach the machine is not a missing source; every other refusal is about the source.
            expect(precise.getTextContent()).toContain(cause === 'home_unreachable'
                ? t('pluginSurfaces.state.unreachable.title')
                : t('pluginSurfaces.state.sourceUnavailable.title'));
        }
    });

    it('keeps a resolving source pending and presents an unknown source only after selection settles', async () => {
        const { resolvePluginSurfaceSourceCause } = await import('./pluginSurfaceInteractionAvailability');
        const state = { kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['unknown'] } as const;
        expect(resolvePluginSurfaceSourceCause(state, true)).toBe('connecting');
        expect(resolvePluginSurfaceSourceCause(state, false)).toBe('unknown');
    });

    it('lets presence stay the cause for an offline machine and blames the source for every other refusal', async () => {
        const { resolvePluginSurfaceSourceCause } = await import('./pluginSurfaceInteractionAvailability');
        const unavailable = (...reasons: readonly ('offline' | 'stale' | 'missing' | 'replaced' | 'no_materialization')[]) => (
            resolvePluginSurfaceSourceCause({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons }, false)
        );
        expect(unavailable('offline')).toBeNull();
        expect(unavailable('stale', 'offline')).toBeNull();
        expect(unavailable('no_materialization')).toBe('no_materialization');
        expect(unavailable('missing')).toBe('unavailable');
        expect(unavailable('offline', 'replaced')).toBe('unavailable');
        expect(resolvePluginSurfaceSourceCause({ kind: 'selectionRequired', candidates: [] }, false)).toBe('required');
        // A chosen source the resolver admitted is not offline: until its view answers, it is connecting.
        expect(resolvePluginSurfaceSourceCause({
            kind: 'selected', selectionSource: 'pinned',
            origin: {} as never, candidate: {} as never,
        }, false)).toBe('connecting');
        expect(resolvePluginSurfaceSourceCause({ kind: 'conflict', candidates: [], reasons: ['different_versions'] }, false)).toBe('required');
        for (const reason of ['home_unreachable', 'release_unavailable', 'non_portable', 'source_not_ready',
            'daemon_unsupported', 'daemon_invalid_response', 'activation_refused'] as const) {
            expect(resolvePluginSurfaceSourceCause({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons: [reason] }, false)).toBe(reason);
        }
        expect(resolvePluginSurfaceSourceCause({ kind: 'unavailable', storedOrigin: null, candidates: [],
            reasons: ['non_portable', 'activation_refused'] }, false)).toBe('unavailable');
    });
});
