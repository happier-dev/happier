import * as React from 'react';

import type { ApiTokenSettingsController } from './apiTokenSettingsController';

export function useApiTokenSettingsControllerState(controller: ApiTokenSettingsController) {
    return React.useSyncExternalStore(
        controller.subscribe,
        controller.getState,
        controller.getState,
    );
}
