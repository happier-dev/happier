import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
  type PluginMcpContributesV1,
  type PluginSystemToolContributionV1,
} from '@happier-dev/plugin-sdk';
import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/protocol';
import type { PluginAgentContributionV2, PluginHookContributionV2 } from '@happier-dev/protocol';

import { AGENT_DEFINITION } from './agent/definition.js';

const CLAUDE_BACKEND_ID = 'claude';
const SURFACE_OPERATIONS = BackendSurfaceOperationCatalogV1;
type BackendSurfaceHandlerV1 = NonNullable<PluginBackendContributionV2['surfaceHandlers']>[number];
type ClaudeAgentCliRuntime = NonNullable<PluginAgentContributionV2['agentCliRuntime']>;
type ClaudeManualInstallRecipe = NonNullable<
  NonNullable<ClaudeAgentCliRuntime['manualInstallRecipes']>['darwin']
>[number];
type ClaudeSourceManualInstallRecipe = NonNullable<
  NonNullable<typeof AGENT_DEFINITION.agentCliRuntime.manualInstallRecipes>['darwin']
>[number];

function cloneManualInstallRecipe(recipe: ClaudeSourceManualInstallRecipe): ClaudeManualInstallRecipe {
  return {
    cmd: recipe.cmd,
    args: [...recipe.args],
    requiresAdmin: recipe.requiresAdmin,
    note: recipe.note,
  };
}

function cloneManualInstallRecipes(
  recipes: typeof AGENT_DEFINITION.agentCliRuntime.manualInstallRecipes,
): ClaudeAgentCliRuntime['manualInstallRecipes'] {
  if (!recipes) return recipes;

  return {
    darwin: recipes.darwin?.map(cloneManualInstallRecipe),
    linux: recipes.linux?.map(cloneManualInstallRecipe),
    win32: recipes.win32?.map(cloneManualInstallRecipe),
  };
}

function surfaceHandler(params: Readonly<{
  id: string;
  kind: 'externalSession' | 'handoff';
  operation: string;
  exportName: string;
}>): BackendSurfaceHandlerV1 {
  return {
    surfaceApiVersion: 1,
    id: params.id,
    kind: params.kind,
    operation: params.operation,
    handler: { target: 'daemon' as const, exportName: params.exportName },
  } as BackendSurfaceHandlerV1;
}

function toClaudeAgentCliRuntime(): ClaudeAgentCliRuntime {
  const runtime = AGENT_DEFINITION.agentCliRuntime;

  return {
    ...runtime,
    kindVersion: 1,
    knownUserBinDirSuffixes: runtime.knownUserBinDirSuffixes == null
      ? runtime.knownUserBinDirSuffixes
      : [...runtime.knownUserBinDirSuffixes],
    managedInstall: runtime.managedInstall,
    manualInstallRecipes: cloneManualInstallRecipes(runtime.manualInstallRecipes),
  };
}

const CLAUDE_AGENT_CLI_RUNTIME = Object.freeze(toClaudeAgentCliRuntime());
const CLAUDE_INSTALL_DOCS_URL =
  AGENT_DEFINITION.agentCliRuntime.installGuideUrl
  ?? AGENT_DEFINITION.agentCliRuntime.docsUrl
  ?? undefined;
const CLAUDE_CONNECTED_SERVICE_IDS = [
  ...(AGENT_DEFINITION.core.connectedServices?.supportedServiceIds ?? []),
];
const CLAUDE_MACOS_SECURITY_SYSTEM_TOOL = Object.freeze({
  toolId: 'claude.macos.security',
  displayName: 'macOS Keychain security',
  source: 'system',
  lookupNames: ['security'],
  defaultArgs: [],
} satisfies PluginSystemToolContributionV1);

type ClaudePluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    backends: ReadonlyArray<PluginBackendContributionV2>;
    hooks: ReadonlyArray<PluginHookContributionV2>;
    mcp: PluginMcpContributesV1;
    systemTools: ReadonlyArray<PluginSystemToolContributionV1>;
  }>;
}>;

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.claude',
  version: '0.0.0',
  displayName: 'claude',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['agents', 'backends', 'mcp', 'sessionHooks', 'terminalHost'] },
  targets: {},
  capabilities: {
    permissions: [
      {
        capability: 'terminal.host.control',
        reason: 'Run Claude through the host-owned terminal multiplexer substrate.',
      },
      {
        capability: 'events.session.subscribe',
        reason: 'Observe host-delivered Claude terminal lifecycle events for session runtime finality.',
      },
      {
        capability: 'session.hooks.control',
        reason: 'Create authenticated Claude session hook bridges for unified terminal runtime events.',
      },
    ],
  },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: CLAUDE_BACKEND_ID,
        catalogAgentId: CLAUDE_BACKEND_ID,
        iconAgentId: CLAUDE_BACKEND_ID,
        settingsBackendId: CLAUDE_BACKEND_ID,
        display: {
          name: 'Claude',
          subtitle: 'Claude Code',
          tags: [],
        },
        agentCliRuntime: CLAUDE_AGENT_CLI_RUNTIME,
        install: {
          docsUrl: CLAUDE_INSTALL_DOCS_URL,
        },
        auth: {
          machineLoginSupport: AGENT_DEFINITION.localCli.supportKind,
          connectedServiceCompatibility: CLAUDE_CONNECTED_SERVICE_IDS,
        },
        session: {
          storage: AGENT_DEFINITION.core.sessionStorage.direct ? 'direct' : 'host',
          resume: {
            supportLevel: AGENT_DEFINITION.core.resume.vendorResume,
            vendorResumeIdField: AGENT_DEFINITION.core.resume.vendorResumeIdField ?? undefined,
          },
          handoff: {
            supportLevel: AGENT_DEFINITION.core.handoff.vendorStateTransfer,
          },
          terminalRuntime: {
            supported: AGENT_DEFINITION.core.localControl?.supported ?? false,
            topology: AGENT_DEFINITION.core.localControl?.topology,
            attachStrategy: AGENT_DEFINITION.core.localControl?.attachStrategy,
          },
          sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities,
        },
        ui: {
          modeSelection: AGENT_DEFINITION.sessionModesKind,
          modelSelection: AGENT_DEFINITION.modelConfig.supportsSelection ? 'supported' : 'unsupported',
        },
        ownedBackendIds: [CLAUDE_BACKEND_ID],
      },
    ],
    backends: [
      {
        kindVersion: 1,
        id: CLAUDE_BACKEND_ID,
        agentId: CLAUDE_BACKEND_ID,
        engine: { kind: 'custom' },
        surfaceHandlers: [
          surfaceHandler({
            id: 'claude.externalSession.resolveSource',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveSource,
            exportName: 'resolveClaudeExternalSessionSource',
          }),
          surfaceHandler({
            id: 'claude.externalSession.listCandidates',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.listCandidates,
            exportName: 'listClaudeExternalSessionCandidates',
          }),
          surfaceHandler({
            id: 'claude.externalSession.getActivity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.getActivity,
            exportName: 'getClaudeExternalSessionActivity',
          }),
          surfaceHandler({
            id: 'claude.externalSession.pageTranscript',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.pageTranscript,
            exportName: 'pageClaudeExternalSessionTranscript',
          }),
          surfaceHandler({
            id: 'claude.externalSession.readAfterTranscript',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.readAfterTranscript,
            exportName: 'readClaudeExternalSessionAfterTranscript',
          }),
          surfaceHandler({
            id: 'claude.externalSession.resolveFollowTranscriptPath',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveFollowTranscriptPath,
            exportName: 'resolveClaudeExternalSessionFollowTranscriptPath',
          }),
          surfaceHandler({
            id: 'claude.externalSession.acquireFollowLease',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.acquireFollowLease,
            exportName: 'acquireClaudeExternalSessionFollowLease',
          }),
          surfaceHandler({
            id: 'claude.externalSession.resolveLinkIdentity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkIdentity,
            exportName: 'resolveClaudeExternalSessionLinkIdentity',
          }),
          surfaceHandler({
            id: 'claude.externalSession.resolveLinkedIdentity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkedIdentity,
            exportName: 'resolveLinkedClaudeExternalSessionIdentity',
          }),
          surfaceHandler({
            id: 'claude.externalSession.resolveTakeoverLaunch',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveTakeoverLaunch,
            exportName: 'resolveClaudeExternalSessionTakeoverLaunch',
          }),
          surfaceHandler({
            id: 'claude.handoff.exportBundle',
            kind: 'handoff',
            operation: SURFACE_OPERATIONS.handoff.exportBundle,
            exportName: 'exportClaudeSessionBundle',
          }),
          surfaceHandler({
            id: 'claude.handoff.importBundle',
            kind: 'handoff',
            operation: SURFACE_OPERATIONS.handoff.importBundle,
            exportName: 'importClaudeSessionBundle',
          }),
        ],
        capabilities: {
          executionRun: { supported: true },
          session: {
            media: {
              emitsSessionMedia: {
                supported: true,
                mediaKinds: ['image'],
                sources: ['tool-output'],
                storage: 'session-media-file',
              },
              nativeImageGeneration: { supported: false },
            },
          },
        },
      },
    ],
    hooks: [
      {
        id: 'backend.resolveRuntimePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'backend',
        filters: { backendId: CLAUDE_BACKEND_ID },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveClaudeDaemonSpawnPrerequisites',
        },
      },
      {
        id: 'spawn.augmentEnv',
        hookApiVersion: 1,
        category: 'augmentation',
        scope: 'daemon',
        filters: { backendId: CLAUDE_BACKEND_ID },
        executionKind: 'augment',
        handler: {
          target: 'plugin',
          exportName: 'augmentClaudeDaemonSpawnEnv',
        },
      },
    ],
    mcp: {
      servers: [],
      discoveryProviders: [
        {
          id: 'claude.config',
          kind: 'mcp.discoveryProvider',
          version: '1.0.0',
          capabilityGates: [],
          permissionGates: [],
          redaction: 'none',
          hidden: false,
          providerId: CLAUDE_BACKEND_ID,
        },
      ],
    },
    systemTools: [CLAUDE_MACOS_SECURITY_SYSTEM_TOOL],
  },
} satisfies ClaudePluginManifestV2);
