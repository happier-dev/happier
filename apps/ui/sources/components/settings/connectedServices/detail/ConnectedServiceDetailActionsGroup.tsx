import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

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
    <ItemGroup title="Actions">
      <Item
        title="Set default profile"
        subtitle={props.defaultProfileId ? `Default: ${props.defaultProfileId}` : 'Choose which profile is selected by default'}
        icon={<Ionicons name="star-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={props.onSetDefaultProfile}
      />
      <Item
        title="Set profile label"
        subtitle="Optional label shown in auth pickers"
        icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={props.onSetProfileLabel}
      />
      <Item
        title="Add OAuth profile"
        subtitle="Connect a new account profile"
        icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
        onPress={props.onAddOauthProfile}
      />
      {props.supportsSetupToken ? (
        <Item
          title="Connect via setup-token"
          subtitle="Paste a Claude setup-token"
          icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={props.onConnectSetupToken}
        />
      ) : null}
    </ItemGroup>
  );
});
