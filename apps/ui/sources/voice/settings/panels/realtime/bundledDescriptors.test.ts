import { describe, expect, it } from 'vitest';

import { getBundledVoiceUiEntry } from '@/voice/registry/internalContributions';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

import { parseRealtimeSettingsDescriptor, resolveRealtimeProviderConfig } from './descriptor';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPrivacyDisclosure(value: unknown): unknown {
  return isRecord(value) ? value.privacyDisclosure : null;
}

describe('bundled realtime provider settings projection', () => {
  for (const providerId of ['realtime_elevenlabs', 'realtime_openai', 'realtime_grok', 'realtime_codex']) {
    it(`renders ${providerId} through the same descriptor and settings-owner boundary`, () => {
      const entry = getBundledVoiceUiEntry(providerId);
      expect(entry?.kind).toBe('voice.conversation-provider.v1');
      if (!entry || entry.kind !== 'voice.conversation-provider.v1') throw new Error('missing bundled provider');
      const createSettingsSection = entry.internal.createSettingsSection;
      const registryEntry = createDefaultVoiceProviderRegistry().get(providerId);
      const internalProviderSettings = 'providerSettings' in entry.internal
        ? entry.internal.providerSettings
        : undefined;
      expect(registryEntry?.providerSettings && internalProviderSettings).toBeFalsy();
      const providerSettings = registryEntry?.providerSettings ?? internalProviderSettings;
      if (providerId === 'realtime_codex') {
        expect(createSettingsSection).toBeUndefined();
        expect(providerSettings)
          .toMatchObject({
            schemaVersion: 2,
            privacyDisclosure: {
              key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
            },
            connectedServicesBinding: {
              id: 'globalConnectedServices',
              agent: {
                pluginId: 'happier.agent.codex',
                localId: 'codex',
              },
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
        })).toEqual({ status: 'ready', modeId: 'experimental' });
        return;
      }
      if (providerId === 'realtime_elevenlabs') {
        expect(readPrivacyDisclosure(providerSettings)).toBe(
          'Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.',
        );
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
