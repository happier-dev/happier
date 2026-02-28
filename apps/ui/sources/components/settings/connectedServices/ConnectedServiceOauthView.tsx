import * as React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { OAuthView, OAuthViewUnsupported, type OAuthViewConfig } from '@/components/ui/navigation/OAuthView';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/context/AuthContext';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storeConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { ConnectedServiceCredentialRecordV1Schema, ConnectedServiceIdSchema, type ConnectedServiceCredentialRecordV1, type ConnectedServiceId } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { getConnectedServiceOauthAdapter } from '@/sync/domains/connectedServices/oauth/connectedServiceOauthAdapters';
import { ConnectedServiceOauthPasteView } from './ConnectedServiceOauthPasteView';
import { OpenAiCodexDeviceAuthView } from './oauth/openai/OpenAiCodexDeviceAuthView';
import { ConnectedServiceOauthEmbeddedView } from './oauth/ConnectedServiceOauthEmbeddedView';
import { resolveConnectedServiceOauthMode } from './oauth/resolveConnectedServiceOauthMode';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export const ConnectedServiceOauthView = React.memo(function ConnectedServiceOauthView() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');

  const rawServiceId = asStringParam(params.serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam(params.profileId).trim();
  const method = asStringParam((params as any).method).trim().toLowerCase();

  const entry = serviceId ? getConnectedServiceRegistryEntry(serviceId) : null;

  if (!serviceId || !entry || !profileId) {
    return (
      <View style={{ flex: 1 }}>
        <OAuthViewUnsupported name={rawServiceId || t('connectedServices.fallbackName')} command={entry?.connectCommand} />
      </View>
    );
  }

  if (!connectedServicesEnabled) {
    return (
      <View style={{ flex: 1 }}>
        <OAuthViewUnsupported name={entry.displayName} command={entry.connectCommand} />
      </View>
    );
  }

  if (!entry.supportsOauth) {
    return (
      <View style={{ flex: 1 }}>
        <OAuthViewUnsupported name={entry.displayName} command={entry.connectCommand} />
      </View>
    );
  }

  const mode = resolveConnectedServiceOauthMode({
    platformOS: Platform.OS,
    serviceId,
    method,
    oauthAddActionModes: entry.oauthAddActionModes,
  });
  const isWeb = Platform.OS === 'web';
  const adapter = getConnectedServiceOauthAdapter(serviceId);

  if (mode === 'device') {
    return (
      <OpenAiCodexDeviceAuthView
        serviceId={rawServiceId}
        profileId={profileId}
        onDone={() => router.back()}
        fallbackAction={{
          title: t('connectedServices.deviceAuth.usePasteInstead'),
          onPress: () => router.push({
            pathname: '/(app)/settings/connected-services/oauth',
            params: {
              serviceId: rawServiceId,
              profileId,
              method: 'paste',
            },
          }),
        }}
      />
    );
  }

  if (mode === 'paste') {
    const fallbackAction = (() => {
      if ((entry.oauthAddActionModes ?? []).includes('device')) {
        return {
          title: t('connectedServices.oauthPaste.tryDeviceInstead'),
          onPress: () => router.push({
            pathname: '/(app)/settings/connected-services/oauth',
            params: { serviceId: rawServiceId, profileId },
          }),
        };
      }
      if (!isWeb) {
        return {
          title: t('connectedServices.oauthPaste.tryEmbeddedInstead'),
          onPress: () => router.push({
            pathname: '/(app)/settings/connected-services/oauth',
            params: { serviceId: rawServiceId, profileId, method: 'browser' },
          }),
        };
      }
      return undefined;
    })();

    return (
      <ConnectedServiceOauthPasteView
        serviceId={rawServiceId}
        profileId={profileId}
        onDone={() => router.back()}
        fallbackAction={fallbackAction}
      />
    );
  }

  const ensureCredentials = () => {
    if (!auth.credentials) throw new Error('Not authenticated');
    return auth.credentials;
  };

  const registerRecord = async (record: ConnectedServiceCredentialRecordV1) => {
    const credentials = ensureCredentials();
    await storeConnectedServiceCredentialForAccount(credentials, { serviceId, profileId, record });
    await sync.refreshProfile();
  };

  const registerMaybeRecord = async (record: unknown) => {
    const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(record);
    if (!parsed.success) throw new Error('OAuth flow returned an invalid credential record');
    await registerRecord(parsed.data);
  };

  if (!adapter) {
    return <OAuthViewUnsupported name={entry.displayName} command={entry.connectCommand} />;
  }

  const redirectUri = adapter.defaultRedirectUri;
  const config: OAuthViewConfig = {
    redirectUri,
    authUrl: (pkce, state: string, uri: string) =>
      adapter.buildAuthorizationUrl({ redirectUri: uri, state, challenge: pkce.challenge }),
    tokenExchange: async (code: string, verifier: string, state: string) => {
      const now = Date.now();
      const credentials = ensureCredentials();
      return await adapter.exchangeAuthorizationCodeForRecord({
        credentials,
        profileId,
        code,
        verifier,
        redirectUri,
        state,
        now,
      });
    },
    onSuccess: (record: unknown) => {
      fireAndForget((async () => {
        try {
          await registerMaybeRecord(record);
          await Modal.alert(
            t('connectedServices.oauthPaste.alerts.connectedTitle'),
            t('connectedServices.oauthPaste.alerts.connectedBody', { serviceId: entry.displayName, profileId }),
          );
          router.back();
        } catch (e: unknown) {
          await Modal.alert(
            t('common.error'),
            e instanceof Error ? e.message : t('connectedServices.oauthPaste.alerts.failedToConnect'),
          );
        }
      })(), { tag: 'ConnectedServiceOauthView.onSuccess' });
    },
  };

  return (
    <ConnectedServiceOauthEmbeddedView
      name={entry.displayName}
      command={entry.connectCommand}
      config={config}
      fallbackAction={{
        title: t('connectedServices.deviceAuth.usePasteInstead'),
        onPress: () => router.push({
          pathname: '/(app)/settings/connected-services/oauth',
          params: { serviceId: rawServiceId, profileId, method: 'paste' },
        }),
      }}
    />
  );
});
