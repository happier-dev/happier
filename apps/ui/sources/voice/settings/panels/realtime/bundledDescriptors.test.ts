import { describe, expect, it } from 'vitest';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { getBundledVoiceProviderEntry } from '@/voice/registry/internalContributions';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

import { parseRealtimeSettingsDescriptor, resolveRealtimeProviderConfig } from './descriptor';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPrivacyDisclosure(value: unknown): unknown {
  return isRecord(value) ? value.privacyDisclosure : null;
}

function readPrivacyDisclosureFallback(value: unknown): string {
  const disclosure = readPrivacyDisclosure(value);
  if (typeof disclosure === 'string') return disclosure;
  return isRecord(disclosure) && typeof disclosure.fallback === 'string'
    ? disclosure.fallback
    : '';
}

describe('bundled realtime provider settings projection', () => {
  for (const [legacyProviderId, pluginId, localId] of [
    ['happier.voice.elevenlabs/realtime-elevenlabs', 'happier.voice.elevenlabs', 'realtime-elevenlabs'],
    ['happier.voice.openai/realtime-openai', 'happier.voice.openai', 'realtime-openai'],
    ['happier.voice.xai/realtime-grok', 'happier.voice.xai', 'realtime-grok'],
    ['happier.agent.codex/realtime-codex', 'happier.agent.codex', 'realtime-codex'],
  ] as const) {
    const providerId = buildQualifiedPluginContributionKey(
      createPluginContributionIdentity({ pluginId, localId }),
    );
    it(`renders ${providerId} through the same descriptor and settings-owner boundary`, () => {
      const entry = getBundledVoiceProviderEntry(providerId);
      expect(entry?.kind).toBe('voice.conversation-provider.v1');
      if (!entry || entry.kind !== 'voice.conversation-provider.v1') throw new Error('missing bundled provider');
      const createSettingsSection = entry.presentation?.createSettingsSection;
      const registryEntry = createDefaultVoiceProviderRegistry().get(providerId);
      const providerSettings = registryEntry?.providerSettings;
      if (legacyProviderId === 'happier.agent.codex/realtime-codex') {
        expect(createSettingsSection).toBeUndefined();
        expect(providerSettings)
          .toMatchObject({
            schemaVersion: 2,
            privacyDisclosure: {
              key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
            },
            connectedServicesBinding: {
              id: 'globalConnectedServices',
              agent: 'codex',
              serviceIds: ['openai-codex'],
            },
          });
        expect(registryEntry?.projectSettings?.({
          schemaVersion: 1,
          config: {},
        })).toEqual({ status: 'unsupported_version', modeId: null });
        expect(registryEntry?.projectSettings?.({
          schemaVersion: 2,
          config: { globalConnectedServices: null },
        })).toEqual({ status: 'missing_required_setting', modeId: 'experimental' });
        return;
      }
      if (legacyProviderId === 'happier.voice.elevenlabs/realtime-elevenlabs') {
        expect(readPrivacyDisclosure(providerSettings)).toBe(
          'Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.',
        );
      }
      if (legacyProviderId === 'happier.voice.openai/realtime-openai' || legacyProviderId === 'happier.voice.xai/realtime-grok') {
        expect(readPrivacyDisclosure(providerSettings)).toMatchObject({
          key: legacyProviderId === 'happier.voice.openai/realtime-openai'
            ? 'settingsVoice.realtimeProviders.openai.privacyDisclosure'
            : 'settingsVoice.realtimeProviders.xai.privacyDisclosure',
        });
        const disclosure = readPrivacyDisclosureFallback(providerSettings);
        expect(disclosure).toMatch(/audio/iu);
        expect(disclosure).toMatch(/context/iu);
        expect(disclosure).toMatch(/client-tool definitions/iu);
        expect(disclosure).toMatch(/delegated results/iu);
        expect(disclosure).toMatch(/server and relay do not carry live audio/iu);
        expect(disclosure).toMatch(/may retain/iu);
        expect(disclosure).toMatch(/context-sharing controls are separate/iu);
        expect(providerSettings).not.toHaveProperty('defaultConfig.mode');
        expect(isRecord(providerSettings)
          && typeof providerSettings.parseConfig === 'function'
          && isRecord(providerSettings.defaultConfig)
          ? providerSettings.parseConfig(providerSettings.defaultConfig)
          : null).not.toBeNull();
      }
      if (legacyProviderId === 'happier.voice.openai/realtime-openai') {
        expect(createSettingsSection).toBeUndefined();
        return;
      }
      expect(typeof createSettingsSection).toBe('function');
      if (typeof createSettingsSection !== 'function') throw new Error('invalid bundled provider settings descriptor');

      const descriptor = parseRealtimeSettingsDescriptor(providerId, createSettingsSection());
      expect(descriptor?.providerId).toBe(providerId);
      if (!isRecord(providerSettings)
        || typeof providerSettings.schemaVersion !== 'number'
        || !isRecord(providerSettings.defaultConfig)
        || typeof providerSettings.parseConfig !== 'function') throw new Error('invalid bundled provider settings owner');
      expect(descriptor?.fields.length).toBeGreaterThan(0);
      const resolved = resolveRealtimeProviderConfig({
        schemaVersion: providerSettings.schemaVersion,
        defaultConfig: providerSettings.defaultConfig,
        parseConfig: providerSettings.parseConfig as (value: unknown) => Readonly<Record<string, unknown>> | null,
      }, null);
      expect(resolved.status).toBe('ready');
      if (resolved.status !== 'ready') throw new Error('expected ready provider config');
      expect(JSON.stringify(resolved.config)).not.toMatch(/apiKey|accessToken|refreshToken|encryptedValue/iu);
    });
  }
});
