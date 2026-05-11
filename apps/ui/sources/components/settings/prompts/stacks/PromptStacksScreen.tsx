import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { layout } from '@/components/ui/layout/layout';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
}));

export const PromptStacksScreen = React.memo(() => {
  const { theme } = useUnistyles();
  const router = useRouter();
  const promptStacks = useSetting('promptStacksV1');

  const profileCount = Object.keys(promptStacks?.surfaces?.profilesById ?? {}).length;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingVertical: 12, maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
        <ItemGroup title={t('promptLibrary.stacks')}>
          <Item
            testID="promptStacks.coding"
            title={t('promptLibrary.codingStack')}
            subtitle={t('promptLibrary.codingStackSubtitle')}
            icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/prompts/stacks/coding')}
          />
          <Item
            testID="promptStacks.voice"
            title={t('promptLibrary.voiceStack')}
            subtitle={t('promptLibrary.voiceStackSubtitle')}
            icon={<Ionicons name="mic-outline" size={29} color={theme.colors.accent.indigo} />}
            onPress={() => router.push('/settings/prompts/stacks/voice')}
          />
          <Item
            testID="promptStacks.profiles"
            title={t('promptLibrary.profileStacks')}
            subtitle={t('promptLibrary.profileStacksSubtitle', { count: profileCount })}
            icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.text.secondary} />}
            onPress={() => router.push('/settings/prompts/stacks/profiles')}
          />
        </ItemGroup>
      </ScrollView>
    </View>
  );
});

PromptStacksScreen.displayName = 'PromptStacksScreen';
