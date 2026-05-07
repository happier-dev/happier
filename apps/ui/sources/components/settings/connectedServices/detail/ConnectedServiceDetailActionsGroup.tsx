import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export const ConnectedServiceDetailActionsGroup = React.memo(function ConnectedServiceDetailActionsGroup(props: Readonly<{
  supportsOauth: boolean;
  oauthAddActionModes?: ReadonlyArray<'device' | 'paste' | 'browser'>;
  supportsToken: boolean;
  tokenKind: 'access-token' | 'api-key' | 'setup-token' | null;
  tokenSetupUrl?: string | null;
  onAddOauthProfile: (method: 'device' | 'paste' | 'browser' | null) => void;
  onConnectToken: () => void;
  onOpenTokenSetupUrl: (url: string) => void;
}>) {
  const { theme } = useUnistyles();
  const oauthModes = props.oauthAddActionModes ?? [];
  const showExplicitOauthModes = oauthModes.length > 0;
  const singleOauthMode: 'device' | 'paste' | 'browser' | null = oauthModes[0] ?? null;
  const tokenSetupUrl = props.tokenSetupUrl ?? null;

  return (
    <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
      {props.supportsToken ? (
        <Item
          testID="connected-services-action:connect-token"
          title={
            props.tokenKind === 'setup-token'
              ? t('connectedServices.detail.connectSetupTokenTitle')
              : props.tokenKind === 'access-token'
                ? t('connectedServices.detail.connectAccessTokenTitle')
                : t('connectedServices.detail.connectApiKeyTitle')
          }
          subtitle={
            props.tokenKind === 'setup-token'
              ? t('connectedServices.detail.connectSetupTokenSubtitle')
              : props.tokenKind === 'access-token'
                ? t('connectedServices.detail.connectAccessTokenSubtitle')
                : t('connectedServices.detail.connectApiKeySubtitle')
          }
          icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={props.onConnectToken}
        />
      ) : null}
      {props.tokenKind === 'access-token' && tokenSetupUrl ? (
        <Item
          testID="connected-services-action:open-github-token-template"
          title={t('connectedServices.detail.openGithubTokenTemplateTitle')}
          subtitle={t('connectedServices.detail.openGithubTokenTemplateSubtitle')}
          icon={<Ionicons name="open-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={() => props.onOpenTokenSetupUrl(tokenSetupUrl)}
        />
      ) : null}
      {props.supportsOauth ? (
        <>
          {showExplicitOauthModes ? (
            oauthModes.map((mode) => {
              const titleKey =
                mode === 'device'
                  ? t('connectedServices.detail.addOauthProfileDeviceTitle')
                  : mode === 'paste'
                    ? t('connectedServices.detail.addOauthProfilePasteTitle')
                    : t('connectedServices.detail.addOauthProfileBrowserTitle');
              const subtitleKey =
                mode === 'device'
                  ? t('connectedServices.detail.addOauthProfileDeviceSubtitle')
                  : mode === 'paste'
                    ? t('connectedServices.detail.addOauthProfilePasteSubtitle')
                    : t('connectedServices.detail.addOauthProfileBrowserSubtitle');
              return (
                <Item
                  key={`add-oauth:${mode}`}
                  testID={`connected-services-action:add-oauth-profile-${mode}`}
                  title={titleKey}
                  subtitle={subtitleKey}
                  icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
                  onPress={() => props.onAddOauthProfile(mode)}
                />
              );
            })
          ) : (
            <Item
              testID="connected-services-action:add-oauth-profile"
              title={t('connectedServices.detail.addOauthProfileTitle')}
              subtitle={t('connectedServices.detail.addOauthProfileSubtitle')}
              icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
              onPress={() => props.onAddOauthProfile(singleOauthMode)}
            />
          )}
        </>
      ) : null}
    </ItemGroup>
  );
});
