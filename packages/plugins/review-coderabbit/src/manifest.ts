import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { AGENT_DEFINITION } from './agent/definition.js';
import { CODERABBIT_CLI_AUTH } from './agent/authStatus.js';
import { createCodeRabbitExecutionRunFactory } from './agent/reviews/nativeRun.js';
import { createCodeRabbitReviewExecutionProfile } from './agent/reviews/profile.js';
import { CODERABBIT_SYSTEM_TOOL_ID } from './agent/reviews/systemTool.js';
import { CODERABBIT_ACCOUNT_RUNTIME } from './connectedAccount.js';
import { CODERABBIT_ACCOUNT_PURPOSE, CODERABBIT_ACCOUNT_SERVICE_ID, CODERABBIT_STATE_SHARING } from './connectedAccountDeclarations.js';

const createCodeRabbitRuntime: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: createCodeRabbitExecutionRunFactory(),
});

export const CODERABBIT_PLUGIN = definePlugin({
  id: 'happier.review.coderabbit',
  version: '0.0.0',
  displayName: 'CodeRabbit review engine',
  description: 'Runs CodeRabbit as a review-only execution engine.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: {
    required: [{
      id: 'coderabbit-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted execution-run workspace as the CodeRabbit process working directory.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'coderabbit-process',
      capability: 'process',
      reason: 'Launch the user-installed CodeRabbit review CLI for an admitted review run.',
      scope: {
        executables: [{ kind: 'systemTool', id: CODERABBIT_SYSTEM_TOOL_ID }],
        envKeys: ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CODERABBIT_API_KEY'],
      },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    [CODERABBIT_ACCOUNT_SERVICE_ID]: {
      declaration: {
        title: 'CodeRabbit', capabilities: [],
        authentication: { defaultModeId: 'native-login', modes: [{
          id: 'native-login', kind: 'manual', title: 'Browser sign-in on this Machine',
          outcomeReconciliation: 'none',
          setup: { url: 'https://docs.coderabbit.ai/cli',
            checklist: ['CodeRabbit opens a browser on the selected Machine. Complete sign-in there; Happier keeps the login in a private managed home.'] },
          fields: [{ id: 'region', title: 'Region', schema: { type: 'string', enum: ['us', 'eu'] },
            default: 'us', secret: false, presentation: { control: 'select', options: [
              { value: 'us', title: 'US' }, { value: 'eu', title: 'EU' },
            ] } }],
        }] },
      },
      runtime: CODERABBIT_ACCOUNT_RUNTIME,
    },
  },
  agents: {
    coderabbit: {
      declaration: {
        title: 'CodeRabbit',
        connectedAccounts: [{ purpose: CODERABBIT_ACCOUNT_PURPOSE, service: CODERABBIT_ACCOUNT_SERVICE_ID,
          required: false, materializationKinds: ['files'], credentialKinds: ['oauth'] }],
        runtime: { kind: 'custom' },
        cli: {
          executable: {
            binaryName: 'coderabbit',
            knownUserBinDirSuffixes: ['.local/bin'],
            knownEnvironmentBinDirs: [{ envVar: 'LOCALAPPDATA', relativeDir: 'Programs/coderabbit' }],
            sourcePreference: 'system-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'sh', args: ['-c', 'installer=$(curl -fsSL https://cli.coderabbit.ai/install.sh) && printf "%s\\n" "$installer" | CR_CLI_SKIP_LOGIN=1 sh'] }],
                linux: [{ cmd: 'sh', args: ['-c', 'installer=$(curl -fsSL https://cli.coderabbit.ai/install.sh) && printf "%s\\n" "$installer" | CR_CLI_SKIP_LOGIN=1 sh'] }],
                win32: [{ cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "$env:CR_CLI_SKIP_LOGIN = '1'; irm https://cli.coderabbit.ai/install.ps1 | iex"] }],
              },
            },
            guideUrl: 'https://docs.coderabbit.ai/cli',
            docsUrl: 'https://docs.coderabbit.ai/cli',
          },
          auth: {
            support: 'login_terminal',
            missingCredentialState: 'unknown',
            loginLaunches: [{ kind: 'primary', args: ['auth', 'login'] }],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'executionRuns',
        catalog: {
          agentCliSystemTool: { toolId: CODERABBIT_SYSTEM_TOOL_ID },
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, { skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' }, executionRuns: { open: ['create'], checkpoint: false, stop: true, workspaceWrites: 'deny' } }),
      },
      cliAuth: CODERABBIT_CLI_AUTH,
      connectedAccountLaunch: {
        stateSharingDescriptor: CODERABBIT_STATE_SHARING,
        switchContinuity: { continuityMode: 'restart_same_home', supportedTransitions: ['connected_to_connected'] },
        continuity: {},
      },
      factory: createCodeRabbitRuntime,
    },
  },
  executionRunProfiles: {
    review: createCodeRabbitReviewExecutionProfile(),
  },
  resources: {
    'review-prompt-resource': {
      kind: 'prompt',
      path: './resources/review-prompt.md',
      contentType: 'text/markdown',
    },
  },
  promptAssets: {
    'review-prompt': {
      kind: 'systemPrompt',
      resource: 'review-prompt-resource',
      target: { kind: 'agent', agent: 'coderabbit' },
    },
  },
  systemTools: {
    [CODERABBIT_SYSTEM_TOOL_ID]: {
      title: 'CodeRabbit CLI',
      executableNames: ['coderabbit'],
    },
  },
});

export const PLUGIN_MANIFEST = CODERABBIT_PLUGIN.manifest;
