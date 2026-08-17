import type {
  ConversationEndpointKindV1,
  ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';

import type { DiscordPermissionOverwriteEvidence } from './discordSetup.js';

export type DiscordKnownChannel = Readonly<{
  channelId: string;
  kind: 'direct' | 'shared' | 'thread';
  label?: string;
  parentChannelId?: string;
  parentLabel?: string;
  guildId?: string;
  permissionOverwrites?: readonly DiscordPermissionOverwriteEvidence[];
}>;

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function matchesQuery(query: string, values: readonly (string | undefined)[]): boolean {
  const normalizedQuery = query.toLocaleLowerCase();
  return values.some((value) => value !== undefined && value.toLocaleLowerCase().includes(normalizedQuery));
}

function endpointFromKnownChannel(channel: DiscordKnownChannel): ConversationResolvedEndpointV1 {
  const channelId = requireNonEmpty(channel.channelId, 'Discord channel ID');
  const label = channel.label?.trim();
  if (channel.kind === 'direct') {
    return {
      kind: 'direct',
      audience: 'direct',
      id: `discord:channel:${channelId}`,
      ...(label ? { label } : {}),
    };
  }
  if (channel.kind === 'shared') {
    return {
      kind: 'shared',
      audience: 'shared',
      id: `discord:channel:${channelId}`,
      ...(label ? { label } : {}),
    };
  }
  const parentChannelId = requireNonEmpty(channel.parentChannelId ?? '', 'Discord thread parent channel ID');
  const parentLabel = channel.parentLabel?.trim();
  return {
    kind: 'thread',
    audience: 'shared',
    id: `discord:channel:${channelId}`,
    parentId: `discord:channel:${parentChannelId}`,
    ...(label ? { label } : {}),
    ...(parentLabel ? { parentLabel } : {}),
  };
}

/**
 * Resolution is deliberately constrained to channels Discord has already
 * returned to the provider. In particular, a Discord user id or display name
 * never becomes a guessed `/users/@me/channels` direct-message destination.
 */
export function resolveDiscordEndpointCandidates(input: Readonly<{
  query: string;
  knownChannels: readonly DiscordKnownChannel[];
  kinds?: readonly ConversationEndpointKindV1[];
}>): readonly ConversationResolvedEndpointV1[] {
  const query = requireNonEmpty(input.query, 'Discord endpoint query');
  const allowedKinds = input.kinds ? new Set(input.kinds) : null;
  const seen = new Set<string>();
  const resolved: ConversationResolvedEndpointV1[] = [];

  for (const channel of input.knownChannels) {
    if (allowedKinds && !allowedKinds.has(channel.kind)) continue;
    const candidate = endpointFromKnownChannel(channel);
    if (!matchesQuery(query, [channel.channelId, channel.label, channel.parentChannelId, channel.parentLabel])) continue;
    const dedupeKey = `${candidate.kind}:${candidate.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    resolved.push(candidate);
  }
  return resolved;
}
