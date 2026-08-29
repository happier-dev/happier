import {
  createVoiceProviderRecipientContractFromCredentialsV1,
  type RecipientContractV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';

/**
 * Canonical trusted build-time identity for first-party Voice recipients.
 * Installed-generation currentness remains a separate invocation fence.
 */
export function createBundledVoiceRecipientContract(input: Readonly<{
  pluginId: string;
  declaration: VoiceProviderContribution;
}>): RecipientContractV1 | null {
  const credentials = input.declaration.credentials;
  if (!credentials?.hostMediated) return null;
  return createVoiceProviderRecipientContractFromCredentialsV1({
    package: {
      pluginId: input.pluginId,
      source: { kind: 'bundled', locator: input.pluginId },
    },
    publisher: {
      trust: 'bundled',
      identity: 'happier.dev:first-party-bundle',
    },
    contribution: {
      pluginId: input.pluginId,
      localId: input.declaration.id,
    },
    credentials: {
      slot: credentials.slot,
      hostMediated: credentials.hostMediated,
    },
    presentation: { title: input.declaration.title },
  });
}
