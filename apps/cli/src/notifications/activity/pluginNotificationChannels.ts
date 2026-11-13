import type { StablePluginNotificationsOwner } from '@/plugins/runtime/invocation/services/notifications';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { HealthCheckAlertChannelV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { ConversationNotificationDestinationSetupResultV1Schema } from '@happier-dev/channels-protocol';

export type SavedHealthAlertDestinationAvailability = Readonly<{ kind: 'ready' } | { kind: 'unavailable'; reason: string }>;
export type SavedHealthAlertDestinationHost = Readonly<{
    notificationChannelsList(signal?: AbortSignal): Promise<readonly Readonly<{
        value: string; disabled?: boolean; destinationSetup?: PluginContributionRef;
    }>[]>;
    executeSetup(ref: PluginContributionRef, input: Readonly<{ destination: NonNullable<HealthCheckAlertChannelV1['destination']> }>, signal?: AbortSignal): Promise<unknown>;
}>;

/** Reads the selected provider's current connection owner; it never probes delivery. */
export async function readSavedHealthAlertDestinationAvailabilityForHost(
    input: Readonly<{ channel: HealthCheckAlertChannelV1; signal?: AbortSignal }>,
    host: SavedHealthAlertDestinationHost,
): Promise<SavedHealthAlertDestinationAvailability> {
    input.signal?.throwIfAborted();
    const configured = (await host.notificationChannelsList(input.signal)).find(channel => channel.value === input.channel.channelId);
    if (!configured || configured.disabled) return { kind: 'unavailable', reason: 'notification_channel_unavailable' };
    if (!configured.destinationSetup) return { kind: 'ready' };
    if (input.channel.destination === undefined || input.channel.destination === null) return { kind: 'unavailable', reason: 'notification_destination_unconfigured' };
    const result = await host.executeSetup(configured.destinationSetup, { destination: input.channel.destination }, input.signal);
    input.signal?.throwIfAborted();
    const parsed = ConversationNotificationDestinationSetupResultV1Schema.safeParse(result);
    return parsed.success && parsed.data.kind !== 'resolved'
        ? parsed.data : { kind: 'unavailable', reason: 'notification_destination_unavailable' };
}

/** Reaches the daemon's current notification owner through its existing runtime lease. */
export function createHostPluginNotificationChannels(): Pick<
    StablePluginNotificationsOwner,
    'availableHostChannels' | 'sendHostNotification'
> {
    return Object.freeze({
        async availableHostChannels() {
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) return Object.freeze([]);
            try {
                return await lease.registry.pluginNotifications?.availableHostChannels() ?? Object.freeze([]);
            } finally {
                await lease.release();
            }
        },
        async sendHostNotification(request) {
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) return false;
            try {
                return await lease.registry.pluginNotifications?.sendHostNotification(request) ?? false;
            } finally {
                await lease.release();
            }
        },
    });
}
