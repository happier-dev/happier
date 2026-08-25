import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveVoiceSpeechSettingsCorrespondence } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
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
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { shouldUseVoiceCredentialSourceMutationForSavedSecret } from '@/voice/credentials/accountVoiceCredential';
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
import { promptSpeechEndpointChange } from './endpointConsent';
import {
  VoiceCredentialSourceField,
  type VoiceCredentialSourceFieldStatus,
} from '../realtime/VoiceCredentialSourceField';
import { VoiceProviderSettingsActions } from '../realtime/VoiceProviderSettingsActions';
import type { VoiceRemoteCatalogState } from '@/voice/settings/remoteCatalogState';

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
  const machine = useVoiceExecutionMachinePresentation();
  const [openKey, setOpenKey] = React.useState<string | null>(null);
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
        machineId={machine.machineId}
        machineLabel={machine.machineLabel}
        disclosePlainStorage={true}
        onStatusChanged={onCredentialStatusChanged}
        onChanged={() => setCatalogRefreshRevision((current) => current + 1)}
      /> : null}
      {props.descriptor.fields.map((field) => {
        const value = config[field.key];
        if (field.kind === 'text') {
          return (
            <React.Fragment key={field.key}>
              <Item
                title={translateDescriptorKey(field.titleKey)}
                subtitle={translateDescriptorKey(field.subtitleKey)}
                detail={typeof value === 'string' && value.length > 0 ? value : t('common.none')}
                onPress={() => fireAndForget((async () => {
                if (props.descriptor.endpointConsent?.baseUrlFieldId === field.key) {
                  const consent = props.descriptor.endpointConsent;
                  const patch = await promptSpeechEndpointChange({
                    currentBaseUrl: typeof value === 'string' ? value : '',
                    currentConsent: typeof config[consent.originConsentFieldId] === 'string'
                      ? config[consent.originConsentFieldId] as string : '',
                    currentConsentMachineId: typeof config[consent.machineConsentFieldId] === 'string'
                      ? config[consent.machineConsentFieldId] as string : '',
                    machineId: machine.machineId,
                    machineLabel: machine.machineLabel,
                    promptBaseUrl: async () => await Modal.prompt(
                      translateDescriptorKey(field.promptTitleKey ?? field.titleKey),
                      translateDescriptorKey(field.promptBodyKey ?? field.subtitleKey),
                      { placeholder: typeof value === 'string' ? value : '' },
                    ),
                    confirmInsecureOrigin: async ({ origin, machineLabel }) => await Modal.confirm(
                      t('settingsVoice.local.openAiCompatEndpoint.insecureTitle'),
                      t('settingsVoice.local.openAiCompatEndpoint.insecureBody', { origin, machine: machineLabel }),
                      { confirmText: t('settingsVoice.local.openAiCompatEndpoint.allowAction') },
                    ),
                    showInvalidEndpoint: async () => await Modal.alert(
                      t('common.error'),
                      t('settingsVoice.local.openAiCompatEndpoint.invalidBody'),
                    ),
                  });
                  if (patch) writeConfig({ ...config, ...patch });
                  return;
                }
                const raw = await Modal.prompt(
                  translateDescriptorKey(field.promptTitleKey ?? field.titleKey),
                  translateDescriptorKey(field.promptBodyKey ?? field.subtitleKey),
                  { placeholder: typeof value === 'string' ? value : '' },
                );
                if (raw === null) return;
                const next = String(raw).trim();
                if (next.length < field.minLength || next.length > field.maxLength) {
                  await Modal.alert(t('common.error'));
                  return;
                }
                setValue(field.key, next);
                })(), { tag: `BundledSpeechSettings.text.${field.key}` })}
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
          return (
            <React.Fragment key={field.key}>
              <Item
                title={translateDescriptorKey(field.titleKey)}
                subtitle={translateDescriptorKey(field.subtitleKey)}
                detail={typeof value === 'number' ? String(value) : t('common.none')}
                onPress={() => fireAndForget((async () => {
                const raw = await Modal.prompt(translateDescriptorKey(field.promptTitleKey!), translateDescriptorKey(field.promptBodyKey!), {
                  inputType: 'numeric',
                  placeholder: typeof value === 'number' ? String(value) : '',
                });
                if (raw === null) return;
                const trimmed = String(raw).trim();
                if (!trimmed && field.nullable) return setValue(field.key, null);
                const next = Number(trimmed);
                if (!Number.isFinite(next) || next < (field.min ?? -Infinity) || next > (field.max ?? Infinity)) {
                  await Modal.alert(t('common.error'), `${field.min}–${field.max}`);
                  return;
                }
                setValue(field.key, next);
                })(), { tag: `BundledSpeechSettings.number.${field.key}` })}
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
                fireAndForget((async () => {
                  const raw = await Modal.prompt(translateDescriptorKey(field.titleKey), translateDescriptorKey(field.subtitleKey), { placeholder: typeof value === 'string' ? value : '' });
                  if (raw !== null) setValue(field.key, String(raw).trim() || (field.nullable ? null : value));
                })(), { tag: `BundledSpeechSettings.custom.${field.key}` });
              } else {
                setValue(field.key, id || null);
              }
              setOpenKey(null);
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
        model: requestSettings.model,
        voiceName: requestSettings.voiceName,
        languageCode: typeof config.languageCode === 'string' ? config.languageCode : null,
        format: config.format === 'wav' ? 'wav' : 'mp3',
        speakingRate: typeof config.speakingRate === 'number' ? config.speakingRate : null,
        pitch: typeof config.pitch === 'number' ? config.pitch : null,
      });
      await playAudioBytesWithStopper({
        bytes: result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer,
        format: config.format === 'wav' ? 'wav' : 'mp3',
        registerPlaybackStopper: () => () => {},
      });
    },
  });
}
