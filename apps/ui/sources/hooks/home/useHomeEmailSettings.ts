import * as React from 'react';
import type {
    HomeMailDeliveryReadinessV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getHomeMailDelivery } from '@/sync/ops/home/homeGovernanceOperations';

import { useHomeSettingsWithCompanion } from './useHomeSettingsWithCompanion';

export type HomeEmailSettings = Readonly<{
    /** Last settings the Home answered; kept through a later failed read. */
    settings: HomeSettingsProjectionV1 | null;
    /** Last mail readiness the Home answered; `null` until it answers. */
    readiness: HomeMailDeliveryReadinessV1 | null;
    loading: boolean;
    /** The failure of the latest settings read, when it failed. */
    failure: HomeDomainFailure | null;
    readinessLoading: boolean;
    readinessFailure: HomeDomainFailure | null;
    reload: () => void;
    /** Adopts the projection a settings write answered with and re-reads readiness. */
    adoptSettings: (settings: HomeSettingsProjectionV1) => void;
}>;

const readReadiness = (scope: ServerAccountScope) => getHomeMailDelivery({ scope });

/**
 * The Email page's two reads of one exact Home: the effective settings (values and sources) and
 * whether mail can be sent. Readiness belongs to the mail owner on the server, so it is always
 * re-read after a write rather than derived here from the settings.
 */
export function useHomeEmailSettings(scope: ServerAccountScope | null, enabled: boolean): HomeEmailSettings {
    const reads = useHomeSettingsWithCompanion(scope, enabled, readReadiness);
    return React.useMemo(() => Object.freeze({
        settings: reads.settings,
        readiness: reads.companion,
        loading: reads.loading,
        failure: reads.failure,
        readinessLoading: reads.companionLoading,
        readinessFailure: reads.companionFailure,
        reload: reads.reload,
        adoptSettings: reads.adoptSettings,
    }), [reads]);
}
