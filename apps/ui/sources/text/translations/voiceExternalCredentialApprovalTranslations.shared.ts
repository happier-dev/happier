

export type VoiceExternalCredentialApprovalCopy = Readonly<{
  reviewRequired: string;
  recipientApprovalTitle: string;
  recipientApprovalPackage: (args: { title: string; pluginId: string; sourceKind: string; sourceLocator: string }) => string;
  recipientApprovalPublisher: (args: { trust: string; identity: string }) => string;
  recipientApprovalContribution: (args: { pluginId: string; localId: string }) => string;
  recipientApprovalConfirm: string;
}>;



export function defineVoiceExternalCredentialApproval(copy: VoiceExternalCredentialApprovalCopy) {
  return copy;
}