import { createStore } from 'zustand/vanilla';
import type { DeploymentPublishPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { StoreAppCreateFailure } from './useStoreAppListing';

type StoreAppPreparationState = Readonly<{
    machineId: string | null;
    controllerId: string | null;
    environmentName: string;
    domainHostnames: Readonly<Record<string, string>>;
    production: boolean;
    pending: boolean;
    prepared: DeploymentPublishPrepareResultV1 | null;
    creating: boolean;
    refusal: Readonly<{ code: string; step: 'prepare' | 'create'; failure?: StoreAppCreateFailure }> | null;
}>;

/** The open install owns its answers and outcome, including while responsive chrome remounts its content. */
export function createStoreAppPreparationState(machineId: string | null) {
    return createStore<StoreAppPreparationState>(() => ({
        machineId, controllerId: null, environmentName: '', domainHostnames: {}, production: false,
        pending: false, prepared: null, creating: false, refusal: null,
    }));
}

export type StoreAppPreparationStore = ReturnType<typeof createStoreAppPreparationState>;
