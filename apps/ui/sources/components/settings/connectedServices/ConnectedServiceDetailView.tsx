import * as React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { deleteConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  connectedServiceProfileKey,
  pruneConnectedServiceProfilePreferencesForDeletedProfile,
  resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { deriveAccountHealth, type AccountHealth } from '@/sync/domains/connectedServices/deriveAccountHealth';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { AccountBlock } from './account/AccountBlock';
import { buildConnectedServiceAccountRowActions } from './account/buildConnectedServiceAccountRowActions';
import { ConnectedServiceDetailActionsGroup } from './detail/ConnectedServiceDetailActionsGroup';
import {
  ConnectedServiceSegmentedShell,
  type ConnectedServiceDetailSegment,
} from './detail/ConnectedServiceSegmentedShell';
import { PoolsList } from './pools/PoolsList';
import { SettingsHeaderAddButton } from '../navigation/SettingsHeaderAddButton';
import {
  isConnectedServiceCredentialReferencedByGroupError,
  refreshConnectedServiceProfileAfterSupersededMutation,
  resolveConnectedServiceSettingsErrorMessage,
} from './errors/connectedServiceSettingsErrors';
import { resolveConnectedServiceRuntimeGroupCapability } from './model/connectedServiceRuntimeFallbackCapability';
import { resolveConnectedServiceProfileIdentityDisplay } from './model/resolveConnectedServiceIdentityDisplay';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import {
  formatConnectedServiceProfileGroupReferenceLabels,
  resolveConnectedServiceProfileGroupReferenceLabels,
} from './model/resolveConnectedServiceProfileGroupReferences';
import { resolveConnectedServiceOauthAddActionModesForPlatform } from './oauth/resolveConnectedServiceOauthAddActionModesForPlatform';
import { promptConnectedServiceTokenValue } from './promptConnectedServiceTokenValue';
import { storeConnectedServiceCredentialWithIdentityConfirmation } from './storeConnectedServiceCredentialWithIdentityConfirmation';
import { runConnectedServiceCredentialStoredEffects } from './runConnectedServiceCredentialStoredEffects';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import { resolveConnectedServiceProjectionSignature } from '@/sync/domains/connectedServices/resolveConnectedServiceProjectionSignature';
import { useConnectedServiceAuthGroups } from './model/useConnectedServiceAuthGroups';
import { Icon } from '@/components/ui/icons/Icon';
import { fireAndForget } from '@/utils/system/fireAndForget';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

const HEALTH_SEVERITY_RANK: Readonly<Record<AccountHealth, number>> = {
  error: 0,
  attention: 1,
  healthy: 2,
};

export const ConnectedServiceDetailView = React.memo(function ConnectedServiceDetailView() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
  const profile = useProfile();
  const settings = useSettings();
  const applySettings = useApplySettings();
  const [activeSegment, setActiveSegment] = React.useState<ConnectedServiceDetailSegment>('accounts');

  const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const entry = serviceId ? getConnectedServiceRegistryEntry(serviceId) : null;
  const serviceLabel = serviceId ? resolveConnectedServiceDisplayName(serviceId, t) : t('connectedServices.fallbackName');

  const services = profile.connectedServicesV2;
  const svc = serviceId ? (services.find((s) => s.serviceId === serviceId) ?? null) : null;
  const profiles = svc?.profiles ?? [];
  const defaultProfileIdRaw = serviceId ? settings.connectedServicesDefaultProfileByServiceId[serviceId] : undefined;
  const defaultProfileId = typeof defaultProfileIdRaw === 'string' ? defaultProfileIdRaw.trim() : '';
  const runtimeGroupCapability = React.useMemo(
    () => serviceId
      ? resolveConnectedServiceRuntimeGroupCapability(serviceId)
      : {
        groupConfigurationSupported: false,
        runtimeFallbackSupported: false,
        groupConfigurationSupportingAgentIds: [],
        runtimeFallbackSupportingAgentIds: [],
      },
    [serviceId],
  );
  const runtimeGroupFallbackSupported = runtimeGroupCapability.runtimeFallbackSupported;
  const groupConfigurationSupported = runtimeGroupCapability.groupConfigurationSupported;
  const serviceProjectionSignature = React.useMemo(
    () => resolveConnectedServiceProjectionSignature(svc),
    [svc],
  );

  // Pools ("auth groups") read path + create flow. Member/policy mutations live
  // in PoolDetailView; the shell only needs the list + create.
  const authGroups = useConnectedServiceAuthGroups({
    serviceId,
    accountGroupsEnabled,
    groupConfigurationSupported,
    runtimeGroupFallbackSupported,
    serviceProjectionSignature,
  });

  const poolsAvailable = accountGroupsEnabled && groupConfigurationSupported;

  // Honor an initial `segment` deep-link param (e.g. the profile "Add to pool" action
  // routes here with `segment: 'pools'`) exactly once, once pools are actually available.
  const requestedSegment = asStringParam((params as Record<string, unknown>).segment).trim();
  const didApplyRequestedSegmentRef = React.useRef(false);
  React.useEffect(() => {
    if (didApplyRequestedSegmentRef.current) return;
    if (requestedSegment === 'pools' && poolsAvailable) {
      didApplyRequestedSegmentRef.current = true;
      setActiveSegment('pools');
    }
  }, [poolsAvailable, requestedSegment]);

  const ensureCredentials = () => {
    if (!auth.credentials) {
      throw new Error('Not authenticated');
    }
    return auth.credentials;
  };

  const resolveProfileGroupReferenceLabels = React.useCallback((profileId: string) => (
    accountGroupsEnabled
      ? resolveConnectedServiceProfileGroupReferenceLabels({
        profileId,
        groups: authGroups.groups,
        projectedGroups: svc?.groups,
      })
      : []
  ), [accountGroupsEnabled, authGroups.groups, svc?.groups]);

  const finishDisconnect = React.useCallback(async (
    profileId: string,
    opts?: Readonly<{ cleanupGroupReferences?: boolean }>,
  ) => {
    const credentials = ensureCredentials();
    const expectedCredentialRevision = profile.connectedServiceCredentialRevisionsV1.find((candidate) => (
      candidate.serviceId === serviceId && candidate.profileId === profileId
    ))?.credentialRevision;
    await deleteConnectedServiceCredentialForAccount(credentials, {
      serviceId: serviceId!,
      profileId,
      expectedCredentialRevision,
      ...(opts?.cleanupGroupReferences ? { cleanupGroupReferences: true } : {}),
    });
    applySettings(pruneConnectedServiceProfilePreferencesForDeletedProfile({
      serviceId: serviceId!,
      profileId,
      connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
      connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
    }));
    await sync.refreshProfile();
    invalidateConnectedServiceGroupsRefreshSignal();
  }, [
    applySettings,
    profile.connectedServiceCredentialRevisionsV1,
    serviceId,
    settings.connectedServicesDefaultProfileByServiceId,
    settings.connectedServicesProfileLabelByKey,
  ]);

  const promptProfileId = async (opts?: { defaultValue?: string }) => {
    const res = await Modal.prompt(
      t('connectedServices.detail.prompts.profileIdTitle'),
      t('connectedServices.detail.prompts.profileIdBody'),
      {
        placeholder: t('connectedServices.detail.prompts.profileIdPlaceholder'),
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
    const profileRecord = profiles.find((candidate) => candidate.profileId === profileId) ?? null;
    const profileConfirmationLabel = serviceId
      ? resolveConnectedServiceProfileIdentityDisplay({
          profileId,
          label: resolveConnectedServiceProfileLabel({
            labelsByKey: settings.connectedServicesProfileLabelByKey,
            serviceId,
            profileId,
          }),
          providerEmail: typeof profileRecord?.providerEmail === 'string' ? profileRecord.providerEmail : '',
        }).diagnosticLabel
      : profileId;
    const groupReferenceLabels = resolveProfileGroupReferenceLabels(profileId);
    const cleanupGroupReferences = groupReferenceLabels.length > 0;
    const ok = await Modal.confirm(
      t('modals.disconnect'),
      cleanupGroupReferences
        ? t('connectedServices.detail.disconnectGroupCleanupConfirmBody', {
          service: serviceLabel,
          profileId: profileConfirmationLabel,
          groups: formatConnectedServiceProfileGroupReferenceLabels(groupReferenceLabels),
        })
        : t('connectedServices.detail.disconnectConfirmBody', { service: serviceLabel, profileId: profileConfirmationLabel }),
      { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    try {
      await finishDisconnect(profileId, { cleanupGroupReferences });
    } catch (e: unknown) {
      if (!cleanupGroupReferences && isConnectedServiceCredentialReferencedByGroupError(e)) {
        const retry = await Modal.confirm(
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryTitle'),
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryBody', { service: serviceLabel, profileId: profileConfirmationLabel }),
          {
            confirmText: t('connectedServices.detail.errors.disconnectGroupCleanupRetryConfirm'),
            cancelText: t('common.cancel'),
          },
        );
        if (retry) {
          try {
            await finishDisconnect(profileId, { cleanupGroupReferences: true });
            return;
          } catch (retryError: unknown) {
            await refreshConnectedServiceProfileAfterSupersededMutation(retryError, () => sync.refreshProfile());
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(retryError));
            return;
          }
        }
        return;
      }
      await refreshConnectedServiceProfileAfterSupersededMutation(e, () => sync.refreshProfile());
      await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
    }
  };

  const handleConnectOauth = async (profileId: string, method: 'device' | 'paste' | 'browser' | null = null) => {
    if (!serviceId || !entry) return;
    if (!entry?.supportsOauth) {
      await Modal.alert(
        t('connect.unsupported.connectTitle', { name: serviceLabel }),
        t('connect.unsupported.runCommandInTerminalWithCommand', { command: entry.connectCommand }),
        [{ text: t('common.ok'), style: 'cancel' }],
      );
      return;
    }
    try {
      router.push({
        pathname: '/settings/connected-services/oauth',
        params: { serviceId: serviceId!, profileId, ...(method ? { method } : {}) },
      });
    } catch {
      await Modal.alert(
        t('connect.unsupported.connectTitle', { name: serviceLabel }),
        t('connect.unsupported.runCommandInTerminalWithCommand', { command: entry.connectCommand }),
        [{ text: t('common.ok'), style: 'cancel' }],
      );
    }
  };

  const storeTokenProfile = async (profileId: string, tokenValue: string) => {
    if (!serviceId || !entry) return;
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
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(credentials, {
      serviceId: serviceId!,
      profileId,
      record,
    }, { onStored: runConnectedServiceCredentialStoredEffects });
    if (!stored) return;
    await Modal.alert(
      t('connectedServices.oauthPaste.alerts.connectedTitle'),
      t('connectedServices.oauthPaste.alerts.connectedBody', {
        serviceId: serviceLabel,
        profileId,
      }),
    );
  };

  const handleConnectToken = async () => {
    if (!serviceId || !entry) return;
    const profileId = await promptProfileId();
    if (!profileId) return;
    const tokenValue = await promptConnectedServiceTokenValue(entry.tokenKind ?? null);
    if (!tokenValue) return;
    await storeTokenProfile(profileId, tokenValue);
  };

  const handleReplaceToken = async (profileId: string) => {
    if (!serviceId || !entry) return;
    const exists = profiles.some((p) => p?.profileId === profileId && p?.kind === 'token');
    if (!exists) {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel }),
      );
      return;
    }
    const tokenValue = await promptConnectedServiceTokenValue(entry.tokenKind ?? null);
    if (!tokenValue) return;
    await storeTokenProfile(profileId, tokenValue);
  };

  const handleOpenTokenSetupUrl = async (url: string) => {
    const ok = await openExternalUrl(url);
    if (!ok) {
      await Modal.alert(
        t('common.error'),
        t('connectedServices.detail.alerts.failedToOpenTokenSetupUrl'),
      );
    }
  };

  const handleAddOauthProfile = async (method: 'device' | 'paste' | 'browser' | null) => {
    const profileId = await promptProfileId();
    if (!profileId) return;
    await handleConnectOauth(profileId, method);
  };

  const handleOpenProfile = (profileId: string) => {
    if (!serviceId) return;
    router.push({
      pathname: '/settings/connected-services/profile',
      params: { serviceId, profileId },
    });
  };

  const handleOpenPool = (groupId: string) => {
    if (!serviceId) return;
    router.push({
      pathname: '/(app)/settings/connected-services/group',
      params: { serviceId, groupId },
    });
  };

  const handleToggleDefaultProfile = async (profileId: string) => {
    if (!serviceId) return;
    const exists = profiles.some((p) => p?.profileId === profileId);
    const isDefault = profileId === defaultProfileId;
    const nextMap = { ...settings.connectedServicesDefaultProfileByServiceId };
    if (isDefault) {
      delete nextMap[serviceId];
    } else if (exists) {
      nextMap[serviceId] = profileId;
    } else {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel }),
      );
      return;
    }
    applySettings({ connectedServicesDefaultProfileByServiceId: nextMap });
  };

  const handleEditProfileLabel = async (profileId: string) => {
    if (!serviceId) return;
    const exists = profiles.some((p) => p?.profileId === profileId);
    if (!exists) {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel }),
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

    applySettings({ connectedServicesProfileLabelByKey: nextMap });
  };

  const oauthAddActionModes = React.useMemo(
    () => entry
      ? resolveConnectedServiceOauthAddActionModesForPlatform({
        platformOS: Platform.OS,
        oauthAddActionModes: entry.oauthAddActionModes,
      })
      : [],
    [entry],
  );

  // Context-aware header "+": add account (Accounts segment) / create pool (Pools).
  const handleHeaderAdd = React.useCallback(() => {
    if (activeSegment === 'pools' && poolsAvailable) {
      void authGroups.createPool();
      return;
    }
    if (entry?.supportsOauth) {
      void handleAddOauthProfile(oauthAddActionModes[0] ?? null);
      return;
    }
    if (entry?.supportsToken) {
      void handleConnectToken();
    }
  }, [activeSegment, authGroups, entry, oauthAddActionModes, poolsAvailable]);

  const canAdd = Boolean(entry) && (
    (activeSegment === 'pools' && poolsAvailable)
    || Boolean(entry?.supportsOauth)
    || Boolean(entry?.supportsToken)
  );

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: serviceLabel,
      headerRight: canAdd
        ? () => (
          <SettingsHeaderAddButton
            testID="connected-services-detail:header-add"
            accessibilityLabel={activeSegment === 'pools'
              ? t('connectedServices.pools.create.title')
              : t('connectedServices.detail.addOauthProfileTitle')}
            onPress={handleHeaderAdd}
          />
        )
        : undefined,
    });
  }, [activeSegment, canAdd, handleHeaderAdd, navigation, serviceLabel]);

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('settings.connectedAccounts')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('settings.connectedAccountsDisabled')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  if (!serviceId || !entry) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.detail.unknownService')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  const sortedProfiles = profiles
    .map((p) => {
      const profileId = typeof p?.profileId === 'string' ? p.profileId : '';
      // Fail-closed normalization drives ordering + row ACTIONS only; AccountBlock
      // receives the RAW status so its fail-open usage gate stays live (UI-1).
      const rawStatus: unknown = p?.status;
      const status = resolveConnectedServiceCredentialHealthStatus(rawStatus);
      // Attention-first ordering uses the status dimension of the canonical
      // health derivation (quota capacity is fetched inside AccountBlock).
      const health = deriveAccountHealth({ status, capacityPct: null });
      return { record: p, profileId, rawStatus, status, health };
    })
    .filter((entryRow) => entryRow.profileId.length > 0)
    .sort((a, b) => {
      const rank = HEALTH_SEVERITY_RANK[a.health] - HEALTH_SEVERITY_RANK[b.health];
      if (rank !== 0) return rank;
      return a.profileId.localeCompare(b.profileId);
    });

  const accountsContent = (
    <>
      <ItemGroup title={serviceLabel} columns={2}>
        {sortedProfiles.length === 0 ? (
          <EmptyState
            testID="connected-services-accounts:empty"
            icon={<Icon name="key" size={29} color={theme.colors.text.secondary} />}
            title={t('connectedServices.detail.profiles.empty')}
          />
        ) : null}
        {sortedProfiles.map((row) => {
          const { profileId, rawStatus, status, record } = row;
          const isDefault = profileId === defaultProfileId;
          const kind = record.kind === 'token' ? 'token' : record.kind === 'oauth' ? 'oauth' : null;
          const label = resolveConnectedServiceProfileLabel({
            labelsByKey: settings.connectedServicesProfileLabelByKey,
            serviceId,
            profileId,
          });
          const identityDisplay = resolveConnectedServiceProfileIdentityDisplay({
            profileId,
            label,
            providerEmail: typeof record.providerEmail === 'string' ? record.providerEmail : '',
          });
          const title = identityDisplay.primaryLabel;
          const poolLabels = resolveProfileGroupReferenceLabels(profileId);
          const actions = buildConnectedServiceAccountRowActions({
            kind,
            status,
            onOpen: () => handleOpenProfile(profileId),
            onEditLabel: () => void handleEditProfileLabel(profileId),
            onReplaceToken: () => void handleReplaceToken(profileId),
            onReconnect: () => void handleConnectOauth(profileId),
            onDisconnect: () => handleDisconnect(profileId),
          });
          return (
            <AccountBlock
              key={profileId}
              serviceId={serviceId}
              profileId={profileId}
              title={title}
              identityLabel={identityDisplay.secondaryLabel}
              status={rawStatus}
              isDefault={isDefault}
              onToggleDefault={() => void handleToggleDefaultProfile(profileId)}
              poolLabels={poolLabels}
              actions={actions}
            />
          );
        })}
      </ItemGroup>

      <ConnectedServiceDetailActionsGroup
        supportsOauth={Boolean(entry.supportsOauth)}
        oauthAddActionModes={oauthAddActionModes}
        supportsToken={Boolean(entry.supportsToken)}
        tokenKind={entry.tokenKind ?? null}
        tokenSetupUrl={entry.tokenSetupUrl ?? null}
        onAddOauthProfile={(method) => void handleAddOauthProfile(method)}
        onConnectToken={() => void handleConnectToken()}
        onOpenTokenSetupUrl={(url) => void handleOpenTokenSetupUrl(url)}
        onImport={entry.importSources?.length ? () => {
          fireAndForget((async () => {
            const profileId = await promptProfileId();
            if (!profileId) return;
            router.push({ pathname: '/settings/connected-services/import', params: { serviceId, profileId } });
          })(), { tag: 'ConnectedServiceDetailView.import' });
        } : undefined}
      />
    </>
  );

  return (
    <ItemList>
      <ConnectedServiceSegmentedShell
        activeSegment={activeSegment}
        onSelectSegment={setActiveSegment}
        poolsAvailable={poolsAvailable}
        accountsContent={accountsContent}
        poolsContent={(
          <PoolsList
            serviceId={serviceId}
            profiles={profiles}
            profileLabelsByKey={settings.connectedServicesProfileLabelByKey}
            groups={authGroups.groups}
            loadStatus={authGroups.loadStatus}
            quotasEnabled={quotasEnabled}
            groupConfigurationSupported={groupConfigurationSupported}
            onOpenPool={handleOpenPool}
            onCreatePool={() => void authGroups.createPool()}
            onRetryLoad={() => void authGroups.refresh()}
          />
        )}
      />
    </ItemList>
  );
});
