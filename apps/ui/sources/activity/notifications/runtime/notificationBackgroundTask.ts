import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { runNotificationBackgroundTask } from './runNotificationBackgroundTask';

export { runNotificationBackgroundTask } from './runNotificationBackgroundTask';

export const NOTIFICATION_BACKGROUND_TASK_NAME = 'happier-notification-actions';

// Required synchronously, only on Android, inside the guarded entry-point bootstrap.
if (!TaskManager.isTaskDefined(NOTIFICATION_BACKGROUND_TASK_NAME)) {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_BACKGROUND_TASK_NAME, runNotificationBackgroundTask);
}

export async function registerNotificationBackgroundTask(): Promise<boolean> {
    if (!await TaskManager.isAvailableAsync()) return false;
    await Notifications.registerTaskAsync(NOTIFICATION_BACKGROUND_TASK_NAME);
    return true;
}
