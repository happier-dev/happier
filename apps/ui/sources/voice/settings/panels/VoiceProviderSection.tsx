import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { Platform } from 'react-native';


import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import {
  PluginSettingSelectField,
  PluginSettingSwitchField,
} from '@/components/settings/plugins/detail/PluginSettingChoiceFields';
import { PluginSettingTextField } from '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { resolveRequiredRecipientContractApprovalDigestV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import type { VoiceCredentialSourceSelection } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import {
  resolvePluginProjectionEditableSettingsGroup,
  type PluginProjectionEditableSettingField,
  type ResolvedPluginProjectionEditableSettingField,
  type ResolvedPluginProjectionEditableSettingsGroup,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import type { Settings } from '@/sync/domains/settings/settings';
import { useMachineCliDetectionTarget, useProfile } from '@/sync/store/hooks';
import {
  captureActiveServerAccountScopeLifetime,
  type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { inspectVoiceProviderReadiness, projectVoiceRawSpeechReadinessTargets } from '@/voice/settings/voiceProviderReadinessInspection';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
  readVoiceProviderSettingsConfig,
  voiceSettingsParse,
  writeVoiceProviderSettingsConfig,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { VoiceServiceGallery, VoiceServiceMark, type VoiceServiceTile } from '@/voice/settings/panels/VoiceServiceGallery';
import { resolveVoiceServiceTitle } from '@/voice/registry/voiceProviderPresentation';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { VoicePipelineView } from '@/voice/settings/pipeline/VoicePipelineView';
import { buildVoiceConversationsPipeline } from '@/voice/settings/pipeline/voicePipelineSteps';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import {
  resolveAccountVoiceCredentialSourceSelection,
  resolveAccountVoiceCredentialStatus,
  resolveSelectedVoiceCredentialRawGrants,
  shouldUseVoiceCredentialSourceMutationForSavedSecret,
} from '@/voice/credentials/accountVoiceCredential';
import {
  resolveVoiceConnectedAccountTargetEligibility,
  type VoiceConnectedAccountTargetEligibility,
} from '@/voice/credentials/sourceEligibility';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { VoiceRawCredentialAccessReview } from '@/voice/credentials/VoiceRawCredentialAccessReview';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import {
  isVoiceProviderSettingsProjectionCurrent,
  projectVoiceProviderCredentialReadiness,
  projectVoiceProviderSettings,
  type VoiceProviderCredentialReadinessProjection,
} from '@/voice/registry/providerRegistry';
import {
  projectSelectedUnavailableVoiceProvider,
  projectVoiceProviderSelectionRows,
  selectVoiceProviderOption,
} from '@/voice/registry/providerSelection';
import {
  isVoiceRoleSelectableForConfiguration,
  type VoiceProviderCredentialSourceKind,
  resolveVoicePassiveSetupReadiness,
  resolveVoiceRoleReadiness,
  type VoiceCredentialReadinessFact,
  type VoiceRoleReadiness,
} from '@/voice/registry/readiness';
import {
  resolveVoiceProviderAvailability,
  type ResolveVoiceProviderAvailabilityInput,
} from '@/voice/settings/resolveVoiceProviderAvailability';
import { projectLocalConversationReadinessFacts } from '@/voice/settings/projectLocalConversationReadinessFacts';
import {
  projectVoiceProviderAgentRealtimePassiveSetup,
  readVoiceProviderConnectedServicesBinding,
  readVoiceProviderPassiveRealtimeSetupResult,
  projectVoiceProviderConnectedServicesCredentialFact,
  projectVoiceProviderPassiveSetupFacts,
} from '@/voice/settings/passiveSetup';
import { VoiceGlobalConnectedServicesBindingField } from './realtime/VoiceGlobalConnectedServicesBindingField';
import { VoiceCredentialSourceField } from './realtime/VoiceCredentialSourceField';
import { resolveVoiceProviderReadinessPresentation, translateVoiceReadiness } from './voiceProviderReadinessPresentation';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';

const registry = createDefaultVoiceProviderRegistry();

const selectReadinessAccountSettings = (settings: Settings) => ({
  voiceSettingsV1: settings.voiceSettingsV1,
  secrets: settings.secrets,
  connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
  connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
});

type CheckedVoiceProviderReadinessResult =
  | Readonly<{
      kind: 'checking';
      detail: string;
      recoveryAction: 'none';
    }>
  | Readonly<{
      kind: 'terminal';
      detail: string | undefined;
      recoveryAction: VoiceRoleReadiness['recoveryAction'];
    }>;

type CheckedVoiceProviderReadinessState = Readonly<{
  providerId: string;
  checkKey: string;
  accountScopeLifetime: ActiveServerAccountScopeLifetime | null;
  status: 'checking' | 'terminal';
  passiveRealtimeSetupResult: unknown | null;
  rawCredentialAuthorizationByContribution: Readonly<Record<string, {
    contribution: Readonly<{ pluginId: string; localId: string }>;
    machineId: string | null;
    realm: 'daemon';
    phase: 'speech';
    status: 'ready' | 'approval_required' | 'unknown';
  }>>;
}>;

function serializeDeclarativeSettingDraft(control: string, value: unknown): string {
  if (control === 'json') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }
  return value === null || value === undefined ? '' : String(value);
}

function VoiceDeclarativeTextSettingField(props: Readonly<{
  pluginId: string;
  group: ResolvedPluginProjectionEditableSettingsGroup;
  field: ResolvedPluginProjectionEditableSettingField;
  value: unknown;
  onChangeValue: (value: unknown) => void;
}>) {
  const serializedValue = serializeDeclarativeSettingDraft(props.field.control, props.value);
  const [draft, setDraft] = React.useState(serializedValue);
  const [invalid, setInvalid] = React.useState(false);
  React.useEffect(() => {
    setDraft(serializedValue);
    setInvalid(false);
  }, [serializedValue]);

  return (
    <PluginSettingTextField
      pluginId={props.pluginId}
      group={props.group}
      field={props.field}
      value={draft}
      dirty={draft !== serializedValue}
      saving={false}
      saveFailed={false}
      persistenceDisabled={false}
      errorMessage={invalid ? t('settingsVoice.realtimeProviders.invalidValue') : null}
      onChangeText={(value) => {
        setDraft(value);
        setInvalid(false);
      }}
      onCommit={() => {
        let nextValue: unknown = draft;
        try {
          if (props.field.control === 'number') nextValue = Number(draft);
          if (props.field.control === 'json') nextValue = JSON.parse(draft);
          const validate = compilePluginJsonSchema(props.field.valueSchema);
          if (!isValidPluginJsonSchemaValue(validate, nextValue)) {
            setInvalid(true);
            return;
          }
        } catch {
          setInvalid(true);
          return;
        }
        props.onChangeValue(nextValue);
      }}
    />
  );
}

function normalizePlatform(platform: string): 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown' {
  return platform === 'web'
    || platform === 'ios'
    || platform === 'android'
    || platform === 'macos'
    || platform === 'windows'
    || platform === 'linux'
    ? platform
    : 'unknown';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createVoiceProviderReadinessCheckKey(input: Readonly<{
  providerId: string | null;
  modeId: string | null;
  executionMachineId: string | null;
  daemonStateVersion: number;
  connectedServices: unknown;
  /** Local voice's Hear/Speak engines: a different engine is a different setup to check. */
  speechEngines: readonly string[] | null;
  accountScope: unknown;
  credentialAuthority: unknown;
}>): string | null {
  if (!input.providerId) return null;
  return stableJsonStringify({
    providerId: input.providerId,
    modeId: input.modeId,
    executionMachineId: input.executionMachineId,
    daemonStateVersion: input.daemonStateVersion,
    connectedServices: input.connectedServices,
    speechEngines: input.speechEngines,
    accountScope: input.accountScope,
    credentialAuthority: input.credentialAuthority,
  });
}

function projectHostedModeAvailabilityReadiness(input: Readonly<{
  providerId: string;
  role: VoiceRoleReadiness['role'];
  modeId: string | null;
  hostedEnabled: boolean;
}>): VoiceRoleReadiness | null {
  if (input.modeId !== 'happier' || input.hostedEnabled) return null;
  return Object.freeze({
    role: input.role,
    providerId: input.providerId,
    status: 'unavailable',
    code: 'server_feature_disabled',
    reasonKey: 'voice.readiness.server_feature_disabled',
    recoveryAction: 'switch_provider',
  });
}

export function resolveVoiceProviderCredentialFact(input: Readonly<{
  sourceKind: 'built_in' | 'bundled' | 'external';
  projectedCredential: Pick<VoiceProviderCredentialReadinessProjection, 'status'> | null;
  hasAccountCredentialSlot: boolean;
  hasAccountCredentialReference: boolean;
  accountCredentialApprovalRequired?: boolean;
}>): VoiceCredentialReadinessFact {
  // The account-credential fallback is for an external row that produced *no*
  // projection. An explicit `unknown` is a produced fact — the account-settings
  // snapshot could not be read — and re-deriving it from the reference lookup
  // turns "I could not check" into "add a credential" for a credential that may
  // be stored and working.
  const usesExternalAccountCredentialFallback = input.sourceKind === 'external'
    && input.hasAccountCredentialSlot
    && !input.projectedCredential;
  if (input.sourceKind === 'external'
    && input.accountCredentialApprovalRequired
    && (input.projectedCredential?.status === 'missing' || usesExternalAccountCredentialFallback)) {
    return 'approval_required';
  }
  if (input.projectedCredential) {
    return input.projectedCredential.status;
  }
  if (input.sourceKind !== 'external') return 'unknown';
  return input.hasAccountCredentialSlot
    ? input.hasAccountCredentialReference ? 'ready' : 'missing'
    : 'unknown';
}

/** Read-only projection until a returned user operation is invoked; the gallery and hub share it. */
export function useVoiceConversationsReadinessModel(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  happierVoiceSupported: boolean;
  platformOs?: string;
  localAvailability?: ResolveVoiceProviderAvailabilityInput['local'];
  executionMachineId?: string | null;
  /** Retained selected identity; never used for a daemon request while offline. */
  executionMachineSelectedId?: string | null;
  executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
  popoverBoundaryRef?: React.RefObject<any> | null;
  onRecoveryAction?: (action: VoiceRoleReadiness['recoveryAction']) => void;
}) {
  React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const accountSettings = useSettingsSelector(selectReadinessAccountSettings);
  const savedSecretCatalog = useSavedSecretCatalog();
  const accountProfile = useProfile();
  const activeAccountScopeLifetime = captureActiveServerAccountScopeLifetime();
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const voiceAgentEnabled = useFeatureEnabled('voice.agent');
  const [checkedReadiness, setCheckedReadiness] = React.useState<CheckedVoiceProviderReadinessState | null>(null);
  const checkedReadinessRevision = React.useRef(0);
  const currentReadinessCheckKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => () => {
    checkedReadinessRevision.current += 1;
  }, []);
  const select = (next: VoiceSettings) => {
    checkedReadinessRevision.current += 1;
    setCheckedReadiness(null);
    props.setVoice(next);
  };

  const voice = voiceSettingsParse(props.voice);
  const availability = resolveVoiceProviderAvailability({
    happierVoiceSupported: props.happierVoiceSupported,
    platformOs: props.platformOs,
    local: props.localAvailability,
  });
  const platform = normalizePlatform(props.platformOs ?? Platform.OS);
  const executionMachineTarget = useMachineCliDetectionTarget(props.executionMachineId ?? null);
  const executionMachineSelectedId = props.executionMachineSelectedId
    ?? props.executionMachineId
    ?? null;
  const localAdapterSettings = resolveLocalVoiceAdapterSettings({ voice });
  const selectedSpeechProviderIds = [
    parseLocalVoiceSttSettings(localAdapterSettings.config.stt).provider,
    parseLocalVoiceTtsSettings(localAdapterSettings.config.tts).provider,
  ];
  const selectedRawSpeechTargets = projectVoiceRawSpeechReadinessTargets({ ...accountSettings, voice }, registry, props.executionMachineId ?? null);
  const localConversationReadinessFacts = projectLocalConversationReadinessFacts({
    registry,
    voice,
    voiceSettingsV1: accountSettings.voiceSettingsV1,
    secrets: accountSettings.secrets,
    connectedAccountPurposeBindingsV1: accountSettings.connectedAccountPurposeBindingsV1,
    platform,
    local: availability.local,
    localInput: props.localAvailability,
    executionMachineId: props.executionMachineId,
    executionMachineSelectionKind: props.executionMachineSelectionKind,
    voiceAgentEnabled,
    rawCredentialAuthorizationByContribution:
      checkedReadiness?.rawCredentialAuthorizationByContribution,
    resolveSavedSecret: savedSecretCatalog.resolveReference,
  });
  const rows = projectVoiceProviderSelectionRows(voice, registry).map((row) => {
    const settingsProjection = projectVoiceProviderSettings(row.entry, row.envelope);
    const contribution = row.entry.kind === 'voice.conversation-provider.v1'
      && row.entry.declaration?.kind === 'conversation'
      ? {
          pluginId: row.entry.pluginId,
          localId: row.entry.declaration.id,
        }
      : null;
    const accountCredentialStatus = row.entry.accountCredentialSlot && contribution
      ? resolveAccountVoiceCredentialStatus({
          settings: accountSettings,
          contribution,
          credentialSlotId: row.entry.accountCredentialSlot.id,
          requiredRecipientContractDigest: resolveRequiredRecipientContractApprovalDigestV1(
            row.entry.accountCredentialSlot.recipientContract,
          ),
          resolveSavedSecret: savedSecretCatalog.resolveReference,
        })
      : null;
    const accountCredentialReference = accountCredentialStatus?.status === 'ready'
      ? accountCredentialStatus.reference
      : null;
    // Bundled first-party recipients are governed by the shipped contract, not
    // the external-publisher re-review gate. Keep that gate at its only owner:
    // an externally supplied provider whose recipient contract can change.
    const accountCredentialApprovalRequired = row.entry.source.kind === 'external'
      && accountCredentialStatus?.status === 'review_required';
    const credentialDeclaration = row.entry.kind === 'voice.conversation-provider.v1'
      && row.entry.declaration?.kind === 'conversation'
      ? row.entry.declaration.credentials ?? null
      : null;
    let sourceSelection: (
      VoiceCredentialSourceSelection
      & Readonly<{ connectedAccountEligibility: VoiceConnectedAccountTargetEligibility }>
    ) | null = null;
    if (contribution && credentialDeclaration) {
      try {
        const resolvedSource = resolveAccountVoiceCredentialSourceSelection({
          settings: accountSettings,
          contribution,
          credentialSlotId: credentialDeclaration.slot.id,
          purpose: {
            consumer: contribution,
            purpose: credentialDeclaration.slot.purpose,
          },
          machineId: null,
        });
        sourceSelection = resolvedSource.selection.kind === 'connectedAccount'
          ? Object.freeze({
            kind: 'connectedAccount' as const,
            target: resolvedSource.selection.target,
            connectedAccountEligibility: resolveVoiceConnectedAccountTargetEligibility({
              target: resolvedSource.selection.target,
              declaredServices: credentialDeclaration.sources.flatMap((source) => (
                source.kind === 'connectedAccount'
                  ? [typeof source.service === 'string'
                      ? { pluginId: contribution.pluginId, localId: source.service }
                      : source.service]
                  : []
              )),
              accounts: accountProfile.connectedAccountsV4 ?? [],
              groups: accountProfile.connectedAccountGroupsV4 ?? [],
              resolveAuthentication: getConnectedAccountAuthentication,
            }),
          })
          : Object.freeze({
            kind: resolvedSource.selection.kind,
            connectedAccountEligibility: 'unusable' as const,
          });
      } catch {
        sourceSelection = null;
      }
    }
    const projectedCredential = projectVoiceProviderCredentialReadiness(
      row.entry,
      row.envelope,
      {
        sourceSelection,
        savedSecret: {
          status: accountCredentialStatus?.status === 'unknown'
            ? 'unknown'
            : accountCredentialReference ? 'ready' : 'missing',
        },
      },
    );
    const credentialFact = resolveVoiceProviderCredentialFact({
      sourceKind: row.entry.source.kind,
      projectedCredential,
      hasAccountCredentialSlot: Boolean(row.entry.accountCredentialSlot),
      hasAccountCredentialReference: Boolean(accountCredentialReference),
      accountCredentialApprovalRequired,
    });
    const declaredExecution = row.entry.kind === 'voice.conversation-provider.v1'
      && row.entry.declaration?.kind === 'conversation'
      ? row.entry.declaration.execution ?? null
      : null;
    const declaredPassiveSetup = projectVoiceProviderAgentRealtimePassiveSetup(declaredExecution);
    const declaredPassiveSetupFacts = projectVoiceProviderPassiveSetupFacts({
      execution: declaredExecution,
      executionMachineId: executionMachineSelectedId,
      executionMachineSelectionKind: props.executionMachineSelectionKind,
      executionMachineOnline: executionMachineTarget.isOnline,
      runtimeCapabilityResult: null,
    });
    const selectedMachineReady = typeof props.executionMachineId === 'string'
      && props.executionMachineId.trim().length > 0
      && executionMachineTarget.isOnline;
    const credentialSourceKind: VoiceProviderCredentialSourceKind | null = sourceSelection?.kind ?? null;
    const readinessFacts = {
      settings: row.providerId === 'local_conversation'
        ? localConversationReadinessFacts.settings
        : settingsProjection?.status ?? 'unknown',
      serverFeature: row.providerId === 'local_conversation'
        ? localConversationReadinessFacts.serverFeature
        : props.happierVoiceSupported ? 'ready' : 'missing',
      executionMachine:
        row.providerId === 'local_conversation'
          ? props.executionMachineSelectionKind === 'selected_unreachable'
            ? 'incompatible'
            : localConversationReadinessFacts.executionMachine
          : credentialSourceKind === 'connectedAccount'
            ? selectedMachineReady
              ? 'ready'
              : props.executionMachineSelectionKind === 'selected_unreachable'
                ? 'incompatible'
                : 'missing'
            : declaredPassiveSetupFacts.executionMachine ?? 'missing',
      credential: row.providerId === 'local_conversation'
        ? localConversationReadinessFacts.credential
        : credentialFact,
      endpoint: localConversationReadinessFacts.endpoint,
      runtime: row.providerId === 'local_conversation'
        ? localConversationReadinessFacts.runtime
        : declaredPassiveSetupFacts.runtime ?? localConversationReadinessFacts.runtime,
      model: localConversationReadinessFacts.model,
    } as const;
    const projectedReadiness = resolveVoiceRoleReadiness({
      registry,
      role: row.entry.roles[0]!,
      providerId: row.providerId,
      platform,
      modeId: row.modeId,
      settingsRequirements: settingsProjection?.requirements,
      credentialSourceKind,
      facts: readinessFacts,
    });
    const descriptorReadiness = row.providerId === 'local_conversation'
      && localConversationReadinessFacts.daemonRouteReadiness
      && (
        localConversationReadinessFacts.daemonRouteReadiness.code === 'server_feature_disabled'
        || localConversationReadinessFacts.daemonRouteReadiness.code === 'execution_machine_missing'
        || localConversationReadinessFacts.daemonRouteReadiness.code === 'execution_machine_incompatible'
        || projectedReadiness.code === 'execution_machine_missing'
      )
      ? localConversationReadinessFacts.daemonRouteReadiness
      : projectedReadiness;
    const readiness = projectHostedModeAvailabilityReadiness({
      providerId: row.providerId,
      role: row.entry.roles[0]!,
      modeId: row.modeId,
      hostedEnabled: availability.happier.enabled,
    }) ?? descriptorReadiness;
    // Whether a credential *can* be supplied is answered by the contribution's
    // own declaration (a savedSecret/connectedAccount source) or by a bundled
    // settings section — never by where the provider came from. Gating this on
    // bundled provenance left an externally installed provider whose only
    // blocker is `configure_credential` unselectable, so the credential it
    // declares could never be configured.
    const credentialConfigurationAvailable = row.entry.kind === 'voice.conversation-provider.v1'
      && (
        row.entry.providerSettings?.presentation !== null
        || credentialDeclaration?.sources.some((source) => (
          source.kind === 'savedSecret' || source.kind === 'connectedAccount'
        )) === true
      );
    const selectable = isVoiceRoleSelectableForConfiguration({
      readiness,
      credentialConfigurationAvailable,
      passiveRuntimeCheckAvailable: declaredPassiveSetup !== null,
    });
    const readinessPresentation = resolveVoiceProviderReadinessPresentation(readiness, translateVoiceReadiness, resolveVoiceServiceTitle(row.entry, tLoose, localizePluginText));
    const projectedCredentialGuidance = row.entry.source.kind === 'bundled'
      && row.entry.requirements.includes('credential')
      && projectedCredential?.status === 'unknown'
      ? tLoose(projectedCredential.detailKey)
      : null;
    const credentialDetail = row.entry.source.kind === 'external'
      && row.entry.requirements.includes('credential')
      ? projectedCredential
        ? tLoose(projectedCredential.detailKey)
        : row.entry.accountCredentialSlot
            ? accountCredentialReference
              ? t('settingsVoice.externalCredentials.ready')
              : t('settingsVoice.externalCredentials.missing')
            : t('settingsVoice.externalCredentials.unavailable')
      : undefined;
    const joinParts = (parts: readonly (string | null | undefined)[]) => parts
      .filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ') || undefined;
    const detail = accountCredentialApprovalRequired
      ? t('settingsVoice.externalCredentials.reviewRequired')
      : projectedCredentialGuidance ?? joinParts([credentialDetail, readinessPresentation.reason, readinessPresentation.action]);
    // What choosing this row needs, without its recovery action: the pipeline card owns the one action.
    const need = accountCredentialApprovalRequired
      ? t('settingsVoice.externalCredentials.reviewRequired')
      : projectedCredentialGuidance ?? joinParts([credentialDetail, readinessPresentation.reason]);
    return {
      ...row,
      readiness,
      selectable,
      detail,
      need,
      short: readinessPresentation.short,
      projectedCredential,
      projectedCredentialGuidance,
      readinessFacts,
      sourceSelection,
      credentialSourceKind,
    };
  });
  const selectedUnavailableProvider = projectSelectedUnavailableVoiceProvider(voice, registry);
  const selectedUnavailableReadiness = selectedUnavailableProvider
    ? resolveVoiceRoleReadiness({
        registry,
        role: selectedUnavailableProvider.entry?.roles[0] ?? 'realtime_conversation',
        providerId: selectedUnavailableProvider.providerId,
        platform,
        modeId: selectedUnavailableProvider.modeId,
        settingsRequirements: selectedUnavailableProvider.settingsProjection?.requirements,
        facts: {
          settings: selectedUnavailableProvider.settingsProjection?.status ?? 'unknown',
        },
      })
    : null;
  const selectedUnavailablePresentation = selectedUnavailableReadiness
    ? resolveVoiceProviderReadinessPresentation(selectedUnavailableReadiness, translateVoiceReadiness, selectedUnavailableProvider ? tLoose(selectedUnavailableProvider.titleKey) : undefined)
    : null;
  const selectedUnavailableDetail = selectedUnavailablePresentation
    ? [
        selectedUnavailablePresentation.reason,
        selectedUnavailablePresentation.action,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ') || undefined
    : undefined;
  const selectedProviderRow = rows.find((row) => row.selected) ?? null;
  const selectedAgentRealtimeExecution = selectedProviderRow?.entry.kind === 'voice.conversation-provider.v1'
    && selectedProviderRow.entry.declaration?.kind === 'conversation'
    ? selectedProviderRow.entry.declaration.execution ?? null
    : null;
  const selectedPassiveSetup = projectVoiceProviderAgentRealtimePassiveSetup(
    selectedAgentRealtimeExecution,
  );
  const selectedProviderConfig = selectedProviderRow
    ? readVoiceProviderSettingsConfig(voice, selectedProviderRow.providerId)
    : null;
  const selectedPassiveConnectedServicesBinding = selectedProviderRow
    ? readVoiceProviderConnectedServicesBinding({
        providerSettings: selectedProviderRow.entry.providerSettings ?? null,
        providerConfig: selectedProviderConfig,
      })
    : null;
  const selectedReadinessCheckKey = createVoiceProviderReadinessCheckKey({
    providerId: selectedProviderRow?.providerId ?? selectedUnavailableProvider?.providerId ?? null,
    modeId: selectedProviderRow?.modeId ?? selectedUnavailableProvider?.modeId ?? null,
    executionMachineId: executionMachineSelectedId,
    daemonStateVersion: executionMachineTarget.daemonStateVersion,
    connectedServices: selectedPassiveConnectedServicesBinding,
    speechEngines: selectedProviderRow?.providerId === 'local_conversation' ? selectedSpeechProviderIds : null,
    accountScope: activeAccountScopeLifetime?.scope ?? null,
    credentialAuthority: {
      voiceCredentialBindings: accountSettings.voiceSettingsV1.credentialBindings,
      connectedAccountPurposeBindingsV1: accountSettings.connectedAccountPurposeBindingsV1,
      savedSecretCatalog: {
        status: savedSecretCatalog.status,
        stale: savedSecretCatalog.stale,
        entries: savedSecretCatalog.sharedEntries.map((entry) => ({
          ref: entry.ref,
          revision: entry.revision,
          materialStatus: entry.materialStatus,
          use: entry.capabilities.use,
        })),
      },
    },
  });
  currentReadinessCheckKeyRef.current = selectedReadinessCheckKey;
  const checkedReadinessIsCurrent = checkedReadiness !== null
    && checkedReadiness.checkKey === selectedReadinessCheckKey
    && checkedReadiness.providerId === voice.providerId
    && checkedReadiness.accountScopeLifetime === activeAccountScopeLifetime
    && (
      checkedReadiness.accountScopeLifetime === null
      || checkedReadiness.accountScopeLifetime.isCurrent()
    );
  const passiveCapabilityRequest = React.useMemo(() => ({
    requests: selectedPassiveSetup
      ? [{
          id: selectedPassiveSetup.capabilityId,
          params: { bypassCache: true },
        }]
      : [],
  }), [selectedPassiveSetup]);
  const passiveCapability = useDaemonScopedMachineCapabilitiesCache({
    machineId: props.executionMachineId ?? null,
    enabled: checkedReadinessIsCurrent
      && selectedPassiveSetup !== null
      && executionMachineTarget.isOnline,
    request: passiveCapabilityRequest,
  });
  const passiveCapabilitySnapshot = passiveCapability.state.status === 'loaded'
    || passiveCapability.state.status === 'loading'
    ? passiveCapability.state.snapshot ?? null
    : null;
  const runtimeCapabilityResult = selectedPassiveSetup && checkedReadinessIsCurrent
    ? passiveCapabilitySnapshot?.response.results[selectedPassiveSetup.capabilityId] ?? null
    : null;
  const passiveRealtimeSetupResult = checkedReadinessIsCurrent
    ? readVoiceProviderPassiveRealtimeSetupResult(checkedReadiness.passiveRealtimeSetupResult)
    : null;
  const passiveSetupFacts = projectVoiceProviderPassiveSetupFacts({
    execution: selectedAgentRealtimeExecution,
    executionMachineId: executionMachineSelectedId,
    executionMachineSelectionKind: props.executionMachineSelectionKind,
    executionMachineOnline: executionMachineTarget.isOnline,
    runtimeCapabilityResult,
    passiveRealtimeSetupResult,
  });
  const passiveConnectedServicesCredential = selectedProviderRow
    ? projectVoiceProviderConnectedServicesCredentialFact({
        providerSettings: selectedProviderRow.entry.providerSettings ?? null,
        providerConfig: selectedProviderConfig,
        accountProfileConnectedServicesV2: accountProfile.connectedServicesV2 ?? [],
        labelsByKey: accountSettings.connectedServicesProfileLabelByKey ?? {},
        accountGroupsEnabled,
      })
    : undefined;
  const checkedProviderReadiness = selectedProviderRow
    ? resolveVoicePassiveSetupReadiness({
        registry,
        role: selectedProviderRow.entry.roles[0]!,
        providerId: selectedProviderRow.providerId,
        platform,
        modeId: selectedProviderRow.modeId,
        credentialSourceKind: selectedProviderRow.credentialSourceKind,
        passiveSetupUnavailable: passiveRealtimeSetupResult?.status === 'unavailable',
        facts: {
          ...selectedProviderRow.readinessFacts,
          ...passiveSetupFacts,
          ...(passiveConnectedServicesCredential
            ? { credential: passiveConnectedServicesCredential }
            : {}),
        },
      })
    : selectedUnavailableReadiness;
  const selectedProviderReadiness = selectedProviderRow?.readiness
    ?? selectedUnavailableReadiness;
  const checkedProviderReadinessPresentation = checkedProviderReadiness
    ? resolveVoiceProviderReadinessPresentation(checkedProviderReadiness, translateVoiceReadiness, selectedProviderRow ? resolveVoiceServiceTitle(selectedProviderRow.entry, tLoose, localizePluginText) : undefined)
    : null;
  const checkedProviderReadinessDetail = selectedProviderRow?.projectedCredentialGuidance
    ?? (checkedProviderReadinessPresentation ? [
        checkedProviderReadinessPresentation.summary,
        checkedProviderReadinessPresentation.action,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ') || undefined
      : undefined);
  const isCheckingPassiveSetup = checkedReadinessIsCurrent
    && checkedReadiness?.status === 'checking';
  const checkedProviderResult: CheckedVoiceProviderReadinessResult | null = isCheckingPassiveSetup
    ? {
        kind: 'checking',
        detail: tLoose('settings.updates.checking'),
        recoveryAction: 'none',
      }
    : checkedProviderReadiness
      ? {
          kind: 'terminal',
          detail: checkedProviderReadinessDetail,
          recoveryAction: checkedProviderReadiness.recoveryAction,
        }
      : null;
  const checkedReadinessRecoveryAction = checkedProviderResult?.recoveryAction ?? 'none';
  const checkedReadinessRecoveryHandler = checkedReadinessRecoveryAction === 'none'
    ? null
    : props.onRecoveryAction ?? null;
  const showCheckedReadiness = checkedReadinessIsCurrent
    && checkedProviderResult !== null;
  const visibleRows = selectedUnavailableProvider
    ? rows.filter((row) => row.providerId !== selectedUnavailableProvider.providerId)
    : rows;
  const isOff = voice.providerId === null;
  const selectedExternalRow = rows.find((row) => (
    row.providerId === voice.providerId
    && row.entry.kind === 'voice.conversation-provider.v1'
    && !row.entry.providerSettings?.presentation
    && projectVoiceProviderSettings(row.entry, voice.providers[row.providerId] ?? null)?.status === 'ready'
  ));
  const selectedExternalDeclaration = selectedExternalRow?.entry.kind === 'voice.conversation-provider.v1'
    && selectedExternalRow.entry.declaration?.kind === 'conversation'
    ? selectedExternalRow.entry.declaration
    : null;
  const selectedExternalCredentials = selectedExternalDeclaration?.credentials ?? null;
  const selectedExternalSourceSelection = selectedExternalRow?.sourceSelection ?? null;
  const selectedExternalContribution = selectedExternalDeclaration && selectedExternalRow
    ? Object.freeze({
        pluginId: selectedExternalRow.entry.pluginId,
        localId: selectedExternalDeclaration.id,
      })
    : null;
  const selectedExternalHasSavedSecret = selectedExternalCredentials?.sources.some(
    (source) => source.kind === 'savedSecret',
  ) === true;
  const selectedExternalHasConnectedAccount = selectedExternalCredentials?.sources.some(
    (source) => source.kind === 'connectedAccount',
  ) === true;
  const selectedExternalRawReviewGrants = (
    (platform === 'web' || platform === 'ios' || platform === 'android')
    && selectedExternalDeclaration
    && selectedExternalContribution
    && selectedExternalSourceSelection
  ) ? (['prepare', 'connection'] as const).flatMap((phase) => (
      resolveSelectedVoiceCredentialRawGrants({
        declaration: selectedExternalDeclaration,
        contribution: selectedExternalContribution,
        selection: selectedExternalSourceSelection,
        access: { realm: platform, phase },
      })
    )).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) : [];
  const selectedExternalCredentialAccessIsRaw = selectedExternalRawReviewGrants.length > 0;
  const selectedExternalConnectedRawReviewEligible = selectedExternalSourceSelection?.kind === 'connectedAccount'
    && selectedExternalRawReviewGrants.length > 0;
  const selectedExternalCredentialSlot = selectedExternalRow?.entry.accountCredentialSlot;
  const selectedDeclarativeSettingsRow = rows.find((row) => (
    row.providerId === voice.providerId
    && row.entry.kind === 'voice.conversation-provider.v1'
    && row.entry.providerSettings
    && !row.entry.providerSettings.presentation
    && row.entry.source.kind !== 'built_in'
    && isVoiceProviderSettingsProjectionCurrent(
      projectVoiceProviderSettings(row.entry, voice.providers[row.providerId] ?? null),
    )
  ));
  const selectedDeclarativeSettings = selectedDeclarativeSettingsRow?.entry.providerSettings;
  const selectedDeclarativeSettingsSource = selectedDeclarativeSettingsRow
    && selectedDeclarativeSettingsRow.entry.source.kind !== 'built_in'
    ? selectedDeclarativeSettingsRow.entry.source
    : null;
  const selectedDeclarativeConfig = selectedDeclarativeSettingsRow
    ? readVoiceProviderSettingsConfig(voice, selectedDeclarativeSettingsRow.providerId)
    : null;
  const declarativeSettingsGroup: ResolvedPluginProjectionEditableSettingsGroup | null = selectedDeclarativeSettingsRow
    && selectedDeclarativeSettings
    && selectedDeclarativeSettingsSource
    ? resolvePluginProjectionEditableSettingsGroup({
        id: selectedDeclarativeSettingsRow.providerId,
        pluginId: selectedDeclarativeSettingsSource.pluginId,
        version: 1,
        title: tLoose(selectedDeclarativeSettingsRow.titleKey),
        scope: { kind: 'account' },
        presentation: { sections: [], subagentSections: [] },
        target: { kind: 'plugin' },
        fields: selectedDeclarativeSettings.fields.map((field): PluginProjectionEditableSettingField => {
          const control = field.presentation?.control ?? 'auto';
          const schemaType = field.schema.type;
          const valueType: PluginProjectionEditableSettingField['valueType'] =
            schemaType === 'boolean'
            || schemaType === 'number'
            || schemaType === 'integer'
            || schemaType === 'object'
            || schemaType === 'array'
            || schemaType === 'null'
            || schemaType === 'string'
              ? schemaType
              : control === 'switch'
                ? 'boolean'
                : control === 'number'
                  ? 'number'
                  : 'string';
          return {
            key: field.id,
            control,
            valueType,
            valueSchema: field.schema,
            title: field.title,
            subtitle: field.description ?? null,
            secretCustody: null,
            redaction: 'none',
            clearWhenEmpty: 'persist',
            defaultValue: field.default,
            ...(control === 'switch' && typeof field.default === 'boolean'
              ? { defaultBooleanValue: field.default }
              : {}),
            ...(field.presentation ? { presentation: field.presentation } : {}),
          };
        }),
      }, localizePluginText)
    : null;
  const writeExternalSetting = (fieldId: string, value: unknown): void => {
    if (!selectedDeclarativeSettingsRow || !isRecord(selectedDeclarativeConfig)) return;
    select(writeVoiceProviderSettingsConfig(voice, selectedDeclarativeSettingsRow.providerId, {
      ...selectedDeclarativeConfig,
      [fieldId]: value,
    }));
  };

  const checkProviderReadiness = (): void => {
    if (isCheckingPassiveSetup || !voice.providerId || !selectedReadinessCheckKey) return;
    const revision = ++checkedReadinessRevision.current;
    const accountScopeLifetime = activeAccountScopeLifetime;
    const machineId = typeof props.executionMachineId === 'string'
      && props.executionMachineId.trim().length > 0
      ? props.executionMachineId.trim()
      : null;
    const canInspectPassiveSetup = Boolean(
      selectedPassiveSetup
      && selectedPassiveConnectedServicesBinding
      && machineId
      && executionMachineTarget.isOnline,
    );
    const canInspectRawSpeech = voice.providerId === 'local_conversation'
      && machineId !== null
      && executionMachineTarget.isOnline
      && selectedRawSpeechTargets.length > 0;
    setCheckedReadiness({
      providerId: voice.providerId,
      checkKey: selectedReadinessCheckKey,
      accountScopeLifetime,
      status: canInspectPassiveSetup || canInspectRawSpeech ? 'checking' : 'terminal',
      passiveRealtimeSetupResult: null,
      rawCredentialAuthorizationByContribution: {},
    });

    if (selectedPassiveSetup && executionMachineTarget.isOnline) {
      passiveCapability.refresh({
        request: passiveCapabilityRequest,
        bypassCache: true,
      });
    }
    if (!canInspectPassiveSetup && !canInspectRawSpeech) return;
    const settle = (result: Readonly<{
      passive: unknown | null;
      raw: readonly Readonly<{ providerId: string; contribution: Readonly<{ pluginId: string; localId: string }>; status: 'ready' | 'approval_required' | 'unknown' }>[];
    }>): void => {
      if (
        checkedReadinessRevision.current !== revision
        || currentReadinessCheckKeyRef.current !== selectedReadinessCheckKey
        || (accountScopeLifetime !== null && !accountScopeLifetime.isCurrent())
      ) return;
      setCheckedReadiness((current) => (
        current
        && current.checkKey === selectedReadinessCheckKey
        && current.providerId === voice.providerId
          ? {
              ...current,
              status: 'terminal',
              passiveRealtimeSetupResult: result.passive,
              rawCredentialAuthorizationByContribution: Object.fromEntries(result.raw.map((row) => [
                row.providerId,
                {
                  contribution: row.contribution,
                  machineId,
                  realm: 'daemon' as const,
                  phase: 'speech' as const,
                  status: row.status,
                },
              ])),
            }
          : current
      ));
    };

    if (!machineId) return;
    void inspectVoiceProviderReadiness({ machineId,
      passiveSetup: canInspectPassiveSetup ? selectedPassiveSetup : null,
      connectedServices: selectedPassiveConnectedServicesBinding,
      rawTargets: canInspectRawSpeech ? selectedRawSpeechTargets : [],
      isCurrent: () => checkedReadinessRevision.current === revision
        && currentReadinessCheckKeyRef.current === selectedReadinessCheckKey
        && (accountScopeLifetime === null || accountScopeLifetime.isCurrent()),
    }).then(settle);
  };

  // One tile per service: a service whose options only change who pays (hosted or your own account)
  // is one tile, and its billing is chosen in the Account section beneath the gallery.
  const serviceRowsById = new Map<string, typeof visibleRows[number][]>();
  for (const row of visibleRows) {
    const group = serviceRowsById.get(row.providerId);
    if (group) group.push(row);
    else serviceRowsById.set(row.providerId, [row]);
  }
  const resolveServiceTitle = (serviceRows: readonly typeof visibleRows[number][]): string =>
    resolveVoiceServiceTitle(serviceRows[0]!.entry, tLoose, localizePluginText);
  const serviceTiles: VoiceServiceTile[] = [
    ...(selectedUnavailableProvider ? [{
      id: selectedUnavailableProvider.providerId,
      title: tLoose(selectedUnavailableProvider.titleKey),
      subtitle: selectedUnavailableProvider.subtitleKey ? tLoose(selectedUnavailableProvider.subtitleKey) : undefined,
      status: selectedUnavailableDetail ? { tone: 'needs_you' as const, text: selectedUnavailableDetail } : null,
      selected: true,
      disabled: true,
      testID: 'settings.voice.provider.selectedUnavailable',
    }] : []),
    ...[...serviceRowsById.values()].map((serviceRows): VoiceServiceTile => {
      const shown = serviceRows.find((row) => row.selected) ?? serviceRows.find((row) => row.selectable) ?? serviceRows[0]!;
      const ready = shown.readiness.status === 'ready';
      const identity = shown.entry.mark;
      const badgeKey = shown.entry.presentation?.selectionOptions?.find((option) => option.id === shown.optionId)?.badgeKey;
      return {
        id: shown.providerId,
        title: resolveServiceTitle(serviceRows),
        subtitle: serviceRows.length > 1 ? undefined : tLoose(shown.subtitleKey),
        mark: identity ? <VoiceServiceMark identity={identity} /> : undefined,
        badge: badgeKey ? tLoose(badgeKey) : undefined,
        status: ready
          ? { tone: 'ready', text: shown.detail ?? t('settingsVoice.pages.conversations.serviceReady') }
          : {
              tone: 'needs_you',
              text: shown.short ?? translateVoiceReadiness(shown.readiness.reasonKey, { service: resolveServiceTitle(serviceRows) }),
              detail: shown.need ?? translateVoiceReadiness(shown.readiness.reasonKey, { service: resolveServiceTitle(serviceRows) }),
            },
        selected: serviceRows.some((row) => row.selected),
        disabled: !serviceRows.some((row) => row.selectable),
        testID: `settings.voice.provider.${encodeURIComponent(shown.providerId)}.${encodeURIComponent(shown.optionId)}`,
      };
    }),
  ];
  const selectedServiceBillingRows = isOff
    ? []
    : serviceRowsById.get(voice.providerId ?? '') ?? [];

  /** Choose a service from the gallery: its selected (or first selectable) option; never another service's setup. */
  const selectService = (providerId: string) => {
    const providerRows = visibleRows.filter((row) => row.providerId === providerId);
    const target = providerRows.find((row) => row.selected && row.selectable)
      ?? providerRows.find((row) => row.selectable);
    if (!target || target.selected) return;
    const next = selectVoiceProviderOption(voice, registry, target.providerId, target.optionId);
    if (next) select(next);
  };

  return {
    serviceTiles, isOff, select, selectService, voice, visibleRows, selectedServiceBillingRows,
    selectedProviderReadiness: showCheckedReadiness ? checkedProviderReadiness : selectedProviderReadiness,
    isCheckingPassiveSetup, checkProviderReadiness, showCheckedReadiness, checkedReadinessRecoveryHandler,
    checkedProviderResult, checkedReadinessRecoveryAction, checkedReadinessRevision, checkedReadiness,
    selectedExternalRow, selectedExternalDeclaration, selectedExternalCredentials, selectedExternalContribution,
    selectedExternalHasSavedSecret, selectedExternalHasConnectedAccount, selectedExternalCredentialAccessIsRaw,
    selectedExternalRawReviewGrants, selectedExternalCredentialSlot, selectedExternalConnectedRawReviewEligible,
    selectedDeclarativeSettings, selectedDeclarativeSettingsSource, declarativeSettingsGroup, selectedDeclarativeConfig,
    selectedDeclarativeSettingsRow, localizePluginText, writeExternalSetting,
    selectedProviderRow, selectedUnavailableProvider, localAdapterSettings, selectedSpeechProviderIds,
    selectedReadinessCheckKey,
    selectedLocalSpeechReadiness: checkedReadiness?.rawCredentialAuthorizationByContribution
      && !checkedReadinessIsCurrent
      ? null
      : localConversationReadinessFacts.speechReadiness,
  };
}

export function VoiceProviderSection(props: Parameters<typeof useVoiceConversationsReadinessModel>[0] & Readonly<{
  /**
   * Renders the selected service's own settings with this section's account rows (Pay with) on top of
   * the service's account group, so the page has one Account section. Without it the rows stand alone.
   */
  renderServiceSettings?: (accountLead: React.ReactNode) => React.ReactNode;
}>) {
  const router = useRouter();
  const {
    serviceTiles, isOff, select, selectService, voice, visibleRows, selectedServiceBillingRows, selectedProviderReadiness,
    selectedLocalSpeechReadiness, selectedReadinessCheckKey,
    checkProviderReadiness, showCheckedReadiness,
    checkedProviderResult, checkedReadinessRevision, checkedReadiness,
    selectedExternalRow, selectedExternalDeclaration, selectedExternalCredentials, selectedExternalContribution,
    selectedExternalHasSavedSecret, selectedExternalHasConnectedAccount, selectedExternalCredentialAccessIsRaw,
    selectedExternalRawReviewGrants, selectedExternalCredentialSlot, selectedExternalConnectedRawReviewEligible,
    selectedDeclarativeSettings, selectedDeclarativeSettingsSource, declarativeSettingsGroup, selectedDeclarativeConfig,
    selectedDeclarativeSettingsRow, localizePluginText, writeExternalSetting,
  } = useVoiceConversationsReadinessModel(props);
  // Always-on card readiness (lab C1): the model's passive check runs when this page opens and
  // whenever the setup it checks changes. Only the page renders this section — the hub reads the same
  // model without probing. The check itself is passive: no microphone, no audio, nothing billable.
  const checkProviderReadinessRef = React.useRef(checkProviderReadiness);
  checkProviderReadinessRef.current = checkProviderReadiness;
  React.useEffect(() => {
    if (selectedReadinessCheckKey) checkProviderReadinessRef.current();
  }, [selectedReadinessCheckKey]);
  const executionMachine = useVoiceExecutionMachinePresentation();
  const selectedServiceTitle = serviceTiles.find((tile) => tile.selected)?.title ?? null;
  const conversationsPipeline = React.useMemo(() => buildVoiceConversationsPipeline({
    voice,
    serviceTitle: selectedServiceTitle,
    readiness: selectedProviderReadiness ?? null,
    localSpeechReadiness: selectedLocalSpeechReadiness,
    machine: { machineId: executionMachine.selectedMachineId, machineLabel: executionMachine.machineLabel },
  }), [executionMachine.machineLabel, executionMachine.selectedMachineId, selectedLocalSpeechReadiness, selectedProviderReadiness, selectedServiceTitle, voice]);

  const payWith = selectedServiceBillingRows.length > 1 ? (
      <SegmentedChoiceItem<string>
        title={t('settingsVoice.pages.conversations.payWithTitle')}
        subtitleLines={0}
        testIDPrefix="settings.voice.provider.payWith"
        value={selectedServiceBillingRows.find((row) => row.selected)?.optionId ?? ''}
        options={selectedServiceBillingRows.map((row) => ({
          id: row.optionId,
          label: tLoose(row.titleKey),
          // What this way to pay means, in one sentence; its readiness is on the card above.
          description: row.optionId === 'happier'
            ? t('settingsVoice.pages.conversations.payWithHappierDescription')
            : row.optionId === 'byo'
              ? t('settingsVoice.pages.conversations.payWithOwnDescription')
              : tLoose(row.subtitleKey),
          // Why this way to pay cannot be chosen: the reason alone, never a run-on with its recovery action.
          ...(row.selectable ? {} : { unavailableReason: row.readiness.code === 'server_feature_disabled'
            ? t('settingsVoice.pages.conversations.happierBillingUnavailable')
            : row.need ?? translateVoiceReadiness(row.readiness.reasonKey, { service: tLoose(row.titleKey) }) }),
        }))}
        onChange={(optionId) => {
          const target = selectedServiceBillingRows.find((row) => row.optionId === optionId);
          if (!target || !target.selectable || target.selected) return;
          const next = selectVoiceProviderOption(voice, registry, target.providerId, target.optionId);
          if (next) select(next);
        }}
      />
  ) : null;
  return (
    <>
      {conversationsPipeline && selectedServiceTitle ? (
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.readiness}>
        <ItemGroup surface="none">
          <VoicePipelineView
            testID="settings.voice.conversations.pipeline"
            title={selectedServiceTitle}
            pipeline={conversationsPipeline.pipeline}
            cardReadiness={conversationsPipeline.cardReadiness}
            onRecoveryAction={props.onRecoveryAction}
          >
          <PoliteAccessibilityStatus
            announcement={showCheckedReadiness
              ? checkedProviderResult?.detail ?? t('settingsVoice.setupCheck.result')
              : ''}
            statusTestID="settings.voice.provider.readiness-status"
            transitionKey={showCheckedReadiness
              ? `${checkedReadinessRevision.current}:${checkedReadiness?.providerId ?? ''}:${checkedProviderResult?.kind ?? ''}:${checkedProviderResult?.detail ?? ''}`
              : `idle:${checkedReadinessRevision.current}`}
          />
          </VoicePipelineView>
        </ItemGroup>
        </SettingAnchor>
      ) : null}
      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.provider}>
      <ItemGroup
        title={t('settingsVoice.pages.conversations.serviceTitle')}
        description={t('settingsVoice.pages.conversations.serviceDescription')}
        surface="none"
      >
        <VoiceServiceGallery
          tiles={serviceTiles}
          offSelected={isOff}
          onSelectOff={() => select({ ...voice, providerId: null })}
          onSelect={selectService}
          onOpenServiceList={() => router.push(SETTINGS_ROUTES.voiceService as never)}
        />
      </ItemGroup>
      </SettingAnchor>
      {props.renderServiceSettings ? props.renderServiceSettings(payWith) : payWith ? (
        <ItemGroup
          title={t('settingsVoice.pages.conversations.accountTitle')}
          description={t('settingsVoice.pages.conversations.accountDescription')}
        >
          {payWith}
        </ItemGroup>
      ) : null}
      {!selectedExternalRow
        || !selectedExternalDeclaration
        || !selectedExternalCredentials
        || !selectedExternalContribution
        || (!selectedExternalHasSavedSecret && !selectedExternalHasConnectedAccount) ? null : (
        <ItemGroup
          title={tLoose(selectedExternalRow.titleKey)}
          description={t(
            selectedExternalCredentialAccessIsRaw
              ? 'settingsVoice.externalCredentials.rawFooter'
              : 'settingsVoice.externalCredentials.footer',
          )}
        >
          {!selectedExternalHasConnectedAccount ? null : <VoiceCredentialSourceField
            contribution={selectedExternalContribution}
            declaration={selectedExternalDeclaration}
            credentials={selectedExternalCredentials}
            popoverBoundaryRef={props.popoverBoundaryRef}
            isCurrent={() => {
              const current = registry.get(selectedExternalRow.providerId);
              return current?.kind === 'voice.conversation-provider.v1'
                && current.pluginId === selectedExternalContribution.pluginId
                && current.declaration?.id === selectedExternalContribution.localId;
            }}
          />}
          {!selectedExternalHasSavedSecret ? null : <VoiceCredentialItem
            testID={`settings.voice.externalCredential.${encodeURIComponent(selectedExternalRow.providerId)}.${encodeURIComponent(selectedExternalCredentials.slot.id)}`}
            title={t('settingsVoice.externalCredentials.apiKeyTitle')}
            promptTitle={t('settingsVoice.externalCredentials.promptTitle')}
            promptDescription={t(
              selectedExternalCredentialAccessIsRaw
                ? 'settingsVoice.externalCredentials.rawPromptDescription'
                : 'settingsVoice.externalCredentials.promptDescription',
            )}
            contribution={selectedExternalContribution}
            credentialSlotId={selectedExternalCredentials.slot.id}
            credentialSourcePurpose={shouldUseVoiceCredentialSourceMutationForSavedSecret(
              selectedExternalRow.sourceSelection,
            )
              ? selectedExternalCredentials.slot.purpose
              : undefined}
            credentialSourceDeclaration={selectedExternalDeclaration}
            rawCredentialReviewGrants={selectedExternalRow.sourceSelection?.kind === 'savedSecret'
              ? selectedExternalRawReviewGrants
              : undefined}
            recipientContract={selectedExternalCredentialSlot?.id === selectedExternalCredentials.slot.id
              ? selectedExternalCredentialSlot.recipientContract
              : null}
            recipientContractDigest={selectedExternalCredentialSlot?.id === selectedExternalCredentials.slot.id
              ? selectedExternalCredentialSlot.recipientContractDigest
              : null}
            disclosePlainStorage={true}
          />}
          {selectedExternalHasSavedSecret || !selectedExternalConnectedRawReviewEligible ? null : selectedExternalRawReviewGrants.map((rawGrant, index) => (
            <VoiceRawCredentialAccessReview
              key={JSON.stringify(rawGrant)}
              contribution={selectedExternalContribution}
              rawGrant={rawGrant}
              testID={`settings.voice.externalCredential.${encodeURIComponent(selectedExternalRow.providerId)}.rawAccess${index === 0 ? '' : `.${index}`}`}
            />
          ))}
        </ItemGroup>
      )}
      {!selectedDeclarativeSettings
        || !selectedDeclarativeSettingsRow
        || !selectedDeclarativeSettingsSource
        || !declarativeSettingsGroup
        || !isRecord(selectedDeclarativeConfig)
        || (selectedDeclarativeSettings.fields.length === 0
          && !selectedDeclarativeSettings.connectedServicesBinding)
        ? null
        : (
          <ItemGroup
            title={tLoose(selectedDeclarativeSettingsRow.titleKey)}
          >
            {selectedDeclarativeSettings.connectedServicesBinding
              ? (
                <VoiceGlobalConnectedServicesBindingField
                  agentId={
                    typeof selectedDeclarativeSettings.connectedServicesBinding.agent === 'string'
                      ? {
                        pluginId: selectedDeclarativeSettingsSource.pluginId,
                        localId: selectedDeclarativeSettings.connectedServicesBinding.agent,
                      }
                      : selectedDeclarativeSettings.connectedServicesBinding.agent
                  }
                  serviceIds={selectedDeclarativeSettings.connectedServicesBinding.serviceIds}
                  title={localizePluginText(
                    selectedDeclarativeSettingsSource.pluginId,
                    selectedDeclarativeSettings.connectedServicesBinding.title,
                  )}
                  subtitle={selectedDeclarativeSettings.connectedServicesBinding.description
                    ? localizePluginText(
                        selectedDeclarativeSettingsSource.pluginId,
                        selectedDeclarativeSettings.connectedServicesBinding.description,
                      )
                    : undefined}
                  value={selectedDeclarativeConfig[selectedDeclarativeSettings.connectedServicesBinding.id]}
                  onChange={(value) => writeExternalSetting(
                    selectedDeclarativeSettings.connectedServicesBinding!.id,
                    value,
                  )}
                />
              )
              : null}
            {declarativeSettingsGroup.fields.map((field) => {
              const control = field.presentation?.control;
              if (!control || field.presentation?.hidden === true) return null;
              if (control === 'select') return (
                <PluginSettingSelectField
                  key={field.key}
                  pluginId={selectedDeclarativeSettingsSource.pluginId}
                  group={declarativeSettingsGroup}
                  field={field}
                  value={selectedDeclarativeConfig[field.key]}
                  disabled={false}
                  popoverBoundaryRef={props.popoverBoundaryRef}
                  onChangeValue={(value) => writeExternalSetting(field.key, value)}
                />
              );
              if (control === 'switch') return (
                <PluginSettingSwitchField
                  key={field.key}
                  pluginId={selectedDeclarativeSettingsSource.pluginId}
                  group={declarativeSettingsGroup}
                  field={field}
                  value={selectedDeclarativeConfig[field.key] === true}
                  disabled={false}
                  onChangeValue={(_field, value) => writeExternalSetting(field.key, value)}
                />
              );
              return (
                <VoiceDeclarativeTextSettingField
                  key={field.key}
                  pluginId={selectedDeclarativeSettingsSource.pluginId}
                  group={declarativeSettingsGroup}
                  field={field}
                  value={selectedDeclarativeConfig[field.key]}
                  onChangeValue={(value) => writeExternalSetting(field.key, value)}
                />
              );
            })}
          </ItemGroup>
        )}
    </>
  );
}
