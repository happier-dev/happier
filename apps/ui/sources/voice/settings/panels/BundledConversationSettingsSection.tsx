import * as React from 'react';
import { Linking, Platform } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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
  type BundledConversationVoiceCatalogItem,
} from '@/voice/credentials/bundledConversationClient';
import {
  VoiceCredentialItem,
  type VoiceCredentialItemStatus,
} from '@/voice/credentials/CredentialItem';
import { shouldUseVoiceCredentialSourceMutationForSavedSecret } from '@/voice/credentials/accountVoiceCredential';
import {
  getExternalVoiceProviderRegistrationsRevision,
  subscribeExternalVoiceProviderRegistrations,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';

import {
  parseRealtimeSettingsDescriptor,
  readRealtimeSavedSecretCredentialPurpose,
  resolveRealtimeProviderConfig,
  type RealtimeProviderSettingsOwner,
  type RealtimeSettingsDescriptor,
} from './realtime/descriptor';
import {
  RealtimeProviderFields,
  type RealtimeCatalogState,
} from './realtime/RealtimeProviderFields';
import {
  VoiceCredentialSourceField,
  type VoiceCredentialSourceFieldStatus,
} from './realtime/VoiceCredentialSourceField';
import { VoiceProviderSettingsActions } from './realtime/VoiceProviderSettingsActions';

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

async function fetchCatalog(client: BundledConversationProviderClient, signal?: AbortSignal | null) {
  return normalizeCatalogRows(await client.fetchVoiceCatalog(signal));
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
  const billingMode = config && typeof config.billingMode === 'string' ? config.billingMode : null;
  const byoActive = descriptor?.mode === 'byo' || billingMode === 'byo';
  const providerEntry = providerId ? providerRegistry.get(providerId) : null;
  const settingsActions = providerEntry?.kind === 'voice.conversation-provider.v1'
    && providerEntry.declaration?.kind === 'conversation'
    ? providerEntry.declaration.settings?.actions ?? []
    : [];
  const contribution = React.useMemo(() => (
    providerEntry?.kind === 'voice.conversation-provider.v1'
      && providerEntry.declaration?.kind === 'conversation'
      ? Object.freeze({
          pluginId: providerEntry.pluginId,
          localId: providerEntry.declaration.id,
        })
      : null
  ), [providerEntry]);
  const credentialDeclaration = providerEntry?.kind === 'voice.conversation-provider.v1'
    && providerEntry.declaration?.kind === 'conversation'
    ? providerEntry.declaration.credentials ?? null
    : null;
  const credentialProviderDeclaration = providerEntry?.kind === 'voice.conversation-provider.v1'
    && providerEntry.declaration?.kind === 'conversation'
    ? providerEntry.declaration
    : null;
  const visibleDescriptor = React.useMemo<RealtimeSettingsDescriptor | null>(() => {
    if (!descriptor || byoActive || !descriptor.modes.includes('byo')) return descriptor;
    return Object.freeze({ ...descriptor, fields: Object.freeze(descriptor.fields.filter((field) => field.kind === 'welcome')) });
  }, [byoActive, descriptor]);
  const credentialTargetKey = providerId ?? '';
  const [credentialState, setCredentialState] = React.useState<Readonly<{
    targetKey: string;
    status: VoiceCredentialItemStatus | null;
  }> | null>(null);
  const credentialAvailability = credentialState?.targetKey === credentialTargetKey ? credentialState.status : null;
  const [credentialSourceState, setCredentialSourceState] = React.useState<Readonly<{
    targetKey: string;
    status: VoiceCredentialSourceFieldStatus;
  }> | null>(null);
  const credentialSourceStatus = credentialSourceState?.targetKey === credentialTargetKey
    ? credentialSourceState.status
    : null;
  const selectedSavedSecretRawReviewGrants = React.useMemo(() => {
    if (credentialSourceStatus?.selection.kind !== 'savedSecret') return [];
    const realm = Platform.OS === 'web' || Platform.OS === 'ios' || Platform.OS === 'android'
      ? Platform.OS
      : null;
    if (!realm) return [];
    return credentialDeclaration?.sources
      .filter((source) => source.kind === 'savedSecret')
      .flatMap((source) => source.rawGrants ?? [])
      .filter((grant) => grant.realm === realm && grant.phase === 'prepare')
      ?? [];
  }, [credentialDeclaration, credentialSourceStatus?.selection.kind]);
  const credentialUsable = credentialDeclaration && credentialDeclaration.sources.length > 1
    ? credentialSourceStatus?.selection.kind === 'connectedAccount'
      ? credentialSourceStatus.usable
      : credentialSourceStatus?.selection.kind === 'savedSecret'
        ? credentialAvailability?.usable === true
        : false
    : credentialAvailability?.usable === true;
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
    if (!bundledUi?.client || !credentialUsable) return;
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
  }, [bundledUi, catalog.phase, credentialTargetKey, credentialUsable]);

  React.useEffect(() => {
    catalogRequestRef.current.controller?.abort();
    catalogRequestRef.current = { generation: catalogRequestRef.current.generation + 1, controller: null };
    setCatalogState({ targetKey: credentialTargetKey, value: { phase: 'idle' } });
  }, [credentialTargetKey]);

  React.useEffect(() => () => catalogRequestRef.current.controller?.abort(), []);

  const onCredentialStatusChanged = React.useCallback((status: VoiceCredentialItemStatus) => {
    setCredentialState({ targetKey: credentialTargetKey, status });
  }, [credentialTargetKey]);
  const onCredentialSourceStatusChanged = React.useCallback((status: VoiceCredentialSourceFieldStatus) => {
    setCredentialSourceState({ targetKey: credentialTargetKey, status });
  }, [credentialTargetKey]);
  const credentialSourceIsCurrent = React.useCallback(() => {
    if (!providerId) return false;
    if (resolveVoiceProviderId(latestVoiceRef.current.providerId) !== providerId) return false;
    return providerRegistry.get(providerId)?.kind === 'voice.conversation-provider.v1';
  }, [providerId]);
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
    && credential.kind === 'api_key'
    && credentialDeclaration?.sources.some((source) => source.kind === 'savedSecret') === true;
  const credentialSourceVisible = byoActive
    && contribution !== null
    && credentialDeclaration !== null
    && credentialDeclaration.sources.some((source) => source.kind === 'connectedAccount');
  const accountCredentialSlot = providerRegistry.get(providerId)?.accountCredentialSlot;
  const primarySettingsVisible = credentialSettingsVisible
    || credentialSourceVisible
    || visibleDescriptor.fields.length > 0
    || settingsActions.length > 0;
  const visibleLinks = byoActive
    ? Object.entries(descriptor.links).flatMap(([kind, rawUrl]) => (
      typeof rawUrl === 'string' ? [{ kind, url: rawUrl }] : []
    ))
    : [];
  if (!primarySettingsVisible && visibleLinks.length === 0) return null;

  return <>
    {!primarySettingsVisible ? null : <ItemGroup
      title={descriptor.titleKey ? tLoose(descriptor.titleKey) : tLoose('settingsVoice.realtimeProviders.setup.title')}
      footer={descriptor.footerKey ? tLoose(descriptor.footerKey) : undefined}
    >
      {!credentialSourceVisible || !contribution || !credentialDeclaration || !credentialProviderDeclaration ? null : <VoiceCredentialSourceField
        contribution={contribution}
        declaration={credentialProviderDeclaration}
        credentials={credentialDeclaration}
        popoverBoundaryRef={props.popoverBoundaryRef}
        onStatusChanged={onCredentialSourceStatusChanged}
        isCurrent={credentialSourceIsCurrent}
      />}
      {!credentialSettingsVisible ? null : <VoiceCredentialItem
        key={credentialTargetKey}
        title={tLoose(String(credential.titleKey ?? 'settingsVoice.realtimeProviders.credential.title'))}
        promptTitle={tLoose(String(credential.promptTitleKey ?? 'settingsVoice.realtimeProviders.credential.promptTitle'))}
        promptDescription={tLoose(String(credential.promptBodyKey ?? 'settingsVoice.realtimeProviders.credential.promptBody'))}
        contribution={contribution}
        credentialSlotId={credential.kind}
        credentialSourcePurpose={shouldUseVoiceCredentialSourceMutationForSavedSecret(
          credentialSourceVisible ? credentialSourceStatus?.selection : null,
        )
          ? credentialSourceVisible
            ? credentialDeclaration?.slot.purpose
            : readRealtimeSavedSecretCredentialPurpose(descriptor) ?? undefined
          : undefined}
        credentialSourceDeclaration={credentialProviderDeclaration ?? undefined}
        rawCredentialReviewGrants={selectedSavedSecretRawReviewGrants}
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
        credentialStatus={credentialAvailability?.status ?? 'missing'}
        catalog={catalog}
        onRequestCatalog={requestCatalog}
        popoverBoundaryRef={props.popoverBoundaryRef}
        welcomeSelection={resolveVoiceWelcomeSelection(voice.welcome)}
        onWelcomeSelection={(selection) => props.setVoice(applyVoiceWelcomeSelection(
          voice,
          selection === 'off' ? 'off' : selection === 'on_first_turn' ? 'on_first_turn' : 'immediate',
        ))}
        renderAfterField={(field) => <VoiceProviderSettingsActions
          providerId={providerId}
          owner={owner}
          actions={settingsActions}
          config={config}
          placement={{ kind: 'afterField', fieldId: field.path }}
        />}
      />
      <VoiceProviderSettingsActions
        providerId={providerId}
        owner={owner}
        actions={settingsActions}
        config={config}
        placement={{ kind: 'contributionFooter' }}
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
