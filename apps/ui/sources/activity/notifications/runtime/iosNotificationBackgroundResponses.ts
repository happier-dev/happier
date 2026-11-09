import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { withTimeout } from '@/utils/timing/time';
import { PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS } from '../permission/pushNotificationAccess';
import { handleNotificationBackgroundTask } from './notificationPermissionActions';
import { markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';

type BackgroundDelivery = Readonly<{ deliveryId: string; response: unknown }>;
type NotificationCompletionModule = Readonly<{
    getPendingBackgroundNotificationResponses?: () => Promise<BackgroundDelivery[]>;
    claimBackgroundNotificationResponse?: (deliveryId: string) => Promise<boolean>;
    completeBackgroundNotificationResponse?: (deliveryId: string) => Promise<boolean>;
    addListener(event: string, listener: (event: unknown) => void): { remove(): void };
}>;

let registration: Promise<boolean> | undefined;

function deliveryId(event: unknown): string | null {
    return typeof event === 'object' && event !== null && 'deliveryId' in event && typeof event.deliveryId === 'string'
        ? event.deliveryId : null;
}

function needsReview(message: string): void {
    console.warn(`[notifications] ${message}; open Happier to review`);
    try { markNotificationPermissionRecoveryNeeded(); }
    catch { console.warn('[notifications] Permission action recovery storage unavailable'); }
}

async function registerResponses(): Promise<boolean> {
    const native = requireOptionalNativeModule<NotificationCompletionModule>('ExpoNotificationsEmitter');
    if (!native?.getPendingBackgroundNotificationResponses || !native.claimBackgroundNotificationResponse
        || !native.completeBackgroundNotificationResponse) return false;
    const claim = native.claimBackgroundNotificationResponse.bind(native);
    const complete = native.completeBackgroundNotificationResponse.bind(native);
    const running = new Map<string, AbortController>();
    const receive = (event: unknown) => {
        const id = deliveryId(event);
        if (!id || typeof event !== 'object' || event === null || !('response' in event) || running.has(id)) return;
        const lifetime = new AbortController();
        running.set(id, lifetime);
        void (async () => {
            let claimed = false;
            try {
                // The native record survives an in-process JS reload. Only its
                // first claimant may execute; a new bridge cannot retry it.
                claimed = await claim(id);
                if (claimed) await handleNotificationBackgroundTask({ data: event.response }, { signal: lifetime.signal });
            } catch {
                needsReview('Native notification admission unavailable');
            } finally {
                running.delete(id);
                lifetime.abort();
                if (claimed) {
                    try { await complete(id); }
                    catch { console.warn('[notifications] Native notification completion unavailable'); }
                }
            }
        })();
    };
    const responseSubscription = native.addListener('onDidReceiveBackgroundNotificationResponse', receive);
    const expirationSubscription = native.addListener('onDidExpireBackgroundNotificationResponse', event => {
        const id = deliveryId(event);
        if (!id) return;
        running.get(id)?.abort();
        needsReview('Background permission action expired');
    });
    try {
        for (const response of await native.getPendingBackgroundNotificationResponses()) receive(response);
        return true;
    } catch (error) {
        responseSubscription.remove();
        expirationSubscription.remove();
        for (const lifetime of running.values()) lifetime.abort();
        throw error;
    }
}

/** One native capability admission per runtime, shared by bootstrap and categories. */
export function initializeIOSNotificationBackgroundResponses(): Promise<boolean> {
    if (Platform.OS !== 'ios') return Promise.resolve(false);
    if (registration) return registration;
    registration = (async () => {
        try {
            const supported = await withTimeout(registerResponses, PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
                'iOS notification response registration');
            if (!supported) console.warn('[notifications] Background actions unavailable; using foreground actions');
            return supported;
        } catch {
            console.warn('[notifications] Background action registration unavailable; using foreground actions');
            return false;
        }
    })();
    return registration;
}
