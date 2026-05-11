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

export const PromptProfileStacksScreen = React.memo(() => {
  const { theme } = useUnistyles();
  const router = useRouter();
  const profiles = useSetting('profiles');
  const promptStacksV1 = useSetting('promptStacksV1');

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingVertical: 12, maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
        <ItemGroup title={t('promptLibrary.profileStacks')}>
          {profiles.map((profile) => {
            const profileId = profile.id;
            const profileName = profile.name || profileId;
            const count = (promptStacksV1.surfaces.profilesById?.[profileId] ?? []).length;
            return (
              <Item
                key={profileId}
                testID={`promptStacks.profile.${profileId}`}
                title={profileName}
                subtitle={t('promptLibrary.profileStackCount', { count })}
                icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.text.secondary} />}
                onPress={() => router.push(`/settings/prompts/stacks/profiles/${encodeURIComponent(profileId)}`)}
              />
            );
          })}

          {profiles.length === 0 ? (
            <Item
              testID="promptStacks.profiles.empty"
              title={t('promptLibrary.noProfilesTitle')}
              subtitle={t('promptLibrary.noProfilesSubtitle')}
              icon={<Ionicons name="information-circle-outline" size={22} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
          ) : null}
        </ItemGroup>
      </ScrollView>
    </View>
  );
});

PromptProfileStacksScreen.displayName = 'PromptProfileStacksScreen';
