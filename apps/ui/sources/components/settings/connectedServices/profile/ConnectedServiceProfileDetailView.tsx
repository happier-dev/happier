import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { deleteConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { connectedServiceProfileKey, resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { ConnectedServiceQuotaCard } from '../ConnectedServiceQuotaCard';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export const ConnectedServiceProfileDetailView = React.memo(function ConnectedServiceProfileDetailView() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const profile = useProfile();
  const settings = useSettings();

  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

  const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam((params as Record<string, unknown>).profileId).trim();

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('settings.connectedAccounts')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>{t('settings.connectedAccountsDisabled')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  if (!serviceId || !profileId) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>{t('connectedServices.oauthPaste.invalidConfig')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  const entry = getConnectedServiceRegistryEntry(serviceId);
  const svc = profile.connectedServicesV2.find((s) => s.serviceId === serviceId) ?? null;
  const profileRecord = (svc?.profiles ?? []).find((p) => p.profileId === profileId) ?? null;
  const status = profileRecord?.status === 'connected' ? 'connected' : 'needs_reauth';
  const providerEmail = typeof profileRecord?.providerEmail === 'string' ? profileRecord.providerEmail : '';
  const providerAccountId = typeof profileRecord?.providerAccountId === 'string' ? profileRecord.providerAccountId : '';

  const label = resolveConnectedServiceProfileLabel({
    labelsByKey: settings.connectedServicesProfileLabelByKey,
    serviceId,
    profileId,
  });
  const title = label || profileId;

  const isDefault = (settings.connectedServicesDefaultProfileByServiceId[serviceId] ?? '') === profileId;

  const ensureCredentials = () => {
    if (!auth.credentials) {
      throw new Error('Not authenticated');
    }
    return auth.credentials;
  };

  const handleDisconnect = async () => {
    const ok = await Modal.confirm(
      t('modals.disconnect'),
      t('connectedServices.detail.disconnectConfirmBody', { service: entry.displayName, profileId }),
      { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    const credentials = ensureCredentials();
    await deleteConnectedServiceCredentialForAccount(credentials, { serviceId, profileId });
    await sync.refreshProfile();
    router.back();
  };

  const handleSetDefault = async () => {
    const nextMap = { ...settings.connectedServicesDefaultProfileByServiceId };
    if (isDefault) delete nextMap[serviceId];
    else nextMap[serviceId] = profileId;
    await sync.applySettings({ connectedServicesDefaultProfileByServiceId: nextMap });
  };

  const handleEditLabel = async () => {
    const key = connectedServiceProfileKey({ serviceId, profileId });
    const currentLabelRaw =
      resolveConnectedServiceProfileLabel({
        labelsByKey: settings.connectedServicesProfileLabelByKey,
        serviceId,
        profileId,
      }) ?? settings.connectedServicesProfileLabelByKey[key];
    const currentLabel = typeof currentLabelRaw === 'string' ? currentLabelRaw : '';
    const next = await Modal.prompt(
      t('connectedServices.detail.prompts.profileLabelTitle'),
      t('connectedServices.detail.prompts.profileLabelBody'),
      {
        placeholder: t('connectedServices.detail.prompts.profileLabelPlaceholder'),
        defaultValue: currentLabel,
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    if (typeof next !== 'string') return;
    const trimmed = next.trim();

    const nextMap = { ...settings.connectedServicesProfileLabelByKey };
    if (trimmed) nextMap[key] = trimmed;
    else delete nextMap[key];

    await sync.applySettings({ connectedServicesProfileLabelByKey: nextMap });
  };

  const pinnedKey = connectedServiceProfileKey({ serviceId, profileId });
  const pinnedMeterIds = settings.connectedServicesQuotaPinnedMeterIdsByKey[pinnedKey] ?? [];

  const setPinnedQuotaMeters = async (nextPinned: ReadonlyArray<string>) => {
    const nextMap = { ...settings.connectedServicesQuotaPinnedMeterIdsByKey };
    if (nextPinned.length === 0) delete nextMap[pinnedKey];
    else nextMap[pinnedKey] = [...nextPinned];
    await sync.applySettings({ connectedServicesQuotaPinnedMeterIdsByKey: nextMap });
  };

  return (
    <ItemList>
      <ItemGroup title={`${entry.displayName} • ${title}`}>
        <Item
          title={t('connectedServices.profile.profileId')}
          subtitle={profileId}
          showChevron={false}
        />
        <Item
          title={t('connectedServices.profile.status')}
          subtitle={status === 'connected' ? t('connectedServices.detail.profiles.connected') : t('connectedServices.detail.profiles.needsReauth')}
          showChevron={false}
        />
        {providerEmail ? (
          <Item
            title={t('connectedServices.profile.email')}
            subtitle={providerEmail}
            showChevron={false}
          />
        ) : null}
        {providerAccountId ? (
          <Item
            title={t('connectedServices.profile.accountId')}
            subtitle={providerAccountId}
            showChevron={false}
          />
        ) : null}
      </ItemGroup>

      {quotasEnabled && status === 'connected' ? (
        <ConnectedServiceQuotaCard
          serviceId={serviceId}
          profileId={profileId}
          title={t('connectedServices.profile.quotaTitle')}
          pinnedMeterIds={pinnedMeterIds}
          onSetPinnedMeterIds={(next) => void setPinnedQuotaMeters(next)}
        />
      ) : null}

      <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
        <Item
          title={isDefault ? t('connectedServices.detail.actions.unsetDefault') : t('connectedServices.detail.actions.setDefault')}
          subtitle={isDefault ? t('connectedServices.profile.defaultSubtitle') : t('connectedServices.profile.setDefaultSubtitle')}
          icon={<Ionicons name={isDefault ? 'star' : 'star-outline'} size={22} color={theme.colors.accent.blue} />}
          onPress={() => void handleSetDefault()}
        />
        <Item
          title={t('connectedServices.detail.actions.editLabel')}
          subtitle={t('connectedServices.detail.setProfileLabelSubtitle')}
          icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={() => void handleEditLabel()}
        />
        {status === 'connected' ? (
          <Item
            title={t('modals.disconnect')}
            subtitle={t('connectedServices.profile.disconnectSubtitle')}
            icon={<Ionicons name="trash-outline" size={22} color={theme.colors.deleteAction} />}
            onPress={() => void handleDisconnect()}
          />
        ) : (
          <Item
            title={t('connectedServices.detail.actions.reconnect')}
            subtitle={t('connectedServices.profile.reconnectSubtitle')}
            icon={<Ionicons name="refresh-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={() => router.push({ pathname: '/(app)/settings/connected-services/oauth', params: { serviceId, profileId } })}
          />
        )}
      </ItemGroup>
    </ItemList>
  );
});
