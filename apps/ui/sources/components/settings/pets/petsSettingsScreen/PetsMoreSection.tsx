import * as React from 'react';
import { useRouter, type Href } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useCreatePetSession } from '@/components/pets/useCreatePetSession';
import {
  buildPluginsHomeRoute,
  PLUGINS_SURFACE_ICON,
} from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Settings › Pets "More pets" (DECISIONS-R12 §19): where new pets come from, right under the Account library they land
 * in. Two navigation rows: the Store's Pets kind, and the one Create-a-pet entry the Store and the face chooser share.
 */
export function PetsMoreSection(): React.ReactElement {
  const router = useRouter();
  const { theme } = useUnistyles();
  const createPet = useCreatePetSession();
  return (
    <ItemGroup
      title={t('settingsPets.more.title')}
      description={t('settingsPets.more.description')}
    >
      <Item
        testID="settings-pets-more-browse"
        title={t('settingsPets.more.browse')}
        subtitle={t('settingsPets.more.browseSubtitle')}
        icon={
          <Icon
            name={PLUGINS_SURFACE_ICON}
            color={theme.colors.text.secondary}
          />
        }
        onPress={() =>
          router.push(
            buildPluginsHomeRoute('app', { view: 'kind', kind: 'pet' }) as Href,
          )
        }
      />
      <Item
        testID="settings-pets-more-create"
        title={t('settingsPets.more.create')}
        subtitle={t('settingsPets.more.createSubtitle')}
        icon={<Icon name="sparkle" color={theme.colors.text.secondary} />}
        onPress={() =>
          fireAndForget(createPet(), { tag: 'PetsMoreSection.create' })
        }
      />
    </ItemGroup>
  );
}
