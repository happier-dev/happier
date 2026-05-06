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
  tokenKind: 'api-key' | 'setup-token' | 'personal-access-token' | 'api-token' | null;
  tokenSetupUrl?: string | null;
  onAddOauthProfile: (method: 'device' | 'paste' | 'browser' | null) => void;
  onConnectToken: () => void;
  onOpenTokenSetup?: () => void;
}>) {
  const { theme } = useUnistyles();
  const oauthModes = props.oauthAddActionModes ?? [];
  const showExplicitOauthModes = oauthModes.length > 0;
  const singleOauthMode: 'device' | 'paste' | 'browser' | null = oauthModes[0] ?? null;

  return (
    <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
      {props.supportsToken && props.tokenSetupUrl ? (
        <Item
          testID="connected-services-action:open-token-setup"
          title={
            props.tokenKind === 'personal-access-token'
              ? t('connectedServices.detail.openPersonalAccessTokenSetupTitle')
              : t('connectedServices.detail.openTokenSetupTitle')
          }
          subtitle={
            props.tokenKind === 'personal-access-token'
              ? t('connectedServices.detail.openPersonalAccessTokenSetupSubtitle')
              : t('connectedServices.detail.openTokenSetupSubtitle')
          }
          icon={<Ionicons name="open-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={props.onOpenTokenSetup}
        />
      ) : null}
      {props.supportsToken ? (
        <Item
          testID="connected-services-action:connect-token"
          title={
            props.tokenKind === 'setup-token'
              ? t('connectedServices.detail.connectSetupTokenTitle')
              : props.tokenKind === 'personal-access-token'
                ? t('connectedServices.detail.connectPersonalAccessTokenTitle')
                : props.tokenKind === 'api-token'
                  ? t('connectedServices.detail.connectApiTokenTitle')
              : t('connectedServices.detail.connectApiKeyTitle')
          }
          subtitle={
            props.tokenKind === 'setup-token'
              ? t('connectedServices.detail.connectSetupTokenSubtitle')
              : props.tokenKind === 'personal-access-token'
                ? t('connectedServices.detail.connectPersonalAccessTokenSubtitle')
                : props.tokenKind === 'api-token'
                  ? t('connectedServices.detail.connectApiTokenSubtitle')
              : t('connectedServices.detail.connectApiKeySubtitle')
          }
          icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={props.onConnectToken}
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
