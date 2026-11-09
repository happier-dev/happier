import * as React from 'react';
import { Platform } from 'react-native';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import {
  VoiceCredentialItem,
  type VoiceCredentialItemStatus,
} from '@/voice/credentials/CredentialItem';
import {
  resolveSelectedVoiceCredentialRawGrants,
  shouldUseVoiceCredentialSourceMutationForSavedSecret,
} from '@/voice/credentials/accountVoiceCredential';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';

import {
  readRealtimeSavedSecretCredentialPurpose,
  resolveVisibleRealtimeSettingsDescriptor,
  type RealtimeSettingsDescriptor,
} from './realtime/descriptor';
import { RealtimeProviderFields } from './realtime/RealtimeProviderFields';
import { useRealtimeVoiceCatalog } from './realtime/realtimeVoiceCatalogMenu';
import { useBundledConversationProviderSettings } from './realtime/useBundledConversationProviderSettings';
import { readDeclaredVoiceSettingsCatalog } from './realtime/voiceCatalog';
import {
  VoiceCredentialSourceField,
  type VoiceCredentialSourceFieldStatus,
} from './realtime/VoiceCredentialSourceField';
import { VoiceProviderSettingsActions } from './realtime/VoiceProviderSettingsActions';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceContributedSettingRefs } from '@/voice/settings/useVoiceContributedSettingRefs';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useVoiceSettingsSearchPrerequisite } from '@/voice/settings/VoiceSettingsSearchPrerequisite';

const providerRegistry = createDefaultVoiceProviderRegistry();

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
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
  popoverBoundaryRef?: React.RefObject<any> | null;
  /**
   * Rows the host owns that belong at the top of the service's account group (the service's Pay with
   * choice), so the page shows one Account section whatever the service contributes. Without a
   * contributed account group they stand in their own Account section.
   */
  accountLead?: React.ReactNode;
}>) {
  const searchPrerequisite = useVoiceSettingsSearchPrerequisite();
  const voice = React.useMemo(() => voiceSettingsParse(props.voice), [props.voice]);
  const accountLeadOnly = props.accountLead ? (
    <ItemGroup
      title={t('settingsVoice.pages.conversations.accountTitle')}
      description={t('settingsVoice.pages.conversations.accountDescription')}
    >
      {props.accountLead}
    </ItemGroup>
  ) : null;
  const latestVoiceRef = React.useRef(voice);
  latestVoiceRef.current = voice;
  const { providerId, bundledUi, descriptor, owner, resolved, config, sessionChoice } = useBundledConversationProviderSettings(voice);
  const settingRef = useVoiceContributedSettingRefs(providerId ?? '');
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
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
    return descriptor ? resolveVisibleRealtimeSettingsDescriptor(descriptor, config) : null;
  }, [config, descriptor]);
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
    if (!credentialProviderDeclaration || !contribution) return [];
    return resolveSelectedVoiceCredentialRawGrants({
      declaration: credentialProviderDeclaration,
      contribution,
      selection: credentialSourceStatus.selection,
      access: { realm, phase: 'prepare' },
    });
  }, [contribution, credentialProviderDeclaration, credentialSourceStatus?.selection]);
  const credentialUsable = credentialDeclaration?.sources.some((source) => source.kind === 'connectedAccount')
    ? credentialSourceStatus?.selection.kind === 'connectedAccount'
      ? credentialSourceStatus.usable
      : credentialSourceStatus?.selection.kind === 'savedSecret'
        ? credentialAvailability?.usable === true
        : false
    : credentialAvailability?.usable === true;
  const declaredRows = React.useMemo(() => sessionChoice?.declaration
    ? readDeclaredVoiceSettingsCatalog(sessionChoice.declaration) : null, [sessionChoice?.declaration]);
  const { catalog, requestCatalog, resetCatalog } = useRealtimeVoiceCatalog({
    providerId,
    catalogAvailable: Boolean(bundledUi?.client), credentialUsable, targetKey: sessionChoice?.targetKey ?? credentialTargetKey,
    declaredRows,
  });

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
  const onCredentialChanged = resetCatalog;

  if (!providerId || !bundledUi) return accountLeadOnly;
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
  const primarySettingsVisible = credentialSettingsVisible
    || credentialSourceVisible
    || visibleDescriptor.fields.length > 0
    || settingsActions.length > 0;
  const visibleLinks = byoActive
    ? Object.entries(descriptor.links).flatMap(([kind, rawUrl]) => (
      typeof rawUrl === 'string' ? [{ kind, url: rawUrl }] : []
    ))
    : [];
  const hiddenSettings = descriptor.fields.filter((field) => !visibleDescriptor.fields.includes(field))
    .flatMap((field) => [settingRef(field.path), settingRef(`${field.path}.preview`), settingRef(`${field.path}.stopPreview`),
      ...(field.kind === 'server_vad' && Array.isArray(field.subfields) ? field.subfields.flatMap((raw: unknown) => {
        const subfield = record(raw);
        return typeof subfield?.path === 'string' ? [settingRef(subfield.path)] : [];
      }) : [])]);
  const ownAccount = providerEntry?.selectionOptions?.find((option) => option.modeId === 'byo');
  const prerequisite = ownAccount && !byoActive ? searchPrerequisite({ settings: [...hiddenSettings, ...(!credentialSettingsVisible ? [settingRef('credential')] : []),
      ...(!credentialSourceVisible ? [settingRef('credentialSource')] : [])], reason: t('settingsVoice.pages.search.select', { choice: tLoose(ownAccount.titleKey), control: t('settingsVoice.pages.conversations.payWithTitle') }), group: true }) : null;
  if (!primarySettingsVisible && visibleLinks.length === 0) return <>{accountLeadOnly}{prerequisite}</>;

  const credentialControls = <>
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
        disclosePlainStorage={true}
        onStatusChanged={onCredentialStatusChanged}
        onChanged={onCredentialChanged}
      />}
  </>;
  const credentialSetting = settingRef('credential');
  const sourceSetting = settingRef('credentialSource');
  const anchoredCredentialControls = <SettingAnchor settings={[credentialSetting, sourceSetting].filter((setting) => setting !== undefined)}>
    {credentialControls}
  </SettingAnchor>;
  const groups: NonNullable<RealtimeSettingsDescriptor['groups']> = visibleDescriptor.groups ?? [{
    id: 'provider',
    titleKey: descriptor.titleKey ?? 'settingsVoice.realtimeProviders.setup.title',
    includeCredentials: true,
    fieldPaths: visibleDescriptor.fields.map((field) => field.path),
  }];
  const credentialsAssigned = groups.some((group) => group.includeCredentials === true);
  const accountGroupIndex = credentialsAssigned ? groups.findIndex((group) => group.includeCredentials === true) : 0;
  // One rule with the fields beneath (RealtimeProviderFields): a plain string is a host translation key
  // or the author's literal text (an unknown key resolves to itself); a localized object belongs to the
  // contributing plugin's catalog. Installed and generated descriptors of one service read the same.
  const presentationText = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return tLoose(value);
    if (providerEntry) return localizePluginText(providerEntry.pluginId, value);
    const localized = record(value);
    return typeof localized?.key === 'string' ? tLoose(localized.key)
      : typeof localized?.fallback === 'string' ? localized.fallback : undefined;
  };

  return <>
    {prerequisite}
    {!primarySettingsVisible ? accountLeadOnly : groups.map((group, index) => {
      const fields = visibleDescriptor.fields.filter((field) => group.fieldPaths.includes(field.path));
      const finalGroup = index === groups.length - 1;
      const includeCredentials = group.includeCredentials === true || (!credentialsAssigned && index === 0);
      const accountLead = index === accountGroupIndex ? props.accountLead : null;
      if (fields.length === 0 && !accountLead && !(includeCredentials && (credentialSettingsVisible || credentialSourceVisible))
        && !(finalGroup && settingsActions.some((action) => action.placement?.kind === 'contributionFooter'))) return null;
      return <ItemGroup key={group.id}
        title={presentationText(group.titleKey)}
        description={presentationText(group.descriptionKey) ?? (index === 0 && descriptor.footerKey ? tLoose(descriptor.footerKey) : undefined)}
      >
      {accountLead}
      {includeCredentials ? anchoredCredentialControls : null}
      <RealtimeProviderFields
        providerId={providerId}
        descriptor={{ ...visibleDescriptor, fields }}
        owner={owner}
        config={config}
        credentialStatus={credentialUsable ? 'ready' : credentialAvailability?.status ?? 'missing'}
        catalog={catalog}
        onRequestCatalog={requestCatalog}
        popoverBoundaryRef={props.popoverBoundaryRef}
        welcomeSelection={resolveVoiceWelcomeSelection(voice.welcome)}
        assistantLanguage={voice.assistantLanguage}
        renderAfterField={(field) => <VoiceProviderSettingsActions
          providerId={providerId}
          owner={owner}
          actions={settingsActions}
          agentAction={providerEntry?.presentation?.agentAction}
          config={config}
          placement={{ kind: 'afterField', fieldId: field.path }}
        />}
      />
      {!finalGroup ? null : <VoiceProviderSettingsActions
        providerId={providerId}
        owner={owner}
        actions={settingsActions}
        config={config}
        placement={{ kind: 'contributionFooter' }}
      />}
    </ItemGroup>;
    })}

    {visibleLinks.length === 0 ? null : <ItemGroup title={tLoose(providerEntry?.presentation?.resources?.titleKey ?? 'settingsVoice.realtimeProviders.links.title')}>
      {visibleLinks.map(({ kind, url }) => <Item
        key={kind}
        icon={<Icon name="arrow-square-out" />}
        title={tLoose((kind === 'account' ? providerEntry?.presentation?.resources?.accountTitleKey
          : kind === 'apiKeys' ? providerEntry?.presentation?.resources?.apiKeysTitleKey : undefined)
          ?? `settingsVoice.realtimeProviders.links.${kind}.title`)}
        subtitle={providerEntry?.presentation?.resources ? undefined : tLoose(`settingsVoice.realtimeProviders.links.${kind}.subtitle`)}
        onPress={() => fireAndForget(requestOpenExternalUrl(url), { tag: `BundledConversationSettings.openLink.${kind}` })}
      />)}
    </ItemGroup>}

  </>;
}
