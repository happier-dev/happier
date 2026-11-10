import { SavedHealthAlertTestResultSchema as canonicalResult } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import type { SavedHealthAlertTestResult } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';
import { NOTIFICATION_NOTIFY_ME_ACTION_ID as canonicalNotifyMe,
    SAVED_HEALTH_ALERT_TEST_ACTION_ID as canonicalSavedTest,
    WEBHOOK_NOTIFICATION_TEST_ACTION_ID as canonicalWebhookTest } from '@happier-dev/protocol/actions/notificationConfigurationActionIds';

export const NOTIFICATION_NOTIFY_ME_ACTION_ID = canonicalNotifyMe;
export const SAVED_HEALTH_ALERT_TEST_ACTION_ID = canonicalSavedTest;
export const WEBHOOK_NOTIFICATION_TEST_ACTION_ID = canonicalWebhookTest;

/** The host's saved-source Test settlement, shared with agent execution. */
export const SavedHealthAlertTestResultSchema: Readonly<{
    parse(value: unknown): SavedHealthAlertTestResult;
}> = /* @__PURE__ */ projectProtocolValue(canonicalResult);
export type { SavedHealthAlertTestResult };
