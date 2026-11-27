import { createAntigravityAgentRuntime } from './agent/runtime/factory.js';
import { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/protocol/agents/antigravity/oauth-profile';
import { antigravityConnectedAccountRuntime } from './connectedAccounts/antigravityNativeRuntime.js';
import { antigravityAccountAuthentication } from './connectedAccounts/account.js';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { antigravityExternalSessionsContribution } from './agent/cliPrint/externalSessions.js';
import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { antigravityConnectedAccountLaunch } from './agent/connectedServices/continuity.js';
import { ANTIGRAVITY_BACKEND_ID, ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV } from './agent/install/cliRuntime.js';
import { ANTIGRAVITY_CLI_SYSTEM_TOOL_ID } from './agent/systemTool.js';
import {
  GEMINI_API_KEY_ENV,
  GEMINI_CONNECTED_ACCOUNT_SERVICE,
} from '@happier-dev/plugin-sdk/connected-accounts';

export const ANTIGRAVITY_PLUGIN = definePlugin({
  id: 'happier.agent.antigravity',
  version: '0.0.0',
  displayName: 'Antigravity',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
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
      id: 'antigravity-cli-process',
      capability: 'process',
      reason: 'Launch the user-installed Antigravity CLI through host-mediated execution.',
      scope: { executables: [{ kind: 'systemTool', id: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID }],
        envKeys: ['GEMINI_HOME', GEMINI_API_KEY_ENV, ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV] },
    }, {
      id: 'antigravity-quota', capability: 'network', reason: 'Set up the selected Antigravity project and read its quota.',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://cloudcode-pa.googleapis.com' },
        { kind: 'fixedOrigin', origin: 'https://daily-cloudcode-pa.googleapis.com' },
      ], methods: ['GET', 'POST'] },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    'antigravity-account': {
      declaration: {
        title: 'Google Antigravity',
        capabilities: ['usage'],
        ui: { iconResourceId: 'agent-mark' },
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
              description: 'Importing shares this native login with Happier. The native app may ask you to sign in again when Happier renews it. On macOS, importing an earlier Happier sign-in reads the Keychain without testing write availability.',
              schema: { type: 'string', enum: ['acp', 'cli', 'cli-file'] }, default: 'cli',
              presentation: { control: 'select', options: [
                { value: 'cli', title: 'Antigravity CLI (macOS and Linux)' },
                { value: 'cli-file', title: 'Antigravity CLI credential file' },
                // Store of the retired Antigravity ACP server that earlier Happier releases ran.
                { value: 'acp', title: 'Earlier Happier Antigravity sign-in' },
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
        runtime: { kind: 'custom' },
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
            loginLaunches: [{ kind: 'primary', target: 'provider_cli', args: ['acp', '--login'] }],
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
        }, {
          purpose: 'gemini-api-key',
          service: GEMINI_CONNECTED_ACCOUNT_SERVICE,
          required: false,
          materializationKinds: ['environment'],
          credentialKinds: ['token'],
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
      factory: createAntigravityAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory', export: 'createAntigravityAgentRuntime',
        runtimeApiVersion: 1, externalSessionsExport: 'antigravityExternalSessionsContribution',
      },
      connectedAccountLaunch: antigravityConnectedAccountLaunch,
      externalSessions: antigravityExternalSessionsContribution,
      externalSessionObservation: antigravityExternalSessionObservationContribution,
    },
  },
  systemTools: {
    [ANTIGRAVITY_CLI_SYSTEM_TOOL_ID]: {
      title: 'Antigravity CLI',
      executableNames: ['agy'],
    },
  },
  resources: {
    'agent-mark': { kind: 'asset', path: 'assets/agent-mark.svg', contentType: 'image/svg+xml' },
  },
});

export const PLUGIN_MANIFEST = ANTIGRAVITY_PLUGIN.manifest;
