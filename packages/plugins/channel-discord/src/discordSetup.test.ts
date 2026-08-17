import { describe, expect, it } from 'vitest';

import {
  DISCORD_BASE_GATEWAY_INTENTS,
  DISCORD_GUILDS_INTENT,
  DISCORD_MESSAGE_CONTENT_INTENT,
  DISCORD_REQUIRED_PERMISSIONS,
  buildDiscordInviteUrl,
  createDiscordSetupResult,
} from './discordSetup.js';

describe('Discord setup facts', () => {
  it('includes GUILDS alongside message events without requesting the privileged Guild Members intent', () => {
    expect(DISCORD_BASE_GATEWAY_INTENTS).toBe(
      DISCORD_GUILDS_INTENT | (1 << 9) | (1 << 12),
    );
    expect(DISCORD_BASE_GATEWAY_INTENTS & (1 << 1)).toBe(0);
  });

  it('derives both invite copy and its exact bot-only permission request from one permission table', () => {
    expect(DISCORD_REQUIRED_PERMISSIONS.map(({ id }) => id)).toEqual([
      'viewChannels',
      'sendMessages',
      'sendMessagesInThreads',
      'readMessageHistory',
    ]);

    const invite = new URL(buildDiscordInviteUrl('application-123'));
    expect(invite.origin + invite.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(invite.searchParams.get('client_id')).toBe('application-123');
    expect(invite.searchParams.get('scope')).toBe('bot');
    expect(invite.searchParams.get('permissions')).toBe('274877975552');
    expect(invite.searchParams.has('applications.commands')).toBe(false);
  });

  it('derives socket/session-bound setup facts from verified immutable application and bot IDs', () => {
    const credentialRef = {
      service: { pluginId: 'happier.channel.discord', localId: 'discord-bot' },
      accountId: 'bot-456',
    } as const;
    expect(createDiscordSetupResult({
      applicationId: 'application-123',
      botUserId: 'bot-456',
      botLabel: 'Happier Bot',
    }, credentialRef)).toEqual({
      v: 1,
      credentialRef,
      providerConnectionKey: 'discord:application:application-123',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-123',
        botUserId: 'bot-456',
        inviteUrl: buildDiscordInviteUrl('application-123'),
      },
      integrationPrincipal: { id: 'discord:bot:bot-456', label: 'Happier Bot' },
      supportedTransports: ['socket'],
      recommendedTransport: 'socket',
      overlapSafety: 'safe',
      replayContinuity: 'sessionBound',
      outboundTextLimit: { maximum: 2_000, unit: 'unicodeCodePoints' },
    });
  });

});
