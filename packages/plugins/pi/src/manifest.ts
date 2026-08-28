import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import {
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
} from './agent/auth/services/requestAuth/purposes.js';
import {
  PI_ANTHROPIC_API_KEY_PURPOSE_ID,
  PI_OPENAI_API_KEY_PURPOSE_ID,
  PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES,
} from './agent/auth/services/qualifiedPurposes.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { PI_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/models.js';
import { piConnectedServiceStateSharingDescriptor } from './agent/connectedServices/stateSharingDescriptor.js';
import { createPiConnectedServiceRuntimeAuthAdapter } from './agent/connectedServices/runtimeAuthAdapter.js';
import { verifyResumeReachablePi } from './agent/connectedServices/reachability.js';
import { PI_REQUEST_AUTH_USES } from './agent/auth/services/requestAuth/purposes.js';
import { piExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { piExternalSessionObservationContribution } from './agent/externalSessions/observation.js';
import { piExternalSessionTakeoverContribution } from './agent/externalSessions/takeover.js';
import {
  PI_DIRECT_AUTH_ENV_KEYS,
  PI_LAUNCH_ENV_KEYS,
  resolvePiSessionRuntimePreferences,
} from './agent/launchEnvironment.js';
import { createPiAgentRuntime } from './agent/runtime/engine.js';
import { PI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PI_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

export {
  PI_ANTHROPIC_API_KEY_PURPOSE_ID,
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_API_KEY_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
};

const {
  id: PI_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...PI_AGENT_SETTINGS_DECLARATION
} = PI_AGENT_SETTINGS_CONTRIBUTION;

export const PI_PLUGIN = definePlugin({
  id: 'happier.agent.pi',
  version: '0.0.0',
  displayName: 'Pi',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'pi-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the Pi process working directory.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'pi-process',
      capability: 'process',
      reason: 'Launch the Pi coding-agent CLI through the host execution service.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'pi-cli' }],
        envKeys: [...PI_LAUNCH_ENV_KEYS],
      },
    }],
    optional: [],
  },
  agents: {
    pi: {
      declaration: {
        title: 'Pi',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'Pi Coding Agent CLI',
          executable: {
            binaryName: 'pi',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@earendil-works/pi-coding-agent',
              binaryName: 'pi',
            },
            manual: { kind: 'command' },
            guideUrl: 'https://github.com/badlogic/pi-mono',
            docsUrl: null,
          },
          auth: {
            support: 'status_only',
            environmentVariables: [...PI_DIRECT_AUTH_ENV_KEYS],
            loginLaunches: [],
          },
        },
        primary: 'sessions',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
          agentCliSystemTool: { toolId: 'pi-cli' },
        },
        connectedAccounts: PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.map((declaration) => ({
          ...declaration,
          service: { ...declaration.service },
          materializationKinds: [...declaration.materializationKinds],
        })),
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            startupInstructions: { versions: [1] },
            cancel: true,
            configuration: true,
            compaction: { events: true, manual: true },
          },
          executionRuns: { open: ['create'], checkpoint: false, stop: true },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'piAgentDir',
              schema: {
                fields: [
                  { kind: 'literal', name: 'kind', value: 'piAgentDir' },
                  { kind: 'string', name: 'agentDir', min: 1, max: 10_000, nullish: true },
                  // Resolved carrier, not a logical source identity: `resolveLinkIdentity`
                  // pins the exact session file it verified inside the agent directory and
                  // every later read path (`pageTranscript`, `readAfterTranscript`,
                  // observation, takeover) reads it back off the source the host persisted
                  // and revalidates. It is deliberately absent from `key.segments`, so two
                  // sources differing only by session file keep one source identity.
                  { kind: 'string', name: 'sessionFile', min: 1, max: 10_000, nullish: true },
                ],
              },
              key: {
                segments: [
                  { kind: 'literal', value: 'piAgentDir' },
                  { kind: 'field', field: 'agentDir' },
                ],
              },
              instances: [{ kind: 'default', constants: {} }, {
                kind: 'agentSettingOverride',
                settingId: 'piAgentDir',
                field: 'agentDir',
                normalization: 'configuredPath',
                constants: {},
              }],
            }],
          },
        },
      },
      factory: createPiAgentRuntime,
      connectedAccountLaunch: {
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: ['connected_to_connected'],
          providerStateSharingRequired: {
            supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
          },
        },
        requestAuthUses: PI_REQUEST_AUTH_USES,
        stateSharingDescriptor: {
          providerSupportStatus: piConnectedServiceStateSharingDescriptor.providerSupportStatus,
          config: piConnectedServiceStateSharingDescriptor.config,
          state: piConnectedServiceStateSharingDescriptor.state,
          authIsolation: piConnectedServiceStateSharingDescriptor.authIsolation,
          nativeHome: {
            environmentKey: 'PI_CODING_AGENT_DIR',
            defaultRelativePath: '.pi/agent',
          },
        },
        continuity: {
          runtimeAuthAdapter: createPiConnectedServiceRuntimeAuthAdapter(),
          verifyResumeReachable: verifyResumeReachablePi,
        },
      },
      preflightSessionControls: PI_PREFLIGHT_SESSION_CONTROLS,
      cliSessionCommand: {
        sessionRuntimeId: 'pi',
        accountSettingsAgentId: 'pi',
        buildSessionOptions: (input) => ({
          ok: true,
          options: resolvePiSessionRuntimePreferences({
            settings: input.settings,
            environment: input.environment,
          }),
        }),
      },
      sessionRunnerFactory: {
        module: './agent/runtime/engine',
        export: 'createPiAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'piExternalSessionsContribution',
      },
      externalSessions: piExternalSessionsContribution,
      externalSessionTakeover: piExternalSessionTakeoverContribution,
      externalSessionObservation: piExternalSessionObservationContribution,
    },
  },
  systemTools: {
    'pi-cli': { title: 'Pi coding-agent CLI', executableNames: ['pi'] },
  },
  hooks: {},
  settings: {
    [PI_AGENT_SETTINGS_CONTRIBUTION_ID]: PI_AGENT_SETTINGS_DECLARATION,
  },
  ui: { translations: PI_UI_TRANSLATION_BUNDLES },
});

export const PLUGIN_MANIFEST = PI_PLUGIN.manifest;
