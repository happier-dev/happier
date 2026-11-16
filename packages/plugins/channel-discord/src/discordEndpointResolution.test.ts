import { describe, expect, it } from 'vitest';

import {
  resolveDiscordEndpointCandidates,
} from './discordEndpointResolution.js';

describe('Discord endpoint resolution', () => {
  it('maps provider-observed channels in canonical label and id order, independent of discovery order', () => {
    const candidates = resolveDiscordEndpointCandidates({
      query: 'support',
      knownChannels: [
        { channelId: 'dm-1', kind: 'direct', label: 'Alice' },
        { channelId: 'guild-1', kind: 'shared', label: 'Support' },
        { channelId: 'guild-0', kind: 'shared', label: 'Support' },
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
        kind: 'thread',
        audience: 'shared',
        id: 'discord:channel:thread-1',
        parentId: 'discord:channel:guild-1',
        label: 'Escalation',
        parentLabel: 'Support',
      },
      {
        kind: 'shared',
        audience: 'shared',
        id: 'discord:channel:guild-0',
        label: 'Support',
      },
      {
        kind: 'shared',
        audience: 'shared',
        id: 'discord:channel:guild-1',
        label: 'Support',
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

  it('never exposes a permission-only forum or media parent as an endpoint candidate', () => {
    expect(resolveDiscordEndpointCandidates({
      query: 'parent-1',
      knownChannels: [{
        channelId: 'parent-1',
        kind: 'permissionParent',
        guildId: 'guild-1',
        permissionOverwrites: [],
      }],
    })).toEqual([]);
  });

});
