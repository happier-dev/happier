import {
  DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  type PluginMachineExecutionOriginV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import {
  PluginUiArtifactsManifestEntryV1Schema,
  type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
  getInstalledPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
  getInstalledPluginUiExecutableModuleHost,
  type PluginUiExecutableAuthority,
  type PluginUiExecutableModuleActivationResult,
  type PluginUiExecutableModuleHost,
} from '@/components/plugins/reactNative/executableModuleHost';
import {
  derivePluginUiFederatedContainerName,
  type PluginReactNativeLoaderBackend,
  type RepackInstalledArtifactModuleReference,
} from '@/components/plugins/reactNative/loader';
import { resolveDefaultReactNativeLoaderBackend } from '@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend';
import {
  acquirePluginReactNativeArtifactAvailability,
} from '@/sync/domains/plugins/availability/reactNativeArtifactAvailability';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiProjectionEntryExecutionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { createAppShellPluginUiInvocationHost } from '@/components/appShell/plugins/pluginUiInvocationHost';

import {
  createExternalVoiceProviderActivationScope,
  type VoiceConversationProviderContribution,
} from './externalVoiceProviderActivation';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from './externalVoiceProviderRegistrations';
import {
  projectVoiceProviderDeclarationRequirements,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';
import { createExternalVoiceProviderSettingsDescriptor, projectExternalVoiceProviderSettings } from '@/voice/settings/externalProviderSettings';
import type { VoiceProviderPresentation, VoiceSpeechSettingsPresentation } from './voiceProviderPresentation';

type ActivationAttempt = Readonly<{
  providerId: string;
  result: PluginUiExecutableModuleActivationResult;
}>;

type ValidProjectedVoiceProvider = Readonly<{
  entry: PluginUiProjectionModel['voiceProvidersById'][string];
  declaration: VoiceConversationProviderContribution;
  identity: ReturnType<typeof DaemonPluginReactNativeBundleCacheIdentityV1Schema.parse>;
  artifactGraph: PluginUiArtifactsManifestEntryV1;
  moduleReference: RepackInstalledArtifactModuleReference;
  origin: PluginMachineExecutionOriginV1;
}>;

type ExternalVoiceProviderHostPlatform = 'web' | 'ios' | 'android';

const projectedSpeechRegistrationTokens = new WeakMap<PluginUiExecutableModuleHost, object>();
const projectedSpeechAuthorityTokens = new WeakMap<PluginUiExecutableModuleHost, object>();

function isExternalVoiceProviderHostPlatform(value: string): value is ExternalVoiceProviderHostPlatform {
  return value === 'web' || value === 'ios' || value === 'android';
}

function areSameProjectedVoiceExecutionOrigins(
  left: PluginMachineExecutionOriginV1,
  right: PluginMachineExecutionOriginV1,
): boolean {
  return left.serverIdentityId === right.serverIdentityId
    && left.materializationRef.machineId === right.materializationRef.machineId
    && left.materializationRef.materializationId === right.materializationRef.materializationId
    && left.materializationRef.pluginId === right.materializationRef.pluginId;
}

function bindArtifactCurrentnessToLoaderBackend(input: Readonly<{
  backend: PluginReactNativeLoaderBackend;
  isCurrent: () => boolean;
}>): PluginReactNativeLoaderBackend {
  const loadInstalledBundle = input.backend.loadInstalledBundle;
  if (!loadInstalledBundle) return input.backend;
  return Object.freeze({
    ...input.backend,
    loadInstalledBundle: async (request) => {
      if (!input.isCurrent()) throw new Error('voice_artifact_lease_revoked');
      const exported = await loadInstalledBundle(request);
      if (!input.isCurrent()) throw new Error('voice_artifact_lease_revoked');
      return exported;
    },
  });
}

function localizedText(
  value: string | Readonly<{ key: string; fallback: string }> | undefined,
  fallback: string,
): string {
  return typeof value === 'string' ? value : value?.fallback ?? fallback;
}

function projectExternalSpeechDescriptor(input: Readonly<{
  pluginId: string;
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;
}>): VoiceProviderRegistryEntry {
  const { declaration } = input;
  const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: input.pluginId,
    localId: declaration.id,
  }));
  const providerSettings = createExternalVoiceProviderSettingsDescriptor(declaration.settings);
  const requirements = projectVoiceProviderDeclarationRequirements(declaration);
  const hasStt = declaration.roles.some((role) => role.endsWith('_stt'));
  const hasTts = declaration.roles.some((role) => role.endsWith('_tts'));
  const speechPresentation: VoiceSpeechSettingsPresentation = Object.freeze({
    titleKey: localizedText(declaration.title, declaration.id),
    subtitleKey: input.pluginId,
    detailKey: input.pluginId,
    iconName: 'extension',
    ...(declaration.credentials
      ? {
          credential: Object.freeze({
            titleKey: localizedText(declaration.credentials.slot.title, 'API key'),
            promptTitleKey: localizedText(declaration.credentials.slot.title, 'API key'),
            promptBodyKey: localizedText(
              declaration.credentials.slot.description,
              localizedText(declaration.credentials.slot.title, 'API key'),
            ),
          }),
        }
      : {}),
    fields: Object.freeze(providerSettings.fields
      .filter((field) => field.presentation?.hidden !== true)
      .map((field) => Object.freeze({
        fieldId: field.id,
        titleKey: localizedText(field.title, field.id),
        subtitleKey: localizedText(field.description, localizedText(field.title, field.id)),
        promptTitleKey: localizedText(field.title, field.id),
        promptBodyKey: localizedText(field.description, localizedText(field.title, field.id)),
      }))),
    test: null,
  });
  const presentation: VoiceProviderPresentation = Object.freeze({
    providerId,
    settingsSectionId: providerId,
    createSettingsSpec: () => speechPresentation,
  });
  return Object.freeze({
    kind: 'voice.speech-engine.v1' as const,
    pluginId: input.pluginId,
    providerId,
    settingsSectionId: providerId,
    roles: Object.freeze([...declaration.roles]),
    requirements: Object.freeze(requirements),
    supportedPlatforms: Object.freeze([...declaration.platforms]),
    role: hasStt && hasTts ? 'both' : hasTts ? 'tts' : 'stt',
    declaration,
    catalogs: declaration.catalogs,
    limits: declaration.limits,
    presentation,
    providerSettings,
    projectSettings: (envelope) => projectExternalVoiceProviderSettings(envelope, providerSettings),
    source: Object.freeze({
      kind: 'external' as const,
      pluginId: input.pluginId,
      localId: declaration.id,
    }),
  });
}

export async function withdrawProjectedExternalVoiceProviders(
  executableHost: PluginUiExecutableModuleHost = getInstalledPluginUiExecutableModuleHost(),
): Promise<void> {
  projectedSpeechAuthorityTokens.delete(executableHost);
  const speechToken = projectedSpeechRegistrationTokens.get(executableHost);
  if (speechToken) {
    removeExternalVoiceProviderRegistration(speechToken);
    projectedSpeechRegistrationTokens.delete(executableHost);
  }
  await executableHost.replaceAuthority(null);
}

/**
 * Production F35 consumer. The generic projection/artifact owners establish
 * identity, integrity, currentness, and bytes; this adapter only maps the
 * declared Voice registration right into the canonical Voice activation scope.
 */
export async function activateProjectedExternalVoiceProviders(input: Readonly<{
  projection: PluginUiProjectionModel;
  machineId: string;
  serverId?: string | null;
  hostPlatform: string;
  executableHost?: PluginUiExecutableModuleHost;
  loaderBackend?: PluginReactNativeLoaderBackend;
  /** Account Availability is the only Artifact admission/source owner. */
  reader?: PluginAccountAvailabilityReader | null;
  /** Captured active Account lifetime; missing/retired scopes fail closed. */
  accountLifetime?: ActiveServerAccountScopeLifetime | null;
  createInvocationUi?: typeof createAppShellPluginUiInvocationHost;
}>): Promise<readonly ActivationAttempt[]> {
  const executableHost = input.executableHost ?? getInstalledPluginUiExecutableModuleHost();
  const cache = getInstalledPluginReactNativeBundleCache();
  const authority: PluginUiExecutableAuthority = Object.freeze({
    serverId: input.serverId ?? null,
    machineId: input.machineId,
    projectionGeneration: input.projection.generation,
  });
  const speechAuthorityToken = Object.freeze({});
  projectedSpeechAuthorityTokens.set(executableHost, speechAuthorityToken);
  const previousSpeechToken = projectedSpeechRegistrationTokens.get(executableHost);
  if (previousSpeechToken) {
    removeExternalVoiceProviderRegistration(previousSpeechToken);
    projectedSpeechRegistrationTokens.delete(executableHost);
  }
  await executableHost.replaceAuthority(authority);
  if (projectedSpeechAuthorityTokens.get(executableHost) !== speechAuthorityToken) {
    return Object.freeze([]);
  }
  if (!isExternalVoiceProviderHostPlatform(input.hostPlatform) || input.projection.generation === null) {
    return Object.freeze([]);
  }

  const loaderBackend = input.loaderBackend ?? resolveDefaultReactNativeLoaderBackend();
  const attempts: ActivationAttempt[] = [];
  const speechToken = Object.freeze({});
  let projectedSpeech = false;
  for (const entry of Object.values(input.projection.voiceProvidersById)) {
    const declaration = entry.definition;
    if (entry.generation !== input.projection.generation
      || declaration.kind !== 'speech'
      || !declaration.platforms.includes(input.hostPlatform)) continue;
    const descriptor = projectExternalSpeechDescriptor({ pluginId: entry.pluginId, declaration });
    if (descriptor.providerId !== entry.id) continue;
    commitExternalVoiceProviderRegistration(Object.freeze({
      token: speechToken,
      pluginId: entry.pluginId,
      localId: declaration.id,
      providerId: entry.id,
      descriptor,
      adapter: null,
    }));
    projectedSpeech = true;
  }
  if (projectedSpeech) projectedSpeechRegistrationTokens.set(executableHost, speechToken);
  const groups = new Map<string, ValidProjectedVoiceProvider[]>();
  for (const entry of Object.values(input.projection.voiceProvidersById)) {
    const declaration = entry.definition;
    if (declaration.kind !== 'conversation') continue;
    if (!declaration.platforms.includes(input.hostPlatform)) continue;
    const contributionId = declaration.id;
    const bundle = input.projection.reactNativeBundlesById[`reactNativeBundle:${entry.pluginId}:${contributionId}`];
    const runtime = bundle?.runtime;
    const runtimeRecord = runtime && typeof runtime === 'object' && !Array.isArray(runtime)
      ? runtime as Readonly<Record<string, unknown>>
      : null;
    const decision = runtimeRecord?.decision;
    const decisionRecord = decision && typeof decision === 'object' && !Array.isArray(decision)
      ? decision as Readonly<Record<string, unknown>>
      : null;
    const loadPolicy = runtimeRecord?.loadPolicy;
    const loadPolicyRecord = loadPolicy && typeof loadPolicy === 'object' && !Array.isArray(loadPolicy)
      ? loadPolicy as Readonly<Record<string, unknown>>
      : null;
    const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.safeParse(bundle?.artifactGraph);
    const identity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(runtimeRecord?.cacheIdentity);
    const entryOrigin = readPluginUiProjectionEntryExecutionOrigin(entry);
    const bundleOrigin = readPluginUiProjectionEntryExecutionOrigin(bundle);
    if (
      bundle?.pluginId !== entry.pluginId
      || bundle?.contributionId !== contributionId
      || !entryOrigin
      || !bundleOrigin
      || !areSameProjectedVoiceExecutionOrigins(entryOrigin, bundleOrigin)
      || entryOrigin.materializationRef.machineId !== input.machineId
      || !artifactGraph.success
      || artifactGraph.data.contributionId !== declaration.client.artifactId
      || artifactGraph.data.platform !== input.hostPlatform
      || decisionRecord?.state !== 'load'
      || loadPolicyRecord?.source !== 'installedArtifact'
      || !identity.success
      || identity.data.pluginId !== entry.pluginId
      || identity.data.contributionId !== contributionId
      || identity.data.projectionGeneration !== input.projection.generation
      || identity.data.platform !== input.hostPlatform
      || identity.data.artifactDigest !== artifactGraph.data.digest
    ) continue;

    const moduleReference = artifactGraph.data.repack ?? Object.freeze({
      containerName: derivePluginUiFederatedContainerName({
        pluginId: entry.pluginId,
        contributionId: declaration.client.artifactId,
      }),
      modulePath: declaration.client.modulePath,
      exportName: declaration.client.exportName,
    });
    const groupKey = [
      entry.pluginId,
      declaration.client.artifactId,
      moduleReference.containerName,
      moduleReference.modulePath,
      moduleReference.exportName,
      entryOrigin.serverIdentityId,
      entryOrigin.materializationRef.machineId,
      entryOrigin.materializationRef.materializationId,
      entryOrigin.materializationRef.pluginId,
    ].join('\u0000');
    const group = groups.get(groupKey) ?? [];
    group.push(Object.freeze({
      entry,
      declaration,
      identity: identity.data,
      artifactGraph: artifactGraph.data,
      moduleReference,
      origin: entryOrigin,
    }));
    groups.set(groupKey, group);
  }

  for (const unorderedGroup of groups.values()) {
    const group = [...unorderedGroup].sort((left, right) => left.entry.id.localeCompare(right.entry.id));
    const first = group[0];
    if (!first) continue;
    if (group.some((candidate) => (
      candidate.artifactGraph.digest !== first.artifactGraph.digest
      || !areSameProjectedVoiceExecutionOrigins(candidate.origin, first.origin)
    ))) continue;

    const reader = input.reader;
    const accountLifetime = input.accountLifetime;
    const serverId = input.serverId;
    if (!reader || !accountLifetime || !accountLifetime.isCurrent() || !serverId) continue;
    const consumerIsCurrent = () => (
      projectedSpeechAuthorityTokens.get(executableHost) === speechAuthorityToken
      && accountLifetime.isCurrent()
    );
    const acquired = await acquirePluginReactNativeArtifactAvailability({
      reader,
      artifactGraph: first.artifactGraph,
      cacheIdentity: first.identity,
      accountLifetime,
      artifactOwnerKind: 'voiceProvider',
      daemon: {
        origin: first.origin,
        serverId,
      },
      isCurrent: consumerIsCurrent,
    });
    if (acquired.kind !== 'available') continue;
    if (!acquired.isCurrent()) {
      acquired.dispose();
      continue;
    }

    let leaseReleased = false;
    let scopeCreated = false;
    let artifactLeaseRevocation: Readonly<{ dispose(): void }> | null = null;
    let accountLifetimeRetirement: Readonly<{ dispose(): void }> | null = null;
    const releaseLease = () => {
      if (leaseReleased) return;
      leaseReleased = true;
      artifactLeaseRevocation?.dispose();
      accountLifetimeRetirement?.dispose();
      acquired.dispose();
    };
    artifactLeaseRevocation = acquired.onRevoke(() => {
      void executableHost.invalidatePlugin(first.entry.pluginId);
    });
    accountLifetimeRetirement = accountLifetime.onRetire(() => {
      void executableHost.invalidatePlugin(first.entry.pluginId);
    });
    if (!acquired.isCurrent()) {
      releaseLease();
      continue;
    }

    const result = await executableHost.activate({
      cache,
      identity: first.identity,
      moduleReference: first.moduleReference,
      backend: bindArtifactCurrentnessToLoaderBackend({
        backend: loaderBackend,
        isCurrent: acquired.isCurrent,
      }),
      hostPlatform: input.hostPlatform,
      authority,
      createScope: () => {
        const scope = createExternalVoiceProviderActivationScope({
          pluginId: first.entry.pluginId,
          generation: String(first.identity.projectionGeneration),
          declarations: group.map((candidate) => candidate.declaration),
          clientRuntimeIdentitiesByLocalId: Object.freeze(Object.fromEntries(
            group.map((candidate) => [candidate.declaration.id, candidate.identity] as const),
          )),
          recipientContractsByLocalId: Object.freeze(Object.fromEntries(group.flatMap((candidate) => (
            candidate.entry.recipientContract
              ? [[candidate.declaration.id, candidate.entry.recipientContract] as const]
              : []
          )))),
          hostPlatform: input.hostPlatform,
          createInvocationUi: (operation) => (input.createInvocationUi ?? createAppShellPluginUiInvocationHost)({
            ...operation,
            machineId: input.machineId,
            serverId: input.serverId ?? null,
            executionOrigin: first.origin,
          }),
        });
        scopeCreated = true;
        return Object.freeze({
          ...scope,
          isCurrent: () => acquired.isCurrent() && (scope.isCurrent?.() ?? true),
          async commit() {
            if (!acquired.isCurrent()) throw new Error('voice_artifact_lease_revoked');
            await scope.commit();
            if (!acquired.isCurrent()) throw new Error('voice_artifact_lease_revoked');
          },
          unwind: () => {
            try {
              return scope.unwind();
            } finally {
              // Call the Voice scope first: its synchronous prefix withdraws
              // registrations before this Artifact lease is released.
              releaseLease();
            }
          },
        });
      },
    });
    if (!scopeCreated) releaseLease();
    for (const candidate of group) {
      attempts.push(Object.freeze({ providerId: candidate.entry.id, result }));
    }
  }
  return Object.freeze(attempts);
}
