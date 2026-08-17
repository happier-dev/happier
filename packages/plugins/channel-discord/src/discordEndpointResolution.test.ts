import { describe, expect, it } from 'vitest';

import {
  resolveDiscordEndpointCandidates,
} from './discordEndpointResolution.js';

describe('Discord endpoint resolution', () => {
  it('maps only provider-observed direct, guild, and thread channels to canonical endpoint ids', () => {
    const candidates = resolveDiscordEndpointCandidates({
      query: 'support',
      knownChannels: [
        { channelId: 'dm-1', kind: 'direct', label: 'Alice' },
        { channelId: 'guild-1', kind: 'shared', label: 'Support' },
        {
          channelId: 'thread-1',
          kind: 'thread',
          label: 'Escalation',
          parentChannelId: 'guild-1',
          parentLabel: 'Support',
        },
      ],
    });

    expect(candidates).toEqual([
      {
        kind: 'shared',
        audience: 'shared',
        id: 'discord:channel:guild-1',
        label: 'Support',
      },
      {
        kind: 'thread',
        audience: 'shared',
        id: 'discord:channel:thread-1',
        parentId: 'discord:channel:guild-1',
        label: 'Escalation',
        parentLabel: 'Support',
      },
    ]);
  });

  it('marks provider-observed direct-message channels as direct audiences', () => {
    expect(resolveDiscordEndpointCandidates({
      query: 'alice',
      knownChannels: [{ channelId: 'dm-1', kind: 'direct', label: 'Alice' }],
    })).toEqual([
      {
        kind: 'direct',
        audience: 'direct',
        id: 'discord:channel:dm-1',
        label: 'Alice',
      },
    ]);
  });

  it('does not invent a direct-message channel from a user query', () => {
    const candidates = resolveDiscordEndpointCandidates({
      query: 'alice',
      knownChannels: [{ channelId: 'shared-1', kind: 'shared', label: 'General' }],
    });

    expect(candidates).toEqual([]);
    expect(candidates).not.toContainEqual(expect.objectContaining({ id: 'discord:channel:alice' }));
  });

});
