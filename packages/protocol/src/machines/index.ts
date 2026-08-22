export {
    ContentPublicKeyFingerprintSchema,
    MachineInstallationIdentityV1Schema,
    MachineInstallationProofPayloadV1Schema,
    MachineInstallationProofSignatureSchema,
    MachineInstallationProofV1Schema,
    MachineInstallationPrivateKeySchema,
    MachineInstallationPublicKeySchema,
    buildMachineInstallationProofPayloadBytes,
    computeContentPublicKeyFingerprint,
    signMachineInstallationProof,
    verifyMachineInstallationProof,
    type ContentPublicKeyFingerprint,
    type MachineInstallationIdentityV1,
    type MachineInstallationProofPayloadV1,
    type MachineInstallationProofV1,
} from './identity/installationIdentity.js';

export {
    MachineReplacementFieldsSchema,
    MachineReplacementReasonSchema,
    readMachineReplacementRegistrationIntent,
    type MachineReplacementFields,
    type MachineReplacementReason,
    type MachineReplacementRegistrationIntent,
} from './identity/machineReplacement.js';

export {
    findMachineInCollection,
    isMachineReplaced,
    normalizeMachineIdentityString,
    resolveCanonicalMachineId,
    type CanonicalMachineResolution,
    type MachineCollection,
    type MachineIdentityRecord,
    type MachineReplacementRecord,
} from './identity/canonicalMachineId.js';

export {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    decodePlainMachineStoredContent,
    encodePlainMachineStoredContent,
    isPlainMachineDataKeyMarker,
    machineStoredContentMatchesAccountMode,
    machineUpdateMatchesStoredMode,
} from './machineStoredContent.js';

export {
    arePluginMachineExecutionOriginsEqual,
    PluginMachineExecutionOriginV1Schema,
    PluginMachineExecutionOriginV1JsonSchema,
    type PluginMachineExecutionOriginV1,
} from './administration/pluginMachineExecutionOriginV1.js';
export {
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    MachineOperationProtocolCapabilityV1Schema,
    MachineOperationProtocolCapabilitiesV1Schema,
    MachineOperationProtocolVersionsV1Schema,
    MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
    MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
    supportsMachineOperationProtocolCapabilityV1,
    type MachineOperationProtocolCapabilityNameV1,
    type MachineOperationProtocolCapabilityV1,
    type MachineOperationProtocolCapabilitiesV1,
    type MachineUpdateOperationProtocolCapabilitiesRequestV1,
    type MachineUpdateOperationProtocolCapabilitiesResponseV1,
} from './operationProtocolCapabilitiesV1.js';
