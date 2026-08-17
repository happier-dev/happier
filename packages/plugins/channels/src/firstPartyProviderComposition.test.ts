import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  assertConversationProviderContributionV1,
} from '@happier-dev/channels-protocol/testing/v1';
import {
  activate as activateDiscord,
  PLUGIN_MANIFEST as DISCORD_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-channel-discord';
import {
  activate as activateTelegram,
  PLUGIN_MANIFEST as TELEGRAM_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-channel-telegram';
import {
  activate as activateGithub,
  PLUGIN_MANIFEST as GITHUB_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-scm-github';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { CHANNELS_PROVIDER_POINT_REF, PLUGIN_MANIFEST } from './manifest.js';

/**
 * Converts the public testkit's structural fixture snapshot into the exact
 * transient selection accepted by Channels setup. The testkit, not this test,
 * owns parsed-declaration discovery and opaque operation-handle issuance.
 * Production CLI cold admission is covered by the target-owner suite.
 */
function providerSelection(testkit: PluginTestkit): PluginTargetedContributionSelectionV1 {
  const snapshot = testkit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF);
  const contribution = snapshot.contributions[0];
  if (contribution === undefined || snapshot.contributions.length !== 1) {
    throw new Error('Expected exactly one structural first-party Channels provider fixture contribution.');
  }
  return {
    target: {
      pluginId: CHANNELS_PROVIDER_POINT_REF.targetPluginId,
      immutableGenerationId: snapshot.generation,
    },
    point: {
      pointId: CHANNELS_PROVIDER_POINT_REF.id,
      protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
    },
    contributor: contribution.contributor,
  };
}

function jsonResponse(value: unknown, finalUrl: string): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status: 200,
    finalUrl,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

describe('Channels first-party provider composition', () => {
  it('uses Telegram\'s declared arbitrary-local setup handle through the core preparation owner', async () => {
    assertConversationProviderContributionV1(TELEGRAM_PLUGIN_MANIFEST);
    const telegramCredential = {
      service: { pluginId: 'happier.channel.telegram', localId: 'telegram-bot' },
      accountId: 'telegram-account',
    } as const;
    const telegramAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { TELEGRAM_BOT_TOKEN: '123:bot-token' },
      })),
    };
    const telegramHttp = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => jsonResponse(
        request.url.endsWith('/getWebhookInfo')
          ? { ok: true, result: { url: '', pending_update_count: 0 } }
          : {
              ok: true,
              result: {
                id: 123,
                is_bot: true,
                first_name: 'Happier Bot',
                username: 'HappierBot',
                can_read_all_group_messages: false,
              },
            },
        request.url,
      )),
    };
    const telegram = await createPluginTestkit({
      manifest: TELEGRAM_PLUGIN_MANIFEST,
      module: { activate: activateTelegram },
      services: { connectedAccounts: telegramAccounts, http: telegramHttp },
    });
    const telegramCore = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      targetedContributionContributors: [telegram],
    });

    try {
      await expect(telegramCore.invokeAction('connection/prepare-v1', {
        providerSelection: providerSelection(telegramCore),
        providerSetupInput: { credentialRef: telegramCredential },
        credentialRef: telegramCredential,
      })).resolves.toEqual({
        kind: 'ready',
        supportedTransports: ['checkpointedPull'],
        recommendedTransport: 'checkpointedPull',
        overlapSafety: 'providerExclusive',
        replayContinuity: 'checkpointed',
        outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
        destinationLabel: 'Happier Bot',
      });
      expect(telegramAccounts.materialize).toHaveBeenCalledWith(
        'telegram-bot-credential',
        { kind: 'environment', keys: ['TELEGRAM_BOT_TOKEN'] },
        expect.objectContaining({ expectedAccount: telegramCredential }),
      );
    } finally {
      await telegramCore.dispose();
      await telegram.dispose();
    }
  });

  it('uses Discord\'s declared arbitrary-local setup handle through the core preparation owner', async () => {
    const discordCredential = {
      service: { pluginId: 'happier.channel.discord', localId: 'discord-bot' },
      accountId: 'discord-account',
    } as const;
    const discordAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { DISCORD_BOT_TOKEN: 'discord-token' },
      })),
    };
    const discordHttp = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => {
        if (request.url.endsWith('/oauth2/applications/@me')) {
          return jsonResponse({ id: 'application-1', name: 'Happier Discord' }, request.url);
        }
        if (request.url.endsWith('/users/@me')) {
          return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true }, request.url);
        }
        if (request.url.endsWith('/gateway/bot')) {
          return jsonResponse({
            url: 'wss://gateway.discord.gg',
            session_start_limit: {
              total: 1_000,
              remaining: 999,
              reset_after: 86_400_000,
              max_concurrency: 1,
            },
          }, request.url);
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      }),
    };
    assertConversationProviderContributionV1(DISCORD_PLUGIN_MANIFEST);
    const discord = await createPluginTestkit({
      manifest: DISCORD_PLUGIN_MANIFEST,
      module: { activate: activateDiscord },
      services: { connectedAccounts: discordAccounts, http: discordHttp },
    });
    const discordCore = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      targetedContributionContributors: [discord],
    });

    try {
      await expect(discordCore.invokeAction('connection/prepare-v1', {
        providerSelection: providerSelection(discordCore),
        providerSetupInput: { credentialRef: discordCredential },
        credentialRef: discordCredential,
      })).resolves.toEqual({
        kind: 'ready',
        supportedTransports: ['socket'],
        recommendedTransport: 'socket',
        overlapSafety: 'safe',
        replayContinuity: 'sessionBound',
        outboundTextLimit: { maximum: 2_000, unit: 'unicodeCodePoints' },
        destinationLabel: 'Happier',
      });
      expect(discordAccounts.materialize).toHaveBeenCalledWith(
        'discord-bot-credential',
        { kind: 'environment', keys: ['DISCORD_BOT_TOKEN'] },
        expect.objectContaining({ expectedAccount: discordCredential }),
      );
    } finally {
      await discordCore.dispose();
      await discord.dispose();
    }
  });

  it('uses GitHub\'s declared arbitrary-local setup handle through the core preparation owner', async () => {
    const githubCredential = {
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
      accountId: 'github-account',
    } as const;
    const githubAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer github-token' },
      })),
    };
    const githubHttp = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => {
        if (request.url === 'https://api.github.com/repos/acme/widgets') {
          return jsonResponse({
            id: 77,
            name: 'widgets',
            full_name: 'acme/widgets',
            owner: { login: 'acme' },
          }, request.url);
        }
        if (request.url === 'https://api.github.com/user') {
          return jsonResponse({ id: 99, login: 'happier-bot' }, request.url);
        }
        throw new Error(`Unexpected GitHub request: ${request.url}`);
      }),
    };
    assertConversationProviderContributionV1(GITHUB_PLUGIN_MANIFEST);
    const github = await createPluginTestkit({
      manifest: GITHUB_PLUGIN_MANIFEST,
      module: { activate: activateGithub },
      services: { connectedAccounts: githubAccounts, http: githubHttp },
    });
    const githubCore = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      targetedContributionContributors: [github],
    });

    try {
      await expect(githubCore.invokeAction('connection/prepare-v1', {
        providerSelection: providerSelection(githubCore),
        providerSetupInput: { credentialRef: githubCredential, repository: 'acme/widgets' },
        credentialRef: githubCredential,
      })).resolves.toEqual({
        kind: 'ready',
        supportedTransports: ['checkpointedPull'],
        recommendedTransport: 'checkpointedPull',
        overlapSafety: 'safe',
        replayContinuity: 'checkpointed',
        outboundTextLimit: { maximum: 65_536, unit: 'utf8Bytes' },
        destinationLabel: 'happier-bot',
      });
      expect(githubAccounts.materialize).toHaveBeenCalledWith(
        'github-connected-account',
        {
          kind: 'httpHeaders',
          origin: 'https://api.github.com',
          headerNames: ['authorization'],
        },
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          expectedAccount: githubCredential,
        }),
      );
    } finally {
      await githubCore.dispose();
      await github.dispose();
    }
  });
});
