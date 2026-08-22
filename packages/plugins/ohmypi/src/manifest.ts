import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES } from './agent/auth/services/accountPurposes.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { resolveOhMyPiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createOhMyPiAgentRuntime } from './agent/runtime/engine.js';
import { ohMyPiExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import {
  ohMyPiExternalSessionObservationContribution,
} from './agent/surfaces/sessions/external/observation.js';
import {
  ohMyPiExternalSessionTakeoverContribution,
} from './agent/surfaces/sessions/external/semantics.js';
import { OH_MY_PI_SYSTEM_TOOL_ID } from './agent/systemTool.js';
import { OH_MY_PI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { OH_MY_PI_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const OH_MY_PI_AUTH_ENV_KEYS = [
  'OPENAI_CODEX_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
] as const;

const resolveOhMyPiDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveOhMyPiDaemonSpawnPrerequisites(event, context);

const {
  id: OH_MY_PI_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...OH_MY_PI_AGENT_SETTINGS_DECLARATION
} = OH_MY_PI_AGENT_SETTINGS_CONTRIBUTION;

export const OH_MY_PI_PLUGIN = definePlugin({
  id: 'happier.agent.ohmypi',
  version: '0.0.0',
  displayName: 'Oh My Pi',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'ohmypi-process',
      capability: 'process',
      reason: 'Launch the user-installed Oh My Pi CLI through the host execution service.',
      scope: {
        executables: [{ kind: 'systemTool', id: OH_MY_PI_SYSTEM_TOOL_ID }],
        envKeys: [...OH_MY_PI_AUTH_ENV_KEYS, 'PI_CODING_AGENT_DIR'],
      },
    }],
    optional: [],
  },
  agents: {
    ohmypi: {
      declaration: {
        title: 'Oh My Pi',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'oh-my-pi CLI',
          executable: {
            binaryName: 'omp',
            knownUserBinDirSuffixes: ['.bun/bin'],
            sourcePreference: 'system-first',
            acceptsJavaScriptFileOverride: true,
          },
          install: {
            managed: {
              kind: 'github_release_binary',
              githubRepo: 'can1357/oh-my-pi',
              binaryName: 'omp',
            },
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bun', args: ['install', '-g', '@oh-my-pi/pi-coding-agent'] }],
                linux: [{ cmd: 'bun', args: ['install', '-g', '@oh-my-pi/pi-coding-agent'] }],
                win32: [{ cmd: 'bun', args: ['install', '-g', '@oh-my-pi/pi-coding-agent'] }],
              },
            },
            guideUrl: 'https://github.com/can1357/oh-my-pi#via-bun-recommended',
            docsUrl: 'https://github.com/can1357/oh-my-pi',
          },
          auth: {
            support: 'manual_only',
            machineLoginKey: 'oh-my-pi',
            probe: {
              parser: 'piEnvOnly',
              backgroundChecks: 'safe',
              statusArgs: null,
              envVars: [...OH_MY_PI_AUTH_ENV_KEYS],
            },
            loginLaunches: [],
          },
        },
        primary: 'sessions',
        connectedAccounts: OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map(({ purpose, service }) => ({
          purpose,
          service,
          required: false,
          materializationKinds: ['environment'] as const,
        })),
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
            configuration: true,
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'ohMyPiAgentDir',
              schema: {
                fields: [
                  { kind: 'literal', name: 'kind', value: 'ohMyPiAgentDir' },
                  { kind: 'string', name: 'agentDir', min: 1, max: 10_000, nullish: true },
                  // Resolved carrier, not a logical source identity: `resolveLinkIdentity`
                  // pins the exact session file it verified inside the agent directory and
                  // every later read path (`pageTranscript`, `readAfterTranscript`,
                  // observation, takeover) reads it back off the source the host persisted
                  // and revalidates. It is deliberately absent from `key.segments`, so two
                  // sources differing only by session file keep one source identity.
                  { kind: 'string', name: 'sessionFilePath', min: 1, max: 10_000, nullish: true },
                ],
              },
              key: {
                segments: [
                  { kind: 'literal', value: 'ohMyPiAgentDir' },
                  { kind: 'field', field: 'agentDir' },
                ],
              },
              instances: [{ kind: 'default', constants: {} }, {
                kind: 'agentSettingOverride',
                settingId: 'ohMyPiAgentDir',
                field: 'agentDir',
                normalization: 'configuredPath',
                constants: {},
              }],
            }],
          },
        },
      },
      factory: createOhMyPiAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/engine',
        export: 'createOhMyPiAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'ohMyPiExternalSessionsContribution',
      },
      externalSessions: ohMyPiExternalSessionsContribution,
      externalSessionTakeover: ohMyPiExternalSessionTakeoverContribution,
      externalSessionObservation: ohMyPiExternalSessionObservationContribution,
    },
  },
  systemTools: {
    [OH_MY_PI_SYSTEM_TOOL_ID]: { title: 'Oh My Pi CLI', executableNames: ['omp'] },
  },
  hooks: {
    'resolve-prerequisites': {
      declaration: {
        on: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'ohMyPi' },
        executionKind: 'decide',
      },
      handler: resolveOhMyPiDaemonSpawnPrerequisitesHook,
    },
  },
  settings: {
    [OH_MY_PI_AGENT_SETTINGS_CONTRIBUTION_ID]: OH_MY_PI_AGENT_SETTINGS_DECLARATION,
  },
  ui: { translations: OH_MY_PI_UI_TRANSLATION_BUNDLES },
});

export const PLUGIN_MANIFEST = OH_MY_PI_PLUGIN.manifest;
