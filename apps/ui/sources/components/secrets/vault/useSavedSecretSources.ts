import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import {
    installedSecretSourceDeclarations,
    listSavedSecretSources,
    type SavedSecretSourceOption,
} from '@/sync/api/account/savedSecretCatalogPresentation';

/** Secret sources installed on this Account's Machines, from admitted declarations only. */
export function useSavedSecretSources(scope: ServerAccountScope | null, enabled: boolean): readonly SavedSecretSourceOption[] {
    const reader = usePluginAccountAvailabilityReader(enabled ? scope : null);
    return React.useMemo(() => reader ? listSavedSecretSources(installedSecretSourceDeclarations(reader.readInstalledPlugins())) : [],
        [reader]);
}
