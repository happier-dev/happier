import type { PluginContributionClientPlatform } from '@happier-dev/protocol';

import {
  createPluginUiClientExecutableRegistrationIndex,
} from '@/components/plugins/reactNative/clientExecutableContributions';

import {
  createExternalVoiceProviderActivationScope as createProductionExternalVoiceProviderActivationScope,
  type ExternalVoiceProviderActivationScope,
  type VoiceConversationProviderContribution,
} from './externalVoiceProviderActivation';

type ProductionInput = Parameters<typeof createProductionExternalVoiceProviderActivationScope>[0];
type TestInput = Omit<ProductionInput, 'registrationScope'>;

function testClientPlatform(
  declaration: VoiceConversationProviderContribution,
): PluginContributionClientPlatform {
  return declaration.platforms.find((platform): platform is PluginContributionClientPlatform => (
    platform === 'web' || platform === 'ios' || platform === 'android'
  )) ?? 'web';
}

/**
 * Direct Voice-owner tests still execute through the real generic client
 * registration transaction. Production activation receives this scope from
 * the executable composition rather than constructing it itself.
 */
export function createExternalVoiceProviderActivationScope(
  input: TestInput,
): ExternalVoiceProviderActivationScope {
  const declaration = input.declarations[0];
  if (!declaration) {
    throw new Error('external_voice_provider_declaration_required');
  }
  const controller = new AbortController();
  const registrationScope = createPluginUiClientExecutableRegistrationIndex().createScope({
    pluginId: input.pluginId,
    contributes: Object.freeze({ voiceProviders: input.declarations }),
    target: Object.freeze({
      artifactId: declaration.client.artifactId,
      modulePath: declaration.client.modulePath,
      exportName: declaration.client.exportName,
      platform: testClientPlatform(declaration),
    }),
    executionOrigin: Object.freeze({
      serverIdentityId: 'srv_test',
      materializationRef: Object.freeze({
        machineId: 'machine-test',
        materializationId: 'materialization-test',
        pluginId: input.pluginId,
      }),
    }),
    projectionGeneration: 1,
    lifecycle: Object.freeze({
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    }),
  });
  const scope = createProductionExternalVoiceProviderActivationScope({
    ...input,
    registrationScope,
  });
  let committed = false;
  let unwound = false;
  return Object.freeze({
    ...scope,
    isCurrent: () => (
      !unwound
      && registrationScope.isCurrent()
      && (!committed || (scope.isCurrent?.() ?? true))
    ),
    async commit() {
      await scope.commit();
      committed = true;
    },
    async unwind() {
      unwound = true;
      await registrationScope.unwind();
      await scope.unwind();
    },
  });
}
