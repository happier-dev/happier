import * as React from 'react';
import { Platform } from 'react-native';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  PluginSettingSelectField,
  PluginSettingSwitchField,
} from '@/components/settings/plugins/detail/PluginSettingChoiceFields';
import { PluginSettingTextField } from '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  resolveRequiredRecipientContractApprovalDigestV1,
} from '@happier-dev/protocol';
import type {
  PluginProjectionEditableSettingField,
  PluginProjectionEditableSettingsGroup,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { useSettings } from '@/sync/domains/state/storage';
import { useMachineCliDetectionTarget, useProfile } from '@/sync/store/hooks';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import {
  readVoiceProviderSettingsConfig,
  voiceSettingsParse,
  writeVoiceProviderSettingsConfig,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import {
  resolveAccountVoiceCredentialSourceSelection,
  resolveAccountVoiceCredentialStatus,
  shouldUseVoiceCredentialSourceMutationForSavedSecret,
} from '@/voice/credentials/accountVoiceCredential';
import {
  resolveVoiceConnectedAccountTargetEligibility,
  type VoiceConnectedAccountTargetEligibility,
} from '@/voice/credentials/sourceEligibility';
import { getConnectedAccountAuthenticationMode } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  VoiceCredentialItem,
  voiceCredentialDeclarationHasRawGrants,
} from '@/voice/credentials/CredentialItem';
import { VoiceRawCredentialAccessReview } from '@/voice/credentials/VoiceRawCredentialAccessReview';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
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
  projectVoiceProviderConnectedServicesCredentialFact,
  projectVoiceProviderPassiveSetupFacts,
} from '@/voice/settings/passiveSetup';
import { VoiceGlobalConnectedServicesBindingField } from './realtime/VoiceGlobalConnectedServicesBindingField';
import { VoiceCredentialSourceField } from './realtime/VoiceCredentialSourceField';
import { resolveVoiceProviderReadinessPresentation } from './voiceProviderReadinessPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { ExternalSessionOperationAccessibilityStatus } from '@/components/sessions/external/progress/ExternalSessionOperationAccessibilityStatus';

const registry = createDefaultVoiceProviderRegistry();

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
  group: PluginProjectionEditableSettingsGroup;
  field: PluginProjectionEditableSettingField;
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

function localizedText(value: string | Readonly<{ key: string; fallback: string }>): string {
  if (typeof value === 'string') return value;
  const translated = tLoose(value.key);
  return translated === value.key ? value.fallback : translated;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  if (input.accountCredentialApprovalRequired
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

export function VoiceProviderSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  happierVoiceSupported: boolean;
  platformOs?: string;
  localAvailability?: ResolveVoiceProviderAvailabilityInput['local'];
  executionMachineId?: string | null;
  executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
  popoverBoundaryRef?: React.RefObject<any> | null;
  showProcessingDisclosure?: boolean;
  onRecoveryAction?: (action: VoiceRoleReadiness['recoveryAction']) => void;
}) {
  React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  const { theme } = useUnistyles();
  const accountSettings = useSettings();
  const accountProfile = useProfile();
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const voiceAgentEnabled = useFeatureEnabled('voice.agent');
  const [checkedReadiness, setCheckedReadiness] = React.useState<Readonly<{
    providerId: string;
  }> | null>(null);
  const select = (next: VoiceSettings) => {
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
  const localConversationReadinessFacts = projectLocalConversationReadinessFacts({
    registry,
    voice,
    voiceSettingsV1: accountSettings.voiceSettingsV1,
    secrets: accountSettings.secrets,
    platform,
    local: availability.local,
    localInput: props.localAvailability,
    executionMachineId: props.executionMachineId,
    executionMachineSelectionKind: props.executionMachineSelectionKind,
    voiceAgentEnabled,
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
        })
      : null;
    const accountCredentialReference = accountCredentialStatus?.status === 'ready'
      ? accountCredentialStatus.reference
      : null;
    const accountCredentialApprovalRequired = accountCredentialStatus?.status === 'review_required';
    const credentialDeclaration = row.entry.kind === 'voice.conversation-provider.v1'
      && row.entry.declaration?.kind === 'conversation'
      ? row.entry.declaration.credentials ?? null
      : null;
    let sourceSelection: Readonly<{
      kind: 'none' | 'savedSecret' | 'connectedAccount';
      connectedAccountEligibility: VoiceConnectedAccountTargetEligibility;
    }> | null = null;
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
        sourceSelection = Object.freeze({
          kind: resolvedSource.selection.kind,
          connectedAccountEligibility: resolvedSource.selection.kind === 'connectedAccount'
            ? resolveVoiceConnectedAccountTargetEligibility({
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
              resolveAuthenticationMode: (candidate) => getConnectedAccountAuthenticationMode(
                candidate.ref.service,
                candidate.authenticationModeId,
              ),
            })
            : 'unusable',
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
      executionMachineId: props.executionMachineId ?? null,
      executionMachineOnline: executionMachineTarget.isOnline,
      runtimeCapabilityResult: null,
    });
    const selectedMachineReady = typeof props.executionMachineId === 'string'
      && props.executionMachineId.trim().length > 0
      && executionMachineTarget.isOnline;
    const credentialSourceKind: VoiceProviderCredentialSourceKind | null = sourceSelection?.kind ?? null;
    const readinessFacts = {
      settings: settingsProjection?.status ?? 'unknown',
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
        typeof row.entry.presentation?.createSettingsSection === 'function'
        || credentialDeclaration?.sources.some((source) => (
          source.kind === 'savedSecret' || source.kind === 'connectedAccount'
        )) === true
      );
    const selectable = isVoiceRoleSelectableForConfiguration({
      readiness,
      credentialConfigurationAvailable,
      passiveRuntimeCheckAvailable: declaredPassiveSetup !== null,
    });
    const readinessPresentation = resolveVoiceProviderReadinessPresentation(readiness, tLoose);
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
    const detail = accountCredentialApprovalRequired
      ? t('settingsVoice.externalCredentials.reviewRequired')
      : projectedCredentialGuidance ?? ([
        credentialDetail,
        readinessPresentation.reason,
        readinessPresentation.action,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ') || undefined);
    return {
      ...row,
      readiness,
      selectable,
      detail,
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
        facts: {
          settings: selectedUnavailableProvider.settingsProjection?.status ?? 'unknown',
        },
      })
    : null;
  const selectedUnavailablePresentation = selectedUnavailableReadiness
    ? resolveVoiceProviderReadinessPresentation(selectedUnavailableReadiness, tLoose)
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
    enabled: checkedReadiness?.providerId === voice.providerId
      && selectedPassiveSetup !== null
      && executionMachineTarget.isOnline,
    request: passiveCapabilityRequest,
  });
  const passiveCapabilitySnapshot = passiveCapability.state.status === 'loaded'
    ? passiveCapability.state.snapshot
    : null;
  const runtimeCapabilityResult = selectedPassiveSetup
    ? passiveCapabilitySnapshot?.response.results[selectedPassiveSetup.capabilityId] ?? null
    : null;
  const passiveSetupFacts = projectVoiceProviderPassiveSetupFacts({
    execution: selectedAgentRealtimeExecution,
    executionMachineId: props.executionMachineId ?? null,
    executionMachineOnline: executionMachineTarget.isOnline,
    runtimeCapabilityResult,
  });
  const selectedProviderConfig = selectedProviderRow
    ? readVoiceProviderSettingsConfig(voice, selectedProviderRow.providerId)
    : null;
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
  const selectedProviderReadinessPresentation = checkedProviderReadiness
    ? resolveVoiceProviderReadinessPresentation(checkedProviderReadiness, tLoose)
    : null;
  const selectedProviderReadinessDetail = selectedProviderRow?.projectedCredentialGuidance
    ?? (selectedProviderReadinessPresentation ? [
        selectedProviderReadinessPresentation.summary,
        selectedProviderReadinessPresentation.action,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ') || undefined
      : undefined);
  const showCheckedReadiness = checkedReadiness !== null
    && checkedReadiness.providerId === voice.providerId
    && checkedProviderReadiness !== null
    && passiveCapability.state.status !== 'loading';
  const visibleRows = selectedUnavailableProvider
    ? rows.filter((row) => row.providerId !== selectedUnavailableProvider.providerId)
    : rows;
  const isOff = voice.providerId === null;
  const selectedExternalRow = rows.find((row) => (
    row.providerId === voice.providerId
    && row.entry.kind === 'voice.conversation-provider.v1'
    && typeof row.entry.presentation?.createSettingsSection !== 'function'
    && projectVoiceProviderSettings(row.entry, voice.providers[row.providerId] ?? null)?.status === 'ready'
  ));
  const selectedExternalDeclaration = selectedExternalRow?.entry.kind === 'voice.conversation-provider.v1'
    && selectedExternalRow.entry.declaration?.kind === 'conversation'
    ? selectedExternalRow.entry.declaration
    : null;
  const selectedExternalCredentials = selectedExternalDeclaration?.credentials ?? null;
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
  const selectedExternalCredentialAccessIsRaw = voiceCredentialDeclarationHasRawGrants(
    selectedExternalDeclaration ?? undefined,
  );
  const selectedExternalCredentialSlot = selectedExternalRow?.entry.accountCredentialSlot;
  const selectedDeclarativeSettingsRow = rows.find((row) => (
    row.providerId === voice.providerId
    && row.entry.kind === 'voice.conversation-provider.v1'
    && row.entry.providerSettings
    && typeof row.entry.presentation?.createSettingsSection !== 'function'
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
  const declarativeSettingsGroup: PluginProjectionEditableSettingsGroup | null = selectedDeclarativeSettingsRow
    && selectedDeclarativeSettings
    && selectedDeclarativeSettingsSource
    ? {
      id: selectedDeclarativeSettingsRow.providerId,
      pluginId: selectedDeclarativeSettingsSource.pluginId,
      version: 1,
      title: tLoose(selectedDeclarativeSettingsRow.titleKey),
      scope: { kind: 'account' },
      presentation: { sections: [], subagentSections: [] },
      target: { kind: 'plugin' },
      fields: [],
    }
    : null;
  const writeExternalSetting = (fieldId: string, value: unknown): void => {
    if (!selectedDeclarativeSettingsRow || !isRecord(selectedDeclarativeConfig)) return;
    select(writeVoiceProviderSettingsConfig(voice, selectedDeclarativeSettingsRow.providerId, {
      ...selectedDeclarativeConfig,
      [fieldId]: value,
    }));
  };
  const showProcessingDisclosure = props.showProcessingDisclosure ?? true;
  const selectedDeclarativeDisclosureOnly = showProcessingDisclosure && selectedDeclarativeSettings?.privacyDisclosure
    && selectedDeclarativeSettings.fields.length === 0
    && !selectedDeclarativeSettings.connectedServicesBinding
    ? selectedDeclarativeSettings.privacyDisclosure
    : null;

  return (
    <>
      <ItemGroup
        title={t('settingsVoice.modeTitle')}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('settingsVoice.modeTitle')}
      >
      <Item
        testID="settings.voice.provider.off"
        title={t('settingsVoice.mode.off')}
        subtitle={t('settingsVoice.mode.offSubtitle')}
        accessibilityRole="radio"
        webRole="radio"
        selected={isOff}
        rightElement={isOff ? <Icon name="check-circle" size={24} color={theme.colors.accent.blue} /> : null}
        onPress={() => select({ ...voice, providerId: null })}
        showChevron={false}
      />

      {selectedUnavailableProvider ? (
        <Item
          testID="settings.voice.provider.selectedUnavailable"
          title={tLoose(selectedUnavailableProvider.titleKey)}
          subtitle={selectedUnavailableProvider.subtitleKey
            ? tLoose(selectedUnavailableProvider.subtitleKey)
            : undefined}
          detail={selectedUnavailableDetail}
          accessibilityRole="radio"
          webRole="radio"
          selected={true}
          rightElement={<Icon name="check-circle" size={24} color={theme.colors.accent.blue} />}
          disabled={true}
          showChevron={false}
        />
      ) : null}

      {visibleRows.map((row) => (
        <Item
          key={`${row.providerId}:${row.optionId}`}
          testID={`settings.voice.provider.${encodeURIComponent(row.providerId)}.${encodeURIComponent(row.optionId)}`}
          title={tLoose(row.titleKey)}
          subtitle={tLoose(row.subtitleKey)}
          detail={row.detail}
          accessibilityRole="radio"
          webRole="radio"
          selected={row.selected}
          rightElement={row.selected
            ? <Icon name="check-circle" size={24} color={theme.colors.accent.blue} />
            : null}
          disabled={!row.selectable}
          onPress={row.selectable
            ? () => {
              const next = selectVoiceProviderOption(voice, registry, row.providerId, row.optionId);
              if (next) select(next);
            }
            : undefined}
          showChevron={false}
        />
      ))}
      </ItemGroup>
      {voice.providerId && selectedProviderReadiness ? (
        <ItemGroup
          title={t('settingsVoice.setupCheck.title')}
          footer={t('settingsVoice.setupCheck.footer')}
        >
          <Item
            testID="settings.voice.provider.checkSetup"
            title={t('settingsVoice.setupCheck.check')}
            subtitle={t('settingsVoice.setupCheck.checkSubtitle')}
            accessibilityRole="button"
            onPress={() => {
              setCheckedReadiness({ providerId: voice.providerId! });
              if (selectedPassiveSetup && executionMachineTarget.isOnline) {
                passiveCapability.refresh({
                  request: passiveCapabilityRequest,
                  bypassCache: true,
                });
              }
            }}
          />
          {showCheckedReadiness ? (
            <>
              <Item
                testID="settings.voice.provider.readiness"
                mode="info"
                title={t('settingsVoice.setupCheck.result')}
                subtitle={selectedProviderReadinessDetail}
                accessibilityRole={selectedProviderReadiness.recoveryAction === 'none' ? undefined : 'button'}
                onPress={selectedProviderReadiness.recoveryAction === 'none'
                  ? undefined
                  : () => props.onRecoveryAction?.(selectedProviderReadiness.recoveryAction)}
              />
              <ExternalSessionOperationAccessibilityStatus
                announcement={selectedProviderReadinessDetail ?? t('settingsVoice.setupCheck.result')}
                statusTestID="settings.voice.provider.readiness-status"
                transitionKey={`${checkedReadiness?.providerId ?? ''}:${selectedProviderReadinessDetail ?? ''}`}
              />
            </>
          ) : null}
        </ItemGroup>
      ) : null}
      {!selectedExternalRow
        || !selectedExternalDeclaration
        || !selectedExternalCredentials
        || !selectedExternalContribution
        || (!selectedExternalHasSavedSecret && !selectedExternalHasConnectedAccount) ? null : (
        <ItemGroup
          title={tLoose(selectedExternalRow.titleKey)}
          footer={t(
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
            recipientContract={selectedExternalCredentialSlot?.id === selectedExternalCredentials.slot.id
              ? selectedExternalCredentialSlot.recipientContract
              : null}
            recipientContractDigest={selectedExternalCredentialSlot?.id === selectedExternalCredentials.slot.id
              ? selectedExternalCredentialSlot.recipientContractDigest
              : null}
            disclosePlainStorage={true}
          />}
          {selectedExternalHasSavedSecret || !selectedExternalCredentialAccessIsRaw ? null : (
            <VoiceRawCredentialAccessReview
              contribution={selectedExternalContribution}
              testID={`settings.voice.externalCredential.${encodeURIComponent(selectedExternalRow.providerId)}.rawAccess`}
            />
          )}
        </ItemGroup>
      )}
      {!selectedDeclarativeSettings
        || !selectedDeclarativeSettingsSource
        || !declarativeSettingsGroup
        || !isRecord(selectedDeclarativeConfig)
        || (selectedDeclarativeSettings.fields.length === 0
          && !selectedDeclarativeSettings.connectedServicesBinding
          && !(showProcessingDisclosure && selectedDeclarativeSettings.privacyDisclosure))
        ? null
        : (
          <ItemGroup
            title={tLoose(selectedDeclarativeSettingsRow.titleKey)}
            footer={showProcessingDisclosure && !selectedDeclarativeDisclosureOnly && selectedDeclarativeSettings.privacyDisclosure
              ? localizedText(selectedDeclarativeSettings.privacyDisclosure)
              : undefined}
          >
            {selectedDeclarativeDisclosureOnly ? (
              <Item
                testID={`settings.voice.provider.disclosure.${encodeURIComponent(selectedDeclarativeSettingsRow.providerId)}`}
                mode="info"
                title={t('settingsVoice.realtimeProviders.links.privacy.title')}
                subtitle={localizedText(selectedDeclarativeDisclosureOnly)}
                showChevron={false}
              />
            ) : null}
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
                  title={localizedText(selectedDeclarativeSettings.connectedServicesBinding.title)}
                  subtitle={selectedDeclarativeSettings.connectedServicesBinding.description
                    ? localizedText(selectedDeclarativeSettings.connectedServicesBinding.description)
                    : undefined}
                  value={selectedDeclarativeConfig[selectedDeclarativeSettings.connectedServicesBinding.id]}
                  onChange={(value) => writeExternalSetting(
                    selectedDeclarativeSettings.connectedServicesBinding!.id,
                    value,
                  )}
                />
              )
              : null}
            {selectedDeclarativeSettings.fields.map((field) => {
              const control = field.presentation?.control;
              if (!control || field.presentation?.hidden === true) return null;
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
              const projectedField: PluginProjectionEditableSettingField = {
                key: field.id,
                control,
                valueType,
                valueSchema: field.schema,
                title: localizedText(field.title),
                subtitle: field.description ? localizedText(field.description) : null,
                secretCustody: null,
                redaction: 'none',
                clearWhenEmpty: 'persist',
                defaultValue: field.default,
                ...(control === 'switch' && typeof field.default === 'boolean'
                  ? { defaultBooleanValue: field.default }
                  : {}),
                ...(field.presentation ? { presentation: field.presentation } : {}),
              };
              if (control === 'select') return (
                <PluginSettingSelectField
                  key={field.id}
                  pluginId={selectedDeclarativeSettingsSource.pluginId}
                  group={declarativeSettingsGroup}
                  field={projectedField}
                  value={selectedDeclarativeConfig[field.id]}
                  disabled={false}
                  popoverBoundaryRef={props.popoverBoundaryRef}
                  onChangeValue={(value) => writeExternalSetting(field.id, value)}
                />
              );
              if (control === 'switch') return (
                <PluginSettingSwitchField
                  key={field.id}
                  pluginId={selectedDeclarativeSettingsSource.pluginId}
                  group={declarativeSettingsGroup}
                  field={projectedField}
                  value={selectedDeclarativeConfig[field.id] === true}
                  disabled={false}
                  onChangeValue={(_field, value) => writeExternalSetting(field.id, value)}
                />
              );
              return (
                <VoiceDeclarativeTextSettingField
                  key={field.id}
                  pluginId={selectedDeclarativeSettingsSource.pluginId}
                  group={declarativeSettingsGroup}
                  field={projectedField}
                  value={selectedDeclarativeConfig[field.id]}
                  onChangeValue={(value) => writeExternalSetting(field.id, value)}
                />
              );
            })}
          </ItemGroup>
        )}
    </>
  );
}
