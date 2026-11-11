import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';

import { AGENT_DEFINITION } from './agent/definition.js';
import { interpretCursorCliAuthCommand } from './agent/auth/status.js';
import { CURSOR_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/models.js';
import { createCursorAgentRuntime } from './agent/runtime/engine.js';
import { CURSOR_AGENT_SETTINGS_CONTRIBUTION } from './agent/settings.js';
import { cursorExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { CURSOR_CONNECTED_ACCOUNT_LAUNCH, CURSOR_NATIVE_PURPOSE_ID } from './agent/connectedAccount.js';
import { cursorConnectedAccountRuntime, cursorPortableAccountRuntime } from './connectedAccounts/runtime.js';

const {
  id: CURSOR_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...CURSOR_AGENT_SETTINGS_DECLARATION
} = CURSOR_AGENT_SETTINGS_CONTRIBUTION;

export const CURSOR_PLUGIN = definePlugin({
  id: 'happier.agent.cursor',
  version: '0.0.0',
  displayName: 'Cursor',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'cursor-api-key',
      capability: 'environment',
      reason: 'Read CURSOR_API_KEY when environment-based Cursor authentication is selected.',
      scope: { keys: ['CURSOR_API_KEY'] },
    }, {
      id: 'cursor-process',
      capability: 'process',
      reason: 'Launch the user-installed Cursor Agent CLI.',
      scope: {
        executables: [
          { kind: 'systemTool', id: 'cursor-agent' },
          { kind: 'systemTool', id: 'cursor-agent-no-fallback' },
        ],
        envKeys: ['CURSOR_API_KEY'],
      },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    'cursor-account': {
      declaration: {
        title: 'Cursor',
        ui: { iconResourceId: 'agent-mark' },
        authentication: {
          account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
          defaultModeId: 'api-key',
          modes: [{
            id: 'api-key', kind: 'manual', apiKey: true, title: 'User or service API key',
            setup: {
              url: 'https://cursor.com/dashboard',
              checklist: ['Create a user or service API key in Cursor Dashboard → API Keys. Admin keys are not supported.', 'Copy the key and paste it here.'],
              createKeyTitle: 'Open Cursor API keys',
            },
            accountDirectSave: { fieldKeys: { token: 'apiKey' } },
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Cursor API key', schema: { type: 'string', minLength: 1 }, secret: true }],
          }],
        },
      },
      runtime: cursorConnectedAccountRuntime,
      accountRuntime: cursorPortableAccountRuntime,
    },
  },
  agents: {
    cursor: {
      declaration: {
        title: 'Cursor',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'Cursor Agent CLI',
          executable: {
            binaryName: 'cursor-agent',
            alternativeBinaryNames: ['agent'],
            alternativeBinaryFallbackEnabledEnvVar: 'HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED',
            knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreference: 'system-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://cursor.com/install | bash'] }],
                linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://cursor.com/install | bash'] }],
                win32: [{
                  cmd: 'powershell.exe',
                  args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "irm 'https://cursor.com/install?win32=true' | iex"],
                }],
              },
            },
            guideUrl: 'https://cursor.com/docs/cli/installation',
            docsUrl: 'https://cursor.com/docs/cli',
            // https://cursor.com/docs/cli/installation ("agent update"); `agent` and `cursor-agent`
            // are the same installed executable under ~/.local/share/cursor-agent/versions/.
            nativeUpdate: {
              args: ['update'],
              installPaths: ['.local/share/cursor-agent'],
            },
          },
          auth: {
            support: 'status_only',
            environmentVariables: ['CURSOR_API_KEY'],
            nonInteractiveStatusProbe: true,
            loginLaunches: [],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        connectedAccounts: [{
          purpose: CURSOR_NATIVE_PURPOSE_ID, service: 'cursor-account', required: false,
          credentialKinds: ['token'], materializationKinds: ['environment'],
        }],
        catalog: {
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
          agentCliSystemTool: { toolId: 'cursor-agent' },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: {
            delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: {
              user: [['.agents', 'skills'], ['.cursor', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']],
              project: [['.agents', 'skills'], ['.cursor', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']],
            },
          },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            configuration: true,
            executionRunContext: { versions: [1] },
            workStateSources: [{ id: 'todos', itemKinds: ['todo'] }],
          },
        }),
        surfaces: { externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{ sourceKind: 'cursorHome', contentSearch: true,
            schema: { fields: [
              { kind: 'literal', name: 'kind', value: 'cursorHome' },
              { kind: 'string', name: 'homeDir', min: 1, max: 10_000, nullish: true },
            ] },
            key: { segments: [{ kind: 'literal', value: 'cursorHome' }, { kind: 'field', field: 'homeDir' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        } },
      },
      factory: createCursorAgentRuntime,
      connectedAccountLaunch: CURSOR_CONNECTED_ACCOUNT_LAUNCH,
      externalSessions: cursorExternalSessionsContribution,
      preflightSessionControls: CURSOR_PREFLIGHT_SESSION_CONTROLS,
      cliAuth: {
        detectAuthStatus: async ({ runDeclaredSystemToolCommand }) =>
          interpretCursorCliAuthCommand(await runDeclaredSystemToolCommand({
            toolId: 'cursor-agent',
            args: ['about', '--format', 'json'],
            timeoutMs: 6_000,
          })),
      },
      sessionRunnerFactory: {
        module: './agent/runtime/engine',
        export: 'createCursorAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'cursorExternalSessionsContribution',
      },
    },
  },
  systemTools: {
    'cursor-agent': {
      title: 'Cursor Agent CLI',
      executableNames: ['cursor-agent', 'agent'],
    },
    'cursor-agent-no-fallback': {
      title: 'Cursor Agent CLI without legacy agent fallback',
      executableNames: ['cursor-agent'],
    },
  },
  settings: {
    [CURSOR_AGENT_SETTINGS_CONTRIBUTION_ID]: CURSOR_AGENT_SETTINGS_DECLARATION,
  },
  resources: {
    'agent-mark': { kind: 'asset', path: 'assets/agent-mark.svg', contentType: 'image/svg+xml' },
  },
});

export const PLUGIN_MANIFEST = CURSOR_PLUGIN.manifest;
