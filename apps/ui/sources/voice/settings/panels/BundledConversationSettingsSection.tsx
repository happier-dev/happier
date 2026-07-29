import * as React from 'react';
import { Linking } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import {
  voiceSettingsParse,
  writeVoiceProviderSettingsConfig,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  createBundledConversationUi,
  type BundledConversationProviderClient,
  type BundledConversationTtsConfigInput,
  type BundledConversationVoiceCatalogItem,
} from '@/voice/credentials/bundledConversationClient';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import {
  getExternalVoiceProviderRegistrationsRevision,
  subscribeExternalVoiceProviderRegistrations,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { showBundledVoiceAgentReuseDialog } from '@/voice/settings/modals/showBundledVoiceAgentReuseDialog';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';

import {
  parseRealtimeSettingsDescriptor,
  readRealtimeProviderConfigPath,
  resolveRealtimeProviderConfig,
  updateRealtimeProviderConfig,
  type RealtimeProviderSettingsOwner,
  type RealtimeSettingsDescriptor,
  type RealtimeSettingsFieldDescriptor,
} from './realtime/descriptor';
import {
  RealtimeProviderFields,
  type RealtimeCatalogState,
} from './realtime/RealtimeProviderFields';
import { VoiceGlobalConnectedServicesBindingField } from './realtime/VoiceGlobalConnectedServicesBindingField';

type Autoprovision = NonNullable<NonNullable<ReturnType<typeof createBundledConversationUi>>['autoprovision']>;

const providerRegistry = createDefaultVoiceProviderRegistry();

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function createUiSafely(providerId: string) {
  try {
    return createBundledConversationUi(providerId);
  } catch {
    return null;
  }
}

function normalizeCatalogRows(
  rows: readonly BundledConversationVoiceCatalogItem[] | readonly Readonly<{ id: string; name: string; metadata?: unknown }>[],
): readonly Readonly<{ id: string; name: string; subtitle?: string; previewUrl?: string | null }>[] {
  return rows.flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const id = typeof value.id === 'string' ? value.id : typeof value.voiceId === 'string' ? value.voiceId : null;
    if (!id || typeof value.name !== 'string') return [];
    const metadata = record(value.metadata);
    const labels = record(value.labels);
    const subtitle = typeof value.category === 'string' ? value.category
      : typeof metadata?.description === 'string' ? metadata.description
        : typeof labels?.accent === 'string' ? labels.accent : undefined;
    const previewUrl = typeof value.previewUrl === 'string' ? value.previewUrl
      : typeof metadata?.previewUrl === 'string' ? metadata.previewUrl : null;
    return [{ id, name: value.name, ...(subtitle ? { subtitle } : {}), previewUrl }];
  });
}

const ELEVENLABS_PROVISION_FAILURE_STAGES = new Set([
  'list_agents',
  'list_tools',
  'create_tool',
  'update_tool',
  'create_agent',
  'update_agent',
]);

function formatAutoprovisionFailureMessage(error: unknown): string {
  const value = record(error);
  const stage = typeof value?.stage === 'string'
    && ELEVENLABS_PROVISION_FAILURE_STAGES.has(value.stage)
    ? value.stage
    : null;
  const message = tLoose('settingsVoice.byo.autoprovFailed');
  return stage ? `${message}\n\n[${stage}]` : message;
}

async function fetchCatalog(client: BundledConversationProviderClient, signal?: AbortSignal | null) {
  if (client.fetchVoiceCatalog) return normalizeCatalogRows(await client.fetchVoiceCatalog(signal));
  if (client.listVoices) return normalizeCatalogRows(await client.listVoices(signal));
  throw new Error('voice_provider_catalog_unavailable');
}

function AutoprovisionItems(props: Readonly<{
  field: RealtimeSettingsFieldDescriptor;
  autoprovision: Autoprovision;
  config: Readonly<Record<string, unknown>>;
  credentialExists: boolean;
  targetKey: string;
  onAgentId: (agentId: string) => void;
}>) {
  const busyRef = React.useRef(false);
  const [busy, setBusy] = React.useState<'create' | 'update' | null>(null);
  const operationControllerRef = React.useRef<AbortController | null>(null);
  const targetKeyRef = React.useRef(props.targetKey);
  targetKeyRef.current = props.targetKey;
  const targetGenerationRef = React.useRef(0);
  React.useEffect(() => {
    operationControllerRef.current?.abort();
    operationControllerRef.current = null;
    targetGenerationRef.current += 1;
    busyRef.current = false;
    setBusy(null);
  }, [props.targetKey]);
  React.useEffect(() => () => {
    operationControllerRef.current?.abort();
    operationControllerRef.current = null;
    targetGenerationRef.current += 1;
  }, []);
  const agentIdValue = readRealtimeProviderConfigPath(props.config, props.field.pathSegments);
  const agentId = typeof agentIdValue === 'string' && agentIdValue.trim() ? agentIdValue : null;
  const ttsPath = typeof props.field.ttsPath === 'string' ? props.field.ttsPath.split('.') : [];
  const ttsValue = ttsPath.length > 0 ? record(readRealtimeProviderConfigPath(props.config, ttsPath)) : null;
  if (!ttsValue) return null;
  const tts = ttsValue as BundledConversationTtsConfigInput;

  const run = (kind: 'create' | 'update') => {
    if (busyRef.current || !props.credentialExists || (kind === 'update' && !agentId)) return;
    const targetKey = props.targetKey;
    const targetGeneration = targetGenerationRef.current;
    const controller = new AbortController();
    operationControllerRef.current = controller;
    const targetIsCurrent = () => targetKeyRef.current === targetKey
      && targetGenerationRef.current === targetGeneration
      && !controller.signal.aborted;
    busyRef.current = true;
    setBusy(kind);
    fireAndForget((async () => {
      try {
        if (kind === 'update' && agentId) {
          await props.autoprovision.updateAgent({ agentId, tts }, controller.signal);
          if (!targetIsCurrent()) return;
          await Modal.alertAsync(t('common.success'), tLoose('settingsVoice.byo.autoprovUpdated'));
          return;
        }
        const existing = await props.autoprovision.findExistingAgents(controller.signal);
        if (!targetIsCurrent()) return;
        if (existing.length > 0) {
          const candidate = existing[0]!;
          const decision = await showBundledVoiceAgentReuseDialog({
            existingAgentId: candidate.agentId,
            existingAgentName: candidate.name,
          });
          if (!targetIsCurrent()) return;
          if (decision === 'cancel') return;
          if (decision === 'update_existing') {
            await props.autoprovision.updateAgent(
              { agentId: candidate.agentId, tts },
              controller.signal,
            );
            if (!targetIsCurrent()) return;
            props.onAgentId(candidate.agentId);
            await Modal.alertAsync(t('common.success'), tLoose('settingsVoice.byo.autoprovUpdated'));
            return;
          }
        }
        const created = await props.autoprovision.createAgent({ tts }, controller.signal);
        if (!targetIsCurrent()) return;
        props.onAgentId(created.agentId);
        await Modal.alertAsync(t('common.success'), t('settingsVoice.byo.autoprovCreated', { agentId: created.agentId }));
      } catch (error) {
        if (!targetIsCurrent()) return;
        await Modal.alertAsync(t('common.error'), formatAutoprovisionFailureMessage(error));
      } finally {
        if (targetIsCurrent()) {
          operationControllerRef.current = null;
          busyRef.current = false;
          setBusy(null);
        }
      }
    })(), { tag: `BundledConversationSettings.autoprovision.${kind}` });
  };

  return <>
    <Item
      testID="voice-realtime-autoprovision-create"
      title={tLoose(String(props.field.titleKey ?? 'settingsVoice.byo.autoprovCreate'))}
      subtitle={tLoose(String(props.field.subtitleKey ?? 'settingsVoice.byo.autoprovCreateSubtitle'))}
      loading={busy === 'create'}
      disabled={busy !== null || !props.credentialExists}
      onPress={() => run('create')}
    />
    <Item
      testID="voice-realtime-autoprovision-update"
      title={tLoose('settingsVoice.byo.autoprovUpdate')}
      subtitle={tLoose('settingsVoice.byo.autoprovUpdateSubtitle')}
      loading={busy === 'update'}
      disabled={busy !== null || !props.credentialExists || !agentId}
      onPress={() => run('update')}
    />
  </>;
}

function UnavailableSettings(props: Readonly<{ status: string }>) {
  return <ItemGroup title={tLoose('settingsVoice.realtimeProviders.unavailable.title')}>
    <Item
      title={tLoose('settingsVoice.realtimeProviders.unavailable.rowTitle')}
      subtitle={tLoose(`settingsVoice.realtimeProviders.unavailable.${props.status}`)}
    />
  </ItemGroup>;
}

export function BundledConversationSettingsSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}>) {
  const voice = React.useMemo(() => voiceSettingsParse(props.voice), [props.voice]);
  const latestVoiceRef = React.useRef(voice);
  latestVoiceRef.current = voice;
  const providerId = resolveVoiceProviderId(voice.providerId);
  const registrationsRevision = React.useSyncExternalStore(
    subscribeExternalVoiceProviderRegistrations,
    getExternalVoiceProviderRegistrationsRevision,
    getExternalVoiceProviderRegistrationsRevision,
  );
  const bundledUi = React.useMemo(
    () => providerId ? createUiSafely(providerId) : null,
    [providerId, registrationsRevision],
  );
  const descriptor = React.useMemo(
    () => providerId && bundledUi ? parseRealtimeSettingsDescriptor(providerId, bundledUi.settingsDescriptor) : null,
    [bundledUi, providerId],
  );
  const owner = React.useMemo<RealtimeProviderSettingsOwner | null>(() => bundledUi ? Object.freeze({
    ...bundledUi.settingsOwner,
    schemaVersion: bundledUi.settingsOwner.currentSchemaVersion,
  }) : null, [bundledUi]);
  const envelope = providerId ? voice.providers?.[providerId] ?? null : null;
  const resolved = React.useMemo(
    () => owner ? resolveRealtimeProviderConfig(owner, envelope) : null,
    [envelope, owner],
  );
  const config = resolved?.status === 'ready' ? resolved.config : null;
  const latestProviderConfigRef = React.useRef<Readonly<Record<string, unknown>> | null>(config);
  latestProviderConfigRef.current = config;
  const billingMode = config && typeof config.billingMode === 'string' ? config.billingMode : null;
  const byoActive = descriptor?.mode === 'byo' || billingMode === 'byo';
  const authentication = config ? record(config.authentication) : null;
  const savedSecretActive = authentication?.source === undefined
    || authentication.source === 'voice_saved_secret';
  const visibleDescriptor = React.useMemo<RealtimeSettingsDescriptor | null>(() => {
    if (!descriptor || byoActive || !descriptor.modes.includes('byo')) return descriptor;
    return Object.freeze({ ...descriptor, fields: Object.freeze(descriptor.fields.filter((field) => field.kind === 'welcome')) });
  }, [byoActive, descriptor]);
  const credentialTargetKey = providerId ?? '';
  const [credentialState, setCredentialState] = React.useState<Readonly<{
    targetKey: string;
    status: Readonly<{ exists: boolean }> | null;
  }> | null>(null);
  const credentialAvailability = credentialState?.targetKey === credentialTargetKey ? credentialState.status : null;
  const [catalogState, setCatalogState] = React.useState<Readonly<{
    targetKey: string;
    value: RealtimeCatalogState;
  }> | null>(null);
  const catalog: RealtimeCatalogState = catalogState?.targetKey === credentialTargetKey
    ? catalogState.value
    : { phase: 'idle' };
  const catalogRequestRef = React.useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });

  const persistConfig = React.useCallback((next: Readonly<Record<string, unknown>>) => {
    if (!providerId) return;
    props.setVoice(writeVoiceProviderSettingsConfig(latestVoiceRef.current, providerId, next));
  }, [props.setVoice, providerId]);

  const requestCatalog = React.useCallback(() => {
    if (!bundledUi?.client || credentialAvailability?.exists !== true) return;
    if (catalog.phase === 'loading') return;
    const client = bundledUi.client;
    catalogRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = catalogRequestRef.current.generation + 1;
    catalogRequestRef.current = { generation, controller };
    const targetKey = credentialTargetKey;
    setCatalogState({ targetKey, value: { phase: 'loading' } });
    void fetchCatalog(client, controller.signal).then((rows) => {
      if (catalogRequestRef.current.generation === generation && !controller.signal.aborted) {
        setCatalogState({ targetKey, value: { phase: 'ready', rows } });
      }
    }).catch(() => {
      if (catalogRequestRef.current.generation === generation && !controller.signal.aborted) {
        setCatalogState({ targetKey, value: { phase: 'error' } });
      }
    });
  }, [bundledUi, catalog.phase, credentialAvailability?.exists, credentialTargetKey]);

  React.useEffect(() => {
    catalogRequestRef.current.controller?.abort();
    catalogRequestRef.current = { generation: catalogRequestRef.current.generation + 1, controller: null };
    setCatalogState({ targetKey: credentialTargetKey, value: { phase: 'idle' } });
  }, [credentialTargetKey]);

  React.useEffect(() => () => catalogRequestRef.current.controller?.abort(), []);

  const onCredentialStatusChanged = React.useCallback((status: Readonly<{ exists: boolean }>) => {
    setCredentialState({ targetKey: credentialTargetKey, status });
  }, [credentialTargetKey]);
  const onCredentialChanged = React.useCallback(
    () => setCatalogState({ targetKey: credentialTargetKey, value: { phase: 'idle' } }),
    [credentialTargetKey],
  );

  if (!providerId || !bundledUi) return null;
  if (!descriptor || !owner || !visibleDescriptor) {
    return <UnavailableSettings status="provider" />;
  }
  if (!resolved || resolved.status !== 'ready' || !config) return <UnavailableSettings status={resolved?.status ?? 'invalid'} />;

  const credential = descriptor.credential;
  const credentialSettingsVisible = byoActive
    && savedSecretActive
    && credential.kind === 'api_key';
  const accountCredentialSlot = providerRegistry.get(providerId)?.accountCredentialSlot;
  const primarySettingsVisible = credentialSettingsVisible
    || visibleDescriptor.fields.length > 0;
  const visibleLinks = byoActive
    ? Object.entries(descriptor.links).flatMap(([kind, rawUrl]) => (
      typeof rawUrl === 'string' ? [{ kind, url: rawUrl }] : []
    ))
    : [];
  const renderAutoprovision = (field: RealtimeSettingsFieldDescriptor) => bundledUi.autoprovision ? <AutoprovisionItems
    field={field}
    autoprovision={bundledUi.autoprovision}
    config={config}
    credentialExists={credentialAvailability?.exists === true}
    targetKey={credentialTargetKey}
    onAgentId={(agentId) => {
      const latestConfig = latestProviderConfigRef.current;
      if (!latestConfig) return;
      const next = updateRealtimeProviderConfig(owner, latestConfig, field.pathSegments, agentId);
      if (next) persistConfig(next);
    }}
  /> : null;

  if (!primarySettingsVisible && visibleLinks.length === 0) return null;

  return <>
    {!primarySettingsVisible ? null : <ItemGroup
      title={descriptor.titleKey ? tLoose(descriptor.titleKey) : tLoose('settingsVoice.realtimeProviders.setup.title')}
      footer={descriptor.footerKey ? tLoose(descriptor.footerKey) : undefined}
    >
      {!credentialSettingsVisible ? null : <VoiceCredentialItem
        key={credentialTargetKey}
        title={tLoose(String(credential.titleKey ?? 'settingsVoice.realtimeProviders.credential.title'))}
        promptTitle={tLoose(String(credential.promptTitleKey ?? 'settingsVoice.realtimeProviders.credential.promptTitle'))}
        promptDescription={tLoose(String(credential.promptBodyKey ?? 'settingsVoice.realtimeProviders.credential.promptBody'))}
        providerId={providerId}
        credentialSlotId={credential.kind}
        recipientContract={accountCredentialSlot?.id === credential.kind
          ? accountCredentialSlot.recipientContract
          : null}
        recipientContractDigest={accountCredentialSlot?.id === credential.kind
          ? accountCredentialSlot.recipientContractDigest
          : null}
        disclosePlainStorage={true}
        onStatusChanged={onCredentialStatusChanged}
        onChanged={onCredentialChanged}
      />}
      <RealtimeProviderFields
        providerId={providerId}
        descriptor={visibleDescriptor}
        owner={owner}
        config={config}
        onConfigChange={persistConfig}
        credentialExists={credentialAvailability?.exists === true}
        catalog={catalog}
        onRequestCatalog={requestCatalog}
        popoverBoundaryRef={props.popoverBoundaryRef}
        welcomeSelection={resolveVoiceWelcomeSelection(voice.welcome)}
        onWelcomeSelection={(selection) => props.setVoice(applyVoiceWelcomeSelection(
          voice,
          selection === 'off' ? 'off' : selection === 'on_first_turn' ? 'on_first_turn' : 'immediate',
        ))}
        renderAutoprovision={renderAutoprovision}
        renderConnectedServicesBinding={(field, value, onChange) => (
          <VoiceGlobalConnectedServicesBindingField
            agentId={field.agentId}
            serviceIds={field.serviceIds}
            titleKey={field.titleKey}
            subtitleKey={field.subtitleKey}
            value={value}
            onChange={onChange}
          />
        )}
      />
    </ItemGroup>}

    {visibleLinks.length === 0 ? null : <ItemGroup title={tLoose('settingsVoice.realtimeProviders.links.title')}>
      {visibleLinks.map(({ kind, url }) => <Item
        key={kind}
        title={tLoose(`settingsVoice.realtimeProviders.links.${kind}.title`)}
        subtitle={tLoose(`settingsVoice.realtimeProviders.links.${kind}.subtitle`)}
        onPress={() => fireAndForget((async () => {
          if (await Linking.canOpenURL(url)) await Linking.openURL(url);
        })(), { tag: `BundledConversationSettings.openLink.${kind}` })}
      />)}
    </ItemGroup>}

  </>;
}
