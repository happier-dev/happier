import * as React from 'react';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
  useStoreBrowserProfileScope,
  useStoreMachineScope,
} from '@/components/settings/plugins/model/useStoreMachineScope';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { readWebStoreExtensionId } from './catalog/storeBrowserExtensions';
import { presentBrowserExtensionInstallForm } from './submitBrowserExtensionMutation';

/**
 * Browser extensions' search, when its text is a Chrome Web Store link or ID: one result that installs that
 * extension through the same form as a listing. The curated catalog stays what the page lists; this covers the rest.
 */
export function StoreBrowserExtensionLinkResult(
  props: Readonly<{ query: string }>,
): React.ReactNode {
  const extensionId = readWebStoreExtensionId(props.query);
  return extensionId ? <LinkResult extensionId={extensionId} /> : null;
}

function LinkResult(
  props: Readonly<{ extensionId: string }>,
): React.ReactElement {
  const { extensionId } = props;
  const execution = useMountedActionExecution(useAccountSettingsScope());
  const { binding, execute, getSignal } = execution;
  const seedMachineId = useStoreMachineScope()?.machineId ?? null;
  const seedProfileId = useStoreBrowserProfileScope();
  const title = t('capabilities.store.browserExtensionProfile.linkTitle');
  const open = React.useCallback(
    () =>
      presentBrowserExtensionInstallForm({
        title,
        // Before install only the id is known; the permission review names the extension, so no raw id is shown here.
        description: null,
        source: { kind: 'webStore', extensionId },
        execution: { binding, execute, getSignal },
        seedMachineId,
        seedProfileId,
      }),
    [
      binding,
      execute,
      extensionId,
      getSignal,
      seedMachineId,
      seedProfileId,
      title,
    ],
  );
  return (
    <ItemGroup testID="store.browserExtension.link">
      {/* It opens the add flow, so it is the add row: a plus, no chevron. */}
      <ItemAddRow
        testID="store.browserExtension.link.add"
        title={title}
        disabled={!execution.ready}
        onPress={open}
      />
    </ItemGroup>
  );
}
