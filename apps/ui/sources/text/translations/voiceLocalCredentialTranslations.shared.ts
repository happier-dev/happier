

export type VoiceLocalCredentialCopy = Readonly<{
  voiceCredential: Readonly<{
    setOnAccount: string;
    notSetOnAccount: string;
    setOnMachineOverride: (args: { machine: string }) => string;
    notSetWithFallback: (args: { machine: string }) => string;
    plainStorageTitle: string;
    plainStorageBody: string;
    plainStorageConfirm: string;
    deleteAccountBody: string;
    machineUnavailable: string;
    machineUnavailableTitle: string;
    machineUnavailableBody: string;
    statusUnavailable: (args: { machine: string }) => string;
    importAvailable: (args: { machine: string }) => string;
    notSetOnMachine: (args: { machine: string }) => string;
    setOnMachine: (args: { machine: string; protection: string }) => string;
    protection: Readonly<{ osProtected: string; filePermissions: string }>;
    importTitle: string;
    importBody: (args: { machine: string }) => string;
    importAction: string;
    enterNewAction: string;
    useSavedSecretTitle: string;
    useSavedSecretSubtitle: string;
    replaceOrRemoveBody: string;
    deleteTitle: string;
    deleteBody: (args: { machine: string }) => string;
    operationFailed: string;
    newCredentialRequired: (args: { machine: string }) => string;
  }>;
  openAiCompatEndpoint: Readonly<{
    executionMachine: (args: { machine: string }) => string;
    insecureTitle: string;
    insecureBody: (args: { origin: string; machine: string }) => string;
    allowAction: string;
    invalidBody: string;
  }>;
}>;



export function defineVoiceLocalCredential(copy: VoiceLocalCredentialCopy) {
  return copy;
}