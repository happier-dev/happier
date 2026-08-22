import { describe, expect, it, vi } from 'vitest';

import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
    NotificationPreferences as PluginNotificationPreferences,
} from '@happier-dev/plugin-sdk/notifications';

import type {
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
} from '@/plugins/projection/registry/types';

import {
    createStablePluginNotificationsOwner,
    createStablePluginNotificationsService,
    PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS,
    type PluginNotificationSenderBinding,
} from './notifications';

type PluginNotificationSendResult = Awaited<
    ReturnType<Parameters<PluginApi['notifications']['registerChannel']>[1]>
>;
type PluginNotificationSendRequest = Parameters<
    Parameters<PluginApi['notifications']['registerChannel']>[1]
>[0];

const category: ResolvedNotificationCategoryContribution = Object.freeze({
    provenance: 'external',
    source: Object.freeze({ kind: 'path' }),
    pluginId: 'acme.notifications',
    definition: Object.freeze({
        id: 'review-ready',
        kind: 'plugin',
        title: 'Review ready',
        description: 'A review is ready',
        eventIds: ['review-ready-event'],
        defaultChannels: [
            'configured',
            Object.freeze({ pluginId: 'acme.delivery', localId: 'external' }),
        ],
    }),
});

const channels: readonly ResolvedNotificationChannelContribution[] = Object.freeze([
    Object.freeze({
        provenance: 'external', source: Object.freeze({ kind: 'path' }), pluginId: 'acme.notifications',
        definition: Object.freeze({ id: 'configured', kind: 'plugin', title: 'Configured', configurable: true, defaultEnabled: true }),
    }),
    Object.freeze({
        provenance: 'external', source: Object.freeze({ kind: 'path' }), pluginId: 'acme.delivery',
        definition: Object.freeze({ id: 'external', kind: 'plugin', title: 'External', configurable: true, defaultEnabled: false }),
    }),
]);

const seed = Object.freeze({
    plugin: Object.freeze({ id: 'acme.notifications', version: '1.0.0' }),
    contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.notifications/actions/run' }),
    generation: '7',
    correlationId: 'correlation-1',
    surface: 'cli' as const,
    signal: new AbortController().signal,
    isGenerationCurrent: () => true,
});

describe('stable plugin notifications service', () => {
    it('demands the exact qualified channel, re-reads its generation, and replays stable per-channel results', async () => {
        const demands: string[] = [];
        let binding: PluginNotificationSenderBinding | null = null;
        const sender = vi.fn(async (request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => Object.freeze({
            deliveryId: request.deliveryId,
            channelId: request.channelId,
            status: 'accepted' as const,
            evidence: 'provider' as const,
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels,
            async activateChannel(ref) {
                demands.push(`${ref.pluginId}/notificationChannels/${ref.localId}`);
                binding = Object.freeze({ generation: '7', isCurrent: () => true, send: sender });
            },
            readChannel: () => binding,
            now: () => 1_000,
        });

        const request = Object.freeze({
            clientRequestId: 'request-1',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: Object.freeze(['configured']),
            data: Object.freeze({ sessionId: 'session-1' }),
        });
        const first = await service.send(request);
        const replay = await service.send(request);

        expect(demands).toEqual(['acme.notifications/notificationChannels/configured']);
        expect(sender).toHaveBeenCalledTimes(1);
        expect(first).toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                channelId: 'acme.notifications/configured',
                status: 'accepted',
                evidence: 'provider',
            })],
        });
        expect(replay).toEqual({ ...first, replayed: true });
    });

    it('reports declared channel availability and keeps suppression distinct from acceptance', async () => {
        const demands: string[] = [];
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels,
            activateChannel: async (ref) => {
                demands.push(`${ref.pluginId}/notificationChannels/${ref.localId}`);
            },
            readChannel: () => null,
            now: () => 1_000,
        });

        await expect(service.listCategories()).resolves.toEqual({
            items: [{
                id: 'review-ready',
                title: 'Review ready',
                description: 'A review is ready',
                defaultChannelIds: ['acme.notifications/configured', 'acme.delivery/external'],
            }],
        });
        await expect(service.listChannels()).resolves.toEqual({
            items: [
                { id: 'acme.delivery/external', title: 'External', state: 'unavailable', code: 'plugin_notification_channel_disabled' },
                { id: 'acme.notifications/configured', title: 'Configured', state: 'unavailable', code: 'plugin_notification_channel_unavailable' },
            ],
        });
        expect(demands).toEqual(['acme.notifications/notificationChannels/configured']);
        await expect(service.send({
            clientRequestId: 'request-2', categoryId: 'review-ready', title: 'Review ready',
        })).resolves.toEqual({
            replayed: false,
            deliveries: [
                expect.objectContaining({ channelId: 'acme.notifications/configured', status: 'failed', code: 'plugin_notification_channel_unavailable' }),
                expect.objectContaining({ channelId: 'acme.delivery/external', status: 'suppressed', code: 'plugin_notification_channel_disabled' }),
            ],
        });
        expect(() => service.watchPreferences('review-ready', () => undefined))
            .toThrow(expect.objectContaining({ code: 'plugin_notification_preferences_watch_unavailable' }));
    });

    it('binds retained category declarations without replacing the shared notification owner', async () => {
        const currentCategory: ResolvedNotificationCategoryContribution =
            Object.freeze({
                ...category,
                definition: Object.freeze({
                    ...category.definition,
                    id: 'current-only',
                    title: 'Current only',
                }),
            });
        const owner = createStablePluginNotificationsOwner({
            categories: [currentCategory],
            channels,
            activateChannel: async () => undefined,
            readChannel: () => null,
        });
        const retained = owner.bind(seed, {
            categories: [Object.freeze({
                pluginId: category.pluginId,
                definition: category.definition,
            })],
        });

        await expect(retained.listCategories()).resolves.toEqual({
            items: [{
                id: 'review-ready',
                title: 'Review ready',
                description: 'A review is ready',
                defaultChannelIds: [
                    'acme.notifications/configured',
                    'acme.delivery/external',
                ],
            }],
        });
    });

    it('fails closed on category and channel availability before activation or sender dispatch', async () => {
        const unavailableCategory = Object.freeze({
            ...category,
            definition: Object.freeze({
                ...category.definition,
                id: 'session-only',
                availability: Object.freeze({
                    when: Object.freeze({ fact: 'session.exists', operator: 'equals' as const, value: true }),
                }),
            }),
        }) satisfies ResolvedNotificationCategoryContribution;
        const disabledChannel = Object.freeze({
            ...channels[0]!,
            definition: Object.freeze({
                ...channels[0]!.definition,
                availability: Object.freeze({
                    disabledWhen: Object.freeze({ fact: 'plugin.enabled', operator: 'equals' as const, value: true }),
                    disabledReason: 'Notification channel disabled by policy',
                }),
            }),
        }) satisfies ResolvedNotificationChannelContribution;
        const unknownChannel = Object.freeze({
            ...channels[1]!,
            pluginId: 'acme.notifications',
            definition: Object.freeze({
                ...channels[1]!.definition,
                id: 'feature-channel',
                defaultEnabled: true,
                availability: Object.freeze({
                    when: Object.freeze({ fact: 'host.feature', operator: 'enabled' as const, value: 'notifications' }),
                }),
            }),
        }) satisfies ResolvedNotificationChannelContribution;
        const sender = vi.fn();
        const activateChannel = vi.fn(async () => undefined);
        const service = createStablePluginNotificationsService(seed, {
            categories: [category, unavailableCategory],
            channels: [disabledChannel, unknownChannel],
            activateChannel,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            now: () => 1_000,
        });

        await expect(service.listCategories()).resolves.toEqual({
            items: [expect.objectContaining({ id: 'review-ready' })],
        });
        await expect(service.preferences('session-only'))
            .rejects.toMatchObject({ code: 'plugin_contribution_not_applicable' });
        await expect(service.listChannels()).resolves.toEqual({
            items: [
                expect.objectContaining({
                    id: 'acme.notifications/configured',
                    state: 'unavailable',
                    code: 'plugin_contribution_disabled',
                }),
                expect.objectContaining({
                    id: 'acme.notifications/feature-channel',
                    state: 'unavailable',
                    code: 'plugin_contribution_policy_fact_unavailable',
                }),
            ],
        });
        await expect(service.send({
            clientRequestId: 'request-policy-availability',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured', 'feature-channel'],
        })).resolves.toEqual({
            replayed: false,
            deliveries: [
                expect.objectContaining({
                    channelId: 'acme.notifications/configured',
                    status: 'suppressed',
                    code: 'plugin_contribution_disabled',
                }),
                expect.objectContaining({
                    channelId: 'acme.notifications/feature-channel',
                    status: 'failed',
                    code: 'plugin_contribution_policy_fact_unavailable',
                    retryable: false,
                }),
            ],
        });
        expect(activateChannel).not.toHaveBeenCalled();
        expect(sender).not.toHaveBeenCalled();
    });

    it('routes default delivery through the host-owned user preference policy and publishes preference changes', async () => {
        const sender = vi.fn(async (request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => ({
            deliveryId: request.deliveryId,
            channelId: request.channelId,
            status: 'accepted',
            evidence: 'provider',
        }));
        let configuredEnabled = false;
        let revision = 'settings-1';
        let publishChange: (() => void) | undefined;
        const disposePreferenceWatch = vi.fn();
        const service = createStablePluginNotificationsService(seed, {
            categories: [category],
            channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            preferencePolicy: {
                read(params) {
                    return Object.freeze({
                        enabled: params.channelId !== 'acme.notifications/configured' || configuredEnabled,
                        revision,
                    });
                },
                watch(params) {
                    publishChange = params.listener;
                    return Object.freeze({ dispose: disposePreferenceWatch });
                },
            },
            now: () => 1_000,
        });

        await expect(service.preferences('review-ready')).resolves.toEqual({
            categoryId: 'review-ready',
            enabled: false,
            channelIds: [],
            revision: expect.any(String),
        });
        await expect(service.send({
            clientRequestId: 'request-policy-suppressed',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured'],
        })).resolves.toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                channelId: 'acme.notifications/configured',
                status: 'suppressed',
                code: 'plugin_notification_channel_disabled',
            })],
        });
        expect(sender).not.toHaveBeenCalled();

        const listener = vi.fn();
        const watch = service.watchPreferences('review-ready', listener);
        configuredEnabled = true;
        revision = 'settings-2';
        publishChange?.();
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({
            categoryId: 'review-ready',
            enabled: true,
            channelIds: ['acme.notifications/configured'],
        }));
        watch.dispose();
        expect(disposePreferenceWatch).toHaveBeenCalledTimes(1);
    });

    it('awaits terminal channel currentness before invoking the registered sender', async () => {
        const sender = vi.fn(async (request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => ({
            deliveryId: request.deliveryId,
            channelId: request.channelId,
            status: 'accepted',
            evidence: 'provider',
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({
                generation: '7',
                isCurrent: async () => false,
                send: sender,
            }),
            now: () => 1_000,
        });

        await expect(service.send({
            clientRequestId: 'request-stale-channel',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured'],
        })).resolves.toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                channelId: 'acme.notifications/configured',
                status: 'failed',
                code: 'plugin_notification_channel_unavailable',
            })],
        });
        expect(sender).not.toHaveBeenCalled();
    });

    it('reports an unknown outcome when the registered sender retires during delivery', async () => {
        let current = true;
        const sender = vi.fn(async (request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => {
            current = false;
            return {
                deliveryId: request.deliveryId,
                channelId: request.channelId,
                status: 'accepted',
                evidence: 'provider',
            };
        });
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({
                generation: '7',
                isCurrent: async () => current,
                send: sender,
            }),
            now: () => 1_000,
        });

        await expect(service.send({
            clientRequestId: 'request-retires-during-send',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured'],
        })).resolves.toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                status: 'outcomeUnknown',
                code: 'plugin_notification_outcome_unknown',
            })],
        });
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('settles an unresponsive sender on generation retirement, then expires its terminal evidence', async () => {
        let now = 1_000;
        const retiredGeneration = new AbortController();
        const currentGeneration = new AbortController();
        let resolveLateSuccess: ((result: PluginNotificationSendResult) => void) | undefined;
        let rejectLateFailure: ((error: Error) => void) | undefined;
        const startedUnresponsiveRequestIds = new Set<string>();
        const sender = vi.fn((request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => {
            if (
                request.clientRequestId === 'request-late-success'
                && !startedUnresponsiveRequestIds.has(request.clientRequestId)
            ) {
                startedUnresponsiveRequestIds.add(request.clientRequestId);
                return new Promise<PluginNotificationSendResult>((resolve) => {
                    resolveLateSuccess = resolve;
                });
            }
            if (
                request.clientRequestId === 'request-late-failure'
                && !startedUnresponsiveRequestIds.has(request.clientRequestId)
            ) {
                startedUnresponsiveRequestIds.add(request.clientRequestId);
                return new Promise<PluginNotificationSendResult>((_resolve, reject) => {
                    rejectLateFailure = reject;
                });
            }
            return Promise.resolve(Object.freeze({
                deliveryId: request.deliveryId,
                channelId: request.channelId,
                status: 'accepted',
                evidence: 'provider',
            }));
        });
        const owner = createStablePluginNotificationsOwner({
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: (_ref, callerSeed) => Object.freeze({
                generation: callerSeed.generation,
                isCurrent: () => !callerSeed.signal.aborted,
                send: sender,
            }),
            now: () => now,
        });
        const request = (clientRequestId: string) => Object.freeze({
            clientRequestId,
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured'],
        });
        const retiredService = owner.bind(Object.freeze({
            ...seed,
            signal: retiredGeneration.signal,
            isGenerationCurrent: () => !retiredGeneration.signal.aborted,
        }));

        const pendingSuccess = retiredService.send(request('request-late-success'));
        const pendingFailure = retiredService.send(request('request-late-failure'));
        await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(2));
        retiredGeneration.abort();
        const didNotSettle = Symbol('did-not-settle');
        const retiredResults = await Promise.race([
            Promise.all([pendingSuccess, pendingFailure]),
            new Promise<typeof didNotSettle>((resolve) => setImmediate(() => resolve(didNotSettle))),
        ]);
        expect(retiredResults).not.toBe(didNotSettle);
        expect(retiredResults).toEqual([
            {
                replayed: false,
                deliveries: [expect.objectContaining({
                    status: 'outcomeUnknown',
                    code: 'plugin_notification_outcome_unknown',
                })],
            },
            {
                replayed: false,
                deliveries: [expect.objectContaining({
                    status: 'outcomeUnknown',
                    code: 'plugin_notification_outcome_unknown',
                })],
            },
        ]);

        const unhandledRejections: unknown[] = [];
        const captureUnhandledRejection = (error: unknown) => {
            unhandledRejections.push(error);
        };
        process.prependListener('unhandledRejection', captureUnhandledRejection);
        try {
            const [successRequest] = sender.mock.calls.find(([candidate]) => (
                candidate.clientRequestId === 'request-late-success'
            )) ?? [];
            expect(successRequest).toBeDefined();
            resolveLateSuccess?.(Object.freeze({
                deliveryId: successRequest!.deliveryId,
                channelId: successRequest!.channelId,
                status: 'accepted',
                evidence: 'provider',
            }));
            rejectLateFailure?.(new Error('late provider failure'));
            await new Promise<void>((resolve) => setImmediate(resolve));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(unhandledRejections).toEqual([]);
        } finally {
            process.removeListener('unhandledRejection', captureUnhandledRejection);
        }

        const currentService = owner.bind(Object.freeze({
            ...seed,
            generation: '8',
            signal: currentGeneration.signal,
            isGenerationCurrent: () => !currentGeneration.signal.aborted,
        }));
        for (const clientRequestId of ['request-late-success', 'request-late-failure']) {
            await expect(currentService.send(request(clientRequestId))).resolves.toEqual({
                replayed: true,
                deliveries: [expect.objectContaining({
                    status: 'outcomeUnknown',
                    code: 'plugin_notification_outcome_unknown',
                })],
            });
        }
        expect(sender).toHaveBeenCalledTimes(2);

        now += PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS;
        for (const clientRequestId of ['request-late-success', 'request-late-failure']) {
            await expect(currentService.send(request(clientRequestId))).resolves.toEqual({
                replayed: false,
                deliveries: [expect.objectContaining({
                    status: 'accepted',
                    evidence: 'provider',
                })],
            });
        }
        expect(sender).toHaveBeenCalledTimes(4);
    });

    it('owns a real preference watch with the caller generation and fences late publication', () => {
        const generation = new AbortController();
        const generationSeed = Object.freeze({ ...seed, signal: generation.signal });
        const disposeHostWatch = vi.fn();
        let publish: ((preferences: PluginNotificationPreferences) => void) | undefined;
        const service = createStablePluginNotificationsService(generationSeed, {
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => null,
            watchPreferences(params) {
                expect(params).toMatchObject({
                    pluginId: 'acme.notifications',
                    contributionId: 'acme.notifications/actions/run',
                    generation: '7',
                    categoryId: 'review-ready',
                });
                publish = params.listener;
                return Object.freeze({ dispose: disposeHostWatch });
            },
            now: () => 1_000,
        });
        const listener = vi.fn();
        const watch = service.watchPreferences('review-ready', listener);
        const first = Object.freeze({
            categoryId: 'review-ready', enabled: true, channelIds: Object.freeze(['acme.notifications/configured']), revision: '1',
        });
        publish?.(first);
        expect(listener).toHaveBeenCalledWith(first);

        generation.abort();
        expect(disposeHostWatch).toHaveBeenCalledTimes(1);
        publish?.(Object.freeze({ ...first, revision: '2' }));
        expect(listener).toHaveBeenCalledTimes(1);
        watch.dispose();
        expect(disposeHostWatch).toHaveBeenCalledTimes(1);
    });

    it('rejects undeclared, conflicting, oversized, and retired-generation operations before unsafe delivery', async () => {
        let current = true;
        const sender = vi.fn(async (request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => {
            current = false;
            return Object.freeze({
                deliveryId: request.deliveryId,
                channelId: request.channelId,
                status: 'accepted' as const,
                evidence: 'hostAdapter' as const,
            });
        });
        const retiredSeed = Object.freeze({ ...seed, isGenerationCurrent: () => current });
        const service = createStablePluginNotificationsService(retiredSeed, {
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            now: () => 1_000,
        });

        await expect(service.send({
            clientRequestId: 'request-3', categoryId: 'review-ready', title: 'Review ready', channelIds: ['configured'],
        })).resolves.toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                status: 'outcomeUnknown', code: 'plugin_notification_outcome_unknown',
            })],
        });
        current = true;
        await expect(service.send({
            clientRequestId: 'request-3', categoryId: 'review-ready', title: 'Different', channelIds: ['configured'],
        })).rejects.toMatchObject({ code: 'plugin_notification_request_conflict' });
        await expect(service.send({
            clientRequestId: 'request-4', categoryId: 'missing', title: 'Missing',
        })).rejects.toMatchObject({ code: 'plugin_notification_category_undeclared' });
        await expect(service.send({
            clientRequestId: 'request-5', categoryId: 'review-ready', title: 'x'.repeat(513),
        })).rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        await expect(service.send({
            clientRequestId: 'request-invalid-channel', categoryId: 'review-ready', title: 'Review ready',
            channelIds: ['INVALID'],
        })).rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        const accessorRequest = Object.defineProperty({
            clientRequestId: 'request-6', categoryId: 'review-ready',
        }, 'title', {
            enumerable: true,
            get() { throw new Error('must not invoke author accessors'); },
        });
        await expect(service.send(accessorRequest as Parameters<typeof service.send>[0]))
            .rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        let channelAccessorReads = 0;
        const accessorChannels = Object.defineProperty(['configured'], '0', {
            enumerable: true,
            get() {
                channelAccessorReads += 1;
                return 'configured';
            },
        });
        await expect(service.send({
            clientRequestId: 'request-accessor-channel', categoryId: 'review-ready', title: 'Review ready',
            channelIds: accessorChannels,
        })).rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        expect(channelAccessorReads).toBe(0);
        const proxyRequest = new Proxy({
            clientRequestId: 'request-proxy', categoryId: 'review-ready', title: 'Review ready',
        }, {
            ownKeys() { throw new Error('must not escape author proxy traps'); },
        });
        await expect(service.send(proxyRequest))
            .rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('deduplicates manifest defaults and treats accessor-backed sender results as unknown without invoking them', async () => {
        let accessorReads = 0;
        const duplicateDefaults: ResolvedNotificationCategoryContribution = Object.freeze({
            ...category,
            definition: Object.freeze({
                ...category.definition,
                defaultChannels: ['configured', 'configured'],
            }),
        });
        const sender = vi.fn(async (request: PluginNotificationSendRequest) => Object.defineProperty({
            deliveryId: request.deliveryId,
            channelId: request.channelId,
        }, 'status', {
            enumerable: true,
            get() {
                accessorReads += 1;
                return 'accepted';
            },
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [duplicateDefaults], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            now: () => 1_000,
        });

        await expect(service.listCategories()).resolves.toEqual({
            items: [expect.objectContaining({
                id: 'review-ready',
                defaultChannelIds: ['acme.notifications/configured'],
            })],
        });
        await expect(service.send({
            clientRequestId: 'request-7', categoryId: 'review-ready', title: 'Review ready',
        })).resolves.toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                channelId: 'acme.notifications/configured',
                status: 'outcomeUnknown',
                code: 'plugin_notification_outcome_unknown',
            })],
        });
        expect(sender).toHaveBeenCalledTimes(1);
        expect(accessorReads).toBe(0);
    });

    it('resolves a declared local channel id containing a slash before treating it as a qualified id', async () => {
        const slashChannel: ResolvedNotificationChannelContribution = Object.freeze({
            provenance: 'external', source: Object.freeze({ kind: 'path' }), pluginId: 'acme.notifications',
            definition: Object.freeze({
                id: 'configured/webhook', kind: 'webhook', title: 'Configured webhook', configurable: true, defaultEnabled: true,
            }),
        });
        const sender = vi.fn(async (request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => ({
            deliveryId: request.deliveryId,
            channelId: request.channelId,
            status: 'accepted',
            evidence: 'provider',
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [Object.freeze({
                ...category,
                definition: Object.freeze({ ...category.definition, defaultChannels: [] }),
            })],
            channels: [slashChannel],
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            now: () => 1_000,
        });

        await expect(service.send({
            clientRequestId: 'request-slash-channel',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured/webhook'],
        })).resolves.toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                channelId: 'acme.notifications/configured/webhook',
                status: 'accepted',
            })],
        });
        await expect(service.send({
            clientRequestId: 'request-qualified-channel',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['acme.notifications/configured/webhook'],
        })).resolves.toMatchObject({
            replayed: false,
            deliveries: [expect.objectContaining({
                channelId: 'acme.notifications/configured/webhook',
                status: 'accepted',
            })],
        });
        expect(sender).toHaveBeenCalledTimes(2);
    });

    it('isolates the daemon idempotency namespace between contributions owned by the same plugin', async () => {
        const sender = vi.fn(async (request: PluginNotificationSendRequest): Promise<PluginNotificationSendResult> => ({
            deliveryId: request.deliveryId,
            channelId: request.channelId,
            status: 'accepted',
            evidence: 'provider',
        }));
        const owner = createStablePluginNotificationsOwner({
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            now: () => 1_000,
        });
        const first = owner.bind(seed);
        const second = owner.bind(Object.freeze({
            ...seed,
            contribution: Object.freeze({ id: 'other', qualifiedId: 'acme.notifications/actions/other' }),
        }));
        const request = Object.freeze({
            clientRequestId: 'request-8', categoryId: 'review-ready', title: 'Review ready', channelIds: ['configured'],
        });

        await expect(first.send(request)).resolves.toMatchObject({ replayed: false });
        await expect(second.send(request)).resolves.toMatchObject({ replayed: false });
        expect(sender).toHaveBeenCalledTimes(2);
    });

    it('settles the canonical operation as unknown when its caller aborts a non-cooperative sender', async () => {
        let resolveSender: ((result: PluginNotificationSendResult) => void) | undefined;
        const sender = vi.fn((request: PluginNotificationSendRequest) => new Promise<PluginNotificationSendResult>((resolve) => {
            resolveSender = resolve;
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            now: () => 1_000,
        });
        const request = Object.freeze({
            clientRequestId: 'request-9', categoryId: 'review-ready', title: 'Review ready', channelIds: ['configured'],
        });
        const controller = new AbortController();
        const firstCaller = service.send(request, { signal: controller.signal });
        await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
        const joinedCaller = service.send(request);
        const senderRequest = sender.mock.calls[0]?.[0];
        expect(senderRequest).toBeDefined();

        controller.abort();

        await expect(firstCaller).rejects.toMatchObject({
            code: 'plugin_notification_wait_aborted',
            details: { operationIdBound: true },
        });
        await expect(joinedCaller).resolves.toEqual({
            replayed: true,
            deliveries: [expect.objectContaining({
                status: 'outcomeUnknown',
                code: 'plugin_notification_outcome_unknown',
            })],
        });
        resolveSender?.(Object.freeze({
            deliveryId: senderRequest!.deliveryId,
            channelId: senderRequest!.channelId,
            status: 'accepted',
            evidence: 'provider',
        }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(service.send(request)).resolves.toEqual({
            replayed: true,
            deliveries: [expect.objectContaining({
                status: 'outcomeUnknown',
                code: 'plugin_notification_outcome_unknown',
            })],
        });
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('keeps an in-flight operation bound after the settled-result retention window', async () => {
        let now = 1_000;
        const pending: Array<Readonly<{
            request: PluginNotificationSendRequest;
            resolve(result: PluginNotificationSendResult): void;
        }>> = [];
        const sender = vi.fn((request: PluginNotificationSendRequest) => new Promise<PluginNotificationSendResult>((resolve) => {
            pending.push(Object.freeze({ request, resolve }));
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ generation: '7', isCurrent: () => true, send: sender }),
            now: () => now,
        });
        const request = Object.freeze({
            clientRequestId: 'request-pending-retention',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured'],
        });

        const first = service.send(request);
        await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
        now += PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS;
        const joined = service.send(request);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const dispatchCount = sender.mock.calls.length;
        for (const operation of pending) {
            operation.resolve(Object.freeze({
                deliveryId: operation.request.deliveryId,
                channelId: operation.request.channelId,
                status: 'accepted',
                evidence: 'provider',
            }));
        }

        await expect(first).resolves.toMatchObject({ replayed: false });
        await expect(joined).resolves.toMatchObject({ replayed: true });
        expect(dispatchCount).toBe(1);
    });

    it('rejects exact capacity plus one before delivery with the earliest retry delay, then admits after expiry', async () => {
        let now = 1_000;
        const categoryWithoutDefaults: ResolvedNotificationCategoryContribution = Object.freeze({
            ...category,
            definition: Object.freeze({ ...category.definition, defaultChannels: [] }),
        });
        const service = createStablePluginNotificationsService(seed, {
            categories: [categoryWithoutDefaults], channels: [],
            activateChannel: async () => undefined,
            readChannel: () => null,
            now: () => now,
        });

        for (let index = 0; index < 16_384; index += 1) {
            await service.send({
                clientRequestId: `capacity-${index}`,
                categoryId: 'review-ready',
                title: 'Review ready',
            });
        }
        await expect(service.send({
            clientRequestId: 'capacity-over',
            categoryId: 'review-ready',
            title: 'Review ready',
        })).rejects.toMatchObject({
            code: 'plugin_notification_capacity_unavailable',
            details: { retryAfterMs: PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS },
        });

        now += PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS;
        await expect(service.send({
            clientRequestId: 'capacity-after-expiry',
            categoryId: 'review-ready',
            title: 'Review ready',
        })).resolves.toMatchObject({ replayed: false, deliveries: [] });
    }, 30_000);
});
