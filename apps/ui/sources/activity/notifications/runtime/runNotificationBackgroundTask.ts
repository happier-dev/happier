import { handleNotificationBackgroundTask, type NotificationPermissionActionOptions } from './notificationPermissionActions';

/** Native task completion follows the shared action lifetime, including cold loading. */
export async function runNotificationBackgroundTask(
    body: unknown,
    options: NotificationPermissionActionOptions = {},
): Promise<void> {
    await handleNotificationBackgroundTask(body, options);
}
