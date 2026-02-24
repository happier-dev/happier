import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export const ConnectedServiceDetailActionsGroup = React.memo(function ConnectedServiceDetailActionsGroup(props: Readonly<{
  defaultProfileId: string;
  supportsSetupToken: boolean;
  onSetDefaultProfile: () => void;
  onSetProfileLabel: () => void;
  onAddOauthProfile: () => void;
  onConnectSetupToken: () => void;
}>) {
  const { theme } = useUnistyles();

  return (
    <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
      <Item
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
        title={t('connectedServices.detail.setProfileLabelTitle')}
        subtitle={t('connectedServices.detail.setProfileLabelSubtitle')}
        icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={props.onSetProfileLabel}
      />
      <Item
        title={t('connectedServices.detail.addOauthProfileTitle')}
        subtitle={t('connectedServices.detail.addOauthProfileSubtitle')}
        icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={props.onAddOauthProfile}
      />
      {props.supportsSetupToken ? (
        <Item
          title={t('connectedServices.detail.connectSetupTokenTitle')}
          subtitle={t('connectedServices.detail.connectSetupTokenSubtitle')}
          icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={props.onConnectSetupToken}
        />
      ) : null}
    </ItemGroup>
  );
});
