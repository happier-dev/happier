import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/context/AuthContext';
import { generateOauthState, generatePkceCodes, parseOauthCallbackUrl } from '@/utils/auth/oauthCore';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import {
  ConnectedServiceIdSchema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { getConnectedServiceOauthAdapter } from '@/sync/domains/connectedServices/oauth/connectedServiceOauthAdapters';
import { resolveConnectedServiceOauthPasteCopy } from './oauth/resolveConnectedServiceOauthPasteCopy';
import { resolveConnectedServiceOauthErrorMessage } from './oauth/resolveConnectedServiceOauthErrorMessage';
import { storeConnectedServiceCredentialWithIdentityConfirmation } from './storeConnectedServiceCredentialWithIdentityConfirmation';
import { runConnectedServiceCredentialStoredEffects } from './runConnectedServiceCredentialStoredEffects';
import { Icon } from '@/components/ui/icons/Icon';

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
  const copy = React.useMemo(() => (serviceId ? resolveConnectedServiceOauthPasteCopy(serviceId) : null), [serviceId]);

  const [state, setState] = React.useState<string>('');
  const [pkce, setPkce] = React.useState<{ verifier: string; challenge: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [redirectUrlInput, setRedirectUrlInput] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [didShowOpenInstructions, setDidShowOpenInstructions] = React.useState(false);

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
    const pastedUrl = redirectUrlInput.trim();
    if (!pastedUrl) return;
    let exchangeAttempted = false;
    setBusy(true);
    try {
      const parsed = parseOauthCallbackUrl({ url: pastedUrl, redirectUri });
      if (parsed.error) throw new Error(`OAuth error: ${parsed.error}`);
      const code = parsed.code ?? '';
      const returnedState = parsed.state ?? '';
      if (!code) throw new Error('Missing code');
      if (!returnedState) throw new Error(copy?.missingStateError ?? t('connectedServices.oauthPaste.errors.missingState'));
      if (returnedState !== state) throw new Error(t('connectedServices.oauthPaste.errors.stateMismatch'));

      const credentials = ensureCredentials();
      const now = Date.now();
      exchangeAttempted = true;
      const record = await adapter.exchangeAuthorizationCodeForRecord({
        credentials,
        profileId,
        code,
        verifier: pkce.verifier,
        redirectUri,
        state: returnedState,
        now,
        ...(adapter.supportsProjectId && projectId.trim() ? { projectId: projectId.trim() } : {}),
      });

      const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(
        credentials,
        { serviceId, profileId, record },
        { onStored: runConnectedServiceCredentialStoredEffects },
      );
      if (!stored) return;

      await Modal.alert(
        t('connectedServices.oauthPaste.alerts.connectedTitle'),
        t('connectedServices.oauthPaste.alerts.connectedBody', { serviceId, profileId })
      );
      props.onDone();
    } catch (e: unknown) {
      if (exchangeAttempted) {
        // Google codes are single-use, including failed exchanges after token issuance.
        setRedirectUrlInput('');
        setState(generateOauthState());
        setPkce(await generatePkceCodes());
        setDidShowOpenInstructions(false);
      }
      const message = resolveConnectedServiceOauthErrorMessage(
        e,
        t('connectedServices.oauthPaste.alerts.failedToConnect'),
      );
      await Modal.alert(
        t('common.error'),
        message,
      );
    } finally {
      setBusy(false);
    }
  }, [adapter, auth.credentials, copy?.missingStateError, pkce, profileId, projectId, props, redirectUri, serviceId, state, redirectUrlInput]);

  const handleOpenAuthorization = React.useCallback(() => {
    if (!authorizationUrl) return;
    fireAndForget((async () => {
      if (!didShowOpenInstructions) {
        setDidShowOpenInstructions(true);
        await Modal.alertAsync(
          copy?.connectWebDescription ?? t('connectedServices.oauthPaste.connectWebDescription'),
          copy?.pasteRedirectUrlPromptBody ?? t('connectedServices.oauthPaste.pasteRedirectUrlPromptBody'),
          [{ text: t('connectedServices.oauthPaste.openAuthorizationUrl') }],
        );
      }
      const ok = await openExternalUrl(authorizationUrl);
      if (!ok) {
        await Modal.alert(
          t('common.error'),
          t('connectedServices.oauthPaste.alerts.failedToOpenUrl'),
        );
      }
    })(), { tag: 'ConnectedServiceOauthPasteView.openAuthorizationUrl' });
  }, [authorizationUrl, copy?.connectWebDescription, copy?.pasteRedirectUrlPromptBody, didShowOpenInstructions]);

  if (!serviceId || !profileId || !adapter) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.oauthPaste.invalidConfig')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList keyboardAware keyboardShouldPersistTaps="handled">
      <ItemGroup title={t('connectedServices.oauthPaste.connectWebGroupTitle')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: theme.colors.text.secondary }}>
            {copy?.connectWebDescription ?? t('connectedServices.oauthPaste.connectWebDescription')}
          </Text>
        </View>
      </ItemGroup>

      <ItemGroup title={t('connectedServices.oauthPaste.openAuthorizationUrl')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: theme.colors.text.secondary, marginBottom: 6 }}>{t('connectedServices.oauthPaste.openAuthorizationUrl')}</Text>
          <Text selectable={true} style={{ color: theme.colors.text.secondary }}>
            {authorizationUrl || t('connectedServices.oauthPaste.preparing')}
          </Text>
          <View style={{ marginTop: 12 }}>
            <RoundButton
              testID="connectedServices.oauthPaste.openAuthorizationButton"
              size="normal"
              title={t('connectedServices.oauthPaste.openAuthorizationUrl')}
              disabled={!authorizationUrl}
              onPress={handleOpenAuthorization}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <Text style={{ color: theme.colors.text.secondary }}>
              {authorizationUrl ? t('connectedServices.oauthPaste.opensInNewTab') : t('connectedServices.oauthPaste.preparing')}
            </Text>
          </View>
        </View>
      </ItemGroup>

      <ItemGroup title={t('connectedServices.oauthPaste.pasteRedirectUrl')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: theme.colors.text.secondary, marginBottom: 8 }}>
            {copy?.pasteRedirectUrlPromptBody ?? t('connectedServices.oauthPaste.pasteRedirectUrlPromptBody')}
          </Text>
          <TextInput
            testID="connectedServices.oauthPaste.redirectUrlInput"
            value={redirectUrlInput}
            onChangeText={setRedirectUrlInput}
            placeholder={copy?.pasteRedirectUrlPlaceholder ?? redirectUri}
            placeholderTextColor={theme.colors.input.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.redirectInput}
          />
          {adapter.supportsProjectId ? (
            <>
              <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.importAccounts.projectLabel')}</Text>
              <TextInput
                testID="connectedServices.oauthPaste.projectInput"
                value={projectId} onChangeText={setProjectId} editable={!busy}
                accessibilityLabel={t('connectedServices.importAccounts.projectLabel')}
                autoCapitalize="none" autoCorrect={false} style={styles.redirectInput}
              />
            </>
          ) : null}
          <RoundButton
            testID="connectedServices.oauthPaste.validateRedirectButton"
            size="normal"
            title={busy ? t('connectedServices.oauthPaste.working') : t('common.continue')}
            disabled={busy || !redirectUrlInput.trim()}
            onPress={busy ? undefined : handlePaste}
          />
          <View style={{ marginTop: 8 }}>
            <Text selectable={true} style={{ color: theme.colors.text.secondary }}>{redirectUri}</Text>
          </View>
        </View>
      </ItemGroup>

      {props.fallbackAction ? (
        <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
          <Item
            testID="connectedServices.oauthPaste.switchMethodItem"
            title={props.fallbackAction.title}
            icon={<Icon name="arrows-left-right" size={20} color={theme.colors.accent.blue} />}
            onPress={props.fallbackAction.onPress}
          />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

const styles = StyleSheet.create((theme) => ({
  redirectInput: {
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.input.background,
    color: theme.colors.input.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
}));
