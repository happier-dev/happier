import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createCursorAgentRuntime } from './agent/runtime/engine.js';
import { CURSOR_AGENT_SETTINGS_CONTRIBUTION } from './agent/settings.js';

const {
  id: CURSOR_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...CURSOR_AGENT_SETTINGS_DECLARATION
} = CURSOR_AGENT_SETTINGS_CONTRIBUTION;

export const CURSOR_PLUGIN = definePlugin({
  id: 'happier.agent.cursor',
  version: '0.0.0',
  displayName: 'Cursor',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
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
            manual: { kind: 'vendor_recipe' },
            guideUrl: 'https://cursor.com/docs/cli/installation',
            docsUrl: 'https://cursor.com/docs/cli',
          },
          auth: {
            support: 'status_only',
            probe: {
              parser: 'cursorAboutJson',
              backgroundChecks: 'safe',
              statusArgs: ['about', '--format', 'json'],
              envVars: ['CURSOR_API_KEY'],
            },
            loginLaunches: [],
          },
        },
        primary: 'sessions',
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
            configuration: true,
            workStateSources: [{ id: 'todos', itemKinds: ['todo'] }],
          },
        }),
      },
      factory: createCursorAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/engine',
        export: 'createCursorAgentRuntime',
        runtimeApiVersion: 1,
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
});

export const PLUGIN_MANIFEST = CURSOR_PLUGIN.manifest;
