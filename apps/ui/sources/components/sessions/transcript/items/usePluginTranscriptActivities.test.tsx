import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
    PluginProjectionV2Schema,
} from '@happier-dev/protocol';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    normalizePluginUiProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';

import {
    appendPluginTranscriptActivityTranscriptItems,
    buildPluginTranscriptActivityIdentityKey,
    createPluginTranscriptActivityTranscriptItemsCache,
} from './pluginTranscriptActivityTranscriptItem';
import { PluginTranscriptActivityDismissalProvider } from './PluginTranscriptActivityDismissalProvider';
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

const ACCOUNT_LIFETIME = Object.freeze({
    scope: { serverId: 'server-1', accountId: 'account-1' },
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => undefined }),
});

function createAccountLifetime(accountId: string) {
    let current = true;
    const retirements = new Set<() => void>();
    return {
        lifetime: Object.freeze({
            scope: { serverId: 'server-1', accountId },
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
        retire: () => {
            if (!current) return;
            current = false;
            const pending = [...retirements];
            retirements.clear();
            pending.forEach((cancel) => cancel());
        },
    };
}

const projection: PluginUiProjectionModel = Object.freeze({
    ...EMPTY_PLUGIN_UI_PROJECTION,
    generation: 7,
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

function response(
    value: unknown,
    digest: string,
    resource: Readonly<{ pluginId: string; localId: string }> = {
        pluginId: 'acme.preview',
        localId: 'live-activity',
    },
) {
    return {
        supported: true,
        result: {
            ok: true,
            resource,
            kind: 'config',
            contentType: PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
            digest,
            bytesBase64: Buffer.from(JSON.stringify(value)).toString('base64'),
        },
    };
}

function channelsProjectionFromDaemonEntry(): PluginUiProjectionModel {
    const daemonProjection = PluginProjectionV2Schema.parse({
        v: 2,
        generation: 17,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'transcriptActivity:happier.channels:outward-delivery': {
                        id: 'transcriptActivity:happier.channels:outward-delivery',
                        pluginId: 'happier.channels',
                        contributionKind: 'transcriptActivity',
                        descriptorId: 'outward-delivery',
                        resource: {
                            pluginId: 'happier.channels',
                            localId: 'outward-delivery-activities-v1',
                        },
                        actions: [],
                    },
                },
            },
        },
        diagnostics: [],
    });
    return normalizePluginUiProjection(daemonProjection);
}

function ActivityTestProviders(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <PluginContextualResourceStoreProvider>
            <PluginTranscriptActivityDismissalProvider>
                {props.children}
            </PluginTranscriptActivityDismissalProvider>
        </PluginContextualResourceStoreProvider>
    );
}

function ResourceOnlyTestProviders(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <PluginContextualResourceStoreProvider>
            {props.children}
        </PluginContextualResourceStoreProvider>
    );
}

describe('plugin transcript Activity Resource projection', () => {
    it('consumes the real Channels daemon-projected descriptor through the generic Resource owner', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const channelsProjection = channelsProjectionFromDaemonEntry();
        const current = response({
            version: 1,
            activities: [{
                localActivityId: 'delivery-0123',
                title: 'External delivery',
                phase: 'running',
                status: 'Delivery will retry',
                checklist: [],
                dismissible: false,
                actions: [],
            }],
        }, `sha256:${'0'.repeat(64)}`, {
            pluginId: 'happier.channels',
            localId: 'outward-delivery-activities-v1',
        });
        transport.read.mockResolvedValue(current);
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: current.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe() {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: channelsProjection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{
                pluginId: 'happier.channels',
                contributionId: 'outward-delivery',
                resourceId: 'outward-delivery-activities-v1',
                title: 'External delivery',
                status: 'Delivery will retry',
            }]);
        });
        expect(transport.read.mock.calls[0]?.[1]).toMatchObject({
            resource: {
                pluginId: 'happier.channels',
                localId: 'outward-delivery-activities-v1',
            },
            context: { kind: 'session', sessionId: 'session-a' },
        });

        await act(async () => { tree?.unmount(); });
    });

    it('keeps terminal rows until a valid empty profile snapshot omits them, even when interaction is inactive', async () => {
        let current = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Build complete',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'a'.repeat(64)}`);
        let resolveNext: ((value: unknown) => void) | null = null;
        transport.read.mockImplementation(async () => current);
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: current.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise((resolve) => {
            resolveNext = resolve;
        }));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe() {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([
                { localActivityId: 'build', phase: 'succeeded', freshness: 'current' },
            ]);
        });
        const dismissedIdentity = buildPluginTranscriptActivityIdentityKey(latest!.activities[0]!);
        await act(async () => {
            latest!.onDismissActivity(dismissedIdentity);
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.dismissedActivityIds.has(dismissedIdentity)).toBe(true);
        });

        current = response({ version: 1, activities: [] }, `sha256:${'b'.repeat(64)}`);
        await vi.waitFor(() => { expect(resolveNext).toBeTypeOf('function'); });
        await act(async () => {
            resolveNext!({
                supported: true,
                result: {
                    ok: true,
                    status: 'event',
                    event: {
                        version: 1,
                        subscriptionId: 'ignored-by-client',
                        kind: 'invalidated',
                        digest: current.result.digest,
                    },
                },
            });
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toEqual([]);
            expect(latest?.dismissedActivityIds.has(dismissedIdentity)).toBe(false);
        });

        await act(async () => { tree?.unmount(); });
    });

    it('retains 15 decoded Activity rows and their synthetic cards when one of the bounded 16 changes', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const initialActivities = Array.from({ length: 16 }, (_, index) => ({
            localActivityId: `activity-${index}`,
            title: `Activity ${index}`,
            phase: 'running' as const,
            checklist: [],
            dismissible: false,
            actions: [],
        }));
        let current = response({ version: 1, activities: initialActivities }, `sha256:${'c'.repeat(64)}`);
        let resolveNext: ((value: unknown) => void) | null = null;
        let holdRefreshRead = false;
        let resolveRefreshRead: ((value: typeof current) => void) | null = null;
        transport.read.mockImplementation(async () => {
            if (!holdRefreshRead) return current;
            return await new Promise<typeof current>((resolve) => {
                resolveRefreshRead = resolve;
            });
        });
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: current.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise((resolve) => {
            resolveNext = resolve;
        }));
        transport.close.mockResolvedValue(undefined);

        const transcriptItemsCache = createPluginTranscriptActivityTranscriptItemsCache();
        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        let latestSyntheticRows: ReturnType<typeof appendPluginTranscriptActivityTranscriptItems> = [];
        function Probe() {
            const value = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            latest = value;
            latestSyntheticRows = appendPluginTranscriptActivityTranscriptItems([], {
                sessionId: 'session-a',
                activities: value.activities,
                dismissedActivityIds: value.dismissedActivityIds,
                isActionAvailable: () => true,
                cache: transcriptItemsCache,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(latest?.activities).toHaveLength(16); });
        const initialRowsByIdentity = new Map(latest!.activities.map((activity) => [
            buildPluginTranscriptActivityIdentityKey(activity),
            activity,
        ]));
        const initialSyntheticRowsByIdentity = new Map(latestSyntheticRows.map((row) => [
            row.kind === 'plugin-transcript-activity' ? row.identityKey : row.id,
            row,
        ]));

        current = response({
            version: 1,
            // Successful Resource reads decode fresh JSON objects. Preserve
            // identity at the projection owner rather than depending on a
            // transport-level object reuse accident.
            activities: initialActivities.map((activity, index) => ({
                ...activity,
                title: index === 6 ? 'Only this Activity changed' : activity.title,
            })),
        }, `sha256:${'d'.repeat(64)}`);
        holdRefreshRead = true;
        await vi.waitFor(() => { expect(resolveNext).toBeTypeOf('function'); });
        await act(async () => {
            resolveNext!({
                supported: true,
                result: {
                    ok: true,
                    status: 'event',
                    event: {
                        version: 1,
                        subscriptionId: 'ignored-by-client',
                        kind: 'invalidated',
                        digest: current.result.digest,
                    },
                },
            });
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(resolveRefreshRead).toBeTypeOf('function'); });
        // The Resource owner exposes its LKG as stale while the canonical
        // refresh is pending. Preserve that semantic fact, then ensure the
        // succeeding fresh snapshot can recover the exact current identities
        // rather than treating its own temporary stale wrappers as history.
        await vi.waitFor(() => {
            expect(latest?.activities).toHaveLength(16);
            expect(latest?.activities.every((activity) => activity.freshness === 'stale')).toBe(true);
        });
        holdRefreshRead = false;
        await act(async () => {
            resolveRefreshRead!(current);
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities.find((activity) => activity.localActivityId === 'activity-6')?.title)
                .toBe('Only this Activity changed');
        });

        const changedIdentity = buildPluginTranscriptActivityIdentityKey(
            latest!.activities.find((activity) => activity.localActivityId === 'activity-6')!,
        );
        for (const activity of latest!.activities) {
            const identityKey = buildPluginTranscriptActivityIdentityKey(activity);
            const synthetic = latestSyntheticRows.find((row) => (
                row.kind === 'plugin-transcript-activity' && row.identityKey === identityKey
            ))!;
            if (identityKey === changedIdentity) {
                expect(activity).not.toBe(initialRowsByIdentity.get(identityKey));
                expect(synthetic).not.toBe(initialSyntheticRowsByIdentity.get(identityKey));
            } else {
                expect(activity).toBe(initialRowsByIdentity.get(identityKey));
                expect(synthetic).toBe(initialSyntheticRowsByIdentity.get(identityKey));
            }
        }

        await act(async () => { tree?.unmount(); });
    });

    it('marks malformed fresh snapshots stale, then replaces a profile on a later valid partial omission', async () => {
        let current = response({
            version: 1,
            activities: [
                {
                    localActivityId: 'build',
                    title: 'Build complete',
                    phase: 'succeeded',
                    checklist: [],
                    dismissible: true,
                    actions: [],
                },
                {
                    localActivityId: 'deploy',
                    title: 'Deploying',
                    phase: 'running',
                    checklist: [],
                    dismissible: false,
                    actions: [],
                },
            ],
        }, `sha256:${'c'.repeat(64)}`);
        let resolveNext: ((value: unknown) => void) | null = null;
        transport.read.mockImplementation(async () => current);
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: current.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise((resolve) => {
            resolveNext = resolve;
        }));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe() {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([
                { localActivityId: 'build', freshness: 'current' },
                { localActivityId: 'deploy', freshness: 'current' },
            ]);
        });

        // This is a successful Resource read whose bytes fail only the
        // Activity schema. It must preserve the last valid rows as stale,
        // rather than treating the malformed candidate as current data.
        const previousDigest = current.result.digest;
        current = response({ version: 2, activities: [] }, `sha256:${'d'.repeat(64)}`);
        await vi.waitFor(() => { expect(resolveNext).toBeTypeOf('function'); });
        await act(async () => {
            resolveNext!({
                supported: true,
                result: {
                    ok: true,
                    status: 'event',
                    event: {
                        version: 1,
                        subscriptionId: 'ignored-by-client',
                        kind: 'invalidated',
                        // The old digest is deliberately only a convergence hint:
                        // the generic Resource store keeps the fresh LKG while it
                        // rereads, then receives the malformed fresh candidate.
                        digest: previousDigest,
                    },
                },
            });
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([
                { localActivityId: 'build', freshness: 'stale' },
                { localActivityId: 'deploy', freshness: 'stale' },
            ]);
        });

        // A later valid snapshot is authoritative and replaces the profile,
        // so omission removes only `build`; it cannot leave a stale tombstone.
        current = response({
            version: 1,
            activities: [{
                localActivityId: 'deploy',
                title: 'Deploy complete',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'e'.repeat(64)}`);
        await vi.waitFor(() => { expect(resolveNext).toBeTypeOf('function'); });
        await act(async () => {
            resolveNext!({
                supported: true,
                result: {
                    ok: true,
                    status: 'event',
                    event: {
                        version: 1,
                        subscriptionId: 'ignored-by-client',
                        kind: 'invalidated',
                        digest: current.result.digest,
                    },
                },
            });
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([
                {
                    localActivityId: 'deploy',
                    phase: 'succeeded',
                    freshness: 'current',
                },
            ]);
            expect(latest?.activities).toHaveLength(1);
        });

        await act(async () => { tree?.unmount(); });
    });

    it('shares one same-session Resource observation across Activity profiles that bind the same Resource', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const twoProfiles: PluginUiProjectionModel = Object.freeze({
            ...projection,
            transcriptActivitiesById: Object.freeze({
                ...projection.transcriptActivitiesById,
                'acme.preview/activity-copy': Object.freeze({
                    id: 'acme.preview/activity-copy',
                    pluginId: 'acme.preview',
                    contributionKind: 'transcriptActivity' as const,
                    descriptorId: 'activity-copy',
                    resource: Object.freeze({ pluginId: 'acme.preview', localId: 'live-activity' }),
                    actions: Object.freeze([]),
                }),
            }),
        });
        const current = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Build complete',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'f'.repeat(64)}`);
        transport.read.mockResolvedValue(current);
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: current.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe() {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: twoProfiles,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(latest?.activities).toHaveLength(2); });

        // These profiles differ only in presentation identity. The generic
        // contextual Resource owner must fan out the one same-plugin,
        // same-session observation instead of letting Activity create a store
        // and watch lifecycle per profile.
        expect(transport.open).toHaveBeenCalledTimes(1);
        expect(transport.read).toHaveBeenCalledTimes(1);
        expect(transport.read.mock.calls[0]?.[1]).toMatchObject({
            context: { kind: 'session', sessionId: 'session-a' },
        });

        await act(async () => { tree?.unmount(); });
    });

    it('recovers a first contextual watch establishment failure without clearing the admitted Activity rows', async () => {
        vi.useFakeTimers();
        try {
            transport.read.mockReset();
            transport.open.mockReset();
            transport.next.mockReset();
            transport.close.mockReset();

            let current = response({
                version: 1,
                activities: [{
                    localActivityId: 'build',
                    title: 'Last known good build',
                    phase: 'running',
                    checklist: [],
                    dismissible: false,
                    actions: [],
                }],
            }, `sha256:${'a'.repeat(64)}`);
            let openAttempts = 0;
            transport.read.mockImplementation(async () => current);
            transport.open.mockImplementation(async (_machineId: string, options: Readonly<{
                subscriptionId: string;
            }>) => {
                openAttempts += 1;
                if (openAttempts === 1) return { supported: false, reason: 'error' };
                return {
                    supported: true,
                    result: {
                        ok: true,
                        subscriptionId: options.subscriptionId,
                        digest: current.result.digest,
                    },
                };
            });
            transport.next.mockImplementation(async () => await new Promise(() => {}));
            transport.close.mockResolvedValue(undefined);

            let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
            const renderedTitles: string[][] = [];
            function Probe() {
                const value = usePluginTranscriptActivities({
                    accountLifetime: ACCOUNT_LIFETIME,
                    interactionEnabled: false,
                    machineId: 'machine-1',
                    platform: 'web',
                    pluginUiProjection: projection,
                    serverId: 'server-1',
                    sessionId: 'session-a',
                });
                latest = value;
                React.useLayoutEffect(() => {
                    renderedTitles.push(value.activities.map((activity) => activity.title));
                }, [value.activities]);
                return null;
            }

            let tree: renderer.ReactTestRenderer | null = null;
            await act(async () => {
                tree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
                await Promise.resolve();
                await Promise.resolve();
            });
            await vi.waitFor(() => {
                expect(latest?.activities).toMatchObject([{ title: 'Last known good build' }]);
            });
            expect(transport.open).toHaveBeenCalledTimes(1);

            current = response({
                version: 1,
                activities: [{
                    localActivityId: 'build',
                    title: 'Recovered build',
                    phase: 'succeeded',
                    checklist: [],
                    dismissible: true,
                    actions: [],
                }],
            }, `sha256:${'b'.repeat(64)}`);
            const recoveryStart = renderedTitles.length;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(250);
                await Promise.resolve();
                await Promise.resolve();
            });
            await vi.waitFor(() => {
                expect(latest?.activities).toMatchObject([{ title: 'Recovered build' }]);
            });

            expect(transport.open).toHaveBeenCalledTimes(2);
            expect(renderedTitles.slice(recoveryStart)).not.toContainEqual([]);

            await act(async () => { tree?.unmount(); });
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the provider-local Resource and dismissal owners usable through a StrictMode effect replay', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();
        const current = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Build complete',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'a'.repeat(64)}`);
        transport.read.mockResolvedValue(current);
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: current.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe() {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <React.StrictMode>
                    <ActivityTestProviders><Probe /></ActivityTestProviders>
                </React.StrictMode>,
                { unstable_strictMode: true } as unknown as renderer.TestRendererOptions,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Build complete' }]);
        });

        const identityKey = buildPluginTranscriptActivityIdentityKey(latest!.activities[0]!);
        await act(async () => {
            latest!.onDismissActivity(identityKey);
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.dismissedActivityIds.has(identityKey)).toBe(true);
        });

        await act(async () => { tree?.unmount(); });
    });

    it('creates a fresh Resource owner after a true provider unmount instead of reusing prior LKG', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();

        const initial = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Prior mounted build',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'a'.repeat(64)}`);
        const remounted = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Freshly mounted build',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'b'.repeat(64)}`);
        let readCount = 0;
        let resolveRemountedRead: ((value: ReturnType<typeof response>) => void) | null = null;
        transport.read.mockImplementation(async () => {
            readCount += 1;
            if (readCount === 1) return initial;
            return await new Promise<ReturnType<typeof response>>((resolve) => {
                resolveRemountedRead = resolve;
            });
        });
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: readCount === 0 ? initial.result.digest : remounted.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe() {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }

        let firstTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            firstTree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Prior mounted build' }]);
        });

        await act(async () => { firstTree?.unmount(); });
        latest = null;

        let secondTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            secondTree = renderer.create(<ActivityTestProviders><Probe /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(readCount).toBe(2);
            expect(latest?.activities).toEqual([]);
        });

        await act(async () => {
            resolveRemountedRead!(remounted);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Freshly mounted build' }]);
        });
        expect(transport.open).toHaveBeenCalledTimes(2);

        await act(async () => { secondTree?.unmount(); });
    });

    it('does not retain a contextual Resource LKG after its last transcript consumer unmounts', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();

        const initial = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Retained build',
                phase: 'running',
                checklist: [],
                dismissible: false,
                actions: [],
            }],
        }, `sha256:${'a'.repeat(64)}`);
        const remounted = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Refreshed build',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'b'.repeat(64)}`);
        let readCount = 0;
        let resolveRemountedRead: ((value: ReturnType<typeof response>) => void) | null = null;
        transport.read.mockImplementation(async () => {
            readCount += 1;
            if (readCount === 1) return initial;
            return await new Promise<ReturnType<typeof response>>((resolve) => {
                resolveRemountedRead = resolve;
            });
        });
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: readCount <= 1 ? initial.result.digest : remounted.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe() {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }
        function Harness(props: Readonly<{ mounted: boolean }>) {
            return (
                <ActivityTestProviders>
                    {props.mounted ? <Probe /> : null}
                </ActivityTestProviders>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Harness mounted />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Retained build' }]);
        });

        await act(async () => {
            tree?.update(<Harness mounted={false} />);
        });
        latest = null;
        await vi.waitFor(() => {
            expect(transport.close).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
            tree?.update(<Harness mounted />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(readCount).toBe(2); });
        // Session navigation continuity belongs to the mounted pane, not an
        // app-root Resource registry. A fresh mounted consumer cannot render
        // bytes retained after the prior consumer released the exact store.
        await vi.waitFor(() => {
            expect(latest?.activities).toEqual([]);
        });

        await act(async () => {
            resolveRemountedRead!(remounted);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Refreshed build' }]);
        });
        expect(transport.open).toHaveBeenCalledTimes(2);

        await act(async () => { tree?.unmount(); });
    });

    it('retires Account-A contextual Resource ownership while its provider stays mounted', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();

        const accountA = createAccountLifetime('account-a');
        const accountB = createAccountLifetime('account-b');
        const initial = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Account A build',
                phase: 'running',
                checklist: [],
                dismissible: false,
                actions: [],
            }],
        }, `sha256:${'a'.repeat(64)}`);
        const replacement = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Account B build',
                phase: 'running',
                checklist: [],
                dismissible: false,
                actions: [],
            }],
        }, `sha256:${'b'.repeat(64)}`);
        let readCount = 0;
        let resolveReplacementRead: ((value: ReturnType<typeof response>) => void) | null = null;
        transport.read.mockImplementation(async () => {
            readCount += 1;
            if (readCount === 1) return initial;
            return await new Promise<ReturnType<typeof response>>((resolve) => {
                resolveReplacementRead = resolve;
            });
        });
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: readCount <= 1 ? initial.result.digest : replacement.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latest: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe(props: Readonly<{ accountLifetime: typeof accountA.lifetime }>) {
            latest = usePluginTranscriptActivities({
                accountLifetime: props.accountLifetime,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            return null;
        }
        function Harness(props: Readonly<{ accountLifetime: typeof accountA.lifetime }>) {
            return (
                <ResourceOnlyTestProviders>
                    <Probe accountLifetime={props.accountLifetime} />
                </ResourceOnlyTestProviders>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Harness accountLifetime={accountA.lifetime} />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Account A build' }]);
        });

        // The activity consumer and its one mounted generic Resource store
        // are the only Account-retirement owners. There is no app-root map
        // retaining Account-keyed Resource entries.
        expect(accountA.activeRetirementCount()).toBe(2);

        await act(async () => {
            accountA.retire();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toEqual([]);
            expect(transport.close).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
            tree?.update(<Harness accountLifetime={accountB.lifetime} />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(readCount).toBe(2);
            expect(latest?.activities).toEqual([]);
        });

        await act(async () => {
            resolveReplacementRead!(replacement);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'Account B build' }]);
        });

        await act(async () => { tree?.unmount(); });
    });

    it('does not share one exact Session Resource store across concurrent Account lifetimes', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();

        const accountA = createAccountLifetime('account-a');
        const accountB = createAccountLifetime('account-b');
        const current = response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'Account-isolated build',
                phase: 'running',
                checklist: [],
                dismissible: false,
                actions: [],
            }],
        }, `sha256:${'e'.repeat(64)}`);
        transport.read.mockResolvedValue(current);
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{ subscriptionId: string }>) => ({
            supported: true,
            result: {
                ok: true,
                subscriptionId: options.subscriptionId,
                digest: current.result.digest,
            },
        }));
        transport.next.mockImplementation(async () => await new Promise(() => {}));
        transport.close.mockResolvedValue(undefined);

        let latestA: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        let latestB: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe(props: Readonly<{
            accountLifetime: typeof accountA.lifetime;
            account: 'a' | 'b';
        }>) {
            const value = usePluginTranscriptActivities({
                accountLifetime: props.accountLifetime,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: 'session-a',
            });
            if (props.account === 'a') latestA = value;
            else latestB = value;
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ResourceOnlyTestProviders>
                    <Probe account="a" accountLifetime={accountA.lifetime} />
                    <Probe account="b" accountLifetime={accountB.lifetime} />
                </ResourceOnlyTestProviders>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latestA?.activities).toMatchObject([{ title: 'Account-isolated build' }]);
            expect(latestB?.activities).toMatchObject([{ title: 'Account-isolated build' }]);
        });

        // Account identity is part of the exact mounted binding. Sharing a
        // Session target must never let Account B consume Account A's store,
        // even while both pane trees coexist during a transition.
        expect(transport.open).toHaveBeenCalledTimes(2);
        expect(transport.read).toHaveBeenCalledTimes(2);

        await act(async () => { tree?.unmount(); });
    });

    it('shares one exact Session Resource observation and terminal dismissal across duplicate Session-A mounts while isolating Session B', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();

        const currentBySession = new Map<string, ReturnType<typeof response>>([
            ['session-a', response({
                version: 1,
                activities: [{
                    localActivityId: 'build',
                    title: 'A initial build',
                    phase: 'succeeded',
                    checklist: [],
                    dismissible: true,
                    actions: [],
                }],
            }, `sha256:${'a'.repeat(64)}`)],
            ['session-b', response({
                version: 1,
                activities: [{
                    localActivityId: 'build',
                    title: 'B isolated build',
                    phase: 'succeeded',
                    checklist: [],
                    dismissible: true,
                    actions: [],
                }],
            }, `sha256:${'b'.repeat(64)}`)],
        ]);
        const sessionBySubscriptionId = new Map<string, string>();
        const resolveNextBySession = new Map<string, Array<(value: unknown) => void>>();
        transport.read.mockImplementation(async (_machineId: string, options: Readonly<{
            context?: Readonly<{ kind: string; sessionId: string }>;
        }>) => {
            const sessionId = options.context?.kind === 'session'
                ? options.context.sessionId
                : null;
            if (!sessionId) throw new Error('Expected a host-stamped Session Resource context.');
            return currentBySession.get(sessionId)!;
        });
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{
            subscriptionId: string;
            context?: Readonly<{ kind: string; sessionId: string }>;
        }>) => {
            const sessionId = options.context?.kind === 'session'
                ? options.context.sessionId
                : null;
            if (!sessionId) throw new Error('Expected a host-stamped Session watch context.');
            sessionBySubscriptionId.set(options.subscriptionId, sessionId);
            return {
                supported: true,
                result: {
                    ok: true,
                    subscriptionId: options.subscriptionId,
                    digest: currentBySession.get(sessionId)!.result.digest,
                },
            };
        });
        transport.next.mockImplementation(async (_machineId: string, options: Readonly<{
            subscriptionId: string;
        }>) => await new Promise((resolve) => {
            const sessionId = sessionBySubscriptionId.get(options.subscriptionId);
            if (!sessionId) throw new Error('Expected an opened Session Resource watch.');
            const resolvers = resolveNextBySession.get(sessionId) ?? [];
            resolvers.push(resolve);
            resolveNextBySession.set(sessionId, resolvers);
        }));
        transport.close.mockResolvedValue(undefined);

        let latestAFirst: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        let latestASecond: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        let latestB: ReturnType<typeof usePluginTranscriptActivities> | null = null;
        function Probe(props: Readonly<{ mount: 'a-first' | 'a-second' | 'b'; sessionId: string }>) {
            const value = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: projection,
                serverId: 'server-1',
                sessionId: props.sessionId,
            });
            if (props.mount === 'a-first') latestAFirst = value;
            else if (props.mount === 'a-second') latestASecond = value;
            else latestB = value;
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ActivityTestProviders>
                    <>
                        <Probe mount="a-first" sessionId="session-a" />
                        <Probe mount="a-second" sessionId="session-a" />
                        <Probe mount="b" sessionId="session-b" />
                    </>
                </ActivityTestProviders>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latestAFirst?.activities).toMatchObject([{ title: 'A initial build' }]);
            expect(latestASecond?.activities).toMatchObject([{ title: 'A initial build' }]);
            expect(latestB?.activities).toMatchObject([{ title: 'B isolated build' }]);
        });

        // Two consumers of the exact same Session-A binding must share the generic Resource
        // store/watch. Session B remains a distinct binding and therefore gets its own pair.
        expect(transport.open).toHaveBeenCalledTimes(2);
        expect(transport.read).toHaveBeenCalledTimes(2);

        currentBySession.set('session-a', response({
            version: 1,
            activities: [{
                localActivityId: 'build',
                title: 'A updated build',
                phase: 'succeeded',
                checklist: [],
                dismissible: true,
                actions: [],
            }],
        }, `sha256:${'c'.repeat(64)}`));
        await vi.waitFor(() => {
            expect(resolveNextBySession.get('session-a')).toHaveLength(1);
        });
        await act(async () => {
            resolveNextBySession.get('session-a')![0]!({
                supported: true,
                result: {
                    ok: true,
                    status: 'event',
                    event: {
                        version: 1,
                        subscriptionId: 'ignored-by-client',
                        kind: 'invalidated',
                        digest: currentBySession.get('session-a')!.result.digest,
                    },
                },
            });
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latestAFirst?.activities).toMatchObject([{ title: 'A updated build' }]);
            expect(latestASecond?.activities).toMatchObject([{ title: 'A updated build' }]);
            expect(latestB?.activities).toMatchObject([{ title: 'B isolated build' }]);
        });

        const identityKey = buildPluginTranscriptActivityIdentityKey(latestAFirst!.activities[0]!);
        await act(async () => {
            latestAFirst!.onDismissActivity(identityKey);
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latestAFirst?.dismissedActivityIds.has(identityKey)).toBe(true);
            expect(latestASecond?.dismissedActivityIds.has(identityKey)).toBe(true);
            expect(latestB?.dismissedActivityIds.has(identityKey)).toBe(false);
        });

        await act(async () => { tree?.unmount(); });
    });

    it('retains a terminal dismissal through Session A → B → A after Session A has zero consumers', async () => {
        transport.read.mockReset();
        transport.open.mockReset();
        transport.next.mockReset();
        transport.close.mockReset();

        const currentBySession = new Map<string, ReturnType<typeof response>>([
            ['session-a', response({
                version: 1,
                activities: [{
                    localActivityId: 'build',
                    title: 'A completed build',
                    phase: 'succeeded',
                    checklist: [],
                    dismissible: true,
                    actions: [],
                }],
            }, `sha256:${'a'.repeat(64)}`)],
            ['session-b', response({
                version: 1,
                activities: [{
                    localActivityId: 'build',
                    title: 'B completed build',
                    phase: 'succeeded',
                    checklist: [],
                    dismissible: true,
                    actions: [],
                }],
            }, `sha256:${'b'.repeat(64)}`)],
        ]);
        transport.read.mockImplementation(async (_machineId: string, options: Readonly<{
            context?: Readonly<{ kind: string; sessionId: string }>;
        }>) => {
            const sessionId = options.context?.kind === 'session' ? options.context.sessionId : null;
            if (!sessionId) throw new Error('Expected a host-stamped Session Resource context.');
            return currentBySession.get(sessionId)!;
        });
        transport.open.mockImplementation(async (_machineId: string, options: Readonly<{
            subscriptionId: string;
        }>) => ({
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
        function Probe(props: Readonly<{
            sessionId: string;
            projectionModel?: PluginUiProjectionModel;
            sessionRemoved?: boolean;
        }>) {
            latest = usePluginTranscriptActivities({
                accountLifetime: ACCOUNT_LIFETIME,
                interactionEnabled: false,
                machineId: 'machine-1',
                platform: 'web',
                pluginUiProjection: props.projectionModel ?? projection,
                serverId: 'server-1',
                sessionId: props.sessionId,
                sessionRemoved: props.sessionRemoved,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityTestProviders><Probe sessionId="session-a" /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'A completed build' }]);
        });
        const sessionAIdentity = buildPluginTranscriptActivityIdentityKey(latest!.activities[0]!);
        await act(async () => {
            latest!.onDismissActivity(sessionAIdentity);
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.dismissedActivityIds.has(sessionAIdentity)).toBe(true);
        });

        await act(async () => {
            tree?.update(<ActivityTestProviders><Probe sessionId="session-b" /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'B completed build' }]);
        });

        await act(async () => {
            tree?.update(<ActivityTestProviders><Probe sessionId="session-a" /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'A completed build' }]);
            expect(latest?.dismissedActivityIds.has(sessionAIdentity)).toBe(true);
        });

        // Replacing a contributor generation retires its old local dismissal;
        // returning to the former generation must not resurrect a stale card
        // decision from that retired source.
        const replacementGeneration = Object.freeze({ ...projection, generation: 8 });
        await act(async () => {
            tree?.update(
                <ActivityTestProviders>
                    <Probe sessionId="session-a" projectionModel={replacementGeneration} />
                </ActivityTestProviders>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'A completed build' }]);
            expect(latest?.dismissedActivityIds.has(sessionAIdentity)).toBe(false);
        });
        await act(async () => {
            tree?.update(<ActivityTestProviders><Probe sessionId="session-a" /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.dismissedActivityIds.has(sessionAIdentity)).toBe(false);
        });

        // This is the permanent Session-removal fact, distinct from the A → B
        // route replacement above. Its lease retirement clears the exact
        // presentation entry before a restored Session can acquire it again.
        await act(async () => {
            tree?.update(
                <ActivityTestProviders><Probe sessionId="session-a" sessionRemoved /></ActivityTestProviders>,
            );
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(latest?.dismissedActivityIds.has(sessionAIdentity)).toBe(false); });
        await act(async () => {
            tree?.update(<ActivityTestProviders><Probe sessionId="session-a" /></ActivityTestProviders>);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(latest?.activities).toMatchObject([{ title: 'A completed build' }]);
            expect(latest?.dismissedActivityIds.has(sessionAIdentity)).toBe(false);
        });

        await act(async () => { tree?.unmount(); });
    });
});
