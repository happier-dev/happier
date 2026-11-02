import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

/** Receiver facts for fixtures that support current signed requester dispatch. */
export function machineOperationSupportForTest() {
    return {
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
            externalActionExecutionAuthorization: { protocolVersions: [1] },
            requesterExecutionIsolation: { protocolVersions: [1] },
        }),
    };
}
