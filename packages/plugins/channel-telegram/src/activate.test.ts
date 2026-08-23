import { ConversationProvidersContributionProtocolV1 } from '@happier-dev/channels-protocol/v1';
import { assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import {
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
  TELEGRAM_BOT_CREDENTIAL_PURPOSE,
  TELEGRAM_CHANNEL_ACTION_IDS,
} from './constants.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { TELEGRAM_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const telegramAccount = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.channel.telegram', localId: 'telegram-bot' }),
  accountId: 'bot:123',
});
const telegramSetupInput = Object.freeze({ credentialRef: telegramAccount });

const TELEGRAM_CHANNEL_PROVIDER_OPERATIONS = Object.freeze({
  setup: TELEGRAM_CHANNEL_ACTION_IDS.setup,
  setupRemediation: TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation,
  connectionTest: TELEGRAM_CHANNEL_ACTION_IDS.connectionTest,
  endpointResolve: TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve,
  observationsPoll: TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll,
  messageDeliver: TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver,
});

function response(value: unknown): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status: 200,
    finalUrl: 'https://api.telegram.org/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function coreContext(services: Pick<PluginInvocationContext['services'], 'connectedAccounts' | 'http'>): PluginInvocationContext {
  return {
    plugin: { id: 'happier.channel.telegram', version: '0.0.0' },
    contribution: {
      id: TELEGRAM_CHANNEL_ACTION_IDS.setup,
      qualifiedId: `happier.channel.telegram/actions/${TELEGRAM_CHANNEL_ACTION_IDS.setup}`,
    },
    surface: 'plugin',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: {
        id: 'connection-setup-v1',
        qualifiedId: 'happier.channels/actions/connection-setup-v1',
      },
    },
    signal: new AbortController().signal,
    // This fixture only supplies the two genuine system boundaries consumed by
    // the provider Action; its host-stamped caller and cancellation are real.
    services: services as PluginInvocationContext['services'],
  };
}

describe('Telegram Channel plugin activation', () => {
  it('withholds the Automation Event declaration while its occurrence has no durable obligation', () => {
    // Telegram `getUpdates` is single-consumer: one `offset` confirms and
    // discards every earlier update for every reader of the bot. The admission
    // in `automationEvents.ts` runs inline inside that shared cycle and holds
    // no durable obligation, so declaring the Event would force a catalog or
    // admission outage to choose between losing occurrences and stalling
    // Channel delivery for every user of the bot. Nothing may arm a Telegram
    // chat source until the occurrence is persisted in the canonical Channels
    // ingress store before the shared offset advances.
    expect(PLUGIN_MANIFEST.contributes.events ?? []).toEqual([]);
    // Withholding the declaration is not deleting the work: the setup Action
    // stays declared so the retained admission keeps its one registered entry
    // point, and it is reachable only from the `plugin` surface, so nothing
    // user-facing can offer an Automation that cannot exist.
    expect(PLUGIN_MANIFEST.contributes.actions.find(
      ({ id }) => id === TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
    )).toMatchObject({ surfaces: ['plugin'] });
  });

  it('publishes the complete plugin-owned UI translation bundles', () => {
    expect(PLUGIN_MANIFEST.contributes.ui.translations).toEqual(TELEGRAM_UI_TRANSLATION_BUNDLES);
  });

  it('serializes one checkpointed-pull provider contribution through arbitrary local Actions', async () => {
    assertConversationProviderContributionV1(PLUGIN_MANIFEST);
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions).toEqual([{
        id: 'telegram-provider',
        target: { pluginId: 'happier.channels', pointId: 'providers' },
        protocol: { id: 'happier.channels/providers', version: 1 },
        operations: TELEGRAM_CHANNEL_PROVIDER_OPERATIONS,
      }]);
      expect(testkit.registrations()).toEqual([
        ...Object.values(TELEGRAM_CHANNEL_ACTION_IDS).map((localId) => ({ family: 'actions' as const, localId })),
        { family: 'actions' as const, localId: TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID },
        { family: 'connectedAccountDescriptors', localId: 'telegram-bot' },
      ]);

      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('connectionStop');
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('deliveryReconcile');
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('principalResolve');
    } finally {
      await testkit.dispose();
    }
  });

  it('declares remote Telegram delivery and setup remediation as writesRemote', () => {
    const action = (id: string) => PLUGIN_MANIFEST.contributes.actions.find((candidate) => candidate.id === id);

    for (const id of [
      TELEGRAM_CHANNEL_ACTION_IDS.setup,
      TELEGRAM_CHANNEL_ACTION_IDS.connectionTest,
      TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve,
      TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll,
    ]) {
      expect(action(id)?.dangerLevel).toBe('safe');
    }
    expect(action(TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver)?.dangerLevel).toBe('writesRemote');
    expect(action(TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation)).toMatchObject({
      dangerLevel: 'writesRemote',
      confirmation: {
        title: 'Remove Telegram webhook?',
        confirmLabel: 'Remove webhook',
      },
    });
  });

  it('registers only its supported polling-provider roles and Connected Account runtime through the manifest', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(testkit.registrations()).toEqual([
        { family: 'actions', localId: TELEGRAM_CHANNEL_ACTION_IDS.setup },
        { family: 'actions', localId: TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation },
        { family: 'actions', localId: TELEGRAM_CHANNEL_ACTION_IDS.connectionTest },
        { family: 'actions', localId: TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve },
        { family: 'actions', localId: TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll },
        { family: 'actions', localId: TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver },
        { family: 'actions', localId: TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID },
        { family: 'connectedAccountDescriptors', localId: 'telegram-bot' },
      ]);

      const setup = PLUGIN_MANIFEST.contributes.actions.find(
        ({ id }) => id === TELEGRAM_CHANNEL_ACTION_IDS.setup,
      );
      expect(setup?.resultSchema).toEqual(
        ConversationProvidersContributionProtocolV1.operations.setup.declaration.resultSchema.jsonSchema,
      );
      // The declared document carries the JSON Schema dialect once, at its
      // root; the composed account-ref subschema contributes only its shape.
      const { $schema: _accountRefDialect, ...credentialRefSchema } = QualifiedConnectedAccountRefJsonSchema;
      expect(setup?.inputSchema).toEqual({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          credentialRef: credentialRefSchema,
        },
        required: ['credentialRef'],
        additionalProperties: false,
      });
      expect(setup).toMatchObject({
        surfaces: ['plugin'],
        hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
        inputHints: {
          fields: [
            {
              path: 'credentialRef',
              widget: 'select',
              connectedAccountOptions: true,
              required: true,
            },
          ],
        },
      });
      expect(setup?.inputHints?.fields).not.toContainEqual(expect.objectContaining({ widget: 'secret' }));
      expect(PLUGIN_MANIFEST.hostAccess.required.filter(({ capability }) => capability === 'connectedAccounts'))
        .toEqual([expect.objectContaining({
          id: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
          scope: {
            serviceRefs: ['telegram-bot'],
            operations: ['select', 'use'],
            materializationKinds: ['environment'],
          },
        })]);
      expect(PLUGIN_MANIFEST.contributes.actions.map(({ id }) => id)).toEqual([
        TELEGRAM_CHANNEL_ACTION_IDS.setup,
        TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation,
        TELEGRAM_CHANNEL_ACTION_IDS.connectionTest,
        TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve,
        TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll,
        TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver,
        TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
      ]);
      for (const action of PLUGIN_MANIFEST.contributes.actions) {
        expect(action.execution).toEqual({ target: 'daemon' });
      }
      const setupRemediation = PLUGIN_MANIFEST.contributes.actions.find(
        ({ id }) => id === TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation,
      );
      expect(setupRemediation).toMatchObject({
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: {
            credentialRef: credentialRefSchema,
          },
          required: ['credentialRef'],
          additionalProperties: false,
        },
        resultSchema: ConversationProvidersContributionProtocolV1.operations.setupRemediation
          .declaration.resultSchema.jsonSchema,
        surfaces: ConversationProvidersContributionProtocolV1.operations.setupRemediation.declaration.surfaces,
        dangerLevel: ConversationProvidersContributionProtocolV1.operations.setupRemediation.declaration.dangerLevel,
      });
      for (const [id, role] of [
        [TELEGRAM_CHANNEL_ACTION_IDS.connectionTest, ConversationProvidersContributionProtocolV1.operations.connectionTest],
        [TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve, ConversationProvidersContributionProtocolV1.operations.endpointResolve],
        [TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll, ConversationProvidersContributionProtocolV1.operations.observationsPoll],
        [TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver, ConversationProvidersContributionProtocolV1.operations.messageDeliver],
      ] as const) {
        const action = PLUGIN_MANIFEST.contributes.actions.find((candidate) => candidate.id === id);
        expect(action?.inputSchema).toEqual(role.declaration.input.schema.jsonSchema);
        expect(action?.resultSchema).toEqual(role.declaration.resultSchema.jsonSchema);
        expect(action?.surfaces).toEqual(role.declaration.surfaces);
        expect(action?.dangerLevel).toBe(role.declaration.dangerLevel);
      }
    } finally {
      await testkit.dispose();
    }
  });

  it('requires a host-stamped Channels caller before a provider Action can use credentials', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      await expect(testkit.invokeAction(
        TELEGRAM_CHANNEL_ACTION_IDS.setup,
        telegramSetupInput,
        { surface: 'plugin' },
      )).rejects.toMatchObject({ code: 'telegram_channels_core_caller_required' });
    } finally {
      await testkit.dispose();
    }
  });

  it('rejects a setup credential reference outside the Telegram Connected Account service', async () => {
    const connectedAccounts = {
      materialize: vi.fn(),
    };
    const http = { request: vi.fn() };
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const setup = testkit.registration('actions', TELEGRAM_CHANNEL_ACTION_IDS.setup);
      if (!setup) throw new Error('Expected the Telegram setup Action registration');

      await expect(setup({
        credentialRef: {
          ...telegramAccount,
          service: { ...telegramAccount.service, pluginId: 'happier.channel.other' },
        },
      }, coreContext({ connectedAccounts, http }))).rejects.toMatchObject({
        code: 'telegram_setup_credential_invalid',
      });
      expect(connectedAccounts.materialize).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
    } finally {
      await testkit.dispose();
    }
  });

  it('uses the declared selected bot account for setup and returns only setup facts', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { TELEGRAM_BOT_TOKEN: '123:bot-token' },
      })),
    };
    const http = {
      request: vi.fn(async (input: Readonly<{ url: string }>) => response(
        input.url.endsWith('/getWebhookInfo')
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
      )),
    };
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const setup = testkit.registration('actions', TELEGRAM_CHANNEL_ACTION_IDS.setup);
      if (!setup) throw new Error('Expected the Telegram setup Action registration');

      await expect(setup(telegramSetupInput, coreContext({ connectedAccounts, http }))).resolves.toEqual({
        v: 1,
        credentialRef: telegramAccount,
        providerConnectionKey: 'telegram-bot:123',
        providerConfigVersion: 1,
        providerConfig: {
          botUsername: 'HappierBot',
          canReadAllGroupMessages: false,
        },
        integrationPrincipal: { id: '123', label: 'Happier Bot' },
        supportedTransports: ['checkpointedPull'],
        recommendedTransport: 'checkpointedPull',
        overlapSafety: 'providerExclusive',
        replayContinuity: 'checkpointed',
        outboundTextLimit: { maximum: 4096, unit: 'unicodeCodePoints' },
        // This bot has group privacy enabled, so Telegram withholds ordinary
        // group and supergroup messages. Setup carries that authenticated
        // truth so no binding can promise `allAllowedMessages` there.
        sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
        pairingDeepLinkTemplate: 'https://t.me/HappierBot?start={{token}}',
      });
      expect(connectedAccounts.materialize).toHaveBeenCalledWith(
        TELEGRAM_BOT_CREDENTIAL_PURPOSE,
        { kind: 'environment', keys: ['TELEGRAM_BOT_TOKEN'] },
        expect.objectContaining({ expectedAccount: telegramAccount }),
      );
    } finally {
      await testkit.dispose();
    }
  });

  it('rejects an active Telegram webhook during polling setup without deleting it', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { TELEGRAM_BOT_TOKEN: '123:bot-token' },
      })),
    };
    const http = {
      request: vi.fn(async (input: Readonly<{ url: string }>) => response(
        input.url.endsWith('/getWebhookInfo')
          ? { ok: true, result: { url: 'https://other.example/telegram', pending_update_count: 2 } }
          : {
              ok: true,
              result: {
                id: 123,
                is_bot: true,
                first_name: 'Happier Bot',
                username: 'HappierBot',
              },
            },
      )),
    };
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const setup = testkit.registration('actions', TELEGRAM_CHANNEL_ACTION_IDS.setup);
      if (!setup) throw new Error('Expected the Telegram setup Action registration');

      await expect(setup(telegramSetupInput, coreContext({ connectedAccounts, http }))).resolves.toEqual({
        kind: 'requiresRemediation',
      });
      expect(http.request).toHaveBeenCalledTimes(2);
      expect(http.request.mock.calls.map(([input]) => input.url)).not.toContain(
        expect.stringContaining('/deleteWebhook'),
      );
    } finally {
      await testkit.dispose();
    }
  });

});
