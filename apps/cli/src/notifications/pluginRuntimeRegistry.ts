import type {
    PluginApiNotificationCategoryRegistration,
    PluginApiNotificationChannelRegistration,
} from '@/plugins/runtime/api/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

import {
    createBuiltInNotificationRegistry,
    type NotificationCategoryRegistration,
    type NotificationChannelRegistration,
    type NotificationOwner,
    type NotificationRegistry,
} from './service';

type ActivatedNotificationCategoryEntry = Readonly<{
    pluginId: string;
    registration: PluginApiNotificationCategoryRegistration;
}>;

type ActivatedNotificationChannelEntry = Readonly<{
    pluginId: string;
    registration: PluginApiNotificationChannelRegistration;
}>;

function resolveOwner(pluginId: string | undefined): NotificationOwner {
    if (pluginId && pluginId.trim().length > 0) {
        return { kind: 'plugin', pluginId };
    }
    return { kind: 'built_in' };
}

function registerStaticCategories(params: Readonly<{
    registry: NotificationRegistry;
    contributes: Pick<ResolvedContributionRegistry, 'notifications'>;
    activatedById?: ReadonlyMap<string, ActivatedNotificationCategoryEntry>;
}>): void {
    for (const contribution of params.contributes.notifications ?? []) {
        const activated = params.activatedById?.get(contribution.definition.id) ?? null;
        const category: NotificationCategoryRegistration = Object.freeze({
            ...contribution.definition,
            owner: resolveOwner(activated?.pluginId ?? contribution.pluginId),
        });
        params.registry.registerCategory(category);
    }
}

function registerStaticChannels(params: Readonly<{
    registry: NotificationRegistry;
    contributes: Pick<ResolvedContributionRegistry, 'notificationChannels'>;
    activatedById?: ReadonlyMap<string, ActivatedNotificationChannelEntry>;
}>): void {
    for (const contribution of params.contributes.notificationChannels ?? []) {
        const activated = params.activatedById?.get(contribution.definition.id) ?? null;
        const channel: NotificationChannelRegistration = Object.freeze({
            ...contribution.definition,
            owner: resolveOwner(activated?.pluginId ?? contribution.pluginId),
            ...(activated ? { send: activated.registration.send } : {}),
        });
        params.registry.registerChannel(channel);
    }
}

function registerActivatedCategoryFallbacks(params: Readonly<{
    registry: NotificationRegistry;
    activatedById?: ReadonlyMap<string, ActivatedNotificationCategoryEntry>;
}>): void {
    for (const [categoryId, activated] of params.activatedById ?? []) {
        if (params.registry.getCategory(categoryId)) {
            continue;
        }
        params.registry.registerCategory({
            ...activated.registration,
            owner: { kind: 'plugin', pluginId: activated.pluginId },
        });
    }
}

function registerActivatedChannelFallbacks(params: Readonly<{
    registry: NotificationRegistry;
    activatedById?: ReadonlyMap<string, ActivatedNotificationChannelEntry>;
}>): void {
    for (const [channelId, activated] of params.activatedById ?? []) {
        if (params.registry.getChannel(channelId)) {
            continue;
        }
        params.registry.registerChannel({
            ...activated.registration,
            owner: { kind: 'plugin', pluginId: activated.pluginId },
        });
    }
}

export function createNotificationRegistryFromPluginRuntime(
    runtimeRegistry: Readonly<{
        contributes: Pick<ResolvedContributionRegistry, 'notifications' | 'notificationChannels'>;
        notificationCategoriesById?: ReadonlyMap<string, ActivatedNotificationCategoryEntry>;
        notificationChannelsById?: ReadonlyMap<string, ActivatedNotificationChannelEntry>;
    }>,
): NotificationRegistry {
    const registry = createBuiltInNotificationRegistry();
    registerStaticCategories({
        registry,
        contributes: runtimeRegistry.contributes,
        activatedById: runtimeRegistry.notificationCategoriesById,
    });
    registerStaticChannels({
        registry,
        contributes: runtimeRegistry.contributes,
        activatedById: runtimeRegistry.notificationChannelsById,
    });
    registerActivatedCategoryFallbacks({
        registry,
        activatedById: runtimeRegistry.notificationCategoriesById,
    });
    registerActivatedChannelFallbacks({
        registry,
        activatedById: runtimeRegistry.notificationChannelsById,
    });
    return registry;
}
