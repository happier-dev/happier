/**
 * The plugin's own manifest identity. The manifest declaration, the Event's
 * `setupActionRef`, admission `eventRef`s, and Connected Account reference
 * validation must all name the same plugin, so they read one spelling.
 */
export const DISCORD_PLUGIN_ID = 'happier.channel.discord';

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

/**
 * The single provider-owned spelling of a Discord conversation endpoint id.
 * Message classification, endpoint resolution, and Automation Event source
 * matching all read the same channel identity through this owner instead of
 * repeating the prefix, so a change here cannot desynchronize them.
 */
export const DISCORD_CHANNEL_ENDPOINT_ID_PREFIX = 'discord:channel:';

export function createDiscordChannelEndpointId(channelId: string): string {
  return `${DISCORD_CHANNEL_ENDPOINT_ID_PREFIX}${channelId}`;
}

export function readDiscordChannelEndpointId(endpointId: string): string | null {
  if (!endpointId.startsWith(DISCORD_CHANNEL_ENDPOINT_ID_PREFIX)) return null;
  return endpointId.slice(DISCORD_CHANNEL_ENDPOINT_ID_PREFIX.length).trim() || null;
}
