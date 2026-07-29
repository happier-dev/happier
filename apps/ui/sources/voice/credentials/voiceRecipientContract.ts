import {
  createVoiceProviderRecipientContractV1,
  type PluginVoiceProviderContributionV1,
  type RecipientContractV1,
} from '@happier-dev/protocol';

type ConversationDeclaration = Extract<
  PluginVoiceProviderContributionV1,
  Readonly<{ kind: 'conversation' }>
>;

/**
 * Canonical trusted build-time identity for first-party Voice recipients.
 * Installed-generation currentness remains a separate invocation fence.
 */
export function createBundledVoiceRecipientContract(input: Readonly<{
  pluginId: string;
  declaration: ConversationDeclaration;
}>): RecipientContractV1 | null {
  const mediation = input.declaration.accountMediation;
  if (!mediation) return null;
  return createVoiceProviderRecipientContractV1({
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
    accountMediation: mediation,
    presentation: { title: input.declaration.title },
  });
}
