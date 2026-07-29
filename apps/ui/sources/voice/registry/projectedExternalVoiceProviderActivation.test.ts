import { readFile } from 'node:fs/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createRecipientContractDigestV1,
  createVoiceProviderRecipientContractV1,
  DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  PluginContributesV2Schema,
  PluginManifestV2Schema,
  type PluginProjectionV2,
  type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';
import {
  PluginUiArtifactsManifestV1Schema,
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { createPluginUiExecutableModuleHost } from '@/components/plugins/reactNative/executableModuleHost';
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
import { createReactNativeWebLoaderBackend } from '@/components/plugins/reactNative/webLoaderBackend.web';
import { encodeBase64 } from '@/encryption/base64';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import {
  EMPTY_PLUGIN_UI_PROJECTION,
  resolvePluginUiProjectionState,
  type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { getVoiceAdapterRegistry, resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { listExternalVoiceProviderRegistrations } from './externalVoiceProviderRegistrations';
import type {
  ExternalVoiceProviderActivationApi,
  ExternalVoiceProviderRuntimeRegistration,
  PluginVoiceConversationProviderContributionV1,
} from './externalVoiceProviderActivation';
import { activateProjectedExternalVoiceProviders } from './projectedExternalVoiceProviderActivation';
import { projectVoiceProviderSelectionRows, selectVoiceProviderOption } from './providerSelection';
import { resolveVoiceRoleReadiness } from './readiness';

function createProviderLeaf(): ExternalVoiceProviderRuntimeRegistration {
  return {
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
    encodeTextTurn: (text) => [{ type: 'text', text }], requiresMicForConnection: false,
  };
}

function requireConversationDeclaration(
  declaration: PluginVoiceProviderContributionV1,
): PluginVoiceConversationProviderContributionV1 {
  if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
  return declaration;
}

describe('projected external Voice provider activation', () => {
  // AMENDMENT_REQUIRED: this expectation deliberately remains RED until the
  // public speech declaration can project its engine identities, settings, and
  // daemon target contract without borrowing bundled first-party internals.
  it('projects a current installed external speech declaration into the Voice registry and withdraws it with generation authority', async () => {
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: 'speech',
      title: 'Never-before-seen Speech',
      kind: 'speech',
      roles: ['conversation_stt', 'conversation_tts'],
      platforms: ['web'],
      capabilities: { readiness: { requirements: ['credential'] } },
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
      await executableHost.unload();
    });

    expect(projection.voiceProvidersById[contributionId]?.definition).toMatchObject({
      kind: 'speech',
      roles: ['conversation_stt', 'conversation_tts'],
    });

    await activateProjectedExternalVoiceProviders({
      projection,
      machineId: 'machine-1',
      hostPlatform: 'web',
      executableHost,
      cache: createPluginReactNativeBundleCache(),
    });

    const installedRegistrations = listExternalVoiceProviderRegistrations()
      .filter((registration) => registration.pluginId === pluginId && registration.localId === declaration.id);
    const installedEntry = installedRegistrations
      .map((registration) => registration.descriptor)
      .find((entry) => entry?.kind === 'voice.speech-engine.v1') ?? null;
    const installedRegistry = createDefaultVoiceProviderRegistry();
    const readiness = installedEntry
      ? resolveVoiceRoleReadiness({
          registry: installedRegistry,
          role: 'conversation_stt',
          providerId: installedEntry.providerId,
          platform: 'web',
          facts: {
            settings: 'ready',
            credential: 'missing',
          },
        })
      : null;

    const removedProjection = resolvePluginUiProjectionState(projection, {
      ...rawProjection,
      generation: 32,
      familiesById: {},
    });
    await activateProjectedExternalVoiceProviders({
      projection: removedProjection,
      machineId: 'machine-1',
      hostPlatform: 'web',
      executableHost,
      cache: createPluginReactNativeBundleCache(),
    });
    const registrationsAfterRemoval = listExternalVoiceProviderRegistrations()
      .filter((registration) => registration.pluginId === pluginId && registration.localId === declaration.id);

    expect({
      installed: installedEntry,
      readiness,
      registrationsAfterRemoval,
    }).toMatchObject({
      installed: {
        kind: 'voice.speech-engine.v1',
        roles: ['conversation_stt', 'conversation_tts'],
        requirements: ['credential'],
        supportedPlatforms: ['web'],
        source: {
          kind: 'external',
          pluginId,
          localId: declaration.id,
        },
      },
      readiness: {
        status: 'needs_setup',
        code: 'credential_missing',
        recoveryAction: 'configure_credential',
      },
      registrationsAfterRemoval: [],
    });
  });

  it.each(['ios', 'android'] as const)('loads a generated %s Re.Pack artifact through public activate(api) and unloads it', async (platform) => {
    const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({ voiceProviders: [{
      id: 'conversation', title: `Synthetic ${platform}`, kind: 'conversation',
      roles: ['realtime_conversation'], platforms: [platform],
      capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: false } },
      execution: { kind: 'experimental_agent_session_realtime', agent: 'codex' },
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
    const entryPath = `react-native/voice-runtime-native/${platform}.bundle.js`;
    const bytes = new TextEncoder().encode(`// ${platform} repack bundle`);
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const artifactGraph = PluginUiArtifactsManifestV1Schema.parse({ version: 1, entries: [{
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
    const pluginId = `acme.synthetic-${platform}`;
    const providerId = `${pluginId}/conversation`;
    const generation = platform === 'ios' ? 21 : 22;
    const identity = Object.freeze({
      pluginId, contributionId: declaration.id, artifactDigest: digest,
      hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
      platform, channel: 'internal', nativeCapabilitiesDigest: `sha256:${'a'.repeat(64)}`, projectionGeneration: generation,
    });
    const projection: PluginUiProjectionModel = Object.freeze({
      ...EMPTY_PLUGIN_UI_PROJECTION,
      generation,
      voiceProvidersById: Object.freeze({
        [providerId]: Object.freeze({
          id: providerId, pluginId, generation, contributionKey: providerId, definition: declaration,
        }),
      }),
      reactNativeBundlesById: Object.freeze({
        [`reactNativeBundle:${pluginId}:${declaration.id}`]: Object.freeze({
          id: `reactNativeBundle:${pluginId}:${declaration.id}`,
          pluginId, contributionKind: 'reactNativeBundle', contributionId: declaration.id,
          artifactGraph,
          runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: identity },
        }),
      }),
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const executableHost = createPluginUiExecutableModuleHost();
    const activate = vi.fn((api: ExternalVoiceProviderActivationApi) => {
      api.voiceProviders.register(declaration.id, createProviderLeaf());
    });
    const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'repackScriptManager', available: true,
      loadInstalledBundle: vi.fn(async () => activate),
    });
    onTestFinished(async () => {
      await executableHost.unload();
      hostLease.revoke();
    });

    await expect(activateProjectedExternalVoiceProviders({
      projection, machineId: 'machine-1', hostPlatform: platform,
      executableHost, cache: createPluginReactNativeBundleCache(), loaderBackend,
      fetchArtifactBytes: async () => ({
        ok: true, cacheIdentity: identity,
        artifact: { pluginId, contributionId: declaration.id, artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
        bytesBase64: encodeBase64(bytes),
        files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
      }),
    })).resolves.toEqual([{ providerId, result: { ok: true } }]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(loaderBackend.loadInstalledBundle).toHaveBeenCalledWith(expect.objectContaining({
      moduleReference: artifactGraph.repack,
    }));
    expect(getVoiceAdapterRegistry().get(providerId)).toMatchObject({
      resolveConversationBinding: expect.any(Function),
    });
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
                  'openai-codex': {
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

    await executableHost.invalidatePlugin(pluginId);
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
    const declaration = requireConversationDeclaration(pluginManifest.contributes.voiceProviders[0]!);
    const artifactRoot = new URL('dist/happier-plugin-ui/', fixtureRoot);
    const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(
      await readFile(new URL('ui-artifacts.json', artifactRoot), 'utf8'),
    ));
    const artifactGraph = manifest.entries.find((entry) => entry.contributionId === declaration.client.artifactId)!;
    const bytes = new Uint8Array(await readFile(new URL(artifactGraph.entry, artifactRoot)));
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const digest = artifactGraph.digest;
    const pluginId = pluginManifest.id;
    const identity = Object.freeze({
      pluginId, contributionId: declaration.id, artifactDigest: digest,
      hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
      platform: 'web', channel: 'internal', nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`, projectionGeneration: 12,
    });
    const providerId = `${pluginId}/${declaration.id}`;
    const recipientContract = createVoiceProviderRecipientContractV1({
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
        localId: declaration.id,
      },
      accountMediation: declaration.accountMediation!,
      presentation: { title: declaration.title },
    });
    const rawProjection: PluginProjectionV2 = {
      v: 2,
      generation: 12,
      installedPackagesById: {}, agentsById: {}, backendsById: {}, actionsById: {}, toolsById: {},
      commandsById: {}, resourcesById: {}, settingsById: {},
      familiesById: {
        voiceProviders: {
          family: 'voiceProviders',
          entriesById: {
            [providerId]: {
              id: providerId, pluginId: identity.pluginId, generation: 12,
              contributionKey: providerId, definition: declaration,
              recipientContract,
              recipientContractDigest: createRecipientContractDigestV1(recipientContract),
            },
          },
        },
        pluginUi: {
          family: 'pluginUi',
          entriesById: {
            [`reactNativeBundle:${identity.pluginId}:${identity.contributionId}`]: {
              id: `reactNativeBundle:${identity.pluginId}:${identity.contributionId}`,
              pluginId: identity.pluginId, contributionKind: 'reactNativeBundle', contributionId: identity.contributionId,
              artifactGraph,
              runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: identity },
            },
          },
        },
      },
      diagnostics: [],
    };
    const projection = resolvePluginUiProjectionState(EMPTY_PLUGIN_UI_PROJECTION, rawProjection);
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
      await host.unload();
      hostLease.revoke();
    });

    const activationInput = {
      projection, machineId: 'machine-1', serverId: 'server-1', hostPlatform: 'web',
      executableHost: host, cache: createPluginReactNativeBundleCache(), loaderBackend: backend,
      fetchArtifactBytes: async () => ({
        ok: true as const, cacheIdentity: identity,
        artifact: { pluginId: identity.pluginId, contributionId: identity.contributionId, artifactKind: 'reactNativeBundle' as const, digest, format: 'plainJs' as const, byteSize: bytes.byteLength },
        bytesBase64: encodeBase64(bytes),
        files: [{
          relativePath: artifactGraph.entry,
          digest: entryDigest,
          byteSize: bytes.byteLength,
          bytesBase64: encodeBase64(bytes),
        }],
      }),
    } as const;
    await expect(activateProjectedExternalVoiceProviders(activationInput))
      .resolves.toEqual([{ providerId, result: { ok: true } }]);
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
    });

    const declarationB = requireConversationDeclaration(PluginContributesV2Schema.parse({ voiceProviders: [{
      ...declaration,
      title: 'Synthetic B',
      capabilities: {
        readiness: { requirements: [] },
        turn: { cancelResponse: false, bargeIn: false },
      },
    }] }).voiceProviders[0]!);
    const projectionB: PluginUiProjectionModel = Object.freeze({
      ...projection,
      voiceProvidersById: Object.freeze({
        [providerId]: Object.freeze({
          ...projection.voiceProvidersById[providerId]!,
          definition: declarationB,
        }),
      }),
    });
    await expect(activateProjectedExternalVoiceProviders({
      ...activationInput,
      projection: projectionB,
      machineId: 'machine-2',
      serverId: 'server-2',
    })).resolves.toEqual([{ providerId, result: { ok: true } }]);
    expect(loads).toBe(2);
    expect(resolveVoiceAdapterSurfaceCapabilities(providerId, selected)).toEqual({
      allowsGlobalStart: true, controlSessionScope: 'global', requiresVoiceAgentFeature: false,
      bargeInEnabled: false, cancelResponse: 'unsupported', interruptionPolicy: 'disabled',
    });

    const replacementHostLease = createBundledConversationRuntimeHostLease();
    onTestFinished(() => replacementHostLease.revoke());
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    await expect(activateProjectedExternalVoiceProviders(activationInput))
      .resolves.toEqual([{ providerId, result: { ok: true } }]);
    expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();

    await host.unload();
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBeNull();
  });

  it('activates one shared executable artifact once for every declared Voice provider it owns', async () => {
    const declarations = PluginContributesV2Schema.parse({ voiceProviders: [
      {
        id: 'conversation-a', title: 'Synthetic A', kind: 'conversation',
        roles: ['realtime_conversation'], platforms: ['web'],
        capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: true } },
        client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
      },
      {
        id: 'conversation-b', title: 'Synthetic B', kind: 'conversation',
        roles: ['realtime_conversation'], platforms: ['web'],
        capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: true } },
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
    const identities = Object.fromEntries(declarations.map((declaration) => [declaration.id, Object.freeze({
      pluginId, contributionId: declaration.id, artifactDigest: digest,
      hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
      platform: 'web' as const, channel: 'internal', nativeCapabilitiesDigest: `sha256:${'d'.repeat(64)}`,
      projectionGeneration: generation,
    })]));
    const projection: PluginUiProjectionModel = Object.freeze({
      ...EMPTY_PLUGIN_UI_PROJECTION,
      generation,
      voiceProvidersById: Object.freeze(Object.fromEntries(declarations.map((declaration) => {
        const providerId = `${pluginId}/${declaration.id}`;
        return [providerId, Object.freeze({
          id: providerId, pluginId, generation, contributionKey: providerId, definition: declaration,
        })];
      }))),
      reactNativeBundlesById: Object.freeze(Object.fromEntries(declarations.map((declaration) => {
        const identity = identities[declaration.id]!;
        const id = `reactNativeBundle:${pluginId}:${declaration.id}`;
        return [id, Object.freeze({
          id, pluginId, contributionKind: 'reactNativeBundle', contributionId: declaration.id,
          artifactGraph,
          runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: identity },
        })];
      }))),
    });
    let loads = 0;
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
      backendId: 'reactNativeWebModule', available: true,
      async loadInstalledBundle() {
        loads += 1;
        return (api: ExternalVoiceProviderActivationApi) => {
          api.voiceProviders.register('conversation-a', createProviderLeaf());
          api.voiceProviders.register('conversation-b', createProviderLeaf());
        };
      },
    });
    const hostLease = createBundledConversationRuntimeHostLease();
    const host = createPluginUiExecutableModuleHost();
    const fetches: string[] = [];
    onTestFinished(async () => {
      await host.unload();
      hostLease.revoke();
    });

    const attempts = await activateProjectedExternalVoiceProviders({
      projection, machineId: 'machine-1', hostPlatform: 'web', executableHost: host,
      cache: createPluginReactNativeBundleCache(), loaderBackend: backend,
      fetchArtifactBytes: async ({ identity }) => {
        fetches.push(identity.contributionId);
        return {
          ok: true, cacheIdentity: identity,
          artifact: { pluginId, contributionId: identity.contributionId, artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
          bytesBase64: encodeBase64(bytes),
          files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength, bytesBase64: encodeBase64(bytes) }],
        };
      },
    });

    expect(Object.values(identities).map((identity) => DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(identity)))
      .toEqual([expect.objectContaining({ success: true }), expect.objectContaining({ success: true })]);
    expect(fetches).toEqual(['conversation-a']);
    expect(loads).toBe(1);
    expect(attempts).toEqual([
      { providerId: `${pluginId}/conversation-a`, result: { ok: true } },
      { providerId: `${pluginId}/conversation-b`, result: { ok: true } },
    ]);
    expect(getVoiceAdapterRegistry().get(`${pluginId}/conversation-a`)).not.toBeNull();
    expect(getVoiceAdapterRegistry().get(`${pluginId}/conversation-b`)).not.toBeNull();
  });
});
