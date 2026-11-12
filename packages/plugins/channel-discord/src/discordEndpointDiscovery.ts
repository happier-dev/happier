import type { ConversationEndpointKindV1 } from '@happier-dev/channels-protocol/v1';

import type { DiscordApiFailure, DiscordBotApi } from './discordApi.js';
import type { DiscordKnownChannel } from './discordEndpointResolution.js';

/** Read existing Discord channels only; name lookup never creates a DM. */
export async function readDiscordEndpointChannels(input: Readonly<{
  api: DiscordBotApi;
  query: string;
  kinds?: readonly ConversationEndpointKindV1[];
  signal: AbortSignal;
}>): Promise<readonly DiscordKnownChannel[] | DiscordApiFailure> {
  const query = input.query.trim();
  if (/^[0-9]+$/.test(query)) {
    const channel = await input.api.getChannel({ channelId: query }, { signal: input.signal });
    input.signal.throwIfAborted();
    if (channel?.kind === 'notReady') return channel;
    return channel === null ? [] : [channel];
  }
  if (input.kinds?.every(kind => kind === 'direct')) return [];
  const guilds = await input.api.listGuilds({ signal: input.signal });
  input.signal.throwIfAborted();
  if ('kind' in guilds) return guilds;
  const knownChannels: DiscordKnownChannel[] = [];
  for (const guildId of guilds) {
    const channels = await input.api.getGuildChannels({ guildId }, { signal: input.signal });
    input.signal.throwIfAborted();
    if ('kind' in channels) return channels;
    knownChannels.push(...channels);
    if (input.kinds !== undefined && !input.kinds.includes('thread')) continue;
    const threads = await input.api.getGuildActiveThreads({ guildId }, { signal: input.signal });
    input.signal.throwIfAborted();
    if ('kind' in threads) return threads;
    const parents = new Map(channels.map(channel => [channel.channelId, channel]));
    for (const thread of threads) {
      if (thread.kind !== 'thread' || thread.parentChannelId === undefined) {
        knownChannels.push(thread);
        continue;
      }
      const parent = parents.get(thread.parentChannelId);
      const parentLabel = parent !== undefined && 'label' in parent ? parent.label : undefined;
      knownChannels.push(parentLabel === undefined ? thread : { ...thread, parentLabel });
    }
  }
  return knownChannels;
}
