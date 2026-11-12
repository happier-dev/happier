import { vi } from 'vitest';

export type BrowserNotificationStub = {
    readonly title: string;
    readonly options?: NotificationOptions;
    readonly close: ReturnType<typeof vi.fn>;
    onclick: (() => void) | null;
};

/**
 * Browser platform boundary stub for the Web Notifications API.
 *
 * The Node test runtime has no `Notification` global. This installs one with a fixed permission
 * state and records every notification the code under test shows, so tests observe what the user
 * would see and can simulate a click through `onclick`. Remove it with `vi.unstubAllGlobals()`.
 */
export function installBrowserNotificationApiStub(permission: NotificationPermission): Readonly<{
    shown: BrowserNotificationStub[];
    requestPermission: ReturnType<typeof vi.fn<() => Promise<NotificationPermission>>>;
}> {
    const shown: BrowserNotificationStub[] = [];
    const requestPermission = vi.fn(async (): Promise<NotificationPermission> => permission);

    class BrowserNotification implements BrowserNotificationStub {
        static readonly permission = permission;
        static readonly requestPermission = requestPermission;
        readonly close = vi.fn();
        onclick: (() => void) | null = null;

        constructor(readonly title: string, readonly options?: NotificationOptions) {
            shown.push(this);
        }
    }

    vi.stubGlobal('Notification', BrowserNotification);
    return { shown, requestPermission };
}
