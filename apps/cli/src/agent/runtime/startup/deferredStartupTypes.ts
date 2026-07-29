import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PushNotificationClient } from '@/api/pushNotifications';

import type { Metadata } from '@/api/types';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';

export type DeferredStartupPushSender = Pick<PushNotificationClient, 'sendToAllDevices' | 'sendToAllDevicesAsync'>;

export type DeferredStartupLoopApi = Readonly<{
    push: () => DeferredStartupPushSender;
}>;

export type DeferredStartupStartOptions = Readonly<{
    prepareSession?: (session: ApiSessionClient) => void | Promise<void>;
}>;

export type DeferredStartupBootstrapResult = Readonly<{
    api: DeferredStartupLoopApi;
    session: ApiSessionClient;
    machineId: string;
    metadata: Metadata;
    attachedToExistingSession: boolean;
    reconnectionHandle: { cancel: () => void } | null;
    start?: ((options?: DeferredStartupStartOptions) => void | Promise<void>) | null;
    cancel?: (() => void) | null;
    cleanup?: (() => void | Promise<void>) | null;
}>;

export type DeferredStartupRegisteredStateMutationFactory = (
    sessionId: string,
) => readonly RegisteredSessionStateFieldMutationV1[];
