import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
    });
});

vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginSurfaceHost: (props: Record<string, unknown>) => {
        pluginSurfaceHostSpy(props);
        return React.createElement('PluginSurfaceHost', props);
    },
}));

function createCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return {
        contribution: { pluginId: 'acme.compose', localId: 'summary' },
        immutableGenerationId: 'generation-1',
        projectionGeneration: 7,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.compose', localId: 'summary-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.compose', localId: 'summary-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'summary-renderer',
                model: { visible: true },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'acme.compose',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: { pluginId: 'acme.compose', immutableGenerationId: 'generation-1' },
            points: [],
        },
    } as DaemonPluginUiComposerSurfaceCatalogEntryV1;
}

const lifetime = {
    isCurrent: () => true,
    onRetire: () => ({ dispose() {} }),
};

describe('ComposerPluginSurface', () => {
    it('reuses the one PluginSurfaceHost composer arm with the supplied truthful target', async () => {
        const { ComposerPluginSurface } = await import('./ComposerPluginSurface');
        const catalogEntry = createCatalogEntry();

        await renderScreen(<ComposerPluginSurface
            request={{
                contribution: catalogEntry.contribution,
                immutableGenerationId: 'generation-1',
                role: 'region',
                input: {
                    v: 1,
                    role: 'region',
                    composer: { kind: 'newSession', instanceId: 'new-session-1' },
                    regionLocalId: 'summary',
                },
                instanceKey: 'composer:region:acme.compose/summary',
            }}
            physicalTarget={{ kind: 'app' }}
            projectionGeneration={7}
            catalogEntries={[catalogEntry]}
            pluginProjectionById={{}}
            pluginProjectionV2={{ v: 2, generation: 7 } as PluginProjectionV2}
            machineId="machine-1"
            serverId="server-1"
            parentLifetime={lifetime}
            transactionApplier={{ apply: () => ({ status: 'rejected' }) } as never}
        />);

        expect(pluginSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            composerMount: expect.objectContaining({
                physicalTarget: { kind: 'app' },
                mount: expect.objectContaining({
                    kind: 'composer',
                    mount: expect.objectContaining({
                        role: 'region',
                        input: expect.objectContaining({
                            composer: { kind: 'newSession', instanceId: 'new-session-1' },
                        }),
                    }),
                }),
            }),
        }));
        const hostProps = pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{
            composerMount?: Readonly<{
                binding?: Readonly<{
                    mountedHostApiHandlers?: Readonly<Record<string, unknown>>;
                }>;
            }>;
        }>;
        expect(hostProps.composerMount?.binding?.mountedHostApiHandlers).toEqual(expect.objectContaining({
            pickComposerMedia: expect.any(Function),
            inspectComposerContent: expect.any(Function),
            releaseComposerContent: expect.any(Function),
        }));
    });

    // The Composer host is presented by the same web bundle in a plain browser
    // tab and inside the Tauri/Electron desktop shell, where `Platform.OS` is
    // still `'web'`. Only the canonical desktop-aware resolver separates them,
    // and the separation decides whether a hosted Composer surface reaches the
    // native desktop Artifact path or the sandboxed browser iframe.
    it('classifies the desktop shell as desktop and a plain browser tab as web', async () => {
        const { ComposerPluginSurface } = await import('./ComposerPluginSurface');
        const catalogEntry = createCatalogEntry();
        const renderComposerSurface = () => renderScreen(<ComposerPluginSurface
            request={{
                contribution: catalogEntry.contribution,
                immutableGenerationId: 'generation-1',
                role: 'region',
                input: {
                    v: 1,
                    role: 'region',
                    composer: { kind: 'newSession', instanceId: 'new-session-1' },
                    regionLocalId: 'summary',
                },
                instanceKey: 'composer:region:acme.compose/summary',
            }}
            physicalTarget={{ kind: 'app' }}
            projectionGeneration={7}
            catalogEntries={[catalogEntry]}
            pluginProjectionById={{}}
            pluginProjectionV2={{ v: 2, generation: 7 } as PluginProjectionV2}
            machineId="machine-1"
            serverId="server-1"
            parentLifetime={lifetime}
            transactionApplier={{ apply: () => ({ status: 'rejected' }) } as never}
        />);
        const readPlatform = (): unknown => (
            (pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{ platform?: unknown }>)?.platform
        );

        await renderComposerSurface();
        expect(readPlatform()).toBe('web');

        (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => undefined };
        try {
            await renderComposerSurface();
            expect(readPlatform()).toBe('desktop');
        } finally {
            delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
        }
    });
});
