import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Icon } from '@/components/ui/icons/Icon';

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
            icon={<Icon name="file-text" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/prompts/docs')}
          />
          <Item
            testID="settings-prompts-library-skills"
            title={t('promptLibrary.skills')}
            subtitle={t('promptLibrary.skillsSubtitle')}
            icon={<Icon name="sparkle" size={29} color={theme.colors.accent.indigo} />}
            onPress={() => router.push('/settings/prompts/skills')}
          />
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.sections')}>
          <Item
            testID="settings-prompts-folders"
            title={t('promptLibrary.folders')}
            subtitle={t('promptLibrary.foldersSubtitle')}
            icon={<Icon name="folder-open" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/prompts/folders')}
          />
          <Item
            testID="settings-prompts-templates"
            title={t('promptLibrary.templates')}
            subtitle={t('promptLibrary.templatesSubtitle')}
            icon={<Icon name="lightning" size={29} color={theme.colors.accent.indigo} />}
            onPress={() => router.push('/settings/prompts/templates')}
          />
          <Item
            testID="settings-prompts-stacks"
            title={t('promptLibrary.stacks')}
            subtitle={t('promptLibrary.stacksSubtitle')}
            icon={<Icon name="stack-simple" size={29} color={theme.colors.text.secondary} />}
            onPress={() => router.push('/settings/prompts/stacks')}
          />
          {promptAssetsExternalEnabled ? (
            <Item
              testID="settings-prompts-assets"
              title={t('promptLibrary.externalAssets')}
              subtitle={t('promptLibrary.externalAssetsSubtitle')}
              icon={<Icon name="download" size={29} color={theme.colors.accent.purple} />}
              onPress={() => router.push('/settings/prompts/assets')}
            />
          ) : null}
          {promptRegistriesEnabled ? (
            <Item
              testID="settings-prompts-registries"
              title={t('promptLibrary.registries')}
              subtitle={t('promptLibrary.registriesSubtitle')}
              icon={<Icon name="graph" size={29} color={theme.colors.accent.purple} />}
              onPress={() => router.push('/settings/prompts/registries')}
            />
          ) : null}
        </ItemGroup>
      </ScrollView>
    </View>
  );
});

PromptsSettingsHome.displayName = 'PromptsSettingsHome';
