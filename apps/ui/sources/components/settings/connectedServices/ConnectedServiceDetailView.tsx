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
import { useProfile } from '@/sync/store/hooks';
import { useSettings } from '@/sync/store/hooks';
import { deleteConnectedServiceCredentialForAccount, storeConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { connectedServiceProfileKey, resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { ConnectedServiceDetailActionsGroup } from './detail/ConnectedServiceDetailActionsGroup';
import { ConnectedServiceDetailProfilesGroup } from './detail/ConnectedServiceDetailProfilesGroup';
import { ConnectedServiceDetailQuotasSection } from './detail/ConnectedServiceDetailQuotasSection';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export const ConnectedServiceDetailView = React.memo(function ConnectedServiceDetailView() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
  const profile = useProfile();
  const settings = useSettings();

  const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const entry = serviceId ? getConnectedServiceRegistryEntry(serviceId) : null;

  const services = profile.connectedServicesV2;
  const svc = serviceId ? (services.find((s) => s.serviceId === serviceId) ?? null) : null;
  const profiles = svc?.profiles ?? [];
  const defaultProfileIdRaw = serviceId ? settings.connectedServicesDefaultProfileByServiceId[serviceId] : undefined;
  const defaultProfileId = typeof defaultProfileIdRaw === 'string' ? defaultProfileIdRaw.trim() : '';

  const ensureCredentials = () => {
    if (!auth.credentials) {
      throw new Error('Not authenticated');
    }
    return auth.credentials;
  };

  const promptProfileId = async (opts?: { defaultValue?: string }) => {
    const res = await Modal.prompt(
      t('connectedServices.detail.prompts.profileIdTitle'),
      t('connectedServices.detail.prompts.profileIdBody'),
      {
        placeholder: 'work',
        defaultValue: opts?.defaultValue,
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    const profileId = typeof res === 'string' ? res.trim() : '';
    if (!profileId) return null;
    const parsed = ConnectedServiceProfileIdSchema.safeParse(profileId);
    if (!parsed.success) {
      await Modal.alert(
        t('connectedServices.detail.alerts.invalidProfileIdTitle'),
        t('connectedServices.detail.alerts.invalidProfileIdBody'),
      );
      return null;
    }
    return parsed.data;
  };

  const handleDisconnect = async (profileId: string) => {
    const serviceLabel = entry?.displayName ?? serviceId ?? t('connectedServices.fallbackName');
    const ok = await Modal.confirm(
      t('modals.disconnect'),
      t('connectedServices.detail.disconnectConfirmBody', { service: serviceLabel, profileId }),
      { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    const credentials = ensureCredentials();
    await deleteConnectedServiceCredentialForAccount(credentials, { serviceId: serviceId!, profileId });
    await sync.refreshProfile();
  };

  const handleConnectOauth = async (profileId: string) => {
    if (!serviceId || !entry) return;
    if (!entry?.supportsOauth) {
      await Modal.alert(
        t('connect.unsupported.connectTitle', { name: entry?.displayName ?? serviceId ?? t('connectedServices.fallbackName') }),
        t('connect.unsupported.runCommandInTerminalWithCommand', { command: entry.connectCommand }),
        [{ text: t('common.ok'), style: 'cancel' }],
      );
      return;
    }
    try {
      router.push({ pathname: '/(app)/settings/connected-services/oauth', params: { serviceId: serviceId!, profileId } });
    } catch {
      await Modal.alert(
        t('connect.unsupported.connectTitle', { name: entry?.displayName ?? serviceId ?? t('connectedServices.fallbackName') }),
        t('connect.unsupported.runCommandInTerminalWithCommand', { command: entry.connectCommand }),
        [{ text: t('common.ok'), style: 'cancel' }],
      );
    }
  };

  const handleConnectToken = async () => {
    if (!serviceId || !entry) return;
    const profileId = await promptProfileId();
    if (!profileId) return;

    const tokenKind = entry?.tokenKind ?? null;
    const token = await Modal.prompt(
      tokenKind === 'setup-token'
        ? t('connectedServices.detail.prompts.setupTokenTitle')
        : t('connectedServices.detail.prompts.apiKeyTitle'),
      tokenKind === 'setup-token'
        ? t('connectedServices.detail.prompts.setupTokenBody')
        : t('connectedServices.detail.prompts.apiKeyBody'),
      {
        placeholder: tokenKind === 'setup-token' ? 'sk-ant-oat01-…' : 'sk-ant-…',
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    const tokenValue = typeof token === 'string' ? token.trim() : '';
    if (!tokenValue) return;

    const credentials = ensureCredentials();
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: serviceId!,
      profileId,
      kind: 'token',
      token: {
        token: tokenValue,
        providerAccountId: null,
        providerEmail: null,
      },
    });
    await storeConnectedServiceCredentialForAccount(credentials, {
      serviceId: serviceId!,
      profileId,
      record,
    });
    await sync.refreshProfile();
    router.back();
  };

  const handleAddOauthProfile = async () => {
    const profileId = await promptProfileId();
    if (!profileId) return;
    await handleConnectOauth(profileId);
  };

  const handleSetDefaultProfile = async () => {
    if (!serviceId) return;
    if (profiles.length === 0) return;

    const profileId = await promptProfileId({ defaultValue: defaultProfileId || profiles[0]?.profileId });
    if (!profileId) return;
    const exists = profiles.some((p: any) => p?.profileId === profileId);
    if (!exists) {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: entry?.displayName ?? serviceId }),
      );
      return;
    }
    await sync.applySettings({
      connectedServicesDefaultProfileByServiceId: {
        ...settings.connectedServicesDefaultProfileByServiceId,
        [serviceId]: profileId,
      },
    });
  };

  const handleSetProfileLabel = async () => {
    if (!serviceId) return;
    if (profiles.length === 0) return;

    const profileId = await promptProfileId({ defaultValue: profiles[0]?.profileId });
    if (!profileId) return;
    const exists = profiles.some((p: any) => p?.profileId === profileId);
    if (!exists) {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: entry?.displayName ?? serviceId }),
      );
      return;
    }

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

  const [quotaSnapshotsByKey, setQuotaSnapshotsByKey] = React.useState<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>({});

  const setPinnedQuotaMeters = async (profileId: string, nextPinned: ReadonlyArray<string>) => {
    if (!serviceId) return;
    const key = connectedServiceProfileKey({ serviceId, profileId });
    const nextMap = { ...settings.connectedServicesQuotaPinnedMeterIdsByKey };
    if (nextPinned.length === 0) {
      delete nextMap[key];
    } else {
      nextMap[key] = [...nextPinned];
    }
    await sync.applySettings({ connectedServicesQuotaPinnedMeterIdsByKey: nextMap });
  };

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('settings.connectedAccounts')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>{t('settings.connectedAccountsDisabled')}</Text>
          </View>
        </ItemGroup>

        <ItemGroup>
          <Item
            title={t('common.done')}
            icon={<Ionicons name="close-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={() => router.back()}
            showChevron={false}
          />
        </ItemGroup>
      </ItemList>
    );
  }

  if (!serviceId || !entry) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>{t('connectedServices.detail.unknownService')}</Text>
          </View>
        </ItemGroup>
        <ItemGroup>
          <Item
            title={t('common.close')}
            icon={<Ionicons name="close-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={() => router.back()}
            showChevron={false}
          />
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <ConnectedServiceDetailProfilesGroup
        title={entry.displayName}
        serviceId={serviceId}
        profiles={profiles}
        defaultProfileId={defaultProfileId}
        profileLabelsByKey={settings.connectedServicesProfileLabelByKey}
        pinnedMeterIdsByKey={settings.connectedServicesQuotaPinnedMeterIdsByKey}
        quotaSummaryStrategyByKey={settings.connectedServicesQuotaSummaryStrategyByKey}
        quotaSnapshotsByKey={quotaSnapshotsByKey}
        quotasEnabled={quotasEnabled}
        onDisconnect={(profileId) => void handleDisconnect(profileId)}
        onConnectOauth={(profileId) => void handleConnectOauth(profileId)}
      />

      {quotasEnabled ? (
        <ConnectedServiceDetailQuotasSection
          serviceId={serviceId}
          profiles={profiles}
          profileLabelsByKey={settings.connectedServicesProfileLabelByKey}
          pinnedMeterIdsByKey={settings.connectedServicesQuotaPinnedMeterIdsByKey}
          onSetPinnedMeterIds={(profileId, nextPinned) => void setPinnedQuotaMeters(profileId, nextPinned)}
          onSnapshot={(key, snapshot) => setQuotaSnapshotsByKey((prev) => ({ ...prev, [key]: snapshot }))}
        />
      ) : null}

      <ConnectedServiceDetailActionsGroup
        defaultProfileId={defaultProfileId}
        supportsOauth={Boolean(entry.supportsOauth)}
        supportsToken={Boolean(entry.supportsToken)}
        tokenKind={entry.tokenKind ?? null}
        onSetDefaultProfile={() => void handleSetDefaultProfile()}
        onSetProfileLabel={() => void handleSetProfileLabel()}
        onAddOauthProfile={() => void handleAddOauthProfile()}
        onConnectToken={() => void handleConnectToken()}
      />

      <ItemGroup>
        <Item
          title={t('common.done')}
          icon={<Ionicons name="close-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={() => router.back()}
          showChevron={false}
        />
      </ItemGroup>
    </ItemList>
  );
});
