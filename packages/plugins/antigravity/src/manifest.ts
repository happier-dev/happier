import {
  BackendSurfaceOperationCatalogV1,
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
  type PluginAgentSettingsContributionV1,
} from '@happier-dev/plugin-sdk/manifest';

import { AGENT_DEFINITION } from './agent/definition.js';
import {
  ANTIGRAVITY_AGENT_CLI_RUNTIME,
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_BACKEND_ID,
  ANTIGRAVITY_RUNTIME_CORE,
  ANTIGRAVITY_TERMINAL_RUNTIME_BACKEND_MODE,
} from './agent/install/cliRuntime.js';
import {
  ANTIGRAVITY_LOCALHARNESS_COMMAND,
  ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_DESCRIPTOR,
  ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
} from './agent/localharness/installable.js';
import { ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

type BackendSurfaceHandlerV1 = NonNullable<PluginAgentContributionV2['surfaceHandlers']>[number];
type AntigravityManualInstallRecipe = Readonly<{
  cmd: string;
  args: readonly string[];
  requiresAdmin?: boolean;
  note?: string | null;
}>;
type AntigravityAgentCliRuntime = Omit<typeof ANTIGRAVITY_AGENT_CLI_RUNTIME, 'manualInstallRecipes'> & Readonly<{
  kindVersion: 1;
  manualInstallRecipes: Readonly<{
    darwin: readonly AntigravityManualInstallRecipe[];
    linux: readonly AntigravityManualInstallRecipe[];
    win32: readonly AntigravityManualInstallRecipe[];
  }>;
}>;

function cloneManualInstallRecipe(recipe: AntigravityManualInstallRecipe): AntigravityManualInstallRecipe {
  return {
    cmd: recipe.cmd,
    args: [...recipe.args],
    requiresAdmin: recipe.requiresAdmin,
    note: recipe.note,
  };
}

function toAntigravityAgentCliRuntime(): AntigravityAgentCliRuntime {
  return {
    ...ANTIGRAVITY_AGENT_CLI_RUNTIME,
    kindVersion: 1,
    manualInstallRecipes: {
      darwin: ANTIGRAVITY_AGENT_CLI_RUNTIME.manualInstallRecipes.darwin.map(cloneManualInstallRecipe),
      linux: ANTIGRAVITY_AGENT_CLI_RUNTIME.manualInstallRecipes.linux.map(cloneManualInstallRecipe),
      win32: ANTIGRAVITY_AGENT_CLI_RUNTIME.manualInstallRecipes.win32.map(cloneManualInstallRecipe),
    },
  };
}

function terminalLaunchSurfaceHandler(): BackendSurfaceHandlerV1 {
  return {
    surfaceApiVersion: 1,
    id: 'antigravity.terminalRuntime.launch',
    kind: 'terminalRuntime',
    operation: BackendSurfaceOperationCatalogV1.terminalRuntime.launch,
    support: 'supported',
    handler: {
      target: 'daemon',
      exportName: 'resolveAntigravityTerminalRuntimeLaunch',
    },
    staticMetadata: {
      topology: 'exclusive',
      attachStrategy: 'terminal_host',
      transcript: 'terminal_mirror',
      structuredTranscript: false,
      providerNativeStatusLine: false,
      printMode: false,
      runtimeCore: ANTIGRAVITY_RUNTIME_CORE,
      runtimeSurface: 'terminalRuntime',
      backendMode: ANTIGRAVITY_TERMINAL_RUNTIME_BACKEND_MODE,
    },
  } satisfies BackendSurfaceHandlerV1;
}

const ANTIGRAVITY_MANIFEST_AGENT_CLI_RUNTIME = Object.freeze(toAntigravityAgentCliRuntime());

type AntigravityPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    managedDependencies: ReadonlyArray<typeof ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_DESCRIPTOR>;
    hooks: NonNullable<NonNullable<PluginManifestV2['contributes']>['hooks']>;
    agentSettings: ReadonlyArray<PluginAgentSettingsContributionV1>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.antigravity',
  version: '0.0.0',
  displayName: 'antigravity',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:antigravity'],
  uses: ['agents', 'hooks', 'managedDependencies'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: ANTIGRAVITY_AGENT_ID,
        catalogAgentId: ANTIGRAVITY_AGENT_ID,
        iconAgentId: ANTIGRAVITY_AGENT_ID,
        settingsBackendId: ANTIGRAVITY_BACKEND_ID,
        display: {
          name: 'Antigravity',
          subtitle: 'Terminal-first Antigravity CLI',
          tags: [],
        },
        agentCliRuntime: ANTIGRAVITY_MANIFEST_AGENT_CLI_RUNTIME,
        auth: {
          machineLoginSupport: AGENT_DEFINITION.localCli.supportKind,
        },
        session: {
          storage: 'host',
          resume: {
            supportLevel: 'unsupported',
          },
          handoff: {
            supportLevel: 'unsupported',
          },
          terminalRuntime: {
            supported: true,
            topology: 'exclusive',
            attachStrategy: 'terminal_host',
          },
          sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities,
        },
        tools: {
          delivery: AGENT_DEFINITION.core.tools.delivery,
          support: AGENT_DEFINITION.core.tools.support,
        },
        ui: {
          modeSelection: 'none',
          modelSelection: AGENT_DEFINITION.modelConfig.supportsSelection ? 'supported' : 'unsupported',
        },
        ownedBackendIds: [ANTIGRAVITY_BACKEND_ID],
        launch: {
          binaryName: ANTIGRAVITY_LOCALHARNESS_COMMAND,
          args: [],
          resolutionPolicy: 'managed-installable',
        },
        install: {
          docsUrl: ANTIGRAVITY_AGENT_CLI_RUNTIME.docsUrl,
          managedInstallBehavior: 'vendor_recipe_requires_consent',
          managedInstall: {
            installableKey: ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
            command: ANTIGRAVITY_LOCALHARNESS_COMMAND,
          },
          manualInstall: undefined,
          sourcePreference: 'managed-first',
        },
        runtime: { kind: 'custom' },
        runtimeOwner: {
          selectedOwner: 'plugin_engine',
          acceptedBy: '2026-06-19-antigravity-runtime-unification',
        },
        capabilities: {
          executionRun: { supported: true },
          session: {
            media: {
              acceptsImageInput: { supported: false },
              emitsSessionMedia: { supported: false },
              nativeImageGeneration: { supported: false },
            },
          },
        },
        surfaceHandlers: [terminalLaunchSurfaceHandler()],
      },
    ],
    managedDependencies: [ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_DESCRIPTOR],
    agentSettings: [ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION],
    hooks: [
      {
        id: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: ANTIGRAVITY_BACKEND_ID },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveAntigravityDaemonSpawnPrerequisites',
        },
      },
    ],
  },
} satisfies AntigravityPluginManifestV2);
