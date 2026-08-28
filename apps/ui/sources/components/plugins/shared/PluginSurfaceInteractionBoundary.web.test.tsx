import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

describe('PluginSurfaceInteractionBoundary.web', () => {
    it('stamps loaded runtime evidence without using it as interaction authority', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-loaded-runtime"
                snapshotTitle="Loaded runtime"
                enabled
                loadedRuntimeIdentity={{
                    pluginId: 'happier.inspector',
                    generation: '17',
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
                'data-plugin-generation': '17',
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

    it('keeps an offline summary perceivable while the executable snapshot is inert', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.web');
        const screen = await renderScreen(
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-web-offline"
                snapshotTitle="Build summary"
                enabled={false}
            >
                <button data-testid="plugin-web-offline-action">Run build</button>
            </PluginSurfaceInteractionBoundary>,
        );

        expect(screen.findByTestId('plugin-web-offline-action')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:surface-web-offline')?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-web-offline')?.props).toMatchObject({
            role: 'status',
            'aria-live': 'polite',
        });
        expect(
            screen.findByTestId('plugin-surface-offline-summary:surface-web-offline')?.props.children,
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
});
