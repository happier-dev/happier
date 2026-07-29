import * as React from 'react';
import { Platform } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  PluginSettingSelectField,
  PluginSettingSwitchField,
} from '@/components/settings/plugins/detail/PluginSettingChoiceFields';
import type {
  PluginProjectionEditableSettingField,
  PluginProjectionEditableSettingsGroup,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { useSettings } from '@/sync/domains/state/storage';
import { useProfile } from '@/sync/store/hooks';
import {
  readVoiceProviderSettingsConfig,
  voiceSettingsParse,
  writeVoiceProviderSettingsConfig,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import {
  isAccountVoiceCredentialRecipientApprovalRequired,
  resolveAccountVoiceCredential,
} from '@/voice/credentials/accountVoiceCredential';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import {
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
  resolveVoiceRoleReadiness,
  type VoiceCredentialReadinessFact,
  type VoiceReadinessFact,
} from '@/voice/registry/readiness';
import {
  resolveVoiceProviderAvailability,
  type ResolveVoiceProviderAvailabilityInput,
} from '@/voice/settings/resolveVoiceProviderAvailability';
import { projectLocalConversationReadinessFacts } from '@/voice/settings/projectLocalConversationReadinessFacts';
import { VoiceGlobalConnectedServicesBindingField } from './realtime/VoiceGlobalConnectedServicesBindingField';
import { resolveVoiceProviderReadinessPresentation } from './voiceProviderReadinessPresentation';

const registry = createDefaultVoiceProviderRegistry();

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

export function resolveVoiceProviderCredentialFact(input: Readonly<{
  sourceKind: 'built_in' | 'bundled' | 'external';
  projectedCredential: Pick<VoiceProviderCredentialReadinessProjection, 'status'> | null;
  hasAccountCredentialSlot: boolean;
  hasAccountCredentialReference: boolean;
  accountCredentialApprovalRequired?: boolean;
}>): VoiceCredentialReadinessFact {
  const usesExternalAccountCredentialFallback = input.sourceKind === 'external'
    && input.hasAccountCredentialSlot
    && (!input.projectedCredential || input.projectedCredential.status === 'unknown');
  if (input.accountCredentialApprovalRequired
    && (input.projectedCredential?.status === 'missing' || usesExternalAccountCredentialFallback)) {
    return 'approval_required';
  }
  if (input.projectedCredential && input.projectedCredential.status !== 'unknown') {
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
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  const { theme } = useUnistyles();
  const accountSettings = useSettings();
  const accountProfile = useProfile();
  const [checkedReadiness, setCheckedReadiness] = React.useState<Readonly<{
    code: string;
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
  const localExecutionMachineFact: VoiceReadinessFact = props.executionMachineId != null ? 'ready' : 'missing';
  const platform = normalizePlatform(props.platformOs ?? Platform.OS);
  const localConversationReadinessFacts = projectLocalConversationReadinessFacts({
    voice,
    platform,
    local: availability.local,
    localInput: props.localAvailability,
    executionMachineId: props.executionMachineId,
  });
  const rows = projectVoiceProviderSelectionRows(voice, registry).map((row) => {
    const settingsProjection = projectVoiceProviderSettings(row.entry, row.envelope);
    const accountCredentialReference = row.entry.accountCredentialSlot
      ? resolveAccountVoiceCredential(
        { ...accountSettings, voice },
        row.providerId,
        row.entry.accountCredentialSlot.id,
        undefined,
        row.entry.accountCredentialSlot.recipientContractDigest,
      )
      : null;
    const accountCredentialApprovalRequired = row.entry.accountCredentialSlot
      ? isAccountVoiceCredentialRecipientApprovalRequired({
          settings: { ...accountSettings, voice },
          providerId: row.providerId,
          credentialSlotId: row.entry.accountCredentialSlot.id,
          requiredRecipientContractDigest: row.entry.accountCredentialSlot.recipientContractDigest,
        })
      : false;
    const projectedCredential = projectVoiceProviderCredentialReadiness(
      row.entry,
      row.envelope,
      {
        accountProfile,
        savedSecret: {
          status: accountCredentialReference ? 'ready' : 'missing',
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
    const readiness = resolveVoiceRoleReadiness({
      registry,
      role: row.entry.roles[0]!,
      providerId: row.providerId,
      platform,
      modeId: row.modeId,
      facts: {
        settings: settingsProjection?.status ?? 'unknown',
        serverFeature: props.happierVoiceSupported ? 'ready' : 'missing',
        executionMachine:
          row.providerId === 'local_conversation'
            ? localExecutionMachineFact
            : 'missing',
        credential: credentialFact,
        endpoint: localConversationReadinessFacts.endpoint,
        runtime: localConversationReadinessFacts.runtime,
        model: localConversationReadinessFacts.model,
      },
    });
    const selectable = isVoiceRoleSelectableForConfiguration({
      readiness,
      credentialConfigurationAvailable: row.entry.source.kind === 'bundled'
        && row.entry.kind === 'voice.conversation-provider.v1'
        && typeof row.entry.internal?.createSettingsSection === 'function',
    });
    const readinessPresentation = resolveVoiceProviderReadinessPresentation(readiness, tLoose);
    const projectedCredentialGuidance = row.entry.source.kind === 'bundled'
      && row.entry.requirements.includes('credential')
      && projectedCredential?.status === 'unknown'
      ? tLoose(projectedCredential.detailKey)
      : null;
    const credentialDetail = row.entry.source.kind === 'external'
      && row.entry.requirements.includes('credential')
      ? projectedCredential && projectedCredential.status !== 'unknown'
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
  const selectedProviderReadiness = selectedProviderRow?.readiness
    ?? selectedUnavailableReadiness;
  const selectedProviderReadinessPresentation = selectedProviderReadiness
    ? resolveVoiceProviderReadinessPresentation(selectedProviderReadiness, tLoose)
    : null;
  const selectedProviderReadinessDetail = selectedProviderRow?.projectedCredentialGuidance
    ?? (selectedProviderReadinessPresentation ? [
        selectedProviderReadinessPresentation.summary,
        selectedProviderReadinessPresentation.action,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ') || undefined
      : undefined);
  const showCheckedReadiness = checkedReadiness !== null
    && checkedReadiness.providerId === voice.providerId
    && checkedReadiness.code === selectedProviderReadiness?.code;
  const visibleRows = selectedUnavailableProvider
    ? rows.filter((row) => row.providerId !== selectedUnavailableProvider.providerId)
    : rows;
  const isOff = voice.providerId === null;
  const selectedExternalRow = rows.find((row) => (
    row.providerId === voice.providerId
    && row.entry.source.kind === 'external'
    && projectVoiceProviderSettings(row.entry, voice.providers[row.providerId] ?? null)?.status === 'ready'
  ));
  const selectedDeclarativeSettingsRow = rows.find((row) => (
    row.providerId === voice.providerId
    && row.entry.providerSettings
    && row.entry.source.kind !== 'built_in'
    && projectVoiceProviderSettings(row.entry, voice.providers[row.providerId] ?? null)?.status === 'ready'
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
      storageScope: 'synced',
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
  const selectedDeclarativeDisclosureOnly = selectedDeclarativeSettings?.privacyDisclosure
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
        rightElement={isOff ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} /> : null}
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
          rightElement={<Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} />}
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
            ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} />
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
            onPress={() => setCheckedReadiness({
              providerId: voice.providerId!,
              code: selectedProviderReadiness.code,
            })}
          />
          {showCheckedReadiness ? (
            <Item
              testID="settings.voice.provider.readiness"
              mode="info"
              title={t('settingsVoice.setupCheck.result')}
              subtitle={selectedProviderReadinessDetail}
            />
          ) : null}
        </ItemGroup>
      ) : null}
      {!selectedExternalRow?.entry.accountCredentialSlot
        || (selectedExternalRow.projectedCredential
          && selectedExternalRow.projectedCredential.status !== 'unknown') ? null : (
        <ItemGroup
          title={tLoose(selectedExternalRow.titleKey)}
          footer={t('settingsVoice.externalCredentials.footer')}
        >
          <VoiceCredentialItem
            testID={`settings.voice.externalCredential.${encodeURIComponent(selectedExternalRow.providerId)}.${encodeURIComponent(selectedExternalRow.entry.accountCredentialSlot.id)}`}
            title={t('settingsVoice.externalCredentials.apiKeyTitle')}
            promptTitle={t('settingsVoice.externalCredentials.promptTitle')}
            promptDescription={t('settingsVoice.externalCredentials.promptDescription')}
            providerId={selectedExternalRow.providerId}
            credentialSlotId={selectedExternalRow.entry.accountCredentialSlot.id}
            recipientContract={selectedExternalRow.entry.accountCredentialSlot.recipientContract}
            recipientContractDigest={selectedExternalRow.entry.accountCredentialSlot.recipientContractDigest}
            disclosePlainStorage={true}
          />
        </ItemGroup>
      )}
      {!selectedDeclarativeSettings
        || !selectedDeclarativeSettingsSource
        || !declarativeSettingsGroup
        || !isRecord(selectedDeclarativeConfig)
        || (selectedDeclarativeSettings.fields.length === 0
          && !selectedDeclarativeSettings.connectedServicesBinding
          && !selectedDeclarativeSettings.privacyDisclosure)
        ? null
        : (
          <ItemGroup
            title={tLoose(selectedDeclarativeSettingsRow.titleKey)}
            footer={!selectedDeclarativeDisclosureOnly && selectedDeclarativeSettings.privacyDisclosure
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
              if (control !== 'select' && control !== 'switch') return null;
              const projectedField: PluginProjectionEditableSettingField = {
                key: field.id,
                control,
                valueType: control === 'switch' ? 'boolean' : 'string',
                valueSchema: field.schema,
                title: localizedText(field.title),
                subtitle: field.description ? localizedText(field.description) : null,
                redaction: 'none',
                clearWhenEmpty: 'persist',
                defaultValue: field.default,
                ...(control === 'switch' && typeof field.default === 'boolean'
                  ? { defaultBooleanValue: field.default }
                  : {}),
                ...(field.presentation ? { presentation: field.presentation } : {}),
              };
              return control === 'select' ? (
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
              ) : (
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
            })}
          </ItemGroup>
        )}
    </>
  );
}
