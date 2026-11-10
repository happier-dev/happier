import { NOTIFICATION_DESTINATION_INPUT_TYPE_V1, NotificationDestinationSelectionV1Schema } from '@happier-dev/channels-protocol/v1';
import type { PluginContributedActionHostFacts } from './pluginContributedActionController';
import type { MachineTargetV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { createActionInputForm } from './actionInputForm';
import { presentActionInputForm } from './presentActionInputForm';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

type NotificationDestinationSelectionV1 = ReturnType<typeof NotificationDestinationSelectionV1Schema.parse>;

/** The same finite Channels-owned selection serves source setup and creation preferences. */
export async function presentNotificationDestinationSelection(params: Readonly<{
    host: Pick<PluginContributedActionHostFacts, 'serverId' | 'machineId' | 'accountLifetime'>;
    channelId?: string;
    target?: MachineTargetV1;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    present?: typeof presentActionInputForm;
    anchor?: Parameters<typeof presentActionInputForm>[0]['anchor'];
}>): Promise<Readonly<{ kind: 'notificationDestination'; channel: NotificationDestinationSelectionV1 }>
    | Readonly<{ kind: 'cancelled' }> | Readonly<{ kind: 'unavailable'; reason: 'host_unavailable' }>> {
    const lifetime = params.host.accountLifetime;
    const mountedServerId = resolveServerProfileScopeIdForIdentifier(params.host.serverId);
    const serverId = resolveServerProfileScopeIdForIdentifier(params.target?.serverId ?? params.host.serverId);
    const machineId = (params.target?.machineId ?? params.host.machineId)?.trim();
    if (!lifetime || !machineId || !serverId
        || mountedServerId !== serverId
        || serverId !== resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId)) {
        return { kind: 'unavailable', reason: 'host_unavailable' };
    }
    const present = params.present ?? presentActionInputForm;
    const select = async (channelId?: string) => {
        let settle: (value: NotificationDestinationSelectionV1 | string | null) => void = () => {};
        const selected = new Promise<NotificationDestinationSelectionV1 | string | null>(resolve => { settle = resolve; });
        const form = createActionInputForm({
            presentation: { title: t('common.select'), description: null, inputHints: {
                fields: channelId === undefined
                    ? [{ path: 'channelId', title: t('common.select'), widget: 'select', required: true,
                        optionsSourceId: 'notifications.channels.available' }]
                    : [{ path: 'channel', title: t('common.select'), widget: 'json', required: true,
                        inputType: NOTIFICATION_DESTINATION_INPUT_TYPE_V1 }],
                submitLabel: t('common.done'),
            } },
            initialInput: channelId === undefined ? {} : { channel: { channelId } },
            accountLifetime: lifetime, signal: params.signal, isCurrent: params.isCurrent,
            submit: async candidate => {
                if (channelId === undefined) {
                    const channel = NotificationDestinationSelectionV1Schema.safeParse({ channelId: candidate.channelId });
                    if (!channel.success) return { ok: false };
                    settle(channel.data.channelId);
                } else {
                    const channel = NotificationDestinationSelectionV1Schema.safeParse(candidate.channel);
                    if (!channel.success) return { ok: false };
                    settle(channel.data);
                }
                return { ok: true };
            },
            onRetire: () => settle(null),
        });
        present({ form, anchor: params.anchor,
            ...(params.signal ? { signal: params.signal } : {}),
            pickerContext: { serverId, machineId, accountLifetime: lifetime } });
        try { return await selected; }
        finally { form.retire(); }
    };
    let channelId = params.channelId;
    if (channelId === undefined) {
        const channel = await select();
        if (typeof channel !== 'string') return { kind: 'cancelled' };
        channelId = channel;
    }
    const channel = await select(channelId);
    return channel !== null && typeof channel !== 'string'
        ? { kind: 'notificationDestination', channel } : { kind: 'cancelled' };
}
