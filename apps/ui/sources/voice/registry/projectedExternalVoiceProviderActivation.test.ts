import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createRecipientContractDigestV1,
  createVoiceProviderRecipientContractFromCredentialsV1,
  DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  PluginContributesV2Schema,
  PluginManifestV2Schema,
  type PluginProjectionV2,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import {
  PluginUiArtifactsManifestV1Schema,
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
  type PluginUiArtifactDigestV1,
  type PluginUiArtifactCompatibilityKeyV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginUiExecutableModuleHost } from '@/components/plugins/reactNative/executableModuleHost';
import { getPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import {
  reconcileAppShellProjectedClientExecutables,
  unloadAppShellProjectedClientExecutables,
} from '@/components/appShell/plugins/appShellClientExecutableActivation';
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
import { createReactNativeWebLoaderBackend } from '@/components/plugins/reactNative/webLoaderBackend.web';
import { encodeBase64 } from '@/encryption/base64';
import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { PluginReactNativeExactArtifactByteFetcher } from '@/sync/domains/plugins/availability/reactNativeArtifactLease';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import {
  EMPTY_PLUGIN_UI_PROJECTION,
  resolvePluginUiProjectionState,
  type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { getVoiceAdapterRegistry, resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';
import { listLocalSttProviderSpecs } from '@/voice/settings/panels/localStt/providers/registry';
import { listLocalTtsProviderSpecs } from '@/voice/settings/panels/localTts/providers/registry';
import { readBundledSpeechSettingsDescriptorFromEntry } from '@/voice/settings/panels/bundledSpeech/descriptor';
import { createBundledSpeechRuntime } from '@/voice/runtime/bundledSpeech/bundledSpeechRuntime';
import { projectVoiceProviderAgentRealtimePassiveSetup } from '@/voice/settings/passiveSetup';

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { listExternalVoiceProviderRegistrations } from './externalVoiceProviderRegistrations';
import type {
  ExternalVoiceProviderRuntimeRegistration,
  VoiceConversationProviderContribution,
} from './externalVoiceProviderActivation';
import {
  withdrawProjectedExternalVoiceProviders,
} from './projectedExternalVoiceProviderActivation';
import { projectVoiceProviderSelectionRows, selectVoiceProviderOption } from './providerSelection';
import { resolveVoiceRoleReadiness } from './readiness';
import { projectVoiceSpeechEndpointReadiness } from './speechEndpointReadiness';

const rawCredentialMachineRpc = vi.hoisted(() => vi.fn());
const reactNativeArtifactDaemonTransport = vi.hoisted(() => ({
  fetch: vi.fn<PluginReactNativeExactArtifactByteFetcher>(),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: rawCredentialMachineRpc,
}));
vi.mock('@/sync/domains/plugins/availability/reactNativeArtifactDaemonTransport', () => ({
  fetchReactNativeExactArtifactBytesViaMachineRpc: reactNativeArtifactDaemonTransport.fetch,
}));
vi.mock('@/voice/settings/executionMachine', () => ({
  resolveVoiceExecutionMachineId: () => 'machine-1',
  isCapturedVoiceExecutionMachineCurrent: (machineId: string | null) => machineId === 'machine-1',
}));
afterEach(() => {
  rawCredentialMachineRpc.mockReset();
  reactNativeArtifactDaemonTransport.fetch.mockReset();
});

const voiceArtifactScope = Object.freeze({ serverId: 'server-1', accountId: 'account-1' });

function isVoiceReactNativeArtifactGraph<T extends Readonly<{ tier?: string; platform?: string }>>(
  artifactGraph: T,
): artifactGraph is T & Readonly<{ tier: 'reactNative'; platform: 'web' | 'ios' | 'android' }> {
  return artifactGraph.tier === 'reactNative'
    && (artifactGraph.platform === 'web' || artifactGraph.platform === 'ios' || artifactGraph.platform === 'android');
}

function createCurrentVoiceArtifactAdmission(input: Readonly<{
  pluginId: string;
  identity: PluginReactNativeBundleCacheIdentity;
  artifactGraph: {
    contributionId: string;
    tier: 'reactNative';
    platform: 'web' | 'ios' | 'android';
    digest: PluginUiArtifactDigestV1;
  };
  origin: Readonly<{
    serverIdentityId: string;
    materializationRef: { machineId: string; materializationId: string; pluginId: string };
  }>;
  scope?: Readonly<{ serverId: string; accountId: string }>;
}>) {
  const scope = input.scope ?? voiceArtifactScope;
  // Portable release facts retain generated-bundle compatibility only. The
  // current host/channel/capability facts belong to the Account adoption link.
  const releaseCompatibility = {
    hostUiApiVersion: input.identity.hostUiApiVersion,
    reactVersion: input.identity.reactVersion,
    reactNativeVersion: input.identity.reactNativeVersion,
    ...(input.identity.expoRuntimeVersion ? { expoRuntimeVersion: input.identity.expoRuntimeVersion } : {}),
    ...(input.identity.hermesVersion ? { hermesVersion: input.identity.hermesVersion } : {}),
  };
  const channel = input.identity.channel;
  if (channel !== 'desktop' && channel !== 'development' && channel !== 'internal' && channel !== 'store') {
    throw new Error(`unsupported voice Artifact fixture channel: ${channel}`);
  }
  const adoptionCompatibility: PluginUiArtifactCompatibilityKeyV1 = {
    ...releaseCompatibility,
    hostAppVersion: input.identity.hostAppVersion,
    platform: input.artifactGraph.platform,
    channel,
    nativeCapabilities: [],
  };
  const release = PluginReleaseFactsV1Schema.parse({
    ref: { pluginId: input.pluginId, version: '1.2.3' },
    archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
    normalizedManifest: {
      schemaVersion: 2,
      id: input.pluginId,
      version: '1.2.3',
      displayName: 'Voice fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {},
    },
    collectionContracts: [],
    uiSlots: [{
      contributionId: input.artifactGraph.contributionId,
      tier: input.artifactGraph.tier,
      platform: input.artifactGraph.platform,
      artifactDigest: input.artifactGraph.digest,
      compatibility: releaseCompatibility,
    }],
    packageAssetArchive: {
      archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
      resources: [],
    },
  });
  const materialization = {
    serverIdentityId: input.origin.serverIdentityId,
    machineId: input.origin.materializationRef.machineId,
    materializationId: input.origin.materializationRef.materializationId,
    pluginId: input.pluginId,
    version: release.ref.version,
    sourceClass: 'registryPackage' as const,
    portableRelease: true,
    archiveDigestSha256: release.archiveDigestSha256,
    uiArtifacts: release.uiSlots.map(({ compatibility: _compatibility, ...slot }) => slot),
    enabled: true,
    trustState: 'trusted' as const,
    observedAt: 1,
  };
  const reader = createPluginAccountAvailabilityReader({
    scope,
    snapshot: {
      availabilityCursor: 1,
      intentReads: [{
        pluginId: input.pluginId,
        response: {
          availabilityCursor: 1,
          hostingCapability: { enabled: false },
          intent: {
            pluginId: input.pluginId,
            desiredVersion: release.ref.version,
            enabled: true,
            offlineUiHosting: 'disabled',
            writableCollections: [],
            revision: 'intent-1',
          },
          release,
          uiArtifacts: [{
            release: release.ref,
            contributionId: input.artifactGraph.contributionId,
            tier: input.artifactGraph.tier,
            platform: input.artifactGraph.platform,
            artifactId: '00000000-0000-4000-8000-000000000001',
            artifactDigest: input.artifactGraph.digest,
            compatibility: adoptionCompatibility,
          }],
        },
      }],
      materializations: [materialization],
      snapshots: [],
    },
  });
  const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
  });
  return Object.freeze({ reader, lifetime });
}

function createProviderLeaf(): ExternalVoiceProviderRuntimeRegistration {
  return {
    kind: 'conversation',
    protocol: {
      async prepare() { return { kind: 'prepared', session: { config: {}, safeMetadata: null } }; },
      decodeControl: () => [],
      encodeTurnControl: () => null,
    },
    async createConnection() {
      return {
        kind: 'sdk_handle', async connect() {}, async sendControl() {},
        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }), async close() {},
        state: () => 'closed' as const, currentProviderSessionId: () => null, playbackCursorMs: () => null,
        beginOutputInterruptionCandidate: () => 'unsupported' as const, resolveOutputInterruptionCandidate() {},
      };
    },
    encodeToolResults: () => [], encodeToolContinuation: (responseId) => ({ type: 'continue', responseId }),
    encodeContextUpdate: (text) => [{ type: 'context', text }],
    encodeTextTurn: (text) => [{ type: 'text', text }],
    microphoneMode: 'provider_managed',
    setInputMuted: () => {},
  };
}

function requireConversationDeclaration(
  declaration: VoiceProviderContribution,
): VoiceConversationProviderContribution {
  if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
  return declaration;
}

describe('projected external Voice provider activation', () => {
  it('keeps complete-set reconciliation at the AppShell boundary', async () => {
    expect(reconcileAppShellProjectedClientExecutables).toBeTypeOf('function');

    const activationModule = await import('./projectedExternalVoiceProviderActivation');
    expect(activationModule).not.toHaveProperty('activateProjectedExternalVoiceProviders');
  });

  it('projects a current installed external speech declaration into the Voice registry and withdraws it with generation authority', async () => {
    rawCredentialMachineRpc.mockReset();
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: 'speech',
      title: 'Never-before-seen Speech',
      kind: 'speech',
      roles: ['conversation_stt', 'conversation_tts'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'baseUrl',
            title: 'Endpoint',
            schema: { type: 'string', minLength: 0, maxLength: 2048 },
            default: '',
            presentation: { control: 'text' },
          },
          {
            id: 'insecureLocalOriginConsent',
            title: 'Confirmed origin',
            schema: { type: 'string', minLength: 0, maxLength: 512 },
            default: '',
            presentation: { control: 'text', hidden: true },
          },
          {
            id: 'insecureLocalConsentMachineId',
            title: 'Confirmed machine',
            schema: { type: 'string', minLength: 0, maxLength: 512 },
            default: '',
            presentation: { control: 'text', hidden: true },
          },
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'synthetic-stt-v1',
            presentation: { control: 'text' },
          },
          {
            id: 'voiceName',
            title: 'Voice',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'synthetic-voice-v1',
            presentation: { control: 'text' },
          },
        ],
        actions: [{
          id: 'refresh-voice',
          title: 'Refresh voice',
          placement: { kind: 'contributionFooter' },
          confirmation: { kind: 'none' },
          patchFieldIds: ['voiceName'],
        }],
      },
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech', title: 'API key' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: {
              kind: 'httpHeaders',
              origin: 'https://speech.example.test',
              headerNames: ['authorization'],
            },
          }],
        }],
      },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');

    const pluginId = 'acme.external-speech';
    const contributionId = `${pluginId}/${declaration.id}`;
    const rawProjection: PluginProjectionV2 = {
      v: 2,
      generation: 31,
      installedPackagesById: {},
      agentsById: {},
      backendsById: {},
      actionsById: {},
      toolsById: {},
      commandsById: {},
      resourcesById: {},
      settingsById: {},
      familiesById: {
        voiceProviders: {
          family: 'voiceProviders',
          entriesById: {
            [contributionId]: {
              id: contributionId,
              pluginId,
              generation: 31,
              contributionKey: contributionId,
              definition: declaration,
            },
          },
        },
      },
      diagnostics: [],
    };
    const projection = resolvePluginUiProjectionState(EMPTY_PLUGIN_UI_PROJECTION, rawProjection);
    const executableHost = createPluginUiExecutableModuleHost();
    onTestFinished(async () => {
      await unloadAppShellProjectedClientExecutables(executableHost);
    });

    expect(projection.voiceProvidersById[contributionId]?.definition).toMatchObject({
      kind: 'speech',
      roles: ['conversation_stt', 'conversation_tts'],
    });

    const initialAttempts = await reconcileAppShellProjectedClientExecutables({
      projection: null,
      platform: 'web',
      // Catalog projection remains authoritative even when Voice interaction
      // cannot activate an executable runtime on this client.
      voiceProviderProjection: projection,
      voice: null,
      executableHost,
    });

    const installedRegistrations = listExternalVoiceProviderRegistrations()
      .filter((registration) => registration.pluginId === pluginId && registration.localId === declaration.id);
    const installedRegistration = installedRegistrations.find(
      (registration) => registration.descriptor?.kind === 'voice.speech-engine.v1',
    ) ?? null;
    const installedEntry = installedRegistrations
      .map((registration) => registration.descriptor)
      .find((entry) => entry?.kind === 'voice.speech-engine.v1') ?? null;
    const installedRegistry = createDefaultVoiceProviderRegistry();
    const installedSettingsDescriptor = readBundledSpeechSettingsDescriptorFromEntry(
      contributionId,
      installedRegistry.get(contributionId),
    );
    const actionSignal = new AbortController().signal;
    rawCredentialMachineRpc.mockResolvedValueOnce({ ok: true, patch: { voiceName: 'synthetic-voice-v2' } });
    if (!installedRegistration?.settingsActions) {
      throw new Error('speech_settings_action_projection_required');
    }
    await expect(installedRegistration.settingsActions.execute({
      actionId: 'refresh-voice',
      settings: {
        baseUrl: '',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'synthetic-stt-v1',
        voiceName: 'synthetic-voice-v1',
      },
      settingsRevision: '7',
      signal: actionSignal,
    })).resolves.toEqual({ patch: { voiceName: 'synthetic-voice-v2' } });
    expect(rawCredentialMachineRpc).toHaveBeenCalledWith({
      machineId: 'machine-1',
      method: 'daemon.voice.speech.settingsAction.execute',
      payload: {
        target: { pluginId, localId: declaration.id },
        actionId: 'refresh-voice',
        settings: {
          baseUrl: '',
          insecureLocalOriginConsent: '',
          insecureLocalConsentMachineId: '',
          model: 'synthetic-stt-v1',
          voiceName: 'synthetic-voice-v1',
        },
        expectedSettingsVersion: 7,
      },
      signal: actionSignal,
    });
    const installedSttSpec = listLocalSttProviderSpecs().find((spec) => spec.id === contributionId) ?? null;
    const installedTtsSpec = listLocalTtsProviderSpecs().find((spec) => spec.id === contributionId) ?? null;
    const speechRuntime = createBundledSpeechRuntime({
      registry: installedRegistry,
      client: {
        transcribe: vi.fn(async () => 'external transcript'),
        synthesize: vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' as const })),
      },
    });
    const readiness = installedEntry
      ? resolveVoiceRoleReadiness({
          registry: installedRegistry,
          role: 'conversation_stt',
          providerId: installedEntry.providerId,
          platform: 'web',
          facts: {
            settings: 'ready',
            executionMachine: 'ready',
            credential: 'missing',
            endpoint: 'ready',
          },
        })
      : null;
    const insecureEndpointFact = installedEntry
      ? projectVoiceSpeechEndpointReadiness({
          registry: installedRegistry,
          role: 'conversation_stt',
          providerId: installedEntry.providerId,
          providerEnvelope: {
            schemaVersion: 2,
            config: {
              baseUrl: 'http://localhost:11434/v1',
              insecureLocalOriginConsent: '',
              insecureLocalConsentMachineId: '',
              model: 'synthetic-stt-v1',
              voiceName: 'synthetic-voice-v1',
            },
          },
          executionMachineId: 'machine-1',
        })
      : null;
    const confirmedEndpointFact = installedEntry
      ? projectVoiceSpeechEndpointReadiness({
          registry: installedRegistry,
          role: 'conversation_stt',
          providerId: installedEntry.providerId,
          providerEnvelope: {
            schemaVersion: 2,
            config: {
              baseUrl: 'https://speech.example.test/v1',
              insecureLocalOriginConsent: '',
              insecureLocalConsentMachineId: '',
              model: 'synthetic-stt-v1',
              voiceName: 'synthetic-voice-v1',
            },
          },
          executionMachineId: 'machine-1',
        })
      : null;
    const endpointMissingReadiness = installedEntry && insecureEndpointFact
      ? resolveVoiceRoleReadiness({
          registry: installedRegistry,
          role: 'conversation_stt',
          providerId: installedEntry.providerId,
          platform: 'web',
          facts: {
            settings: 'ready',
            executionMachine: 'ready',
            credential: 'ready',
            endpoint: insecureEndpointFact,
          },
        })
      : null;
    const confirmedEndpointReadiness = installedEntry && confirmedEndpointFact
      ? resolveVoiceRoleReadiness({
          registry: installedRegistry,
          role: 'conversation_stt',
          providerId: installedEntry.providerId,
          platform: 'web',
          facts: {
            settings: 'ready',
            executionMachine: 'ready',
            credential: 'ready',
            endpoint: confirmedEndpointFact,
          },
        })
      : null;

    const removedProjection = resolvePluginUiProjectionState(projection, {
      ...rawProjection,
      generation: 32,
      familiesById: {},
    });
    const removedAttempts = await reconcileAppShellProjectedClientExecutables({
      projection: null,
      platform: 'web',
      voice: Object.freeze({
        projection: removedProjection,
        machineId: 'machine-1',
        serverId: null,
      }),
      executableHost,
    });
    const registrationsAfterRemoval = listExternalVoiceProviderRegistrations()
      .filter((registration) => registration.pluginId === pluginId && registration.localId === declaration.id);

    expect({
      installed: installedEntry,
      installedSettingsDescriptor,
      installedSttSpec,
      installedTtsSpec,
      sttProviderIds: speechRuntime.sttProviderIds(),
      ttsProviderIds: speechRuntime.ttsProviderIds(),
      readiness,
      insecureEndpointFact,
      confirmedEndpointFact,
      endpointMissingReadiness,
      confirmedEndpointReadiness,
      registrationsAfterRemoval,
    }).toMatchObject({
      installed: {
        kind: 'voice.speech-engine.v1',
        roles: ['conversation_stt', 'conversation_tts'],
        requirements: ['execution_machine', 'endpoint', 'credential'],
        supportedPlatforms: ['web'],
        source: {
          kind: 'external',
          pluginId,
          localId: declaration.id,
        },
      },
      installedSettingsDescriptor: {
        providerId: contributionId,
        role: 'both',
        actions: [{ id: 'refresh-voice', placement: { kind: 'contributionFooter' } }],
        fields: [
          { key: 'baseUrl', kind: 'text' },
          { key: 'model', kind: 'text' },
          { key: 'voiceName', kind: 'text' },
        ],
        endpointConsent: {
          baseUrlFieldId: 'baseUrl',
          originConsentFieldId: 'insecureLocalOriginConsent',
          machineConsentFieldId: 'insecureLocalConsentMachineId',
        },
      },
      installedSttSpec: { id: contributionId },
      installedTtsSpec: { id: contributionId },
      sttProviderIds: expect.arrayContaining([contributionId]),
      ttsProviderIds: expect.arrayContaining([contributionId]),
      readiness: {
        status: 'needs_setup',
        code: 'credential_missing',
        recoveryAction: 'configure_credential',
      },
      insecureEndpointFact: 'missing',
      confirmedEndpointFact: 'ready',
      endpointMissingReadiness: {
        status: 'needs_setup',
        code: 'endpoint_missing',
        recoveryAction: 'configure_endpoint',
      },
      confirmedEndpointReadiness: {
        status: 'ready',
        code: 'ready',
        recoveryAction: 'none',
      },
      registrationsAfterRemoval: [],
    });

    expect(initialAttempts).toEqual([]);
    expect(removedAttempts).toEqual([]);

  });

  it('selects and dispatches the credential-less speech contributions from the packed external fixture', async () => {
    const fixtureRoot = new URL(
      '../../../../cli/src/plugins/testkit/fixtures/packed-external-voice-provider/',
      import.meta.url,
    );
    const manifest = PluginManifestV2Schema.parse(JSON.parse(
      await readFile(new URL('.happier-plugin/plugin.json', fixtureRoot), 'utf8'),
    ));
    const declarations = manifest.contributes.voiceProviders.filter(
      (candidate): candidate is Extract<VoiceProviderContribution, { kind: 'speech' }> => candidate.kind === 'speech',
    );
    const generation = 37;
    const entriesById = Object.fromEntries(declarations.map((declaration) => {
      const id = `${manifest.id}/${declaration.id}`;
      return [id, { id, pluginId: manifest.id, generation, contributionKey: id, definition: declaration }];
    }));
    const projection = resolvePluginUiProjectionState(EMPTY_PLUGIN_UI_PROJECTION, {
      v: 2,
      generation,
      installedPackagesById: {},
      agentsById: {},
      backendsById: {},
      actionsById: {},
      toolsById: {},
      commandsById: {},
      resourcesById: {},
      settingsById: {},
      familiesById: {
        voiceProviders: { family: 'voiceProviders', entriesById },
      },
      diagnostics: [],
    });
    const host = createPluginUiExecutableModuleHost();
    onTestFinished(async () => withdrawProjectedExternalVoiceProviders(host));

    await expect(reconcileAppShellProjectedClientExecutables({
      projection: null,
      platform: 'web',
      voice: Object.freeze({
        projection,
        machineId: 'machine-1',
        serverId: null,
      }),
      executableHost: host,
    })).resolves.toEqual([]);

    const registry = createDefaultVoiceProviderRegistry();
    const transcribe = vi.fn(async () => 'packed transcript');
    const synthesize = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/wav' as const,
    }));
    const play = vi.fn(async () => undefined);
    const speechRuntime = createBundledSpeechRuntime({
      registry,
      client: {
        transcribe,
        synthesize,
      },
      platformOs: 'ios',
      play,
    });
    expect(declarations.map((declaration) => declaration.credentials)).toEqual([undefined, undefined]);
    expect(listLocalSttProviderSpecs().find((spec) => spec.id === `${manifest.id}/speech-stt`)).toMatchObject({
      id: `${manifest.id}/speech-stt`,
    });
    expect(listLocalTtsProviderSpecs().find((spec) => spec.id === `${manifest.id}/speech-tts`)).toMatchObject({
      id: `${manifest.id}/speech-tts`,
    });
    expect(speechRuntime.sttProviderIds()).toContain(`${manifest.id}/speech-stt`);
    expect(speechRuntime.ttsProviderIds()).toContain(`${manifest.id}/speech-tts`);

    await expect(speechRuntime.transcribeRecordedAudio(`${manifest.id}/speech-stt`, {
      uri: 'file:///recording.wav',
      providerConfig: { model: 'packed-stt-v1' },
      fallbackLanguage: 'en',
    })).resolves.toBe('packed transcript');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: `${manifest.id}/speech-stt` }),
      model: 'packed-stt-v1',
    }));

    await expect(speechRuntime.speak(`${manifest.id}/speech-tts`, {
      text: 'packed speech',
      providerConfig: { voice: 'packed-voice-primary' },
      registerPlaybackStopper: () => () => {},
    })).resolves.toBeUndefined();
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: `${manifest.id}/speech-tts` }),
      voiceName: 'packed-voice-primary',
    }));
    expect(play).toHaveBeenCalledOnce();
  });

  it('prepares a normalized web Voice target through the strict executable-platform seam', async () => {
    const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({ voiceProviders: [{
      id: 'conversation', title: 'Desktop-web Voice', kind: 'conversation',
      roles: ['realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: true, bargeIn: false } },
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
    }] }).voiceProviders[0]!);
    const pluginId = 'acme.desktop-web-voice';
    const generation = 23;
    const entryPath = 'react-native/voice-runtime-web/index.js';
    const bytes = new TextEncoder().encode('// desktop web voice bundle');
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const artifactGraph = PluginUiArtifactsManifestV1Schema.parse({ version: 1, entries: [{
      contributionId: declaration.client.artifactId,
      tier: 'reactNative', platform: 'web', entry: entryPath,
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }], digest,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      hostUiApiVersion: '1.0.0', compat: { react: '19.0.0', reactNative: '0.83.4' },
    }] }).entries[0]!;
    if (!isVoiceReactNativeArtifactGraph(artifactGraph)) {
      throw new Error('expected web React Native Artifact graph');
    }
    const identity = Object.freeze({
      pluginId, contributionId: declaration.id, artifactDigest: digest,
      hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
      platform: 'web' as const, channel: 'internal' as const,
      nativeCapabilitiesDigest: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
      projectionGeneration: generation,
    });
    const origin = Object.freeze({
      serverIdentityId: 'srv_desktop_web_voice',
      materializationRef: Object.freeze({
        pluginId,
        machineId: 'machine-1',
        materializationId: 'desktop-web-voice-install',
      }),
    });
    const providerId = `${pluginId}/${declaration.id}`;
    const projection: PluginUiProjectionModel = Object.freeze({
      ...EMPTY_PLUGIN_UI_PROJECTION,
      generation,
      voiceProvidersById: Object.freeze({
        [providerId]: Object.freeze({
          id: providerId, pluginId, generation, contributionKey: providerId, definition: declaration, ...origin,
        }),
      }),
      reactNativeBundlesById: Object.freeze({
        [`reactNativeBundle:${pluginId}:${declaration.id}`]: Object.freeze({
          id: `reactNativeBundle:${pluginId}:${declaration.id}`,
          pluginId,
          contributionKind: 'reactNativeBundle' as const,
          contributionId: declaration.id,
          generatedOwnerKind: 'voiceProvider',
          ...origin,
          artifactGraph,
          runtime: Object.freeze({
            decision: Object.freeze({ state: 'load' }),
            loadPolicy: Object.freeze({ source: 'installedArtifact' }),
            cacheIdentity: identity,
          }),
        }),
      }),
    });
    const { reader, lifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity,
      artifactGraph,
      origin,
    });
    const executableHost = createPluginUiExecutableModuleHost();
    const fetchArtifactBytes = vi.fn(async () => ({
      ok: true as const,
      artifactFamily: 'reactNative' as const,
      artifactOwnerKind: 'voiceProvider' as const,
      cacheIdentity: identity,
      artifact: {
        pluginId,
        contributionId: declaration.id,
        artifactKind: 'reactNativeBundle' as const,
        digest,
        format: 'plainJs' as const,
        byteSize: bytes.byteLength,
      },
      bytesBase64: encodeBase64(bytes),
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
    }));
    reactNativeArtifactDaemonTransport.fetch.mockImplementation(fetchArtifactBytes);
    const hostLease = createBundledConversationRuntimeHostLease();
    const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'reactNativeWebModule',
      available: true,
      loadInstalledBundle: vi.fn(async () => (api: PluginClientApi) => {
        api.voiceProviders.register(declaration.id, createProviderLeaf());
      }),
    });
    const attempts = await reconcileAppShellProjectedClientExecutables({
      projection: null,
      platform: 'web',
      voice: Object.freeze({
        projection,
        machineId: 'machine-1',
        serverId: 'server-1',
      }),
      executableHost,
      loaderBackend,
      reader,
      accountLifetime: lifetime,
    });
    onTestFinished(async () => {
      await unloadAppShellProjectedClientExecutables(executableHost);
      hostLease.revoke();
    });

    expect(fetchArtifactBytes).toHaveBeenCalledWith(expect.objectContaining({
      artifactOwnerKind: 'voiceProvider',
    }));
    expect(attempts).toMatchObject([{
      result: { ok: true },
      activation: { target: { platform: 'web' } },
    }]);
  });

  it.each(['ios', 'android'] as const)('loads a generated %s Re.Pack artifact through public activate(api) and unloads it', async (platform) => {
    const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({ voiceProviders: [{
      id: 'conversation', title: `Synthetic ${platform}`, kind: 'conversation',
      roles: ['realtime_conversation'], platforms: [platform],
      capabilities: { turn: { cancelResponse: true, bargeIn: false } },
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: 'codex',
        supportedRuntimeVersions: ['1.2.3'],
      },
      settings: {
        schemaVersion: 2,
        fields: [],
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Codex account',
          agent: 'codex',
          serviceIds: ['openai-codex'],
        },
      },
      client: { artifactId: 'voice-runtime-native', modulePath: './voiceRuntime', exportName: 'activate' },
    }] }).voiceProviders[0]!);
    const entryPath = `react-native/voice-runtime-native/${platform}.bundle`;
    const bytes = new TextEncoder().encode(`// ${platform} repack bundle`);
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const parsedArtifactGraph = PluginUiArtifactsManifestV1Schema.parse({ version: 1, entries: [{
      contributionId: declaration.client.artifactId,
      tier: 'reactNative', platform, entry: entryPath,
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }], digest,
      builtWith: { bundler: 'repack', version: '5.2.5' },
      repack: {
        containerName: `published_${platform}_voice_container`,
        modulePath: declaration.client.modulePath,
        exportName: declaration.client.exportName,
      },
      hostUiApiVersion: '1.0.0', compat: { react: '19.0.0', reactNative: '0.83.4' },
    }] }).entries[0]!;
    if (!isVoiceReactNativeArtifactGraph(parsedArtifactGraph)) {
      throw new Error('expected generated React Native Artifact graph');
    }
    const artifactGraph = parsedArtifactGraph;
    const pluginId = `acme.synthetic-${platform}`;
    const providerId = `${pluginId}/conversation`;
    const generation = platform === 'ios' ? 21 : 22;
    const identity = Object.freeze({
      pluginId, contributionId: declaration.id, artifactDigest: digest,
      hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
      platform, channel: 'internal', nativeCapabilitiesDigest: `sha256:${'a'.repeat(64)}`, projectionGeneration: generation,
    });
    const origin = Object.freeze({
      serverIdentityId: 'srv_account_one',
      materializationRef: Object.freeze({
        machineId: 'machine-1',
        materializationId: `voice-install-${platform}`,
        pluginId,
      }),
    });
    const projection: PluginUiProjectionModel = Object.freeze({
      ...EMPTY_PLUGIN_UI_PROJECTION,
      generation,
      voiceProvidersById: Object.freeze({
        [providerId]: Object.freeze({
          id: providerId, pluginId, generation, contributionKey: providerId, definition: declaration,
          ...origin,
        }),
      }),
      reactNativeBundlesById: Object.freeze({
        [`reactNativeBundle:${pluginId}:${declaration.id}`]: Object.freeze({
          id: `reactNativeBundle:${pluginId}:${declaration.id}`,
          pluginId, contributionKind: 'reactNativeBundle', contributionId: declaration.id,
          generatedOwnerKind: 'voiceProvider',
          ...origin,
          artifactGraph,
          runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: identity },
        }),
      }),
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const executableHost = createPluginUiExecutableModuleHost();
    const { reader, lifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity,
      artifactGraph,
      origin,
    });
    const activate = vi.fn((api: PluginClientApi) => {
      api.voiceProviders.register(declaration.id, createProviderLeaf());
    });
    const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'repackScriptManager', available: true,
      loadInstalledBundle: vi.fn(async () => activate),
    });
    onTestFinished(async () => {
      await unloadAppShellProjectedClientExecutables(executableHost);
      hostLease.revoke();
    });

    const fetchArtifactBytes = vi.fn(async () => ({
      ok: true as const, artifactFamily: 'reactNative' as const, artifactOwnerKind: 'voiceProvider' as const, cacheIdentity: identity,
      artifact: { pluginId, contributionId: declaration.id, artifactKind: 'reactNativeBundle' as const, digest, format: 'plainJs' as const, byteSize: bytes.byteLength },
      bytesBase64: encodeBase64(bytes),
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
    }));
    reactNativeArtifactDaemonTransport.fetch.mockImplementation(fetchArtifactBytes);
    await expect(reconcileAppShellProjectedClientExecutables({
      projection,
      platform,
      voice: {
        projection,
        machineId: 'machine-1',
        serverId: 'server-1',
      },
      executableHost,
      loaderBackend,
    })).resolves.toEqual([]);
    expect(fetchArtifactBytes).not.toHaveBeenCalled();

    const currentActivation = {
      projection,
      platform,
      voice: Object.freeze({
        projection,
        machineId: 'machine-1',
        serverId: 'server-1',
      }),
      executableHost,
      loaderBackend,
      reader,
      accountLifetime: lifetime,
    };
    const attempts = await reconcileAppShellProjectedClientExecutables(currentActivation);
    expect(fetchArtifactBytes).toHaveBeenCalledWith(expect.objectContaining({
      artifactOwnerKind: 'voiceProvider',
    }));
    expect(attempts).toMatchObject([{
      result: { ok: true },
      reused: false,
      activation: {
        pluginId,
        contributes: {
          voiceProviders: [{ id: declaration.id }],
        },
      },
    }]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(loaderBackend.loadInstalledBundle).toHaveBeenCalledWith(expect.objectContaining({
      moduleReference: artifactGraph.repack,
    }));
    expect(getVoiceAdapterRegistry().get(providerId)).toMatchObject({
      resolveConversationBinding: expect.any(Function),
    });
    const installedEntry = createDefaultVoiceProviderRegistry().get(providerId);
    expect(installedEntry?.requirements).toEqual(['execution_machine', 'runtime']);
    expect(projectVoiceProviderAgentRealtimePassiveSetup(
      installedEntry?.kind === 'voice.conversation-provider.v1'
        ? installedEntry.declaration?.execution
        : null,
    )).toMatchObject({ capabilityId: 'cli.codex' });
    const installedProviderSettings = {
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
                    profileId: 'installed-codex',
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, installedProviderSettings)).toMatchObject({
      agentRuntime: {
        pluginId,
        localId: 'codex',
      },
    });

    await unloadAppShellProjectedClientExecutables(executableHost);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
  });

  it('consumes the real projection/artifact path and activates the declared export', async () => {
    const fixtureRoot = new URL(
      '../../../../cli/src/plugins/testkit/fixtures/packed-external-voice-provider/',
      import.meta.url,
    );
    const pluginManifest = PluginManifestV2Schema.parse(JSON.parse(
      await readFile(new URL('.happier-plugin/plugin.json', fixtureRoot), 'utf8'),
    ));
    const declarations = pluginManifest.contributes.voiceProviders
      .filter((candidate) => candidate.kind === 'conversation')
      .map(requireConversationDeclaration);
    const action = pluginManifest.contributes.actions[0]!;
    const declaration = declarations[0]!;
    const artifactRoot = new URL('dist/happier-plugin-ui/', fixtureRoot);
    const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(
      await readFile(new URL('ui-artifacts.json', artifactRoot), 'utf8'),
    ));
    const artifactGraphCandidate = manifest.entries.find((entry) => entry.contributionId === declaration.client.artifactId)!;
    if (!isVoiceReactNativeArtifactGraph(artifactGraphCandidate)) {
      throw new Error('expected packed external voice provider React Native Artifact graph');
    }
    const artifactGraph = artifactGraphCandidate;
    const bytes = new Uint8Array(await readFile(new URL(artifactGraph.entry, artifactRoot)));
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = artifactGraph.digest;
    const pluginId = pluginManifest.id;
    const origin = Object.freeze({
      serverIdentityId: 'srv_account_one',
      materializationRef: Object.freeze({
        machineId: 'machine-1',
        materializationId: 'packed-voice-install-one',
        pluginId,
      }),
    });
    const identitiesByLocalId = Object.freeze(Object.fromEntries(declarations.map((candidate) => [
      candidate.id,
      Object.freeze({
        pluginId, contributionId: candidate.id, artifactDigest: digest,
        hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
        platform: 'web', channel: 'internal', nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`, projectionGeneration: 12,
      }),
    ])));
    const identity = identitiesByLocalId[declaration.id]!;
    const actionIdentity = Object.freeze({
      ...identity,
      contributionId: action.id,
    });
    const providerId = `${pluginId}/${declaration.id}`;
    const voiceProviderEntries = Object.fromEntries(declarations.map((candidate) => {
      const candidateProviderId = `${pluginId}/${candidate.id}`;
      const hostMediated = candidate.credentials?.hostMediated;
      const recipientContract = candidate.credentials && hostMediated
        ? createVoiceProviderRecipientContractFromCredentialsV1({
            package: {
              pluginId,
              source: { kind: 'package', locator: pluginId },
            },
            publisher: {
              trust: 'verified',
              identity: `package:${pluginId}`,
            },
            contribution: {
              pluginId,
              localId: candidate.id,
            },
            credentials: {
              slot: candidate.credentials.slot,
              hostMediated,
            },
            presentation: { title: candidate.title },
          })
        : null;
      return [candidateProviderId, {
        id: candidateProviderId,
        pluginId,
        generation: 12,
        contributionKey: candidateProviderId,
        ...origin,
        definition: candidate,
        ...(recipientContract
          ? {
              recipientContract,
              recipientContractDigest: createRecipientContractDigestV1(recipientContract),
            }
          : {}),
      }] as const;
    }));
    const pluginUiEntries = Object.fromEntries([action, ...declarations].map((candidate) => {
      const candidateIdentity = identitiesByLocalId[candidate.id]!;
      const id = `reactNativeBundle:${pluginId}:${candidate.id}`;
        return [id, {
          id,
          pluginId,
          contributionKind: 'reactNativeBundle' as const,
          contributionId: candidate.id,
          generatedOwnerKind: candidate.id === action.id ? 'clientContribution' : 'voiceProvider',
          ...origin,
          artifactGraph,
        runtime: {
          decision: { state: 'load' as const },
          loadPolicy: { source: 'installedArtifact' as const },
          cacheIdentity: candidate.id === action.id ? actionIdentity : candidateIdentity,
        },
      }] as const;
    }));
    const rawProjection: PluginProjectionV2 = {
      v: 2,
      generation: 12,
      installedPackagesById: {}, agentsById: {}, backendsById: {}, actionsById: {
        [`${pluginId}/${action.id}`]: {
          ...action,
          pluginId,
          ...origin,
          available: true,
        },
      }, toolsById: {},
      commandsById: {}, resourcesById: {}, settingsById: {},
      familiesById: {
        voiceProviders: {
          family: 'voiceProviders',
          entriesById: voiceProviderEntries,
        },
        pluginUi: {
          family: 'pluginUi',
          entriesById: pluginUiEntries,
        },
      },
      diagnostics: [],
    };
    const projection = resolvePluginUiProjectionState(EMPTY_PLUGIN_UI_PROJECTION, rawProjection);
    const actionProjection = unionPluginUiProjections([{
      machineId: 'machine-1',
      serverId: 'server-1',
      projection,
      phase: 'current',
      interactionEnabled: true,
    }], new Map([[pluginId, origin]])).pluginUiProjection;
    if (!actionProjection) throw new Error('expected packed external Voice app projection');
    const { reader, lifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity,
      artifactGraph,
      origin,
    });
    const source = new TextDecoder().decode(bytes);
    const moduleBackend = createReactNativeWebLoaderBackend({
      importModule: async () => import(
        /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}#${digest}`
      ) as Promise<Readonly<{ default?: unknown } & Record<string, unknown>>>,
    });
    let loads = 0;
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
      ...moduleBackend,
      async loadInstalledBundle(input) {
        loads += 1;
        return await moduleBackend.loadInstalledBundle!(input);
      },
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const host = createPluginUiExecutableModuleHost();
    onTestFinished(async () => {
      await unloadAppShellProjectedClientExecutables(host);
      hostLease.revoke();
    });

    reactNativeArtifactDaemonTransport.fetch.mockImplementation(async (input) => ({
      ok: true as const,
      artifactFamily: 'reactNative' as const,
      ...(input.artifactOwnerKind === 'clientContribution'
        ? { artifactOwnerKind: 'clientContribution' as const, clientContribution: input.clientContribution }
        : { artifactOwnerKind: 'voiceProvider' as const }),
      cacheIdentity: input.identity,
      artifact: { pluginId: input.identity.pluginId, contributionId: input.identity.contributionId, artifactKind: 'reactNativeBundle' as const, digest, format: 'plainJs' as const, byteSize: bytes.byteLength },
      bytesBase64: encodeBase64(bytes),
      files: [{
        relativePath: artifactGraph.entry,
        digest: entryDigest,
        byteSize: bytes.byteLength,
        bytesBase64: encodeBase64(bytes),
      }],
    }));
    const activationInput = {
      projection: actionProjection,
      platform: 'web' as const,
      voice: Object.freeze({
        projection,
        machineId: 'machine-1',
        serverId: 'server-1',
      }),
      executableHost: host,
      loaderBackend: backend,
      reader,
      accountLifetime: lifetime,
    };
    const initialAttempts = await reconcileAppShellProjectedClientExecutables(activationInput);
    expect(initialAttempts).toMatchObject([{
      result: { ok: true },
      reused: false,
      activation: {
        pluginId,
        contributes: { voiceProviders: expect.any(Array) },
      },
    }]);
    expect(loads).toBe(1);
    expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();
    const registry = createDefaultVoiceProviderRegistry();
    expect(registry.get(providerId)).not.toBeNull();
    const unselected = voiceSettingsParse({ providerId: null });
    const externalRow = projectVoiceProviderSelectionRows(unselected, registry)
      .find((row) => row.providerId === providerId);
    expect(externalRow).toMatchObject({ optionId: 'default', selected: false });
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, unselected)).toBeNull();
    const selected = selectVoiceProviderOption(unselected, registry, providerId, 'default');
    expect(selected).toMatchObject({
      providerId,
      providers: {
        [providerId]: {
          schemaVersion: 2,
          config: {
            profile: 'balanced',
            enableProvisioning: true,
          },
        },
      },
    });
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, selected)).toEqual({
      allowsGlobalStart: true, controlSessionScope: 'global', requiresVoiceAgentFeature: false,
      bargeInEnabled: false, cancelResponse: 'immediate', interruptionPolicy: 'disabled',
      agentRuntime: {
        pluginId,
        localId: 'voice-agent',
      },
    });

    const declarationB = requireConversationDeclaration(PluginContributesV2Schema.parse({ voiceProviders: [{
      ...declaration,
      title: 'Synthetic B',
      capabilities: {
        turn: { cancelResponse: false, bargeIn: false },
      },
    }] }).voiceProviders[0]!);
    const replacementOrigin = Object.freeze({
      serverIdentityId: 'srv_account_two',
      materializationRef: Object.freeze({
        machineId: 'machine-2',
        materializationId: 'packed-voice-install-two',
        pluginId,
      }),
    });
    const { reader: replacementReader, lifetime: replacementLifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity,
      artifactGraph,
      origin: replacementOrigin,
      scope: { serverId: 'server-2', accountId: 'account-1' },
    });
    const projectionB: PluginUiProjectionModel = Object.freeze({
      ...projection,
      actionsById: Object.freeze(Object.fromEntries(
        Object.entries(projection.actionsById).map(([id, entry]) => [id, Object.freeze({
          ...entry,
          ...replacementOrigin,
        })]),
      )),
      voiceProvidersById: Object.freeze(Object.fromEntries(
        Object.entries(projection.voiceProvidersById).map(([id, entry]) => [id, Object.freeze({
          ...entry,
          ...replacementOrigin,
          ...(id === providerId ? { definition: declarationB } : {}),
        })]),
      )),
      reactNativeBundlesById: Object.freeze(Object.fromEntries(
        Object.entries(projection.reactNativeBundlesById).map(([id, bundle]) => [id, Object.freeze({
          ...bundle,
          ...replacementOrigin,
        })]),
      )),
    });
    const actionProjectionB = unionPluginUiProjections([{
      machineId: 'machine-2',
      serverId: 'server-2',
      projection: projectionB,
      phase: 'current',
      interactionEnabled: true,
    }], new Map([[pluginId, replacementOrigin]])).pluginUiProjection;
    if (!actionProjectionB) throw new Error('expected replacement packed external Voice app projection');
    const replacementAttempts = await reconcileAppShellProjectedClientExecutables({
      ...activationInput,
      projection: actionProjectionB,
      voice: Object.freeze({
        projection: projectionB,
        machineId: 'machine-2',
        serverId: 'server-2',
      }),
      reader: replacementReader,
      accountLifetime: replacementLifetime,
    });
    expect(replacementAttempts).toMatchObject([{
      result: { ok: true },
      reused: false,
      activation: {
        pluginId,
        contributes: { voiceProviders: expect.any(Array) },
      },
    }]);
    expect(loads).toBe(2);
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, selected)).toEqual({
      allowsGlobalStart: true, controlSessionScope: 'global', requiresVoiceAgentFeature: false,
      bargeInEnabled: false, cancelResponse: 'unsupported', interruptionPolicy: 'disabled',
      agentRuntime: {
        pluginId,
        localId: 'voice-agent',
      },
    });

    const replacementHostLease = createBundledConversationRuntimeHostLease();
    onTestFinished(() => replacementHostLease.revoke());
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    const reactivatedAttempts = await reconcileAppShellProjectedClientExecutables(activationInput);
    expect(reactivatedAttempts).toMatchObject([{
      result: { ok: true },
      reused: false,
      activation: {
        pluginId,
        contributes: { voiceProviders: expect.any(Array) },
      },
    }]);
    expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();

    await unloadAppShellProjectedClientExecutables(host);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
  });

  it('uses one generic Artifact lease while preserving Voice runtime identities in one shared activation', async () => {
    const rawRequest = Object.freeze({
      kind: 'httpHeaders' as const,
      origin: 'https://voice.example.test',
      headerNames: Object.freeze(['authorization']),
    });
    const declarations = PluginContributesV2Schema.parse({ voiceProviders: [
      {
        id: 'conversation-a', title: 'Synthetic A', kind: 'conversation',
        roles: ['realtime_conversation'], platforms: ['web'],
        capabilities: { turn: { cancelResponse: true, bargeIn: true } },
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.browser', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret', secretKinds: ['apiKey'],
            rawGrants: [{ realm: 'web', phase: 'settings', request: rawRequest }],
          }],
        },
        client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
      },
      {
        id: 'conversation-b', title: 'Synthetic B', kind: 'conversation',
        roles: ['realtime_conversation'], platforms: ['web'],
        capabilities: { turn: { cancelResponse: true, bargeIn: true } },
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.browser', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret', secretKinds: ['apiKey'],
            rawGrants: [{ realm: 'web', phase: 'settings', request: rawRequest }],
          }],
        },
        client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
      },
    ] }).voiceProviders.map(requireConversationDeclaration);
    const source = 'export function activate() {}';
    const bytes = new TextEncoder().encode(source);
    const entryPath = 'react-native/voice-runtime-web/index.js';
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const artifactGraph = {
      contributionId: 'voice-runtime-web', tier: 'reactNative' as const, platform: 'web' as const,
      entry: entryPath,
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }], digest,
      builtWith: { bundler: 'vite' as const, version: '7.0.0' },
      hostUiApiVersion: '1.0.0', compat: { react: '19.0.0', reactNative: '0.83.4' },
    };
    const pluginId = 'acme.shared-voice';
    const generation = 13;
    const origin = Object.freeze({
      serverIdentityId: 'srv_account_one',
      materializationRef: Object.freeze({
        machineId: 'machine-1',
        materializationId: 'shared-voice-install-one',
        pluginId,
      }),
    });
    const action: PluginUiProjectionModel['actionsById'][string] = {
      id: 'open-voice-settings',
      pluginId,
      title: 'Open voice settings',
      scopes: ['session'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      priority: 0,
      dangerLevel: 'safe',
      available: true,
      execution: {
        target: 'client',
        client: {
          artifactId: 'voice-runtime-web',
          modulePath: './voiceRuntime',
          exportName: 'activate',
        },
        platforms: ['web'],
      },
      ...origin,
    };
    const identities = Object.fromEntries(declarations.map((declaration) => [declaration.id, Object.freeze({
      pluginId, contributionId: declaration.id, artifactDigest: digest,
      hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
      platform: 'web' as const, channel: 'internal', nativeCapabilitiesDigest: `sha256:${'d'.repeat(64)}`,
      projectionGeneration: generation,
    })]));
    const actionIdentity = Object.freeze({
      pluginId,
      contributionId: action.id,
      artifactDigest: digest,
      hostAppVersion: '2.0.0',
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.0.0',
      reactNativeVersion: '0.83.4',
      platform: 'web' as const,
      channel: 'internal',
      nativeCapabilitiesDigest: `sha256:${'d'.repeat(64)}`,
      projectionGeneration: generation,
    });
    const machineProjection: PluginUiProjectionModel = Object.freeze({
      ...EMPTY_PLUGIN_UI_PROJECTION,
      generation,
      actionsById: Object.freeze({
        [`${pluginId}/open-voice-settings`]: Object.freeze(action),
      }),
      voiceProvidersById: Object.freeze(Object.fromEntries(declarations.map((declaration) => {
        const providerId = `${pluginId}/${declaration.id}`;
        return [providerId, Object.freeze({
          id: providerId, pluginId, generation, contributionKey: providerId, definition: declaration,
          ...origin,
        })];
      }))),
      reactNativeBundlesById: Object.freeze({
        [`reactNativeBundle:${pluginId}:${action.id}`]: Object.freeze({
          id: `reactNativeBundle:${pluginId}:${action.id}`,
          pluginId,
          contributionKind: 'reactNativeBundle',
          contributionId: action.id,
          generatedOwnerKind: 'clientContribution',
          ...origin,
          artifactGraph,
          runtime: {
            decision: { state: 'load' },
            loadPolicy: { source: 'installedArtifact' },
            cacheIdentity: actionIdentity,
          },
        }),
        ...Object.fromEntries(declarations.map((declaration) => {
          const identity = identities[declaration.id]!;
          const id = `reactNativeBundle:${pluginId}:${declaration.id}`;
          return [id, Object.freeze({
            id, pluginId, contributionKind: 'reactNativeBundle', contributionId: declaration.id,
            generatedOwnerKind: 'voiceProvider',
            ...origin,
            artifactGraph,
            runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: identity },
          })];
        })),
      }),
    });
    const projection = unionPluginUiProjections([{
      machineId: 'machine-1',
      serverId: 'server-1',
      projection: machineProjection,
      phase: 'current',
      interactionEnabled: true,
    }], new Map([[pluginId, origin]])).pluginUiProjection;
    if (!projection) throw new Error('expected selected app projection');
    const { reader, lifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity: identities[declarations[0]!.id]!,
      artifactGraph,
      origin,
    });
    let loads = 0;
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'reactNativeWebModule', available: true,
      async loadInstalledBundle() {
        loads += 1;
        return (api: PluginClientApi) => {
          api.actions.register('open-voice-settings', async () => null);
          for (const localId of ['conversation-a', 'conversation-b'] as const) {
            api.voiceProviders.register(localId, {
              ...createProviderLeaf(),
              settingsOperations: {
                async listCatalog(input) {
                  await input.credentials.raw?.materialize(rawRequest);
                  return [];
                },
              },
            });
          }
        };
      },
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const host = createPluginUiExecutableModuleHost();
    const fetches: string[] = [];
    rawCredentialMachineRpc.mockImplementation(async (input: Readonly<{ payload: unknown }>) => {
      const payload = input.payload as Readonly<{ cacheIdentity: { contributionId: string } }>;
      return {
        ok: true,
        materialization: {
          kind: 'httpHeaders',
          headers: { authorization: `Bearer ${payload.cacheIdentity.contributionId}` },
        },
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      };
    });
    onTestFinished(async () => {
      await unloadAppShellProjectedClientExecutables(host);
      hostLease.revoke();
    });

    reactNativeArtifactDaemonTransport.fetch.mockImplementation(async (input) => {
      const artifactOwner = input.artifactOwnerKind === 'clientContribution'
        ? {
          artifactOwnerKind: 'clientContribution' as const,
          clientContribution: input.clientContribution,
        }
        : {
          artifactOwnerKind: 'voiceProvider' as const,
        };
      const { identity } = input;
      fetches.push(identity.contributionId);
      return {
        ok: true, artifactFamily: 'reactNative', ...artifactOwner, cacheIdentity: identity,
        artifact: { pluginId, contributionId: identity.contributionId, artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
        bytesBase64: encodeBase64(bytes),
        files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
      };
    });
    const attempts = await reconcileAppShellProjectedClientExecutables({
      projection,
      platform: 'web',
      voice: Object.freeze({
        projection,
        machineId: 'machine-1',
        serverId: 'server-1',
      }),
      executableHost: host,
      loaderBackend: backend,
      reader,
      accountLifetime: lifetime,
    });

    expect(Object.values(identities).map((identity) => DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(identity)))
      .toEqual([expect.objectContaining({ success: true }), expect.objectContaining({ success: true })]);
    // The generic target owns one lease/load anchor. Voice retains its own
    // runtime identities only for credential and recipient contracts.
    expect(fetches).toEqual(['open-voice-settings']);
    expect(loads).toBe(1);
    expect(attempts).toMatchObject([{
      result: { ok: true },
      reused: false,
      activation: {
        pluginId,
        contributes: {
          voiceProviders: [{ id: 'conversation-a' }, { id: 'conversation-b' }],
          actions: [{ id: 'open-voice-settings' }],
        },
      },
    }]);
    expect(getVoiceAdapterRegistry().get(`${pluginId}/conversation-a`)).not.toBeNull();
    expect(getVoiceAdapterRegistry().get(`${pluginId}/conversation-b`)).not.toBeNull();
    expect(getPluginUiClientExecutableComposition(host).read({
      family: 'actions',
      pluginId,
      localId: 'open-voice-settings',
      target: {
        artifactId: 'voice-runtime-web',
        modulePath: './voiceRuntime',
        exportName: 'activate',
        platform: 'web',
      },
      executionOrigin: origin,
      projectionGeneration: generation,
    })).toMatchObject({
      registration: { family: 'actions', localId: 'open-voice-settings' },
    });
    for (const localId of ['conversation-a', 'conversation-b'] as const) {
      const registration = listExternalVoiceProviderRegistrations().find((entry) => (
        entry.providerId === `${pluginId}/${localId}`
      ));
      await expect(registration?.settingsOperations?.listCatalog?.({
        catalog: 'models',
        providerConfig: {},
        signal: new AbortController().signal,
      })).resolves.toEqual([]);
    }
    expect(rawCredentialMachineRpc.mock.calls.map(([call]) => ({
      contributionId: call.payload.cacheIdentity.contributionId,
      platform: call.payload.cacheIdentity.platform,
      phase: call.payload.phase,
    }))).toEqual([
      { contributionId: 'conversation-a', platform: 'web', phase: 'settings' },
      { contributionId: 'conversation-b', platform: 'web', phase: 'settings' },
    ]);
  });
});
