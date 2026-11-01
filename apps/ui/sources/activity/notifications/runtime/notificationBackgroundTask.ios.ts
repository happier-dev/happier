import { requireOptionalNativeModule } from 'expo-modules-core';
import { markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';
import { runNotificationBackgroundTask } from './runNotificationBackgroundTask';

type BackgroundDelivery = Readonly<{ deliveryId: string; response: unknown }>;
type NotificationCompletionModule = Readonly<{
    getPendingBackgroundNotificationResponses?: () => Promise<BackgroundDelivery[]>;
    claimBackgroundNotificationResponse?: (deliveryId: string) => Promise<boolean>;
    completeBackgroundNotificationResponse?: (deliveryId: string) => Promise<boolean>;
    addListener(event: string, listener: (event: unknown) => void): { remove(): void };
}>;

function deliveryId(event: unknown): string | null {
    return typeof event === 'object' && event !== null && 'deliveryId' in event && typeof event.deliveryId === 'string'
        ? event.deliveryId : null;
}

export async function registerNotificationBackgroundTask(): Promise<boolean> {
    const native = requireOptionalNativeModule<NotificationCompletionModule>('ExpoNotificationsEmitter');
    if (!native?.getPendingBackgroundNotificationResponses || !native.claimBackgroundNotificationResponse || !native.completeBackgroundNotificationResponse) return false;
    const claim = native.claimBackgroundNotificationResponse.bind(native);
    const complete = native.completeBackgroundNotificationResponse.bind(native);
    const running = new Map<string, AbortController>();
    const receive = (event: unknown) => {
        const id = deliveryId(event);
        if (!id || typeof event !== 'object' || event === null || !('response' in event)) return;
        if (running.has(id)) return;
        const lifetime = new AbortController();
        running.set(id, lifetime);
        void (async () => {
            let claimed = false;
            try {
                // The native record survives an in-process JS reload. Only its
                // first claimant may execute; cached snapshots cannot retry it.
                claimed = await claim(id);
                if (claimed) await runNotificationBackgroundTask({ data: event.response }, { signal: lifetime.signal });
            } catch {
                console.warn('[notifications] Native notification admission unavailable; open Happier to review');
                try {
                    markNotificationPermissionRecoveryNeeded();
                } catch {
                    console.warn('[notifications] Permission action recovery storage unavailable');
                }
            } finally {
                running.delete(id);
                lifetime.abort();
                if (claimed) {
                    try {
                        await complete(id);
                    } catch {
                        console.warn('[notifications] Native notification completion unavailable');
                    }
                }
            }
        })();
    };
    const responseSubscription = native.addListener('onDidReceiveBackgroundNotificationResponse', receive);
    const expirationSubscription = native.addListener('onDidExpireBackgroundNotificationResponse', (event) => {
        const id = deliveryId(event);
        if (!id) return;
        running.get(id)?.abort();
        console.warn('[notifications] Background permission action expired; open Happier to review');
        try {
            markNotificationPermissionRecoveryNeeded();
        } catch {
            console.warn('[notifications] Permission action recovery storage unavailable');
        }
    });
    try {
        const pending = await native.getPendingBackgroundNotificationResponses();
        for (const response of pending) receive(response);
        return true;
    } catch (error) {
        responseSubscription.remove();
        expirationSubscription.remove();
        for (const lifetime of running.values()) lifetime.abort();
        throw error;
    }
}
