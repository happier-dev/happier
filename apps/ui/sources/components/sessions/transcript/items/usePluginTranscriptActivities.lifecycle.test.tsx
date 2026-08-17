import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
} from '@happier-dev/protocol';

import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

import { usePluginTranscriptActivities } from './usePluginTranscriptActivities';

const transport = vi.hoisted(() => ({
    read: vi.fn(),
    open: vi.fn(),
    next: vi.fn(),
    close: vi.fn(),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machinePluginUiResourceRead: transport.read,
    machinePluginUiResourceWatchOpen: transport.open,
    machinePluginUiResourceWatchNext: transport.next,
    machinePluginUiResourceWatchClose: transport.close,
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

function createAccountLifetime() {
    let current = true;
    const retirements = new Set<() => void>();
    return {
        lifetime: Object.freeze({
            scope: { serverId: 'server-1', accountId: 'account-a' },
            isCurrent: () => current,
            onRetire(cancel: () => void) {
                if (!current) {
                    cancel();
                    return Object.freeze({ dispose: () => undefined });
                }
                retirements.add(cancel);
                let removed = false;
                return Object.freeze({
                    dispose: () => {
                        if (removed) return;
                        removed = true;
                        retirements.delete(cancel);
                    },
                });
            },
        }),
        activeRetirementCount: () => retirements.size,
    };
}

function projection(generation: number): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation,
        transcriptActivitiesById: Object.freeze({
            'acme.preview/activity': Object.freeze({
                id: 'acme.preview/activity',
                pluginId: 'acme.preview',
                contributionKind: 'transcriptActivity' as const,
                descriptorId: 'activity',
                resource: Object.freeze({ pluginId: 'acme.preview', localId: 'live-activity' }),
                actions: Object.freeze([]),
            }),
        }),
    });
}

function response(title: string, generation: string) {
    return {
        supported: true,
        result: {
            ok: true,
            resource: { pluginId: 'acme.preview', localId: 'live-activity' },
            kind: 'config',
            contentType: PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
            digest: `sha256:${generation.repeat(64)}`,
            bytesBase64: Buffer.from(JSON.stringify({
                version: 1,
                activities: [{
                    localActivityId: 'build',
                    title,
                    phase: 'running',
                    checklist: [],
                    dismissible: false,
                    actions: [],
                }],
            })).toString('base64'),
        },
    };
}

function ResourceStoreProvider(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <PluginContextualResourceStoreProvider>
            {props.children}
        </PluginContextualResourceStoreProvider>
    );
}

describe('plugin transcript Activity Resource retirement', () => {
    it('retires an exact prior generation store when its projection is replaced', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const account = createAccountLifetime();
        const generationSeven = response('Generation seven', 'a');
        const generationEight = response('Generation eight', 'b');
        transport.read.mockImplementation(async (_machineId: string, options: Readonly<{ expectedGeneration: string }>) => (
            options.expectedGeneration === '7'
                ? generationSeven
                : generationEight
        ));
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{
            expectedGeneration: string;
            subscriptionId: string;
        }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: `sha256:${options.expectedGeneration === '7' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe(props: Readonly<{ pluginUiProjection: PluginUiProjectionModel }>) {
            latest = usePluginTranscriptActivities({
                accountLifetime: account.lifetime,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: props.pluginUiProjection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ResourceStoreProvider><Probe pluginUiProjection={projection(7)} /></ResourceStoreProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Generation seven' }]);
        });
        expect(account.activeRetirementCount()).toBe(2);

        await act(async () => {
            tree?.update(<ResourceStoreProvider><Probe pluginUiProjection={projection(8)} /></ResourceStoreProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Generation eight' }]);
        });

        // One generic store has been replaced, not retained alongside the new
        // generation. The hook and mounted store retain their own scoped
        // cancellation callbacks, while the old generation's store is gone.
        expect(account.activeRetirementCount()).toBe(2);
        await act(async () => { tree?.unmount(); });
    });

    it('retires a still-observed prior generation when the exact generation changes', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const account = createAccountLifetime();
        const generationSeven = response('Generation seven', 'd');
        const generationEight = response('Generation eight', 'e');
        const projectionSeven = projection(7);
        const projectionEight = projection(8);
        transport.read.mockImplementation(async (_machineId: string, options: Readonly<{ expectedGeneration: string }>) => (
            options.expectedGeneration === '7' ? generationSeven : generationEight
        ));
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{
            expectedGeneration: string;
            subscriptionId: string;
        }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: `sha256:${options.expectedGeneration === '7' ? 'd'.repeat(64) : 'e'.repeat(64)}`,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let current: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        let stale: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe(props: Readonly<{
            label: 'current' | 'stale';
            pluginUiProjection: PluginUiProjectionModel;
        }>) {
            const value = usePluginTranscriptActivities({
                accountLifetime: account.lifetime,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: props.pluginUiProjection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            if (props.label === 'current') current = value;
            else stale = value;
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ResourceStoreProvider>
                    <Probe label="current" pluginUiProjection={projectionSeven} />
                    <Probe label="stale" pluginUiProjection={projectionSeven} />
                </ResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(current?.activities).toMatchObject([{ title: 'Generation seven' }]);
            expect(stale?.activities).toMatchObject([{ title: 'Generation seven' }]);
        });
        expect(account.activeRetirementCount()).toBe(3);

        await act(async () => {
            tree?.update(
                <ResourceStoreProvider>
                    <Probe label="current" pluginUiProjection={projectionEight} />
                    <Probe label="stale" pluginUiProjection={projectionSeven} />
                </ResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(current?.activities).toMatchObject([{ title: 'Generation eight' }]);
        });

        // The new exact generation is a currentness boundary, not an idle
        // cache policy. A lingering old consumer must not keep its old watch
        // or Account-lifetime store alive after the authoritative replacement.
        await vi.waitFor(() => { expect(transport.close).toHaveBeenCalledTimes(1); });
        expect(account.activeRetirementCount()).toBe(3);

        await act(async () => { tree?.unmount(); });
    });

    it('retires an exact Session Resource only after the canonical deletion fact', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const account = createAccountLifetime();
        const deletedTargetResource = response('Disposable session activity', 'c');
        const deletedTargetProjection = projection(7);
        transport.read.mockResolvedValue(deletedTargetResource);
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: `sha256:${'c'.repeat(64)}`,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe(props: Readonly<{ sessionRemoved: boolean }>) {
            latest = usePluginTranscriptActivities({
                accountLifetime: account.lifetime,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: deletedTargetProjection,
                serverId: 'server-1',
                sessionId: 'session-a',
                // Production supplies this only from `deletedSessionIds`, the
                // canonical server-backed permanent-removal fact. Archive and
                // cache eviction intentionally never set it.
                sessionRemoved: props.sessionRemoved,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ResourceStoreProvider><Probe sessionRemoved={false} /></ResourceStoreProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Disposable session activity' }]);
        });
        expect(account.activeRetirementCount()).toBe(2);

        await act(async () => {
            tree?.update(<ResourceStoreProvider><Probe sessionRemoved /></ResourceStoreProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toEqual([]);
            expect(transport.close).toHaveBeenCalledTimes(1);
        });
        // The transcript consumer remains valid. The permanently removed
        // target's generic Resource store is retired with no Account map left
        // holding its binding.
        expect(account.activeRetirementCount()).toBe(1);

        await act(async () => { tree?.unmount(); });
    });

    it('does not retire a prior Session Resource when navigation lands on a different deleted target', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const account = createAccountLifetime();
        const sessionAInitial = response('Session A retained', 'f');
        const sessionARefreshed = response('Session A refreshed', '0');
        const projectionSeven = projection(7);
        let reads = 0;
        let resolveSessionARefresh: ((value: ReturnType<typeof response>) => void) | null = null;
        transport.read.mockImplementation(async (_machineId: string, options: Readonly<{
            context?: Readonly<{ kind: string; sessionId: string }>;
        }>) => {
            if (options.context?.sessionId !== 'session-a') {
                throw new Error('A permanently deleted destination must not acquire a Resource.');
            }
            reads += 1;
            if (reads === 1) return sessionAInitial;
            return await new Promise<ReturnType<typeof response>>((resolve) => {
                resolveSessionARefresh = resolve;
            });
        });
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: sessionAInitial.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe(props: Readonly<{ sessionId: string; sessionRemoved: boolean }>) {
            latest = usePluginTranscriptActivities({
                accountLifetime: account.lifetime,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projectionSeven,
                serverId: 'server-1',
                sessionId: props.sessionId,
                sessionRemoved: props.sessionRemoved,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ResourceStoreProvider><Probe sessionId="session-a" sessionRemoved={false} /></ResourceStoreProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Session A retained' }]);
        });
        expect(account.activeRetirementCount()).toBe(2);

        await act(async () => {
            tree?.update(<ResourceStoreProvider><Probe sessionId="session-b" sessionRemoved /></ResourceStoreProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(latest?.activities).toEqual([]); });
        // The permanent-removal fact belongs to Session B. It cannot revoke
        // Session A through a shared registry; Session A's released store has
        // already been disposed with its mount-local consumer.
        expect(account.activeRetirementCount()).toBe(1);

        await act(async () => {
            tree?.update(<ResourceStoreProvider><Probe sessionId="session-a" sessionRemoved={false} /></ResourceStoreProvider>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(reads).toBe(2); });
        await vi.waitFor(() => {
            expect(latest?.activities).toEqual([]);
        });

        await act(async () => {
            resolveSessionARefresh!(sessionARefreshed);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Session A refreshed' }]);
        });

        await act(async () => { tree?.unmount(); });
    });
});
