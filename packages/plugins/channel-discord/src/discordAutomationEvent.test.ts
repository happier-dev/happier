import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/plugin-sdk/events';
import { describe, expect, it } from 'vitest';

import {
  DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS,
  DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
  DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
  DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
  createDiscordAutomationMessagePayload,
  createDiscordAutomationMessageSourceInstanceId,
  parseDiscordAutomationMessageSourceConfig,
} from './discordAutomationEvent.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { DISCORD_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const DISCORD_PLUGIN_ID = 'happier.channel.discord';

function readManifestEvent() {
  const events = PLUGIN_MANIFEST.contributes.events ?? [];
  return events.find((event) => event.id === DISCORD_AUTOMATION_MESSAGE_EVENT_ID);
}

describe('Discord Automation Event contribution', () => {
  it('withholds the Event, because this observer persists no cursor for either transport', () => {
    // The provider stores no Gateway position (the session id and last dispatch
    // sequence are locals of one socket run), so `checkpointedPull` has nothing
    // to resume from after process loss or a plugin reload, and `durablePush`
    // is unrepresentable without a webhook endpoint id. Until a real
    // history-capable observer exists, the plugin must offer no Automation
    // trigger that would silently drop Runs. See the withheld-declaration note
    // in `discordAutomationEvent.ts`.
    expect(readManifestEvent()).toBeUndefined();
    const events = PLUGIN_MANIFEST.contributes.events ?? [];
    expect(events.filter((event) => event.kind === 'event' && event.automation?.eligible === true))
      .toEqual([]);
    // The observer's own setup Action stays declared and registered so the
    // retained work keeps one entry point; the contract version it reports is
    // still this module's.
    const actions = PLUGIN_MANIFEST.contributes.actions ?? [];
    expect(actions.map((action) => action.id))
      .toContain(DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID);
    expect(DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION).toBe(1);
    expect(DISCORD_PLUGIN_ID).toBe(PLUGIN_MANIFEST.id);
  });

  it('projects one observed Gateway message into a filterable Automation payload', () => {
    const payload = createDiscordAutomationMessagePayload({
      observation: {
        v: 1,
        occurrenceId: 'discord:message:9001',
        occurredAt: 1_725_000_000_000,
        transport: { kind: 'socket' },
        endpoint: { kind: 'shared', audience: 'shared', id: 'discord:channel:4242' },
        actor: { principalId: 'discord:user:77', kind: 'human', isIntegrationSelf: false },
        message: {
          id: '9001',
          addressingEvidence: 'directIntegrationMention',
          contentProvenance: 'original',
          providerTimestamp: 1_725_000_000_000,
          text: 'hello @happier',
        },
      },
    });
    expect(payload).toEqual({
      v: 1,
      channelId: '4242',
      channelKind: 'shared',
      messageId: '9001',
      text: 'hello @happier',
      textTruncated: false,
      addressingEvidence: 'directIntegrationMention',
      contentProvenance: 'original',
      actorKind: 'human',
      actorPrincipalId: 'discord:user:77',
    });
  });

  it('parses only its own source-config contract and derives one stable source identity', () => {
    const config = parseDiscordAutomationMessageSourceConfig({
      v: 1,
      applicationId: '123',
      channelId: '4242',
    });
    expect(config).toEqual({ v: 1, applicationId: '123', channelId: '4242' });
    expect(createDiscordAutomationMessageSourceInstanceId(config))
      .toBe('discord:application:123:channel:4242');
    expect(parseDiscordAutomationMessageSourceConfig({ v: 2, applicationId: '1', channelId: '2' }))
      .toBeNull();
    expect(parseDiscordAutomationMessageSourceConfig({ v: 1, channelId: '2' })).toBeNull();
  });

  it('keeps the setup result inside the canonical host setup contract', () => {
    expect(() => PluginEventAutomationSetupResultV1Schema.parse({
      v: 1,
      sourceInstanceId: 'discord:application:123:channel:4242',
      sourceContractVersion: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
      sourceConfig: { v: 1, applicationId: '123', channelId: '4242' },
      displayLabel: '#general',
    })).not.toThrow();
  });

  it('localizes every message-source setup hint in every locale the plugin ships', () => {
    const referencedKeys = [
      DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS.title.key,
      DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS.description.key,
      DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS.submitLabel.key,
      ...DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS.fields.flatMap((field) => [
        field.title.key,
        field.description.key,
      ]),
    ];
    for (const bundle of DISCORD_UI_TRANSLATION_BUNDLES) {
      const messages = bundle.messages as Readonly<Record<string, string>>;
      const missing = referencedKeys.filter((key) => typeof messages[key] !== 'string');
      expect({ locale: bundle.locale, missing }).toEqual({ locale: bundle.locale, missing: [] });
    }
  });
});
