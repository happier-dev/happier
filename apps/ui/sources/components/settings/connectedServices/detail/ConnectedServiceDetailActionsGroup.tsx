import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export const ConnectedServiceDetailActionsGroup = React.memo(function ConnectedServiceDetailActionsGroup(props: Readonly<{
  defaultProfileId: string;
  supportsOauth: boolean;
  supportsToken: boolean;
  tokenKind: 'api-key' | 'setup-token' | null;
  onSetDefaultProfile: () => void;
  onSetProfileLabel: () => void;
  onAddOauthProfile: () => void;
  onConnectToken: () => void;
}>) {
  const { theme } = useUnistyles();

  return (
    <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
      <Item
        testID="connected-services-action:set-default-profile"
        title={t('connectedServices.detail.setDefaultProfileTitle')}
        subtitle={
          props.defaultProfileId
            ? t('connectedServices.detail.setDefaultProfileSubtitleDefault', { profileId: props.defaultProfileId })
            : t('connectedServices.detail.setDefaultProfileSubtitleChoose')
        }
        icon={<Ionicons name="star-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={props.onSetDefaultProfile}
      />
      <Item
        testID="connected-services-action:set-profile-label"
        title={t('connectedServices.detail.setProfileLabelTitle')}
        subtitle={t('connectedServices.detail.setProfileLabelSubtitle')}
        icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={props.onSetProfileLabel}
      />
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
        <Item
          testID="connected-services-action:add-oauth-profile"
          title={t('connectedServices.detail.addOauthProfileTitle')}
          subtitle={t('connectedServices.detail.addOauthProfileSubtitle')}
          icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={props.onAddOauthProfile}
        />
      ) : null}
    </ItemGroup>
  );
});
