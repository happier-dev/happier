import { projectAgentCapabilitiesV2FromDefinition, type PluginHostOwnedAgentDeclaration } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { DROID_ACP_COMMAND } from './agent/preflight.js';
import { DROID_TERMINAL_CONTRIBUTION } from './agent/terminal/contribution.js';
import { DROID_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

export const DROID_PLUGIN = definePlugin({
  id: 'happier.agent.droid', version: '0.0.0', displayName: 'Factory Droid',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{
    id: 'droid-process', capability: 'process', reason: 'Run the declared Factory Droid CLI executable.',
    scope: { envKeys: ['FACTORY_API_KEY'], executables: [{ kind: 'systemTool', id: DROID_ACP_COMMAND.toolId }] },
  }], optional: [] },
  agents: { droid: {
    declaration: {
      title: { key: 'agentInput.agent.droid', fallback: 'Factory Droid' },
      description: { key: 'profiles.aiBackend.droidSubtitleExperimental', fallback: 'Factory Droid (experimental)' },
      runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'droid-cli' }, args: [...DROID_ACP_COMMAND.args] }, definition: { modelConfigOptionId: 'model', mcp: { policy: 'pass_through' } } },
      cli: {
        displayName: 'Factory Droid CLI', executable: { binaryName: 'droid', knownUserBinDirSuffixes: ['.local/bin'], sourcePreference: 'system-first', systemCommandResolutionStrategy: 'path-first' },
        install: {
          managed: null,
          manual: {
            kind: 'vendor_recipe',
            // Factory publishes a POSIX shell installer and a separate Windows
            // PowerShell installer; both are vendor-owned, so Happier runs no
            // package manager of its own.
            recipes: {
              darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://app.factory.ai/cli | sh'] }],
              linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://app.factory.ai/cli | sh'] }],
              win32: [{
                cmd: 'powershell',
                args: [
                  '-NoProfile',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-Command',
                  'Invoke-RestMethod https://app.factory.ai/cli/windows | Invoke-Expression',
                ],
              }],
            },
          },
          guideUrl: 'https://docs.factory.ai/droid-cli/overview',
          docsUrl: 'https://docs.factory.ai/droid-cli/cli-reference',
        },
        auth: { support: 'login_terminal', environmentVariables: ['FACTORY_API_KEY'], missingCredentialState: 'unknown', loginLaunches: [{ kind: 'primary', args: [], initialInput: '/login' }] },
      },
      primary: 'sessions',
      catalog: { vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume } },
      // The host keeps Session V1 canonical and exposes the separately
      // versioned detached Run context through the same declarative ACP core.
      capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp'],
          cancel: true,
          configuration: true,
          executionRunContext: { versions: [1] },
        },
      }),
    } satisfies PluginHostOwnedAgentDeclaration,
    terminal: DROID_TERMINAL_CONTRIBUTION,
  } },
  systemTools: { 'droid-cli': { title: 'Factory Droid CLI', executableNames: ['droid'] } },
  ui: { translations: DROID_UI_TRANSLATION_BUNDLES },
});

export const PLUGIN_MANIFEST = DROID_PLUGIN.manifest;
