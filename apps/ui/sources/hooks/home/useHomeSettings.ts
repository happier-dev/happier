import * as React from 'react';
import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { HomeSettingsRefreshReason } from '@/sync/engine/home/governance/homeSettingsEngine';

import { useHomeSettingsWithCompanion } from './useHomeSettingsWithCompanion';

export type HomeSettingsRead = Readonly<{
    /** Last settings the Home answered; kept through a later failed read. */
    settings: HomeSettingsProjectionV1 | null;
    loading: boolean;
    /** The failure of the latest read, when it failed. */
    failure: HomeDomainFailure | null;
    reload: (reason?: HomeSettingsRefreshReason) => Promise<void>;
    /** Adopts the projection a settings write answered with. */
    adoptSettings: (settings: HomeSettingsProjectionV1) => void;
}>;

/**
 * `home.settings.get` for one exact Home, for a console page with no companion read (Features,
 * Data): the same owner as `useHomeSettingsWithCompanion`, without the companion.
 */
export function useHomeSettings(scope: ServerAccountScope | null, enabled: boolean): HomeSettingsRead {
    const reads = useHomeSettingsWithCompanion<never>(scope, enabled, null);
    return React.useMemo(() => Object.freeze({
        settings: reads.settings,
        loading: reads.loading,
        failure: reads.failure,
        reload: reads.reload,
        adoptSettings: reads.adoptSettings,
    }), [reads]);
}
