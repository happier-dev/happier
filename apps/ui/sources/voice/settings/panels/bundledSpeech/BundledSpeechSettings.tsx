import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { VoiceProviderSettingsEnvelopeV1Schema } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { LANGUAGES, getLanguageDisplayName } from '@/constants/Languages';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { bundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import {
  readLocalSpeechProviderEnvelope,
  writeLocalSpeechProviderEnvelope,
} from '@/sync/domains/settings/voiceLocalSpeechProviderSettings';

import type { LocalSttProviderSettingsProps, LocalSttProviderSpec } from '../localStt/providers/_types';
import type { LocalTtsProviderSettingsProps, LocalTtsProviderSpec } from '../localTts/providers/_types';
import {
  readBundledSpeechSettingsDescriptorFromEntry,
  type BundledSpeechSettingsEntry,
  type BundledSpeechSettingsDescriptor as SettingsDescriptor,
} from './descriptor';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const translateDescriptorKey = t as unknown as (key: string) => string;

type BundledSpeechCatalogs = Record<string, readonly Readonly<{
  id: string;
  name: string;
  metadata: Readonly<Record<string, unknown>>;
}>[]>;

function BundledSpeechSettings(props: Readonly<{
  entry: BundledSpeechSettingsEntry;
  descriptor: SettingsDescriptor;
  settings: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
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
  const envelope = readLocalSpeechProviderEnvelope(props.settings, props.descriptor.providerId);
  const canonicalConfig = envelope?.schemaVersion === props.descriptor.schemaVersion
    ? props.descriptor.parseConfig(envelope.config)
    : null;
  const legacyConfig = envelope?.schemaVersion === 1
    ? props.descriptor.parseLegacyConfig(envelope.config)
    : null;
  const migratedLegacyConfig = legacyConfig ? props.descriptor.migrateLegacy(legacyConfig) : null;
  const config = canonicalConfig ?? migratedLegacyConfig ?? props.descriptor.defaultConfig;
  const legacySecretValue = legacyConfig ? props.descriptor.readLegacySecret(legacyConfig) : null;
  const legacyCredentialClass = legacyConfig
    ? props.descriptor.classifyLegacyCredential(legacyConfig)
    : 'importable';
  const pendingCredentialMigration = legacyConfig !== null
    && (legacySecretValue !== null || legacyCredentialClass === 'needs_machine_credential');
  const nextSettings = React.useMemo(
    () => ({ ...props.settings, provider: props.descriptor.providerId }),
    [props.descriptor.providerId, props.settings],
  );
  const persistCanonicalConfig = React.useCallback((nextConfig: Record<string, unknown>) => props.onChange(
    writeLocalSpeechProviderEnvelope(
      nextSettings,
      props.descriptor.providerId,
      VoiceProviderSettingsEnvelopeV1Schema.parse({
        schemaVersion: props.descriptor.schemaVersion,
        config: nextConfig,
      }),
    ),
  ), [nextSettings, props.descriptor.providerId, props.descriptor.schemaVersion, props.onChange]);
  const writeConfig = (nextConfig: Record<string, unknown>) => {
    if (pendingCredentialMigration) return;
    persistCanonicalConfig(nextConfig);
  };
  const setValue = (key: string, value: unknown) => writeConfig({ ...config, [key]: value });
  const migrateLegacyAfterCredential = React.useCallback(() => {
    if (!migratedLegacyConfig) return;
    persistCanonicalConfig(migratedLegacyConfig);
  }, [migratedLegacyConfig, persistCanonicalConfig]);
  const credentialIdentityRef = React.useRef<string | null | undefined>(undefined);
  const onCredentialStatusChanged = React.useCallback((status: Readonly<{
    exists: boolean;
    credentialIdentity: string | null;
  }> | null) => {
    if (status?.exists === true) migrateLegacyAfterCredential();
    const nextIdentity = status?.credentialIdentity ?? null;
    const previousIdentity = credentialIdentityRef.current;
    credentialIdentityRef.current = nextIdentity;
    if (previousIdentity !== undefined && previousIdentity !== nextIdentity) {
      setCatalogRefreshRevision((current) => current + 1);
    }
  }, [migrateLegacyAfterCredential]);

  React.useEffect(() => {
    const controller = new AbortController();
    setCatalogState({ targetKey: catalogTargetKey, catalogs: {} });
    for (const field of props.descriptor.fields) {
      if (!field.catalog) continue;
      void bundledSpeechDaemonClient.fetchCatalog(props.entry, field.catalog, controller.signal).then((rows) => {
        if (controller.signal.aborted) return;
        setCatalogState((current) => ({
          targetKey: catalogTargetKey,
          catalogs: {
            ...(current?.targetKey === catalogTargetKey ? current.catalogs : {}),
            [field.key]: rows,
          },
        }));
      }).catch(() => {});
    }
    return () => controller.abort();
  }, [catalogTargetKey, props.descriptor.fields, props.entry]);

  return (
    <>
      <VoiceCredentialItem
        title={translateDescriptorKey(props.descriptor.credential.titleKey)}
        promptTitle={translateDescriptorKey(props.descriptor.credential.promptTitleKey)}
        promptDescription={translateDescriptorKey(props.descriptor.credential.promptBodyKey)}
        providerId={props.descriptor.providerId}
        credentialSlotId={props.descriptor.credential.kind}
        machineId={machine.machineId}
        machineLabel={machine.machineLabel}
        disclosePlainStorage={true}
        onStatusChanged={onCredentialStatusChanged}
        onChanged={() => setCatalogRefreshRevision((current) => current + 1)}
      />
      {props.descriptor.fields.map((field) => {
        const value = config[field.key];
        if (field.kind === 'number') {
          return (
            <Item
              key={field.key}
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
          );
        }

        const rows = field.kind === 'language'
          ? LANGUAGES.map((language) => ({
            id: typeof language.code === 'string' ? language.code : '',
            title: typeof language.code === 'string' ? getLanguageDisplayName(language) : translateDescriptorKey(field.autoTitleKey!),
            subtitle: typeof language.code === 'string' ? language.code : translateDescriptorKey(field.autoSubtitleKey!),
          }))
          : field.kind === 'enum'
            ? (field.options ?? []).map((option) => ({ ...option, subtitle: undefined }))
            : (catalogs[field.key] ?? []).map((row) => ({
              id: row.id,
              title: row.name,
              subtitle: typeof row.metadata.description === 'string' ? row.metadata.description : row.id,
            }));
        return (
          <DropdownMenu
            key={field.key}
            open={openKey === field.key}
            onOpenChange={(next) => setOpenKey(next ? field.key : null)}
            variant="selectable"
            search={field.kind === 'remote_select' || field.kind === 'language'}
            searchPlaceholder={field.searchPlaceholderKey ? translateDescriptorKey(field.searchPlaceholderKey) : undefined}
            selectedId={typeof value === 'string' ? value : ''}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{ title: translateDescriptorKey(field.titleKey), subtitle: translateDescriptorKey(field.subtitleKey), showSelectedSubtitle: false }}
            items={[
              ...(field.nullable || field.kind === 'language'
                ? [{ id: '', title: translateDescriptorKey(field.autoTitleKey ?? 'common.none'), subtitle: field.autoSubtitleKey ? translateDescriptorKey(field.autoSubtitleKey) : undefined }]
                : []),
              ...rows.map((row) => ({
                ...row,
                icon: <Ionicons name={field.kind === 'language' ? 'language-outline' : 'sparkles-outline'} size={22} color={theme.colors.text.secondary} />,
              })),
              ...(field.allowCustom ? [{ id: '__custom__', title: t('common.edit'), subtitle: undefined }] : []),
            ]}
            onSelect={(id) => {
              if (id === '__custom__') {
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
        );
      })}
      {props.descriptor.privacyDisclosureKey ? (
        <Item
          testID={`voice-speech-provider-data:${props.descriptor.providerId}`}
          mode="info"
          title={t('settingsVoice.realtimeProviders.links.privacy.title')}
          subtitle={translateDescriptorKey(props.descriptor.privacyDisclosureKey)}
          showChevron={false}
        />
      ) : null}
    </>
  );
}

export function createBundledLocalSttProviderSpec(
  entry: BundledSpeechSettingsEntry,
): LocalSttProviderSpec | null {
  const descriptor = readBundledSpeechSettingsDescriptorFromEntry(entry.providerId, entry);
  if (!descriptor || descriptor.role !== 'stt') return null;
  const Settings = (props: LocalSttProviderSettingsProps) => (
    <BundledSpeechSettings
      entry={entry}
      descriptor={descriptor}
      settings={isRecord(props.cfgStt) ? props.cfgStt : {}}
      onChange={(next) => props.setStt(next)}
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
  if (!descriptor || descriptor.role !== 'tts') return null;
  const Settings = (props: LocalTtsProviderSettingsProps) => (
    <BundledSpeechSettings
      entry={entry}
      descriptor={descriptor}
      settings={isRecord(props.cfgTts) ? props.cfgTts : {}}
      onChange={(next) => props.setTts(next as LocalTtsProviderSettingsProps['cfgTts'])}
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
    test: async ({ cfgTts, sample }) => {
      const envelope = readLocalSpeechProviderEnvelope(cfgTts, descriptor.providerId);
      const config = envelope?.schemaVersion === descriptor.schemaVersion
        ? descriptor.parseConfig(envelope.config) ?? descriptor.defaultConfig
        : descriptor.defaultConfig;
      const voiceName = config.voiceName;
      if (typeof voiceName !== 'string' || !voiceName.trim()) {
        await Modal.alert(t('common.error'), translateDescriptorKey(descriptor.test!.missingValueMessageKey));
        return;
      }
      const result = await bundledSpeechDaemonClient.synthesize({
        entry,
        input: sample,
        voiceName,
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
