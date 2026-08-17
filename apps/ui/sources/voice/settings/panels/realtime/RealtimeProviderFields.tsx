import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { getLanguageDisplayNameForCode } from '@/constants/Languages';
import { Modal } from '@/modal';
import { getPreferredLanguage, t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { AccountVoiceCredentialUseStatus } from '@/voice/credentials/accountVoiceCredential';
import { performVoiceAdapterRuntimeAction } from '@/voice/session/voiceAdapterRegistry';
import {
  acquireVoicePlaybackAudioMode,
  type VoiceAudioModeLease,
} from '@/voice/runtime/voiceAudioMode';

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
  return typeof key === 'string' && key.length > 0 ? tLoose(key) : fallback;
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
  onWelcomeSelection?: (selection: string) => void;
  renderAfterField?: (field: RealtimeSettingsFieldDescriptor) => React.ReactNode;
  renderConnectedServicesBinding?: (
    field: RealtimeSettingsFieldDescriptor,
    value: unknown,
    onChange: (value: unknown) => void,
  ) => React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  const [openField, setOpenField] = React.useState<string | null>(null);
  const actionBusyRef = React.useRef(false);
  const [actionBusy, setActionBusy] = React.useState(false);
  const [previewingId, setPreviewingId] = React.useState<string | null>(null);
  const [expandedAdvancedPaths, setExpandedAdvancedPaths] = React.useState<ReadonlySet<string>>(() => new Set());
  const previewRef = React.useRef<Readonly<{
    player: Readonly<{ play(): void; remove?(): void }>;
    subscription: Readonly<{ remove?(): void }> | null;
    releaseAudioMode: () => Promise<void>;
  }> | null>(null);
  const previewGenerationRef = React.useRef(0);
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
    previewGenerationRef.current += 1;
    const preview = previewRef.current;
    try { preview?.subscription?.remove?.(); } catch { /* player boundary */ }
    try { preview?.player.remove?.(); } catch { /* player boundary */ }
    previewRef.current = null;
    if (preview) {
      fireAndForget(preview.releaseAudioMode().catch(() => {}), { tag: 'RealtimeProviderFields.releasePreviewAudioMode' });
    }
    setPreviewingId(null);
  }, []);

  React.useEffect(() => stopPreview, [stopPreview]);
  React.useEffect(() => {
    stopPreview();
    setOpenField(null);
    setExpandedAdvancedPaths(new Set());
    actionBusyRef.current = false;
    setActionBusy(false);
  }, [props.providerId, stopPreview]);

  const playPreview = React.useCallback((row: CatalogRow) => {
    if (!row.previewUrl) return;
    if (previewingId === row.id) { stopPreview(); return; }
    stopPreview();
    const generation = previewGenerationRef.current;
    setPreviewingId(row.id);
    fireAndForget((async () => {
      let audioModeLease: VoiceAudioModeLease | null = null;
      try {
        audioModeLease = await acquireVoicePlaybackAudioMode('realtime-catalog-preview');
        if (previewGenerationRef.current !== generation) return;
        const { createAudioPlayer } = await import('expo-audio');
        if (previewGenerationRef.current !== generation) return;
        const player = createAudioPlayer(row.previewUrl!);
        if (previewGenerationRef.current !== generation) {
          try { player.remove?.(); } catch { /* player boundary */ }
          return;
        }
        const subscription = player.addListener('playbackStatusUpdate', (status) => {
          if (status?.didJustFinish && previewGenerationRef.current === generation) stopPreview();
        });
        previewRef.current = { player, subscription, releaseAudioMode: audioModeLease.release };
        audioModeLease = null;
        player.play();
      } catch {
        stopPreview();
      } finally {
        if (audioModeLease) await audioModeLease.release().catch(() => {});
      }
    })(), { tag: 'RealtimeProviderFields.previewVoice' });
  }, [previewingId, stopPreview]);

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

  const promptText = React.useCallback((field: RealtimeSettingsFieldDescriptor, current: unknown) => {
    const providerId = props.providerId;
    fireAndForget((async () => {
      const raw = await Modal.prompt(
        translate(field.promptTitleKey, translate(field.titleKey)),
        translate(field.promptBodyKey, translate(field.subtitleKey)),
        { placeholder: current === null || current === undefined ? '' : String(current) },
      );
      if (raw === null) return;
      const trimmed = String(raw).trim();
      write(field, trimmed.length > 0 ? trimmed : null, providerId);
    })(), { tag: `RealtimeProviderFields.text.${field.kind}` });
  }, [props.providerId, write]);

  const promptNumber = React.useCallback((field: RealtimeSettingsFieldDescriptor, current: unknown) => {
    const providerId = props.providerId;
    fireAndForget((async () => {
      const raw = await Modal.prompt(
        translate(field.promptTitleKey, translate(field.titleKey)),
        translate(field.promptBodyKey, translate(field.subtitleKey)),
        { inputType: 'numeric', placeholder: typeof current === 'number' ? String(current) : '' },
      );
      if (raw === null) return;
      const trimmed = String(raw).trim();
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
        return;
      }
      if (next !== null && field.requiresOptIn === true) {
        const confirmed = await Modal.confirm(
          translate(field.confirmTitleKey, translate(field.titleKey)),
          translate(field.confirmBodyKey, translate(field.subtitleKey)),
          { confirmText: translate(field.confirmActionKey, tLoose('common.enable')) },
        );
        if (!confirmed) return;
      }
      write(field, next, providerId);
    })(), { tag: `RealtimeProviderFields.number.${field.kind}` });
  }, [props.providerId, write]);

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
        const selection = props.welcomeSelection ?? 'off';
        return <DropdownMenu
          key={key}
          testID={fieldTestId(field)}
          open={openField === key}
          onOpenChange={(next) => setOpenField(next ? key : null)}
          variant="selectable"
          search={false}
          selectedId={selection}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{ title: translate(field.titleKey), subtitle: translate(field.subtitleKey), showSelectedSubtitle: false }}
          items={[
            { id: 'off', title: tLoose('settingsVoice.byo.realtime.call.welcome.detail.off') },
            { id: 'immediate', title: tLoose('settingsVoice.byo.realtime.call.welcome.detail.immediate') },
            { id: 'on_first_turn', title: tLoose('settingsVoice.byo.realtime.call.welcome.detail.onFirstTurn') },
          ]}
          onSelect={(id) => { props.onWelcomeSelection?.(id); setOpenField(null); }}
        />;
      }

      if (field.kind === 'connected_services_binding') {
        return <React.Fragment key={key}>
          {props.renderConnectedServicesBinding?.(field, value, (next) => {
            write(field, next);
          }) ?? null}
        </React.Fragment>;
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
                      const retention = typeof field.retentionMinutes === 'number' ? field.retentionMinutes : 0;
                      const confirmed = await Modal.confirm(
                        tLoose('settingsVoice.realtimeProviders.resumption.confirmTitle'),
                        tLoose('settingsVoice.realtimeProviders.resumption.confirmBody').replace('{minutes}', String(retention)),
                        { confirmText: tLoose('settingsVoice.realtimeProviders.resumption.confirmAction') },
                      );
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

      if (field.kind === 'nullable_boolean') {
        const rows = [
          { id: '', title: tLoose('settingsVoice.realtimeProviders.options.automatic') },
          { id: 'true', title: tLoose('common.on') },
          { id: 'false', title: tLoose('common.off') },
        ];
        return <DropdownMenu key={key} testID={fieldTestId(field)} open={openField === key}
          onOpenChange={(next) => setOpenField(next ? key : null)} variant="selectable" search={false}
          selectedId={value === null || value === undefined ? '' : String(value)} items={rows}
          showCategoryTitles={false} matchTriggerWidth={true} connectToTrigger={true} rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{ title: translate(field.titleKey), subtitle: translate(field.subtitleKey), showSelectedSubtitle: false }}
          onSelect={(id) => { write(field, id === '' ? null : id === 'true'); setOpenField(null); }} />;
      }

      if (field.kind === 'number' || field.kind === 'range') {
        return <Item key={key} testID={fieldTestId(field)} title={translate(field.titleKey)}
          subtitle={translate(field.subtitleKey)} detail={detail(value)} onPress={() => promptNumber(field, value)} />;
      }

      if (field.kind === 'text' || field.kind === 'instructions' || field.kind === 'optional_model') {
        return <Item key={key} testID={fieldTestId(field)} title={translate(field.titleKey)}
          subtitle={translate(field.subtitleKey)} detail={detail(value)} onPress={() => promptText(field, value)} />;
      }

      if (field.kind === 'keyterms') {
        return <Item key={key} testID={fieldTestId(field)} title={translate(field.titleKey)}
          subtitle={translate(field.subtitleKey)} detail={detail(value)} onPress={() => fireAndForget((async () => {
            const providerId = props.providerId;
            const raw = await Modal.prompt(translate(field.promptTitleKey, translate(field.titleKey)),
              translate(field.promptBodyKey, translate(field.subtitleKey)),
              { placeholder: stringList(value).join(', ') });
            if (raw === null) return;
            const terms = String(raw).split(/[\n,]/u).map((term) => term.trim()).filter(Boolean);
            const deduped = [...new Map(terms.map((term) => [term.toLocaleLowerCase('en-US'), term])).values()];
            write(field, deduped, providerId);
          })(), { tag: 'RealtimeProviderFields.keyterms' })} />;
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
          return <Item key={path} testID={fieldTestId(synthetic)} title={translate(subfield.titleKey)}
            subtitle={translate(subfield.subtitleKey)} detail={detail(current)} onPress={() => promptNumber(synthetic, current)} />;
        });
        if (field.advanced !== true) return <React.Fragment key={key}>{renderedSubfields}</React.Fragment>;
        const expanded = expandedAdvancedPaths.has(field.path);
        const actionKey = expanded
          ? 'settingsVoice.realtimeProviders.advanced.hide'
          : 'settingsVoice.realtimeProviders.advanced.show';
        return <React.Fragment key={key}>
          <Item
            testID={`voice-realtime-advanced-${field.path.replaceAll('.', '-')}`}
            title={translate(field.titleKey)}
            subtitle={translate(field.subtitleKey)}
            detail={tLoose(actionKey)}
            accessibilityLabel={`${translate(field.titleKey)}. ${tLoose(actionKey)}`}
            onPress={() => setExpandedAdvancedPaths((current) => {
              const next = new Set(current);
              if (next.has(field.path)) next.delete(field.path);
              else next.add(field.path);
              return next;
            })}
          />
          {expanded ? renderedSubfields : null}
        </React.Fragment>;
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
      return <DropdownMenu
        key={key}
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
            const providerId = props.providerId;
            fireAndForget((async () => {
              const raw = await Modal.prompt(translate(field.titleKey), translate(field.subtitleKey), { placeholder: detail(value) });
              if (raw === null || !String(raw).trim()) return;
              const custom = String(raw).trim();
              write(field, field.kind === 'voice_catalog' ? { kind: 'custom', id: custom } : custom, providerId);
            })(), { tag: `RealtimeProviderFields.custom.${field.kind}` });
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
                const confirmed = await Modal.confirm(
                  tLoose('settingsVoice.realtimeProviders.movingAlias.confirmTitle'),
                  tLoose('settingsVoice.realtimeProviders.movingAlias.confirmBody'),
                  { confirmText: tLoose('settingsVoice.realtimeProviders.movingAlias.confirmAction') },
                );
                if (confirmed) commit();
              })(), { tag: 'RealtimeProviderFields.confirmMovingAlias' });
            } else commit();
            return;
          }
          if (field.kind === 'voice_catalog') write(field, { kind: 'catalog', id });
          else write(field, id || null);
          setOpenField(null);
        }}
      />;
      })();
      return <React.Fragment key={`layout:${key}`}>
        {rendered}
        {rendered === null ? null : props.renderAfterField?.(field) ?? null}
      </React.Fragment>;
    })}
  </>;
}
