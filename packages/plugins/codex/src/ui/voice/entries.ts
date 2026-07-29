import {
  createPluginContributionIdentity,
  PluginVoiceProviderContributionV1Schema,
} from '@happier-dev/protocol';
import type {
  BundledVoiceUiEntry,
} from '@happier-dev/bundled-voice-runtime-contract';

import { PLUGIN_MANIFEST } from '../../manifest.js';

const PROVIDER_ID = 'realtime_codex';
const parsedDeclaration = PluginVoiceProviderContributionV1Schema.parse(
  PLUGIN_MANIFEST.contributes.voiceProviders[0],
);
if (
  parsedDeclaration.kind !== 'conversation'
  || parsedDeclaration.execution?.kind !== 'experimental_agent_session_realtime'
) {
  throw new Error('codex_realtime_voice_agent_execution_required');
}
const agentRuntime = Object.freeze(createPluginContributionIdentity(
  typeof parsedDeclaration.execution.agent === 'string'
    ? {
        pluginId: PLUGIN_MANIFEST.id,
        localId: parsedDeclaration.execution.agent,
      }
    : parsedDeclaration.execution.agent,
));
const connectedServicesBinding = parsedDeclaration.settings?.connectedServicesBinding;
const declaration = Object.freeze({
  ...parsedDeclaration,
  execution: Object.freeze({
    ...parsedDeclaration.execution,
    agent: agentRuntime,
  }),
  ...(parsedDeclaration.settings
    ? {
        settings: Object.freeze({
          ...parsedDeclaration.settings,
          ...(connectedServicesBinding
            ? {
                connectedServicesBinding: Object.freeze({
                  ...connectedServicesBinding,
                  agent: Object.freeze(createPluginContributionIdentity(
                    typeof connectedServicesBinding.agent === 'string'
                      ? {
                          pluginId: PLUGIN_MANIFEST.id,
                          localId: connectedServicesBinding.agent,
                        }
                      : connectedServicesBinding.agent,
                  )),
                }),
              }
            : {}),
        }),
      }
    : {}),
});

export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([
  Object.freeze({
    kind: 'voice.conversation-provider.v1',
    pluginId: PLUGIN_MANIFEST.id,
    providerId: PROVIDER_ID,
    declaration,
    settingsSectionId: 'voice.provider.realtime_codex',
    roles: declaration.roles,
    requirements: declaration.capabilities.readiness.requirements,
    supportedPlatforms: declaration.platforms,
    selectionOptions: [{
      id: 'experimental',
      modeId: 'experimental',
      order: 24,
      titleKey: 'settingsVoice.mode.codexRealtime',
      subtitleKey: 'settingsVoice.mode.codexRealtimeSubtitle',
    }],
    internal: Object.freeze({
      resolveSurfaceCapabilities() {
        return Object.freeze({
          allowsGlobalStart: true,
          controlSessionScope: 'global' as const,
          requiresVoiceAgentFeature: false,
          bargeInEnabled: false,
          cancelResponse: 'unsupported' as const,
          interruptionPolicy: 'disabled' as const,
        });
      },
    }),
  }),
]) satisfies readonly BundledVoiceUiEntry[];
