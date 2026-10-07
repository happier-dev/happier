

export type VoiceExternalCredentialApprovalCopy = Readonly<{
  reviewRequired: string;
  recipientApprovalTitle: string;
  recipientApprovalBody: string;
  recipientApprovalPackage: (args: { title: string; pluginId: string; sourceKind: string; sourceLocator: string }) => string;
  recipientApprovalPublisher: (args: { trust: string; identity: string }) => string;
  recipientApprovalPackageSignature: (args: { status: string; keyId: string }) => string;
  recipientApprovalContribution: (args: { pluginId: string; localId: string }) => string;
  recipientApprovalOperations: string;
  recipientApprovalOperation: (args: { id: string; purpose: string; effect: string }) => string;
  recipientApprovalRequest: (args: { method: string; origin: string; pathTemplate: string }) => string;
  recipientApprovalCredential: (args: { headerName: string; format: string }) => string;
  recipientApprovalBounds: (args: { requestMaxBytes: number; responseMaxBytes: number }) => string;
  recipientApprovalTrust: Readonly<{ bundled: string; verified: string }>;
  recipientApprovalEffect: Readonly<{ read: string; mutation: string }>;
  recipientApprovalCredentialFormat: Readonly<{ raw: string; bearer: string }>;
  recipientApprovalConfirm: string;
}>;



export function defineVoiceExternalCredentialApproval(copy: VoiceExternalCredentialApprovalCopy) {
  return copy;
}