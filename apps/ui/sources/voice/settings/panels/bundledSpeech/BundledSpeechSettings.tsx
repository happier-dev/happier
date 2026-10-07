import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveVoiceSpeechSettingsCorrespondence } from '@happier-dev/protocol/plugins/contributions/voice';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { Text, TextInput } from '@/components/ui/text/Text';
import { LANGUAGES, getLanguageDisplayName } from '@/constants/Languages';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { bundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { VoiceRawCredentialAccessReview } from '@/voice/credentials/VoiceRawCredentialAccessReview';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import {
  resolveSelectedVoiceCredentialRawGrants,
  shouldUseVoiceCredentialSourceMutationForSavedSecret,
} from '@/voice/credentials/accountVoiceCredential';
import {
  readVoiceProviderSettingsConfig,
  writeVoiceProviderSettingsConfig,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import type { LocalSttProviderSettingsProps, LocalSttProviderSpec } from '../localStt/providers/_types';
import type {
  LocalTtsProviderSettingsProps,
  LocalTtsProviderSpec,
  LocalTtsProviderTestContext,
} from '../localTts/providers/_types';
import { Icon } from '@/components/ui/icons/Icon';
import {
  readBundledSpeechSettingsDescriptorFromEntry,
  type BundledSpeechSettingsEntry,
  type BundledSpeechSettingsDescriptor as SettingsDescriptor,
} from './descriptor';
import {
  VoiceCredentialSourceField,
  type VoiceCredentialSourceFieldStatus,
} from '../realtime/VoiceCredentialSourceField';
import { VoiceProviderSettingsActions } from '../realtime/VoiceProviderSettingsActions';
import type { VoiceRemoteCatalogState } from '@/voice/settings/remoteCatalogState';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceContributedSettingRefs } from '@/voice/settings/useVoiceContributedSettingRefs';
import {
  getExternalVoiceProviderRegistration,
  getExternalVoiceProviderProjectionAuthority,
} from '@/voice/registry/externalVoiceProviderRegistrations';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const translateDescriptorKey = t as unknown as (key: string) => string;

type BundledSpeechCatalogRow = Readonly<{
  id: string;
  name: string;
  metadata: Readonly<Record<string, unknown>>;
}>;
type BundledSpeechCatalogs = Record<string, VoiceRemoteCatalogState<BundledSpeechCatalogRow>>;

const stylesheet = StyleSheet.create((theme) => ({
  editableField: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  editableFieldLabel: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    marginBottom: 4,
  },
  editableFieldDescription: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    marginBottom: 8,
  },
  editableFieldInput: {
    ...Typography.default(),
    minHeight: 88,
    borderRadius: 10,
    borderCurve: 'continuous',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  editableFieldActions: {
    alignItems: 'flex-end',
    marginTop: 8,
  },
}));

function serializeEditableFieldValue(
  field: Extract<SettingsDescriptor['fields'][number], Readonly<{ kind: 'textarea' | 'json' }>>,
  value: unknown,
): string {
  if (field.kind === 'textarea') return typeof value === 'string' ? value : '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

function BundledSpeechEditableField(props: Readonly<{
  descriptor: SettingsDescriptor;
  field: Extract<SettingsDescriptor['fields'][number], Readonly<{ kind: 'textarea' | 'json' }>>;
  config: Record<string, unknown>;
  onCommit: (nextConfig: Record<string, unknown>) => void;
}>) {
  const { theme } = useUnistyles();
  const canonicalDraft = serializeEditableFieldValue(props.field, props.config[props.field.key]);
  const [draft, setDraft] = React.useState(canonicalDraft);
  React.useEffect(() => setDraft(canonicalDraft), [canonicalDraft]);
  const commit = () => {
    let value: unknown;
    if (props.field.kind === 'textarea') {
      if (draft.length < props.field.minLength || draft.length > props.field.maxLength) {
        Modal.alert(t('common.error'));
        return;
      }
      value = draft;
    } else {
      try {
        value = JSON.parse(draft) as unknown;
      } catch {
        Modal.alert(t('common.error'));
        return;
      }
    }
    const parsed = props.descriptor.parseConfig({ ...props.config, [props.field.key]: value });
    if (!parsed) {
      Modal.alert(t('common.error'));
      return;
    }
    props.onCommit(parsed);
  };
  return (
    <View style={stylesheet.editableField}>
      <Text style={stylesheet.editableFieldLabel}>
        {translateDescriptorKey(props.field.titleKey)}
      </Text>
      <Text style={stylesheet.editableFieldDescription}>
        {translateDescriptorKey(props.field.subtitleKey)}
      </Text>
      <TextInput
        testID={`voice-speech-setting:${props.field.key}.input`}
        accessibilityLabel={translateDescriptorKey(props.field.titleKey)}
        value={draft}
        onChangeText={setDraft}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.colors.input.placeholder}
        style={[
          stylesheet.editableFieldInput,
          {
            color: theme.colors.input.text,
            backgroundColor: theme.colors.input.background,
            borderColor: theme.colors.border.default,
          },
        ]}
      />
      <View style={stylesheet.editableFieldActions}>
        <RoundButton
          testID={`voice-speech-setting:${props.field.key}.save`}
          size="normal"
          title={t('common.save')}
          accessibilityLabel={`${t('common.save')}: ${translateDescriptorKey(props.field.titleKey)}`}
          disabled={draft === canonicalDraft}
          onPress={commit}
        />
      </View>
    </View>
  );
}

function BundledSpeechSettings(props: Readonly<{
  entry: BundledSpeechSettingsEntry;
  descriptor: SettingsDescriptor;
  voice: VoiceSettings;
  onVoiceChange: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<unknown> | null;
}>) {
  const { theme } = useUnistyles();
  const settingRef = useVoiceContributedSettingRefs(props.descriptor.providerId);
  const machine = useVoiceExecutionMachinePresentation();
  const endpointScope = useAccountSettingsScope();
  const endpointSettingsRef = React.useRef({ ...props, scope: endpointScope });
  endpointSettingsRef.current = { ...props, scope: endpointScope };
  const endpointMountedRef = React.useRef(true);
  React.useEffect(() => {
    endpointMountedRef.current = true;
    return () => { endpointMountedRef.current = false; };
  }, []);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  /** The remote select whose own value is being typed inline beneath its menu. */
  const [customKey, setCustomKey] = React.useState<string | null>(null);
  const [catalogRefreshRevision, setCatalogRefreshRevision] = React.useState(0);
  const catalogTargetKey = `${machine.machineId ?? ''}:${catalogRefreshRevision}`;
  const [catalogState, setCatalogState] = React.useState<Readonly<{
    targetKey: string;
    catalogs: BundledSpeechCatalogs;
  }> | null>(null);
  const catalogs = catalogState?.targetKey === catalogTargetKey ? catalogState.catalogs : {};
  const canonicalConfig = readVoiceProviderSettingsConfig(props.voice, props.descriptor.providerId);
  const hasCanonicalConfig = canonicalConfig !== null;
  const config = canonicalConfig ?? {};
  const persistCanonicalConfig = React.useCallback((nextConfig: Record<string, unknown>) => {
    if (!hasCanonicalConfig) return;
    props.onVoiceChange(writeVoiceProviderSettingsConfig(
      props.voice,
      props.descriptor.providerId,
      nextConfig,
    ));
  }, [hasCanonicalConfig, props.descriptor.providerId, props.onVoiceChange, props.voice]);
  const writeConfig = (nextConfig: Record<string, unknown>) => {
    persistCanonicalConfig(nextConfig);
  };
  const setValue = (key: string, value: unknown) => writeConfig({ ...config, [key]: value });
  const credentialIdentityRef = React.useRef<string | null | undefined>(undefined);
  const [credentialSourceStatus, setCredentialSourceStatus] = React.useState<
    VoiceCredentialSourceFieldStatus | null
  >(null);
  const speechDeclaration = props.entry.kind === 'voice.speech-engine.v1'
    && props.entry.declaration?.kind === 'speech'
    ? props.entry.declaration
    : null;
  const credentialDeclaration = speechDeclaration?.credentials ?? null;
  const credentialHasSavedSecret = credentialDeclaration?.sources.some(
    (source) => source.kind === 'savedSecret',
  ) === true;
  const credentialSourceVisible = credentialDeclaration?.sources.some(
    (source) => source.kind === 'connectedAccount',
  ) === true;
  const selectedCredentialSource = credentialSourceVisible
    ? credentialSourceStatus?.selection ?? null
    : credentialHasSavedSecret
      ? ({ kind: 'savedSecret' } as const)
      : null;
  const selectedRawSpeechGrants = speechDeclaration
    && selectedCredentialSource
    ? resolveSelectedVoiceCredentialRawGrants({
        declaration: speechDeclaration,
        contribution: props.descriptor.contribution,
        selection: selectedCredentialSource,
        access: { realm: 'daemon', phase: 'speech' },
      })
    : [];
  const selectedSavedSecretRawSpeechGrants = selectedCredentialSource?.kind === 'savedSecret'
    ? selectedRawSpeechGrants
    : [];
  const selectedConnectedAccountRawSpeechGrants = selectedCredentialSource?.kind === 'connectedAccount'
    ? selectedRawSpeechGrants
    : [];
  const onCredentialStatusChanged = React.useCallback((status: Readonly<{
    exists: boolean;
    credentialIdentity: string | null;
  }> | null) => {
    const nextIdentity = status?.credentialIdentity ?? null;
    const previousIdentity = credentialIdentityRef.current;
    credentialIdentityRef.current = nextIdentity;
    if (previousIdentity !== undefined && previousIdentity !== nextIdentity) {
      setCatalogRefreshRevision((current) => current + 1);
    }
  }, []);

  React.useEffect(() => {
    setCatalogState({
      targetKey: catalogTargetKey,
      catalogs: Object.fromEntries(props.descriptor.fields.flatMap((field) => (
        field.kind === 'remote_select' ? [[field.key, { phase: 'loading' as const }]] : []
      ))),
    });
    if (!hasCanonicalConfig) return;
    const controller = new AbortController();
    for (const field of props.descriptor.fields) {
      if (field.kind !== 'remote_select') continue;
      void bundledSpeechDaemonClient.fetchCatalog(props.entry, field.catalog, controller.signal).then((rows) => {
        if (controller.signal.aborted) return;
        setCatalogState((current) => ({
          targetKey: catalogTargetKey,
          catalogs: {
            ...(current?.targetKey === catalogTargetKey ? current.catalogs : {}),
            [field.key]: { phase: 'ready', rows },
          },
        }));
      }).catch(() => {
        if (controller.signal.aborted) return;
        setCatalogState((current) => ({
          targetKey: catalogTargetKey,
          catalogs: {
            ...(current?.targetKey === catalogTargetKey ? current.catalogs : {}),
            [field.key]: { phase: 'error' },
          },
        }));
      });
    }
    return () => controller.abort();
  }, [catalogTargetKey, hasCanonicalConfig, props.descriptor.fields, props.entry]);

  return (
    <>
      {!credentialSourceVisible || !credentialDeclaration || !speechDeclaration ? null : <VoiceCredentialSourceField
        contribution={props.descriptor.contribution}
        declaration={speechDeclaration}
        credentials={credentialDeclaration}
        popoverBoundaryRef={props.popoverBoundaryRef}
        onStatusChanged={setCredentialSourceStatus}
      />}
      {props.descriptor.credential && credentialHasSavedSecret ? <VoiceCredentialItem
        title={translateDescriptorKey(props.descriptor.credential.titleKey)}
        promptTitle={translateDescriptorKey(props.descriptor.credential.promptTitleKey)}
        promptDescription={translateDescriptorKey(props.descriptor.credential.promptBodyKey)}
        contribution={props.descriptor.contribution}
        credentialSlotId={props.descriptor.credential.slotId}
        credentialSourcePurpose={shouldUseVoiceCredentialSourceMutationForSavedSecret(
          credentialSourceVisible ? credentialSourceStatus?.selection : null,
        )
          ? props.descriptor.credential.purpose
          : undefined}
        credentialSourceDeclaration={props.entry.kind === 'voice.speech-engine.v1'
          ? props.entry.declaration
          : undefined}
        recipientContract={props.entry.accountCredentialSlot?.recipientContract ?? null}
        recipientContractDigest={props.entry.accountCredentialSlot?.recipientContractDigest ?? null}
        machineId={machine.machineId}
        machineLabel={machine.machineLabel}
        disclosePlainStorage={true}
        rawCredentialReviewGrants={selectedSavedSecretRawSpeechGrants}
        onStatusChanged={onCredentialStatusChanged}
        onChanged={() => setCatalogRefreshRevision((current) => current + 1)}
      /> : null}
      {selectedConnectedAccountRawSpeechGrants.map((rawGrant, index) => (
        <VoiceRawCredentialAccessReview
          key={JSON.stringify(rawGrant)}
          contribution={props.descriptor.contribution}
          rawGrant={rawGrant}
          testID={`settings.voice.speechCredential.${encodeURIComponent(props.descriptor.providerId)}.rawAccess${index === 0 ? '' : `.${index}`}`}
        />
      ))}
      {props.descriptor.fields.map((field) => {
        const rendered = (() => {
        const value = config[field.key];
        if (field.kind === 'text') {
          const saved = typeof value === 'string' ? value : '';
          return (
            <React.Fragment key={field.key}>
              <FieldValueItem
                testID={`voice-speech-setting:${field.key}`}
                fieldTestID={`voice-speech-setting:${field.key}.field`}
                title={translateDescriptorKey(field.titleKey)}
                subtitle={translateDescriptorKey(field.subtitleKey)}
                placeholder={t('common.none')}
                autoCapitalize="none"
                value={saved}
                onCommit={(draft) => {
                  const consent = props.descriptor.endpointConsent;
                  if (consent?.baseUrlFieldId === field.key) {
                    // The endpoint owner validates the URL and asks before an insecure origin; the field
                    // shows the saved endpoint until its patch lands.
                    const captured = endpointSettingsRef.current;
                    const registration = getExternalVoiceProviderRegistration(captured.entry.providerId);
                    const projection = getExternalVoiceProviderProjectionAuthority();
                    const occurrenceId = projection?.get(captured.entry.providerId);
                    const admitted = registration
                      ? (registration.descriptor === captured.entry
                        || (registration.descriptor === null && captured.entry.source.kind === 'bundled'))
                        && (projection === null || (!!occurrenceId && registration.occurrenceId === occurrenceId))
                      : captured.entry.source.kind === 'bundled' && projection === null;
                    fireAndForget((async () => {
                      const { storage } = await import('@/sync/domains/state/storage');
                      const { areAccountSettingsScopesEqual } = await import('@/sync/domains/settings/scope/accountSettingsScope');
                      const { prepareSpeechEndpointSettingChange } = await import('./prepareEndpointSettingChange');
                      const isCurrent = () => {
                        const currentProjection = getExternalVoiceProviderProjectionAuthority();
                        return admitted && endpointMountedRef.current
                          && endpointSettingsRef.current.entry === captured.entry
                          && endpointSettingsRef.current.descriptor === captured.descriptor
                          && getExternalVoiceProviderRegistration(captured.entry.providerId) === registration
                          && (currentProjection === null) === (projection === null)
                          && currentProjection?.get(captured.entry.providerId) === occurrenceId
                          && areAccountSettingsScopesEqual(captured.scope, storage.getState().settingsScope);
                      };
                      const intent = await prepareSpeechEndpointSettingChange({
                        entry: captured.entry, settings: storage.getState().settings, value: draft, isCurrent,
                      });
                      const delta = intent?.(storage.getState().settings);
                      if (delta?.voice) endpointSettingsRef.current.onVoiceChange(delta.voice);
                    })(), { tag: `BundledSpeechSettings.endpoint.${field.key}` });
                    return saved;
                  }
                  if (draft.length < field.minLength || draft.length > field.maxLength) {
                    Modal.alert(t('common.error'));
                    return saved;
                  }
                  setValue(field.key, draft);
                }}
              />
              <VoiceProviderSettingsActions
                providerId={props.descriptor.providerId}
                owner={props.descriptor}
                actions={props.descriptor.actions}
                config={config}
                placement={{ kind: 'afterField', fieldId: field.key }}
              />
            </React.Fragment>
          );
        }
        if (field.kind === 'number') {
          const saved = typeof value === 'number' ? String(value) : '';
          return (
            <React.Fragment key={field.key}>
              <FieldValueItem
                testID={`voice-speech-setting:${field.key}`}
                fieldTestID={`voice-speech-setting:${field.key}.field`}
                title={translateDescriptorKey(field.titleKey)}
                subtitle={translateDescriptorKey(field.subtitleKey)}
                placeholder={t('common.none')}
                kind="decimal"
                signed={!(typeof field.min === 'number' && field.min >= 0)}
                allowEmpty={field.nullable}
                value={saved}
                onCommit={(draft) => {
                  if (!draft) {
                    setValue(field.key, null);
                    return '';
                  }
                  const next = Number(draft);
                  if (!Number.isFinite(next) || next < (field.min ?? -Infinity) || next > (field.max ?? Infinity)) {
                    Modal.alert(t('common.error'), `${field.min}–${field.max}`);
                    return saved;
                  }
                  setValue(field.key, next);
                  return String(next);
                }}
              />
              <VoiceProviderSettingsActions
                providerId={props.descriptor.providerId}
                owner={props.descriptor}
                actions={props.descriptor.actions}
                config={config}
                placement={{ kind: 'afterField', fieldId: field.key }}
              />
            </React.Fragment>
          );
        }
        if (field.kind === 'textarea' || field.kind === 'json') {
          return (
            <React.Fragment key={field.key}>
              <BundledSpeechEditableField
                descriptor={props.descriptor}
                field={field}
                config={config}
                onCommit={writeConfig}
              />
              <VoiceProviderSettingsActions
                providerId={props.descriptor.providerId}
                owner={props.descriptor}
                actions={props.descriptor.actions}
                config={config}
                placement={{ kind: 'afterField', fieldId: field.key }}
              />
            </React.Fragment>
          );
        }
        if (field.kind === 'switch') {
          return (
            <React.Fragment key={field.key}>
              <Item
                title={translateDescriptorKey(field.titleKey)}
                subtitle={translateDescriptorKey(field.subtitleKey)}
                rightElement={(
                  <Switch
                    testID={`voice-speech-setting:${field.key}.switch`}
                    accessibilityLabel={translateDescriptorKey(field.titleKey)}
                    value={value === true}
                    onValueChange={(next) => setValue(field.key, next)}
                  />
                )}
                rightElementOutsidePressable
                showChevron={false}
                onPress={() => setValue(field.key, value !== true)}
              />
              <VoiceProviderSettingsActions
                providerId={props.descriptor.providerId}
                owner={props.descriptor}
                actions={props.descriptor.actions}
                config={config}
                placement={{ kind: 'afterField', fieldId: field.key }}
              />
            </React.Fragment>
          );
        }

        const rows = (() => {
          if (field.kind === 'language') {
            const autoTitleKey = field.autoTitleKey;
            const autoSubtitleKey = field.autoSubtitleKey;
            return LANGUAGES.map((language) => ({
              id: typeof language.code === 'string' ? language.code : '',
              title: typeof language.code === 'string'
                ? getLanguageDisplayName(language)
                : translateDescriptorKey(autoTitleKey),
              subtitle: typeof language.code === 'string'
                ? language.code
                : translateDescriptorKey(autoSubtitleKey),
            }));
          }
          if (field.kind === 'enum') {
            return field.options.map((option) => ({ ...option, subtitle: undefined }));
          }
          const catalog = catalogs[field.key];
          return (catalog?.phase === 'ready' ? catalog.rows : []).map((row) => ({
            id: row.id,
            title: row.name,
            subtitle: typeof row.metadata.description === 'string' ? row.metadata.description : row.id,
          }));
        })();
        const searchPlaceholder = field.kind === 'remote_select' && field.searchPlaceholderKey
          ? translateDescriptorKey(field.searchPlaceholderKey)
          : undefined;
        const automaticItems = field.kind === 'language'
          ? [{
            id: '',
            title: translateDescriptorKey(field.autoTitleKey),
            subtitle: translateDescriptorKey(field.autoSubtitleKey),
          }]
          : field.nullable
            ? [{ id: '', title: t('common.none'), subtitle: undefined }]
            : [];
        const allowCustom = field.kind === 'remote_select' && field.allowCustom;
        const remoteCatalog = field.kind === 'remote_select' ? catalogs[field.key] : null;
        const catalogStatusItems = field.kind !== 'remote_select'
          ? []
          : remoteCatalog?.phase === 'loading'
            ? [{ id: '__status__', title: t('common.loading'), subtitle: undefined, disabled: true }]
            : remoteCatalog?.phase === 'error'
              ? [{ id: '__retry__', title: t('settingsVoice.realtimeProviders.catalog.retry'), subtitle: undefined }]
              : remoteCatalog?.phase === 'ready' && remoteCatalog.rows.length === 0
                ? [{ id: '__status__', title: t('settingsVoice.realtimeProviders.catalog.empty'), subtitle: undefined, disabled: true }]
                : [];
        return (
          <React.Fragment key={field.key}>
            <DropdownMenu
            open={openKey === field.key}
            onOpenChange={(next) => setOpenKey(next ? field.key : null)}
            variant="selectable"
            search={field.kind === 'remote_select' || field.kind === 'language'}
            searchPlaceholder={searchPlaceholder}
            selectedId={typeof value === 'string' ? value : ''}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{ title: translateDescriptorKey(field.titleKey), subtitle: translateDescriptorKey(field.subtitleKey), showSelectedSubtitle: false }}
            items={[
              ...automaticItems,
              ...catalogStatusItems,
              ...rows.map((row) => ({
                ...row,
                icon: <Icon name={field.kind === 'language' ? 'translate' : 'sparkle'} size={20} color={theme.colors.text.secondary} />,
              })),
              ...(allowCustom ? [{ id: '__custom__', title: t('common.edit'), subtitle: undefined }] : []),
            ]}
            onSelect={(id) => {
              if (id === '__retry__') {
                setCatalogRefreshRevision((current) => current + 1);
              } else if (id === '__custom__') {
                setCustomKey(field.key);
              } else {
                setValue(field.key, id || null);
              }
              setOpenKey(null);
            }}
            />
            {customKey !== field.key ? null : (
              <FieldValueItem
                testID={`voice-speech-setting:${field.key}.custom`}
                fieldTestID={`voice-speech-setting:${field.key}.custom.field`}
                title={translateDescriptorKey(field.titleKey)}
                subtitle={translateDescriptorKey(field.subtitleKey)}
                autoCapitalize="none"
                autoFocus
                value={typeof value === 'string' ? value : ''}
                onCommit={(draft) => {
                  setCustomKey(null);
                  if (draft) setValue(field.key, draft);
                  else if (field.nullable) setValue(field.key, null);
                  else return typeof value === 'string' ? value : '';
                }}
              />
            )}
            <VoiceProviderSettingsActions
              providerId={props.descriptor.providerId}
              owner={props.descriptor}
              actions={props.descriptor.actions}
              config={config}
              placement={{ kind: 'afterField', fieldId: field.key }}
            />
          </React.Fragment>
        );
        })();
        const setting = settingRef(field.key);
        return setting ? <SettingAnchor key={field.key} setting={setting}>{rendered}</SettingAnchor> : rendered;
      })}
      <VoiceProviderSettingsActions
        providerId={props.descriptor.providerId}
        owner={props.descriptor}
        actions={props.descriptor.actions}
        config={config}
        placement={{ kind: 'contributionFooter' }}
      />
    </>
  );
}

export function createBundledLocalSttProviderSpec(
  entry: BundledSpeechSettingsEntry,
): LocalSttProviderSpec | null {
  const descriptor = readBundledSpeechSettingsDescriptorFromEntry(entry.providerId, entry);
  if (!descriptor || (descriptor.role !== 'stt' && descriptor.role !== 'both')) return null;
  const Settings = (props: LocalSttProviderSettingsProps) => (
    <BundledSpeechSettings
      entry={entry}
      descriptor={descriptor}
      voice={props.voice}
      onVoiceChange={props.setVoice}
      popoverBoundaryRef={props.popoverBoundaryRef}
    />
  );
  return Object.freeze({
    id: descriptor.providerId as LocalSttProviderSpec['id'],
    title: translateDescriptorKey(descriptor.titleKey),
    subtitle: translateDescriptorKey(descriptor.subtitleKey),
    detail: translateDescriptorKey(descriptor.detailKey),
    iconName: descriptor.iconName,
    Settings,
  });
}

export function createBundledLocalTtsProviderSpec(
  entry: BundledSpeechSettingsEntry,
): LocalTtsProviderSpec | null {
  const descriptor = readBundledSpeechSettingsDescriptorFromEntry(entry.providerId, entry);
  if (!descriptor || (descriptor.role !== 'tts' && descriptor.role !== 'both')) return null;
  const testDescriptor = descriptor.test;
  const Settings = (props: LocalTtsProviderSettingsProps) => (
    <BundledSpeechSettings
      entry={entry}
      descriptor={descriptor}
      voice={props.voice}
      onVoiceChange={props.setVoice}
      popoverBoundaryRef={props.popoverBoundaryRef}
    />
  );
  return Object.freeze({
    id: descriptor.providerId as LocalTtsProviderSpec['id'],
    title: translateDescriptorKey(descriptor.titleKey),
    subtitle: translateDescriptorKey(descriptor.subtitleKey),
    detail: translateDescriptorKey(descriptor.detailKey),
    iconName: descriptor.iconName,
    Settings,
    test: async ({ cfgTts, voice, sample }: LocalTtsProviderTestContext) => {
      if (!testDescriptor) {
        await Modal.alert(t('common.error'), t('common.unavailable'));
        return;
      }
      const config = readVoiceProviderSettingsConfig(voice, descriptor.providerId);
      if (!config) {
        await Modal.alert(t('common.error'), translateDescriptorKey(testDescriptor.missingValueMessageKey));
        return;
      }
      const missingValue = config[testDescriptor.missingFieldId];
      if (typeof missingValue !== 'string' || !missingValue.trim()) {
        await Modal.alert(t('common.error'), translateDescriptorKey(testDescriptor.missingValueMessageKey));
        return;
      }
      let requestSettings: ReturnType<typeof resolveVoiceSpeechSettingsCorrespondence>['synthesize'];
      const speechDeclaration = entry.kind === 'voice.speech-engine.v1'
        ? entry.declaration
        : null;
      try {
        requestSettings = speechDeclaration?.kind === 'speech'
          ? resolveVoiceSpeechSettingsCorrespondence({
              contribution: speechDeclaration,
              settings: config,
            }).synthesize
          : null;
      } catch {
        requestSettings = null;
      }
      if (!requestSettings) {
        await Modal.alert(t('common.error'), translateDescriptorKey(testDescriptor.missingValueMessageKey));
        return;
      }
      const result = await bundledSpeechDaemonClient.synthesize({
        entry,
        input: sample,
      });
      await playAudioBytesWithStopper({
        bytes: result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer,
        format: result.mimeType === 'audio/wav' ? 'wav' : 'mp3',
        registerPlaybackStopper: () => () => {},
      });
    },
  });
}
