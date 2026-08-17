import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

/** One manifest-facing Action schema declaration projected by the V1 owner. */
export type ConversationActionDeclarationV1 = Readonly<{
    inputSchema: PluginJsonSchema;
    resultSchema?: PluginJsonSchema;
}>;

/** The finite provider-facing core Action declaration map for Channels V1. */
export type ConversationCoreProviderActionDeclarationsV1 = Readonly<{
    observationIngest: ConversationActionDeclarationV1;
    connectionsList: ConversationActionDeclarationV1;
    connectionRead: ConversationActionDeclarationV1;
    transportFactReport: ConversationActionDeclarationV1;
    automationResultDeliver: ConversationActionDeclarationV1;
}>;

/** The finite present-user/core management Action declaration map for Channels V1. */
export type ConversationManagementActionDeclarationsV1 = Readonly<{
    connectionCreate: ConversationActionDeclarationV1;
    connectionTransfer: ConversationActionDeclarationV1;
    connectionPrepare: ConversationActionDeclarationV1;
    connectionUpdate: ConversationActionDeclarationV1;
    connectionSetEnabled: ConversationActionDeclarationV1;
    connectionDelete: ConversationActionDeclarationV1;
    connectionAbandon: ConversationActionDeclarationV1;
    streamBaselineAccept: ConversationActionDeclarationV1;
    connectionPairingCreate: ConversationActionDeclarationV1;
    connectionPairingFinalize: ConversationActionDeclarationV1;
    connectionPairingCancel: ConversationActionDeclarationV1;
    bindingRead: ConversationActionDeclarationV1;
    bindingResolve: ConversationActionDeclarationV1;
    bindingCreate: ConversationActionDeclarationV1;
    bindingUpdate: ConversationActionDeclarationV1;
    bindingSetEnabled: ConversationActionDeclarationV1;
    bindingDelete: ConversationActionDeclarationV1;
    bindingTargetRotate: ConversationActionDeclarationV1;
    ingressRetry: ConversationActionDeclarationV1;
    deliveryResolve: ConversationActionDeclarationV1;
    connectionPollRetry: ConversationActionDeclarationV1;
}>;
