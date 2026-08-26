import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  type PluginContributionClientPlatform,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import type { PluginSettingsActionInput } from '@happier-dev/plugin-sdk/settings';

import {
  type PluginUiClientExecutableDerivedScopeFactory,
} from '@/components/plugins/reactNative/clientExecutableActivation';
import type { PluginUiClientExecutableRegistrationScope } from '@/components/plugins/reactNative/clientExecutableContributions';
import {
  getInstalledPluginUiExecutableModuleHost,
  type PluginUiExecutableModuleHost,
} from '@/components/plugins/reactNative/executableModuleHost';
import type { PluginUiProjectedClientExecutableTarget } from '@/components/plugins/reactNative/clientExecutableProjection';
import type { PluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
  createAppShellPluginUiInvocationHost,
} from '@/components/appShell/plugins/pluginUiInvocationHost';
import {
  createPluginUiProjectedActionResolver,
  type PluginUiProjectedActionResolver,
  type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

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
import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
} from '@/voice/settings/externalProviderSettings';
import { bundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import type { VoiceProviderPresentation, VoiceSpeechSettingsPresentation } from './voiceProviderPresentation';

const projectedSpeechRegistrationTokens = new WeakMap<PluginUiExecutableModuleHost, object>();

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

function readCurrent(input: Readonly<{ isCurrent?: () => boolean }>): boolean {
  try {
    return input.isCurrent?.() ?? true;
  } catch {
    return false;
  }
}

/**
 * Speech has no client executable target. Its existing registry projection is
 * synchronous and token-owned; the generic activation owner never observes
 * or reconstructs these settings descriptors.
 */
function reconcileProjectedExternalSpeechProviders(input: Readonly<{
  projection: PluginUiProjectionModel | null;
  hostPlatform: PluginContributionClientPlatform;
  executableHost: PluginUiExecutableModuleHost;
  isCurrent?: () => boolean;
}>): void {
  if (!readCurrent(input)) return;
  const previousToken = projectedSpeechRegistrationTokens.get(input.executableHost);
  if (previousToken) {
    removeExternalVoiceProviderRegistration(previousToken);
    projectedSpeechRegistrationTokens.delete(input.executableHost);
  }
  const projection = input.projection;
  if (!projection || projection.generation === null || !readCurrent(input)) return;

  const token = Object.freeze({});
  let projected = false;
  for (const entry of Object.values(projection.voiceProvidersById)) {
    const declaration = entry.definition;
    if (
      entry.generation !== projection.generation
      || declaration.kind !== 'speech'
      || !declaration.platforms.includes(input.hostPlatform)
    ) {
      continue;
    }
    const descriptor = projectExternalSpeechDescriptor({ pluginId: entry.pluginId, declaration });
    if (descriptor.providerId !== entry.id) continue;
    commitExternalVoiceProviderRegistration(Object.freeze({
      token,
      pluginId: entry.pluginId,
      localId: declaration.id,
      providerId: entry.id,
      descriptor,
      adapter: null,
      ...(declaration.settings.actions?.length
        ? {
            settingsActions: Object.freeze({
              execute: async (action: PluginSettingsActionInput & Readonly<{
                signal: AbortSignal;
              }>) => await bundledSpeechDaemonClient.executeSettingsAction({
                entry: descriptor,
                actionId: action.actionId,
                signal: action.signal,
              }),
            }),
          }
        : {}),
    }));
    projected = true;
  }
  if (projected && readCurrent(input)) {
    projectedSpeechRegistrationTokens.set(input.executableHost, token);
  } else if (projected) {
    removeExternalVoiceProviderRegistration(token);
  }
}

/** Voice-only cleanup: generic executable unload remains a separate owner. */
export async function withdrawProjectedExternalVoiceProviders(
  executableHost: PluginUiExecutableModuleHost = getInstalledPluginUiExecutableModuleHost(),
): Promise<void> {
  const speechToken = projectedSpeechRegistrationTokens.get(executableHost);
  if (!speechToken) return;
  removeExternalVoiceProviderRegistration(speechToken);
  projectedSpeechRegistrationTokens.delete(executableHost);
}

function createVoiceDerivedScope(input: Readonly<{
  target: PluginUiProjectedClientExecutableTarget;
  registrationScope: PluginUiClientExecutableRegistrationScope;
  resolveContributedAction: PluginUiProjectedActionResolver;
  readNavigationBinding?: () => PluginSurfaceDestinationNavigationBinding | null | undefined;
  createInvocationUi?: typeof createAppShellPluginUiInvocationHost;
  /** Admitted UI projection; resolves declared confirmation wording. */
  pluginUiProjection?: PluginUiProjectionModel | null;
}>): ReturnType<PluginUiClientExecutableDerivedScopeFactory> {
  if (input.target.voiceProviders.length === 0) return null;
  const declarations: readonly VoiceConversationProviderContribution[] = input.target.voiceProviders
    .map((provider) => provider.declaration);
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: input.target.pluginId,
    generation: String(input.target.projectionGeneration),
    declarations,
    registrationScope: input.registrationScope,
    clientRuntimeIdentitiesByLocalId: Object.freeze(Object.fromEntries(
      input.target.voiceProviders.map((provider) => [provider.declaration.id, provider.cacheIdentity] as const),
    )),
    recipientContractsByLocalId: Object.freeze(Object.fromEntries(input.target.voiceProviders.flatMap((provider) => (
      provider.entry.recipientContract
        ? [[provider.declaration.id, provider.entry.recipientContract] as const]
        : []
    )))),
    hostPlatform: input.target.target.platform,
    createInvocationUi: (operation) => (input.createInvocationUi ?? createAppShellPluginUiInvocationHost)({
      ...operation,
      machineId: input.target.authority.machineId,
      serverId: input.target.authority.serverId,
      resolveContributedAction: input.resolveContributedAction,
      readNavigationBinding: input.readNavigationBinding,
      pluginUiProjection: input.pluginUiProjection,
    }),
  });
  return scope;
}

/**
 * Voice receives raw targets after generic projection and Artifact admission.
 * It only projects speech descriptors and layers the Voice runtime scope onto
 * the generic registration transaction; it owns no lease, currentness token,
 * target grouping, loader, or activation call.
 */
export function createProjectedExternalVoiceProviderDerivedScopeFactory(input: Readonly<{
  projection: PluginUiProjectionModel | null;
  hostPlatform: PluginContributionClientPlatform;
  executableHost?: PluginUiExecutableModuleHost;
  actionProjection?: PluginUiProjectionModel | null;
  resolveContributedAction?: PluginUiProjectedActionResolver;
  readNavigationBinding?: () => PluginSurfaceDestinationNavigationBinding | null | undefined;
  createInvocationUi?: typeof createAppShellPluginUiInvocationHost;
  isCurrent?: () => boolean;
}>): PluginUiClientExecutableDerivedScopeFactory {
  const executableHost = input.executableHost ?? getInstalledPluginUiExecutableModuleHost();
  reconcileProjectedExternalSpeechProviders({
    projection: input.projection,
    hostPlatform: input.hostPlatform,
    executableHost,
    isCurrent: input.isCurrent,
  });
  const resolveContributedAction = input.resolveContributedAction
    ?? createPluginUiProjectedActionResolver(input.actionProjection?.actionsById);
  return ({ target, registrationScope }) => {
    if (!readCurrent(input)) {
      throw new Error('projected_external_voice_provider_scope_stale');
    }
    return createVoiceDerivedScope({
      target,
      registrationScope,
      resolveContributedAction,
      readNavigationBinding: input.readNavigationBinding,
      createInvocationUi: input.createInvocationUi,
      pluginUiProjection: input.actionProjection,
    });
  };
}
