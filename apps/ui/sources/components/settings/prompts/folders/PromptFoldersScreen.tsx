import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ArtifactFolderTree, useArtifactFolderCommands, type ArtifactFolderTreeHandle } from '@/components/artifacts/ArtifactFolderTree';
import { resolveArtifactOpenRoute, type ArtifactBrowserFilter } from '@/components/artifacts/artifactBrowserModel';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { useArtifacts } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * `/settings/prompts/folders` (EC D49, lab `lane12-final/c-art` L): how prompts and skills are filed. It is the
 * Artifacts library's one personal folder tree with the kind fixed to prompts — the same folders, row menus and
 * drag and drop as Artifacts › Folders, never a second folder list.
 */
export const PromptFoldersScreen = React.memo(function PromptFoldersScreen() {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const router = useRouter();
  const artifacts = useArtifacts();
  const folders = useArtifactFolderCommands();
  const folderTree = React.useRef<ArtifactFolderTreeHandle>(null);
  const [query, setQuery] = React.useState('');
  const filter = React.useMemo((): ArtifactBrowserFilter => ({ query, kind: 'prompt', sort: 'title_asc' }), [query]);
  const openArtifact = React.useCallback((artifactId: string) => {
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact) router.push(resolveArtifactOpenRoute(artifact) as never);
  }, [artifacts, router]);

  return (
    <CoreCollectionScope>
      <ItemList>
        <SettingsPageHeader description={t('promptLibrary.surface.foldersPageDescription')} />
        <View style={styles.body}>
          <View style={styles.toolbar}>
            <CompactSearchField
              testID="promptFolders.search"
              value={query}
              onChangeText={setQuery}
              placeholder={t('artifacts.browser.folders.promptSearch')}
              style={styles.search}
            />
            <RoundButton
              testID="promptFolders.add"
              size="small"
              display="secondary"
              title={t('artifacts.browser.folders.newFolder')}
              leading={<Icon name="folder-plus" size={14} color={theme.colors.text.secondary} />}
              disabled={!folders.canWrite}
              onPress={() => folderTree.current?.createFolder(null)}
            />
          </View>
          <ArtifactFolderTree
            ref={folderTree}
            testID="promptFolders"
            accessibilityLabel={t('promptLibrary.folders')}
            filter={filter}
            onOpenArtifact={openArtifact}
          />
        </View>
        <ItemGroup>
          <Item
            testID="promptFolders.allKinds"
            icon={<Icon name="files" />}
            title={t('artifacts.browser.folders.showAllKinds')}
            onPress={() => router.push('/artifacts' as never)}
          />
        </ItemGroup>
      </ItemList>
    </CoreCollectionScope>
  );
});

const stylesheet = StyleSheet.create(() => ({
  body: {
    marginTop: 4,
    marginBottom: 20,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  search: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: 320,
  },
}));
