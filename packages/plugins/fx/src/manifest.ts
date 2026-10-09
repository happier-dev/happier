import { projectAgentCapabilitiesV2FromDefinition, type PluginHostOwnedAgentDeclaration } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { FX_ACP_COMMAND } from './agent/preflight.js';
import { FX_TERMINAL_CONTRIBUTION } from './agent/terminal/contribution.js';
import { FX_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

export const FX_PLUGIN = definePlugin({
  id: 'happier.agent.fx', version: '0.0.0', displayName: 'FX',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{
    id: 'fx-process', capability: 'process', reason: 'Run the declared FX CLI executable.',
    scope: { executables: [{ kind: 'systemTool', id: FX_ACP_COMMAND.toolId }] },
  }], optional: [] },
  agents: { fx: {
    declaration: {
      title: { key: 'agentInput.agent.fx', fallback: 'FX' },
      description: { key: 'profiles.aiBackend.fxSubtitleExperimental', fallback: 'FX coding agent (experimental)' },
      runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fx-cli' }, args: [...FX_ACP_COMMAND.args] }, definition: { modelConfigOptionId: 'model', permissionModeMapping: { default: null, 'read-only': 'ask', 'safe-yolo': 'code' }, mcp: { policy: 'pass_through' } } },
      cli: {
        displayName: 'FX CLI', executable: { binaryName: 'fx', knownUserBinDirSuffixes: ['.local/bin'], sourcePreference: 'system-first', systemCommandResolutionStrategy: 'path-first' },
        install: { managed: null, manual: { kind: 'vendor_recipe', recipes: { darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://fx.sh/setup.sh | bash'] }], linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://fx.sh/setup.sh | bash'] }] } }, guideUrl: 'https://github.com/vercel-labs/fx', docsUrl: 'https://github.com/vercel-labs/fx' },
        auth: { support: 'login_terminal', loginLaunches: [{ kind: 'primary', args: ['login'] }] },
      },
      primary: 'sessions',
      catalog: { vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume } },
      // Resume-only: `fx acp` answers `session/list`, so the host composes its
      // own generic ACP session-listing producer for this declaration. The
      // source promises discovery for resume-in-Happier and nothing else — no
      // link, transcript, follow, takeover or writer-safety claim — so this
      // plugin contributes no External Sessions runtime of its own.
      surfaces: {
        externalSession: {
          sources: [{
            sourceKind: 'fxAcpSessionList',
            resumeOnly: true,
            schema: { fields: [{ kind: 'literal', name: 'kind', value: 'fxAcpSessionList' }] },
            key: { segments: [{ kind: 'literal', value: 'fxAcpSessionList' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
      // The host keeps Session V1 canonical and exposes the separately
      // versioned detached Run context through the same declarative ACP core.
      capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp'],
          cancel: true,
          configuration: true,
          executionRunContext: { versions: [1] },
        },
      }),
    } satisfies PluginHostOwnedAgentDeclaration,
    terminal: FX_TERMINAL_CONTRIBUTION,
  } },
  systemTools: { 'fx-cli': { title: 'FX CLI', executableNames: ['fx'] } },
  ui: { translations: FX_UI_TRANSLATION_BUNDLES },
});

export const PLUGIN_MANIFEST = FX_PLUGIN.manifest;
