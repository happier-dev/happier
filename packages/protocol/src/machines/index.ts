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
