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
import { deleteConnectedServiceCredential, registerConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
import { sealConnectedServiceCredential } from '@/sync/domains/connectedServices/sealConnectedServiceCredential';
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

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('settings.connectedAccounts') ?? 'Connected Services'}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>
              {t('settings.connectedAccountsDisabled') ?? 'Connected services are disabled.'}
            </Text>
          </View>
        </ItemGroup>

        <ItemGroup>
          <Item
            title={t('common.close') ?? 'Done'}
            icon={<Ionicons name="close-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={() => router.back()}
            showChevron={false}
          />
        </ItemGroup>
      </ItemList>
    );
  }

  const ensureCredentials = () => {
    if (!auth.credentials) {
      throw new Error('Not authenticated');
    }
    return auth.credentials;
  };

  const promptProfileId = async (opts?: { defaultValue?: string }) => {
    const res = await Modal.prompt(
      'Profile id',
      'Use a short label like work, personal, alt.',
      {
        placeholder: 'work',
        defaultValue: opts?.defaultValue,
        confirmText: t('common.save') ?? 'Save',
        cancelText: t('common.cancel') ?? 'Cancel',
      },
    );
    const profileId = typeof res === 'string' ? res.trim() : '';
    if (!profileId) return null;
    const parsed = ConnectedServiceProfileIdSchema.safeParse(profileId);
    if (!parsed.success) {
      await Modal.alert('Invalid profile id', 'Use letters, numbers, hyphen, or underscore (max 64).');
      return null;
    }
    return parsed.data;
  };

  const handleDisconnect = async (profileId: string) => {
    const ok = await Modal.confirm(
      'Disconnect',
      `Disconnect ${entry?.displayName ?? serviceId} (${profileId})?`,
      { confirmText: t('modals.disconnect') ?? 'Disconnect', cancelText: t('common.cancel') ?? 'Cancel' },
    );
    if (!ok) return;
    const credentials = ensureCredentials();
    await deleteConnectedServiceCredential(credentials, { serviceId: serviceId!, profileId });
    await sync.refreshProfile();
  };

  const handleConnectOauth = async (profileId: string) => {
    router.push({ pathname: '/(app)/settings/connected-services/oauth', params: { serviceId: serviceId!, profileId } });
  };

  const handleConnectSetupToken = async () => {
    const profileId = await promptProfileId();
    if (!profileId) return;

    const token = await Modal.prompt(
      'Setup token',
      'Paste your Claude setup-token.',
      {
        placeholder: 'setup-token',
        confirmText: t('common.save') ?? 'Save',
        cancelText: t('common.cancel') ?? 'Cancel',
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
    const ciphertext = sealConnectedServiceCredential({ credentials, record });
    await registerConnectedServiceCredentialSealed(credentials, {
      serviceId: serviceId!,
      profileId,
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: {
        kind: record.kind,
        providerEmail: record.kind === 'oauth' ? record.oauth.providerEmail : record.token.providerEmail,
        providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : record.token.providerAccountId,
        expiresAt: record.expiresAt,
      },
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
      await Modal.alert('Unknown profile', `No profile named "${profileId}" exists for ${entry?.displayName ?? serviceId}.`);
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
      await Modal.alert('Unknown profile', `No profile named "${profileId}" exists for ${entry?.displayName ?? serviceId}.`);
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
      'Profile label',
      'Optional. Shown in auth pickers.',
      {
        placeholder: 'Work account',
        defaultValue: currentLabel,
        confirmText: t('common.save') ?? 'Save',
        cancelText: t('common.cancel') ?? 'Cancel',
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

  if (!serviceId || !entry) {
    return (
      <ItemList>
        <ItemGroup title="Connected Services">
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>Unknown connected service.</Text>
          </View>
        </ItemGroup>
        <ItemGroup>
          <Item
            title={t('common.close') ?? 'Done'}
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
        supportsSetupToken={Boolean(entry.supportsSetupToken)}
        onSetDefaultProfile={() => void handleSetDefaultProfile()}
        onSetProfileLabel={() => void handleSetProfileLabel()}
        onAddOauthProfile={() => void handleAddOauthProfile()}
        onConnectSetupToken={() => void handleConnectSetupToken()}
      />

      <ItemGroup>
        <Item
          title={t('common.close') ?? 'Done'}
          icon={<Ionicons name="close-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={() => router.back()}
          showChevron={false}
        />
      </ItemGroup>
    </ItemList>
  );
});
