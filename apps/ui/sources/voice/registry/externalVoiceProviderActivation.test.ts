import { waitForTestEvent } from '@/dev/testkit';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as React from 'react';
import type { VoiceSettingsActionContext } from '@happier-dev/plugin-sdk/voice';
import type { PluginSettingsActionInput } from '@happier-dev/plugin-sdk/settings';
import {
  PluginContributesV2Schema} from '@happier-dev/protocol/plugins/contributions/v2';
import {
  VoiceProviderContributionSchema,
  type VoiceProviderContribution} from '@happier-dev/protocol/plugins/contributions/voice';
import {
  createVoiceProviderRecipientContractFromCredentialsV1} from '@happier-dev/protocol/plugins/recipientContractV1';
import {
  AgentSessionRealtimeInspectResultV1Schema,
} from '@happier-dev/protocol/voice/realtime/agentSession';

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
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { ModalProvider } from '@/modal/ModalProvider';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@/voice/persistence/voiceTranscriptHistorySession';
import { readVoiceProviderConversationMetadata, writeVoiceProviderConversationMetadata } from '@/voice/persistence/voiceProviderConversationMetadata';
import {
  createBundledConversationRuntimeHostLease,
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

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
        exactMessage: true,
        interruptionPolicy: 'provider_immediate',
      },
    },
    client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
  }],
}).voiceProviders[0]!);

const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
  pluginId: 'acme.synthetic-voice',
  contributionId: declaration.id,
  artifactId: declaration.client.artifactId,
  artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  platform: 'web',
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

async function installAgentBindingAccount() {
  const inspected: Array<Readonly<{ method: string; payload: unknown }>> = [];
  let reply = AgentSessionRealtimeInspectResultV1Schema.parse({ ok: true, status: 'available', transport: 'webrtc' });
  installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
      if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
      if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string'
        || !('params' in payload)) throw new Error('Malformed Socket RPC boundary input');
      inspected.push({ method: payload.method, payload: payload.params });
      return { ok: true, result: reply };
    });
  });
  const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
  onTestFinished(account.dispose);
  onTestFinished(() => { installDisconnectedServerSocketBoundary(); });
  const session = createSessionFixture({ id: 'visible-codex-session', serverId: account.scope.serverId, active: true,
    metadata: { path: '/project', host: 'voice.test', flavor: 'codex' },
  });
  const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
  const request = account.request.getMockImplementation();
  if (!request) throw new Error('Account HTTP boundary missing');
  account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init) ?? request(input, init)));
  storage.setState({ sessions: { [session.id]: session } });
  return { account, session, inspected, setReply(next: unknown) { reply = AgentSessionRealtimeInspectResultV1Schema.parse(next); } };
}

describe('external Voice provider activation', () => {
  it('provisions declared effect-tool definitions while their direct callbacks remain denied', async () => {
    const provisioningDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'provision-effect-tools',
        capabilities: { ...declaration.capabilities,  },
        settings: {
          schemaVersion: 1,
          fields: [{ id: 'agentId', title: 'Agent ID', schema: { type: 'string', maxLength: 256 }, default: '', presentation: { control: 'text' } }],
          actions: [{
            id: 'create-agent', title: 'Create Agent', patchFieldIds: ['agentId'],
            placement: { kind: 'contributionFooter' }, confirmation: { kind: 'none' },
          }],
        },
      }],
    }).voiceProviders[0]!);
    const previousSettings = storage.getState().settings;
    storage.setState((current) => ({ ...current, settings: {
      ...current.settings, experiments: true,
      featureToggles: { ...current.settings.featureToggles, voice: true },
    } }));
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, occurrenceId: 'provisioning-tool-capability',
      declarations: [provisioningDeclaration], hostPlatform: 'web', runtimeHost: hostLease.host,
      isRuntimeHostCurrent: () => true,
    });
    onTestFinished(async () => {
      await scope.unwind(); hostLease.revoke();
      storage.setState((current) => ({ ...current, settings: previousSettings }));
    });
    let exposedTools: readonly Readonly<{ name: string }>[] = [];
    scope.api.voiceProviders.register(provisioningDeclaration.id, {
      ...createProviderLeaf(),
      settingsActions: { async execute(_input, context) {
        exposedTools = context.tools;
        const effect = context.tools.find((tool) => tool.name === 'invokeAction');
        if (effect) await expect(effect.execute({ message: 'must stay behind custody' }))
          .rejects.toMatchObject({ code: 'voice_effect_call_custody_required' });
        return { patch: { agentId: 'provisioned-agent' } };
      } },
    });
    await scope.commit();
    const registration = listExternalVoiceProviderRegistrations().find((entry) => entry.localId === provisioningDeclaration.id);
    if (!registration?.settingsActions) throw new Error('settings_actions_not_registered');
    await registration.settingsActions.execute({ actionId: 'create-agent', settings: {}, signal: new AbortController().signal });
    expect(exposedTools.map((tool) => tool.name)).toContain('invokeAction');
  });
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
      occurrenceId: `${pluginId}-activation-occurrence`,
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
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).toBeNull();
    expect(createDeclaredVoiceClientRawCredentialAccess({
      pluginId: identity.pluginId,
      declaration: rawDeclaration,
      identity: { ...exactIdentity, contributionId: 'other-provider' },
      hostPlatform: 'web',
      phase: 'connection',
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).toBeNull();
    await expect(raw!.materialize({ kind: 'environment', keys: ['VOICE_TOKEN'] })).rejects.toMatchObject({
      code: 'plugin_voice_provider_result_invalid',
    });
  });

  it('binds generic settings actions to settings-phase credentials, questions, and canonical currentness', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    const hostLease = createBundledConversationRuntimeHostLease();
    const actionDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{ ...declaration, settings: {
        schemaVersion: 1,
        fields: [{ id: 'agentId', title: 'Agent ID', schema: { type: 'string', maxLength: 256 }, default: '',
          presentation: { control: 'text' } }],
        actions: [{ id: 'create-agent', title: 'Create Agent', patchFieldIds: ['agentId'],
          placement: { kind: 'contributionFooter' }, confirmation: { kind: 'none' } }],
      } }],
    }).voiceProviders[0]!);
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, occurrenceId: 'settings-actions-real-context', declarations: [actionDeclaration],
      hostPlatform: 'web', runtimeHost: hostLease.host,
      isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
    });
    let mountedScreen: Awaited<ReturnType<typeof renderScreen>> | null = null;
    onTestFinished(async () => { await scope.unwind(); await mountedScreen?.unmount(); hostLease.revoke(); await account.dispose(); });
    const screen = await renderScreen(React.createElement(ModalProvider, { children: null }));
    mountedScreen = screen;
    const execute = vi.fn(async (_input: PluginSettingsActionInput, context: VoiceSettingsActionContext): Promise<{
      patch: Readonly<Record<string, string | boolean>>;
    }> => {
      expect(context.credentials.phase).toBe('settings');
      expect(Object.keys(context).sort()).toEqual(['credentials', 'interactions', 'signal', 'tools']);
      expect(context.tools.map((tool) => tool.name)).toContain('getActionSpec');
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
        answers: { decision: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'continue' } } },
      });
      context.signal.throwIfAborted();
      return { patch: { agentId: 'agent_1' } };
    });
    scope.api.voiceProviders.register(actionDeclaration.id, {
      ...createProviderLeaf(), settingsActions: { execute },
    });
    await scope.commit();
    const actions = listExternalVoiceProviderRegistrations().find(entry => entry.pluginId === identity.pluginId
      && entry.localId === actionDeclaration.id)?.settingsActions;
    if (!actions) throw new Error('Actual activation settings actions unavailable');
    let running!: ReturnType<typeof actions.execute>;
    await React.act(async () => {
      running = actions.execute({ actionId: 'create-agent', settings: { mode: 'byo' }, signal: new AbortController().signal });
      await Promise.resolve();
    });
    await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('app-shell-question-decision-choice-continue')).not.toBeNull());
    await screen.pressByTestIdAsync('app-shell-question-decision-choice-continue');
    await screen.pressByTestIdAsync('app-shell-question-submit');
    const result = await running;
    expect(result).toEqual({ patch: { agentId: 'agent_1' } });
    await expect(actions.execute({
      actionId: 'undeclared',
      settings: {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/undeclared_voice_provider_settings_action/u);
    await scope.unwind();
    await expect(actions.execute({ actionId: 'create-agent', settings: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
    expect(execute).toHaveBeenCalledTimes(1);
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

  it('installs exact direct Agent binding and rejects malformed global account selections from the public declaration', async () => {
    const fixture = await installAgentBindingAccount();
    const agent = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' });
    const agentRealtimeDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration, id: 'agent-realtime',
        execution: { kind: 'experimental_agent_session_realtime', agent, supportedRuntimeVersions: ['1.2.3'] },
        settings: { schemaVersion: 2, fields: [], connectedServicesBinding: {
          id: 'globalConnectedServices', title: 'Codex account', agent, serviceIds: ['openai-codex'],
        } },
      }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    const providerRef = Object.freeze({ pluginId: identity.pluginId, localId: agentRealtimeDeclaration.id });
    const providerId = `${providerRef.pluginId}/${providerRef.localId}`;
    const contribution = createExternalVoiceProviderRuntimeContribution({
      host: hostLease.host, platform: 'web', providerId, providerRef,
      declaration: agentRealtimeDeclaration, runtime: createProviderLeaf(),
    });
    onTestFinished(async () => { await contribution.dispose(); hostLease.revoke(); });
    const connectedServices = { v: 1, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'codex-account-a' },
    } };
    const settingsWith = (globalConnectedServices: unknown) => ({ voice: voiceSettingsParse({
      providerId, providers: { [providerId]: { schemaVersion: 2, config: { globalConnectedServices } } },
    }) });
    const settings = settingsWith(connectedServices);
    expect(contribution.adapter.resolveSurfaceCapabilities?.(settings)).toMatchObject({ agentRuntime: agent });
    const address = { serverId: fixture.account.scope.serverId, sessionId: fixture.session.id };
    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: fixture.session.id, requestedTargetSessionAddress: address, settings,
    })).resolves.toEqual({
      conversationSessionAddress: address, transcriptMode: 'native_session', targetSessionAddress: address,
    });
    expect(fixture.inspected).toEqual([{ method: `${fixture.session.id}:session.agentRealtime.inspect`,
      payload: { v: 1, provider: providerRef },
    }]);
    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: fixture.session.id,
      requestedTargetSessionAddress: { ...address, sessionId: 'different-session' }, settings,
    })).rejects.toMatchObject({ code: 'session_unavailable' });
    for (const reason of ['session_unavailable', 'update_required']) {
      fixture.setReply({ ok: false, status: 'unavailable', code: reason, message: 'Unavailable', reason });
      await expect(contribution.adapter.resolveConversationBinding?.({
        controlSessionId: fixture.session.id, requestedTargetSessionAddress: address, settings,
      })).rejects.toMatchObject({ code: reason });
    }
    fixture.setReply({ ok: false, status: 'unavailable', code: 'unclassified', message: 'Unclassified decline' });
    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: fixture.session.id, requestedTargetSessionAddress: address, settings,
    })).resolves.toBeNull();
    const admittedDirectRequests = [...fixture.inspected];
    for (const globalConnectedServices of [null, { ...connectedServices, bindingsByServiceId: {
      ...connectedServices.bindingsByServiceId, github: { source: 'connected', selection: 'profile', profileId: 'must-not-be-admitted' },
    } }]) {
      await expect(contribution.adapter.resolveConversationBinding?.({
        controlSessionId: hostLease.host.globalVoiceSessionId, requestedTargetSessionAddress: null,
        settings: settingsWith(globalConnectedServices),
      })).resolves.toBeNull();
    }
    expect(fixture.inspected).toEqual(admittedDirectRequests);
  });

  it('admits binding-free Agent-session realtime declarations for the exact direct session', async () => {
    const fixture = await installAgentBindingAccount();
    const agent = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' });
    const agentRealtimeDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{ ...declaration, id: 'agent-realtime-without-connected-services',
        execution: { kind: 'experimental_agent_session_realtime', agent, supportedRuntimeVersions: ['1.2.3'] },
      }],
    }).voiceProviders[0]!);
    const hostLease = createBundledConversationRuntimeHostLease();
    const providerRef = Object.freeze({ pluginId: identity.pluginId, localId: agentRealtimeDeclaration.id });
    const contribution = createExternalVoiceProviderRuntimeContribution({
      host: hostLease.host, platform: 'web', providerId: `${providerRef.pluginId}/${providerRef.localId}`,
      providerRef, declaration: agentRealtimeDeclaration, runtime: createProviderLeaf(),
    });
    onTestFinished(async () => { await contribution.dispose(); hostLease.revoke(); });
    const address = { serverId: fixture.account.scope.serverId, sessionId: fixture.session.id };
    await expect(contribution.adapter.resolveConversationBinding?.({
      controlSessionId: fixture.session.id, requestedTargetSessionAddress: address, settings: {},
    })).resolves.toEqual({
      conversationSessionAddress: address, transcriptMode: 'native_session', targetSessionAddress: address,
    });
    expect(fixture.inspected).toEqual([{ method: `${fixture.session.id}:session.agentRealtime.inspect`,
      payload: { v: 1, provider: providerRef },
    }]);
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
      pluginId: identity.pluginId, occurrenceId: 'acme-synthetic-voice-activation-occurrence', declarations: [declaration], hostPlatform: 'web',
    });
    Reflect.apply(scope.api.voiceProviders.register, undefined, ['conversation', {
      engineKind: 'realtime', async start() {}, async stop() {}, async toggle() {},
      async interrupt() {}, async setMuted() {}, sendContextUpdate() {},
      getSnapshot: () => ({
        adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
      }),
    }]);
    await expect(scope.commit()).rejects.toThrow('invalid_external_voice_provider_leaf_registration');
    await scope.unwind();
  });

  it('exposes only the declaration-scoped Voice registration API to client-realm modules', async () => {
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, occurrenceId: 'acme-synthetic-voice-activation-occurrence', declarations: [declaration], hostPlatform: 'web',
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
      occurrenceId: 'happier-voice-elevenlabs-activation-occurrence',
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
      pluginId: identity.pluginId, occurrenceId: 'acme-synthetic-voice-activation-occurrence', declarations: [declaration], hostPlatform: 'web',
    });
    scope.api.voiceProviders.register('conversation', createProviderLeaf());
    await expect(scope.commit()).rejects.toThrow(/voice_runtime_host_unavailable/u);
    await scope.unwind();
  });

  it('withdraws external adapter authority synchronously when its Voice runtime host is replaced', async () => {
    const firstHost = createBundledConversationRuntimeHostLease();
    const capturedDispose = vi.fn(async () => {});
    const runtime = { ...createProviderLeaf(), dispose: capturedDispose };
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, occurrenceId: 'acme-synthetic-voice-activation-occurrence', declarations: [declaration], hostPlatform: 'web',
    });
    scope.api.voiceProviders.register('conversation', runtime);
    await scope.commit();
    const providerId = 'acme.synthetic-voice/conversation';
    expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();

    const replacementHost = createBundledConversationRuntimeHostLease();
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();

    await scope.unwind();
    expect(capturedDispose).toHaveBeenCalledOnce();
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
      occurrenceId: 'acme-synthetic-voice-activation-occurrence',
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
      occurrenceId: 'acme-synthetic-voice-activation-occurrence',
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
    })).toEqual({ status: 'ready', modeId: 'default' });
    expect(descriptor.providerSettings?.parseStoredConfig({
      voice: 'bright', expressive: true, apiKey: 'must-not-pass',
    })).toEqual({ voice: 'bright', expressive: true });
    expect(descriptor.providerSettings?.parseConfig({
      voice: 'bright', expressive: true, apiKey: 'must-not-pass',
    })).toBeNull();
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

  it.each([undefined, { key: 'voice.service.description', fallback: 'Talk with the installed service.' }])(
    'preserves an external service description without substituting plugin identity or billing (%j)', async (description) => {
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId,
      occurrenceId: 'acme-synthetic-voice-presentation-occurrence',
      declarations: [requireConversationDeclaration(VoiceProviderContributionSchema.parse({ ...declaration, ...(description ? { description } : {}) }))],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });
    scope.api.voiceProviders.register(declaration.id, createProviderLeaf());
    await scope.commit();

    const descriptor = createDefaultVoiceProviderRegistry().get(`${identity.pluginId}/${declaration.id}`)!;
    if (descriptor.kind !== 'voice.conversation-provider.v1') throw new Error('Expected conversation service');
    const option = descriptor.selectionOptions?.[0];
    expect(option?.titleKey).toBe('Synthetic Conversation');
    expect(descriptor.description).toEqual(description);
    // Service descriptions do not become billing-option subtitles or identifiers.
    expect(option?.subtitleKey).toBe('');
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
      occurrenceId: `${pluginId}-activation-occurrence`,
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

  it('projects conditional credential requirements identically for bundled and external declarations', async () => {
    const conditionalDeclaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: 'conditional-credential-parity',
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
          requirement: { kind: 'when_setting_equals', settingId: 'billingMode', value: 'byo' },
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
        settings: {
          schemaVersion: 1,
          fields: [{
            id: 'billingMode',
            title: 'Billing mode',
            schema: { type: 'string', enum: ['hosted', 'byo'] },
            default: 'hosted',
            presentation: {
              control: 'select',
              options: [
                { value: 'hosted', title: 'Hosted' },
                { value: 'byo', title: 'Bring your own key' },
              ],
            },
          }],
        },
      }],
    }).voiceProviders[0]!);
    const pluginId = 'acme.conditional-parity';
    const providerId = `${pluginId}/${conditionalDeclaration.id}`;
    const bundled = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId, providerId, declaration: conditionalDeclaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        selectionOptions: [
          {
            id: 'hosted', modeId: 'hosted', order: 10,
            titleKey: 'Hosted', subtitleKey: 'Hosted', configPatch: { billingMode: 'hosted' },
          },
          {
            id: 'byo', modeId: 'byo', order: 20,
            titleKey: 'BYO', subtitleKey: 'BYO', configPatch: { billingMode: 'byo' },
          },
        ],
      }],
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId,
      occurrenceId: `${pluginId}-activation-occurrence`,
      declarations: [conditionalDeclaration],
      hostPlatform: 'web',
    });
    onTestFinished(async () => {
      await scope.unwind();
      hostLease.revoke();
    });
    scope.api.voiceProviders.register(conditionalDeclaration.id, createProviderLeaf());
    await scope.commit();
    const external = createDefaultVoiceProviderRegistry().get(providerId);

    expect(bundled.get(providerId)?.requirementsByMode).toEqual({ hosted: [], byo: ['credential'] });
    expect(external?.requirementsByMode).toEqual({ default: [] });
    expect(external?.requirements).toContain('credential');
    expect(external?.projectSettings?.({
      schemaVersion: 1,
      config: { billingMode: 'hosted' },
    })).toMatchObject({ requirements: [] });
    expect(external?.projectSettings?.({
      schemaVersion: 1,
      config: { billingMode: 'byo' },
    })).toMatchObject({ requirements: ['credential'] });
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
      occurrenceId: 'acme-synthetic-voice-activation-occurrence',
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
      occurrenceId: 'acme-invalid-voice-activation-occurrence',
      declarations: [mismatchedDeclaration as typeof credentialDeclaration],
      hostPlatform: 'web',
    })).toThrow(/invalid_external_voice_provider_declaration/u);
  });

  it('unwinds a committed contribution when an external registration listener throws', async () => {
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: identity.pluginId, occurrenceId: 'acme-synthetic-voice-activation-occurrence', declarations: [declaration], hostPlatform: 'web',
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
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const providerId = 'acme.synthetic-voice/conversation';
    const history = createSessionFixture({ id: 'external-history', serverId: account.scope.serverId,
      metadata: writeVoiceProviderConversationMetadata({ path: '/voice', host: 'voice.test',
        ...buildVoiceTranscriptHistorySessionMetadata() }, {
        providerId, state: { conversationId: 'retained-provider-thread' }, updatedAt: Date.now(),
      }),
    });
    const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [history.id]: history }));
    const request = account.request.getMockImplementation();
    if (!request) throw new Error('Account HTTP boundary missing');
    account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
      if (new URL(String(input)).pathname === '/v2/sessions/lookup-by-tags') {
        const { SessionLookupByTagsRequestV2Schema} = await import('@happier-dev/protocol/sessions/control/contract');
        expect(SessionLookupByTagsRequestV2Schema.parse(JSON.parse(String(init?.body))).tags)
          .toEqual([VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG]);
        const detail = sessionHttp.handle(new URL(`/v2/sessions/${history.id}`, String(input)));
        if (!detail) throw new Error('Missing History HTTP record');
        const { SessionLookupByTagsResponseV2Schema} = await import('@happier-dev/protocol/sessions/control/contract');
        return Response.json(SessionLookupByTagsResponseV2Schema.parse({ sessions: [(await detail.json()).session] }));
      }
      return sessionHttp.handle(input, init) ?? request(input, init);
    }));
    storage.setState({ sessions: { [history.id]: history } });
    registerVoiceAdapters([]);
    const hostLease = createBundledConversationRuntimeHostLease();
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({ identity, bytes: new Uint8Array([47, 47]), format: 'plainJs' });
    const forgetProviderConversation = vi.fn(async () => {});
    const setInputMuted = vi.fn(async () => undefined);
    const disposeProviderLeaf = vi.fn(async () => {});
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'commonJs',
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
    const authority = Object.freeze({ serverId: 'server-1', machineId: 'machine-1' });
    await host.replaceAuthority(authority);

    const activationInput = {
      cache,
      identity,
      moduleReference: {
        exportName: declaration.client.exportName,
      },
      backend,
      hostPlatform: 'web',
      authority,
      createScope: () => createExternalVoiceProviderActivationScope({
        pluginId: identity.pluginId,
        occurrenceId: 'acme-synthetic-voice-activation-occurrence',
        declarations: [declaration],
        hostPlatform: 'web',
        runtimeHost: hostLease.host,
        isRuntimeHostCurrent: () =>
          getCurrentBundledConversationRuntimeHost() === hostLease.host,
      }),
    } as const;
    await expect(host.activate(activationInput)).resolves.toEqual({ ok: true });
    expect(getCurrentBundledConversationRuntimeHost()).toBe(hostLease.host);

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
      status: 'ready', modeId: 'default',
    });
    expect(descriptor.providerSettings?.parseStoredConfig({ extra: true })).toEqual({});
    expect(descriptor.providerSettings?.parseConfig({ extra: true })).toBeNull();
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
    })).toEqual(resolveVoiceAdapterSurfaceCapabilities(providerId, {
      providerId,
      providers: { [providerId]: { schemaVersion: 1, config: {} } },
    }));
    await expect(getVoiceAdapterRegistry().get(providerId)?.performRuntimeAction?.('forget_provider_conversation'))
      .resolves.toEqual({ status: 'completed' });
    expect(forgetProviderConversation).toHaveBeenCalledTimes(1);
    expect(readVoiceProviderConversationMetadata(
      readSessionOwnerMetadataView(storage.getState().sessions[history.id]!), providerId,
    )).toBeNull();
    expect(sessionHttp.writes).toContain(history.id);
    await host.invalidatePlugin(identity.pluginId);
    expect(disposeProviderLeaf).toHaveBeenCalledTimes(1);
    expect(getCurrentBundledConversationRuntimeHost()).toBe(hostLease.host);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
    await expect(adapter.start({
      sessionId: 'voice-after-retirement',
      requestedTargetSessionAddress: null,
    }))
      .rejects.toThrow(/voice_runtime_generation_revoked/u);
    await expect(host.activate(activationInput)).resolves.toEqual({ ok: true });
    const replacementAdapter = getVoiceAdapterRegistry().get(providerId);
    expect(replacementAdapter).not.toBeNull();
    if (!replacementAdapter) throw new Error('expected_replacement_external_voice_adapter');
    expect(createDefaultVoiceProviderRegistry().get(providerId)).not.toBeNull();
    await host.replaceAuthority({ ...authority, machineId: 'machine-2' });
    expect(disposeProviderLeaf).toHaveBeenCalledTimes(2);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
    await expect(replacementAdapter.start({
      sessionId: 'voice-after-update',
      requestedTargetSessionAddress: null,
    }))
      .rejects.toThrow(/voice_runtime_generation_revoked/u);
    await expect(host.activate(activationInput)).resolves.toMatchObject({
      ok: false, code: 'artifact_replaced',
    });
  });
});
