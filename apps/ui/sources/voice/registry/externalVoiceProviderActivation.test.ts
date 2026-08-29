import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  PluginContributesV2Schema,
  createRecipientContractDigestV1,
  createVoiceProviderRecipientContractFromCredentialsV1,
  type VoiceProviderContribution,
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
import { createVoiceProviderRegistry } from './providerRegistry';
import { resolveVoicePassiveSetupReadiness } from './readiness';
import {
  projectVoiceProviderAgentRealtimePassiveSetup,
  projectVoiceProviderPassiveSetupFacts,
} from '@/voice/settings/passiveSetup';

import {
  createExternalVoiceProviderRuntimeContribution,
  createDeclaredVoiceClientRawCredentialAccess,
  bindVoiceProviderSettingsActions,
  type VoiceConversationProviderContribution,
} from './externalVoiceProviderActivation';
import { createExternalVoiceProviderActivationScope } from './externalVoiceProviderActivation.testkit';
import {
  listExternalVoiceProviderRegistrations,
  subscribeExternalVoiceProviderRegistrations,
} from './externalVoiceProviderRegistrations';
import {
  createBundledConversationRuntimeHostLease,
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';

function requireConversationDeclaration(
  declaration: VoiceProviderContribution,
): VoiceConversationProviderContribution {
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
    kind: 'conversation' as const,
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
    microphoneMode: 'provider_managed' as const,
    setInputMuted: input?.setInputMuted ?? (() => {}),
  };
}

describe('external Voice provider activation', () => {
  it('derives identical Agent runtime requirements and incompatibility for bundled and external declarations', async () => {
    const agentRealtimeDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'agent-realtime-parity',
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: 'fixture-agent',
          supportedRuntimeVersions: ['1.2.3'],
        },
        settings: {
          schemaVersion: 2,
          fields: [],
          connectedServicesBinding: {
            id: 'globalConnectedServices',
            title: 'Agent account',
            agent: 'fixture-agent',
            serviceIds: ['openai-codex'],
          },
        },
      }],
    }).voiceProviders[0]!);
    const pluginId = 'acme.agent-voice-parity';
    const providerId = `${pluginId}/${agentRealtimeDeclaration.id}`;
    const bundled = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId, providerId, declaration: agentRealtimeDeclaration }],
      bundledPresentations: [{ providerId, settingsSectionId: providerId }],
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId,
      declarations: [agentRealtimeDeclaration],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });
    scope.api.voiceProviders.register(agentRealtimeDeclaration.id, createProviderLeaf());
    await scope.commit();
    const external = createDefaultVoiceProviderRegistry();

    for (const entry of [bundled.get(providerId), external.get(providerId)]) {
      expect(entry?.requirements).toEqual(['execution_machine', 'runtime']);
      if (entry?.kind !== 'voice.conversation-provider.v1' || !entry.declaration?.execution) {
        throw new Error('expected Agent realtime declaration');
      }
      const facts = projectVoiceProviderPassiveSetupFacts({
        execution: entry.declaration.execution,
        executionMachineId: 'machine-1',
        executionMachineOnline: true,
        runtimeCapabilityResult: {
          ok: true,
          checkedAt: 1,
          data: { available: true, version: '1.2.4', resolvedPath: '/bin/fixture-agent' },
        },
      });
      expect(projectVoiceProviderAgentRealtimePassiveSetup(entry.declaration.execution)).toMatchObject({
        capabilityId: 'cli.fixture-agent',
      });
      expect(facts).toMatchObject({
        executionMachine: 'ready',
        runtime: 'incompatible',
      });
      expect(resolveVoicePassiveSetupReadiness({
        registry: entry.source.kind === 'bundled' ? bundled : external,
        role: 'realtime_conversation',
        providerId,
        platform: 'web',
        modeId: null,
        facts: { settings: 'ready', ...facts },
      })).toMatchObject({ status: 'incompatible', code: 'runtime_incompatible' });
    }
  });

  it('exposes raw access only for the exact current client identity, platform, and declared phase', async () => {
    const rawDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.browser', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'web',
              phase: 'connection',
              request: {
                kind: 'httpHeaders',
                origin: 'https://voice.example.test',
                headerNames: ['authorization'],
              },
            }],
          }],
        },
      }],
    }).voiceProviders[0]!);
    const exactIdentity = Object.freeze({
      ...identity,
      contributionId: rawDeclaration.id,
    });

    const raw = createDeclaredVoiceClientRawCredentialAccess({
      pluginId: identity.pluginId,
      declaration: rawDeclaration,
      identity: exactIdentity,
      hostPlatform: 'web',
      phase: 'connection',
      generation: '12',
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(raw).not.toBeNull();
    expect(createDeclaredVoiceClientRawCredentialAccess({
      pluginId: identity.pluginId,
      declaration: rawDeclaration,
      identity: exactIdentity,
      hostPlatform: 'web',
      phase: 'prepare',
      generation: '12',
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).toBeNull();
    expect(createDeclaredVoiceClientRawCredentialAccess({
      pluginId: identity.pluginId,
      declaration: rawDeclaration,
      identity: { ...exactIdentity, contributionId: 'other-provider' },
      hostPlatform: 'web',
      phase: 'connection',
      generation: '12',
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).toBeNull();
    await expect(raw!.materialize({ kind: 'environment', keys: ['VOICE_TOKEN'] })).rejects.toMatchObject({
      code: 'plugin_voice_provider_result_invalid',
    });
  });

  it('binds generic settings actions to settings-phase credentials, questions, and canonical currentness', async () => {
    const tools = Object.freeze([Object.freeze({
      name: 'hostListMachines',
      description: 'Host-normalized machine inventory',
      parameters: Object.freeze({ type: 'object', additionalProperties: false }),
      execute: async () => Object.freeze({ ok: true }),
    })]);
    const askQuestions = vi.fn(async () => Object.freeze({
      requestId: 'questions-1',
      kind: 'questions' as const,
      status: 'answered' as const,
      answers: Object.freeze({
        decision: Object.freeze({
          kind: 'singleChoice' as const,
          answer: Object.freeze({ kind: 'choice' as const, choiceId: 'continue' }),
        }),
      }),
    }));
    const execute = vi.fn(async (_input, context): Promise<{
      patch: Readonly<Record<string, string | boolean>>;
    }> => {
      expect(context.credentials.phase).toBe('settings');
      expect(Object.keys(context).sort()).toEqual(['credentials', 'interactions', 'signal', 'tools']);
      expect(context.tools).toBe(tools);
      expect(Reflect.get(context, 'disabledActionIds')).toBeUndefined();
      expect(Reflect.get(context, 'extraSystemAppendBlocks')).toBeUndefined();
      await expect(context.interactions.askQuestions({
        kind: 'questions',
        title: 'Choose whether to continue',
        questions: [{
          id: 'decision',
          prompt: 'Continue?',
          type: 'singleChoice',
          required: true,
          allowCustom: false,
          choices: [{ id: 'continue', label: 'Continue' }],
        }],
      }, {
        signal: context.signal,
      })).resolves.toMatchObject({
        status: 'answered',
      });
      context.signal.throwIfAborted();
      return { patch: { agentId: 'agent_1' } };
    });
    const actions = bindVoiceProviderSettingsActions({
      actions: { execute },
      declaredActions: [{ id: 'create-agent', patchFieldIds: ['agentId'] }],
      createCredentials: () => ({ phase: 'settings', mediated: null, raw: null }),
      createInteractions: () => ({ askQuestions }),
      getRealtimeClientToolDefinitions: () => tools,
      isCurrent: () => true,
    });
    const result = await actions.execute({
      actionId: 'create-agent',
      settings: { mode: 'byo' },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ patch: { agentId: 'agent_1' } });
    await expect(actions.execute({
      actionId: 'undeclared',
      settings: {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/undeclared_voice_provider_settings_action/u);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(askQuestions).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the host has no canonical present-user interaction adapter', () => {
    // @ts-expect-error - this deliberately malformed dynamic host input proves the runtime guard.
    expect(() => bindVoiceProviderSettingsActions({
      actions: { execute: async () => ({ patch: {} }) },
      declaredActions: [],
      createCredentials: () => ({ phase: 'settings', mediated: null, raw: null }),
      isCurrent: () => true,
    })).toThrow(/voice_settings_interaction_host_required/u);
  });

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
          supportedRuntimeVersions: ['1.2.3'],
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
      input: Parameters<NonNullable<
        typeof hostLease.host.resolveAgentRealtimeVoiceConversationBinding
      >>[0],
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
                  'happier.agent.codex/openai-codex': {
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
                    'happier.agent.codex/openai-codex': {
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
                    'happier.agent.codex/openai-codex': {
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
        'happier.agent.codex/openai-codex': Object.freeze({
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

  it('admits binding-free Agent-session realtime declarations for direct session binding', async () => {
    const agent = Object.freeze({
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    });
    const agentRealtimeDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'agent-realtime-without-connected-services',
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent,
          supportedRuntimeVersions: ['1.2.3'],
        },
      }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    const resolveAgentBinding = vi.fn(async (
      input: Parameters<NonNullable<
        typeof hostLease.host.resolveAgentRealtimeVoiceConversationBinding
      >>[0],
    ) => Object.freeze({
      conversationSessionId: input.controlSessionId,
      transcriptMode: 'native_session' as const,
      targetSessionId: input.requestedTargetSessionId,
    }));
    const providerRef = Object.freeze({
      pluginId: identity.pluginId,
      localId: agentRealtimeDeclaration.id,
    });
    const contribution = createExternalVoiceProviderRuntimeContribution({
      host: Object.freeze({
        ...hostLease.host,
        resolveAgentRealtimeVoiceConversationBinding: resolveAgentBinding,
      }),
      platform: 'web',
      providerId: `${providerRef.pluginId}/${providerRef.localId}`,
      providerRef,
      declaration: agentRealtimeDeclaration,
      runtime: createProviderLeaf(),
    });
    onTestFinished(async () => {
      await contribution.dispose();
      hostLease.revoke();
    });

    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: 'visible-codex-session',
      requestedTargetSessionId: 'requested-target',
      settings: {},
    })).resolves.toMatchObject({
      conversationSessionId: 'visible-codex-session',
      targetSessionId: 'requested-target',
    });
    expect(resolveAgentBinding).toHaveBeenCalledWith(expect.objectContaining({
      provider: providerRef,
      agent,
      controlSessionId: 'visible-codex-session',
    }));
    expect(resolveAgentBinding.mock.lastCall?.[0]).not.toHaveProperty('connectedServices');
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
            config: {},
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
          supportedRuntimeVersions: ['1.2.3'],
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

  it('rejects broad host-controller registration from an external plugin at commit', async () => {
    const hostLease = createBundledConversationRuntimeHostLease();
    onTestFinished(() => hostLease.revoke());
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, declarations: [declaration], hostPlatform: 'web',
    });
    Reflect.apply(scope.api.voiceProviders.register, undefined, ['conversation', {
      engineKind: 'realtime', async start() {}, async stop() {}, async toggle() {},
      async interrupt() {}, async setMuted() {}, sendContextUpdate() {},
      getSnapshot: () => ({
        adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
      }),
    }]);
    await expect(scope.commit()).rejects.toThrow(/registered an invalid .*runtime/u);
    await scope.unwind();
  });

  it('exposes only the declaration-scoped Voice registration API to client-realm modules', async () => {
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, declarations: [declaration], hostPlatform: 'web',
    });
    expect(Object.keys(scope.api)).toEqual(['voiceProviders']);
    expect(Reflect.get(scope.api, 'actions')).toBeUndefined();
    await scope.unwind();
  });

  it('does not project hosted ElevenLabs lifecycle properties from an external identity collision', async () => {
    const hostLease = createBundledConversationRuntimeHostLease();
    onTestFinished(() => hostLease.revoke());
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
    const fetchHostedVoiceToken = vi.fn();
    const completeHostedVoiceSession = vi.fn();

    scope.api.voiceProviders.register('realtime-elevenlabs', {
      ...createProviderLeaf(),
      fetchHostedVoiceToken,
      completeHostedVoiceSession,
    } as ReturnType<typeof createProviderLeaf>);
    await expect(scope.commit()).resolves.toBeUndefined();
    const registration = listExternalVoiceProviderRegistrations().find((entry) => (
      entry.pluginId === 'happier.voice.elevenlabs'
      && entry.localId === copiedDeclaration.id
    ));
    if (!registration?.adapter) throw new Error('expected_external_voice_adapter');
    expect(registration.adapter.id).toBe('happier.voice.elevenlabs/realtime-elevenlabs');
    expect(Reflect.get(registration.adapter, 'fetchHostedVoiceToken')).toBeUndefined();
    expect(Reflect.get(registration.adapter, 'completeHostedVoiceSession')).toBeUndefined();
    await scope.unwind();
    expect(fetchHostedVoiceToken).not.toHaveBeenCalled();
    expect(completeHostedVoiceSession).not.toHaveBeenCalled();
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
    const capturedDispose = vi.fn(async () => {});
    const replacementDispose = vi.fn(async () => {});
    const runtime = { ...createProviderLeaf(), dispose: capturedDispose };
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, declarations: [declaration], hostPlatform: 'web',
    });
    scope.api.voiceProviders.register('conversation', runtime);
    await scope.commit();
    runtime.dispose = replacementDispose;
    const providerId = 'acme.synthetic-voice/conversation';
    expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();

    const replacementHost = createBundledConversationRuntimeHostLease();
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();

    await scope.unwind();
    expect(capturedDispose).toHaveBeenCalledOnce();
    expect(replacementDispose).not.toHaveBeenCalled();
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

  it('uses the commit-time Voice runtime snapshot after author code mutates its object', async () => {
    const capturedListCatalog = vi.fn(async () => Object.freeze([{ id: 'captured' }]));
    const replacementListCatalog = vi.fn(async () => Object.freeze([{ id: 'replacement' }]));
    const settingsOperations = {
      listCatalog: capturedListCatalog,
    };
    const runtime = {
      ...createProviderLeaf(),
      settingsOperations,
    };
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId,
      declarations: [declaration],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });

    scope.api.voiceProviders.register(declaration.id, runtime);
    await scope.commit();
    settingsOperations.listCatalog = replacementListCatalog;

    const registration = listExternalVoiceProviderRegistrations()
      .find((entry) => entry.pluginId === identity.pluginId && entry.localId === declaration.id);
    const result = await registration?.settingsOperations?.listCatalog?.({
      catalog: 'models',
      providerConfig: {},
      signal: new AbortController().signal,
    });

    expect(result).toEqual([{ id: 'captured' }]);
    expect(capturedListCatalog).toHaveBeenCalledOnce();
    expect(replacementListCatalog).not.toHaveBeenCalled();
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
      defaultConfig: { voice: 'calm', expressive: false },
      fields: [
        { id: 'voice', presentation: { control: 'select' } },
        { id: 'expressive', presentation: { control: 'switch' } },
      ],
    });
    expect(descriptor.projectSettings?.({
      schemaVersion: 1,
      config: { voice: 'bright', expressive: true },
    })).toEqual({ status: 'ready', modeId: 'default' });
    expect(descriptor.projectSettings?.({
      schemaVersion: 1,
      config: { voice: 'unknown', expressive: true },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(descriptor.projectSettings?.({
      schemaVersion: 1,
      config: { voice: 'bright', expressive: true, apiKey: 'must-not-pass' },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(descriptor.projectSettings?.({
      schemaVersion: 2,
      config: { voice: 'bright', expressive: true },
    })).toEqual({ status: 'unsupported_version', modeId: null });

    const parsed = voiceSettingsParse({
      providerId,
      providers: {
        [providerId]: {
          schemaVersion: 1,
          config: { voice: 'bright', expressive: true },
        },
      },
    });
    expect(readVoiceProviderSettingsConfig(parsed, providerId)).toEqual({
      voice: 'bright',
      expressive: true,
    });
    expect(writeVoiceProviderSettingsConfig(parsed, providerId, {
      voice: 'calm',
      expressive: false,
    }).providers[providerId]).toEqual({
      schemaVersion: 1,
      config: { voice: 'calm', expressive: false },
    });
  });

  it('answers declared settings readiness identically for bundled and external descriptors', async () => {
    const readinessDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'readiness-parity',
        settings: {
          schemaVersion: 1,
          fields: [{
            id: 'model',
            title: 'Model',
            schema: { type: 'string', maxLength: 64 },
            default: '',
            presentation: { control: 'text' },
          }],
          readiness: [{ kind: 'setting_nonempty', settingId: 'model' }],
        },
      }],
    }).voiceProviders[0]!);
    const pluginId = 'acme.readiness-parity';
    const providerId = `${pluginId}/${readinessDeclaration.id}`;
    const bundled = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId, providerId, declaration: readinessDeclaration }],
      bundledPresentations: [{ providerId, settingsSectionId: providerId }],
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId,
      declarations: [readinessDeclaration],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });
    scope.api.voiceProviders.register(readinessDeclaration.id, createProviderLeaf());
    await scope.commit();
    const external = createDefaultVoiceProviderRegistry();

    for (const [source, entry] of [
      ['bundled', bundled.get(providerId)],
      ['external', external.get(providerId)],
    ] as const) {
      expect({
        source,
        blank: entry?.projectSettings?.({ schemaVersion: 1, config: { model: '' } }),
        filled: entry?.projectSettings?.({ schemaVersion: 1, config: { model: 'fixture-model' } }),
      }).toEqual({
        source,
        blank: { status: 'missing_required_setting', modeId: 'default' },
        filled: { status: 'ready', modeId: 'default' },
      });
    }
  });

  it('projects only the one exact host-mediated credential slot and rejects mismatched declarations', async () => {
    const operation = {
      id: 'client-auth',
      purpose: 'voice.client-auth',
      credentialSlotId: 'api_key',
      effect: 'read' as const,
      request: {
        origin: 'https://voice.example.test',
        pathTemplate: '/v1/session',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'none' as const },
        method: 'POST' as const,
        credential: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
        redirect: 'error' as const,
        maxBodyBytes: 0,
        contentTypes: [],
      },
      parameters: {
        schema: { type: 'object' as const, properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
    };
    const credentialDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'credential-conversation',
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            operationProjections: [{
              kind: 'recipientCredential',
              operation: 'client-auth',
              phase: 'prepare',
              format: 'bearer',
            }],
          }],
          hostMediated: { operations: [operation] },
        },
      }],
    }).voiceProviders[0]!);
    if (!credentialDeclaration.credentials?.hostMediated) {
      throw new Error('expected host-mediated credentials');
    }
    const recipientContract = createVoiceProviderRecipientContractFromCredentialsV1({
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
      credentials: {
        slot: credentialDeclaration.credentials.slot,
        hostMediated: credentialDeclaration.credentials.hostMediated,
      },
      presentation: { title: credentialDeclaration.title },
    });
    const undeclaredSlot = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'undeclared-credential',
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

    const mismatchedDeclaration = {
      ...credentialDeclaration,
      credentials: {
        ...credentialDeclaration.credentials,
        hostMediated: {
          operations: [{ ...operation, credentialSlotId: 'other' }],
        },
      },
    };
    expect(() => createExternalVoiceProviderActivationScope({
      pluginId: 'acme.invalid-voice',
      declarations: [mismatchedDeclaration as typeof credentialDeclaration],
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
    const secondDispose = vi.fn(async () => {});
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
    scope.api.voiceProviders.register(incompatibleDeclaration.id, {
      ...createProviderLeaf(),
      dispose: secondDispose,
    });

    await expect(Promise.resolve().then(() => scope.commit()))
      .rejects.toThrow(/voice_provider_resumption_registration_mismatch/u);
    await scope.unwind();
    await scope.unwind();
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
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
      .toThrow(/activation registration is committed/u);

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
    const forgetProviderConversationState = vi.fn(async () => {});
    const runtimeHost = Object.freeze({
      ...hostLease.host,
      forgetProviderConversationState,
    });

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
        runtimeHost,
        isRuntimeHostCurrent: () =>
          getCurrentBundledConversationRuntimeHost() === hostLease.host,
      }),
    } as const;
    await expect(host.activate(activationInput)).resolves.toEqual({ ok: true });
    expect(getCurrentBundledConversationRuntimeHost()).toBe(hostLease.host);

    const providerId = 'acme.synthetic-voice/conversation';
    const adapter = getVoiceAdapterRegistry().get(providerId);
    expect(adapter?.id).toBe(providerId);
    if (!adapter) throw new Error('expected_external_voice_adapter');
    await adapter.setMuted({ sessionId: 'voice', muted: true });
    expect(setInputMuted).not.toHaveBeenCalled();
    expect(createDefaultVoiceProviderRegistry().get(providerId)?.source).toEqual({
      kind: 'external', pluginId: identity.pluginId, localId: 'conversation',
    });
    const descriptor = createDefaultVoiceProviderRegistry().get(providerId)!;
    expect(descriptor.projectSettings?.(null)).toEqual({ status: 'needs_migration', modeId: null });
    expect(descriptor.projectSettings?.({ schemaVersion: 1, config: {} })).toEqual({
      status: 'ready', modeId: 'default',
    });
    expect(descriptor.projectSettings?.({ schemaVersion: 1, config: { extra: true } })).toEqual({
      status: 'invalid', modeId: null,
    });
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, {
      providerId: null,
      providers: { [providerId]: { schemaVersion: 1, config: {} } },
    })).toBeNull();
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, {
      providerId,
      providers: { [providerId]: { schemaVersion: 1, config: {} } },
    })).toMatchObject({
      allowsGlobalStart: true,
      controlSessionScope: 'global',
      interruptionPolicy: 'provider_immediate',
    });
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, {
      providerId,
      providers: { [providerId]: { schemaVersion: 1, config: { extra: true } } },
    })).toBeNull();
    await expect(getVoiceAdapterRegistry().get(providerId)?.performRuntimeAction?.('forget_provider_conversation'))
      .resolves.toEqual({ status: 'completed' });
    expect(forgetProviderConversation).toHaveBeenCalledTimes(1);
    expect(forgetProviderConversationState).toHaveBeenCalledWith({ providerId });
    await host.invalidatePlugin(identity.pluginId);
    expect(disposeProviderLeaf).toHaveBeenCalledTimes(1);
    expect(getCurrentBundledConversationRuntimeHost()).toBe(hostLease.host);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
    await expect(adapter.start({ sessionId: 'voice-after-retirement' }))
      .rejects.toThrow(/voice_runtime_generation_revoked/u);
    await expect(host.activate(activationInput)).resolves.toEqual({ ok: true });
    const replacementAdapter = getVoiceAdapterRegistry().get(providerId);
    expect(replacementAdapter).not.toBeNull();
    if (!replacementAdapter) throw new Error('expected_replacement_external_voice_adapter');
    expect(createDefaultVoiceProviderRegistry().get(providerId)).not.toBeNull();
    await host.replaceAuthority({ ...authority, projectionGeneration: 13 });
    expect(disposeProviderLeaf).toHaveBeenCalledTimes(2);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
    await expect(replacementAdapter.start({ sessionId: 'voice-after-update' }))
      .rejects.toThrow(/voice_runtime_generation_revoked/u);
    await expect(host.activate(activationInput)).resolves.toMatchObject({
      ok: false, code: 'stale_projection_generation',
    });
  });
});
