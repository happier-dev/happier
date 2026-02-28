import * as React from 'react';
import { View } from 'react-native';
import tweetnacl from 'tweetnacl';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { exchangeConnectedServiceOauthViaProxy } from '@/sync/api/account/apiConnectedServicesV2';
import { storeConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { generateOauthState, generatePkceCodes, parseOauthCallbackUrl } from '@/utils/auth/oauthCore';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import {
  ConnectedServiceIdSchema,
  encodeBase64,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { getConnectedServiceOauthAdapter } from '@/sync/domains/connectedServices/oauth/connectedServiceOauthAdapters';
import { buildOauthRecordFromProxyPayload, parseConnectedServiceOauthProxyBundle } from '@/sync/domains/connectedServices/oauth/connectedServiceOauthProxyBundle';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export const ConnectedServiceOauthPasteView = React.memo(function ConnectedServiceOauthPasteView(props: Readonly<{
  serviceId: string;
  profileId: string;
  onDone: () => void;
  fallbackAction?: Readonly<{ title: string; onPress: () => void }>;
}>) {
  const { theme } = useUnistyles();
  const auth = useAuth();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(asStringParam(props.serviceId).trim());
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam(props.profileId).trim();
  const adapter = React.useMemo(() => (serviceId ? getConnectedServiceOauthAdapter(serviceId) : null), [serviceId]);

  const [state, setState] = React.useState<string>('');
  const [pkce, setPkce] = React.useState<{ verifier: string; challenge: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const keyPairRef = React.useRef<tweetnacl.BoxKeyPair | null>(null);
  if (!keyPairRef.current) {
    keyPairRef.current = tweetnacl.box.keyPair();
  }

  React.useEffect(() => {
    let cancelled = false;
    fireAndForget((async () => {
      const nextState = generateOauthState();
      const nextPkce = await generatePkceCodes();
      if (cancelled) return;
      setState(nextState);
      setPkce(nextPkce);
    })(), { tag: 'ConnectedServiceOauthPasteView.initPkce' });
    return () => {
      cancelled = true;
    };
  }, []);

  const redirectUri = React.useMemo(() => {
    if (!adapter) return '';
    return adapter.defaultRedirectUri;
  }, [adapter]);

  const authorizationUrl = React.useMemo(() => {
    if (!adapter || !pkce || !state || !redirectUri) return '';
    return adapter.buildAuthorizationUrl({ redirectUri, state, challenge: pkce.challenge });
  }, [adapter, pkce, redirectUri, state]);

  const ensureCredentials = () => {
    if (!auth.credentials) throw new Error('Not authenticated');
    return auth.credentials;
  };

  const handlePaste = React.useCallback(async () => {
    if (!serviceId || !adapter || !pkce || !state || !profileId) return;
    setBusy(true);
    try {
      const pasted = await Modal.prompt(
        t('connectedServices.oauthPaste.pasteRedirectUrl'),
        t('connectedServices.oauthPaste.pasteRedirectUrlPromptBody'),
        { placeholder: redirectUri, confirmText: t('common.continue'), cancelText: t('common.cancel') },
      );
      const pastedUrl = typeof pasted === 'string' ? pasted.trim() : '';
      if (!pastedUrl) return;

      const parsed = parseOauthCallbackUrl({ url: pastedUrl, redirectUri });
      if (parsed.error) throw new Error(`OAuth error: ${parsed.error}`);
      const code = parsed.code ?? '';
      const returnedState = parsed.state ?? '';
      if (!code) throw new Error('Missing code');
      if (!returnedState || returnedState !== state) throw new Error('State mismatch');

      const credentials = ensureCredentials();
      const now = Date.now();
      const publicKeyB64Url = encodeBase64(keyPairRef.current!.publicKey, 'base64url');

      const exchanged = await exchangeConnectedServiceOauthViaProxy(credentials, {
        serviceId,
        publicKey: publicKeyB64Url,
        code,
        verifier: pkce.verifier,
        redirectUri,
        state: returnedState,
      });

      const payload = parseConnectedServiceOauthProxyBundle({
        bundleB64Url: exchanged.bundle,
        recipientSecretKey: keyPairRef.current!.secretKey,
      });
      if (payload.serviceId !== serviceId) {
        throw new Error('OAuth bundle service mismatch');
      }

      const record = buildOauthRecordFromProxyPayload({
        now,
        serviceId,
        profileId,
        payload,
      });

      await storeConnectedServiceCredentialForAccount(credentials, { serviceId, profileId, record });

      await sync.refreshProfile();
      await Modal.alert(
        t('connectedServices.oauthPaste.alerts.connectedTitle'),
        t('connectedServices.oauthPaste.alerts.connectedBody', { serviceId, profileId })
      );
      props.onDone();
    } catch (e: unknown) {
      await Modal.alert(
        t('common.error'),
        e instanceof Error ? e.message : t('connectedServices.oauthPaste.alerts.failedToConnect')
      );
    } finally {
      setBusy(false);
    }
  }, [adapter, auth.credentials, pkce, profileId, props, redirectUri, serviceId, state]);

  if (!serviceId || !profileId || !adapter) {
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

  return (
    <ItemList>
      <ItemGroup title={t('connectedServices.oauthPaste.connectWebGroupTitle')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ opacity: 0.7 }}>
            {t('connectedServices.oauthPaste.connectWebDescription')}
          </Text>
        </View>
      </ItemGroup>

      <ItemGroup title={t('connectedServices.oauthPaste.openAuthorizationUrl')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ opacity: 0.7, marginBottom: 6 }}>{t('connectedServices.oauthPaste.openAuthorizationUrl')}</Text>
          <Text selectable={true} style={{ opacity: 0.9 }}>
            {authorizationUrl || t('connectedServices.oauthPaste.preparing')}
          </Text>
          <View style={{ marginTop: 12 }}>
            <RoundButton
              testID="connectedServices.oauthPaste.openAuthorizationButton"
              size="normal"
              title={t('connectedServices.oauthPaste.openAuthorizationUrl')}
              disabled={!authorizationUrl}
              onPress={() => {
                if (!authorizationUrl) return;
                fireAndForget((async () => {
                  const ok = await openExternalUrl(authorizationUrl);
                  if (!ok) {
                    await Modal.alert(
                      t('common.error'),
                      t('connectedServices.oauthPaste.alerts.failedToOpenUrl'),
                    );
                  }
                })(), { tag: 'ConnectedServiceOauthPasteView.openAuthorizationUrl' });
              }}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <Text style={{ opacity: 0.7 }}>
              {authorizationUrl ? t('connectedServices.oauthPaste.opensInNewTab') : t('connectedServices.oauthPaste.preparing')}
            </Text>
          </View>
        </View>
      </ItemGroup>

      <ItemGroup title={t('connectedServices.oauthPaste.pasteRedirectUrl')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <RoundButton
            testID="connectedServices.oauthPaste.pasteRedirectButton"
            size="normal"
            title={busy ? t('connectedServices.oauthPaste.working') : t('connectedServices.oauthPaste.pasteRedirectUrl')}
            disabled={busy}
            onPress={busy ? undefined : handlePaste}
          />
          <View style={{ marginTop: 8 }}>
            <Text selectable={true} style={{ opacity: 0.7 }}>{redirectUri}</Text>
          </View>
        </View>
      </ItemGroup>

      {props.fallbackAction ? (
        <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
          <Item
            testID="connectedServices.oauthPaste.switchMethodItem"
            title={props.fallbackAction.title}
            icon={<Ionicons name="swap-horizontal-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={props.fallbackAction.onPress}
          />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});
