import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * `/settings/prompts/stacks`: where prompts and skills are added to an agent's instructions — every
 * coding session, every voice conversation, or sessions started with a given profile.
 */
export const PromptStacksScreen = React.memo(() => {
  const router = useRouter();
  const coding = usePromptLibraryCatalogValue('coding').value;
  const voice = usePromptLibraryCatalogValue('voice').value;
  const { profiles, hasCompleteData: profilesLoaded } = useHomeAiLaunchProfileCatalog(useAccountSettingsScope());

  const profileCount = profiles.filter(profile => (profile.promptStack?.length ?? 0) > 0).length;
  const codingCount = coding?.entries.length;
  const voiceCount = voice?.entries.length;

  return (
    <ItemList>
      <SettingsPageHeader description={t('promptLibrary.surface.stacksPageDescription')} />
      <ItemGroup title={t('promptLibrary.surface.stacksSection')} description={t('promptLibrary.surface.stacksSectionDescription')}>
        <Item
          testID="promptStacks.coding"
          icon={<Icon name="terminal" />}
          title={t('contextPages.account.title')}
          subtitle={t('contextPages.account.linkDescription')}
          detail={codingCount === undefined ? undefined : t('promptLibrary.profileStackCount', { count: codingCount })}
          onPress={() => router.push('/settings/prompts/stacks/coding')}
        />
        <Item
          testID="promptStacks.voice"
          icon={<Icon name="microphone" />}
          title={t('promptLibrary.voiceStack')}
          subtitle={t('promptLibrary.voiceStackSubtitle')}
          detail={voiceCount === undefined ? undefined : t('promptLibrary.profileStackCount', { count: voiceCount })}
          onPress={() => router.push('/settings/prompts/stacks/voice')}
        />
        <Item
          testID="promptStacks.profiles"
          icon={<Icon name="user-circle" />}
          title={t('promptLibrary.profileStacks')}
          subtitle={t('promptLibrary.surface.profileStacksDescription')}
          detail={profilesLoaded ? t('promptLibrary.profileStacksSubtitle', { count: profileCount }) : undefined}
          onPress={() => router.push('/settings/prompts/stacks/profiles')}
        />
      </ItemGroup>
    </ItemList>
  );
});

PromptStacksScreen.displayName = 'PromptStacksScreen';
