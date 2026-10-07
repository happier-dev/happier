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
    occurrenceId: '7',
    correlationId: 'correlation-1',
    surface: 'cli' as const,
    signal: new AbortController().signal,
    isOccurrenceCurrent: () => true,
});

describe('stable plugin notifications service', () => {
    it('discovers current host channels and delivers without claiming a plugin category or caller', async () => {
        const requests: PluginNotificationSendRequest[] = [];
        const activated: string[] = [];
        let binding: PluginNotificationSenderBinding | null = null;
        const owner = createStablePluginNotificationsOwner({
            categories: [], channels,
            async activateChannel(ref) {
                activated.push(`${ref.pluginId}/${ref.localId}`);
                binding = Object.freeze({
                    occurrenceId: 'channel-occurrence',
                    isCurrent: () => true,
                    async send(request) {
                        requests.push(request);
                        return {
                            deliveryId: request.deliveryId,
                            channelId: request.channelId,
                            status: 'accepted',
                            evidence: 'provider',
                        };
                    },
                });
            },
            readChannel: (_ref, callerSeed) => {
                expect(callerSeed).toBeUndefined();
                return binding;
            },
        });

        await expect(owner.availableHostChannels()).resolves.toEqual([
            { value: 'acme.notifications/configured', label: 'Configured (acme.notifications)', kind: 'plugin' },
        ]);
        expect(activated).toEqual([]);
        await expect(owner.sendHostNotification({
            channelId: 'acme.notifications/configured', title: 'Ready', body: 'Review the result',
            data: { runId: 'run-1' },
        })).resolves.toBe(true);
        expect(requests).toEqual([expect.objectContaining({
            channelId: 'acme.notifications/configured', title: 'Ready', body: 'Review the result',
            data: { runId: 'run-1' },
        })]);
        expect(requests[0]).not.toHaveProperty('categoryId');
        expect(activated).toEqual(['acme.notifications/configured']);
        await expect(owner.sendHostNotification({
            channelId: 'acme.delivery/external', title: 'Disabled',
        })).resolves.toBe(false);
        await expect(owner.sendHostNotification({
            channelId: 'unqualified', title: 'Unknown',
        })).resolves.toBe(false);
        expect(requests).toHaveLength(1);
    });

    it('keeps host discovery and sending behind manifest policy and the current sender occurrence', async () => {
        let current = true;
        const requests: PluginNotificationSendRequest[] = [];
        const owner = createStablePluginNotificationsOwner({
            categories: [],
            channels: [channels[0]!, {
                ...channels[0]!,
                definition: {
                    ...channels[0]!.definition, id: 'hidden',
                    availability: { when: { fact: 'session.exists', operator: 'equals', value: true } },
                },
            }],
            async activateChannel() {},
            readChannel: () => ({
                occurrenceId: 'channel-occurrence', isCurrent: () => current,
                async send(request) {
                    requests.push(request);
                    current = false;
                    return {
                        deliveryId: request.deliveryId, channelId: request.channelId,
                        status: 'accepted', evidence: 'provider',
                    };
                },
            }),
        });
        await expect(owner.availableHostChannels()).resolves.toEqual([
            { value: 'acme.notifications/configured', label: 'Configured (acme.notifications)', kind: 'plugin' },
        ]);
        await expect(owner.sendHostNotification({
            channelId: 'acme.notifications/hidden', title: 'Hidden',
        })).resolves.toBe(false);
        await expect(owner.sendHostNotification({
            channelId: 'acme.notifications/configured', title: 'Retired during send',
        })).resolves.toBe(false);
        await expect(owner.availableHostChannels()).resolves.toEqual([]);
        await expect(owner.sendHostNotification({
            channelId: 'acme.notifications/configured', title: 'Retired before send',
        })).resolves.toBe(false);
        expect(requests).toHaveLength(1);
    });

    it('settles a host send as undelivered when its channel retires before the sender answers', async () => {
        const retirement = new AbortController();
        let started!: () => void;
        const sending = new Promise<void>((resolve) => { started = resolve; });
        const owner = createStablePluginNotificationsOwner({
            categories: [], channels,
            async activateChannel() {},
            readChannel: () => ({
                occurrenceId: 'channel-occurrence',
                retirementSignal: retirement.signal,
                isCurrent: () => !retirement.signal.aborted,
                send: () => {
                    started();
                    return new Promise(() => {});
                },
            }),
        });
        const result = owner.sendHostNotification({
            channelId: 'acme.notifications/configured', title: 'Ready',
        });
        await sending;
        retirement.abort();
        await expect(result).resolves.toBe(false);
    });

    it('demands the exact qualified channel, re-reads its occurrenceId, and replays stable per-channel results', async () => {
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
                binding = Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender });
            },
            readChannel: () => binding,
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
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
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
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
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
                occurrenceId: '7',
                isCurrent: async () => false,
                send: sender,
            }),
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
                occurrenceId: '7',
                isCurrent: async () => current,
                send: sender,
            }),
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

    it('retains uncertain terminal evidence and conflict detection across occurrenceId retirement for the owner lifetime', async () => {
        let now = 1_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
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
                occurrenceId: callerSeed!.occurrenceId,
                isCurrent: () => !callerSeed!.signal.aborted,
                send: sender,
            }),
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
            isOccurrenceCurrent: () => !retiredGeneration.signal.aborted,
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
            occurrenceId: '8',
            signal: currentGeneration.signal,
            isOccurrenceCurrent: () => !currentGeneration.signal.aborted,
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

        now += 8 * 24 * 60 * 60 * 1_000;
        for (const clientRequestId of ['request-late-success', 'request-late-failure']) {
            await expect(currentService.send(request(clientRequestId))).resolves.toEqual({
                replayed: true,
                deliveries: [expect.objectContaining({
                    status: 'outcomeUnknown',
                    code: 'plugin_notification_outcome_unknown',
                })],
            });
            await expect(currentService.send({ ...request(clientRequestId), title: 'Changed notification' }))
                .rejects.toMatchObject({ code: 'plugin_notification_request_conflict' });
        }
        expect(sender).toHaveBeenCalledTimes(2);
        clock.mockRestore();
    });

    it('owns a real preference watch with the caller occurrenceId and fences late publication', () => {
        const occurrenceId = new AbortController();
        const generationSeed = Object.freeze({ ...seed, signal: occurrenceId.signal });
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
                    occurrenceId: '7',
                    categoryId: 'review-ready',
                });
                publish = params.listener;
                return Object.freeze({ dispose: disposeHostWatch });
            },
        });
        const listener = vi.fn();
        const watch = service.watchPreferences('review-ready', listener);
        const first = Object.freeze({
            categoryId: 'review-ready', enabled: true, channelIds: Object.freeze(['acme.notifications/configured']), revision: '1',
        });
        publish?.(first);
        expect(listener).toHaveBeenCalledWith(first);

        occurrenceId.abort();
        expect(disposeHostWatch).toHaveBeenCalledTimes(1);
        publish?.(Object.freeze({ ...first, revision: '2' }));
        expect(listener).toHaveBeenCalledTimes(1);
        watch.dispose();
        expect(disposeHostWatch).toHaveBeenCalledTimes(1);
    });

    it('rejects undeclared, conflicting and retired-occurrenceId operations before delivery', async () => {
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
        const retiredSeed = Object.freeze({ ...seed, isOccurrenceCurrent: () => current });
        const service = createStablePluginNotificationsService(retiredSeed, {
            categories: [category], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
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
            clientRequestId: 'request-invalid-channel', categoryId: 'review-ready', title: 'Review ready',
            channelIds: ['INVALID'],
        })).rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('deduplicates manifest defaults and accepts typed sender results supplied by trusted plugin code', async () => {
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
            evidence: 'provider',
        }, 'status', {
            enumerable: true,
            get() { return 'accepted'; },
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [duplicateDefaults], channels,
            activateChannel: async () => undefined,
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
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
                status: 'accepted',
                evidence: 'provider',
            })],
        });
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('delivers valid plugin input without local payload, channel-count or request-id ceilings', async () => {
        const declaredChannels = Array.from({ length: 33 }, (_, index) => Object.freeze({
            ...channels[0]!,
            definition: Object.freeze({ ...channels[0]!.definition, id: `channel-${index}` }),
        }));
        const requests: PluginNotificationSendRequest[] = [];
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels: declaredChannels,
            activateChannel: async () => undefined,
            readChannel: () => ({ occurrenceId: '7', isCurrent: () => true,
                send: async (request) => {
                    requests.push(request);
                    return { deliveryId: request.deliveryId, channelId: request.channelId,
                        status: 'accepted', evidence: 'provider' };
                },
            }),
        });
        const title = 't'.repeat(513);
        const body = 'b'.repeat(8_001);
        const data = { message: 'd'.repeat(64 * 1024 + 1) };
        const request = { clientRequestId: 'r'.repeat(129), categoryId: 'review-ready',
            get title() { return title; }, body, data,
            channelIds: declaredChannels.map(({ definition }) => definition.id),
        };
        await expect(service.send(request)).resolves.toMatchObject({ replayed: false,
            deliveries: Array.from({ length: 33 }, () => expect.objectContaining({ status: 'accepted' })),
        });
        expect(requests).toHaveLength(33);
        expect(requests[0]).toMatchObject({ title, body, data, clientRequestId: request.clientRequestId });
        await expect(service.send(request)).resolves.toMatchObject({ replayed: true });
        expect(requests).toHaveLength(33);
    });

    it('lists all declared channels or the requested page without a local page-size ceiling', async () => {
        const declaredChannels = Array.from({ length: 101 }, (_, index) => Object.freeze({
            ...channels[0]!,
            definition: Object.freeze({ ...channels[0]!.definition, id: `channel-${index}` }),
        }));
        const service = createStablePluginNotificationsService(seed, {
            categories: [category], channels: declaredChannels,
            activateChannel: async () => undefined,
            readChannel: () => ({ occurrenceId: '7', isCurrent: () => true, send: async () => undefined }),
        });
        expect((await service.listChannels()).items).toHaveLength(101);
        expect((await service.listChannels({ limit: 101 })).items).toHaveLength(101);
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
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
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
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
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
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
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

    it('keeps an in-flight operation bound regardless of elapsed time', async () => {
        let now = 1_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
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
            readChannel: () => Object.freeze({ occurrenceId: '7', isCurrent: () => true, send: sender }),
        });
        const request = Object.freeze({
            clientRequestId: 'request-pending-retention',
            categoryId: 'review-ready',
            title: 'Review ready',
            channelIds: ['configured'],
        });

        const first = service.send(request);
        await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
        now += 8 * 24 * 60 * 60 * 1_000;
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
        clock.mockRestore();
    });

    it('keeps distinct notification requests available beyond the former local operation ceiling', async () => {
        let now = 1_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const categoryWithoutDefaults: ResolvedNotificationCategoryContribution = Object.freeze({
            ...category,
            definition: Object.freeze({ ...category.definition, defaultChannels: [] }),
        });
        const service = createStablePluginNotificationsService(seed, {
            categories: [categoryWithoutDefaults], channels: [],
            activateChannel: async () => undefined,
            readChannel: () => null,
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
        })).resolves.toMatchObject({ replayed: false, deliveries: [] });

        now += 8 * 24 * 60 * 60 * 1_000;
        await expect(service.send({
            clientRequestId: 'capacity-after-expiry',
            categoryId: 'review-ready',
            title: 'Review ready',
        })).resolves.toMatchObject({ replayed: false, deliveries: [] });
        clock.mockRestore();
    }, 30_000);
});
