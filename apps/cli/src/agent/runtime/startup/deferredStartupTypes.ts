import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PushNotificationClient } from '@/api/pushNotifications';

import type { Metadata } from '@/api/types';

export type DeferredStartupPushSender = Pick<PushNotificationClient, 'sendToAllDevices' | 'sendToAllDevicesAsync'>;

export type DeferredStartupLoopApi = Readonly<{
    push: () => DeferredStartupPushSender;
}>;

export type DeferredStartupBootstrapResult = Readonly<{
    api: DeferredStartupLoopApi;
    session: ApiSessionClient;
    machineId: string;
    metadata: Metadata;
    attachedToExistingSession: boolean;
    reconnectionHandle: { cancel: () => void } | null;
    start?: (() => void | Promise<void>) | null;
    cleanup?: (() => void | Promise<void>) | null;
}>;
