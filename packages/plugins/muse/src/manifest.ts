import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { MUSE_ACCOUNT_SERVICE_ID, MUSE_NATIVE_PURPOSE, museAccountDescriptor, museNativeConnectedAccountPurpose } from './connectedAccounts/declarations.js';
import { museAccountNativeRuntimeDefinition } from './connectedAccounts/museAccountNativeRuntime.js';
import { museStateSharingDescriptor } from './agent/auth/services/stateSharing.js';
import { MUSE_PREFLIGHT_SESSION_CONTROLS } from './agent/catalog.js';
import { museCliSupport, MUSE_DIRECT_AUTH_ENV_KEYS, MUSE_LAUNCH_ENV_KEYS } from './agent/cli.js';
import { MUSE_AGENT } from './agent/definition.js';
import { createMuseAgentRuntime } from './agent/runtime.js';

/** Native execution and account operations run on the selected Machine. */
export const MUSE_PLUGIN = definePlugin({
  id: 'happier.agent.muse',
  version: '0.0.0',
  displayName: 'Muse',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/icon.png', contentType: 'image/png' },
    'i18n-en': { kind: 'asset', path: 'assets/i18n/en.json', contentType: 'application/json' },
  },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'muse-workspace', capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the Muse process working directory.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }, {
      id: 'muse-process', capability: 'process',
      reason: 'Launch the Muse CLI through the host execution service.',
      scope: { executables: [{ kind: 'systemTool', id: 'muse-cli' }], envKeys: [...MUSE_LAUNCH_ENV_KEYS] },
    }, {
      id: 'muse-account-network', capability: 'network',
      reason: 'Connect the selected Meta account for Muse.',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://auth.meta.com' },
        { kind: 'fixedOrigin', origin: 'https://api.meta.ai' },
      ], methods: ['POST'] },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    [MUSE_ACCOUNT_SERVICE_ID]: {
      declaration: museAccountDescriptor,
      runtime: museAccountNativeRuntimeDefinition,
    },
  },
  agents: {
    muse: {
      declaration: {
        title: 'Muse',
        runtime: { kind: 'custom' },
        cli: museCliSupport,
        sessionModeDescriptor: MUSE_AGENT.sessionModeDescriptor,
        primary: 'sessions',
        catalog: {
          vendorResume: { support: MUSE_AGENT.core.resume.vendorResume },
          agentCliSystemTool: { toolId: 'muse-cli' },
        },
        connectedAccounts: [museNativeConnectedAccountPurpose],
        capabilities: projectAgentCapabilitiesV2FromDefinition(MUSE_AGENT.core, {
          sessions: { open: ['create'], delivery: ['newTurn'], cancel: false },
        }),
      },
      factory: createMuseAgentRuntime,
      connectedAccountLaunch: {
        stateSharingDescriptor: museStateSharingDescriptor,
        environmentUses: MUSE_DIRECT_AUTH_ENV_KEYS.map(environmentKey => ({ purpose: MUSE_NATIVE_PURPOSE, environmentKey })),
        environmentUnsetUses: MUSE_DIRECT_AUTH_ENV_KEYS.map(environmentKey => ({ purpose: MUSE_NATIVE_PURPOSE, environmentKey })),
      },
      preflightSessionControls: MUSE_PREFLIGHT_SESSION_CONTROLS,
      cliSessionCommand: {
        sessionRuntimeId: MUSE_AGENT.id,
        accountSettingsAgentId: MUSE_AGENT.id,
        buildSessionOptions: () => ({ ok: true, options: {} }),
      },
      sessionRunnerFactory: { module: './agent/runtime', export: 'createMuseAgentRuntime', runtimeApiVersion: 1 },
    },
  },
  systemTools: { 'muse-cli': { title: 'Muse CLI', executableNames: ['muse'] } },
  hooks: {},
  settings: {},
  ui: { translations: [{ locale: 'en', resourceId: 'i18n-en' }] },
});

export const PLUGIN_MANIFEST = MUSE_PLUGIN.manifest;
