import * as React from 'react';

import { BrowserProfileExtensionsSection } from '@/components/browser/profile/BrowserProfileExtensionsSection';
import {
  useStoreBrowserProfileScope,
  useStoreMachineScope,
} from '@/components/settings/plugins/model/useStoreMachineScope';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

/**
 * One saved browser profile inside Store, reached from an Installed extension row: which profile, on which Machine,
 * then its Extensions. The profile page mounts the same section once browser profiles have their own page.
 */
export const StoreBrowserProfileScreen = React.memo(
  function StoreBrowserProfileScreen() {
    const machine = useStoreMachineScope();
    const profileId = useStoreBrowserProfileScope();
    const scope = useAccountSettingsScope();
    const machineLabel = useServerScopedMachineLabel(
      machine?.serverId,
      machine?.machineId,
    );
    return (
      <ItemList
        pageColumn="wide"
        keyboardShouldPersistTaps="handled"
        testID="store.browserProfile"
      >
        <PageContentColumn>
          <PageHeader
            testID="store.browserProfile.header"
            title={
              profileId ?? t('capabilities.store.kinds.browserExtension.title')
            }
            alwaysShowTitle
            description={
              machineLabel
                ? t('capabilities.store.browserExtensionProfile.onMachine', {
                    machine: machineLabel,
                  })
                : undefined
            }
          />
          {machine && profileId ? (
            <BrowserProfileExtensionsSection
              scope={scope}
              serverId={machine.serverId}
              machineId={machine.machineId}
              profileId={profileId}
              testID="store.browserProfile.extensions"
            />
          ) : null}
        </PageContentColumn>
      </ItemList>
    );
  },
);
