import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

/** `/settings/prompts/stacks/profiles`: each profile with how many prompts and skills it adds. */
export const PromptProfileStacksScreen = React.memo(() => {
  const router = useRouter();
  const profiles = useAiLaunchProfilesForLegacyUi();

  return (
    <ItemList>
      <SettingsPageHeader description={t('promptLibrary.surface.profileStacksPageDescription')} />
      <ItemGroup title={t('promptLibrary.surface.profilesSection')}>
        {profiles.map((profile) => {
          const profileId = profile.id;
          const count = (profile.promptStack ?? []).length;
          return (
            <Item
              key={profileId}
              testID={`promptStacks.profile.${profileId}`}
              icon={<Icon name="user-circle" />}
              title={profile.name || profileId}
              detail={t('promptLibrary.profileStackCount', { count })}
              onPress={() => router.push(`/settings/prompts/stacks/profiles/${encodeURIComponent(profileId)}`)}
            />
          );
        })}

        {profiles.length === 0 ? (
          <Item
            testID="promptStacks.profiles.empty"
            title={t('promptLibrary.noProfilesTitle')}
            subtitle={t('promptLibrary.noProfilesSubtitle')}
            mode="info"
            showChevron={false}
          />
        ) : null}
      </ItemGroup>
    </ItemList>
  );
});

PromptProfileStacksScreen.displayName = 'PromptProfileStacksScreen';
