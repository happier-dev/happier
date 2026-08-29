import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from './v2.js';

const baseContribution = Object.freeze({
  id: 'conversation',
  title: 'Conversation',
  kind: 'conversation' as const,
  roles: ['realtime_conversation' as const],
  platforms: ['web' as const],
  capabilities: {
    turn: { cancelResponse: false, bargeIn: false },
  },
  client: {
    artifactId: 'voice-runtime-web',
    modulePath: './voiceRuntime',
    exportName: 'activate' as const,
  },
});

function nestedJson(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    value = { next: value };
  }
  return value;
}

describe('Voice provider structured settings declarations', () => {
  it('accepts one canonical rich settings presentation for nested provider fields', () => {
    const parsed = PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...baseContribution,
        settings: {
          schemaVersion: 1,
          fields: [{
            id: 'config',
            title: 'Configuration',
            schema: { type: 'object', additionalProperties: true },
            default: { speed: 1 },
            presentation: { control: 'json' },
          }],
          presentation: {
            kind: 'voice.provider-settings.v1',
            modes: ['byo'],
            credential: { kind: 'none', catalog: null },
            links: { privacy: 'https://example.com/privacy' },
            fields: [{
              kind: 'range', path: 'config.speed', min: 0.7, max: 1.5, step: 0.05, reset: 1,
              titleKey: { key: 'voice.speed', fallback: 'Speed' },
            }],
          },
        },
      }],
    });

    expect(parsed.voiceProviders[0]?.settings?.presentation?.fields[0]).toMatchObject({
      kind: 'range',
      path: 'config.speed',
      reset: 1,
    });
  });

  it('rejects duplicate and unsafe rich presentation paths', () => {
    const settings = {
      schemaVersion: 1,
      fields: [{
        id: 'config', title: 'Configuration', schema: { type: 'object', additionalProperties: true },
        default: {}, presentation: { control: 'json' },
      }],
      presentation: {
        kind: 'voice.provider-settings.v1', modes: ['byo'],
        credential: { kind: 'none', catalog: null }, links: {},
        fields: [
          { kind: 'text', path: 'config.value' },
          { kind: 'text', path: 'config.value' },
        ],
      },
    };
    expect(PluginContributesV2Schema.safeParse({ voiceProviders: [{ ...baseContribution, settings }] }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...baseContribution,
        settings: {
          ...settings,
          presentation: {
            ...settings.presentation,
            fields: [{ kind: 'text', path: '__proto__.polluted' }],
          },
        },
      }],
    }).success).toBe(false);
  });

  it('accepts a localized disclosure without inventing a provider setting', () => {
    const parsed = PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...baseContribution,
        settings: {
          schemaVersion: 1,
          fields: [],
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.openai.privacyDisclosure',
            fallback: 'Audio and conversation content are processed by OpenAI.',
          },
        },
      }],
    });

    expect(parsed.voiceProviders[0]?.settings).toMatchObject({
      fields: [],
      privacyDisclosure: {
        key: 'settingsVoice.realtimeProviders.openai.privacyDisclosure',
      },
    });
  });

  it('accepts a bounded localized privacy disclosure beside declarative account settings', () => {
    const parsed = PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...baseContribution,
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: 'codex',
          supportedRuntimeVersions: ['1.2.3'],
        },
        settings: {
          schemaVersion: 2,
          fields: [],
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
            fallback: 'Audio and the conversation are sent to the provider.',
          },
          connectedServicesBinding: {
            id: 'account',
            title: 'Provider account',
            agent: 'codex',
            serviceIds: ['openai-codex'],
          },
        },
      }],
    });

    expect(parsed.voiceProviders[0]?.settings?.privacyDisclosure).toEqual({
      key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
      fallback: 'Audio and the conversation are sent to the provider.',
    });
  });

  it('accepts bounded JSON object fields for provider-owned nested runtime config', () => {
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...baseContribution,
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'tts',
            title: 'Text-to-speech',
            schema: {
              type: 'object',
              properties: {
                voiceId: { type: 'string', minLength: 1, maxLength: 256 },
                modelId: {
                  anyOf: [
                    { type: 'string', minLength: 1, maxLength: 256 },
                    { type: 'null' },
                  ],
                },
                voiceSettings: {
                  type: 'object',
                  properties: {
                    stability: {
                      anyOf: [
                        { type: 'number', minimum: 0, maximum: 1 },
                        { type: 'null' },
                      ],
                    },
                  },
                  required: ['stability'],
                  additionalProperties: false,
                },
              },
              required: ['voiceId', 'modelId', 'voiceSettings'],
              additionalProperties: false,
            },
            default: {
              voiceId: 'voice-default',
              modelId: null,
              voiceSettings: { stability: null },
            },
            presentation: { control: 'json' },
          }, {
            id: 'byo',
            title: 'Bring your own account',
            schema: {
              type: 'object',
              properties: {
                agentId: {
                  anyOf: [
                    { type: 'string', minLength: 1, maxLength: 256 },
                    { type: 'null' },
                  ],
                },
              },
              required: ['agentId'],
              additionalProperties: false,
            },
            default: { agentId: null },
            presentation: { control: 'json' },
          }, {
            id: 'agentId',
            title: 'Agent ID',
            schema: { type: 'string', maxLength: 256 },
            default: '',
            presentation: { control: 'text' },
          }],
          readiness: [{ kind: 'setting_nonempty', settingId: 'agentId' }],
        },
      }],
    }).success).toBe(true);
  });

  it('admits byte-small deeply nested JSON settings through the Voice contribution boundary', () => {
    const parsed = PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...baseContribution,
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'nested',
            title: 'Nested configuration',
            schema: { type: 'object', additionalProperties: true },
            default: nestedJson(128),
            presentation: { control: 'json' },
          }],
        },
      }],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a nested JSON default that violates its declared schema at the public contribution boundary', () => {
    const parsed = PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...baseContribution,
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'nested',
            title: 'Nested configuration',
            schema: {
              type: 'object',
              properties: {
                requiredValue: { type: 'string', minLength: 1 },
              },
              required: ['requiredValue'],
              additionalProperties: false,
            },
            default: {},
            presentation: { control: 'json' },
          }],
        },
      }],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ['voiceProviders', 0, 'settings', 'fields', 0, 'default'],
        message: 'Voice setting defaults must satisfy their schema.',
      }));
    }
  });

  it('rejects a malformed bounded JSON schema with a stable contribution issue', () => {
    const parsed = PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...baseContribution,
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'nested',
            title: 'Nested configuration',
            schema: {
              type: 'object',
              properties: {
                requiredValue: { type: 'string', pattern: '[' },
              },
              required: ['requiredValue'],
              additionalProperties: false,
            },
            default: { requiredValue: 'valid-before-pattern-compilation' },
            presentation: { control: 'json' },
          }],
        },
      }],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ['voiceProviders', 0, 'settings', 'fields', 0, 'schema'],
        message: 'Voice setting schemas must be valid bounded JSON Schema.',
      }));
    }
  });
});
