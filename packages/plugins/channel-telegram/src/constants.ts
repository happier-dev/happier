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
