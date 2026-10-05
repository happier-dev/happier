import * as React from 'react';
import { VoiceGreetingItem } from '@/voice/settings/panels/VoiceGreetingItem';
import type { VoiceWelcomeSelection } from '@/voice/settings/welcome';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Slider } from '@/components/ui/forms/Slider';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { getLanguageDisplayNameForCode } from '@/constants/Languages';
import { Modal } from '@/modal';
import { getPreferredLanguage, t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { AccountVoiceCredentialUseStatus } from '@/voice/credentials/accountVoiceCredential';
import { performVoiceAdapterRuntimeAction } from '@/voice/session/voiceAdapterRegistry';
import { playRealtimeCatalogPreview, readRealtimeCatalogPreview, stopRealtimeCatalogPreview, subscribeRealtimeCatalogPreview } from './catalogPreview';

import {
  readRealtimeProviderConfigPath,
  updateRealtimeProviderConfig,
  type RealtimeProviderSettingsOwner,
  type RealtimeSettingsDescriptor,
  type RealtimeSettingsFieldDescriptor,
} from './descriptor';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { VoiceRemoteCatalogState } from '@/voice/settings/remoteCatalogState';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceContributedSettingRefs } from '@/voice/settings/useVoiceContributedSettingRefs';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { confirmRealtimeProviderSettingChange } from './confirmRealtimeProviderSettingChange';
import { resolveVoiceWelcomeText } from '@/voice/agent/voiceWelcomeText';

const REALTIME_CATALOG_PREVIEW_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

type CatalogRow = Readonly<{
  id: string;
  name: string;
  subtitle?: string;
  previewUrl?: string | null;
}>;

export type RealtimeCatalogState = VoiceRemoteCatalogState<CatalogRow>;

type SettingsValue = Readonly<Record<string, unknown>>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function translate(key: unknown, fallback = ''): string {
  if (typeof key === 'string' && key.length > 0) return tLoose(key);
  const localized = record(key);
  return typeof localized?.fallback === 'string' && localized.fallback.length > 0
    ? localized.fallback
    : fallback;
}

function fieldTestId(field: RealtimeSettingsFieldDescriptor): string {
  return `voice-realtime-field-${field.path.replaceAll('.', '-')}`;
}

function readOptionRows(field: RealtimeSettingsFieldDescriptor): DropdownMenuItem[] {
  if (!Array.isArray(field.options)) return [];
  return field.options.flatMap((raw): DropdownMenuItem[] => {
    if (typeof raw === 'string') return [{
      id: raw,
      title: field.kind === 'language_hint'
        ? getLanguageDisplayNameForCode(raw, getPreferredLanguage())
        : translate(`settingsVoice.realtimeProviders.options.${raw}`, raw),
    }];
    const option = record(raw);
    if (!option || typeof option.id !== 'string') return [];
    const kind = typeof option.kind === 'string' ? option.kind : null;
    const id = option.id === 'custom' ? '__custom__' : kind ? `${kind}:${option.id}` : option.id;
    return [{
      id,
      title: translate(option.titleKey, typeof option.title === 'string' ? option.title : option.id),
      subtitle: translate(option.subtitleKey) || (kind === 'moving_alias'
        ? tLoose('settingsVoice.realtimeProviders.options.movingAlias')
        : kind === 'pinned' ? tLoose('settingsVoice.realtimeProviders.options.pinned') : undefined),
    }];
  });
}

function selectedId(field: RealtimeSettingsFieldDescriptor, value: unknown): string {
  const selected = record(value);
  if (field.kind === 'model' && selected) {
    return typeof selected.kind === 'string' && typeof selected.id === 'string'
      ? `${selected.kind}:${selected.id}`
      : '';
  }
  if (field.kind === 'voice_catalog' && selected && typeof selected.id === 'string') return selected.id;
  if (value === null || value === undefined) return '';
  return String(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function detail(value: unknown): string {
  if (value === null || value === undefined || value === '') return t('common.none');
  if (Array.isArray(value)) return value.length === 0 ? t('common.none') : value.join(', ');
  const selected = record(value);
  if (selected && typeof selected.id === 'string') return selected.id;
  return String(value);
}

export function RealtimeProviderFields(props: Readonly<{
  providerId: string;
  descriptor: RealtimeSettingsDescriptor;
  owner: RealtimeProviderSettingsOwner;
  config: SettingsValue;
  onConfigChange: (next: SettingsValue) => void;
  credentialStatus: AccountVoiceCredentialUseStatus;
  catalog: RealtimeCatalogState;
  onRequestCatalog: () => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  welcomeSelection?: string;
  assistantLanguage?: string | null;
  onWelcomeSelection?: (selection: string) => void;
  renderAfterField?: (field: RealtimeSettingsFieldDescriptor) => React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  const settingRef = useVoiceContributedSettingRefs(props.providerId);
  const [openField, setOpenField] = React.useState<string | null>(null);
  /** The menu whose Custom entry is being typed inline beneath it. */
  const [customField, setCustomField] = React.useState<string | null>(null);
  const actionBusyRef = React.useRef(false);
  const [actionBusy, setActionBusy] = React.useState(false);
  const previewSnapshot = React.useSyncExternalStore(subscribeRealtimeCatalogPreview, readRealtimeCatalogPreview, readRealtimeCatalogPreview);
  const previewingId = previewSnapshot?.providerId === props.providerId ? previewSnapshot.voiceId : null;
  const [expandedAdvancedPaths, setExpandedAdvancedPaths] = React.useState<ReadonlySet<string>>(() => new Set());
  const previousProviderIdRef = React.useRef(props.providerId);
  const latestSettingsRef = React.useRef({
    providerId: props.providerId,
    owner: props.owner,
    config: props.config,
    onConfigChange: props.onConfigChange,
  });
  latestSettingsRef.current = {
    providerId: props.providerId,
    owner: props.owner,
    config: props.config,
    onConfigChange: props.onConfigChange,
  };
  const credentialUsable = props.credentialStatus === 'ready';
  const credentialUnavailableDetail = props.credentialStatus === 'review_required'
    ? tLoose('settingsVoice.externalCredentials.reviewRequired')
    : props.credentialStatus === 'unknown'
      // The snapshot could not be read; asking for a credential that may
      // already be stored is the same falsehood the row above avoids.
      ? tLoose('voice.readiness.credential_unknown')
      : tLoose('settingsVoice.realtimeProviders.catalog.credentialRequired');

  const stopPreview = React.useCallback(() => {
    stopRealtimeCatalogPreview(props.providerId);
  }, [props.providerId]);

  React.useEffect(() => stopPreview, [stopPreview]);
  React.useEffect(() => {
    // Initial disclosure reveal runs after mount; only a real provider change resets it.
    if (previousProviderIdRef.current === props.providerId) return;
    previousProviderIdRef.current = props.providerId;
    stopPreview();
    setOpenField(null);
    setExpandedAdvancedPaths(new Set());
    actionBusyRef.current = false;
    setActionBusy(false);
  }, [props.providerId, stopPreview]);

  const playPreview = React.useCallback((row: CatalogRow) => {
    if (!row.previewUrl) return;
    if (previewingId === row.id) { stopPreview(); return; }
    const providerId = props.providerId;
    fireAndForget(playRealtimeCatalogPreview({ providerId, row,
      isCurrent: () => latestSettingsRef.current.providerId === providerId }), { tag: 'RealtimeProviderFields.previewVoice' });
  }, [previewingId, props.providerId, stopPreview]);

  const write = React.useCallback((
    field: RealtimeSettingsFieldDescriptor,
    value: unknown,
    expectedProviderId?: string,
  ) => {
    const latest = latestSettingsRef.current;
    if (expectedProviderId && latest.providerId !== expectedProviderId) return false;
    const next = updateRealtimeProviderConfig(latest.owner, latest.config, field.pathSegments, value);
    if (!next) {
      Modal.alert(t('common.error'), tLoose('settingsVoice.realtimeProviders.invalidValue'));
      return false;
    }
    latest.onConfigChange(next);
    return true;
  }, []);

  /** Saves a typed text value; an empty value clears it. Returns the text the field shows afterwards. */
  const commitText = React.useCallback((field: RealtimeSettingsFieldDescriptor, current: unknown, draft: string) => {
    if (!write(field, draft.length > 0 ? draft : null, props.providerId)) return textValue(current);
    return draft;
  }, [props.providerId, write]);

  /**
   * Saves a typed number within the descriptor's bounds, integer and step rules; an empty value restores the
   * range reset (or clears it). A number that needs opt-in is saved only after the confirmation.
   */
  const commitNumber = React.useCallback((field: RealtimeSettingsFieldDescriptor, current: unknown, draft: string) => {
    const providerId = props.providerId;
    const trimmed = draft.trim();
    const next = trimmed.length === 0
      ? field.kind === 'range' && typeof field.reset === 'number' ? field.reset : null
      : Number(trimmed);
    const step = typeof field.step === 'number' && Number.isFinite(field.step) && field.step > 0
      ? field.step
      : null;
    const stepOrigin = typeof field.min === 'number' && Number.isFinite(field.min) ? field.min : 0;
    const violatesStep = next !== null && step !== null
      && Math.abs((next - stepOrigin) / step - Math.round((next - stepOrigin) / step)) > 1e-8;
    if (next !== null && (!Number.isFinite(next)
      || (typeof field.min === 'number' && next < field.min)
      || (typeof field.max === 'number' && next > field.max)
      || (field.integer === true && !Number.isInteger(next))
      || violatesStep)) {
      Modal.alert(t('common.error'), tLoose('settingsVoice.realtimeProviders.invalidValue'));
      return numberValue(current);
    }
    if (next !== null && field.requiresOptIn === true) {
      fireAndForget((async () => {
        const confirmed = await confirmRealtimeProviderSettingChange({ field, value: next, isCurrent: () => latestSettingsRef.current.providerId === providerId });
        if (confirmed) write(field, next, providerId);
      })(), { tag: `RealtimeProviderFields.number.${field.kind}` });
      return numberValue(current);
    }
    if (!write(field, next, providerId)) return numberValue(current);
    return numberValue(next);
  }, [props.providerId, write]);

  const renderNumberField = (field: RealtimeSettingsFieldDescriptor, current: unknown, key: string, title: unknown, subtitle: unknown) => {
    if (field.kind === 'range' && typeof field.min === 'number' && typeof field.max === 'number' && typeof field.step === 'number') {
      const value = typeof current === 'number' ? current
        : typeof field.defaultValue === 'number' ? field.defaultValue
          : typeof field.reset === 'number' ? field.reset : field.min;
      const format = (number: number) => `${typeof field.fractionDigits === 'number' ? number.toFixed(field.fractionDigits) : number}${typeof field.valueSuffix === 'string' ? field.valueSuffix : ''}`;
      return <Item key={key} testID={fieldTestId(field)} title={translate(title)} subtitle={translate(subtitle)}
        subtitleLines={0} showChevron={false} accessoryLayout="adaptive" rightElementOutsidePressable
        rightElement={<View style={{ gap: 4, minWidth: 180, flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Text style={{ ...Typography.default(), fontVariant: ['tabular-nums'], color: theme.colors.text.secondary }}>{format(value)}</Text>
            <RoundButton testID={`${fieldTestId(field)}.default`} title={t('common.default')} size="small" display="inverted"
              onPress={() => { if (field.nullable === true) write(field, null, props.providerId); else commitNumber(field, current, ''); }} />
          </View>
          <Slider testID={`${fieldTestId(field)}.slider`} value={value} min={field.min} max={field.max} step={field.step}
            accessibilityLabel={translate(title)} formatValueText={format}
            onValueChange={(next) => commitNumber(field, current, String(next))} />
        </View>} />;
    }
    return (
    <FieldValueItem
      key={key}
      testID={fieldTestId(field)}
      fieldTestID={`${fieldTestId(field)}.field`}
      title={translate(title)}
      subtitle={translate(subtitle)}
      kind={field.integer === true ? 'integer' : 'decimal'}
      stepper={field.numericControl === 'stepper' && typeof field.step === 'number' ? {
        step: field.step,
        min: typeof field.min === 'number' ? field.min : undefined,
        max: typeof field.max === 'number' ? field.max : undefined,
      } : undefined}
      unit={field.unitKey === undefined ? undefined : translate(field.unitKey)}
      signed={!(typeof field.min === 'number' && field.min >= 0)}
      allowEmpty
      placeholder={typeof field.reset === 'number' ? String(field.reset) : t('common.none')}
      value={numberValue(current)}
      onCommit={(draft) => commitNumber(field, current, draft)}
    />
    );
  };

  return <>
    {props.descriptor.fields.map((field) => {
      const value = readRealtimeProviderConfigPath(props.config, field.pathSegments);
      const key = `${field.kind}:${field.path}`;
      const rendered = (() => {

      if (field.kind === 'segmented' && Array.isArray(field.supportedModelIds)) {
        const model = record(props.config.model);
        if (!model || typeof model.id !== 'string' || !stringList(field.supportedModelIds).includes(model.id)) return null;
      }

      if (field.kind === 'welcome') {
        const selection: VoiceWelcomeSelection = props.welcomeSelection === 'immediate' || props.welcomeSelection === 'on_first_turn' ? props.welcomeSelection : 'off';
        const greetingUnavailable = selection === 'immediate'
          && field.immediateRequiresLiteral === true
          && !resolveVoiceWelcomeText(props.assistantLanguage);
        return <VoiceGreetingItem
          key={key}
          value={selection}
          explanation={greetingUnavailable ? t('voicePresence.greetingLiteralUnavailable') : undefined}
          onChange={(next) => props.onWelcomeSelection?.(next)}
        />;
      }

      if (field.kind === 'privacy_opt_in') {
        const enabled = value === true;
        return <React.Fragment key={key}>
          <Item
            testID={fieldTestId(field)}
            title={translate(field.titleKey)}
            subtitle={translate(field.subtitleKey)}
            rightElement={<Switch
              value={enabled}
              accessibilityLabel={translate(field.titleKey)}
              disabled={actionBusy}
              onValueChange={(next) => {
                const providerId = props.providerId;
                fireAndForget((async () => {
                  try {
                    if (next) {
                      const confirmed = await confirmRealtimeProviderSettingChange({ field, value: next, isCurrent: () => latestSettingsRef.current.providerId === providerId });
                      if (!confirmed) return;
                    }
                    write(field, next, providerId);
                  } catch {
                    if (latestSettingsRef.current.providerId !== providerId) return;
                    await Modal.alertAsync(t('common.error'), tLoose('settingsVoice.realtimeProviders.operationFailed'));
                  }
                })(), { tag: 'RealtimeProviderFields.privacyOptIn' });
              }}
            />}
            rightElementOutsidePressable
          />
          {!enabled || typeof field.forgetAction !== 'string' ? null : <Item
            testID="voice-realtime-forget-provider-conversation"
            title={tLoose('settingsVoice.realtimeProviders.resumption.forgetTitle')}
            subtitle={tLoose('settingsVoice.realtimeProviders.resumption.forgetSubtitle')}
            disabled={actionBusy}
            loading={actionBusy}
            onPress={() => {
              if (actionBusyRef.current) return;
              const actionProviderId = props.providerId;
              actionBusyRef.current = true;
              setActionBusy(true);
              fireAndForget((async () => {
                try {
                  const result = await performVoiceAdapterRuntimeAction(actionProviderId, field.forgetAction as string);
                  if (latestSettingsRef.current.providerId !== actionProviderId) return;
                  const bodyKey = result.status === 'completed'
                    ? 'settingsVoice.realtimeProviders.resumption.forgotten'
                    : result.status === 'unsupported'
                      ? 'settingsVoice.realtimeProviders.resumption.unsupported'
                      : 'settingsVoice.realtimeProviders.resumption.failed';
                  await Modal.alertAsync(
                    result.status === 'completed' ? t('common.success') : t('common.error'),
                    tLoose(bodyKey),
                  );
                } catch {
                  if (latestSettingsRef.current.providerId !== actionProviderId) return;
                  await Modal.alertAsync(
                    t('common.error'),
                    tLoose('settingsVoice.realtimeProviders.resumption.failed'),
                  );
                } finally {
                  if (latestSettingsRef.current.providerId === actionProviderId) {
                    actionBusyRef.current = false;
                    setActionBusy(false);
                  }
                }
              })(), { tag: 'RealtimeProviderFields.forgetProviderConversation' });
            }}
          />}
        </React.Fragment>;
      }

      if (field.kind === 'number' || field.kind === 'range') {
        return renderNumberField(field, value, key, field.titleKey, field.subtitleKey);
      }

      if (field.kind === 'text' || field.kind === 'instructions') {
        return <FieldValueItem key={key} testID={fieldTestId(field)} fieldTestID={`${fieldTestId(field)}.field`}
          title={translate(field.titleKey)} subtitle={translate(field.subtitleKey)} subtitleLines={0} placeholder={t('common.none')}
          value={textValue(value)} onCommit={(draft) => commitText(field, value, draft)} />;
      }

      if (field.kind === 'keyterms') {
        return <FieldValueItem key={key} testID={fieldTestId(field)} fieldTestID={`${fieldTestId(field)}.field`}
          title={translate(field.titleKey)} subtitle={translate(field.subtitleKey)} placeholder={t('common.none')}
          value={stringList(value).join(', ')}
          onCommit={(draft) => {
            const terms = draft.split(/[\n,]/u).map((term) => term.trim()).filter(Boolean);
            const deduped = [...new Map(terms.map((term) => [term.toLocaleLowerCase('en-US'), term])).values()];
            if (!write(field, deduped, props.providerId)) return stringList(value).join(', ');
            return deduped.join(', ');
          }} />;
      }

      if (field.kind === 'server_vad') {
        const subfields = Array.isArray(field.subfields) ? field.subfields : [];
        const renderedSubfields = subfields.map((raw) => {
          const subfield = record(raw);
          if (!subfield || typeof subfield.path !== 'string') return null;
          const path = subfield.path;
          const pathSegments = stringList(subfield.pathSegments);
          if (pathSegments.length === 0) return null;
          const synthetic = { ...subfield, kind: 'number', path, pathSegments } as RealtimeSettingsFieldDescriptor;
          const current = readRealtimeProviderConfigPath(props.config, synthetic.pathSegments);
          const row = renderNumberField(synthetic, current, path, subfield.titleKey, subfield.subtitleKey);
          const setting = settingRef(path);
          return setting ? <SettingAnchor key={path} setting={setting}>{row}</SettingAnchor> : row;
        });
        if (field.advanced !== true) return <React.Fragment key={key}>{renderedSubfields}</React.Fragment>;
        const expanded = expandedAdvancedPaths.has(field.path);
        const actionKey = expanded
          ? 'settingsVoice.realtimeProviders.advanced.hide'
          : 'settingsVoice.realtimeProviders.advanced.show';
        const settings = subfields.flatMap((raw) => {
          const subfield = record(raw);
          const setting = typeof subfield?.path === 'string' ? settingRef(subfield.path) : undefined;
          return setting ? [setting] : [];
        });
        return <SettingAnchor key={key} settings={settings}>
          <ExpandableItem
            testID={`voice-realtime-advanced-${field.path.replaceAll('.', '-')}.disclosure`}
            expanded={expanded}
            onExpandedChange={(nextExpanded) => setExpandedAdvancedPaths((current) => {
              const next = new Set(current);
              if (nextExpanded) next.add(field.path);
              else next.delete(field.path);
              return next;
            })}
            header={(state) => <Item
              {...state.headerProps}
              testID={`voice-realtime-advanced-${field.path.replaceAll('.', '-')}`}
              title={translate(field.titleKey)}
              subtitle={translate(field.subtitleKey)}
              detail={tLoose(actionKey)}
              accessibilityLabel={`${translate(field.titleKey)}. ${tLoose(actionKey)}`}
            />}
          >
            {renderedSubfields}
          </ExpandableItem>
        </SettingAnchor>;
      }

      const optionRows = readOptionRows(field);
      const isCatalog = field.kind === 'voice_catalog' || field.kind === 'remote_voice';
      const catalogRows: DropdownMenuItem[] = props.catalog.phase === 'ready'
        ? props.catalog.rows.map((row) => ({
          id: row.id,
          title: row.name,
          subtitle: row.subtitle,
          rightElement: !row.previewUrl ? undefined : <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('settingsVoice.realtimeProviders.catalog.preview', { voice: row.name })}
            style={{
              minWidth: REALTIME_CATALOG_PREVIEW_TARGET_SIZE,
              minHeight: REALTIME_CATALOG_PREVIEW_TARGET_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onPress={(event) => {
              event.stopPropagation();
              playPreview(row);
            }}
          >
            <Icon
              name={previewingId === row.id ? 'stop-circle' : 'play-circle'}
              size={24}
              color={theme.colors.text.secondary}
            />
          </Pressable>,
        }))
        : [];
      const optionalRows: DropdownMenuItem[] = field.kind === 'language_hint'
        ? [{ id: '', title: tLoose('settingsVoice.realtimeProviders.options.automatic') }]
        : [];
      const rows = isCatalog ? catalogRows : [...optionalRows, ...optionRows];
      const hasCustomRow = rows.some((row) => row.id === '__custom__');
      const allowCustom = field.customIdAllowed === true || hasCustomRow;
      const statusRows: DropdownMenuItem[] = !isCatalog ? []
        : !credentialUsable ? [{ id: '__status__', title: credentialUnavailableDetail, disabled: true }]
          : props.catalog.phase === 'loading' ? [{ id: '__status__', title: t('common.loading'), disabled: true }]
            : props.catalog.phase === 'error' ? [{ id: '__retry__', title: tLoose('settingsVoice.realtimeProviders.catalog.retry') }]
              : props.catalog.phase === 'ready' && props.catalog.rows.length === 0
                ? [{ id: '__status__', title: tLoose('settingsVoice.realtimeProviders.catalog.empty'), disabled: true }]
                : [];
      const customRow = allowCustom && !hasCustomRow
        ? [{ id: '__custom__', title: tLoose('settingsVoice.realtimeProviders.options.custom') }]
        : [];
      const selectedRecord = record(value);
      const customId = typeof selectedRecord?.id === 'string' ? selectedRecord.id : textValue(value);
      return <React.Fragment key={key}>
      <DropdownMenu
        testID={fieldTestId(field)}
        open={openField === key}
        onOpenChange={(next) => {
          setOpenField(next ? key : null);
          if (next && isCatalog && credentialUsable) props.onRequestCatalog();
          if (!next && isCatalog) stopPreview();
        }}
        variant="selectable"
        search={isCatalog}
        searchPlaceholder={translate(field.searchPlaceholderKey)}
        selectedId={selectedId(field, value)}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        itemRowProps={isCatalog ? { rightElementOutsidePressable: true } : undefined}
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{ title: translate(field.titleKey), subtitle: translate(field.subtitleKey), showSelectedSubtitle: false,
          detailFormatter: () => isCatalog && !credentialUsable
            ? credentialUnavailableDetail
            : detail(value) }}
        items={[...statusRows, ...rows, ...customRow]}
        onSelect={(id) => {
          if (id === '__retry__') { props.onRequestCatalog(); return; }
          if (id === '__status__') return;
          if (id === '__custom__') {
            setCustomField(key);
            setOpenField(null);
            return;
          }
          if (field.kind === 'model') {
            const separator = id.indexOf(':');
            const next = separator > 0 ? { kind: id.slice(0, separator), id: id.slice(separator + 1) } : null;
            if (!next) return;
            const providerId = props.providerId;
            const commit = () => { write(field, next, providerId); setOpenField(null); };
            if (next.kind === 'moving_alias' && field.movingAliasRequiresOptIn === true) {
              fireAndForget((async () => {
                const confirmed = await confirmRealtimeProviderSettingChange({ field, value: next, isCurrent: () => latestSettingsRef.current.providerId === providerId });
                if (confirmed) commit();
              })(), { tag: 'RealtimeProviderFields.confirmMovingAlias' });
            } else commit();
            return;
          }
          if (field.kind === 'voice_catalog') write(field, field.valueShape === 'string' ? id : { kind: 'catalog', id });
          else write(field, id || null);
          setOpenField(null);
        }}
      />
      {customField !== key ? null : <FieldValueItem
        testID={`${fieldTestId(field)}.custom`}
        fieldTestID={`${fieldTestId(field)}.custom.field`}
        title={translate(field.titleKey)}
        subtitle={translate(field.subtitleKey)}
        autoFocus
        value={customId}
        onCommit={(draft) => {
          setCustomField(null);
          if (!draft) return customId;
          const next = field.kind === 'model' ? { kind: 'pinned', id: draft }
            : field.kind === 'voice_catalog' && field.valueShape !== 'string' ? { kind: 'custom', id: draft } : draft;
          if (!write(field, next, props.providerId)) return customId;
        }}
      />}
      </React.Fragment>;
      })();
      const setting = field.kind === 'welcome' ? VOICE_CONVERSATIONS_SETTINGS.settings.greeting : settingRef(field.path);
      const catalogOperationSettings = [setting, settingRef(`${field.path}.preview`), settingRef(`${field.path}.stopPreview`)].flatMap(ref => ref ? [ref] : []);
      const anchored = <SettingAnchor settings={catalogOperationSettings}><>{rendered}</></SettingAnchor>;
      return <React.Fragment key={`layout:${key}`}>
        {rendered && setting ? <SettingAnchor setting={setting}>{anchored}</SettingAnchor> : anchored}
        {rendered === null ? null : props.renderAfterField?.(field) ?? null}
      </React.Fragment>;
    })}
  </>;
}
