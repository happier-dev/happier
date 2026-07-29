import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  PluginContributesV2Schema,
  createRecipientContractDigestV1,
  createVoiceProviderRecipientContractV1,
  type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';

import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { createPluginUiExecutableModuleHost } from '@/components/plugins/reactNative/executableModuleHost';
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
  getVoiceAdapterRegistry,
  registerVoiceAdapters,
  resolveVoiceAdapterSurfaceCapabilities,
} from '@/voice/session/voiceAdapterRegistry';
import {
  readVoiceProviderSettingsConfig,
  voiceSettingsParse,
  writeVoiceProviderSettingsConfig,
} from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';

import {
  createExternalVoiceProviderRuntimeContribution,
  createExternalVoiceProviderActivationScope,
  type PluginVoiceConversationProviderContributionV1,
} from './externalVoiceProviderActivation';
import {
  listExternalVoiceProviderRegistrations,
  subscribeExternalVoiceProviderRegistrations,
} from './externalVoiceProviderRegistrations';
import {
  createBundledConversationRuntimeHostLease,
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';

function requireConversationDeclaration(
  declaration: PluginVoiceProviderContributionV1,
): PluginVoiceConversationProviderContributionV1 {
  if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
  return declaration;
}

const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
  voiceProviders: [{
    id: 'conversation',
    title: 'Synthetic Conversation',
    kind: 'conversation',
    roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
    platforms: ['web'],
    capabilities: {
      readiness: { requirements: [] },
      turn: {
        cancelResponse: true,
        bargeIn: false,
        clearInput: true,
        resumption: 'resume',
        replay: 'stable_ids',
        exactMessage: true,
        interruptionPolicy: 'provider_immediate',
      },
    },
    client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
  }],
}).voiceProviders[0]!);

const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
  pluginId: 'acme.synthetic-voice',
  contributionId: declaration.client.artifactId,
  artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  hostAppVersion: '2.0.0',
  hostUiApiVersion: '1.0.0',
  reactVersion: '19.0.0',
  reactNativeVersion: '0.83.4',
  platform: 'web',
  channel: 'internal',
  nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  projectionGeneration: 12,
});

function createProviderLeaf(input?: Readonly<{ setInputMuted?(muted: boolean): Promise<void> | void }>) {
  return {
    protocol: {
      async prepare() {
        return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
      },
      decodeControl: () => [],
      encodeTurnControl: (action: string) => action === 'cancel_response' ? { type: 'cancel' } : null,
    },
    async createConnection() {
      let open = false;
      return {
        kind: 'sdk_handle' as const,
        async connect() { open = true; },
        async sendControl() {},
        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        async close() { open = false; },
        state: () => open ? 'open' as const : 'closed' as const,
        currentProviderSessionId: () => null,
        playbackCursorMs: () => null,
        beginOutputInterruptionCandidate: () => 'unsupported' as const,
        resolveOutputInterruptionCandidate() {},
      };
    },
    encodeToolResults: () => [],
    encodeToolContinuation: (responseId: string) => ({ type: 'continue', responseId }),
    encodeContextUpdate: (text: string) => [{ type: 'context', text }],
    encodeTextTurn: (text: string) => [{ type: 'text', text }],
    async forgetProviderConversation() {},
    requiresMicForConnection: false,
    setInputMuted: input?.setInputMuted ?? (() => {}),
  };
}

describe('external Voice provider activation', () => {
  it('installs exact direct/global Agent-session binding from the public declaration', async () => {
    const agent = Object.freeze({
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    });
    const agentRealtimeDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'agent-realtime',
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent,
        },
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
      }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    const resolveAgentBinding = vi.fn(async (
      input: Parameters<typeof hostLease.host.resolveAgentRealtimeVoiceConversationBinding>[0],
    ): Promise<Readonly<{
      conversationSessionId: string;
      transcriptMode: 'native_session';
      targetSessionId: string | null;
    }> | null> => Object.freeze({
      conversationSessionId: input.controlSessionId === hostLease.host.globalVoiceSessionId
        ? 'hidden-codex'
        : input.controlSessionId,
      transcriptMode: 'native_session' as const,
      targetSessionId: input.requestedTargetSessionId,
    }));
    const host = Object.freeze({
      ...hostLease.host,
      resolveAgentRealtimeVoiceConversationBinding: resolveAgentBinding,
    });
    const providerId = 'acme.synthetic-voice/agent-realtime';
    const providerRef = Object.freeze({
      pluginId: identity.pluginId,
      localId: agentRealtimeDeclaration.id,
    });
    const contribution = createExternalVoiceProviderRuntimeContribution({
      host,
      platform: 'web',
      providerId,
      providerRef,
      declaration: agentRealtimeDeclaration,
      runtime: createProviderLeaf(),
    });
    onTestFinished(async () => {
      await contribution.dispose();
      hostLease.revoke();
    });

    expect(contribution.adapter.resolveSurfaceCapabilities?.({
      voice: {
        providerId,
        providers: {
          [providerId]: {
            schemaVersion: 2,
            config: {
              globalConnectedServices: {
                v: 1,
                bindingsByServiceId: {
                  'openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'codex-account-a',
                  },
                },
              },
            },
          },
        },
      },
    })).toMatchObject({
      agentRuntime: agent,
    });

    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: 'visible-codex-session',
      requestedTargetSessionId: 'ignored-direct-target',
      settings: {
        voice: {
          providerId,
          providers: {
            [providerId]: {
              schemaVersion: 2,
              config: {
                globalConnectedServices: {
                  v: 1,
                  bindingsByServiceId: {
                    'openai-codex': {
                      source: 'connected',
                      selection: 'profile',
                      profileId: 'must-be-ignored-by-direct',
                    },
                  },
                },
              },
            },
          },
        },
      },
    })).resolves.toMatchObject({
      conversationSessionId: 'visible-codex-session',
      transcriptMode: 'native_session',
    });
    expect(resolveAgentBinding).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: providerRef,
      agent,
      controlSessionId: 'visible-codex-session',
    }));
    expect(resolveAgentBinding.mock.lastCall?.[0]).not.toHaveProperty('connectedServices');

    resolveAgentBinding.mockClear();
    resolveAgentBinding.mockResolvedValueOnce(null);
    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: 'mismatched-direct-session',
      requestedTargetSessionId: null,
      settings: {
        voice: {
          providerId,
          providers: {},
        },
      },
    })).resolves.toBeNull();
    expect(resolveAgentBinding).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: 'mismatched-direct-session',
      provider: providerRef,
      agent,
    }));
    expect(resolveAgentBinding.mock.lastCall?.[0]).not.toHaveProperty('connectedServices');

    resolveAgentBinding.mockClear();
    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: hostLease.host.globalVoiceSessionId,
      requestedTargetSessionId: null,
      settings: {
        voice: {
          providerId,
          providers: {
            [providerId]: {
              schemaVersion: 2,
              config: { globalConnectedServices: null },
            },
          },
        },
      },
    })).resolves.toBeNull();
    expect(resolveAgentBinding).not.toHaveBeenCalled();

    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: hostLease.host.globalVoiceSessionId,
      requestedTargetSessionId: null,
      settings: {
        voice: {
          providerId,
          providers: {
            [providerId]: {
              schemaVersion: 2,
              config: {
                globalConnectedServices: {
                  v: 1,
                  bindingsByServiceId: {
                    'openai-codex': {
                      source: 'connected',
                      selection: 'profile',
                      profileId: 'codex-account-a',
                    },
                    github: {
                      source: 'connected',
                      selection: 'profile',
                      profileId: 'must-not-be-admitted',
                    },
                  },
                },
              },
            },
          },
        },
      },
    })).resolves.toBeNull();
    expect(resolveAgentBinding).not.toHaveBeenCalled();

    const connectedServices = Object.freeze({
      v: 1 as const,
      bindingsByServiceId: Object.freeze({
        'openai-codex': Object.freeze({
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'codex-account-a',
        }),
      }),
    });
    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: hostLease.host.globalVoiceSessionId,
      requestedTargetSessionId: null,
      settings: {
        voice: {
          providerId,
          providers: {
            [providerId]: {
              schemaVersion: 2,
              config: { globalConnectedServices: connectedServices },
            },
          },
        },
      },
    })).resolves.toMatchObject({ conversationSessionId: 'hidden-codex' });
    expect(resolveAgentBinding).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: providerRef,
      agent,
      connectedServices,
    }));
  });

  it('does not project an Agent recovery target for direct-media execution', () => {
    const hostLease = createBundledConversationRuntimeHostLease();
    const providerId = 'acme.synthetic-voice/conversation';
    const contribution = createExternalVoiceProviderRuntimeContribution({
      host: hostLease.host,
      platform: 'web',
      providerId,
      providerRef: Object.freeze({
        pluginId: identity.pluginId,
        localId: declaration.id,
      }),
      declaration,
      runtime: createProviderLeaf(),
    });
    onTestFinished(async () => {
      await contribution.dispose();
      hostLease.revoke();
    });

    expect(contribution.adapter.resolveSurfaceCapabilities?.({
      voice: {
        providerId,
        providers: {
          [providerId]: {
            schemaVersion: 1,
            config: { mode: 'default' },
          },
        },
      },
    })).not.toHaveProperty('agentRuntime');
  });

  it('fails closed when the declared binding Agent differs from execution authority', () => {
    const mismatchedDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        settings: {
          schemaVersion: 2,
          fields: [],
          connectedServicesBinding: {
            id: 'globalConnectedServices',
            title: 'Wrong Agent account',
            agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
            serviceIds: ['anthropic'],
          },
        },
      }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    onTestFinished(() => hostLease.revoke());

    expect(() => createExternalVoiceProviderRuntimeContribution({
      host: hostLease.host,
      platform: 'web',
      providerId: 'acme.synthetic-voice/conversation',
      providerRef: Object.freeze({
        pluginId: identity.pluginId,
        localId: mismatchedDeclaration.id,
      }),
      declaration: mismatchedDeclaration,
      runtime: createProviderLeaf(),
    })).toThrow(/voice_agent_realtime_binding_agent_mismatch/u);
  });

  it('rejects broad host-controller registration from an external plugin', async () => {
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, declarations: [declaration], hostPlatform: 'web',
    });
    expect(() => Reflect.apply(scope.api.voiceProviders.register, undefined, ['conversation', {
      engineKind: 'realtime', async start() {}, async stop() {}, async toggle() {},
      async interrupt() {}, async setMuted() {}, sendContextUpdate() {},
      getSnapshot: () => ({
        adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
      }),
    }])).toThrow(/invalid_external_voice_provider_leaf_registration/u);
    await scope.unwind();
  });

  it('does not grant hosted ElevenLabs lifecycle authority to an external identity collision', async () => {
    const copiedDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'realtime-elevenlabs',
        title: 'ElevenLabs',
      }],
    }).voiceProviders[0]!);
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: 'happier.voice.elevenlabs',
      declarations: [copiedDeclaration],
      hostPlatform: 'web',
    });

    expect(() => scope.api.voiceProviders.register('realtime-elevenlabs', {
      ...createProviderLeaf(),
      fetchHostedVoiceToken: vi.fn(),
      completeHostedVoiceSession: vi.fn(),
    } as ReturnType<typeof createProviderLeaf>)).toThrow(
      /invalid_external_voice_provider_leaf_registration/u,
    );
    await scope.unwind();
  });

  it('fails closed when the existing VoiceSessionRuntime host is unavailable', async () => {
    const revokedHost = createBundledConversationRuntimeHostLease();
    revokedHost.revoke();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, declarations: [declaration], hostPlatform: 'web',
    });
    scope.api.voiceProviders.register('conversation', createProviderLeaf());
    await expect(scope.commit()).rejects.toThrow(/voice_runtime_host_unavailable/u);
    await scope.unwind();
  });

  it('withdraws external adapter authority synchronously when its Voice runtime host is replaced', async () => {
    const firstHost = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, declarations: [declaration], hostPlatform: 'web',
    });
    scope.api.voiceProviders.register('conversation', createProviderLeaf());
    await scope.commit();
    const providerId = 'acme.synthetic-voice/conversation';
    expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();

    const replacementHost = createBundledConversationRuntimeHostLease();
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();

    await scope.unwind();
    firstHost.revoke();
    replacementHost.revoke();
  });

  it('commits every declared provider registered by one shared executable module', async () => {
    const secondDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{ ...declaration, id: 'conversation-b', title: 'Synthetic Conversation B' }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId,
      declarations: [declaration, secondDeclaration],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });

    scope.api.voiceProviders.register(declaration.id, createProviderLeaf());
    scope.api.voiceProviders.register(secondDeclaration.id, createProviderLeaf());
    await scope.commit();

    expect(listExternalVoiceProviderRegistrations()
      .filter((entry) => entry.pluginId === identity.pluginId)
      .map((entry) => entry.localId)
      .sort()).toEqual(['conversation', 'conversation-b']);
  });

  it('projects one bounded provider-owned settings descriptor through the exact qualified Voice envelope', async () => {
    const configurableDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'configurable-conversation',
        settings: {
          schemaVersion: 1,
          fields: [{
            id: 'voice',
            title: 'Voice',
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
      }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId,
      declarations: [configurableDeclaration],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });
    scope.api.voiceProviders.register(configurableDeclaration.id, createProviderLeaf());
    await scope.commit();

    const providerId = 'acme.synthetic-voice/configurable-conversation';
    const descriptor = createDefaultVoiceProviderRegistry().get(providerId)!;
    expect(descriptor.providerSettings).toMatchObject({
      schemaVersion: 1,
      defaultConfig: { mode: 'default', voice: 'calm', expressive: false },
      fields: [
        { id: 'voice', presentation: { control: 'select' } },
        { id: 'expressive', presentation: { control: 'switch' } },
      ],
    });
    expect(descriptor.projectSettings?.({
      schemaVersion: 1,
      config: { mode: 'default', voice: 'bright', expressive: true },
    })).toEqual({ status: 'ready', modeId: 'default' });
    expect(descriptor.projectSettings?.({
      schemaVersion: 1,
      config: { mode: 'default', voice: 'unknown', expressive: true },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(descriptor.projectSettings?.({
      schemaVersion: 1,
      config: { mode: 'default', voice: 'bright', expressive: true, apiKey: 'must-not-pass' },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(descriptor.projectSettings?.({
      schemaVersion: 2,
      config: { mode: 'default', voice: 'bright', expressive: true },
    })).toEqual({ status: 'unsupported_version', modeId: null });

    const parsed = voiceSettingsParse({
      providerId,
      providers: {
        [providerId]: {
          schemaVersion: 1,
          config: { mode: 'default', voice: 'bright', expressive: true },
        },
      },
    });
    expect(readVoiceProviderSettingsConfig(parsed, providerId)).toEqual({
      mode: 'default',
      voice: 'bright',
      expressive: true,
    });
    expect(writeVoiceProviderSettingsConfig(parsed, providerId, {
      mode: 'default',
      voice: 'calm',
      expressive: false,
    }).providers[providerId]).toEqual({
      schemaVersion: 1,
      config: { mode: 'default', voice: 'calm', expressive: false },
    });
  });

  it('projects only the one exact clientAuth account slot and rejects ambiguous declarations', async () => {
    const credentialDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'credential-conversation',
        capabilities: {
          ...declaration.capabilities,
          readiness: { requirements: ['credential'] },
        },
        accountMediation: {
          credentialSlots: [{ id: 'api_key', scope: 'account' }],
          operations: [{
            id: 'client-auth',
            purpose: 'voice.client-auth',
            credentialSlotId: 'api_key',
            effect: 'read',
            request: {
              origin: 'https://voice.example.test',
              pathTemplate: '/v1/session',
              queryTemplate: [],
              headerTemplate: [],
              bodyTemplate: { kind: 'none' },
              method: 'POST',
              credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
              redirect: 'error',
              maxBodyBytes: 0,
              contentTypes: [],
            },
            parameters: {
              schema: { type: 'object', properties: {}, additionalProperties: false },
              mapping: [],
            },
            response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
          }],
        },
      }],
    }).voiceProviders[0]!);
    const recipientContract = createVoiceProviderRecipientContractV1({
      package: {
        pluginId: identity.pluginId,
        source: { kind: 'package', locator: identity.pluginId },
      },
      publisher: {
        trust: 'verified',
        identity: `package:${identity.pluginId}`,
      },
      contribution: {
        pluginId: identity.pluginId,
        localId: credentialDeclaration.id,
      },
      accountMediation: credentialDeclaration.accountMediation!,
      presentation: { title: credentialDeclaration.title },
    });
    const undeclaredSlot = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'undeclared-credential',
        capabilities: {
          ...declaration.capabilities,
          readiness: { requirements: ['credential'] },
        },
      }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId,
      declarations: [credentialDeclaration, undeclaredSlot],
      hostPlatform: 'web',
      recipientContractsByLocalId: {
        [credentialDeclaration.id]: recipientContract,
      },
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });
    scope.api.voiceProviders.register(credentialDeclaration.id, createProviderLeaf());
    scope.api.voiceProviders.register(undeclaredSlot.id, createProviderLeaf());
    await scope.commit();

    const registrations = listExternalVoiceProviderRegistrations()
      .filter((entry) => entry.pluginId === identity.pluginId);
    expect(registrations.find((entry) => entry.localId === credentialDeclaration.id)?.descriptor?.accountCredentialSlot)
      .toEqual({
        id: 'api_key',
        scope: 'account',
        kind: 'apiKey',
        recipientContract,
        recipientContractDigest: createRecipientContractDigestV1(recipientContract),
      });
    expect(registrations.find((entry) => entry.localId === undeclaredSlot.id)?.descriptor?.accountCredentialSlot)
      .toBeUndefined();

    const ambiguousDeclaration = {
      ...credentialDeclaration,
      accountMediation: {
        ...credentialDeclaration.accountMediation!,
        credentialSlots: [
          { id: 'api_key', scope: 'account' },
          { id: 'api_key', scope: 'account' },
        ],
      },
    };
    expect(() => createExternalVoiceProviderActivationScope({
      pluginId: 'acme.invalid-voice',
      declarations: [ambiguousDeclaration as typeof credentialDeclaration],
      hostPlatform: 'web',
    })).toThrow(/invalid_external_voice_provider_declaration/u);
  });

  it('disposes already-constructed providers when a later shared-module provider cannot be constructed', async () => {
    const incompatibleDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'conversation-b',
        title: 'Synthetic Conversation B',
        capabilities: {
          ...declaration.capabilities,
          turn: { ...declaration.capabilities.turn, resumption: 'none' },
        },
      }],
    }).voiceProviders[0]!);
    const firstDispose = vi.fn(async () => {});
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId,
      declarations: [declaration, incompatibleDeclaration],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });

    scope.api.voiceProviders.register(declaration.id, { ...createProviderLeaf(), dispose: firstDispose });
    scope.api.voiceProviders.register(incompatibleDeclaration.id, createProviderLeaf());

    await expect(Promise.resolve().then(() => scope.commit()))
      .rejects.toThrow(/voice_provider_resumption_registration_mismatch/u);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(listExternalVoiceProviderRegistrations()
      .some((entry) => entry.pluginId === identity.pluginId)).toBe(false);
  });

  it('unwinds a committed contribution when an external registration listener throws', async () => {
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, declarations: [declaration], hostPlatform: 'web',
    });
    const providerId = 'acme.synthetic-voice/conversation';
    const unsubscribe = subscribeExternalVoiceProviderRegistrations(() => {
      if (listExternalVoiceProviderRegistrations().some((entry) => entry.providerId === providerId)) {
        throw new Error('external_voice_registration_listener_failed');
      }
    });
    onTestFinished(async () => {
      unsubscribe();
      await scope.unwind();
      hostLease.revoke();
    });
    scope.api.voiceProviders.register('conversation', createProviderLeaf());

    await expect(scope.commit()).rejects.toThrow(/external_voice_registration_listener_failed/u);
    expect(listExternalVoiceProviderRegistrations().map((entry) => entry.providerId)).not.toContain(providerId);
    expect(() => scope.api.voiceProviders.register('conversation', createProviderLeaf()))
      .toThrow(/external_voice_provider_registration_closed/u);

    await scope.unwind();
    await scope.unwind();

    expect(listExternalVoiceProviderRegistrations().map((entry) => entry.providerId)).not.toContain(providerId);
    expect(getCurrentBundledConversationRuntimeHost()).toBe(hostLease.host);
  });

  it('requires a current named activation before the central lifecycle can run and revokes it on disable', async () => {
    registerVoiceAdapters([]);
    const hostLease = createBundledConversationRuntimeHostLease();
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({ identity, bytes: new Uint8Array([47, 47]), format: 'plainJs' });
    const forgetProviderConversation = vi.fn(async () => {});
    const setInputMuted = vi.fn(async () => undefined);
    const disposeProviderLeaf = vi.fn(async () => {});
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'reactNativeWebModule',
      available: true,
      async loadInstalledBundle() {
        return (api: ReturnType<typeof createExternalVoiceProviderActivationScope>['api']) => {
          api.voiceProviders.register('conversation', {
            ...createProviderLeaf({ setInputMuted }),
            forgetProviderConversation,
            dispose: disposeProviderLeaf,
          });
        };
      },
    });
    const host = createPluginUiExecutableModuleHost();
    onTestFinished(async () => {
      await host.unload();
      hostLease.revoke();
    });
    const authority = Object.freeze({
      serverId: 'server-1', machineId: 'machine-1', projectionGeneration: 12,
    });
    await host.replaceAuthority(authority);

    const activationInput = {
      cache,
      identity,
      moduleReference: {
        containerName: 'acme_synthetic_voice_runtime',
        modulePath: declaration.client.modulePath,
        exportName: declaration.client.exportName,
      },
      backend,
      hostPlatform: 'web',
      authority,
      createScope: () => createExternalVoiceProviderActivationScope({
        pluginId: identity.pluginId,
        declarations: [declaration],
        hostPlatform: 'web',
      }),
    } as const;
    await expect(host.activate(activationInput)).resolves.toEqual({ ok: true });
    expect(getCurrentBundledConversationRuntimeHost()).toBe(hostLease.host);

    const providerId = 'acme.synthetic-voice/conversation';
    expect(getVoiceAdapterRegistry().get(providerId)?.id).toBe(providerId);
    await getVoiceAdapterRegistry().get(providerId)?.setMuted({ sessionId: 'voice', muted: true });
    expect(setInputMuted).toHaveBeenCalledWith(true);
    expect(createDefaultVoiceProviderRegistry().get(providerId)?.source).toEqual({
      kind: 'external', pluginId: identity.pluginId, localId: 'conversation',
    });
    const descriptor = createDefaultVoiceProviderRegistry().get(providerId)!;
    expect(descriptor.projectSettings?.(null)).toEqual({ status: 'needs_migration', modeId: null });
    expect(descriptor.projectSettings?.({ schemaVersion: 1, config: { mode: 'default' } })).toEqual({
      status: 'ready', modeId: 'default',
    });
    expect(descriptor.projectSettings?.({ schemaVersion: 1, config: { mode: 'default', extra: true } })).toEqual({
      status: 'invalid', modeId: null,
    });
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, {
      providerId: null,
      providers: { [providerId]: { schemaVersion: 1, config: { mode: 'default' } } },
    })).toBeNull();
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, {
      providerId,
      providers: { [providerId]: { schemaVersion: 1, config: { mode: 'default' } } },
    })).toMatchObject({
      allowsGlobalStart: true,
      controlSessionScope: 'global',
      interruptionPolicy: 'provider_immediate',
    });
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, {
      providerId,
      providers: { [providerId]: { schemaVersion: 1, config: { mode: 'default', extra: true } } },
    })).toBeNull();
    await expect(getVoiceAdapterRegistry().get(providerId)?.performRuntimeAction?.('forget_provider_conversation'))
      .resolves.toEqual({ status: 'completed' });
    expect(forgetProviderConversation).toHaveBeenCalledTimes(1);
    await host.invalidatePlugin(identity.pluginId);
    expect(disposeProviderLeaf).toHaveBeenCalledTimes(1);
    expect(getCurrentBundledConversationRuntimeHost()).toBe(hostLease.host);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
    await expect(host.activate(activationInput)).resolves.toEqual({ ok: true });
    expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).not.toBeNull();
    await host.replaceAuthority({ ...authority, projectionGeneration: 13 });
    expect(disposeProviderLeaf).toHaveBeenCalledTimes(2);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
    await expect(host.activate(activationInput)).resolves.toMatchObject({
      ok: false, code: 'stale_projection_generation',
    });
  });
});
