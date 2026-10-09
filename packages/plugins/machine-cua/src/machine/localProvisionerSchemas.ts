import { defineMachineProvisionerReconciliationSchemas, defineMachineProvisionerSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { CuaLocalLaunchV1Schema, CuaLocalResourceV1Schema, CuaLocalNameSchema, type CuaLocalLaunchV1 } from './schemas.js';

// The portable native declaration and every role share C50's public owner.
// Native unit/exact-Space qualification remains at the local operation boundary.
export const CuaLocalNativeOperationV1Schema = defineProtocolObject({ resource: CuaLocalResourceV1Schema,
    imageId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
export const CuaLocalReconciliationSchemas = defineMachineProvisionerReconciliationSchemas({
    launch: CuaLocalLaunchV1Schema, resource: CuaLocalResourceV1Schema, nativeOperation: CuaLocalNativeOperationV1Schema,
});
export const CuaLocalProvisionerSchemas = { ...defineMachineProvisionerSchemas({
    launch: CuaLocalLaunchV1Schema, resource: CuaLocalResourceV1Schema,
}), acquireResult: CuaLocalReconciliationSchemas.result };

export function localAcquireOperation(id: 'local-sandbox' | 'local-space', launch: CuaLocalLaunchV1, managedId: string) {
    const sandboxId = `local:${CuaLocalNameSchema.parse(`happier-${managedId}`)}`;
    return CuaLocalNativeOperationV1Schema.parse({ resource: id === 'local-space'
        ? { kind: 'space', runtimeId: launch.runtimeId, sandboxId, spaceId: sandboxId }
        : { kind: 'sandbox', namespace: 'local', runtimeId: launch.runtimeId, sandboxId }, imageId: launch.imageId });
}
export function localReconciliationOperation(id: 'local-sandbox' | 'local-space', input: ReturnType<typeof CuaLocalReconciliationSchemas.input.parse>) {
    return 'nativeOperation' in input ? input.nativeOperation : localAcquireOperation(id, input.correlation.launch, input.correlation.managedId);
}

export function prepareCuaLocalStoredSchemas() {
    return prepareMachineProvisionerStoredSchemas({ launch: CuaLocalLaunchV1Schema, resource: CuaLocalResourceV1Schema,
        nativeOperation: CuaLocalNativeOperationV1Schema });
}
