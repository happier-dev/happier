import * as React from 'react';

import { PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { storage, useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { updateSkillPromptBundle, readSkillMarkdownFromPromptBundleBody } from '@/sync/ops/promptLibrary/promptBundles';
import { updatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { ensurePromptFolderByName, normalizePromptFolderName, removePromptFolder, renamePromptFolder } from '@/sync/ops/promptLibrary/promptFolders';
import { t } from '@/text';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

function FolderNameEditor(props: Readonly<{ name: string; onSave: (name: string) => void; onCancel: () => void }>) {
  const navigation = useNavigation();
  const [name, setName] = React.useState(props.name);
  useUnsavedDraftNavigationGuard({ navigation, isDirty: name !== props.name, onDiscard: props.onCancel, tag: 'prompt-folder-draft' });
  return <>
    <Item title={t('promptLibrary.folderLabel')} showChevron={false} accessoryLayout="adaptive"
      rightElement={<FieldTextInput testID="promptFolders.draft.name" accessibilityLabel={t('promptLibrary.folderLabel')}
        placeholder={t('promptLibrary.folderPlaceholder')} value={name} onChangeText={setName} autoCapitalize="sentences" autoFocus />} />
    <SectionContentRow><SectionButtonRow>
      <RoundButton testID="promptFolders.draft.save" size="small" title={t('common.save')}
        disabled={!normalizePromptFolderName(name)} onPress={() => props.onSave(name)} />
      <RoundButton testID="promptFolders.draft.cancel" size="small" display="secondary" title={t('common.cancel')} onPress={props.onCancel} />
    </SectionButtonRow></SectionContentRow>
  </>;
}

/**
 * `/settings/prompts/folders`: the folders prompts and skills are filed in, each with how many items
 * it holds. Folders are named in place (add, rename); deleting one leaves its items unfiled.
 */
export const PromptFoldersScreen = React.memo(function PromptFoldersScreen() {
  const artifacts = useArtifacts();
  const [promptFoldersV1, setPromptFoldersV1] = useSettingMutable('promptFoldersV1');
  const [editingFolderId, setEditingFolderId] = React.useState<string | null>(null);
  const scope = useAccountSettingsScope();
  React.useEffect(() => { setEditingFolderId(null); }, [scope?.accountId, scope?.serverId]);

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

  const addFolder = React.useCallback((raw: string) => {
    const next = ensurePromptFolderByName(promptFoldersV1, raw);
    if (!next.folderId || next.promptFoldersV1 === promptFoldersV1) return;
    setPromptFoldersV1(next.promptFoldersV1);
    setEditingFolderId(null);
  }, [promptFoldersV1, setPromptFoldersV1]);

  const renameFolderAction = React.useCallback((folderId: string, currentName: string, raw: string) => {
    const nextName = normalizePromptFolderName(raw);
    if (!nextName) return;
    if (nextName === currentName) { setEditingFolderId(null); return; }
    setPromptFoldersV1(renamePromptFolder(promptFoldersV1, folderId, nextName));
    setEditingFolderId(null);
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
    <ItemList>
      <SettingsPageHeader description={t('promptLibrary.surface.foldersPageDescription')} />
      <ItemGroup
        title={t('promptLibrary.folders')}
        description={t('promptLibrary.surface.foldersSectionDescription')}
        action={(
          <SectionActionButton
            testID="promptFolders.add"
            title={t('promptLibrary.addFolder')}
            icon="plus"
            onPress={() => { void runGuardedNavigation(() => setEditingFolderId('new')); }}
          />
        )}
      >
        {editingFolderId === 'new' ? <ExpandableItem expanded onExpandedChange={(next) => { if (!next) void runGuardedNavigation(() => setEditingFolderId(null)); }}
          header={({ headerProps }) => <Item {...headerProps} title={t('promptLibrary.addFolder')} subtitle={t('promptLibrary.addFolderSubtitle')} />}>
          <FolderNameEditor name="" onSave={addFolder} onCancel={() => setEditingFolderId(null)} />
        </ExpandableItem> : null}
        {folders.length > 0 ? folders.map((folder) => (
          <ExpandableItem key={folder.id} expanded={editingFolderId === folder.id} onExpandedChange={(next) => { void runGuardedNavigation(() => setEditingFolderId(next ? folder.id : null)); }}
            header={() => (
          <Item
            testID={`promptFolders.entry.${folder.id}`}
            title={folder.name}
            subtitle={t('promptLibrary.folderUsageCount', { count: usageCountByFolderId.get(folder.id) ?? 0 })}
            showChevron={false}
            rightElement={(
              <ItemRowActions
                title={folder.name}
                compactActionIds={['rename', 'delete']}
                actions={[
                  {
                    id: 'rename',
                    title: t('promptLibrary.renameFolder'),
                    icon: 'pencil',
                    onPress: () => { void runGuardedNavigation(() => setEditingFolderId(folder.id)); },
                  },
                  {
                    id: 'delete',
                    title: t('common.delete'),
                    icon: 'trash',
                    destructive: true,
                    onPress: () => { void deleteFolderAction(folder.id); },
                  },
                ]}
              />
            )}
          />
            )}>
            {editingFolderId === folder.id ? <FolderNameEditor name={folder.name}
              onSave={(name) => renameFolderAction(folder.id, folder.name, name)} onCancel={() => setEditingFolderId(null)} /> : null}
          </ExpandableItem>
        )) : (
          <Item
            testID="promptFolders.empty"
            title={t('promptLibrary.foldersEmptyTitle')}
            subtitle={t('promptLibrary.foldersEmptySubtitle')}
            mode="info"
            showChevron={false}
          />
        )}
      </ItemGroup>
    </ItemList>
  );
});
