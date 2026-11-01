import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { consumeNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';

const native = vi.hoisted(() => ({
    module: null as null | Record<string, unknown>,
    listeners: new Map<string, (event: unknown) => void>(),
    pending: vi.fn<() => Promise<unknown[]>>(),
    claim: vi.fn<(id: string) => Promise<boolean>>(),
    complete: vi.fn<(id: string) => Promise<boolean>>(),
}));

// Expo's emitter and its live completion callbacks are the OS boundary.
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native.module }));

function delivery(deliveryId: string) {
    return { deliveryId, response: {
        actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
        notification: { request: { identifier: deliveryId, content: { data: {
            serverUrl: 'https://unsaved-ios-background.example.test',
            sessionId: 'session', requestId: 'request', occurrenceId: deliveryId,
        } } } },
    } };
}

describe('iOS live notification completion adapter', () => {
    let releasePendingSnapshot: (() => void) | undefined;

    afterEach(async () => {
        releasePendingSnapshot?.();
        releasePendingSnapshot = undefined;
        // The adapter returns after admission, while execution can still be
        // loading. Finish that real bundler boundary before resetting native spies.
        await vi.dynamicImportSettled();
    });

    beforeEach(() => {
        vi.resetModules();
        native.listeners.clear();
        native.pending.mockReset().mockResolvedValue([]);
        const claimed = new Set<string>();
        native.claim.mockReset().mockImplementation(async (id) => {
            if (claimed.has(id)) return false;
            claimed.add(id);
            return true;
        });
        native.complete.mockReset().mockResolvedValue(true);
        native.module = {
            getPendingBackgroundNotificationResponses: native.pending,
            claimBackgroundNotificationResponse: native.claim,
            completeBackgroundNotificationResponse: native.complete,
            addListener: (event: string, listener: (body: unknown) => void) => {
                native.listeners.set(event, listener);
                return { remove: () => native.listeners.delete(event) };
            },
        };
        consumeNotificationPermissionRecoveryNeeded();
    });

    it('fails closed on older native binaries', async () => {
        native.module = {};
        const adapter = await import('./notificationBackgroundTask.ios');
        await expect(adapter.registerNotificationBackgroundTask()).resolves.toBe(false);
        expect(native.listeners.size).toBe(0);
    });

    it('processes a live cold delivery through scoped admission before completing Apple’s callback', async () => {
        native.pending.mockResolvedValue([delivery('cold')]);
        const adapter = await import('./notificationBackgroundTask.ios');
        await expect(adapter.registerNotificationBackgroundTask()).resolves.toBe(true);
        await vi.dynamicImportSettled();
        expect(native.complete).toHaveBeenCalledWith('cold');
        // The real shared executor rejects this unsaved Home; it is not a new
        // native permission sender or an optimistic native acknowledgement.
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
    });

    it('does not execute or finish a native delivery already claimed by another JS runtime', async () => {
        native.claim.mockResolvedValue(false);
        native.pending.mockResolvedValue([delivery('previous-runtime')]);
        const adapter = await import('./notificationBackgroundTask.ios');
        await adapter.registerNotificationBackgroundTask();
        await vi.dynamicImportSettled();
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
        expect(native.complete).not.toHaveBeenCalled();
    });

    it('does not retry an event delivered again by the initial native drain', async () => {
        let drain!: (pending: unknown[]) => void;
        native.pending.mockImplementation(() => new Promise((resolve) => {
            drain = resolve;
            releasePendingSnapshot = () => resolve([]);
        }));
        const adapter = await import('./notificationBackgroundTask.ios');
        const registering = adapter.registerNotificationBackgroundTask();
        native.listeners.get('onDidReceiveBackgroundNotificationResponse')?.(delivery('race'));
        await vi.dynamicImportSettled();
        expect(native.complete).toHaveBeenCalledWith('race');
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
        drain([delivery('race')]);
        await registering;
        await vi.dynamicImportSettled();
        expect(native.complete).toHaveBeenCalledTimes(1);
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
    });

    it('does not execute a drain snapshot whose native lifetime already expired', async () => {
        native.claim.mockResolvedValue(false);
        let drain!: (pending: unknown[]) => void;
        native.pending.mockImplementation(() => new Promise((resolve) => {
            drain = resolve;
            releasePendingSnapshot = () => resolve([]);
        }));
        const adapter = await import('./notificationBackgroundTask.ios');
        const registering = adapter.registerNotificationBackgroundTask();
        native.listeners.get('onDidExpireBackgroundNotificationResponse')?.({ deliveryId: 'expired' });
        // Expiry itself asks for review. A stale drain must not acquire intent.
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
        drain([delivery('expired')]);
        await registering;
        await vi.dynamicImportSettled();
        expect(native.complete).not.toHaveBeenCalled();
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
    });
});
