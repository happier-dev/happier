import {
    accountSettingsParse,
    resolveAttentionDeliveryPolicyDecision,
    type AccountSettings,
} from '@happier-dev/protocol';
import type {
    NotificationCategoryDescriptorV1,
    NotificationChannelDescriptorV1,
    NotificationPreferencesV1,
    NotificationSendParamsV1,
    NotificationsServiceV1,
    PluginNotificationChannelSenderV1,
} from '@happier-dev/plugin-sdk';

import type { ActivityNotificationEvent } from './activity/activityNotificationEvent';
import type { dispatchActivityNotificationAsync } from './activity/dispatchActivityNotification';

export type NotificationOwner =
    | Readonly<{ kind: 'built_in' }>
    | Readonly<{ kind: 'plugin'; pluginId: string }>;

export type NotificationCategoryRegistration = NotificationCategoryDescriptorV1 & Readonly<{
    owner: NotificationOwner;
}>;

export type NotificationChannelRegistration = NotificationChannelDescriptorV1 & Readonly<{
    owner: NotificationOwner;
    send?: PluginNotificationChannelSenderV1;
}>;

export type NotificationRegistry = Readonly<{
    registerCategory(category: NotificationCategoryRegistration): () => void;
    registerChannel(channel: NotificationChannelRegistration): () => void;
    listCategories(): readonly NotificationCategoryRegistration[];
    listChannels(): readonly NotificationChannelRegistration[];
    getCategory(categoryId: string): NotificationCategoryRegistration | null;
    getChannel(channelId: string): NotificationChannelRegistration | null;
}>;

type ActivityNotificationDispatcher = typeof dispatchActivityNotificationAsync;
type NotificationDeliveryPreference = NotificationPreferencesV1['channels'][number]['delivery'];
type NotificationDeliveryDecision = Readonly<{
    delivery: NotificationDeliveryPreference;
}>;

function formatOwnerLabel(owner: NotificationOwner, subject: 'category' | 'channel'): string {
    if (owner.kind === 'built_in') {
        return `built-in ${subject}`;
    }
    return `plugin '${owner.pluginId}'`;
}

function compareById<T extends Readonly<{ id: string }>>(left: T, right: T): number {
    return left.id.localeCompare(right.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isActivityNotificationEvent(value: unknown): value is ActivityNotificationEvent {
    if (!isRecord(value) || typeof value.topic !== 'string' || typeof value.sessionId !== 'string') {
        return false;
    }
    if (value.topic === 'ready') {
        return typeof value.waitingForCommandLabel === 'string';
    }
    return (
        (value.topic === 'permission_request' || value.topic === 'user_action_request')
        && typeof value.requestId === 'string'
        && typeof value.toolName === 'string'
    );
}

function resolvePolicyChannelId(channel: NotificationChannelRegistration): string | null {
    return channel.kind === 'plugin' ? null : channel.kind;
}

export function createNotificationRegistry(params: Readonly<{
    categories?: readonly NotificationCategoryRegistration[];
    channels?: readonly NotificationChannelRegistration[];
}> = {}): NotificationRegistry {
    const categoriesById = new Map<string, NotificationCategoryRegistration>();
    const channelsById = new Map<string, NotificationChannelRegistration>();

    function registerCategory(category: NotificationCategoryRegistration): () => void {
        const existing = categoriesById.get(category.id);
        if (existing) {
            throw new Error(
                `Notification category '${category.id}' from ${formatOwnerLabel(category.owner, 'category')} conflicts with ${formatOwnerLabel(existing.owner, 'category')}`,
            );
        }
        categoriesById.set(category.id, Object.freeze({ ...category }));
        return () => {
            if (categoriesById.get(category.id)?.owner === category.owner) {
                categoriesById.delete(category.id);
            }
        };
    }

    function registerChannel(channel: NotificationChannelRegistration): () => void {
        const existing = channelsById.get(channel.id);
        if (existing) {
            throw new Error(
                `Notification channel '${channel.id}' from ${formatOwnerLabel(channel.owner, 'channel')} conflicts with ${formatOwnerLabel(existing.owner, 'channel')}`,
            );
        }
        channelsById.set(channel.id, Object.freeze({ ...channel }));
        return () => {
            if (channelsById.get(channel.id)?.owner === channel.owner) {
                channelsById.delete(channel.id);
            }
        };
    }

    for (const category of params.categories ?? []) {
        registerCategory(category);
    }
    for (const channel of params.channels ?? []) {
        registerChannel(channel);
    }

    return Object.freeze({
        registerCategory,
        registerChannel,
        listCategories: () => Object.freeze([...categoriesById.values()].sort(compareById)),
        listChannels: () => Object.freeze([...channelsById.values()].sort(compareById)),
        getCategory: (categoryId) => categoriesById.get(categoryId) ?? null,
        getChannel: (channelId) => channelsById.get(channelId) ?? null,
    });
}

export function createBuiltInNotificationRegistry(): NotificationRegistry {
    return createNotificationRegistry({
        categories: [
            {
                id: 'builtin.activity.ready',
                kind: 'activity',
                title: 'Ready',
                owner: { kind: 'built_in' },
                eventIds: ['ready'],
                defaultChannelIds: ['builtin:expo_push', 'builtin:webhook', 'builtin:live_activity'],
            },
            {
                id: 'builtin.approval.permission_request',
                kind: 'approval',
                title: 'Permission request',
                owner: { kind: 'built_in' },
                eventIds: ['permission_request'],
                defaultChannelIds: ['builtin:expo_push', 'builtin:webhook', 'builtin:live_activity'],
            },
            {
                id: 'builtin.approval.user_action_request',
                kind: 'approval',
                title: 'User action request',
                owner: { kind: 'built_in' },
                eventIds: ['user_action_request'],
                defaultChannelIds: ['builtin:expo_push', 'builtin:webhook', 'builtin:live_activity'],
            },
        ],
        channels: [
            {
                id: 'builtin:expo_push',
                kind: 'expo_push',
                title: 'Expo push',
                owner: { kind: 'built_in' },
            },
            {
                id: 'builtin:webhook',
                kind: 'webhook',
                title: 'Webhook',
                owner: { kind: 'built_in' },
            },
            {
                id: 'builtin:live_activity',
                kind: 'live_activity',
                title: 'Live Activity',
                owner: { kind: 'built_in' },
            },
        ],
    });
}

function resolveChannelIds(params: Readonly<{
    registry: NotificationRegistry;
    category: NotificationCategoryRegistration;
    requestedChannelIds?: readonly string[];
}>): readonly string[] {
    if (params.requestedChannelIds && params.requestedChannelIds.length > 0) {
        return Object.freeze([...params.requestedChannelIds]);
    }
    if (params.category.defaultChannelIds && params.category.defaultChannelIds.length > 0) {
        return Object.freeze([...params.category.defaultChannelIds]);
    }
    return Object.freeze(params.registry.listChannels().map((channel) => channel.id));
}

function resolveEventId(category: NotificationCategoryRegistration): string {
    return category.eventIds?.[0] ?? category.id;
}

function resolvePluginChannelDelivery(params: Readonly<{
    settings: AccountSettings;
    category: NotificationCategoryRegistration;
    channel: NotificationChannelRegistration;
}>): NotificationDeliveryPreference {
    const eventId = resolveEventId(params.category);
    const eventConfig = params.settings.attentionDeliveryPolicyV1.events[eventId];
    const channelConfig = params.settings.attentionDeliveryPolicyV1.channels[params.channel.id];
    const channelEventConfig = channelConfig?.events[eventId];
    if (eventConfig?.enabled === false) {
        return 'suppress';
    }
    if (params.channel.defaultEnabled === false && channelConfig === undefined) {
        return 'suppress';
    }
    if (channelConfig?.enabled === false || channelEventConfig?.enabled === false) {
        return 'suppress';
    }
    return 'deliver';
}

function resolveNotificationDeliveryDecision(params: Readonly<{
    settings: AccountSettings;
    category: NotificationCategoryRegistration;
    channel: NotificationChannelRegistration;
    now: Date;
}>): NotificationDeliveryDecision {
    const policyChannelId = resolvePolicyChannelId(params.channel);
    if (!policyChannelId) {
        return {
            delivery: resolvePluginChannelDelivery({
                settings: params.settings,
                category: params.category,
                channel: params.channel,
            }),
        };
    }
    return resolveAttentionDeliveryPolicyDecision({
        policy: params.settings.attentionDeliveryPolicyV1,
        event: resolveEventId(params.category),
        channel: policyChannelId,
        now: params.now,
    });
}

export function createNotificationsService(params: Readonly<{
    registry?: NotificationRegistry;
    pluginId?: string | null;
    getSettings?: () => AccountSettings | null | undefined;
    getSettingsSecretsReadKeys?: () => ReadonlyArray<Uint8Array | null | undefined>;
    dispatchActivityNotification?: ActivityNotificationDispatcher;
    now?: () => Date;
}> = {}): NotificationsServiceV1 {
    const registry = params.registry ?? createBuiltInNotificationRegistry();
    const scopedPluginId = params.pluginId?.trim() || null;
    const getSettings = params.getSettings ?? (() => null);
    const getSettingsSecretsReadKeys = params.getSettingsSecretsReadKeys ?? (() => []);
    const now = params.now ?? (() => new Date());

    function isCategoryAccessible(category: NotificationCategoryRegistration): boolean {
        if (!scopedPluginId) {
            return true;
        }
        return category.owner.kind === 'plugin' && category.owner.pluginId === scopedPluginId;
    }

    function isChannelAccessible(channel: NotificationChannelRegistration): boolean {
        if (!scopedPluginId || channel.owner.kind === 'built_in') {
            return true;
        }
        return channel.owner.kind === 'plugin' && channel.owner.pluginId === scopedPluginId;
    }

    function assertCategoryAccessible(category: NotificationCategoryRegistration): void {
        if (!isCategoryAccessible(category)) {
            throw new Error(`Notification category '${category.id}' is not available to this plugin context`);
        }
    }

    function assertChannelAccessible(channelId: string): NotificationChannelRegistration | null {
        const channel = registry.getChannel(channelId);
        if (scopedPluginId && (!channel || !isChannelAccessible(channel))) {
            throw new Error(`Notification channel '${channelId}' is not available to this plugin context`);
        }
        return channel;
    }

    function readSettings(): AccountSettings {
        return accountSettingsParse(getSettings() ?? {});
    }

    async function getUserPreferences(categoryId: string): Promise<NotificationPreferencesV1> {
        const category = registry.getCategory(categoryId);
        if (!category) {
            throw new Error(`Unknown notification category '${categoryId}'`);
        }
        assertCategoryAccessible(category);
        const settings = readSettings();
        const channelIds = resolveChannelIds({ registry, category }).filter((channelId) => {
            const channel = registry.getChannel(channelId);
            return !scopedPluginId || Boolean(channel && isChannelAccessible(channel));
        });
        return {
            categoryId,
            channels: Object.freeze(channelIds.map((channelId) => {
                const channel = registry.getChannel(channelId);
                const decision = channel
                    ? resolveNotificationDeliveryDecision({
                        settings,
                        category,
                        channel,
                        now: now(),
                    })
                    : resolveAttentionDeliveryPolicyDecision({
                        policy: settings.attentionDeliveryPolicyV1,
                        event: resolveEventId(category),
                        channel: channelId,
                        now: now(),
                    });
                return Object.freeze({
                    channelId,
                    delivery: decision.delivery,
                    enabled: decision.delivery !== 'suppress',
                });
            })),
        };
    }

    async function send(input: NotificationSendParamsV1): Promise<{ delivered: readonly string[] }> {
        const category = registry.getCategory(input.categoryId);
        if (!category) {
            throw new Error(`Unknown notification category '${input.categoryId}'`);
        }
        assertCategoryAccessible(category);
        const settings = readSettings();
        const delivered: string[] = [];
        if (
            params.dispatchActivityNotification
            && category.owner.kind === 'built_in'
            && (category.kind === 'activity' || category.kind === 'approval')
            && isActivityNotificationEvent(input.payload)
        ) {
            const result = await params.dispatchActivityNotification({
                settings,
                settingsSecretsReadKeys: getSettingsSecretsReadKeys(),
                event: input.payload,
            });
            if (result.deliveredChannels > 0) {
                delivered.push('activity');
            }
        }

        for (const channelId of resolveChannelIds({
            registry,
            category,
            requestedChannelIds: input.channelIds,
        })) {
            const channel = assertChannelAccessible(channelId);
            if (!channel?.send) {
                continue;
            }
            const decision = resolveNotificationDeliveryDecision({
                settings,
                category,
                channel,
                now: now(),
            });
            if (decision.delivery === 'suppress') {
                continue;
            }
            const result = await channel.send({
                categoryId: category.id,
                channelId: channel.id,
                title: input.title,
                body: input.body,
                payload: input.payload,
            });
            if (result.delivered) {
                delivered.push(channel.id);
            }
        }
        return { delivered: Object.freeze(delivered) };
    }

    return Object.freeze({
        send,
        listChannels: async () => registry
            .listChannels()
            .filter(isChannelAccessible)
            .map(({ owner: _owner, send: _send, ...channel }) => channel),
        listCategories: async () => registry
            .listCategories()
            .filter(isCategoryAccessible)
            .map(({ owner: _owner, ...category }) => category),
        getUserPreferences,
    });
}
