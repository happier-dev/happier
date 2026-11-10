import { OH_MY_PI_PROVIDER_BINDING_ADAPTER, OH_MY_PI_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding.js';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';
import { resolveSessionFileStoreLaunchEnvironment } from '@happier-dev/plugin-sdk/sessions/file-stores';

import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES, ohMyPiPurposeEnvironmentKeys, ohMyPiPurposeOwnedEnvironmentKeys } from './agent/auth/services/accountPurposes.js';
import { ohMyPiConnectedServiceStateSharingDescriptor } from './agent/connectedServices/stateSharing.js';
import { verifyResumeReachableOhMyPi } from './agent/connectedServices/reachability.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { OH_MY_PI_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/models.js';
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
import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from './agent/sessionFileStoreDescriptor.js';
import { OH_MY_PI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';


const OH_MY_PI_AUTH_ENV_KEYS = [...new Set(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.flatMap(row => row.nativeRoutes.map(route => route.launchEnvironmentKey)))];

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
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'ohmypi-process',
      capability: 'process',
      reason: 'Launch the user-installed Oh My Pi CLI through the host execution service.',
      scope: {
        executables: [{ kind: 'systemTool', id: OH_MY_PI_SYSTEM_TOOL_ID }],
        envKeys: [...OH_MY_PI_PROVIDER_OWNED_ENV_KEYS, 'PI_CODING_AGENT_DIR'],
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
            environmentVariables: [...OH_MY_PI_AUTH_ENV_KEYS],
            loginLaunches: [],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        catalog: {
          agentCliSystemTool: { toolId: OH_MY_PI_SYSTEM_TOOL_ID },
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        connectedAccounts: OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map((row) => ({
          purpose: row.purpose,
          service: row.service,
          required: false,
          materializationKinds: ['environment' as const, ...(row.fileCredential ? ['files' as const] : [])],
          credentialKinds: [...row.credentialKinds],
        })),
        providerRequirements: {
          acceptsProtocols: ['openai-responses'],
          required: { streaming: true, toolRoundTrips: true },
          credentialSupport: {
            supportsNoAuth: false,
            apiKeyTransports: [{ protocol: 'openai-responses', destination: {
              kind: 'httpHeader', names: ['authorization'], formats: ['bearer'],
            } }],
          },
          authIsolation: {
            suppressConnectedServiceIds: [...new Set(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map(row => buildQualifiedPluginContributionKey(row.service)))],
            ownedEnvKeys: [...OH_MY_PI_PROVIDER_OWNED_ENV_KEYS],
          },
          materialization: 'configFile',
          applyPolicy: 'restart_session',
          supportsFreeformModelIds: true,
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          skills: {
            delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: {
              user: [['.omp', 'agent', 'skills'], ['.claude', 'skills'], ['.codex', 'skills'], ['.agent', 'skills'], ['.agents', 'skills']],
              project: [['.omp', 'skills'], ['.claude', 'skills'], ['.codex', 'skills'], ['.agent', 'skills'], ['.agents', 'skills'], ['.github', 'skills']],
            },
          },
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
            configuration: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'ohMyPiAgentDir',
              contentSearch: true,
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
      providerBinding: OH_MY_PI_PROVIDER_BINDING_ADAPTER,
      connectedAccountLaunch: {
        fileEnvironmentUses: OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.flatMap(row => row.fileCredential
          ? [{ purpose: row.purpose, ...row.fileCredential }] : []),
        environmentUnsetUses: OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.flatMap(row => ohMyPiPurposeOwnedEnvironmentKeys(row).map(environmentKey => ({
          purpose: row.purpose, environmentKey,
        }))),
        // Regional bases are consumed by native configuration preparation, not host env delivery.
        environmentUses: OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.flatMap(row => ohMyPiPurposeEnvironmentKeys(row)
          .filter(key => !row.nativeRoutes.some(route => key === route.nativeBaseEnvironmentKey)).map(environmentKey => ({
          purpose: row.purpose, environmentKey,
        }))),
        stateSharingDescriptor: ohMyPiConnectedServiceStateSharingDescriptor,
        continuity: {
          generationApplicationScope: 'per_session_runtime',
          verifyResumeReachable: verifyResumeReachableOhMyPi,
        },
      },
      preflightSessionControls: OH_MY_PI_PREFLIGHT_SESSION_CONTROLS,
      cliSessionCommand: {
        sessionRuntimeId: 'ohMyPi',
        accountSettingsAgentId: 'ohMyPi',
        buildSessionOptions: (input) => {
          const environmentVariables = resolveSessionFileStoreLaunchEnvironment({
            product: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
            settings: input.pluginSettings.account ?? {},
            env: input.environment,
          });
          return {
            ok: true,
            options: Object.keys(environmentVariables).length > 0
              ? { environmentVariables }
              : {},
          };
        },
      },
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
        filters: { agentId: 'ohMyPi' },
      },
      handler: resolveOhMyPiDaemonSpawnPrerequisitesHook,
    },
  },
  settings: {
    [OH_MY_PI_AGENT_SETTINGS_CONTRIBUTION_ID]: OH_MY_PI_AGENT_SETTINGS_DECLARATION,
  },
  ui: { translations: [
    { locale: "en", resourceId: "i18n-en" },
    { locale: "de", resourceId: "i18n-de" },
    { locale: "ru", resourceId: "i18n-ru" },
    { locale: "pl", resourceId: "i18n-pl" },
    { locale: "es", resourceId: "i18n-es" },
    { locale: "fr", resourceId: "i18n-fr" },
    { locale: "it", resourceId: "i18n-it" },
    { locale: "pt", resourceId: "i18n-pt" },
    { locale: "ca", resourceId: "i18n-ca" },
    { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
    { locale: "ja", resourceId: "i18n-ja" },
  ] },
  resources: {
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
});

export const PLUGIN_MANIFEST = OH_MY_PI_PLUGIN.manifest;
