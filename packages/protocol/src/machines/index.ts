export {
    ContentPublicKeyFingerprintSchema,
    MachineInstallationIdentityV1Schema,
    MachineInstallationProofPayloadV1Schema,
    MachineInstallationProofSignatureSchema,
    MachineInstallationProofV1Schema,
    MachineInstallationPrivateKeySchema,
    MachineInstallationPublicKeySchema,
    MachineInstallationPublicIdentityV1Schema,
    buildMachineInstallationProofPayloadBytes,
    computeContentPublicKeyFingerprint,
    signMachineInstallationProof,
    verifyMachineInstallationProof,
    type ContentPublicKeyFingerprint,
    type MachineInstallationIdentityV1,
    type MachineInstallationPublicIdentityV1,
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
    MachineStoredMetadataPolicyFieldsV1Schema,
    decodePlainMachineStoredContent,
    encodePlainMachineStoredContent,
    isPlainMachineDataKeyMarker,
    machineStoredContentMatchesAccountMode,
    machineUpdateMatchesStoredMode,
    resolvePublishedMachineDataEncryptionKeyV1,
    type ExpectedRunnerMachineContentKeyBindingV1,
    type PublishedMachineDataEncryptionKeyResolutionV1,
    type PublishedMachineDataEncryptionKeyV1,
} from './machineStoredContent.js';

export * from './machineFinitePolicyV1.js';
export * from './machineContentKeyTransitionV1.js';

export {
    arePluginMachineMaterializationRefsEqual,
    arePluginMachineExecutionOriginsEqual,
  PluginMachineExecutionOriginV1Schema,
  PluginMachineMaterializationExecutionOriginV1Schema,
  type PluginMachineMaterializationExecutionOriginV1,
  getPluginMachineExecutionOriginRef,
    PluginMachineExecutionOriginV1JsonSchema,
    type PluginMachineExecutionOriginV1,
} from './administration/pluginMachineExecutionOriginV1.js';
export {
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    MachineOperationProtocolCapabilityV1Schema,
    MachineOperationProtocolCapabilitiesV1Schema,
    MachineOperationProtocolCapabilitiesV1StoredReadSchema,
    MachineOperationProtocolVersionsV1Schema,
    MachineIrohEndpointCapabilityV1Schema,
    MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
    MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
  supportsMachineOperationProtocolCapabilityV1,
  supportsMachineSessionSpawnProtocolVersionV1,
    supportsMachineSessionFollowContextV1,
    supportsMachineSessionFollowWakeOnHumanChangeV1,
    supportsMachineSessionInputAdmissionProtocolVersion,
    readMachineIrohEndpointAuthorityV1,
    type MachineIrohEndpointAuthorityV1,
    type MachineOperationProtocolCapabilityNameV1,
    type MachineOperationProtocolCapabilityV1,
    type MachineOperationProtocolCapabilitiesV1,
    type MachineUpdateOperationProtocolCapabilitiesRequestV1,
    type MachineUpdateOperationProtocolCapabilitiesResponseV1,
} from './operationProtocolCapabilitiesV1.js';
export {
    MachineDestinationPurposeV1Schema,
    MachinePoolPlacementPurposeV1Schema,
    type MachineDestinationPurposeV1,
    type MachinePoolPlacementPurposeV1,
    MachinePoolIdV1Schema,
    MachinePoolSelectionOriginV1Schema,
    MachinePoolNameV1Schema,
    MachinePoolDescriptionV1Schema,
    MachinePoolPriorityTierV1Schema,
    MachinePoolMemberInputV1Schema,
    MachinePoolMemberStateV1Schema,
    MachinePoolMemberV1Schema,
    MachinePoolSummaryV1Schema,
    MachinePoolAvailabilityV1Schema,
    MachinePoolViewV1Schema,
    MachinePoolResolveResultV1Schema,
    MachinePoolErrorV1Schema,
    MachinePoolListInputV1Schema,
    MachinePoolListOutputV1Schema,
    MachinePoolGetInputV1Schema,
    MachinePoolCreateInputV1Schema,
    MachinePoolUpdateInputV1Schema,
    MachinePoolDeleteInputV1Schema,
    MachinePoolDeleteOutputV1Schema,
    MachinePoolResolveInputV1Schema,
    type MachinePoolIdV1,
    type MachinePoolSelectionOriginV1,
    type MachinePoolMemberInputV1,
    type MachinePoolMemberStateV1,
    type MachinePoolMemberV1,
    type MachinePoolSummaryV1,
    type MachinePoolAvailabilityV1,
    type MachinePoolViewV1,
    type MachinePoolResolveResultV1,
    type MachinePoolErrorV1,
    type MachinePoolListInputV1,
    type MachinePoolListOutputV1,
    type MachinePoolGetInputV1,
    type MachinePoolCreateInputV1,
    type MachinePoolUpdateInputV1,
    type MachinePoolDeleteInputV1,
    type MachinePoolDeleteOutputV1,
    type MachinePoolResolveInputV1,
} from './pools/v1.js';
export {
    MACHINE_POOL_ACTION_IDS_V1,
    MachinePoolActionIdV1Schema,
    MachinePoolActionInputSchemasV1,
    MachinePoolActionOutputSchemasV1,
    machinePoolActionEndpointPathV1,
    type MachinePoolActionIdV1,
    type MachinePoolActionInputV1,
    type MachinePoolActionOutputV1,
} from './pools/actionsV1.js';
export {
    MachineKindSchema,
    MachineKindFromLegacyProjectionSchema,
    isPersistentMachine,
    type MachineKind,
} from './machineKind.js';
export {
    CliInstallSourceSchema,
    CliUpdateFactsSchema,
    CliUpdateLastResultSchema,
    CliUpdateOutcomeSchema,
    type CliInstallSource,
    type CliUpdateFacts,
    type CliUpdateLastResult,
    type CliUpdateOutcome,
} from './cliUpdateFacts.js';
export * from './machineAccessV1.js';
export { MachineWorkSummaryV1Schema, type MachineWorkSummaryV1 } from './machineWorkSummaryV1.js';
export { computeMachineOwnerEnvelopeFingerprintV1 } from './machineOwnerEnvelopeFingerprintV1.js';
export * from './managed/providerFactsV1.js';
export * from './managed/devcontainerV1.js';
export * from './managed/managedMachineV1.js';
export * from './managed/actionsV1.js';
export * from './managed/managedMachinePresetV1.js';
export * from './managed/machinePresetActionsV1.js';
export * from './managed/managedConfigurationV1.js';
