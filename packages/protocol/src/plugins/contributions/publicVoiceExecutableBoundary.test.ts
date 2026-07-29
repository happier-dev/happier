import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from './catalog.js';
import { PluginContributesV2Schema } from './v2.js';

describe('public voice executable contribution boundary', () => {
  it('accepts unique non-empty web/iOS/Android platform subsets', () => {
    expect(PluginContributesV2Schema.parse({
      voiceProviders: [{
        id: 'conversation',
        title: 'Conversation',
        kind: 'conversation',
        roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
        platforms: ['web', 'ios', 'android'],
        capabilities: {
          readiness: { requirements: [] },
          turn: {
            cancelResponse: true,
            bargeIn: true,
            clearInput: true,
            resumption: 'resume',
            replay: 'stable_ids',
            exactMessage: true,
            interruptionPolicy: 'provider_immediate',
          },
        },
        client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
      }],
    }).voiceProviders).toEqual([expect.objectContaining({
      id: 'conversation',
      platforms: ['web', 'ios', 'android'],
      capabilities: expect.objectContaining({
        turn: expect.objectContaining({
          clearInput: true,
          resumption: 'resume',
          replay: 'stable_ids',
          exactMessage: true,
          interruptionPolicy: 'provider_immediate',
        }),
      }),
    })]);
  });

  it('catalogs the declaration as one required Voice registration right', () => {
    const catalog = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'voiceProviders');
    expect(catalog).toMatchObject({
      identityField: 'id',
      activationDemand: 'registration',
      allowedRuntimeRegistration: 'voiceProviders',
      consumer: 'voice-host',
      platforms: ['web', 'ios', 'android'],
    });
    expect(protocol).toHaveProperty('PluginVoiceProviderContributionV1Schema');
  });

  it('uses the canonical contribution-reference vocabulary for declaration-gated Agent realtime', () => {
    const base = {
      id: 'conversation',
      title: 'Conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: [] },
        turn: { cancelResponse: false, bargeIn: false },
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    } as const;

    for (const agent of [
      'codex',
      { pluginId: 'happier.agent.codex', localId: 'codex' },
    ] as const) {
      expect(PluginContributesV2Schema.parse({
        voiceProviders: [{
          ...base,
          execution: { kind: 'experimental_agent_session_realtime', agent },
          settings: {
            schemaVersion: 2,
            fields: [],
            connectedServicesBinding: {
              id: 'globalConnectedServices',
              title: 'Agent account',
              agent,
              serviceIds: ['openai-codex'],
            },
          },
        }],
      }).voiceProviders[0]).toMatchObject({
        execution: { kind: 'experimental_agent_session_realtime', agent },
      });
    }
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...base,
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: { pluginId: 'happier.agent.codex', localId: 'codex', sessionId: 'forbidden' },
        },
      }],
    }).success).toBe(false);
  });

  it('declares an exact Agent-scoped Connected Services binding for Agent-session realtime settings', () => {
    const agent = { pluginId: 'happier.agent.codex', localId: 'codex' } as const;
    const contribution = {
      id: 'conversation',
      title: 'Conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: [] },
        turn: { cancelResponse: false, bargeIn: false },
      },
      execution: { kind: 'experimental_agent_session_realtime', agent },
      settings: {
        schemaVersion: 2,
        fields: [],
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Codex account',
          agent,
          serviceIds: ['openai-codex'],
        },
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    } as const;

    expect(PluginContributesV2Schema.parse({
      voiceProviders: [contribution],
    }).voiceProviders[0]).toMatchObject({
      settings: {
        schemaVersion: 2,
        fields: [],
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          agent,
          serviceIds: ['openai-codex'],
        },
      },
    });
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        settings: {
          ...contribution.settings,
          connectedServicesBinding: {
            ...contribution.settings.connectedServicesBinding,
            serviceIds: [],
          },
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        settings: {
          ...contribution.settings,
          connectedServicesBinding: {
            ...contribution.settings.connectedServicesBinding,
            serviceIds: ['openai-codex', 'openai-codex'],
          },
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        settings: {
          ...contribution.settings,
          connectedServicesBinding: {
            ...contribution.settings.connectedServicesBinding,
            serviceIds: ['not-a-service'],
          },
        },
      }],
    }).success).toBe(false);
  });

  it('does not turn a client Voice registration into daemon activation demand', () => {
    const contributes = PluginContributesV2Schema.parse({
      voiceProviders: [{
        id: 'conversation',
        title: 'Conversation',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: {
          readiness: { requirements: [] },
          turn: { cancelResponse: true, bargeIn: false },
        },
        client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
      }],
    });

    expect(protocol.derivePluginContributionRegistrationRights(contributes)).toEqual([
      { family: 'voiceProviders', localId: 'conversation' },
    ]);
    expect(protocol.derivePluginDaemonContributionRegistrationRights(contributes)).toEqual([]);
  });

  it('derives only speech declarations as daemon Voice registration rights', () => {
    const contributes = PluginContributesV2Schema.parse({
      voiceProviders: [{
        id: 'speech',
        title: 'Speech',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'],
        platforms: ['web', 'ios', 'android'],
        capabilities: {
          readiness: { requirements: ['credential'] },
        },
      }],
    });

    expect(protocol.derivePluginContributionRegistrationRights(contributes)).toEqual([
      { family: 'voiceProviders.speech', localId: 'speech' },
    ]);
    expect(protocol.derivePluginDaemonContributionRegistrationRights(contributes)).toEqual([
      { family: 'voiceProviders.speech', localId: 'speech' },
    ]);
  });

  it('rejects qualified ids, empty/duplicate/unknown/desktop platforms, non-activate exports, and duplicate local ids', () => {
    const valid = {
      id: 'conversation',
      title: 'Conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: [] },
        turn: { cancelResponse: false, bargeIn: false },
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    } as const;

    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{ ...valid, id: 'acme.voice/conversation' }],
    }).success).toBe(false);
    for (const platforms of [[], ['web', 'web'], ['desktop'], ['windows']] as const) {
      expect(PluginContributesV2Schema.safeParse({
        voiceProviders: [{ ...valid, platforms }],
      }).success).toBe(false);
    }
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{ ...valid, client: { ...valid.client, exportName: 'createVoiceRuntime' } }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [valid, valid],
    }).success).toBe(false);
  });

  it('accepts the credential requirement used by bundled public leaves and rejects unearned daemon requirements', () => {
    const contribution = {
      id: 'conversation',
      title: 'Conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: ['credential'] },
        turn: { cancelResponse: false, bargeIn: false },
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    } as const;

    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [contribution],
    }).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        capabilities: {
          ...contribution.capabilities,
          readiness: { requirements: ['execution_machine'] },
        },
      }],
    }).success).toBe(false);
  });

  it('accepts only bounded non-secret settings controls owned by the Voice provider config envelope', () => {
    const contribution = {
      id: 'conversation',
      title: 'Configurable conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: [] },
        turn: { cancelResponse: false, bargeIn: false },
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'voice',
          title: 'Voice',
          description: 'The provider-native voice used for new sessions.',
          schema: { type: 'string', enum: ['calm', 'bright'] },
          default: 'calm',
          presentation: {
            control: 'select',
            options: [
              { value: 'calm', title: 'Calm' },
              { value: 'bright', title: 'Bright' },
            ],
          },
        }, {
          id: 'expressive',
          title: 'Expressive delivery',
          schema: { type: 'boolean' },
          default: false,
          presentation: { control: 'switch' },
        }],
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    } as const;

    expect(PluginContributesV2Schema.parse({
      voiceProviders: [contribution],
    }).voiceProviders[0]).toMatchObject({
      settings: {
        schemaVersion: 1,
        fields: [
          { id: 'voice', default: 'calm', presentation: { control: 'select' } },
          { id: 'expressive', default: false, presentation: { control: 'switch' } },
        ],
      },
    });

    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        settings: {
          schemaVersion: 1,
          fields: [{
            id: 'apiKey',
            title: 'API key',
            schema: { type: 'string' },
            secret: true,
            presentation: { control: 'text' },
          }],
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        settings: {
          schemaVersion: 1,
          fields: [{
            id: 'configFile',
            title: 'Configuration file',
            schema: { type: 'string' },
            default: '/tmp/provider.json',
            presentation: { control: 'text' },
          }],
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        settings: {
          schemaVersion: 1,
          fields: [{
            id: 'mode',
            title: 'Mode',
            schema: { type: 'string', enum: ['default'] },
            default: 'default',
            presentation: {
              control: 'select',
              options: [{ value: 'default', title: 'Default' }],
            },
          }],
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        settings: {
          schemaVersion: 1,
          fields: [
            contribution.settings.fields[0],
            contribution.settings.fields[0],
          ],
        },
      }],
    }).success).toBe(false);
  });

  it('accepts distinct bounded client-auth and read-only catalog operations', () => {
    const contribution = {
      id: 'conversation',
      title: 'Credentialed conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: ['credential'] },
        turn: { cancelResponse: true, bargeIn: false },
      },
      accountMediation: {
        credentialSlots: [{ id: 'api_key', scope: 'account' }],
        operations: [{
          id: 'mint-session',
          purpose: 'voice.client-auth',
          credentialSlotId: 'api_key',
          effect: 'read',
          request: {
            origin: 'https://voice.example.test',
            pathTemplate: '/v1/session',
            queryTemplate: [],
            headerTemplate: [
              { name: 'accept', value: 'application/json' },
              { name: 'content-type', value: 'application/json' },
            ],
            bodyTemplate: { kind: 'json', value: {} },
            method: 'POST',
            credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
            redirect: 'error',
            maxBodyBytes: 64 * 1024,
            contentTypes: ['application/json'],
          },
          parameters: {
            schema: {
              type: 'object',
              properties: { body: { type: 'object', additionalProperties: true } },
              required: ['body'],
              additionalProperties: false,
            },
            mapping: [{ parameter: 'body', target: { kind: 'body', pointer: '' } }],
          },
          response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
        }, {
          id: 'list-voices',
          purpose: 'voice.catalog.voices',
          credentialSlotId: 'api_key',
          effect: 'read',
          request: {
            origin: 'https://voice.example.test',
            pathTemplate: '/v1/voices',
            queryTemplate: [],
            headerTemplate: [{ name: 'accept', value: 'application/json' }],
            bodyTemplate: { kind: 'none' },
            method: 'GET',
            credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
            redirect: 'error',
            maxBodyBytes: 0,
            contentTypes: [],
          },
          parameters: {
            schema: { type: 'object', properties: {}, additionalProperties: false },
            mapping: [],
          },
          response: { maxBytes: 2 * 1024 * 1024, contentTypes: ['application/json'] },
        }],
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    } as const;

    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [contribution],
    }).success).toBe(true);
  });

  it('rejects unsupported slot breadth, catalog-only mediation, colliding actions, undeclared slots, and a mutating catalog request', () => {
    const operations = [{
      id: 'mint-session',
      purpose: 'voice.client-auth',
      credentialSlotId: 'api_key',
      effect: 'read' as const,
      request: {
        origin: 'https://voice.example.test',
        pathTemplate: '/v1/session',
        queryTemplate: [],
        headerTemplate: [{ name: 'content-type', value: 'application/json' }],
        bodyTemplate: { kind: 'json' as const, value: {} },
        method: 'POST' as const,
        credential: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
        redirect: 'error' as const,
        maxBodyBytes: 64 * 1024,
        contentTypes: ['application/json'],
      },
      parameters: {
        schema: {
          type: 'object' as const,
          properties: { body: { type: 'object' as const, additionalProperties: true } },
          required: ['body'],
          additionalProperties: false,
        },
        mapping: [{ parameter: 'body', target: { kind: 'body' as const, pointer: '' } }],
      },
      response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
    }, {
      id: 'list-voices',
      purpose: 'voice.catalog.voices',
      credentialSlotId: 'api_key',
      effect: 'read' as const,
      request: {
        origin: 'https://voice.example.test',
        pathTemplate: '/v1/voices',
        queryTemplate: [],
        headerTemplate: [{ name: 'accept', value: 'application/json' }],
        bodyTemplate: { kind: 'none' as const },
        method: 'GET' as const,
        credential: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
        redirect: 'error' as const,
        maxBodyBytes: 0,
        contentTypes: [],
      },
      parameters: {
        schema: { type: 'object' as const, properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: { maxBytes: 2 * 1024 * 1024, contentTypes: ['application/json'] },
    }];
    const contribution = {
      id: 'conversation',
      title: 'Credentialed conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: ['credential'] },
        turn: { cancelResponse: true, bargeIn: false },
      },
      accountMediation: {
        credentialSlots: [{ id: 'api_key', scope: 'account' }],
        operations,
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    } as const;

    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        accountMediation: {
          ...contribution.accountMediation,
          credentialSlots: [
            { id: 'api_key', scope: 'account' },
            { id: 'api_key', scope: 'account' },
          ],
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        accountMediation: {
          ...contribution.accountMediation,
          credentialSlots: [
            ...contribution.accountMediation.credentialSlots,
            { id: 'secondary_key', scope: 'account' },
          ],
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        accountMediation: {
          ...contribution.accountMediation,
          operations: [],
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        accountMediation: {
          ...contribution.accountMediation,
          operations: contribution.accountMediation.operations.map((operation, index) => (
            index === 1 ? { ...operation, credentialSlotId: 'missing' } : operation
          )),
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        accountMediation: {
          ...contribution.accountMediation,
          operations: contribution.accountMediation.operations.map((operation, index) => (
            index === 0 ? { ...operation, credentialSlotId: 'missing' } : operation
          )),
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        accountMediation: {
          ...contribution.accountMediation,
          operations: contribution.accountMediation.operations.map((operation, index) => (
            index === 1 ? { ...operation, id: 'mint-session' } : operation
          )),
        },
      }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        ...contribution,
        accountMediation: {
          ...contribution.accountMediation,
          operations: contribution.accountMediation.operations.map((operation, index) => (
            index === 1 ? { ...operation, purpose: 'voice.client-auth' } : operation
          )),
        },
      }],
    }).success).toBe(false);
  });

  it('rejects speech-only roles that the conversation-provider preview cannot implement', () => {
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        id: 'conversation',
        title: 'Conversation',
        kind: 'conversation',
        roles: ['dictation_stt'],
        platforms: ['web'],
        capabilities: {
          readiness: { requirements: [] },
          turn: { cancelResponse: false, bargeIn: false },
        },
        client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
      }],
    }).success).toBe(false);
  });

  it('retains declarative voice model packs', () => {
    expect(PluginContributesV2Schema.parse({})).toHaveProperty('voiceModelPacks', []);
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.some((entry) => entry.manifestKey === 'voiceModelPacks')).toBe(true);
  });
});
