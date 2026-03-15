export {
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  AccountSettingsSchema,
  ForegroundBehaviorSchema,
  NotificationsSettingsV1Schema,
  DEFAULT_ACTIONS_SETTINGS_V1,
  DEFAULT_NOTIFICATIONS_SETTINGS_V1,
  accountSettingsParse,
  getNotificationsSettingsV1FromAccountSettings,
  type AccountSettings,
  type ForegroundBehavior,
  type NotificationsSettingsV1,
} from './accountSettings.js';

export {
  AccountSettingsStoredContentEnvelopeSchema,
  type AccountSettingsStoredContentEnvelope,
} from './accountSettingsStoredContentEnvelope.js';

export {
  AccountSettingsV2GetResponseSchema,
  AccountSettingsV2UpdateRequestSchema,
  AccountSettingsV2UpdateResponseSchema,
  type AccountSettingsV2GetResponse,
  type AccountSettingsV2UpdateRequest,
  type AccountSettingsV2UpdateResponse,
} from './accountSettingsApiV2.js';
