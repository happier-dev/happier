import { projectAgentCapabilitiesV2FromDefinition, type PluginHostOwnedAgentDeclaration } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { AGENT_DEFINITION } from './agent/definition.js';
import { CODEBUDDY_ACP_RUNTIME_DECLARATION } from './agent/acp/runtimeDeclaration.js';
import { CODEBUDDY_TERMINAL_SURFACE } from './agent/terminal/contribution.js';
import { CODEBUDDY_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { CODEBUDDY_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const { id: settingsId, ...settingsDeclaration } = CODEBUDDY_AGENT_SETTINGS_CONTRIBUTION;

export const CODEBUDDY_PLUGIN = definePlugin({
  id: 'happier.agent.codebuddy', version: '0.0.0', displayName: 'CodeBuddy',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{
    id: 'codebuddy-process', capability: 'process', reason: 'Run the declared CodeBuddy CLI executable.',
    scope: { envKeys: ['CODEBUDDY_API_KEY'], executables: [{ kind: 'systemTool', id: 'codebuddy-cli' }] },
  }], optional: [] },
  agents: { codebuddy: {
    declaration: {
      title: { key: 'agentInput.agent.codebuddy', fallback: 'CodeBuddy' },
      description: { key: 'profiles.aiBackend.codebuddySubtitleExperimental', fallback: 'CodeBuddy Code CLI (experimental)' },
      runtime: CODEBUDDY_ACP_RUNTIME_DECLARATION,
      cli: {
        displayName: 'CodeBuddy Code CLI',
        executable: { binaryName: 'codebuddy', sourcePreference: 'system-first', systemCommandResolutionStrategy: 'path-first' },
        install: {
          managed: { kind: 'managed_package', packageName: '@tencent-ai/codebuddy-code', binaryName: 'codebuddy' },
          manual: { kind: 'command' },
          guideUrl: 'https://www.codebuddy.ai/docs/cli/quickstart',
          docsUrl: 'https://www.codebuddy.ai/docs/cli/acp',
        },
        auth: {
          support: 'login_terminal',
          environmentVariables: ['CODEBUDDY_API_KEY'],
          missingCredentialState: 'unknown',
          loginLaunches: [{ kind: 'primary', args: [], initialInput: '/login\r' }],
        },
      },
      primary: 'sessions',
      catalog: { vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume } },
      capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        sessions: {
          open: ['create', 'resume'], delivery: ['newTurn', 'followUp'], cancel: true,
          configuration: true, executionRunContext: { versions: [1] },
        },
      }),
    } satisfies PluginHostOwnedAgentDeclaration,
    terminal: CODEBUDDY_TERMINAL_SURFACE,
  } },
  systemTools: { 'codebuddy-cli': { title: 'CodeBuddy Code CLI', executableNames: ['codebuddy'] } },
  settings: { [settingsId]: settingsDeclaration },
  ui: { translations: CODEBUDDY_UI_TRANSLATION_BUNDLES },
});
export const PLUGIN_MANIFEST = CODEBUDDY_PLUGIN.manifest;
