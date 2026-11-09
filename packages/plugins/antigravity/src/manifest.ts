import { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/protocol/agents/antigravity/oauth-profile';
import { antigravityConnectedAccountRuntime } from './connectedAccounts/antigravityNativeRuntime.js';
import { antigravityAccountAuthentication } from './connectedAccounts/account.js';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { antigravityExternalSessionsContribution } from './agent/cliPrint/externalSessions.js';
import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { antigravityConnectedAccountLaunch } from './agent/connectedServices/continuity.js';
import { ANTIGRAVITY_ACP_SERVER_INSTALL_ID, ANTIGRAVITY_ACP_SERVER_VERSION, ANTIGRAVITY_BACKEND_ID } from './agent/install/cliRuntime.js';
import { ANTIGRAVITY_CLI_SYSTEM_TOOL_ID } from './agent/systemTool.js';
import { createAntigravityNativeTerminalSurface } from './agent/terminal/nativeSurface.js';

export const ANTIGRAVITY_PLUGIN = definePlugin({
  id: 'happier.agent.antigravity',
  version: '0.0.0',
  displayName: 'Antigravity',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'antigravity-oauth', capability: 'network', reason: 'Authorize and refresh the selected Google Antigravity account.',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://oauth2.googleapis.com' },
        { kind: 'fixedOrigin', origin: 'https://www.googleapis.com' },
      ], methods: ['GET', 'POST'] },
    }, {
      id: 'antigravity-external-session-transcripts',
      capability: 'filesystem',
      reason: 'Read source-qualified Antigravity CLI transcripts for External Session observation.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'antigravity-acp-process',
      capability: 'process',
      reason: 'Launch the pinned official Antigravity ACP server through host-mediated execution.',
      scope: { executables: [{ kind: 'managedDependency', id: 'agy-acp-server' }], envKeys: ['GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE'] },
    }, {
      id: 'antigravity-cli-process',
      capability: 'process',
      reason: 'Launch the user-installed Antigravity CLI through host-mediated execution.',
      scope: { executables: [{ kind: 'systemTool', id: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID }] },
    }, {
      id: 'antigravity-quota', capability: 'network', reason: 'Read quota for the selected Antigravity Connected Account.',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://cloudcode-pa.googleapis.com' },
        { kind: 'fixedOrigin', origin: 'https://daily-cloudcode-pa.googleapis.com' },
      ], methods: ['POST'] },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    'antigravity-account': {
      declaration: {
        title: 'Google Antigravity',
        authentication: {
          account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
          defaultModeId: 'oauth-personal',
          modes: [{
            id: 'oauth-personal', kind: 'oauthAuthorizationCode', title: 'Sign in with Google',
            callbackUrl: ANTIGRAVITY_OAUTH_PROFILE.callbackUrl,
            scopes: [...ANTIGRAVITY_OAUTH_PROFILE.scopes], pkce: 'required', outcomeReconciliation: 'none',
            allowRawAuthorizationCode: ANTIGRAVITY_OAUTH_PROFILE.allowRawAuthorizationCode,
          }, {
            id: 'native-import', kind: 'manual', title: 'Import native login', outcomeReconciliation: 'none',
            setup: {
              url: 'https://antigravity.google/docs/cli/install/',
              checklist: ['Sign in to Antigravity on the computer you will import from.', 'Choose the matching native login source and that computer in Happier.'],
              createKeyTitle: 'Read Antigravity sign-in instructions',
            },
            credentialOrigin: 'native_import',
            fields: [{ id: 'source', title: 'Native login source', secret: false,
              description: 'Importing shares this native login with Happier. The native app may ask you to sign in again when Happier renews it. On macOS, ACP import reads the Keychain without testing write availability.',
              schema: { type: 'string', enum: ['acp', 'cli', 'cli-file'] }, default: 'acp',
              presentation: { control: 'select', options: [
                { value: 'acp', title: 'Antigravity ACP' },
                { value: 'cli', title: 'Antigravity CLI (macOS and Linux)' },
                { value: 'cli-file', title: 'Antigravity CLI credential file' },
              ] },
            }],
          }],
        },
      },
      runtime: antigravityConnectedAccountRuntime,
      accountRuntime: antigravityAccountAuthentication,
    },
  },
  agents: {
    [ANTIGRAVITY_BACKEND_ID]: {
      declaration: {
        title: 'Antigravity',
        runtime: {
          kind: 'acp',
          transport: {
            kind: 'stdio',
            executable: { kind: 'managedDependency', id: 'agy-acp-server' },
          },
          definition: {
            auth: { methodId: 'oauth-personal',
              // ACP 1.3.0 marks failed refresh/onboarding separately from generic missing authentication.
              setupFailure: { requestErrorCode: -32000, dataReason: 'onboarding_failed' },
            },
            mcp: { policy: 'pass_through' },
            // Rendered diagnostic in the pinned ACP 1.3.0 quota_errors.py; advisory reset prose never creates a reset instant.
            usageLimitDiagnostic: {
              pattern: String.raw`^Usage Limit Reached\n\nYou have reached your current quota for this period\.(?: Your limit will reset (?:in \d+ (?:days?|hours?|minutes?|seconds?)(?:, \d+ (?:days?|hours?|minutes?|seconds?))?|on [A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2} UTC)\.)?$`,
              connectedAccountService: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' },
            },
          },
        },
        cli: {
          displayName: 'Antigravity CLI',
          executable: {
            binaryName: 'agy',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] }],
                linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] }],
                win32: [{
                  cmd: 'powershell.exe',
                  args: [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    'irm https://antigravity.google/cli/install.ps1 | iex',
                  ],
                }],
              },
            },
            guideUrl: 'https://antigravity.google/docs/cli-install',
            docsUrl: 'https://antigravity.google/docs/cli-install',
          },
          auth: {
            support: 'login_terminal',
            machineLoginKey: 'antigravity-cli',
            loginLaunches: [{ kind: 'primary', target: 'agent_acp', args: [] }],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        catalog: {
          agentCliSystemTool: { toolId: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        connectedAccounts: [{
          purpose: 'model_upstream',
          service: 'antigravity-account',
          required: false,
          materializationKinds: ['files', 'environment'],
          credentialKinds: ['oauth'],
        }],
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: { user: [['.gemini', 'antigravity-cli', 'skills']], project: [['.gemini', 'skills'], ['.agents', 'skills']] } },
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'antigravityCliPrint',
              contentSearch: true,
              schema: {
                fields: [
                  { kind: 'literal', name: 'kind', value: 'antigravityCliPrint' },
                  { kind: 'string', name: 'brainDir', min: 1, max: 10_000, nullish: true },
                  { kind: 'string', name: 'conversationId', min: 1, max: 2_000, nullish: true },
                  { kind: 'string', name: 'sourceRevision', min: 1, max: 10_000, nullish: true },
                ],
              },
              key: {
                segments: [
                  { kind: 'literal', value: 'antigravityCliPrint' },
                  { kind: 'field', field: 'brainDir' },
                ],
              },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
      },
      connectedAccountLaunch: antigravityConnectedAccountLaunch,
      externalSessions: antigravityExternalSessionsContribution,
      externalSessionObservation: antigravityExternalSessionObservationContribution,
      terminal: createAntigravityNativeTerminalSurface(),
    },
  },
  managedDependencies: {
    'agy-acp-server': {
      title: 'Antigravity ACP server',
      description: 'Official pinned Antigravity ACP server.',
      sources: [{
        kind: 'pinnedArchive',
        installId: ANTIGRAVITY_ACP_SERVER_INSTALL_ID,
        version: ANTIGRAVITY_ACP_SERVER_VERSION,
        // All six official 1.3.0 archives were downloaded and SHA-256 reviewed
        // on 2026-10-08. Largest archive: 333,727,150 bytes; largest file:
        // 930,848,992 bytes; largest expanded payload: 1,056,922,005 bytes.
        // Retain the existing release-owned extraction allowance and deadline.
        archiveExtractionLimits: {
          maxArchiveBytes: 1024 * 1024 * 1024,
          maxFileBytes: 2 * 1024 * 1024 * 1024,
          maxExpandedBytes: 2 * 1024 * 1024 * 1024,
          timeoutMs: 10 * 60_000,
        },
        assetsByPlatform: {
          'darwin-arm64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
            sha256: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
            sizeBytes: 111456962,
            executableSubpath: 'agy_acp_server.par',
          },
          'darwin-x64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip',
            sha256: 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
            sizeBytes: 117245544,
            executableSubpath: 'agy_acp_server.par',
          },
          'linux-x64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
            sha256: '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
            sizeBytes: 333727150,
            executableSubpath: 'agy_acp_server.par',
            args: ['--uid='],
          },
          'linux-arm64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip',
            sha256: '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
            sizeBytes: 321690363,
            executableSubpath: 'agy_acp_server.par',
            args: ['--uid='],
          },
          'win32-x64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
            sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
            sizeBytes: 124509787,
            executableSubpath: 'agy_acp_server.exe',
          },
          'win32-arm64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-arm64.zip',
            sha256: '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3',
            sizeBytes: 124654803,
            executableSubpath: 'agy_acp_server.exe',
          },
        },
      }],
      platforms: ['macos', 'linux', 'windows'],
      architectures: ['arm64', 'x64'],
      executable: 'agy_acp_server',
    },
  },
  systemTools: {
    [ANTIGRAVITY_CLI_SYSTEM_TOOL_ID]: {
      title: 'Antigravity CLI',
      executableNames: ['agy'],
    },
  },
});

export const PLUGIN_MANIFEST = ANTIGRAVITY_PLUGIN.manifest;
