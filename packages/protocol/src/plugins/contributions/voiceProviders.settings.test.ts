import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from './v2.js';

const baseContribution = Object.freeze({
  id: 'conversation',
  title: 'Conversation',
  kind: 'conversation' as const,
  roles: ['realtime_conversation' as const],
  platforms: ['web' as const],
  capabilities: {
    readiness: { requirements: [] },
    turn: { cancelResponse: false, bargeIn: false },
  },
  client: {
    artifactId: 'voice-runtime-web',
    modulePath: './voiceRuntime',
    exportName: 'activate' as const,
  },
});

describe('Voice provider structured settings declarations', () => {
  it('accepts a bounded localized privacy disclosure beside declarative account settings', () => {
    const parsed = PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...baseContribution,
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: 'codex',
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
          }],
        },
      }],
    }).success).toBe(true);
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
        message: 'Voice provider setting default must satisfy its declared JSON Schema.',
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
        message: 'Voice provider setting schema must be a valid bounded JSON Schema.',
      }));
    }
  });
});
