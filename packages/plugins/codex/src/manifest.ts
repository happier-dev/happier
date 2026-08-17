import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { OPENAI_CODEX_OAUTH_PROFILE } from '@happier-dev/plugin-sdk/connected-accounts';

import { CODEX_UI_TRANSLATIONS } from './ui/translations.js';
import { CODEX_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { CODEX_REALTIME_CONVERSATION_SUPPORTED_CLI_VERSIONS } from './agent/runtime/appServer/realtimeSupport.js';

const CODEX_REALTIME_VOICE_PRIVACY_DISCLOSURE = Object.freeze({
  key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
  fallback: 'Audio and the Codex Live conversation are sent from this device to OpenAI using WebRTC. The selected Codex session and Connected Services account run through the selected machine. OpenAI may receive bounded startup and session context and delegated Codex results so the conversation can continue and responses can be spoken. Happier’s server and relay do not carry Codex Live audio; the Happier daemon/app-server still carries signaling, session lifecycle, delegation, tools, and permission control. Provider-operated network relays may participate. Codex or OpenAI may retain developer instructions, realtime conversation material, and related diagnostics in provider-native runtime storage according to the selected account and provider policies; Happier does not delete or rewrite that provider-native data.',
});

const CODEX_AGENT_CONTRIBUTION_IDENTITY = 'codex';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.codex',
  version: '0.0.0',
  displayName: 'Codex',
  description: 'OpenAI Codex coding agent.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'codex-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the Codex process working directory.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'codex-process', capability: 'process', reason: 'Run the declared Codex executable.',
      scope: {
        executables: [
          { kind: 'systemTool', id: 'codex-cli' },
          { kind: 'managedDependency', id: 'codex-acp' },
        ],
        envKeys: ['CODEX_HOME'],
      },
    }, {
      id: 'openai-codex-oauth',
      capability: 'network',
      reason: 'Exchange and refresh OpenAI Codex OAuth credentials for the exact Connected Account.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: OPENAI_CODEX_OAUTH_PROFILE.authBaseUrl },
          { kind: 'connectedAccountOrigin', service: 'openai-codex' },
        ],
        methods: ['POST'],
      },
    }, {
      id: 'openai-codex-quota',
      capability: 'network',
      reason: 'Read quota for the exact OpenAI Codex Connected Account.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://chatgpt.com' },
          { kind: 'connectedAccountOrigin', service: 'openai-codex' },
        ],
        methods: ['GET'],
      },
    }],
    optional: [],
  },
  contributes: {
    connectedAccountDescriptors: [{
      id: 'openai-codex',
      title: 'Codex',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          scopes: [...OPENAI_CODEX_OAUTH_PROFILE.scopes],
          pkce: 'required',
          outcomeReconciliation: 'none',
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          scopes: [...OPENAI_CODEX_OAUTH_PROFILE.scopes],
          outcomeReconciliation: 'none',
        }],
      },
    }],
    agents: [{
      id: 'codex',
      title: 'Codex',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'OpenAI Codex CLI',
        executable: {
          binaryName: 'codex',
          knownUserBinDirSuffixes: null,
          sourcePreference: 'system-first',
        },
        install: {
          managed: {
            kind: 'github_release_binary',
            githubRepo: 'openai/codex',
            binaryName: 'codex',
            assetNameByPlatform: {
              darwin: {
                arm64: 'codex-package-aarch64-apple-darwin.tar.gz',
                x64: 'codex-package-x86_64-apple-darwin.tar.gz',
              },
              linux: {
                arm64: 'codex-package-aarch64-unknown-linux-musl.tar.gz',
                x64: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
              },
              win32: {
                arm64: 'codex-package-aarch64-pc-windows-msvc.tar.gz',
                x64: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
              },
            },
            // OpenAI Codex rust-v0.147.0's canonical package layout. Keep this
            // an explicit runtime allowlist: package metadata, rg, and other
            // bundled files are not part of Happier's managed installation.
            archiveEntriesByPlatform: {
              darwin: [
                { archivePath: 'bin/codex', destinationPath: 'bin/codex' },
                { archivePath: 'bin/codex-code-mode-host', destinationPath: 'bin/codex-code-mode-host' },
              ],
              linux: [
                { archivePath: 'bin/codex', destinationPath: 'bin/codex' },
                { archivePath: 'bin/codex-code-mode-host', destinationPath: 'bin/codex-code-mode-host' },
              ],
              win32: [
                { archivePath: 'bin/codex.exe', destinationPath: 'bin/codex.exe' },
                { archivePath: 'bin/codex-code-mode-host.exe', destinationPath: 'bin/codex-code-mode-host.exe' },
                {
                  archivePath: 'codex-resources/codex-command-runner.exe',
                  destinationPath: 'codex-resources/codex-command-runner.exe',
                },
                {
                  archivePath: 'codex-resources/codex-windows-sandbox-setup.exe',
                  destinationPath: 'codex-resources/codex-windows-sandbox-setup.exe',
                },
              ],
            },
            // OpenAI Codex rust-v0.147.0's checksum-pinned x64 Windows package
            // expands to 370,442,135 bytes, including one 298,668,336-byte
            // executable. The 384 MiB ceilings retain bounded headroom without
            // weakening the shared archive, path, or compression-ratio guards.
            archiveExtractionLimits: {
              maxFileBytes: 384 * 1024 * 1024,
              maxExpandedBytes: 384 * 1024 * 1024,
            },
          },
          manual: { kind: 'command' },
          recommendationOrder: 20,
          guideUrl: null,
          docsUrl: 'https://github.com/openai/codex',
        },
        auth: {
          support: 'login_terminal',
          probe: {
            parser: 'codexLoginStatus',
            backgroundChecks: 'safe',
            statusArgs: ['login', 'status'],
            envVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
            credentialPaths: ['~/.codex/auth.json'],
          },
          loginLaunches: [{ kind: 'primary', args: ['login'] }],
        },
      },
      primary: 'sessions',
      connectedAccounts: [{
        purpose: 'primary',
        service: 'openai-codex',
        required: false,
        materializationKinds: ['files'],
      }],
      capabilities: {
        surfaces: ['terminal', 'externalSessions'],
        sessions: {
          open: ['create', 'resume', 'fork'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
          configuration: true,
          conversationRollback: true,
          goals: {
            active: {
              get: true,
              clear: true,
              set: {
                fields: ['objective', 'status', 'tokenBudget'],
                writableStatuses: ['active', 'paused', 'complete'],
              },
            },
            inactive: {
              get: true,
              clear: true,
              set: {
                fields: ['objective', 'status', 'tokenBudget'],
                writableStatuses: ['active', 'paused', 'complete'],
              },
            },
            source: 'goals',
          },
          catalog: {
            active: ['vendorPlugins', 'skills'],
            inactive: ['vendorPlugins', 'skills'],
          },
          usageLimitRecovery: {
            active: ['checkNow'],
            inactive: ['checkNow'],
          },
          continuationVerification: { intents: ['resume', 'fork'], requirement: 'required' },
          workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
          startupInstructions: { versions: [1] },
        },
        executionRuns: { open: ['create', 'resume'], checkpoint: true, stop: true },
      },
      providerRequirements: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true, toolRoundTrips: true },
        credentialSupport: {
          supportsNoAuth: true,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
          }],
        },
        authIsolation: {
          suppressConnectedServiceIds: ['openai-codex', 'openai'],
          ownedEnvKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
        },
        materialization: 'engineConfig',
        applyPolicy: 'restart_session',
        supportsFreeformModelIds: true,
      },
      surfaces: { externalSession: {
        externalLinkedTakeover: { writerSafety: 'unsupported' },
        sources: [{
        sourceKind: 'codexHome',
        schema: {
          fields: [
            { name: 'kind', kind: 'literal', value: 'codexHome' },
            { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
            { name: 'homePath', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
          ],
          refinements: [
            { kind: 'requiresWhenEquals', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
            { kind: 'forbidsWhenEquals', fields: ['connectedServiceId', 'connectedServiceProfileId', 'connectedServiceGroupId'], when: { field: 'home', equals: 'user' } },
          ],
        },
        key: { segments: [
          { kind: 'literal', value: 'codexHome' },
          { kind: 'homeMode', field: 'home' },
          { kind: 'conditionalField', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
          { kind: 'connectedServiceScope', groupField: 'connectedServiceGroupId', profileField: 'connectedServiceProfileId', when: { field: 'home', equals: 'connectedService' } },
          { kind: 'field', field: 'homePath' },
        ] },
        instances: [
          { kind: 'default', constants: { home: 'user' } },
          {
            kind: 'connectedServiceProfiles',
            serviceId: 'openai-codex',
            constants: { home: 'connectedService' },
            fields: {
              serviceId: 'connectedServiceId',
              profileId: 'connectedServiceProfileId',
            },
          },
        ],
      }],
      } },
    }],
    voiceProviders: [{
      id: 'realtime-codex',
      title: 'Codex Realtime Voice — Experimental',
      kind: 'conversation',
      roles: [
        'conversation_stt',
        'conversation_tts',
        'realtime_conversation',
        'turn_control',
      ],
      platforms: ['web', 'ios', 'android'],
      capabilities: {
        turn: { cancelResponse: false, bargeIn: false },
      },
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: CODEX_AGENT_CONTRIBUTION_IDENTITY,
        supportedRuntimeVersions: [...CODEX_REALTIME_CONVERSATION_SUPPORTED_CLI_VERSIONS],
      },
      settings: {
        schemaVersion: 2,
        fields: [],
        privacyDisclosure: CODEX_REALTIME_VOICE_PRIVACY_DISCLOSURE,
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Codex account',
          description: 'Connected Service account used by global Codex Voice sessions.',
          agent: CODEX_AGENT_CONTRIBUTION_IDENTITY,
          serviceIds: ['openai-codex'],
        },
      },
      client: {
        artifactId: 'voice-runtime-web',
        modulePath: './ui/voice',
        exportName: 'activate',
      },
    }],
    systemTools: [{ id: 'codex-cli', title: 'OpenAI Codex CLI', executableNames: ['codex'] }],
    managedDependencies: [{
      id: 'codex-acp', title: 'Codex ACP adapter',
      sources: [{ kind: 'vendorRecipe', recipeId: 'codex-acp' }], executable: 'codex-acp',
    }],
    hooks: [
      { id: 'resolve-prerequisites', on: 'agent.resolvePrerequisites', category: 'decision', scope: 'agent', filters: { agentId: 'codex' }, executionKind: 'decide' },
      { id: 'augment-spawn-env', on: 'agent.spawnEnv.augment', category: 'augmentation', scope: 'daemon', filters: { agentId: 'codex' }, executionKind: 'augment' },
    ],
    mcp: {
      servers: [],
      discoverySources: [{ id: 'config', title: 'Codex MCP configuration', metadata: { agentId: 'codex' } }],
    },
    ui: {
      translations: [{ locale: 'en', messages: CODEX_UI_TRANSLATIONS.en }],
    },
    settings: [CODEX_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
