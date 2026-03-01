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
  tokenKind: 'api-key' | 'setup-token' | null;
  onAddOauthProfile: (method: 'device' | 'paste' | 'browser' | null) => void;
  onConnectToken: () => void;
}>) {
  const { theme } = useUnistyles();
  const singleOauthMode: 'device' | 'paste' | 'browser' | null = props.oauthAddActionModes?.[0] ?? null;

  return (
    <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
      {props.supportsToken ? (
        <Item
          testID="connected-services-action:connect-token"
          title={
            props.tokenKind === 'setup-token'
              ? t('connectedServices.detail.connectSetupTokenTitle')
              : t('connectedServices.detail.connectApiKeyTitle')
          }
          subtitle={
            props.tokenKind === 'setup-token'
              ? t('connectedServices.detail.connectSetupTokenSubtitle')
              : t('connectedServices.detail.connectApiKeySubtitle')
          }
          icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={props.onConnectToken}
        />
      ) : null}
      {props.supportsOauth ? (
        <>
          {(props.oauthAddActionModes ?? []).length > 1 ? (
            (props.oauthAddActionModes ?? []).map((mode) => {
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
