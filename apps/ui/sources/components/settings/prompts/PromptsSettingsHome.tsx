import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SettingRow } from '@/components/settings/shell/SettingRow';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useArtifacts, useArtifactsLoaded } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { PROMPTS_CONTEXT_ROUTE } from './context/promptsContextSettings';
import { PROMPTS_SETTINGS } from './promptsSettings';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * `/settings/prompts`: the prompt library (prompts, skills, templates) with a count on each, then
 * where library items are used, then the ways to bring them in from machines and registries.
 */
export const PromptsSettingsHome = React.memo(() => {
  const router = useRouter();
  const promptAssetsExternalEnabled = useFeatureEnabled('prompts.assets.external');
  const promptRegistriesEnabled = useFeatureEnabled('prompts.skills.registries');
  const artifacts = useArtifacts();
  const artifactsLoaded = useArtifactsLoaded();
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
    let skills = 0;
    for (const artifact of artifacts) {
      if (artifact.header?.kind === 'prompt_doc.v2') docs += 1;
      else if (artifact.header?.kind === 'prompt_bundle.v2') skills += 1;
    }
    return { docs, skills };
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
        <SettingRow
          testID="settings-prompts-library-skills"
          icon={<Icon name="sparkle" />}
          setting={PROMPTS_SETTINGS.settings.skills}
          detail={count(artifactsLoaded ? counts.skills : null)}
          onPress={() => router.push('/settings/prompts/skills')}
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

      {promptAssetsExternalEnabled || promptRegistriesEnabled ? (
        <ItemGroup title={t('promptLibrary.surface.importSection')} description={t('promptLibrary.surface.importSectionDescription')}>
          {promptAssetsExternalEnabled ? (
            <Item
              testID="settings-prompts-assets"
              icon={<Icon name="download" />}
              title={t('promptLibrary.externalAssets')}
              subtitle={t('promptLibrary.surface.externalAssetsLinkDescription')}
              onPress={() => router.push('/settings/prompts/assets')}
            />
          ) : null}
          {promptRegistriesEnabled ? (
            <Item
              testID="settings-prompts-registries"
              icon={<Icon name="graph" />}
              title={t('promptLibrary.registries')}
              subtitle={t('promptLibrary.surface.registriesLinkDescription')}
              onPress={() => router.push('/settings/prompts/registries')}
            />
          ) : null}
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

PromptsSettingsHome.displayName = 'PromptsSettingsHome';
