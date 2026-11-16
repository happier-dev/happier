import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createCustomAcpAgentRuntime } from './agent/runtime/factory.js';

export const CUSTOM_ACP_PLUGIN = definePlugin({
  id: 'happier.agent.custom-acp',
  version: '0.0.0',
  displayName: 'Custom ACP Agent',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
  },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [{
    id: 'custom-acp-home', capability: 'environment',
    reason: 'Give configured ACP agents their admitted native home.',
    scope: { keys: ['HOME'] },
  }], optional: [] },
  agents: {
    'custom-acp': {
      declaration: {
        title: 'Custom ACP Agent',
        connectedAccounts: [],
        runtime: { kind: 'custom' },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        catalog: { vendorResume: { support: 'supported' } },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' },
          sessions: {
            open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true, configuration: true, executionRunContext: { versions: [1] },
          },
        }),
      },
      factory: createCustomAcpAgentRuntime,
      connectedAccountLaunch: {
        // Requester launches need an empty home even without Connected Accounts.
        // Arbitrary configured executables have no declared native files to import.
        stateSharingDescriptor: {
          nativeHome: { environmentKey: 'HOME', defaultRelativePath: '.' },
          providerSupportStatus: 'supported',
          config: { supported: false, modes: ['isolated'], entries: [], unavailableReason: 'not_implemented' },
          state: {
            supported: false, modes: ['isolated'], entries: [], unavailableReason: 'not_implemented',
            symlinkUnavailableDegradePolicy: 'block_continuity',
          },
          authIsolation: { mode: 'materialized_home', secretEntries: [] },
        },
      },
      sessionRunnerFactory: {
        module: './agent/runtime/factory', export: 'createCustomAcpAgentRuntime', runtimeApiVersion: 1,
      },
    },
  },
});

export const PLUGIN_MANIFEST = CUSTOM_ACP_PLUGIN.manifest;
