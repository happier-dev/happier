import * as React from 'react';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import tweetnacl from 'tweetnacl';

import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/context/AuthContext';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { sync } from '@/sync/sync';
import { delay } from '@/utils/timing/time';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { t } from '@/text';

import {
  ConnectedServiceIdSchema,
  encodeBase64,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  pollOpenAiCodexDeviceAuthViaProxy,
  startOpenAiCodexDeviceAuthViaProxy,
} from '@/sync/api/account/apiConnectedServicesV2';
import { storeConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { buildOauthRecordFromProxyPayload, parseConnectedServiceOauthProxyBundle } from '@/sync/domains/connectedServices/oauth/connectedServiceOauthProxyBundle';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export const OpenAiCodexDeviceAuthView = React.memo(function OpenAiCodexDeviceAuthView(props: Readonly<{
  serviceId: string;
  profileId: string;
  onDone: () => void;
  fallbackAction?: Readonly<{ title: string; subtitle?: string; onPress: () => void }>;
}>) {
  const { theme } = useUnistyles();
  const auth = useAuth();
  const credentialsToken = auth.credentials?.token ?? '';
  const credentialsVariantKey = React.useMemo(() => {
    if (!auth.credentials) return '';
    return isLegacyAuthCredentials(auth.credentials)
      ? auth.credentials.secret
      : `${auth.credentials.encryption.publicKey}:${auth.credentials.encryption.machineKey}`;
  }, [auth.credentials]);
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(asStringParam(props.serviceId).trim());
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam(props.profileId).trim();

  const ensureCredentials = () => {
    if (!auth.credentials) throw new Error('Not authenticated');
    return auth.credentials;
  };

  const keyPairRef = React.useRef<tweetnacl.BoxKeyPair | null>(null);
  if (!keyPairRef.current) {
    keyPairRef.current = tweetnacl.box.keyPair();
  }

  const [deviceAuth, setDeviceAuth] = React.useState<null | Readonly<{
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
    verificationUrl: string;
  }>>(null);

  const [starting, setStarting] = React.useState(false);
  const [polling, setPolling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const cancelledRef = React.useRef(false);
  const pollingStartedRef = React.useRef(false);
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  React.useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (serviceId !== 'openai-codex' || !profileId) return;
    let cancelled = false;
    fireAndForget((async () => {
      setStarting(true);
      setError(null);
      try {
        const credentials = ensureCredentials();
        const publicKey = encodeBase64(keyPairRef.current!.publicKey, 'base64url');
        const started = await startOpenAiCodexDeviceAuthViaProxy(credentials, { publicKey });
        if (cancelled) return;
        setDeviceAuth(started);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t('connectedServices.deviceAuth.alerts.failedToStart'));
      } finally {
        if (!cancelled) setStarting(false);
      }
    })(), { tag: 'OpenAiCodexDeviceAuthView.start' });
    return () => {
      cancelled = true;
    };
  }, [credentialsToken, credentialsVariantKey, profileId, serviceId]);

  const copyUserCode = React.useCallback(async () => {
    const userCode = deviceAuth?.userCode ?? '';
    if (!userCode) return;
    const ok = await setClipboardStringSafe(userCode);
    if (!ok) return;
    setCopied(true);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => {
      setCopied(false);
    }, 1200);
  }, [deviceAuth?.userCode]);

  const beginPolling = React.useCallback(() => {
    if (serviceId !== 'openai-codex' || !profileId || !deviceAuth) return;
    fireAndForget((async () => {
      setPolling(true);
      setError(null);
      try {
        const credentials = ensureCredentials();
        const publicKey = encodeBase64(keyPairRef.current!.publicKey, 'base64url');

        while (!cancelledRef.current) {
          const polled = await pollOpenAiCodexDeviceAuthViaProxy(credentials, {
            publicKey,
            deviceAuthId: deviceAuth.deviceAuthId,
            userCode: deviceAuth.userCode,
            intervalMs: deviceAuth.intervalMs,
          });

          if (cancelledRef.current) return;
          if (polled.status === 'pending') {
            await delay(polled.retryAfterMs);
            continue;
          }

          const payload = parseConnectedServiceOauthProxyBundle({
            bundleB64Url: polled.bundle,
            recipientSecretKey: keyPairRef.current!.secretKey,
          });
          if (payload.serviceId !== serviceId) {
            throw new Error('OAuth bundle service mismatch');
          }

          const now = Date.now();
          const record = buildOauthRecordFromProxyPayload({
            now,
            serviceId,
            profileId,
            payload,
          });

          await storeConnectedServiceCredentialForAccount(credentials, { serviceId, profileId, record });
          await sync.refreshProfile();

          await Modal.alert(
            t('connectedServices.deviceAuth.alerts.connectedTitle'),
            t('connectedServices.deviceAuth.alerts.connectedBody', { serviceId, profileId }),
          );

          props.onDone();
          return;
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : t('connectedServices.deviceAuth.alerts.failedToConnect');
        setError(message);
        await Modal.alert(t('common.error'), message);
      } finally {
        if (!cancelledRef.current) setPolling(false);
      }
    })(), { tag: 'OpenAiCodexDeviceAuthView.poll' });
  }, [deviceAuth, profileId, serviceId, props.onDone]);

  React.useEffect(() => {
    if (!deviceAuth || pollingStartedRef.current) return;
    pollingStartedRef.current = true;
    beginPolling();
  }, [beginPolling, deviceAuth]);

  if (serviceId !== 'openai-codex' || !profileId) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>{t('connectedServices.deviceAuth.invalidConfig')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <ItemGroup title={t('connectedServices.deviceAuth.userCode')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <View
            style={[
              styles.codeRow,
              { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider },
            ]}
          >
            <Text
              selectable={true}
              testID="connectedServices.deviceAuth.userCode"
              style={[
                styles.codeText,
                Typography.mono('semiBold'),
                { color: theme.colors.text },
              ]}
            >
              {deviceAuth?.userCode || t('connectedServices.deviceAuth.preparing')}
            </Text>
            <Pressable
              testID="connectedServices.deviceAuth.copyCodeButton"
              accessibilityRole="button"
              accessibilityLabel={t('common.copy')}
              onPress={!deviceAuth?.userCode ? undefined : () => void copyUserCode()}
              style={[
                styles.copyButton,
                { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHighest },
              ]}
            >
              <Ionicons
                name={copied ? 'checkmark-outline' : 'copy-outline'}
                size={14}
                color={copied ? (theme.colors.success ?? theme.colors.textSecondary) : theme.colors.textSecondary}
              />
              <Text
                style={[
                  styles.copyButtonText,
                  { color: copied ? (theme.colors.success ?? theme.colors.textSecondary) : theme.colors.textSecondary },
                ]}
              >
                {copied ? t('common.copied') : t('common.copy')}
              </Text>
            </Pressable>
          </View>
          <Text style={{ opacity: 0.7, marginTop: 10 }}>
            {t('connectedServices.deviceAuth.securityHint')}
          </Text>
        </View>
      </ItemGroup>

      <ItemGroup title={t('connectedServices.deviceAuth.openVerificationUrl')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text selectable={true} style={{ opacity: 0.9 }}>
            {deviceAuth?.verificationUrl || t('connectedServices.deviceAuth.preparing')}
          </Text>
          <View style={{ marginTop: 12 }}>
            <RoundButton
              size="normal"
              title={t('connectedServices.deviceAuth.openVerificationUrl')}
              disabled={!deviceAuth?.verificationUrl}
              onPress={
                deviceAuth?.verificationUrl
                  ? () => void Linking.openURL(deviceAuth.verificationUrl).catch(() => {})
                  : undefined
              }
            />
          </View>
          <Text style={{ opacity: 0.7, marginTop: 10 }}>
            {t('connectedServices.deviceAuth.deviceAuthDisabledHint')}
          </Text>
        </View>
      </ItemGroup>

      <ItemGroup title={t('connectedServices.deviceAuth.waiting')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          {starting ? (
            <Text style={{ opacity: 0.7 }}>{t('connectedServices.deviceAuth.preparing')}</Text>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {polling ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
                <Text style={{ opacity: 0.7 }}>{t('connectedServices.deviceAuth.waiting')}</Text>
              </View>
              {error ? (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ opacity: 0.9 }}>{error}</Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      </ItemGroup>

      {props.fallbackAction ? (
        <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
          <Item
            testID="connectedServices.deviceAuth.switchMethodItem"
            title={props.fallbackAction.title}
            subtitle={props.fallbackAction.subtitle}
            icon={<Ionicons name="swap-horizontal-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={props.fallbackAction.onPress}
          />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

const styles = StyleSheet.create({
  codeRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  codeText: {
    fontSize: 22,
    letterSpacing: 1.6,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  copyButtonText: {
    fontSize: 12,
  },
});
