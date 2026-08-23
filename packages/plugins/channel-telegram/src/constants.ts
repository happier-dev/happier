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
 * Telegram's `getUpdates` stream is single-consumer: an `offset` confirms and
 * discards every earlier update. The Channels ingress already owns that one
 * cycle, so Automation Event occurrences are admitted from inside that same
 * poll rather than from a second observer that would steal its updates.
 *
 * The declaration that would project these ids is WITHHELD (see `plugin.ts`):
 * the inline admission holds no durable obligation, so nothing arms a Telegram
 * chat source yet, and the poll therefore reaches no Automation authority. The
 * ids stay canonical here for the withheld declaration and for the retained
 * admission in `automationEvents.ts`.
 */
export const TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID = 'automation/chat-message-v1';
export const TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID = 'telegram/setup-chat-event-source';
export const TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION = 1;
