import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PromptBundleBodyV1Schema, PromptDocBodyV1Schema } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { sync } from '@/sync/sync';
import { storage, useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { updateSkillPromptBundle, readSkillMarkdownFromPromptBundleBody } from '@/sync/ops/promptLibrary/promptBundles';
import { updatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { normalizePromptFolderName, removePromptFolder, renamePromptFolder } from '@/sync/ops/promptLibrary/promptFolders';
import { t } from '@/text';

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
}));

export const PromptFoldersScreen = React.memo(function PromptFoldersScreen() {
  const { theme } = useUnistyles();
  const artifacts = useArtifacts();
  const [promptFoldersV1, setPromptFoldersV1] = useSettingMutable('promptFoldersV1');

  const folders = React.useMemo(() => (
    (promptFoldersV1?.folders ?? []).slice().sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  ), [promptFoldersV1?.folders]);

  const usageCountByFolderId = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const artifact of artifacts) {
      const folderId = typeof artifact.header?.folderId === 'string' ? artifact.header.folderId : null;
      if (!folderId) continue;
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
    return counts;
  }, [artifacts]);

  const addFolder = React.useCallback(async () => {
    const raw = await Modal.prompt(t('promptLibrary.addFolder'), t('promptLibrary.addFolderSubtitle'));
    const name = normalizePromptFolderName(String(raw ?? ''));
    if (!name) return;
    const exists = folders.some((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (exists) return;
    setPromptFoldersV1({
      v: 1,
      folders: [...folders, { id: randomUUID(), name, parentId: null }],
    });
  }, [folders, setPromptFoldersV1]);

  const renameFolderAction = React.useCallback(async (folderId: string, currentName: string) => {
    const raw = await Modal.prompt(t('promptLibrary.renameFolder'), undefined, { defaultValue: currentName });
    const nextName = normalizePromptFolderName(String(raw ?? ''));
    if (!nextName || nextName === currentName) return;
    setPromptFoldersV1(renamePromptFolder(promptFoldersV1, folderId, nextName));
  }, [promptFoldersV1, setPromptFoldersV1]);

  const deleteFolderAction = React.useCallback(async (folderId: string) => {
    const confirmed = await Modal.confirm(
      t('promptLibrary.deleteFolderTitle'),
      t('promptLibrary.deleteFolderBody'),
      { confirmText: t('common.delete'), destructive: true },
    );
    if (!confirmed) return;

    const linkedArtifacts = artifacts.filter((artifact) => artifact.header?.folderId === folderId);
    for (const artifact of linkedArtifacts) {
      if (artifact.header?.kind === 'prompt_doc.v2') {
        let bodyText = typeof artifact.body === 'string' ? artifact.body : null;
        if (!bodyText) {
          const full = await sync.fetchArtifactWithBody(artifact.id);
          if (full) {
            storage.getState().updateArtifact(full);
            bodyText = typeof full.body === 'string' ? full.body : null;
          }
        }
        if (!bodyText) continue;
        let bodyJson: unknown;
        try {
          bodyJson = JSON.parse(bodyText);
        } catch {
          continue;
        }
        const parsed = PromptDocBodyV1Schema.safeParse(bodyJson);
        if (!parsed.success) continue;
        await updatePromptDoc({
          artifactId: artifact.id,
          title: String(artifact.header?.title ?? artifact.title ?? ''),
          markdown: parsed.data.markdown,
          folderId: null,
          tags: Array.isArray(artifact.header?.tags) ? artifact.header.tags as string[] : [],
        });
      } else if (artifact.header?.kind === 'prompt_bundle.v2') {
        let bodyText = typeof artifact.body === 'string' ? artifact.body : null;
        if (!bodyText) {
          const full = await sync.fetchArtifactWithBody(artifact.id);
          if (full) {
            storage.getState().updateArtifact(full);
            bodyText = typeof full.body === 'string' ? full.body : null;
          }
        }
        if (!bodyText) continue;
        let bodyJson: unknown;
        try {
          bodyJson = JSON.parse(bodyText);
        } catch {
          continue;
        }
        const parsed = PromptBundleBodyV1Schema.safeParse(bodyJson);
        if (!parsed.success) continue;
        await updateSkillPromptBundle({
          artifactId: artifact.id,
          title: String(artifact.header?.title ?? artifact.title ?? ''),
          skillMarkdown: readSkillMarkdownFromPromptBundleBody(parsed.data) ?? '',
          folderId: null,
          tags: Array.isArray(artifact.header?.tags) ? artifact.header.tags as string[] : [],
        });
      }
    }

    setPromptFoldersV1(removePromptFolder(promptFoldersV1, folderId));
  }, [artifacts, promptFoldersV1, setPromptFoldersV1]);

  return (
    <View style={styles.container}>
      <ItemList containerStyle={styles.content}>
        <ItemGroup title={t('promptLibrary.folders')}>
          {folders.length > 0 ? folders.map((folder) => (
            <Item
              key={folder.id}
              testID={`promptFolders.entry.${folder.id}`}
              title={folder.name}
              subtitle={t('promptLibrary.folderUsageCount', { count: usageCountByFolderId.get(folder.id) ?? 0 })}
              icon={<Ionicons name="folder-outline" size={29} color={theme.colors.accent.blue} />}
              rightElement={(
                <ItemRowActions
                  title={folder.name}
                  compactActionIds={['rename', 'delete']}
                  actions={[
                    {
                      id: 'rename',
                      title: t('common.edit'),
                      icon: 'pencil-outline',
                      onPress: () => { void renameFolderAction(folder.id, folder.name); },
                    },
                    {
                      id: 'delete',
                      title: t('common.delete'),
                      icon: 'trash-outline',
                      destructive: true,
                      onPress: () => { void deleteFolderAction(folder.id); },
                    },
                  ]}
                />
              )}
            />
          )) : (
            <Item
              testID="promptFolders.empty"
              title={t('promptLibrary.foldersEmptyTitle')}
              subtitle={t('promptLibrary.foldersEmptySubtitle')}
              showChevron={false}
            />
          )}
        </ItemGroup>

        <ItemGroup>
          <Item
            testID="promptFolders.add"
            title={t('promptLibrary.addFolder')}
            subtitle={t('promptLibrary.addFolderSubtitle')}
            icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accent.indigo} />}
            onPress={() => { void addFolder(); }}
          />
        </ItemGroup>
      </ItemList>
    </View>
  );
});
