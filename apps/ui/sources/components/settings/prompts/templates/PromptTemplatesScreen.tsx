import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { PromptInvocationsV1 } from '@happier-dev/protocol';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
}));

export const PromptTemplatesScreen = React.memo(() => {
  const { theme } = useUnistyles();
  const router = useRouter();
  const artifacts = useArtifacts();
  const [invocations, setInvocations] = useSettingMutable('promptInvocationsV1');

  const promptDocTitleById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const artifact of artifacts) {
      if (artifact.header?.kind !== 'prompt_doc.v2') continue;
      const title = typeof artifact.header?.title === 'string' ? artifact.header.title : artifact.title;
      if (title) map.set(artifact.id, title);
    }
    return map;
  }, [artifacts]);

  const resolvedInvocations: PromptInvocationsV1 = invocations ?? { v: 1, entries: [] };
  const entries = resolvedInvocations.entries;
  const removeEntry = React.useCallback((entryId: string) => {
    Modal.alert(
      t('promptLibrary.deleteTemplate'),
      t('promptLibrary.deleteTemplateConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            setInvocations({
              ...resolvedInvocations,
              entries: entries.filter((entry) => entry.id !== entryId),
            });
          },
        },
      ],
    );
  }, [entries, resolvedInvocations, setInvocations]);

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{
          paddingVertical: 12,
          maxWidth: layout.maxWidth,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        <ItemGroup title={t('promptLibrary.templates')}>
          {entries.length > 0 ? entries.map((entry) => {
            const token = entry.token;
            const targetTitle = promptDocTitleById.get(entry.target.artifactId) ?? t('promptLibrary.untitledPrompt');
            const subtitle = `${token} → ${targetTitle}`;

            return (
              <Item
                key={entry.id}
                testID={`promptTemplates.entry.${entry.id}`}
                title={entry.title}
                subtitle={subtitle}
                icon={<Ionicons name="flash-outline" size={29} color={theme.colors.text.secondary} />}
                onPress={() => router.push(`/settings/prompts/templates/${entry.id}`)}
                rightElement={(
                  <ItemRowActions
                    title={entry.title}
                    compactActionIds={['edit', 'delete']}
                    actions={[
                      {
                        id: 'edit',
                        title: t('common.edit'),
                        icon: 'pencil-outline',
                        onPress: () => router.push(`/settings/prompts/templates/${entry.id}`),
                      },
                      {
                        id: 'delete',
                        title: t('common.delete'),
                        icon: 'trash-outline',
                        destructive: true,
                        onPress: () => removeEntry(entry.id),
                      },
                    ]}
                  />
                )}
              />
            );
          }) : (
            <Item
              testID="promptTemplates.empty"
              title={t('promptLibrary.templatesEmptyTitle')}
              subtitle={t('promptLibrary.templatesEmptySubtitle')}
              icon={<Ionicons name="flash-outline" size={29} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
          )}
        </ItemGroup>

        <ItemGroup>
          <Item
            testID="promptTemplates.add"
            title={t('promptLibrary.newTemplate')}
            subtitle={t('promptLibrary.newTemplateSubtitle')}
            icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/prompts/templates/new')}
          />
        </ItemGroup>
      </ScrollView>
    </View>
  );
});

PromptTemplatesScreen.displayName = 'PromptTemplatesScreen';
