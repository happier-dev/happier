import {
  createRecipientContractDigestV1,
  normalizeRecipientContractV1,
  type RecipientContractDigestV1,
  type RecipientContractV1,
} from '@happier-dev/protocol';

import { t } from '@/text';

export type RecipientContractApproval = Readonly<{
  contract: RecipientContractV1;
  digest: RecipientContractDigestV1;
  summary: string;
}>;

function localizedTitle(contract: RecipientContractV1): string {
  const title = contract.presentation?.title;
  return typeof title === 'string'
    ? title
    : title?.fallback ?? contract.contribution.localId;
}

/**
 * Formats only the normalized, bounded recipient facts a user must approve.
 * Static templates, parameter mappings and credential values are deliberately
 * excluded from this presentation boundary.
 */
export function createRecipientContractApproval(input: unknown): RecipientContractApproval {
  const contract = normalizeRecipientContractV1(input);
  const lines = [
    t('settingsVoice.externalCredentials.recipientApprovalBody'),
    '',
    t('settingsVoice.externalCredentials.recipientApprovalPackage', {
      title: localizedTitle(contract),
      pluginId: contract.package.pluginId,
      sourceKind: contract.package.source.kind,
      sourceLocator: contract.package.source.locator,
    }),
    t('settingsVoice.externalCredentials.recipientApprovalPublisher', {
      trust: t(`settingsVoice.externalCredentials.recipientApprovalTrust.${contract.publisher.trust}`),
      identity: contract.publisher.identity,
    }),
    t('settingsVoice.externalCredentials.recipientApprovalContribution', {
      pluginId: contract.contribution.pluginId,
      localId: contract.contribution.localId,
    }),
    '',
    t('settingsVoice.externalCredentials.recipientApprovalOperations'),
  ];
  for (const operation of contract.operations) {
    lines.push(
      t('settingsVoice.externalCredentials.recipientApprovalOperation', {
        id: operation.id,
        purpose: operation.purpose,
        effect: t(`settingsVoice.externalCredentials.recipientApprovalEffect.${operation.effect}`),
      }),
      t('settingsVoice.externalCredentials.recipientApprovalRequest', {
        method: operation.request.method,
        origin: operation.request.origin,
        pathTemplate: operation.request.pathTemplate,
      }),
      t('settingsVoice.externalCredentials.recipientApprovalCredential', {
        headerName: operation.request.credential.name,
        format: t(`settingsVoice.externalCredentials.recipientApprovalCredentialFormat.${operation.request.credential.format}`),
      }),
      t('settingsVoice.externalCredentials.recipientApprovalBounds', {
        requestMaxBytes: operation.request.maxBodyBytes,
        responseMaxBytes: operation.response.maxBytes,
      }),
      '',
    );
  }
  return Object.freeze({
    contract,
    digest: createRecipientContractDigestV1(contract),
    summary: lines.join('\n').trimEnd(),
  });
}
