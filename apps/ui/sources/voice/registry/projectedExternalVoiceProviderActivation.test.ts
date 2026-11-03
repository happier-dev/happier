import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';

const network = await installSessionOpsNetworkBoundary();
import { readFile } from 'node:fs/promises';

import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  createRecipientContractDigestV1,
  createVoiceProviderRecipientContractFromCredentialsV1,
  DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  PluginContributesV2Schema,
  PluginManifestV2Schema,
  PluginProjectionV2Schema,
  type PluginMachineExecutionOriginV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { BundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import {
  PluginUiArtifactsManifestV2Schema,
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
  type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

const { createPluginUiExecutableModuleHost } = await import("@/components/plugins/reactNative/executableModuleHost");
const { getPluginUiClientExecutableComposition } = await import("@/components/plugins/reactNative/clientExecutableContributions");
const { reconcileAppShellProjectedClientExecutables, unloadAppShellProjectedClientExecutables } = await import("@/components/appShell/plugins/appShellClientExecutableActivation");
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
const { createPluginUiCommonJsLoaderBackend } = await import("@/components/plugins/reactNative/commonJsLoaderBackend");
const { encodeBase64 } = await import("@/encryption/base64");
const { createPluginAccountAvailabilityReader } = await import("@/sync/domains/plugins/availability/reader");
import type { PluginArtifactDaemonByteFetcher } from '@/sync/domains/plugins/availability/artifactDaemonSource';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
const { voiceSettingsParse } = await import("@/sync/domains/settings/voiceSettings");
const { storage } = await import("@/sync/domains/state/storage");
const { createMachineFixture } = await import("@/dev/testkit/fixtures/machineFixtures");
const { createPlainArtifactHomeFixture } = await import("@/dev/testkit/harness/artifactStoreBoundary");
const { createConnectedPurposeCatalogHttpBoundary } = await import("@/dev/testkit/harness/connectedAccountCatalogBoundary");
const { answerVoiceRealtimePreparationHttpRequest } = await import("@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary");
const { EMPTY_PLUGIN_UI_PROJECTION, normalizePluginUiProjection, resolvePluginUiProjectionPlatform } = await import("@/sync/domains/plugins/ui/projection");
import type { PluginUiProjectionModel } from "@/sync/domains/plugins/ui/projection";
const { unionPluginUiProjections } = await import("@/sync/domains/plugins/ui/projectionUnion");
const { getVoiceAdapterRegistry, resolveVoiceAdapterSurfaceCapabilities } = await import("@/voice/session/voiceAdapterRegistry");
const { listLocalSttProviderSpecs } = await import("@/voice/settings/panels/localStt/providers/registry");
const { listLocalTtsProviderSpecs } = await import("@/voice/settings/panels/localTts/providers/registry");
const { readBundledSpeechSettingsDescriptorFromEntry } = await import("@/voice/settings/panels/bundledSpeech/descriptor");
const { createBundledSpeechRuntime } = await import("@/voice/runtime/bundledSpeech/bundledSpeechRuntime");
const { projectVoiceProviderAgentRealtimePassiveSetup } = await import("@/voice/settings/passiveSetup");

const { createBundledConversationRuntimeHostLease } = await import("./bundledConversationRuntimeHost");
const { createDefaultVoiceProviderRegistry } = await import("./defaultRegistry");
const { listExternalVoiceProviderRegistrations, getExternalVoiceProviderRegistrationsRevision, subscribeExternalVoiceProviderRegistrations } = await import("./externalVoiceProviderRegistrations");
import type {
  ExternalVoiceProviderRuntimeRegistration,
  VoiceConversationProviderContribution,
} from './externalVoiceProviderActivation';
const { withdrawProjectedExternalVoiceProviders } = await import("./projectedExternalVoiceProviderActivation");
const { projectVoiceProviderSelectionRows, selectVoiceProviderOption } = await import("./providerSelection");
const { resolveVoiceRoleReadiness } = await import("./readiness");
const { projectVoiceSpeechEndpointReadiness } = await import("./speechEndpointReadiness");

type BundledSpeechClient = NonNullable<Parameters<typeof createBundledSpeechRuntime>[0]['client']>;

const rawCredentialMachineRpc = vi.fn();
const reactNativeArtifactDaemonTransport = { fetch: vi.fn<PluginArtifactDaemonByteFetcher>() };
const { DaemonPluginUiArtifactBytesReadRequestSchema } = await import('@happier-dev/protocol');
const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
beforeEach(async () => {
  network.resetRequests();
  await network.addHome('https://projected-voice.example.test', 'artifact-account');
  network.setRpcResponder(async request => {
    if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ) {
      const payload = DaemonPluginUiArtifactBytesReadRequestSchema.parse(request.payload);
      return await reactNativeArtifactDaemonTransport.fetch({ transport: { machineId: request.targetId, serverId: account.home.id }, family: payload.artifactFamily, digest: payload.cacheIdentity.artifactDigest });
    }
    return await rawCredentialMachineRpc(request);
  });
  const purposes = createConnectedPurposeCatalogHttpBoundary();
  account = await createPlainArtifactHomeFixture('https://projected-voice.example.test', {
    handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init) ?? await purposes.handle(new URL(path, 'https://projected-voice.example.test'), init)
      ?? answerVoiceRealtimePreparationHttpRequest(new URL(path, 'https://projected-voice.example.test'), storage.getState().settings),
  });
  await purposes.hydrate({ serverId: account.home.id, accountId: 'artifact-account' });
  const machine = createMachineFixture({ activeAt: Date.now() });
  storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.home.id]: [machine] } });
});
afterEach(async () => {
  await account?.dispose();
  rawCredentialMachineRpc.mockReset();
  reactNativeArtifactDaemonTransport.fetch.mockReset();
});

afterAll(() => network.dispose());

const voiceArtifactScope = Object.freeze({ get serverId() { return account.home.id; }, accountId: 'artifact-account' });

function isVoiceReactNativeArtifactGraph<T extends Readonly<{ tier?: string }>>(
  artifactGraph: T,
): artifactGraph is T & Readonly<{ tier: 'reactNative' }> {
  return artifactGraph.tier === 'reactNative';
}

function createCurrentVoiceArtifactAdmission(input: Readonly<{
  pluginId: string;
  identity: PluginReactNativeBundleCacheIdentity;
  artifactGraph: {
    artifactId: string;
    tier: 'reactNative';
    digest: PluginUiArtifactDigestV1;
    hostUiApiRange: string;
  };
  origin: Readonly<{
    serverIdentityId: string;
    materializationRef: { machineId: string; materializationId: string; pluginId: string };
  }>;
  scope?: Readonly<{ serverId: string; accountId: string }>;
}>) {
  const scope = input.scope ?? voiceArtifactScope;
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
      contributionId: input.identity.contributionId,
      artifactId: input.artifactGraph.artifactId,
      tier: input.artifactGraph.tier,
      platform: input.identity.platform,
      artifactDigest: input.artifactGraph.digest,
      hostUiApiRange: input.artifactGraph.hostUiApiRange,
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
    sourceClass: 'versionedArchive' as const,
    portableRelease: true,
    archiveDigestSha256: release.archiveDigestSha256,
    uiArtifacts: release.uiSlots,
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
          packageAssets: [],
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
            contributionId: input.identity.contributionId,
            artifactId: input.artifactGraph.artifactId,
            tier: input.artifactGraph.tier,
            platform: input.identity.platform,
            accountArtifactId: '00000000-0000-4000-8000-000000000001',
            artifactDigest: input.artifactGraph.digest,
            hostUiApiRange: input.artifactGraph.hostUiApiRange,
          }],
        },
      }],
      materializations: [materialization],
      snapshots: [{
        serverIdentityId: materialization.serverIdentityId,
        machineId: materialization.machineId,
        materializations: [materialization],
      }],
    },
  });
  const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
  });
  expect(reader.classifyRelease(materialization)).toMatchObject({
    releaseContent: 'matched',
    validation: { kind: 'admitted' },
  });
  expect(reader.readMaterializations()).toMatchObject({
    kind: 'available',
    materializations: [materialization],
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

function projectConversationVoiceEntries(input: Readonly<{
  pluginId: string;
  generation: number;
  declarations: readonly VoiceConversationProviderContribution[];
  executionOrigin: PluginMachineExecutionOriginV1;
}>): PluginUiProjectionModel['voiceProvidersById'] {
  const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({
    v: 2, generation: input.generation,
    installedPackagesById: {}, agentsById: {}, actionsById: {},
     resourcesById: {}, settingsById: {}, diagnostics: [],
    familiesById: { voiceProviders: { family: 'voiceProviders', entriesById: Object.fromEntries(
      input.declarations.map(definition => {
        const id = `${input.pluginId}/${definition.id}`;
        return [id, { id, pluginId: input.pluginId,
          occurrenceId: `${input.pluginId}-occurrence-${input.generation}`,
          generation: input.generation, contributionKey: id, definition }];
      }),
    ) } },
  }));
  // Execution authority belongs to the UI projection after strict wire parsing.
  return Object.freeze(Object.fromEntries(Object.entries(projection.voiceProvidersById).map(([id, entry]) => [
    id, Object.freeze({ ...entry, executionOrigin: input.executionOrigin }),
  ])));
}

describe('projected external Voice provider activation', () => {
  it.each(['equal', 'changed', 'removed', 'occurrence'] as const)(
    'publishes one coherent speech snapshot only for changed Voice facts: %s', async (change) => {
      const pluginId = 'acme.speech-publication';
      const executableHost = createPluginUiExecutableModuleHost();
      onTestFinished(() => unloadAppShellProjectedClientExecutables(executableHost));
      const fixture = PluginManifestV2Schema.parse(JSON.parse(await readFile(new URL(
        '../../../../cli/src/plugins/testkit/fixtures/packed-external-voice-provider/.happier-plugin/plugin.json',
        import.meta.url,
      ), 'utf8'))).contributes.voiceProviders.find(entry => entry.kind === 'speech');
      if (!fixture) throw new Error('expected speech fixture');
      const declarations = ['first', 'sibling'].map(id => ({ ...fixture, id, title: id }));
      const project = (generation: number) => normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation, installedPackagesById: {}, agentsById: {}, actionsById: {},
        resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: { voiceProviders: { family: 'voiceProviders', entriesById: Object.fromEntries(
          declarations.filter(definition => change !== 'removed' || generation === 1 || definition.id !== 'first')
            .map(definition => {
              const id = `${pluginId}/${definition.id}`;
              return [id, { id, pluginId, generation, contributionKey: id,
                occurrenceId: change === 'occurrence' && generation === 2 && definition.id === 'first'
                  ? 'replacement-occurrence' : 'original-occurrence',
                definition: change === 'changed' && generation === 2 && definition.id === 'first'
                  ? { ...definition, title: 'Changed speech' } : definition }];
            }),
        ) } },
      }));
      const reconcile = (projection: PluginUiProjectionModel | null) => reconcileAppShellProjectedClientExecutables({
        projection: null, voice: null, voiceProviderProjection: projection, platform: 'web', executableHost,
      });
      await reconcile(project(1));
      const registry = createDefaultVoiceProviderRegistry();
      const firstId = `${pluginId}/first`;
      const siblingId = `${pluginId}/sibling`;
      const before = listExternalVoiceProviderRegistrations().filter(entry => entry.pluginId === pluginId);
      const first = before.find(entry => entry.providerId === firstId)!;
      const sibling = before.find(entry => entry.providerId === siblingId)!;
      const snapshots: Array<Readonly<{ first: typeof first | null; sibling: typeof sibling | null;
        visibleFirst: ReturnType<typeof registry.get>; visibleSibling: ReturnType<typeof registry.get> }>> = [];
      const revision = getExternalVoiceProviderRegistrationsRevision();
      const stop = subscribeExternalVoiceProviderRegistrations(() => {
        const registrations = listExternalVoiceProviderRegistrations();
        snapshots.push({ first: registrations.find(entry => entry.providerId === firstId) ?? null,
          sibling: registrations.find(entry => entry.providerId === siblingId) ?? null,
          visibleFirst: registry.get(firstId), visibleSibling: registry.get(siblingId) });
      });
      onTestFinished(stop);
      await reconcile(project(2)); // Fresh wire objects and unrelated generation; exact occurrences stay stable.
      expect({ notifications: snapshots.length, revisionDelta: getExternalVoiceProviderRegistrationsRevision() - revision })
        .toEqual({ notifications: change === 'equal' ? 0 : 1, revisionDelta: change === 'equal' ? 0 : 1 });
      const after = listExternalVoiceProviderRegistrations().filter(entry => entry.pluginId === pluginId);
      expect(after.find(entry => entry.providerId === siblingId)).toBe(sibling);
      if (change === 'equal') expect(after.find(entry => entry.providerId === firstId)).toBe(first);
      else if (change === 'removed') expect(snapshots[0]?.first).toBeNull();
      else {
        expect(snapshots[0]?.first).not.toBe(first);
        expect(snapshots[0]?.first?.descriptor).not.toBe(first.descriptor);
        expect(registry.get(firstId)).toBe(snapshots[0]?.first?.descriptor);
      }
      expect(snapshots.every(snapshot => snapshot.sibling === sibling)).toBe(true);
      expect(snapshots.every(snapshot => snapshot.visibleSibling === sibling.descriptor)).toBe(true);
      if (change !== 'removed') expect(snapshots.every(snapshot => snapshot.first !== null
        && snapshot.visibleFirst === snapshot.first.descriptor)).toBe(true);
      stop();
      await reconcile(null);
      expect(registry.get(firstId)).toBeNull();
      expect(registry.get(siblingId)).toBeNull();
    },
  );

  it('keeps complete-set reconciliation at the AppShell boundary', async () => {
    expect(reconcileAppShellProjectedClientExecutables).toBeTypeOf('function');

    const activationModule = await import('./projectedExternalVoiceProviderActivation');
    expect(activationModule).not.toHaveProperty('activateProjectedExternalVoiceProviders');
  });

  it('projects a current installed external speech declaration into the Voice registry and withdraws it with generation authority', async () => {
    rawCredentialMachineRpc.mockReset();
    const pluginId = 'acme.external-speech';
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
          {
            id: 'format',
            title: 'Output format',
            schema: { type: 'string', enum: ['wav'] },
            default: 'wav',
            presentation: { control: 'select', options: [{ value: 'wav', title: 'WAV' }] },
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
          operationProjections: [{
            kind: 'recipientCredential',
            operation: 'speech-auth',
            phase: 'speech',
            format: 'bearer',
          }],
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
        hostMediated: { operations: [{
          id: 'speech-auth',
          purpose: 'voice.speech',
          credentialSlotId: 'api_key',
          effect: 'read',
          request: {
            origin: 'https://speech.example.test',
            pathTemplate: '/session',
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
          response: { maxBytes: 65536, contentTypes: ['application/json'] },
        }] },
      },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');

    const contributionId = `${pluginId}/${declaration.id}`;
    if (!declaration.credentials?.hostMediated) throw new Error('expected mediated speech declaration');
    const recipientContract = createVoiceProviderRecipientContractFromCredentialsV1({
      package: { pluginId, source: { kind: 'package', locator: pluginId } },
      publisher: { trust: 'verified', identity: `package:${pluginId}` },
      contribution: { pluginId, localId: declaration.id },
      credentials: {
        slot: declaration.credentials.slot,
        hostMediated: declaration.credentials.hostMediated,
      },
      presentation: { title: declaration.title },
    });
    const rawProjection = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 31,
      installedPackagesById: {},
      agentsById: {},
      actionsById: {},


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
              occurrenceId: `${pluginId}-occurrence-31`,
              contributionKey: contributionId,
              definition: declaration,
              recipientContract,
              recipientContractDigest: createRecipientContractDigestV1(recipientContract),
            },
          },
        },
      },
      diagnostics: [],
    });
    const projection = normalizePluginUiProjection(rawProjection);
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
    // A projected engine is named by its own title; its raw plugin id is never shown as its description.
    expect(installedEntry?.presentation?.createSettingsSpec?.()).toMatchObject({
      titleKey: 'Never-before-seen Speech',
      subtitleKey: '',
      detailKey: 'Never-before-seen Speech',
    });
    expect(installedEntry?.accountCredentialSlot).toEqual({
      id: 'api_key',
      scope: 'account',
      kind: 'apiKey',
      recipientContract,
      recipientContractDigest: createRecipientContractDigestV1(recipientContract),
    });
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
        format: 'wav',
      },
      settingsRevision: '7',
      signal: actionSignal,
    })).resolves.toEqual({ patch: { voiceName: 'synthetic-voice-v2' } });
    expect(rawCredentialMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      serverUrl: account.home.serverUrl,
      method: 'daemon.voice.speech.settingsAction.execute',
      payload: {
        target: { pluginId, localId: declaration.id },
        actionId: 'refresh-voice',
        expectedSettingsVersion: 7,
      },
    }));
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
              format: 'wav',
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
              format: 'wav',
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

    const removedProjection = normalizePluginUiProjection({
      ...rawProjection,
      generation: 32,
      familiesById: {},
    }, resolvePluginUiProjectionPlatform(), projection);
    const removedAttempts = await reconcileAppShellProjectedClientExecutables({
      projection: null,
      platform: 'web',
      voice: Object.freeze({
        providerIds: new Set(Object.keys(removedProjection.voiceProvidersById)),
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
          { key: 'format', kind: 'enum' },
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
      return [id, {
        id,
        pluginId: manifest.id,
        generation,
        occurrenceId: `${manifest.id}-occurrence-${generation}`,
        contributionKey: id,
        definition: declaration,
      }];
    }));
    const projection = normalizePluginUiProjection({
      v: 2,
      generation,
      installedPackagesById: {},
      agentsById: {},
      actionsById: {},


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
        providerIds: new Set(Object.keys(projection.voiceProvidersById)),
        projection,
        machineId: 'machine-1',
        serverId: null,
      }),
      executableHost: host,
    })).resolves.toEqual([]);

    const registry = createDefaultVoiceProviderRegistry();
    const transcribe = vi.fn<BundledSpeechDaemonClient['transcribe']>(async () => 'packed transcript');
    const synthesize = vi.fn<BundledSpeechDaemonClient['synthesize']>(async () => ({
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
    })).resolves.toBe('packed transcript');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: `${manifest.id}/speech-stt` }),
    }));
    expect(transcribe.mock.calls[0]?.[0]).not.toHaveProperty('model');

    await expect(speechRuntime.speak(`${manifest.id}/speech-tts`, {
      text: 'packed speech',
      providerConfig: { voice: 'packed-voice-primary', format: 'wav' },
      registerPlaybackStopper: () => () => {},
    })).resolves.toBeUndefined();
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: `${manifest.id}/speech-tts` }),
    }));
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('voiceName');
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('format');
    expect(play).toHaveBeenCalledOnce();
  });

  it('prepares a normalized web Voice target through the strict executable-platform seam', async () => {
    const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({ voiceProviders: [{
      id: 'conversation', title: 'Desktop-web Voice', kind: 'conversation',
      roles: ['realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: true, bargeIn: false } },
      client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
    }] }).voiceProviders[0]!);
    const pluginId = 'acme.desktop-web-voice';
    const generation = 23;
    const entryPath = 'react-native/voice-runtime-web/entry.cjs.bundle';
    const bytes = new TextEncoder().encode('// desktop web voice bundle');
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const artifactGraph = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
      artifactId: declaration.client.artifactId,
      tier: 'reactNative', entry: entryPath,
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }], digest,
      builtWith: { bundler: 'esbuild', version: '0.27.2' },
      executable: { exports: ['activate'] },
      hostUiApiRange: '^1.0.0',
    }] }).entries[0]!;
    if (!isVoiceReactNativeArtifactGraph(artifactGraph)) {
      throw new Error('expected web React Native Artifact graph');
    }
    const identity = Object.freeze({
      pluginId, contributionId: declaration.id, artifactId: artifactGraph.artifactId,
      artifactDigest: digest, platform: 'web' as const,
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
      voiceProvidersById: projectConversationVoiceEntries({ pluginId, generation, declarations: [declaration], executionOrigin: origin }),
      reactNativeBundlesById: Object.freeze({
        [`reactNativeBundle:${pluginId}:${declaration.id}`]: Object.freeze({
          id: `reactNativeBundle:${pluginId}:${declaration.id}`,
          pluginId,
          occurrenceId: `${pluginId}-occurrence-${generation}`,
          contributionKind: 'reactNativeBundle' as const,
          contributionId: declaration.id,
          generatedOwnerKind: 'voiceProvider',
          executionOrigin: origin,
          artifactGraph,
          runtime: Object.freeze({
            decision: Object.freeze({ state: 'load' }),
            loadPolicy: Object.freeze({ source: 'installedArtifact' }),
            cacheIdentity: { artifactDigest: identity.artifactDigest },
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
    const admission = reader.readCurrentArtifact({
      pluginId,
      contributionId: declaration.id,
      tier: 'reactNative',
      platform: 'web',
    });
    expect(admission).toMatchObject({ kind: 'available' });
    const executableHost = createPluginUiExecutableModuleHost();
    const fetchArtifactBytes = vi.fn(async () => ({
      ok: true as const,
      artifactFamily: 'reactNative' as const,
      cacheIdentity: { artifactDigest: identity.artifactDigest },
      artifact: {
        artifactKind: 'reactNativeBundle' as const,
        digest,
        format: 'plainJs' as const,
        byteSize: bytes.byteLength,
      },
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
    }));
    reactNativeArtifactDaemonTransport.fetch.mockImplementation(fetchArtifactBytes);
    const hostLease = createBundledConversationRuntimeHostLease();
    const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'commonJs',
      available: true,
      loadInstalledBundle: vi.fn(async () => (api: PluginClientApi) => {
        api.voiceProviders.register(declaration.id, createProviderLeaf());
      }),
    });
    const attempts = await reconcileAppShellProjectedClientExecutables({
      projection: null,
      platform: 'web',
      voice: Object.freeze({
        providerIds: new Set(Object.keys(projection.voiceProvidersById)),
        projection,
        machineId: 'machine-1',
        serverId: account.home.id,
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

    expect(fetchArtifactBytes).toHaveBeenCalledWith(expect.objectContaining({ family: 'reactNative', digest }));
    expect(attempts[0]?.result).toEqual({ ok: true });
    expect(attempts).toMatchObject([{
      result: { ok: true },
      activation: { target: { platform: 'web' } },
    }]);
  });

  it.each(['ios', 'android'] as const)('loads the generated universal artifact on %s through public activate(api) and unloads it', async (platform) => {
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
      client: { artifactId: 'voice-runtime-native', exportName: 'activate' },
    }] }).voiceProviders[0]!);
    const entryPath = 'react-native/voice-runtime-native/entry.cjs.bundle';
    const bytes = new TextEncoder().encode('// universal CommonJS bundle');
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const parsedArtifactGraph = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
      artifactId: declaration.client.artifactId,
      tier: 'reactNative', entry: entryPath,
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }], digest,
      builtWith: { bundler: 'esbuild', version: '0.27.2' },
      executable: { exports: ['activate'] },
      hostUiApiRange: '^1.0.0',
    }] }).entries[0]!;
    if (!isVoiceReactNativeArtifactGraph(parsedArtifactGraph)) {
      throw new Error('expected generated React Native Artifact graph');
    }
    const artifactGraph = parsedArtifactGraph;
    const pluginId = `acme.synthetic-${platform}`;
    const providerId = `${pluginId}/conversation`;
    const generation = platform === 'ios' ? 21 : 22;
    const identity = Object.freeze({
      pluginId, contributionId: declaration.id, artifactId: artifactGraph.artifactId,
      artifactDigest: digest, platform,
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
      voiceProvidersById: projectConversationVoiceEntries({ pluginId, generation, declarations: [declaration], executionOrigin: origin }),
      reactNativeBundlesById: Object.freeze({
        [`reactNativeBundle:${pluginId}:${declaration.id}`]: Object.freeze({
          id: `reactNativeBundle:${pluginId}:${declaration.id}`,
          pluginId,
          occurrenceId: `${pluginId}-occurrence-${generation}`,
          contributionKind: 'reactNativeBundle',
          contributionId: declaration.id,
          generatedOwnerKind: 'voiceProvider',
          executionOrigin: origin,
          artifactGraph,
          runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest: identity.artifactDigest } },
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
      backendId: 'commonJs', available: true,
      loadInstalledBundle: vi.fn(async () => activate),
    });
    onTestFinished(async () => {
      await unloadAppShellProjectedClientExecutables(executableHost);
      hostLease.revoke();
    });

    const fetchArtifactBytes = vi.fn(async () => ({
      ok: true as const, artifactFamily: 'reactNative' as const,
      cacheIdentity: { artifactDigest: identity.artifactDigest },
      artifact: { artifactKind: 'reactNativeBundle' as const, digest, format: 'plainJs' as const, byteSize: bytes.byteLength },
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
    }));
    reactNativeArtifactDaemonTransport.fetch.mockImplementation(fetchArtifactBytes);
    await expect(reconcileAppShellProjectedClientExecutables({
      projection,
      platform,
      voice: {
        providerIds: new Set(Object.keys(projection.voiceProvidersById)),
        projection,
        machineId: 'machine-1',
        serverId: account.home.id,
      },
      executableHost,
      loaderBackend,
    })).resolves.toEqual([]);
    expect(fetchArtifactBytes).not.toHaveBeenCalled();

    const currentActivation = {
      projection,
      platform,
      voice: Object.freeze({
        providerIds: new Set(Object.keys(projection.voiceProvidersById)),
        projection,
        machineId: 'machine-1',
        serverId: account.home.id,
      }),
      executableHost,
      loaderBackend,
      reader,
      accountLifetime: lifetime,
    };
    const attempts = await reconcileAppShellProjectedClientExecutables(currentActivation);
    // Verified content-addressed bytes may be reused from the real artifact
    // cache; public activation and teardown are the observable contract.
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
      moduleReference: { exportName: declaration.client.exportName },
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
    const manifest = PluginUiArtifactsManifestV2Schema.parse(JSON.parse(
      await readFile(new URL('ui-artifacts.json', artifactRoot), 'utf8'),
    ));
    const artifactGraphCandidate = manifest.entries.find((entry) => entry.artifactId === declaration.client.artifactId)!;
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
        pluginId, contributionId: candidate.id, artifactId: artifactGraph.artifactId,
        artifactDigest: digest, platform: 'web',
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
        occurrenceId: `${pluginId}-occurrence-12`,
        generation: 12,
        contributionKey: candidateProviderId,
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
          occurrenceId: `${pluginId}-occurrence-12`,
          contributionKind: 'reactNativeBundle' as const,
          contributionId: candidate.id,
          generatedOwnerKind: candidate.id === action.id ? 'clientContribution' : 'voiceProvider',
          executionOrigin: origin,
          artifactGraph,
        runtime: {
          decision: { state: 'load' as const },
          loadPolicy: { source: 'installedArtifact' as const },
          cacheIdentity: {
            artifactDigest: (candidate.id === action.id ? actionIdentity : candidateIdentity).artifactDigest,
          },
        },
      }] as const;
    }));
    const rawProjection = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 12,
      installedPackagesById: {}, agentsById: {}, actionsById: {
        [`${pluginId}/${action.id}`]: {
          ...action,
          pluginId,
          occurrenceId: `${pluginId}-occurrence-12`,
          executionOrigin: origin,
          available: true,
        },
      },
       resourcesById: {}, settingsById: {},
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
    });
    const normalizedProjection = normalizePluginUiProjection(rawProjection);
    const projection = Object.freeze({
      ...normalizedProjection,
      voiceProvidersById: Object.freeze(Object.fromEntries(Object.entries(normalizedProjection.voiceProvidersById).map(([id, entry]) => [
        id, Object.freeze({ ...entry, executionOrigin: origin }),
      ]))),
    });
    const actionProjection = unionPluginUiProjections([{
      machineId: 'machine-1',
      serverId: account.home.id,
      projection,
      phase: 'current',
      interactionEnabled: true,
    }], new Map([[pluginId, origin]])).pluginUiProjection;
    if (!actionProjection) throw new Error('expected packed external Voice app projection');
    const { reader, lifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity: actionIdentity,
      artifactGraph,
      origin,
    });
    const moduleBackend = createPluginUiCommonJsLoaderBackend();
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
      cacheIdentity: { artifactDigest: input.digest },
      artifact: { artifactKind: 'reactNativeBundle' as const, digest, format: 'plainJs' as const, byteSize: bytes.byteLength },
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
        providerIds: new Set(Object.keys(projection.voiceProvidersById)),
        projection,
        machineId: 'machine-1',
        serverId: account.home.id,
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
    await network.addHome('https://projected-voice-two.example.test', 'artifact-account');
    const replacementHome = await createPlainArtifactHomeFixture('https://projected-voice-two.example.test', {
      handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
    });
    onTestFinished(() => replacementHome.dispose());
    const { reader: replacementReader, lifetime: replacementLifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity: actionIdentity,
      artifactGraph,
      origin: replacementOrigin,
      scope: { serverId: replacementHome.home.id, accountId: 'artifact-account' },
    });
    const projectionB: PluginUiProjectionModel = Object.freeze({
      ...projection,
      actionsById: Object.freeze(Object.fromEntries(
        Object.entries(projection.actionsById).map(([id, entry]) => [id, Object.freeze({
          ...entry,
          executionOrigin: replacementOrigin,
        })]),
      )),
      voiceProvidersById: Object.freeze(Object.fromEntries(
        Object.entries(projection.voiceProvidersById).map(([id, entry]) => [id, Object.freeze({
          ...entry,
          executionOrigin: replacementOrigin,
          ...(id === providerId ? { definition: declarationB } : {}),
        })]),
      )),
      reactNativeBundlesById: Object.freeze(Object.fromEntries(
        Object.entries(projection.reactNativeBundlesById).map(([id, bundle]) => [id, Object.freeze({
          ...bundle,
          executionOrigin: replacementOrigin,
        })]),
      )),
    });
    const actionProjectionB = unionPluginUiProjections([{
      machineId: 'machine-2',
      serverId: replacementHome.home.id,
      projection: projectionB,
      phase: 'current',
      interactionEnabled: true,
    }], new Map([[pluginId, replacementOrigin]])).pluginUiProjection;
    if (!actionProjectionB) throw new Error('expected replacement packed external Voice app projection');
    const replacementAttempts = await reconcileAppShellProjectedClientExecutables({
      ...activationInput,
      projection: actionProjectionB,
      voice: Object.freeze({
        providerIds: new Set(Object.keys(projectionB.voiceProvidersById)),
        projection: projectionB,
        machineId: 'machine-2',
        serverId: replacementHome.home.id,
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
    const returnedHome = await createPlainArtifactHomeFixture(account.home.serverUrl, {
      handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
    });
    onTestFinished(() => returnedHome.dispose());
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
        client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
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
        client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
      },
    ] }).voiceProviders.map(requireConversationDeclaration);
    const source = 'export function activate() {}';
    const bytes = new TextEncoder().encode(source);
    const entryPath = 'react-native/voice-runtime-web/entry.cjs.bundle';
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const artifactGraph = {
      artifactId: 'voice-runtime-web', tier: 'reactNative' as const,
      entry: entryPath,
      files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }], digest,
      builtWith: { bundler: 'esbuild' as const, version: '0.27.2' },
      executable: { exports: ['activate'] },
      hostUiApiRange: '^1.0.0',
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
      occurrenceId: `${pluginId}-occurrence-${generation}`,
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
          exportName: 'activate',
        },
        platforms: ['web'],
      },
      executionOrigin: origin,
    };
    const identities = Object.fromEntries(declarations.map((declaration) => [declaration.id, Object.freeze({
      pluginId, contributionId: declaration.id, artifactId: artifactGraph.artifactId,
      artifactDigest: digest, platform: 'web' as const,
    })]));
    const actionIdentity = Object.freeze({
      pluginId, contributionId: action.id, artifactId: artifactGraph.artifactId,
      artifactDigest: digest, platform: 'web' as const,
    });
    const machineProjection: PluginUiProjectionModel = Object.freeze({
      ...EMPTY_PLUGIN_UI_PROJECTION,
      generation,
      actionsById: Object.freeze({
        [`${pluginId}/open-voice-settings`]: Object.freeze(action),
      }),
      voiceProvidersById: projectConversationVoiceEntries({ pluginId, generation, declarations, executionOrigin: origin }),
      reactNativeBundlesById: Object.freeze({
        [`reactNativeBundle:${pluginId}:${action.id}`]: Object.freeze({
          id: `reactNativeBundle:${pluginId}:${action.id}`,
          pluginId,
          occurrenceId: `${pluginId}-occurrence-${generation}`,
          contributionKind: 'reactNativeBundle',
          contributionId: action.id,
          generatedOwnerKind: 'clientContribution',
          executionOrigin: origin,
          artifactGraph,
          runtime: {
            decision: { state: 'load' },
            loadPolicy: { source: 'installedArtifact' },
            cacheIdentity: { artifactDigest: actionIdentity.artifactDigest },
          },
        }),
        ...Object.fromEntries(declarations.map((declaration) => {
          const identity = identities[declaration.id]!;
          const id = `reactNativeBundle:${pluginId}:${declaration.id}`;
          return [id, Object.freeze({
            id,
            pluginId,
            occurrenceId: `${pluginId}-occurrence-${generation}`,
            contributionKind: 'reactNativeBundle',
            contributionId: declaration.id,
            generatedOwnerKind: 'voiceProvider',
            executionOrigin: origin,
            artifactGraph,
            runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest: identity.artifactDigest } },
          })];
        })),
      }),
    });
    const projection = unionPluginUiProjections([{
      machineId: 'machine-1',
      serverId: account.home.id,
      projection: machineProjection,
      phase: 'current',
      interactionEnabled: true,
    }], new Map([[pluginId, origin]])).pluginUiProjection;
    if (!projection) throw new Error('expected selected app projection');
    const { reader, lifetime } = createCurrentVoiceArtifactAdmission({
      pluginId,
      identity: actionIdentity,
      artifactGraph,
      origin,
    });
    let loads = 0;
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'commonJs', available: true,
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
      const payload = input.payload as Readonly<{ contribution: { localId: string } }>;
      return {
        ok: true,
        materialization: {
          kind: 'httpHeaders',
          headers: { authorization: `Bearer ${payload.contribution.localId}` },
        },
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      };
    });
    onTestFinished(async () => {
      await unloadAppShellProjectedClientExecutables(host);
      hostLease.revoke();
    });

    reactNativeArtifactDaemonTransport.fetch.mockImplementation(async (input) => {
      fetches.push(input.digest);
      return {
        ok: true, artifactFamily: 'reactNative',
        cacheIdentity: { artifactDigest: input.digest },
        artifact: { artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
        files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
      };
    });
    const attempts = await reconcileAppShellProjectedClientExecutables({
      projection,
      platform: 'web',
      voice: Object.freeze({
        providerIds: new Set(Object.keys(projection.voiceProvidersById)),
        projection,
        machineId: 'machine-1',
        serverId: account.home.id,
      }),
      executableHost: host,
      loaderBackend: backend,
      reader,
      accountLifetime: lifetime,
    });

    expect(Object.values(identities).map((identity) => (
      DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse({ artifactDigest: identity.artifactDigest })
    )))
      .toEqual([expect.objectContaining({ success: true }), expect.objectContaining({ success: true })]);
    // The generic target owns one lease/load anchor. Voice retains its own
    // runtime identities only for credential and recipient contracts.
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
    expect(fetches).toEqual([digest]);
    expect(loads).toBe(1);
    expect(getVoiceAdapterRegistry().get(`${pluginId}/conversation-a`)).not.toBeNull();
    expect(getVoiceAdapterRegistry().get(`${pluginId}/conversation-b`)).not.toBeNull();
    expect(getPluginUiClientExecutableComposition(host).read({
      family: 'actions',
      pluginId,
      occurrenceId: action.occurrenceId,
      localId: 'open-voice-settings',
      target: {
        artifactId: 'voice-runtime-web',
        exportName: 'activate',
        platform: 'web',
      },
      executionOrigin: origin,
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
      contributionId: call.payload.contribution.localId,
      platform: call.payload.platform,
      phase: call.payload.phase,
    }))).toEqual([
      { contributionId: 'conversation-a', platform: 'web', phase: 'settings' },
      { contributionId: 'conversation-b', platform: 'web', phase: 'settings' },
    ]);
  });
});
