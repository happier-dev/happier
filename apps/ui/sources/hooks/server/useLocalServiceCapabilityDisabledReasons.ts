import * as React from 'react';

import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

export type LocalServiceCapabilityDisabledReasons = Readonly<{
    /** `capabilities.localServices.preview.disabledReasons` */
    preview: readonly string[];
    /** `capabilities.localServices.publicPreview.disabledReasons` */
    publicPreview: readonly string[];
}>;

const NO_REASONS: LocalServiceCapabilityDisabledReasons = {
    preview: [],
    publicPreview: [],
};

/**
 * The server's own explanation of which local-service preview prerequisite is unmet.
 *
 * `apps/server/sources/app/features/localServicesFeature.ts` computes one code per failed
 * prerequisite; without this reader the client can only say "previews are disabled", and an operator
 * cannot tell which of eleven environment variables is wrong.
 *
 * While server features are loading or unreachable the reasons are empty, so callers keep whatever
 * generic copy they already show rather than claiming a prerequisite that has not been reported.
 */
export function useLocalServiceCapabilityDisabledReasons(): LocalServiceCapabilityDisabledReasons {
    const snapshot = useServerFeaturesRuntimeSnapshot();
    return React.useMemo(() => {
        if (snapshot.status !== 'ready') return NO_REASONS;
        const localServices = snapshot.features.capabilities.localServices;
        return {
            preview: localServices.preview.disabledReasons,
            publicPreview: localServices.publicPreview.disabledReasons,
        };
    }, [snapshot]);
}
