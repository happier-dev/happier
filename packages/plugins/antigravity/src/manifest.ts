import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { antigravityExternalSessionsContribution } from './agent/cliPrint/externalSessions.js';
import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { ANTIGRAVITY_ACP_SERVER_INSTALL_ID, ANTIGRAVITY_BACKEND_ID } from './agent/install/cliRuntime.js';
import { ANTIGRAVITY_CLI_SYSTEM_TOOL_ID } from './agent/systemTool.js';
import { createAntigravityNativeTerminalSurface } from './agent/terminal/nativeSurface.js';

export const ANTIGRAVITY_PLUGIN = definePlugin({
  id: 'happier.agent.antigravity',
  version: '0.0.0',
  displayName: 'Antigravity',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
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
      scope: { executables: [{ kind: 'managedDependency', id: 'agy-acp-server' }] },
    }, {
      id: 'antigravity-cli-process',
      capability: 'process',
      reason: 'Launch the user-installed Antigravity CLI through host-mediated execution.',
      scope: { executables: [{ kind: 'systemTool', id: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID }] },
    }],
    optional: [],
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
            auth: { methodId: 'oauth-personal' },
            mcp: { policy: 'pass_through' },
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
                  cmd: 'powershell',
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
        primary: 'sessions',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        connectedAccounts: [{
          purpose: 'model_upstream',
          service: {
            pluginId: 'happier.agent.gemini',
            localId: 'gemini-account',
          },
          required: false,
          materializationKinds: ['environment'],
          credentialKinds: ['token'],
        }],
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
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
              contentSearch: false,
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
        version: '1.1.1',
        // The checksum-pinned Linux x64 archive is 681,969,407 bytes and
        // expands to 2,009,327,248 bytes, including one 1,880,360,328-byte file.
        // Keep the release-specific allowance here instead of widening the
        // generic archive extractor's defaults for every managed dependency.
        archiveExtractionLimits: {
          maxArchiveBytes: 1024 * 1024 * 1024,
          maxFileBytes: 2 * 1024 * 1024 * 1024,
          maxExpandedBytes: 2 * 1024 * 1024 * 1024,
          timeoutMs: 10 * 60_000,
        },
        assetsByPlatform: {
          'darwin-arm64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip',
            sha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189',
            executableSubpath: 'agy_acp_server.par',
          },
          'linux-x64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip',
            sha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df',
            sizeBytes: 681969407,
            executableSubpath: 'agy_acp_server.par',
            args: ['--uid='],
          },
          'linux-arm64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip',
            sha256: 'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398',
            executableSubpath: 'agy_acp_server.par',
            args: ['--uid='],
          },
          'win32-x64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip',
            sha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8',
            executableSubpath: 'agy_acp_server.exe',
          },
          'win32-arm64': {
            archiveUrl: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip',
            sha256: '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc',
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
