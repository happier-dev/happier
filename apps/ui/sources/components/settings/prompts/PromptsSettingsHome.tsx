import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
}));

export const PromptsSettingsHome = React.memo(() => {
  const router = useRouter();
  const { theme } = useUnistyles();
  const promptAssetsExternalEnabled = useFeatureEnabled('prompts.assets.external');
  const promptRegistriesEnabled = useFeatureEnabled('prompts.skills.registries');

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingVertical: 12, maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
        <ItemGroup title={t('promptLibrary.library')}>
          <Item
            testID="settings-prompts-library-prompts"
            title={t('promptLibrary.prompts')}
            subtitle={t('promptLibrary.promptsSubtitle')}
            icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/prompts/docs')}
          />
          <Item
            testID="settings-prompts-library-skills"
            title={t('promptLibrary.skills')}
            subtitle={t('promptLibrary.skillsSubtitle')}
            icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.indigo} />}
            onPress={() => router.push('/settings/prompts/skills')}
          />
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.sections')}>
          <Item
            testID="settings-prompts-folders"
            title={t('promptLibrary.folders')}
            subtitle={t('promptLibrary.foldersSubtitle')}
            icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/prompts/folders')}
          />
          <Item
            testID="settings-prompts-templates"
            title={t('promptLibrary.templates')}
            subtitle={t('promptLibrary.templatesSubtitle')}
            icon={<Ionicons name="flash-outline" size={29} color={theme.colors.accent.indigo} />}
            onPress={() => router.push('/settings/prompts/templates')}
          />
          <Item
            testID="settings-prompts-stacks"
            title={t('promptLibrary.stacks')}
            subtitle={t('promptLibrary.stacksSubtitle')}
            icon={<Ionicons name="layers-outline" size={29} color={theme.colors.text.secondary} />}
            onPress={() => router.push('/settings/prompts/stacks')}
          />
          {promptAssetsExternalEnabled ? (
            <Item
              testID="settings-prompts-assets"
              title={t('promptLibrary.externalAssets')}
              subtitle={t('promptLibrary.externalAssetsSubtitle')}
              icon={<Ionicons name="download-outline" size={29} color={theme.colors.accent.purple} />}
              onPress={() => router.push('/settings/prompts/assets')}
            />
          ) : null}
          {promptRegistriesEnabled ? (
            <Item
              testID="settings-prompts-registries"
              title={t('promptLibrary.registries')}
              subtitle={t('promptLibrary.registriesSubtitle')}
              icon={<Ionicons name="git-network-outline" size={29} color={theme.colors.accent.purple} />}
              onPress={() => router.push('/settings/prompts/registries')}
            />
          ) : null}
        </ItemGroup>
      </ScrollView>
    </View>
  );
});

PromptsSettingsHome.displayName = 'PromptsSettingsHome';
