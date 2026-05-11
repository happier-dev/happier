import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { OAuthView, type OAuthViewConfig } from '@/components/ui/navigation/OAuthView';

export const ConnectedServiceOauthEmbeddedView = React.memo(function ConnectedServiceOauthEmbeddedView(props: Readonly<{
  name: string;
  command?: string;
  config: OAuthViewConfig;
  fallbackAction?: Readonly<{ title: string; subtitle?: string; onPress: () => void }>;
}>) {
  const { theme } = useUnistyles();
  const [started, setStarted] = React.useState(false);

  if (started) {
    return (
      <OAuthView
        name={props.name}
        command={props.command}
        config={props.config}
      />
    );
  }

  return (
    <ItemList>
      <ItemGroup title={t('connectedServices.oauthEmbedded.title')}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: theme.colors.text.secondary }}>
            {t('connectedServices.oauthEmbedded.description')}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <RoundButton
            testID="connectedServices.oauthEmbedded.startButton"
            size="normal"
            title={t('connectedServices.oauthEmbedded.startButton')}
            onPress={() => setStarted(true)}
          />
        </View>
      </ItemGroup>

      {props.fallbackAction ? (
        <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
          <Item
            testID="connectedServices.oauthEmbedded.switchMethodItem"
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
