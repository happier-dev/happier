import {
    isPermissionGranted as pluginIsPermissionGranted,
    requestPermission as pluginRequestPermission,
    sendNotification as pluginSendNotification,
} from '@tauri-apps/plugin-notification';
import { invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type DesktopNotificationInteraction = Readonly<{
    identifier: string;
    accountId?: string;
    data: Record<string, unknown>;
    actions: readonly Readonly<{ id: string; title: string }>[];
    silent?: boolean;
}>;

export type DesktopPresentedNotification = Readonly<{
    request: Readonly<{ identifier: string; content: Readonly<{ data: Record<string, unknown>; accountId: string }> }>;
}>;

export type DesktopNotificationResponse = Readonly<{ actionIdentifier: string; notification: DesktopPresentedNotification }>;

const arrivals = new Set<() => void>();

type NotificationPermission = Awaited<ReturnType<typeof pluginRequestPermission>>;

type TauriNotificationModule = {
    isPermissionGranted: () => Promise<boolean>;
    requestPermission: () => Promise<NotificationPermission>;
    sendNotification: (payload: { title: string; body: string }) => void;
};

const plugin: TauriNotificationModule = {
    isPermissionGranted: pluginIsPermissionGranted,
    requestPermission: pluginRequestPermission,
    sendNotification: pluginSendNotification,
};

export async function isPermissionGranted(): Promise<boolean> {
    return await plugin.isPermissionGranted();
}

export async function requestPermission(): Promise<NotificationPermission> {
    return await plugin.requestPermission();
}

export async function sendNotification(payload: { title: string; body: string; interaction?: DesktopNotificationInteraction }): Promise<void> {
    if (!payload.interaction) {
        plugin.sendNotification(payload);
        return;
    }
    const serverId = payload.interaction.data.serverId;
    if (typeof serverId !== 'string' || !serverId) throw new Error('notification_scope_unavailable');
    const binding = await resolveServerCredentialAccountScope(serverId);
    if (binding.kind !== 'bound' || (payload.interaction.accountId !== undefined
        && payload.interaction.accountId !== binding.scope.accountId)
        || (payload.interaction.data.accountId !== undefined
            && payload.interaction.data.accountId !== binding.scope.accountId)) {
        throw new Error('notification_account_unavailable');
    }
    await invokeDesktopHost('desktop_notification_show', { notification: {
        title: payload.title, body: payload.body, ...payload.interaction, accountId: binding.scope.accountId,
    } });
    for (const listener of arrivals) listener();
}

export async function removeNotification(identifier: string): Promise<void> {
    await invokeDesktopHost('desktop_notification_remove', { identifier });
}

/** These are transport shapes only; Guard currentness and authority stay in guardStopWarningLifecycle. */
export const desktopGuardNotificationTransport = {
    getPresentedNotificationsAsync: () => invokeDesktopHost<DesktopPresentedNotification[]>('desktop_notification_list'),
    dismissNotificationAsync: removeNotification,
    addNotificationReceivedListener: (listener: () => void) => {
        arrivals.add(listener);
        return { remove: () => { arrivals.delete(listener); } };
    },
};

export async function subscribeDesktopNotificationResponses(listener: (response: DesktopNotificationResponse) => void, signal?: AbortSignal): Promise<() => void> {
    let disposed = false;
    const isInactive = () => disposed || signal?.aborted === true;
    const drain = async () => {
        if (isInactive()) return;
        const responses = await invokeDesktopHost<DesktopNotificationResponse[]>('desktop_notification_take_responses');
        if (isInactive()) return;
        for (const response of responses) listener(response);
    };
    // Subscribe first so an activation during the initial drain cannot be lost.
    const remove = await listenDesktopHostEvent<void>('desktop-notification-action', () => {
        fireAndForget(drain(), { tag: 'desktopNotificationResponse' });
    }).catch(error => {
        console.warn('[notifications] Desktop notification listener unavailable', error);
        return undefined;
    });
    if (isInactive()) {
        remove?.();
        return () => {};
    }
    try {
        await drain();
    } catch (error) {
        remove?.();
        throw error;
    }
    return () => { disposed = true; remove?.(); };
}
