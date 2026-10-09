import { defineMachineProvisionerReconciliationSchemas, defineMachineProvisionerSchemas,
    prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import { ByocLaunchV1Schema, ByocResourceV1Schema, ByocNativeOperationV1Schema, FleetLaunchV1Schema, FleetResourceV1Schema, FleetNativeIdSchema } from './remoteSchemas.js';
import { CuaLocalNameSchema } from './schemas.js';

// Native declaration and role validation share C50's one public schema owner.
// Activated native carriers are qualified against exact resources at invocation.
export const ByocReconciliationSchemas = defineMachineProvisionerReconciliationSchemas({
    launch: ByocLaunchV1Schema, resource: ByocResourceV1Schema, nativeOperation: ByocNativeOperationV1Schema,
});
export const ByocProvisionerSchemas = { ...defineMachineProvisionerSchemas({ launch: ByocLaunchV1Schema, resource: ByocResourceV1Schema }),
    acquireResult: ByocReconciliationSchemas.result };
// A native claim exists before its guest is bound. The same exact claim shape
// serves pending custody and eventual resource identity; no second handle owner.
export const FleetReconciliationSchemas = defineMachineProvisionerReconciliationSchemas({
    launch: FleetLaunchV1Schema, resource: FleetResourceV1Schema, nativeOperation: FleetResourceV1Schema,
});
export const FleetProvisionerSchemas = {
    ...defineMachineProvisionerSchemas({ launch: FleetLaunchV1Schema, resource: FleetResourceV1Schema }),
    acquireResult: FleetReconciliationSchemas.result,
};

export function byocReconciliationOperation(input: unknown) {
    const request = ByocReconciliationSchemas.input.parse(input);
    return 'nativeOperation' in request ? request.nativeOperation : {
        launch: request.correlation.launch,
        sandboxId: `${request.correlation.launch.cloud}:${CuaLocalNameSchema.parse(`happier-${request.correlation.managedId}`)}`,
    };
}
export function fleetReconciliationOperation(input: unknown) {
    const request = FleetReconciliationSchemas.input.parse(input);
    return 'nativeOperation' in request ? request.nativeOperation : {
        namespace: request.correlation.launch.namespace,
        claimId: FleetNativeIdSchema.parse(`happier-${request.correlation.managedId}`),
    };
}

export function prepareCuaByocStoredSchemas() {
    return prepareMachineProvisionerStoredSchemas({ launch: ByocLaunchV1Schema, resource: ByocResourceV1Schema,
        nativeOperation: ByocNativeOperationV1Schema });
}
export function prepareCuaFleetStoredSchemas() {
    return prepareMachineProvisionerStoredSchemas({ launch: FleetLaunchV1Schema, resource: FleetResourceV1Schema,
        nativeOperation: FleetResourceV1Schema });
}
