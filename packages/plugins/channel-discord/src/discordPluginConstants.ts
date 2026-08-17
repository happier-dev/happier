export const DISCORD_BOT_CONNECTED_ACCOUNT_ID = 'discord-bot';
export const DISCORD_BOT_CREDENTIAL_PURPOSE = 'discord-bot-credential';
export const DISCORD_BOT_TOKEN_ENVIRONMENT_KEY = 'DISCORD_BOT_TOKEN';
export const DISCORD_BRAND_RESOURCE_ID = 'brand-icon';
/** Host target-Action boundary for one current Discord Gateway worker. */
export const DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID = 'discord/gateway-worker-attempt';

export const DISCORD_CHANNEL_ACTION_IDS = Object.freeze({
  setup: 'discord/prepare-bot',
  connectionTest: 'discord/inspect-connection',
  endpointResolve: 'discord/choose-channel',
  messageDeliver: 'discord/post-message',
  connectionStop: 'discord/halt-gateway',
});
