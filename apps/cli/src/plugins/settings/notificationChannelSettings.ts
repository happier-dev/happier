import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';

import type {
    ResolvedNotificationChannelContribution,
    ResolvedSettingsContribution,
} from '@/plugins/projection/registry/types';

export function notificationChannelSettingsContributionId(channelId: string): string {
    return `notification-channel/${channelId}`;
}

export function notificationChannelSettingFieldId(channelId: string, fieldId: string): string {
    return `${channelId}.${fieldId}`;
}

export function resolveNotificationChannelSettingsContributions(
    channels: readonly ResolvedNotificationChannelContribution[],
): readonly ResolvedSettingsContribution[] {
    return Object.freeze(channels.flatMap((channel): readonly ResolvedSettingsContribution[] => {
        if (!channel.pluginId || !channel.definition.settings || channel.definition.settings.length === 0) {
            return [];
        }
        const fieldIds = channel.definition.settings.map((field) => (
            notificationChannelSettingFieldId(channel.definition.id, field.id)
        ));
        const definition: PluginSettingsContributionV2 = {
            id: notificationChannelSettingsContributionId(channel.definition.id),
            version: 1,
            title: channel.definition.title,
            ...(channel.definition.description ? { description: channel.definition.description } : {}),
            target: { kind: 'plugin' },
            scope: 'synced',
            fields: channel.definition.settings.map((field) => ({
                ...field,
                id: notificationChannelSettingFieldId(channel.definition.id, field.id),
            })),
            presentation: {
                sections: [{
                    id: 'configuration',
                    title: channel.definition.title,
                    ...(channel.definition.description ? { description: channel.definition.description } : {}),
                    fields: fieldIds,
                }],
                subagentSections: [],
            },
        };
        return [Object.freeze({
            ...channel,
            definition,
        })];
    }));
}
