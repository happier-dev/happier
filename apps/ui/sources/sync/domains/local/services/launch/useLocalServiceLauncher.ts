import * as React from 'react';

import { selectLocalServiceLaunchTargets } from './store';
import type { LocalServiceLauncherState, LocalServiceLaunchTarget } from './types';

export function useLocalServiceLauncher(state: LocalServiceLauncherState): Readonly<{
    refreshStatus: LocalServiceLauncherState['refreshStatus'];
    refreshError: string | null;
    targets: readonly LocalServiceLaunchTarget[];
}> {
    const targets = React.useMemo(() => selectLocalServiceLaunchTargets(state), [state]);
    return {
        refreshStatus: state.refreshStatus,
        refreshError: state.refreshError,
        targets,
    };
}
