import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { AUGGIE_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/models.js';
import { createAuggieAgentRuntime } from './agent/runtime/factory.js';
import { AUGGIE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { auggieExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';

const {
  id: AUGGIE_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...AUGGIE_AGENT_SETTINGS_DECLARATION
} = AUGGIE_AGENT_SETTINGS_CONTRIBUTION;

export const AUGGIE_PLUGIN = definePlugin({
  id: 'happier.agent.auggie',
  version: '0.0.0',
  displayName: 'Auggie',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'auggie-process',
      capability: 'process',
      reason: 'Run the declared Auggie CLI executable.',
      scope: { executables: [{ kind: 'systemTool', id: 'auggie-cli' }] },
    }],
    optional: [],
  },
  agents: {
    auggie: {
      declaration: {
        title: 'Auggie',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'Auggie CLI',
          executable: {
            binaryName: 'auggie',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@augmentcode/auggie',
              binaryName: 'auggie',
            },
            manual: { kind: 'command' },
            docsUrl: 'https://augmentcode.com',
          },
          auth: {
            support: 'login_terminal',
            loginLaunches: [{ kind: 'primary', args: ['login'] }],
          },
        },
        primary: 'sessions',
        catalog: {
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: { delivery: 'session_dir', materialization: 'copy', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: { user: [['.augment', 'skills'], ['.claude', 'skills'], ['.agents', 'skills']], project: [['.augment', 'skills'], ['.claude', 'skills'], ['.agents', 'skills']] } },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: { externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{ sourceKind: 'auggieHome', contentSearch: true,
            schema: { fields: [
              { kind: 'literal', name: 'kind', value: 'auggieHome' },
              { kind: 'string', name: 'augmentHome', min: 1, nullish: true },
            ] },
            key: { segments: [{ kind: 'literal', value: 'auggieHome' }, { kind: 'field', field: 'augmentHome' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        } },
      },
      factory: createAuggieAgentRuntime,
      preflightSessionControls: AUGGIE_PREFLIGHT_SESSION_CONTROLS,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createAuggieAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'auggieExternalSessionsContribution',
      },
      externalSessions: auggieExternalSessionsContribution,
    },
  },
  systemTools: {
    'auggie-cli': {
      title: 'Auggie CLI',
      executableNames: ['auggie'],
    },
  },
  settings: {
    [AUGGIE_AGENT_SETTINGS_CONTRIBUTION_ID]: AUGGIE_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = AUGGIE_PLUGIN.manifest;
