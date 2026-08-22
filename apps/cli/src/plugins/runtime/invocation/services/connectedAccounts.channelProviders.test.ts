import { describe, expect, it, vi } from 'vitest';

import {
    createStablePluginConnectedAccountsHost,
    type StablePluginConnectedAccountsOwner,
} from './connectedAccounts';
import type {
    PluginConnectedAccountBindingScope,
    PluginInvocationServicesSeed,
} from './types';

type ChannelProviderPurpose = Readonly<{
    pluginId: string;
    actionId: string;
    purpose: string;
    serviceId: string;
}>;

const TELEGRAM_PROVIDER_PURPOSE: ChannelProviderPurpose = Object.freeze({
    pluginId: 'happier.channel.telegram',
    actionId: 'telegram/prepare-bot',
    purpose: 'telegram-bot-credential',
    serviceId: 'telegram-bot',
});

const DISCORD_PROVIDER_PURPOSE: ChannelProviderPurpose = Object.freeze({
    pluginId: 'happier.channel.discord',
    actionId: 'discord/prepare-bot',
    purpose: 'discord-bot-credential',
    serviceId: 'discord-bot',
});

function connectedAccountScope(provider: ChannelProviderPurpose): PluginConnectedAccountBindingScope {
    return Object.freeze({
        purpose: provider.purpose,
        serviceRefs: Object.freeze([Object.freeze({
            pluginId: provider.pluginId,
            localId: provider.serviceId,
        })]),
        operations: Object.freeze(['use'] as const),
        materializationKinds: Object.freeze(['environment'] as const),
    });
}

function createActionSeed(provider: ChannelProviderPurpose): PluginInvocationServicesSeed {
    return Object.freeze({
        plugin: Object.freeze({ id: provider.pluginId, version: '0.0.0' }),
        contribution: Object.freeze({
            id: provider.actionId,
            qualifiedId: `${provider.pluginId}/actions/${provider.actionId}`,
        }),
        generation: 'channel-provider-generation',
        correlationId: `channel-provider:${provider.actionId}`,
        surface: 'plugin',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
    });
}

function createConnectedAccountsService(
    provider: ChannelProviderPurpose,
    environment: Readonly<Record<string, string>>,
) {
    const scope = connectedAccountScope(provider);
    const materialize = vi.fn(async () => Object.freeze({
        kind: 'environment' as const,
        env: Object.freeze({ ...environment }),
    }));
    const owner: StablePluginConnectedAccountsOwner = Object.freeze({
        getBinding: async () => null,
        requestSelection: async () => {
            throw new Error('Channel provider setup does not select an account.');
        },
        materialize,
        listAccounts: async () => Object.freeze({ status: 'complete' as const, accounts: Object.freeze([]) }),
        materializeListedAccount: async () => {
            throw new Error('Channel provider setup does not materialize a listed account.');
        },
        watch: () => Object.freeze({ dispose() {} }),
    });
    const service = createStablePluginConnectedAccountsHost(owner).bind(
        createActionSeed(provider),
        [scope],
    );
    return { scope, materialize, service };
}

describe('Channel provider Connected Account purposes', () => {
    it('rejects a descriptor service id before it reaches the Connected Account owner', async () => {
        const { scope, materialize, service } = createConnectedAccountsService(
            TELEGRAM_PROVIDER_PURPOSE,
            { TELEGRAM_BOT_TOKEN: 'telegram-token' },
        );

        await expect(service.materialize(scope.serviceRefs[0]!.localId, {
            kind: 'environment',
            keys: ['TELEGRAM_BOT_TOKEN'],
        })).rejects.toMatchObject({ code: 'plugin_connected_account_purpose_undeclared' });
        expect(materialize).not.toHaveBeenCalled();
    });

    it('passes each declared provider purpose to the canonical owner', async () => {
        const telegram = createConnectedAccountsService(
            TELEGRAM_PROVIDER_PURPOSE,
            { TELEGRAM_BOT_TOKEN: 'telegram-token' },
        );
        const discord = createConnectedAccountsService(
            DISCORD_PROVIDER_PURPOSE,
            { DISCORD_BOT_TOKEN: 'discord-token' },
        );

        await expect(telegram.service.materialize(TELEGRAM_PROVIDER_PURPOSE.purpose, {
            kind: 'environment',
            keys: ['TELEGRAM_BOT_TOKEN'],
        })).resolves.toMatchObject({
            kind: 'environment',
            env: { TELEGRAM_BOT_TOKEN: 'telegram-token' },
        });
        await expect(discord.service.materialize(DISCORD_PROVIDER_PURPOSE.purpose, {
            kind: 'environment',
            keys: ['DISCORD_BOT_TOKEN'],
        })).resolves.toMatchObject({
            kind: 'environment',
            env: { DISCORD_BOT_TOKEN: 'discord-token' },
        });

        expect(telegram.materialize).toHaveBeenCalledWith(expect.objectContaining({
            purpose: {
                consumer: { pluginId: 'happier.channel.telegram', localId: 'telegram/prepare-bot' },
                purpose: TELEGRAM_PROVIDER_PURPOSE.purpose,
            },
        }));
        expect(discord.materialize).toHaveBeenCalledWith(expect.objectContaining({
            purpose: {
                consumer: { pluginId: 'happier.channel.discord', localId: 'discord/prepare-bot' },
                purpose: DISCORD_PROVIDER_PURPOSE.purpose,
            },
        }));
    });
});
