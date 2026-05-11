import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { layout } from '@/components/ui/layout/layout';
import { TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { deleteArtifact } from '@/sync/api/artifacts/apiArtifacts';
import { useAllMachines, useArtifacts, useSettingMutable, storage } from '@/sync/domains/state/storage';
import { duplicatePromptBundle } from '@/sync/ops/promptLibrary/promptBundles';
import { duplicatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { findPromptFolderById } from '@/sync/ops/promptLibrary/promptFolders';
import { removePromptLibraryArtifactReferences } from '@/sync/ops/promptLibrary/promptLibraryReferences';
import { sync } from '@/sync/sync';
import { t } from '@/text';

import { describePromptLibraryEntrySubtitle } from './describePromptLibraryEntrySubtitle';

type PromptLibraryEntryListKind = 'doc' | 'bundle';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    paddingVertical: 12,
    maxWidth: layout.maxWidth,
    width: '100%',
    alignSelf: 'center',
  },
  input: {
    backgroundColor: theme.colors.input.background,
    color: theme.colors.input.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 12,
    ...SETTINGS_TEXT_INPUT_METRICS,
  },
}));

function getScreenConfig(kind: PromptLibraryEntryListKind) {
  if (kind === 'doc') {
    return {
      title: t('promptLibrary.prompts'),
      emptyTitle: t('promptLibrary.noPrompts'),
      emptySubtitle: t('promptLibrary.noPromptsSubtitle'),
      addTitle: t('promptLibrary.addPrompt'),
      addIcon: 'add-circle-outline' as const,
      addHref: '/settings/prompts/docs/new',
      editHref: (artifactId: string) => `/settings/prompts/docs/${artifactId}`,
      exportHref: (artifactId: string) => `/settings/prompts/docs/${artifactId}/export`,
      itemIcon: 'document-text-outline' as const,
      testPrefix: 'promptLibrary.entry.doc',
    };
  }

  return {
    title: t('promptLibrary.skills'),
    emptyTitle: t('promptLibrary.noSkills'),
    emptySubtitle: t('promptLibrary.noSkillsSubtitle'),
    addTitle: t('promptLibrary.addSkill'),
    addIcon: 'add-circle-outline' as const,
    addHref: '/settings/prompts/skills/new',
    editHref: (artifactId: string) => `/settings/prompts/skills/${artifactId}`,
    exportHref: (artifactId: string) => `/settings/prompts/skills/${artifactId}/export`,
    itemIcon: 'sparkles-outline' as const,
    testPrefix: 'promptLibrary.entry.bundle',
  };
}

export const PromptLibraryEntryListScreen = React.memo((props: Readonly<{ kind: PromptLibraryEntryListKind }>) => {
  const router = useRouter();
  const { theme } = useUnistyles();
  const artifacts = useArtifacts();
  const machines = useAllMachines();
  const [promptInvocationsV1, setPromptInvocationsV1] = useSettingMutable('promptInvocationsV1');
  const [promptStacksV1, setPromptStacksV1] = useSettingMutable('promptStacksV1');
  const [promptExternalLinksV1, setPromptExternalLinksV1] = useSettingMutable('promptExternalLinksV1');
  const [promptFoldersV1] = useSettingMutable('promptFoldersV1');
  const [searchQuery, setSearchQuery] = React.useState('');
  const screen = getScreenConfig(props.kind);

  const entries = React.useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return artifacts
      .filter((artifact) => props.kind === 'doc'
        ? artifact.header?.kind === 'prompt_doc.v2'
        : artifact.header?.kind === 'prompt_bundle.v2')
      .filter((artifact) => {
        if (!normalizedQuery) return true;
        const title = typeof artifact.header?.title === 'string' ? artifact.header.title : artifact.title ?? '';
        const folderName = findPromptFolderById(
          promptFoldersV1,
          typeof artifact.header?.folderId === 'string' ? artifact.header.folderId : null,
        )?.name ?? '';
        const tags = Array.isArray(artifact.header?.tags)
          ? artifact.header.tags.filter((tag): tag is string => typeof tag === 'string')
          : [];
        return [title, folderName, ...tags].join('\n').toLowerCase().includes(normalizedQuery);
      })
      .slice()
      .sort((left, right) => {
        const leftTitle = typeof left.header?.title === 'string' ? left.header.title : left.title ?? '';
        const rightTitle = typeof right.header?.title === 'string' ? right.header.title : right.title ?? '';
        return leftTitle.localeCompare(rightTitle, undefined, { sensitivity: 'base' });
      });
  }, [artifacts, promptFoldersV1, props.kind, searchQuery]);

  const deleteEntry = React.useCallback(async (artifactId: string) => {
    const confirmed = await Modal.confirm(
      t('promptLibrary.deleteLibraryItemTitle'),
      t('promptLibrary.deleteLibraryItemBody'),
      { confirmText: t('common.delete'), destructive: true },
    );
    if (!confirmed) return;

    const credentials = sync.getCredentials();
    if (!credentials) {
      Modal.alert(t('common.error'), t('errors.unknownError'));
      return;
    }

    try {
      await deleteArtifact(credentials, artifactId);
    } catch {
      Modal.alert(t('common.error'), t('errors.unknownError'));
      return;
    }
    storage.getState().deleteArtifact(artifactId);

    const next = removePromptLibraryArtifactReferences({
      artifactId,
      promptInvocationsV1,
      promptStacksV1,
      promptExternalLinksV1,
    });
    setPromptInvocationsV1(next.promptInvocationsV1);
    setPromptStacksV1(next.promptStacksV1);
    setPromptExternalLinksV1(next.promptExternalLinksV1);
  }, [promptExternalLinksV1, promptInvocationsV1, promptStacksV1, setPromptExternalLinksV1, setPromptInvocationsV1, setPromptStacksV1]);

  const duplicateEntry = React.useCallback(async (artifactId: string) => {
    try {
      const nextArtifactId = props.kind === 'doc'
        ? await duplicatePromptDoc(artifactId)
        : await duplicatePromptBundle(artifactId);
      router.push(screen.editHref(nextArtifactId));
    } catch {
      Modal.alert(t('common.error'), t('errors.unknownError'));
    }
  }, [props.kind, router, screen]);

  return (
    <View style={styles.container}>
      <ItemList containerStyle={styles.content}>
        <ItemGroup title={screen.title}>
          <TextInput
            testID={`promptLibrary.search.${props.kind}`}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('promptLibrary.librarySearchPlaceholder')}
            placeholderTextColor={theme.colors.input.placeholder}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {entries.length > 0 ? entries.map((artifact) => {
            const artifactTitle = typeof artifact.header?.title === 'string' ? artifact.header.title : artifact.title ?? (
              props.kind === 'doc' ? t('promptLibrary.untitledPrompt') : t('promptLibrary.untitledSkill')
            );
            const linkedTargets = (promptExternalLinksV1?.links ?? [])
              .filter((entry) => entry.artifactId === artifact.id)
              .map((entry) => {
                const machineTitle = machines.find((machine) => machine.id === entry.machineId)?.metadata?.displayName
                  ?? machines.find((machine) => machine.id === entry.machineId)?.metadata?.host
                  ?? entry.machineId;
                return machineTitle;
              });
            const folderName = findPromptFolderById(
              promptFoldersV1,
              typeof artifact.header?.folderId === 'string' ? artifact.header.folderId : null,
            )?.name ?? null;
            const tags = Array.isArray(artifact.header?.tags)
              ? artifact.header.tags.filter((tag): tag is string => typeof tag === 'string')
              : [];
            return (
              <Item
                key={artifact.id}
                testID={`${screen.testPrefix}.${artifact.id}`}
                title={artifactTitle}
                subtitle={describePromptLibraryEntrySubtitle({
                  origin: typeof artifact.header?.origin === 'string' ? artifact.header.origin : null,
                  linkedTargets,
                  folderName,
                  tags,
                  labels: {
                    imported: t('promptLibrary.imported'),
                    builtIn: t('promptLibrary.builtIn'),
                    exportsCount: (count) => t('promptLibrary.linkedAssetsCount', { count }),
                  },
                })}
                icon={<Ionicons name={screen.itemIcon} size={29} color={theme.colors.text.secondary} />}
                onPress={() => router.push(screen.editHref(artifact.id))}
                rightElement={(
                  <ItemRowActions
                    title={artifactTitle}
                    compactActionIds={['edit', 'delete']}
                    actions={[
                      {
                        id: 'edit',
                        title: t('common.edit'),
                        icon: 'pencil-outline',
                        onPress: () => router.push(screen.editHref(artifact.id)),
                      },
                      {
                        id: 'duplicate',
                        title: t('common.duplicate'),
                        icon: 'copy-outline',
                        onPress: () => { void duplicateEntry(artifact.id); },
                      },
                      {
                        id: 'external',
                        title: t('promptLibrary.manageExternalAssets'),
                        icon: 'cloud-upload-outline',
                        onPress: () => router.push(screen.exportHref(artifact.id)),
                      },
                      {
                        id: 'delete',
                        title: t('common.delete'),
                        icon: 'trash-outline',
                        destructive: true,
                        onPress: () => { void deleteEntry(artifact.id); },
                      },
                    ]}
                  />
                )}
              />
            );
          }) : (
            <Item
              testID={`promptLibrary.empty.${props.kind}`}
              title={screen.emptyTitle}
              subtitle={screen.emptySubtitle}
              icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
          )}
        </ItemGroup>

        <ItemGroup>
          <Item
            testID={`promptLibrary.add.${props.kind}`}
            title={screen.addTitle}
            icon={<Ionicons name={screen.addIcon} size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push(screen.addHref)}
          />
        </ItemGroup>
      </ItemList>
    </View>
  );
});

PromptLibraryEntryListScreen.displayName = 'PromptLibraryEntryListScreen';
