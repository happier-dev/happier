import * as React from 'react';
import {
  buildTriageActionEditorLaunchInputV1,
  TRIAGE_APP_PAGE_DESTINATION_V1,
} from '@happier-dev/triage-protocol/v1';

import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';

/**
 * The one way a core failure surface opens the actions editor (Triage's page): on a record, or on the list when no
 * record answered. It goes through the host's destination navigation, so Back returns to the page that opened it.
 * `null` where the host installs no navigation; the caller then draws no open.
 */
export function useOpenTriageActionEditor():
  | ((actionId?: string) => void)
  | null {
  const navigation = usePluginSurfaceDestinationNavigationBinding();
  return React.useMemo(
    () =>
      navigation === null
        ? null
        : (actionId?: string) => {
            void navigation.openSurface({
              destination: TRIAGE_APP_PAGE_DESTINATION_V1,
              input: buildTriageActionEditorLaunchInputV1(actionId),
              subPath: '',
            });
          },
    [navigation],
  );
}
