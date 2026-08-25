export const TELEGRAM_BOT_CONNECTED_ACCOUNT_ID = 'telegram-bot';
export const TELEGRAM_BOT_CREDENTIAL_PURPOSE = 'telegram-bot-credential';
export const TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID = 'telegram-provider';
export const TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY = 'TELEGRAM_BOT_TOKEN';

export const TELEGRAM_CHANNEL_ACTION_IDS = Object.freeze({
  setup: 'telegram/prepare-bot',
  setupRemediation: 'telegram/remove-webhook',
  connectionTest: 'telegram/inspect-connection',
  endpointResolve: 'telegram/choose-chat',
  observationsPoll: 'telegram/poll-updates',
  messageDeliver: 'telegram/post-message',
});

/**
 * Telegram's `getUpdates` stream is single-consumer: the Channels poll owns
 * its checkpoint, emits this Event candidate with the observation, and owns
 * the resulting durable obligation. The provider's admit action only matches
 * an already-armed source; it never owns a second poll or checkpoint.
 */
export const TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID = 'automation/chat-message-v1';
export const TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID = 'telegram/setup-chat-event-source';
export const TELEGRAM_AUTOMATION_MESSAGE_ADMIT_ACTION_ID = 'telegram/admit-automation-event';
export const TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION = 1;
