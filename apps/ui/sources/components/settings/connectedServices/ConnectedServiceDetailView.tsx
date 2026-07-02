import * as React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t, tLoose } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { deleteConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { deriveConnectedServiceAuthGroupIdFromName } from '@/sync/domains/connectedServices/deriveConnectedServiceAuthGroupIdFromName';
import { connectedServiceProfileKey, resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
  buildConnectedServiceCredentialRecord,
  buildConnectedAccountCredentialRecordFromTokenInput,
  ConnectedServiceAuthGroupV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  type ConnectedServiceId,
  type ConnectedServiceAuthGroupV1,
} from '@happier-dev/protocol';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { ConnectedServiceDetailActionsGroup } from './detail/ConnectedServiceDetailActionsGroup';
import { ConnectedServiceDetailGroupsGroup } from './detail/ConnectedServiceDetailGroupsGroup';
import { ConnectedServiceDetailProfilesGroup } from './detail/ConnectedServiceDetailProfilesGroup';
import { ConnectedServiceDetailQuotasSection } from './detail/ConnectedServiceDetailQuotasSection';
import { resolveConnectedServiceRuntimeGroupCapability } from './model/connectedServiceRuntimeFallbackCapability';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import {
  formatConnectedServiceProfileGroupReferenceLabels,
  resolveConnectedServiceProfileGroupReferenceLabels,
} from './model/resolveConnectedServiceProfileGroupReferences';
import { resolveConnectedServiceOauthAddActionModesForPlatform } from './oauth/resolveConnectedServiceOauthAddActionModesForPlatform';
import { storeConnectedServiceCredentialWithIdentityConfirmation } from './storeConnectedServiceCredentialWithIdentityConfirmation';
import { runConnectedServiceCredentialStoredEffects } from './runConnectedServiceCredentialStoredEffects';
import { useConnectedServiceGroupsRefreshSignal } from './connectedServiceGroupsRefreshSignal';
import {
  isConnectedServiceCredentialReferencedByGroupError,
  isConnectedServiceRuntimeCooldownError,
  resolveConnectedServiceRuntimeCooldownOverrideBody,
  resolveConnectedServiceSettingsErrorMessage,
} from './connectedServiceSettingsErrors';
import {
  listConnectedServiceAuthGroupsV3,
  createConnectedServiceAuthGroupV3,
  addConnectedServiceAuthGroupMemberV3,
  deleteConnectedServiceAuthGroupV3,
  patchConnectedServiceAuthGroupMemberV3,
  patchConnectedServiceAuthGroupV3,
  removeConnectedServiceAuthGroupMemberV3,
  setConnectedServiceAuthGroupActiveProfileV3,
} from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';

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
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const accountFallbackEnabled = useFeatureEnabled('connectedServices.accountFallback');
  const profile = useProfile();
  const settings = useSettings();
  const applySettings = useApplySettings();
  const [quotaSnapshotsByKey, setQuotaSnapshotsByKey] = React.useState<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>({});
  const [authoritativeGroups, setAuthoritativeGroups] = React.useState<ReadonlyArray<ConnectedServiceAuthGroupV1> | null>(null);

  const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const entry = serviceId ? getConnectedServiceRegistryEntry(serviceId) : null;
  const serviceLabel = serviceId ? resolveConnectedServiceDisplayName(serviceId, t) : t('connectedServices.fallbackName');

  const services = profile.connectedServicesV2;
  const svc = serviceId ? (services.find((s) => s.serviceId === serviceId) ?? null) : null;
  const profiles = svc?.profiles ?? [];
  const summaryGroups = React.useMemo<ConnectedServiceAuthGroupV1[]>(() => {
    if (!svc || typeof svc !== 'object') return [];
    const rawGroups = (svc as { groups?: unknown }).groups;
    if (!Array.isArray(rawGroups)) return [];
    const out: ConnectedServiceAuthGroupV1[] = [];
    for (const rawGroup of rawGroups) {
      const parsed = ConnectedServiceAuthGroupV1Schema.safeParse(rawGroup);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }, [svc]);
  const runtimeGroupCapability = React.useMemo(() => (
    serviceId
      ? resolveConnectedServiceRuntimeGroupCapability(serviceId)
      : { groupConfigurationSupported: false, runtimeFallbackSupported: false }
  ), [serviceId]);
  const runtimeGroupFallbackSupported = runtimeGroupCapability.runtimeFallbackSupported;
  const defaultProfileIdRaw = serviceId ? settings.connectedServicesDefaultProfileByServiceId[serviceId] : undefined;
  const defaultProfileId = typeof defaultProfileIdRaw === 'string' ? defaultProfileIdRaw.trim() : '';
  const authCredentials = auth.credentials ?? null;
  const groupsRefreshSignal = useConnectedServiceGroupsRefreshSignal();

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
    const groupReferenceLabels = accountGroupsEnabled
      ? resolveConnectedServiceProfileGroupReferenceLabels({
        profileId,
        groups: authoritativeGroups ?? summaryGroups,
      })
      : [];
    const cleanupGroupReferences = groupReferenceLabels.length > 0;
    const ok = await Modal.confirm(
      t('modals.disconnect'),
      cleanupGroupReferences
        ? t('connectedServices.detail.disconnectGroupCleanupConfirmBody', {
          service: serviceLabel,
          profileId,
          groups: formatConnectedServiceProfileGroupReferenceLabels(groupReferenceLabels),
        })
        : t('connectedServices.detail.disconnectConfirmBody', { service: serviceLabel, profileId }),
      { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    const disconnect = async (cleanup: boolean) => {
      const credentials = ensureCredentials();
      await deleteConnectedServiceCredentialForAccount(credentials, {
        serviceId: serviceId!,
        profileId,
        ...(cleanup ? { cleanupGroupReferences: true } : {}),
      });
      await sync.refreshProfile();
      await refreshAuthoritativeGroups().catch(() => undefined);
    };
    try {
      await disconnect(cleanupGroupReferences);
    } catch (e: unknown) {
      if (!cleanupGroupReferences && isConnectedServiceCredentialReferencedByGroupError(e)) {
        const retry = await Modal.confirm(
          t('modals.disconnect'),
          t('connectedServices.errors.credentialReferencedByGroup'),
          { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
        );
        if (!retry) return;
        try {
          await disconnect(true);
          return;
        } catch (retryError: unknown) {
          await Modal.alert(
            t('common.error'),
            resolveConnectedServiceSettingsErrorMessage(retryError),
          );
          return;
        }
      }
      await Modal.alert(
        t('common.error'),
        resolveConnectedServiceSettingsErrorMessage(e),
      );
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
        pathname: '/(app)/settings/connected-services/oauth',
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

  const handleConnectToken = async () => {
    if (!serviceId || !entry) return;
    const profileId = await promptProfileId();
    if (!profileId) return;

    const tokenKind = entry?.tokenKind ?? null;
    const identity = entry.tokenIdentityPromptLabelKey
      ? await Modal.prompt(
        tLoose(entry.tokenIdentityPromptLabelKey),
        '',
        {
          confirmText: t('common.save'),
          cancelText: t('common.cancel'),
        },
      )
      : null;
    const identityValue = typeof identity === 'string' ? identity.trim() : '';
    if (entry.tokenIdentityPromptLabelKey && !identityValue) return;

    const token = await Modal.prompt(
      entry.tokenPromptLabelKey
        ? tLoose(entry.tokenPromptLabelKey)
        : tokenKind === 'setup-token'
          ? t('connectedServices.detail.prompts.setupTokenTitle')
          : tokenKind === 'personal-access-token'
            ? t('connectedServices.detail.prompts.personalAccessTokenTitle')
            : tokenKind === 'api-token'
              ? t('connectedServices.detail.prompts.apiTokenTitle')
            : t('connectedServices.detail.prompts.apiKeyTitle'),
      tokenKind === 'setup-token'
        ? t('connectedServices.detail.prompts.setupTokenBody')
        : tokenKind === 'personal-access-token'
          ? t('connectedServices.detail.prompts.personalAccessTokenBody')
          : tokenKind === 'api-token'
            ? t('connectedServices.detail.prompts.apiTokenBody')
        : t('connectedServices.detail.prompts.apiKeyBody'),
      {
        placeholder: tokenKind === 'setup-token'
          ? t('connectedServices.detail.prompts.setupTokenPlaceholder')
          : tokenKind === 'personal-access-token'
            ? t('connectedServices.detail.prompts.personalAccessTokenPlaceholder')
            : tokenKind === 'api-token'
              ? t('connectedServices.detail.prompts.apiTokenPlaceholder')
          : t('connectedServices.detail.prompts.apiKeyPlaceholder'),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
        inputType: 'secure-text',
      },
    );
    const tokenValue = typeof token === 'string' ? token.trim() : '';
    if (!tokenValue) return;

    const credentials = ensureCredentials();
    const now = Date.now();
    const record = serviceId === 'bitbucket'
      ? buildConnectedServiceCredentialRecord({
          now,
          serviceId,
          profileId,
          kind: 'token',
          token: {
            token: tokenValue,
            providerAccountId: identityValue || null,
            providerEmail: identityValue || null,
          },
        })
      : buildConnectedAccountCredentialRecordFromTokenInput({
          now,
          serviceId,
          profileId,
          token: tokenValue,
          providerAccountId: identityValue || null,
          providerEmail: identityValue || null,
        });
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(credentials, {
      serviceId: serviceId!,
      profileId,
      record,
    }, {
      onStored: runConnectedServiceCredentialStoredEffects,
    });
    if (!stored) return;
    await Modal.alert(
      t('connectedServices.oauthPaste.alerts.connectedTitle'),
      t('connectedServices.oauthPaste.alerts.connectedBody', {
        serviceId: serviceLabel,
        profileId,
      }),
    );
  };

  const handleOpenTokenSetup = () => {
    if (!entry?.tokenSetupUrl) return;
    void openExternalUrl(entry.tokenSetupUrl, { platformOS: Platform.OS });
  };

  const handleAddOauthProfile = async (method: 'device' | 'paste' | 'browser' | null) => {
    const profileId = await promptProfileId();
    if (!profileId) return;
    await handleConnectOauth(profileId, method);
  };

  const handleOpenProfile = (profileId: string) => {
    if (!serviceId) return;
    router.push({
      pathname: '/(app)/settings/connected-services/profile',
      params: { serviceId, profileId },
    });
  };

  const handleOpenGroup = (groupId: string) => {
    if (!serviceId) return;
    router.push({
      pathname: '/(app)/settings/connected-services/group',
      params: { serviceId, groupId },
    });
  };

  const handleSetDefaultProfile = async (profileId: string) => {
    if (!serviceId) return;
    const exists = profiles.some((p: any) => p?.profileId === profileId);
    const nextMap = { ...settings.connectedServicesDefaultProfileByServiceId };
    if (!profileId) {
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
    const exists = profiles.some((p: any) => p?.profileId === profileId);
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

  const refreshAuthoritativeGroups = React.useCallback(async () => {
    if (!serviceId || !accountGroupsEnabled || !authCredentials) return null;
    const result = await listConnectedServiceAuthGroupsV3(authCredentials, { serviceId });
    setAuthoritativeGroups(result.groups);
    return result.groups;
  }, [accountGroupsEnabled, authCredentials, serviceId, svc]);

  React.useEffect(() => {
    let cancelled = false;

    if (!serviceId || !accountGroupsEnabled || !authCredentials) {
      setAuthoritativeGroups(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const result = await listConnectedServiceAuthGroupsV3(authCredentials, { serviceId });
        if (!cancelled) {
          setAuthoritativeGroups(result.groups);
        }
      } catch {
        if (!cancelled) {
          setAuthoritativeGroups((current) => current);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountGroupsEnabled, authCredentials, groupsRefreshSignal, serviceId]);

  const upsertAuthoritativeGroup = React.useCallback((group: ConnectedServiceAuthGroupV1) => {
    setAuthoritativeGroups((current) => {
      const groups = current ?? [];
      const nextIndex = groups.findIndex((candidate) => candidate.groupId === group.groupId);
      if (nextIndex === -1) return [...groups, group];
      const next = [...groups];
      next[nextIndex] = group;
      return next;
    });
  }, []);

  const removeAuthoritativeGroup = React.useCallback((groupId: string) => {
    setAuthoritativeGroups((current) => {
      if (current === null) return current;
      return current.filter((group) => group.groupId !== groupId);
    });
  }, []);

  const findRenderedGroup = React.useCallback((groupId: string): ConnectedServiceAuthGroupV1 | null => {
    return (authoritativeGroups ?? summaryGroups).find((candidate) => candidate.groupId === groupId) ?? null;
  }, [authoritativeGroups, summaryGroups]);

  const runGroupMutation = React.useCallback(async <T,>(
    mutation: () => Promise<T>,
    opts?: Readonly<{ onSuccess?: (result: T) => void }>,
  ) => {
    try {
      const result = await mutation();
      opts?.onSuccess?.(result);
      await Promise.resolve(sync.refreshProfile()).catch(() => undefined);
      await refreshAuthoritativeGroups().catch(() => undefined);
      return result;
    } catch (e: unknown) {
      await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
      return null;
    }
  }, [refreshAuthoritativeGroups]);

  const runAuthenticatedGroupMutation = React.useCallback(async <T,>(
    mutation: (credentials: ReturnType<typeof ensureCredentials>) => Promise<T>,
    opts?: Readonly<{ onSuccess?: (result: T) => void }>,
  ) => {
    return await runGroupMutation(() => mutation(ensureCredentials()), opts);
  }, [runGroupMutation]);

  const handleCreateAuthGroup = async () => {
    if (!serviceId) return;
    const res = await Modal.prompt(
      t('connectedServices.detail.groups.createTitle'),
      t('connectedServices.detail.groups.createSubtitle'),
      {
        placeholder: t('connectedServices.detail.groupDetail.nameTitle'),
        confirmText: t('common.create'),
        cancelText: t('common.cancel'),
      },
    );
    const groupName = typeof res === 'string' ? res.trim() : '';
    if (!groupName) return;
    const existingGroups = authoritativeGroups ?? summaryGroups;
    const existingGroupIds = existingGroups.map((group) => group.groupId);
    const groupId = deriveConnectedServiceAuthGroupIdFromName({
      name: groupName,
      existingGroupIds,
    }) ?? deriveConnectedServiceAuthGroupIdFromName({
      name: 'group',
      existingGroupIds,
    });
    if (!groupId) {
      await Modal.alert(
        t('connectedServices.detail.groups.invalidGroupTitle'),
        t('connectedServices.detail.groups.invalidGroupBody'),
      );
      return;
    }

    await runAuthenticatedGroupMutation(
      async (credentials) => await createConnectedServiceAuthGroupV3(credentials, {
        serviceId,
        groupId,
        displayName: groupName,
        activeProfileId: null,
        members: [],
      }),
      {
        onSuccess: (result) => upsertAuthoritativeGroup(result.group),
      },
    );
  };

  const handleDeleteAuthGroup = async (groupId: string) => {
    if (!serviceId) return;
    const ok = await Modal.confirm(
      t('connectedServices.detail.groups.deleteTitle'),
      t('connectedServices.detail.groups.deleteBody', { groupId }),
      { confirmText: t('common.delete'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => await deleteConnectedServiceAuthGroupV3(credentials, { serviceId, groupId }),
      {
        onSuccess: (didDelete) => {
          if (didDelete) {
            removeAuthoritativeGroup(groupId);
          }
        },
      },
    );
  };

  const handleSetAuthGroupAutoSwitch = async (groupId: string, autoSwitch: boolean) => {
    if (!serviceId) return;
    const group = groups.find((candidate) => candidate.groupId === groupId) ?? null;
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => await patchConnectedServiceAuthGroupV3(credentials, {
        serviceId,
        groupId,
        patch: { policy: { ...group.policy, autoSwitch }, expectedGeneration: group.generation },
      }),
      {
        onSuccess: (result) => {
          if (result.group) {
            upsertAuthoritativeGroup(result.group);
          }
        },
      },
    );
  };

  const handleSetAuthGroupStrategy = async (groupId: string, strategy: 'priority' | 'manual') => {
    if (!serviceId) return;
    const group = groups.find((candidate) => candidate.groupId === groupId) ?? null;
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => await patchConnectedServiceAuthGroupV3(credentials, {
        serviceId,
        groupId,
        patch: { policy: { ...group.policy, strategy }, expectedGeneration: group.generation },
      }),
      {
        onSuccess: (result) => {
          if (result.group) {
            upsertAuthoritativeGroup(result.group);
          }
        },
      },
    );
  };

  const handleSetAuthGroupActiveProfile = async (groupId: string, profileId: string, expectedGeneration: number) => {
    if (!serviceId) return;
    const applyActiveProfile = async (overrideRuntimeCooldown: boolean) => {
      const result = await setConnectedServiceAuthGroupActiveProfileV3(ensureCredentials(), {
        serviceId,
        groupId,
        profileId,
        expectedGeneration,
        ...(overrideRuntimeCooldown ? { overrideRuntimeCooldown } : {}),
      });
      if (result.group) {
        upsertAuthoritativeGroup(result.group);
      }
      await Promise.resolve(sync.refreshProfile()).catch(() => undefined);
      await refreshAuthoritativeGroups().catch(() => undefined);
    };

    try {
      await applyActiveProfile(false);
    } catch (e: unknown) {
      if (!isConnectedServiceRuntimeCooldownError(e)) {
        await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
        return;
      }
      const ok = await Modal.confirm(
        t('connectedServices.errors.runtimeCooldownOverrideTitle'),
        resolveConnectedServiceRuntimeCooldownOverrideBody(e),
        {
          confirmText: t('connectedServices.errors.runtimeCooldownOverrideConfirm'),
          cancelText: t('common.cancel'),
        },
      );
      if (!ok) return;
      try {
        await applyActiveProfile(true);
      } catch (retryError: unknown) {
        await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(retryError));
      }
    }
  };

  const handleSetAuthGroupMemberEnabled = async (groupId: string, profileId: string, enabled: boolean) => {
    if (!serviceId) return;
    const group = findRenderedGroup(groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => await patchConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        patch: { enabled, expectedGeneration: group.generation },
      }),
      {
        onSuccess: (result) => {
          if (result.group) {
            upsertAuthoritativeGroup(result.group);
          }
        },
      },
    );
  };

  const handleEditAuthGroupMemberPriority = async (groupId: string, profileId: string, currentPriority: number) => {
    if (!serviceId) return;
    const next = await Modal.prompt(
      t('connectedServices.detail.groupActions.priorityTitle'),
      t('connectedServices.detail.groupActions.priorityBody'),
      {
        placeholder: String(currentPriority),
        defaultValue: String(currentPriority),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    if (typeof next !== 'string') return;
    const priority = Number.parseInt(next.trim(), 10);
    if (!Number.isFinite(priority)) {
      await Modal.alert(
        t('connectedServices.detail.groupActions.invalidPriorityTitle'),
        t('connectedServices.detail.groupActions.invalidPriorityBody'),
      );
      return;
    }
    const group = findRenderedGroup(groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => await patchConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        patch: { priority, expectedGeneration: group.generation },
      }),
      {
        onSuccess: (result) => {
          if (result.group) {
            upsertAuthoritativeGroup(result.group);
          }
        },
      },
    );
  };

  const handleAddAuthGroupMember = async (groupId: string, profileId: string) => {
    if (!serviceId) return;
    const group = findRenderedGroup(groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => await addConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        priority: 100,
        enabled: true,
        expectedGeneration: group.generation,
      }),
      {
        onSuccess: (result) => {
          if (result.group) {
            upsertAuthoritativeGroup(result.group);
          }
        },
      },
    );
  };

  const handleRemoveAuthGroupMember = async (groupId: string, profileId: string) => {
    if (!serviceId) return;
    const ok = await Modal.confirm(
      t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
      t('connectedServices.detail.groupActions.removeMemberConfirmBody', { profileId }),
      { confirmText: t('common.remove'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    const group = findRenderedGroup(groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => await removeConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        expectedGeneration: group.generation,
      }),
      {
        onSuccess: (result) => {
          if (result.group) {
            upsertAuthoritativeGroup(result.group);
          }
        },
      },
    );
  };

  const setPinnedQuotaMeters = async (profileId: string, nextPinned: ReadonlyArray<string>) => {
    if (!serviceId) return;
    const key = connectedServiceProfileKey({ serviceId, profileId });
    const nextMap = { ...settings.connectedServicesQuotaPinnedMeterIdsByKey };
    if (nextPinned.length === 0) {
      delete nextMap[key];
    } else {
      nextMap[key] = [...nextPinned];
    }
    applySettings({ connectedServicesQuotaPinnedMeterIdsByKey: nextMap });
  };

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

  const oauthAddActionModes = resolveConnectedServiceOauthAddActionModesForPlatform({
    platformOS: Platform.OS,
    oauthAddActionModes: entry.oauthAddActionModes,
  });
  const groups = accountGroupsEnabled && authoritativeGroups !== null
    ? authoritativeGroups
    : summaryGroups;

  return (
    <ItemList>
      <ConnectedServiceDetailProfilesGroup
        title={serviceLabel}
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
        onOpenProfile={(profileId) => handleOpenProfile(profileId)}
        onSetDefaultProfile={(profileId) => void handleSetDefaultProfile(profileId)}
        onEditProfileLabel={(profileId) => void handleEditProfileLabel(profileId)}
      />

      {accountGroupsEnabled ? (
        <ConnectedServiceDetailGroupsGroup
          serviceId={serviceId}
          profiles={profiles}
          profileLabelsByKey={settings.connectedServicesProfileLabelByKey}
          pinnedMeterIdsByKey={settings.connectedServicesQuotaPinnedMeterIdsByKey}
          quotaSummaryStrategyByKey={settings.connectedServicesQuotaSummaryStrategyByKey}
          quotaSnapshotsByKey={quotaSnapshotsByKey}
          quotasEnabled={quotasEnabled}
          groups={groups}
          accountFallbackEnabled={accountFallbackEnabled}
          groupConfigurationSupported={runtimeGroupCapability.groupConfigurationSupported}
          runtimeGroupFallbackSupported={runtimeGroupFallbackSupported}
          onCreateGroup={() => void handleCreateAuthGroup()}
          onOpenGroup={(groupId) => handleOpenGroup(groupId)}
          onDeleteGroup={(groupId) => void handleDeleteAuthGroup(groupId)}
          onAddMember={(groupId, profileId) => void handleAddAuthGroupMember(groupId, profileId)}
          onRemoveMember={(groupId, profileId) => void handleRemoveAuthGroupMember(groupId, profileId)}
          onSetGroupAutoSwitch={(groupId, autoSwitch) => void handleSetAuthGroupAutoSwitch(groupId, autoSwitch)}
          onSetGroupStrategy={(groupId, strategy) => void handleSetAuthGroupStrategy(groupId, strategy)}
          onSetActiveProfile={(groupId, profileId, expectedGeneration) => void handleSetAuthGroupActiveProfile(groupId, profileId, expectedGeneration)}
          onSetMemberEnabled={(groupId, profileId, enabled) => void handleSetAuthGroupMemberEnabled(groupId, profileId, enabled)}
          onEditMemberPriority={(groupId, profileId, currentPriority) => void handleEditAuthGroupMemberPriority(groupId, profileId, currentPriority)}
        />
      ) : null}

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
        supportsOauth={Boolean(entry.supportsOauth)}
        oauthAddActionModes={oauthAddActionModes}
        supportsToken={Boolean(entry.supportsToken)}
        tokenKind={entry.tokenKind ?? null}
        tokenSetupUrl={entry.tokenSetupUrl ?? null}
        onAddOauthProfile={(method) => void handleAddOauthProfile(method)}
        onConnectToken={() => void handleConnectToken()}
        onOpenTokenSetup={handleOpenTokenSetup}
      />

    </ItemList>
  );
});
