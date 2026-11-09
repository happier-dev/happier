import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useArtifacts, useArtifactsLoaded } from '@/sync/domains/state/storage';
import { PROMPT_LIBRARY_ARTIFACT_KINDS } from '@/sync/domains/artifacts/artifactInventory';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { PROMPTS_CONTEXT_ROUTE } from './context/promptsContextNavigation';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * `/settings/prompts`: prompts and templates, then where prompts are used and filed.
 */
export const PromptsSettingsHome = React.memo(() => {
  const router = useRouter();
  const artifacts = useArtifacts('promptLibrary');
  const artifactsLoaded = useArtifactsLoaded(PROMPT_LIBRARY_ARTIFACT_KINDS);
  const invocations = usePromptLibraryCatalogValue('invocations').value;
  const folders = usePromptLibraryCatalogValue('folders').value;
  const coding = usePromptLibraryCatalogValue('coding').value;
  const voice = usePromptLibraryCatalogValue('voice').value;
  const { profiles, hasCompleteData: profilesLoaded } = useHomeAiLaunchProfileCatalog(useAccountSettingsScope());
  const stackCount = coding && voice && profilesLoaded
    ? coding.entries.length + voice.entries.length
      + profiles.reduce((sum, profile) => sum + (profile.promptStack?.length ?? 0), 0)
    : null;

  const counts = React.useMemo(() => {
    let docs = 0;
    for (const artifact of artifacts) {
      if (artifact.header?.kind === 'prompt_doc.v2') docs += 1;
    }
    return { docs };
  }, [artifacts]);
  const count = (value: number | null | undefined) => value == null
    ? undefined : t('promptLibrary.surface.itemCount', { count: value });

  return (
    <ItemList>
      <SettingsPageHeader description={t('promptLibrary.surface.pageDescription')} />

      <ItemGroup title={t('promptLibrary.library')} description={t('promptLibrary.surface.librarySectionDescription')}>
        <Item
          testID="settings-prompts-library-prompts"
          icon={<Icon name="file-text" />}
          title={t('promptLibrary.prompts')}
          subtitle={t('promptLibrary.surface.promptsLinkDescription')}
          detail={count(artifactsLoaded ? counts.docs : null)}
          onPress={() => router.push('/settings/prompts/docs')}
        />
        <Item
          testID="settings-prompts-templates"
          icon={<Icon name="lightning" />}
          title={t('promptLibrary.templates')}
          subtitle={t('promptLibrary.surface.templatesLinkDescription')}
          detail={count(invocations?.entries.length)}
          onPress={() => router.push('/settings/prompts/templates')}
        />
      </ItemGroup>

      <ItemGroup title={t('promptLibrary.surface.useSection')} description={t('promptLibrary.surface.useSectionDescription')}>
        <Item
          testID="settings-prompts-stacks"
          icon={<Icon name="stack-simple" />}
          title={t('contextPages.account.title')}
          subtitle={t('contextPages.account.linkDescription')}
          detail={count(stackCount)}
          onPress={() => router.push(PROMPTS_CONTEXT_ROUTE)}
        />
        <Item
          testID="settings-prompts-folders"
          icon={<Icon name="folder-open" />}
          title={t('promptLibrary.folders')}
          subtitle={t('promptLibrary.surface.foldersLinkDescription')}
          detail={count(folders?.folders.length)}
          onPress={() => router.push('/settings/prompts/folders')}
        />
      </ItemGroup>

    </ItemList>
  );
});

PromptsSettingsHome.displayName = 'PromptsSettingsHome';
