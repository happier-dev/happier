import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import type { RecipientContractV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import type { PluginContributionClientPlatform } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import type { PluginSettingsActionInput } from '@happier-dev/plugin-sdk/settings';
import type { PluginAccountApi, PluginClientApi } from '@happier-dev/plugin-sdk';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

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
  getExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
  replaceExternalVoiceProviderProjectionAuthority,
  type ExternalVoiceProviderRegistration,
} from './externalVoiceProviderRegistrations';
import {
  projectVoiceProviderAccountCredentialSlot,
  projectVoiceProviderDeclarationRegistryBase,
  projectExternalConversationVoiceDescriptor,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';
import {
  createExternalVoiceProviderSettingsDescriptor,
} from '@/voice/settings/externalProviderSettings';
import { bundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import type { VoiceProviderPresentation, VoiceSpeechSettingsPresentation } from './voiceProviderPresentation';

type ProjectedSpeechProvider = Readonly<{
  pluginId: string;
  occurrenceId: string;
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;
  recipientContract: RecipientContractV1 | null;
  registration: ExternalVoiceProviderRegistration;
}>;
type ProjectedConversationDescriptor = Readonly<{
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;
  recipientContract: RecipientContractV1 | null;
  descriptor: VoiceProviderRegistryEntry;
}>;
const projectedVoiceProjections = new WeakMap<PluginUiExecutableModuleHost, Readonly<{
  token: object;
  speechByProviderId: ReadonlyMap<string, ProjectedSpeechProvider>;
  conversationByProviderId: ReadonlyMap<string, ProjectedConversationDescriptor>;
}>>();

function localizedText(
  value: string | Readonly<{ key: string; fallback: string }> | undefined,
  fallback: string,
): string {
  return typeof value === 'string' ? value : value?.fallback ?? fallback;
}

function projectExternalSpeechDescriptor(input: Readonly<{
  pluginId: string;
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;
  recipientContract: RecipientContractV1 | null;
}>): VoiceProviderRegistryEntry {
  const { declaration } = input;
  const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: input.pluginId,
    localId: declaration.id,
  }));
  const providerSettings = createExternalVoiceProviderSettingsDescriptor(declaration.settings);
  const declarationBase = projectVoiceProviderDeclarationRegistryBase({
    declaration,
    providerSettings,
  });
  const accountCredentialSlot = projectVoiceProviderAccountCredentialSlot(
    declaration,
    input.recipientContract,
  );
  const hasStt = declaration.roles.some((role) => role.endsWith('_stt'));
  const hasTts = declaration.roles.some((role) => role.endsWith('_tts'));
  const title = localizedText(declaration.title, declaration.id);
  const speechPresentation: VoiceSpeechSettingsPresentation = Object.freeze({
    titleKey: title,
    // A speech contribution declares no description; its raw plugin id is never shown in its place.
    subtitleKey: '',
    detailKey: title,
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
    ...declarationBase,
    role: hasStt && hasTts ? 'both' : hasTts ? 'tts' : 'stt',
    declaration,
    catalogs: declaration.catalogs,
    limits: declaration.limits,
    presentation,
    ...(accountCredentialSlot ? { accountCredentialSlot } : {}),
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
 * Declarations remain selectable before a conversation executable is demanded.
 * Speech has no client executable target. Both use the existing synchronous,
 * token-owned projection lifetime rather than executable activation lifetime.
 */
function reconcileProjectedVoiceProviderDescriptors(input: Readonly<{
  projection: PluginUiProjectionModel | null;
  hostPlatform: PluginContributionClientPlatform;
  executableHost: PluginUiExecutableModuleHost;
  isCurrent?: () => boolean;
}>): void {
  if (!readCurrent(input)) return;
  const previous = projectedVoiceProjections.get(input.executableHost);
  const projection = input.projection;
  if (!projection || projection.generation === null || !readCurrent(input)) {
    if (previous) {
      removeExternalVoiceProviderRegistration(previous.token);
      projectedVoiceProjections.delete(input.executableHost);
    }
    return;
  }

  const token = previous?.token ?? Object.freeze({});
  const speechByProviderId = new Map<string, ProjectedSpeechProvider>();
  const conversationByProviderId = new Map<string, ProjectedConversationDescriptor>();
  const next = Object.freeze({ token, speechByProviderId, conversationByProviderId });
  try {
    for (const entry of Object.values(projection.voiceProvidersById)) {
      const declaration = entry.definition;
      if (declaration.kind === 'conversation') {
        if (!declaration.platforms.includes(input.hostPlatform)) continue;
        const recipientContract = entry.recipientContract ?? null;
        const admitted = previous?.conversationByProviderId.get(entry.id);
        if (admitted && admitted.descriptor.pluginId === entry.pluginId
          && sameStrictJsonValue(admitted.declaration, declaration)
          && sameStrictJsonValue(admitted.recipientContract, recipientContract)) {
          conversationByProviderId.set(entry.id, admitted);
        } else {
          conversationByProviderId.set(entry.id, Object.freeze({ declaration, recipientContract,
            descriptor: projectExternalConversationVoiceDescriptor({ pluginId: entry.pluginId,
              declaration, recipientContract }),
          }));
        }
        continue;
      }
      if (
        declaration.kind !== 'speech'
      ) {
        continue;
      }
      const recipientContract = entry.recipientContract ?? null;
      const admitted = previous?.speechByProviderId.get(entry.id);
      if (admitted
        && admitted.pluginId === entry.pluginId
        && admitted.occurrenceId === entry.occurrenceId
        && sameStrictJsonValue(admitted.declaration, declaration)
        && sameStrictJsonValue(admitted.recipientContract, recipientContract)
        && getExternalVoiceProviderRegistration(entry.id) === admitted.registration) {
        speechByProviderId.set(entry.id, admitted);
        continue;
      }
      const descriptor = projectExternalSpeechDescriptor({
        pluginId: entry.pluginId,
        declaration,
        recipientContract,
      });
      if (descriptor.providerId !== entry.id) continue;
      const registration: ExternalVoiceProviderRegistration = Object.freeze({
        token,
        pluginId: entry.pluginId,
        localId: declaration.id,
        providerId: entry.id,
        occurrenceId: entry.occurrenceId,
        descriptor,
        adapter: null,
        ...(declaration.settings.actions?.length
          ? {
              settingsActions: Object.freeze({
                execute: async (action: PluginSettingsActionInput & Readonly<{
                  settingsRevision?: string;
                  signal: AbortSignal;
                }>) => await bundledSpeechDaemonClient.executeSettingsAction({
                  entry: descriptor,
                  actionId: action.actionId,
                  expectedSettingsVersion: Number(action.settingsRevision),
                  signal: action.signal,
                }),
              }),
            }
          : {}),
      });
      speechByProviderId.set(entry.id, Object.freeze({
        pluginId: entry.pluginId, occurrenceId: entry.occurrenceId, declaration, recipientContract, registration,
      }));
    }
    if (!readCurrent(input)) return;
    projectedVoiceProjections.set(input.executableHost, next);
    replaceExternalVoiceProviderProjectionAuthority(
      previous?.token ?? null,
      token,
      new Map(Object.values(projection.voiceProvidersById).map(entry => [entry.id, entry.occurrenceId])),
      [...speechByProviderId.values()].map(entry => entry.registration),
      [...conversationByProviderId.values()].map(entry => entry.descriptor),
    );
  } catch (error) {
    try {
      removeExternalVoiceProviderRegistration(token);
    } catch {
      // The registration/authority bytes are removed before listeners run;
      // a failing observer cannot retain them or replace the original failure.
    }
    projectedVoiceProjections.delete(input.executableHost);
    throw error;
  }
  if (!readCurrent(input) && projectedVoiceProjections.get(input.executableHost) === next) {
    removeExternalVoiceProviderRegistration(token);
    projectedVoiceProjections.delete(input.executableHost);
  }
}

/** Voice-only cleanup: generic executable unload remains a separate owner. */
export async function withdrawProjectedExternalVoiceProviders(
  executableHost: PluginUiExecutableModuleHost = getInstalledPluginUiExecutableModuleHost(),
): Promise<void> {
  const projection = projectedVoiceProjections.get(executableHost);
  if (!projection) return;
  removeExternalVoiceProviderRegistration(projection.token);
  projectedVoiceProjections.delete(executableHost);
}

function createVoiceDerivedScope(input: Readonly<{
  target: PluginUiProjectedClientExecutableTarget;
  registrationScope: PluginUiClientExecutableRegistrationScope<PluginClientApi | PluginAccountApi>;
  resolveContributedAction: PluginUiProjectedActionResolver;
  readNavigationBinding?: () => PluginSurfaceDestinationNavigationBinding | null | undefined;
  createInvocationUi?: typeof createAppShellPluginUiInvocationHost;
  /** Admitted UI projection; resolves declared confirmation wording. */
  pluginUiProjection?: PluginUiProjectionModel | null;
}>): ReturnType<PluginUiClientExecutableDerivedScopeFactory> {
  if (input.target.voiceProviders.length === 0) return null;
  if ('kind' in input.target.authority || !('voiceProviders' in input.registrationScope.api)) return null;
  const authority = input.target.authority;
  const declarations: readonly VoiceConversationProviderContribution[] = input.target.voiceProviders
    .map((provider) => provider.declaration);
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: input.target.pluginId,
    occurrenceId: input.target.occurrenceId,
    declarations,
    registrationScope: { ...input.registrationScope, api: input.registrationScope.api },
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
      machineId: authority.machineId,
      serverId: authority.serverId,
      resolveContributedAction: input.resolveContributedAction,
      readNavigationBinding: input.readNavigationBinding,
      pluginUiProjection: input.pluginUiProjection,
    }),
  });
  return scope;
}

/**
 * Voice receives raw targets after generic projection and Artifact admission.
 * It projects declaration descriptors and layers the Voice runtime scope onto
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
  reconcileProjectedVoiceProviderDescriptors({
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
