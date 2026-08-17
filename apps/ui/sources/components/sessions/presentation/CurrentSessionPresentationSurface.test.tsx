import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';

import { CurrentSessionPresentationSurface } from './CurrentSessionPresentationSurface';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return await createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Readonly<{ children?: React.ReactNode }>) => (
        React.createElement('Text', props, props.children)
    ),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/domains/session/sessionPayloadConsumptionTelemetry', () => ({
    recordSessionPayloadConsumptionTelemetry: vi.fn(),
}));

const owner = {
    pluginId: 'acme.channels',
    contributionId: 'session-observer',
    generationId: '17',
    invocationId: 'invocation-a',
    sessionId: 'session-a',
} as const;

function hasPoliteLiveRegionAncestor(node: ReactTestInstance): boolean {
    let ancestor = node.parent;
    while (ancestor) {
        if (ancestor.props.accessibilityLiveRegion === 'polite') return true;
        ancestor = ancestor.parent;
    }
    return false;
}

afterEach(() => {
    standardCleanup();
    vi.clearAllMocks();
});

describe('CurrentSessionPresentationSurface', () => {
    it('composes admitted manifest regions at the existing physical slot when no transient presentation exists', async () => {
        const renderComposerRegion = vi.fn(() => (
            React.createElement('ComposerManifestRegion', { testID: 'composer-region:acme.review/summary' })
        ));
        const ComposerPresentationSurfaceWithRegions = CurrentSessionPresentationSurface as unknown as React.ComponentType<
            Readonly<Record<string, unknown>>
        >;
        const region = {
            id: 'acme.review/summary',
            pluginId: 'acme.review',
            identity: { pluginId: 'acme.review', localId: 'summary' },
            immutableGenerationId: 'review-generation-a',
            definition: {
                id: 'summary',
                placement: 'beforeComposer',
                renderer: [{ pluginId: 'acme.review', localId: 'summary-renderer' }],
            },
        };
        const screen = await renderScreen(React.createElement(ComposerPresentationSurfaceWithRegions, {
            session: { agentState: {} },
            placement: 'beforeComposer',
            composerRegions: [region],
            renderComposerRegion,
        }));

        expect(renderComposerRegion).toHaveBeenCalledWith(region);
        expect(screen.findByTestId('composer-region:acme.review/summary')).toBeTruthy();
        expect(screen.findByTestId('current-session-presentation-beforeComposer')).toBeTruthy();
    });

    it('keeps changing manifest regions outside the transient polite live region', async () => {
        const ComposerPresentationSurfaceWithRegions = CurrentSessionPresentationSurface as unknown as React.ComponentType<
            Readonly<Record<string, unknown>>
        >;
        const region = {
            id: 'acme.review/summary',
            pluginId: 'acme.review',
            identity: { pluginId: 'acme.review', localId: 'summary' },
            immutableGenerationId: 'review-generation-a',
            definition: {
                id: 'summary',
                placement: 'beforeComposer',
                renderer: [{ pluginId: 'acme.review', localId: 'summary-renderer' }],
            },
        };
        const render = (version: number) => React.createElement(ComposerPresentationSurfaceWithRegions, {
            session: {
                agentState: {
                    currentSessionPresentationV1: {
                        v: 1,
                        hostNonce: 'host-a',
                        revision: 1,
                        statuses: [{
                            localKey: 'refresh',
                            text: 'Refreshing composer',
                            owner,
                            revision: 1,
                        }],
                        widgets: [],
                    },
                },
            },
            placement: 'beforeComposer',
            composerRegions: [region],
            renderComposerRegion: () => React.createElement('ComposerManifestRegion', {
                testID: 'composer-region:acme.review/summary',
                version,
            }),
        });

        const screen = await renderScreen(render(1));
        await screen.update(render(2));

        const regionNode = screen.findByTestId('composer-region:acme.review/summary');
        if (!regionNode) throw new Error('expected the manifest composer region');
        const statusNode = screen.findAll((node) => (
            String(node.type) === 'Text' && node.props.children === 'Refreshing composer'
        ))[0];
        if (!statusNode) throw new Error('expected the transient status line');

        expect(regionNode.props.version).toBe(2);
        expect(hasPoliteLiveRegionAncestor(regionNode)).toBe(false);
        expect(hasPoliteLiveRegionAncestor(statusNode)).toBe(true);
    });

    it('replaces and retires a manifest region at the physical slot when its admitted generation changes or is removed', async () => {
        const mounted = vi.fn();
        const retired = vi.fn();
        type ComposerRegionInput = Readonly<{
            id: string;
            immutableGenerationId: string;
        }>;
        const initialRegion = {
            id: 'acme.review/summary',
            pluginId: 'acme.review',
            identity: { pluginId: 'acme.review', localId: 'summary' },
            immutableGenerationId: 'review-generation-a',
            definition: {
                id: 'summary',
                placement: 'beforeComposer',
                renderer: [{ pluginId: 'acme.review', localId: 'summary-renderer' }],
            },
        } as const;
        const replacementRegion = {
            ...initialRegion,
            immutableGenerationId: 'review-generation-b',
        } as const;
        const ComposerRegion = (props: Readonly<{ region: ComposerRegionInput }>) => {
            React.useEffect(() => {
                mounted(props.region.immutableGenerationId);
                return () => retired(props.region.immutableGenerationId);
            }, [props.region.immutableGenerationId]);
            return React.createElement('ComposerManifestRegion', {
                testID: `composer-region:${props.region.immutableGenerationId}`,
            });
        };
        const renderComposerRegion = vi.fn((region: ComposerRegionInput) => (
            React.createElement(ComposerRegion, { region })
        ));
        const ComposerPresentationSurfaceWithRegions = CurrentSessionPresentationSurface as unknown as React.ComponentType<
            Readonly<Record<string, unknown>>
        >;
        const render = (composerRegions: readonly ComposerRegionInput[]) => React.createElement(
            ComposerPresentationSurfaceWithRegions,
            {
                session: { agentState: {} },
                placement: 'beforeComposer',
                composerRegions,
                renderComposerRegion,
            },
        );

        const screen = await renderScreen(render([initialRegion]));
        expect(mounted).toHaveBeenCalledExactlyOnceWith('review-generation-a');

        await screen.update(render([replacementRegion]));
        expect(retired).toHaveBeenCalledExactlyOnceWith('review-generation-a');
        expect(mounted).toHaveBeenLastCalledWith('review-generation-b');

        await screen.update(render([]));
        expect(retired).toHaveBeenLastCalledWith('review-generation-b');
        expect(screen.findByTestId('current-session-presentation-beforeComposer')).toBeNull();
    });

    it('uses each status/widget local key together with its host owner for React child identity', async () => {
        const betaOwner = {
            ...owner,
            pluginId: 'acme.beta',
            generationId: '18',
            invocationId: 'invocation-b',
        } as const;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const screen = await renderScreen(
                <CurrentSessionPresentationSurface
                    session={{
                        agentState: {
                            currentSessionPresentationV1: {
                                v: 1,
                                hostNonce: 'host-a',
                                revision: 4,
                                statuses: [
                                    { localKey: 'progress', text: 'Alpha status', owner, revision: 1 },
                                    { localKey: 'detail', text: 'Alpha detail', owner, revision: 2 },
                                    { localKey: 'progress', text: 'Beta status', owner: betaOwner, revision: 3 },
                                ],
                                widgets: [
                                    {
                                        localKey: 'progress',
                                        placement: 'beforeComposer',
                                        lines: ['Alpha widget'],
                                        owner,
                                        revision: 4,
                                    },
                                    {
                                        localKey: 'detail',
                                        placement: 'beforeComposer',
                                        lines: ['Alpha detail widget'],
                                        owner,
                                        revision: 5,
                                    },
                                    {
                                        localKey: 'progress',
                                        placement: 'beforeComposer',
                                        lines: ['Beta widget'],
                                        owner: betaOwner,
                                        revision: 6,
                                    },
                                ],
                            },
                        },
                    } as Pick<Session, 'agentState'>}
                    placement="beforeComposer"
                />,
            );

            const text = screen.findAll((node) => String(node.type) === 'Text')
                .map((node) => node.props.children);
            expect(text).toEqual(expect.arrayContaining([
                'Alpha status',
                'Alpha detail',
                'Beta status',
                'Alpha widget',
                'Alpha detail widget',
                'Beta widget',
            ]));
            expect(consoleError.mock.calls.some((args) => args.join(' ').includes('same key'))).toBe(false);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('withholds a legacy actionable record instead of rendering a banner', async () => {
        const screen = await renderScreen(
            <CurrentSessionPresentationSurface
                session={{
                    agentState: {
                        currentSessionPresentationV1: {
                            v: 1,
                            hostNonce: 'host-a',
                            revision: 3,
                            statuses: [],
                            widgets: [],
                            actionable: {
                                key: 'repair-connection',
                                text: 'Reconnect the channel',
                                attentionReason: 'action_required',
                                command: {
                                    kind: 'executeAction',
                                    action: { pluginId: 'acme.channels', localId: 'reconnect' },
                                },
                                owner,
                                revision: 2,
                            },
                        },
                    },
                } as Pick<Session, 'agentState'>}
                placement="beforeComposer"
            />,
        );

        expect(screen.findByTestId('current-session-presentation-actionable:repair-connection')).toBeNull();
        expect(screen.findByTestId('current-session-presentation-beforeComposer')).toBeNull();
    });
});
