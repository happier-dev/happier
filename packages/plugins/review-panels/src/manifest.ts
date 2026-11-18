import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import { AGENT_DEFINITION } from './agent/definition.js';
import { createPanelExecutionRunFactory } from './agent/reviews/execution.js';
import { createPanelReviewExecutionProfile } from './agent/reviews/profile.js';

const createPanelRuntime: AgentRuntimeFactory = () => Object.freeze({ executionRuns: createPanelExecutionRunFactory() });

export const PANELS_PLUGIN = definePlugin({
  id: 'happier.review.panels',
  version: '0.0.0',
  displayName: 'Panel reviews',
  description: 'Native single and panel code reviews on the selected Machine.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [{ id: 'panel-workspace', capability: 'filesystem',
    reason: 'Review the admitted workspace with the native reviewer.', scope: { locations: [{ root: 'workspace' }], access: ['read'] } },
  { id: 'panel-process', capability: 'process', reason: 'Run and stop the native reviewer for one admitted review.',
    scope: { executables: [{ kind: 'managedDependency', id: 'review-executable' }], envKeys: ['ROBOREV_DATA_DIR', 'ROBOREV_TELEMETRY_ENABLED', 'NO_COLOR'] } }], optional: [] },
  agents: { panels: { declaration: { title: 'Panel reviewer', runtime: { kind: 'custom' }, primary: 'executionRuns',
    connectedAccounts: [], sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
    capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
      skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' },
      executionRuns: { open: ['create'], checkpoint: false, stop: true },
    }),
  }, factory: createPanelRuntime } },
  executionRunProfiles: { review: createPanelReviewExecutionProfile() },
  resources: { 'review-prompt-resource': { kind: 'prompt', path: './resources/review-prompt.md', contentType: 'text/markdown' } },
  promptAssets: { 'review-prompt': { kind: 'systemPrompt', resource: 'review-prompt-resource', target: { kind: 'agent', agent: 'panels' } } },
  managedDependencies: {
    'review-executable': {
      title: 'Panel review executable',
      executable: 'roborev',
      platforms: ['linux', 'macos', 'windows'],
      architectures: ['x64', 'arm64'],
      sources: [{
        kind: 'githubReleaseBinary',
        installId: 'dep.review-panels',
        repo: 'kenn-io/roborev',
        distTag: 'latest',
        archiveLayout: 'single_executable',
        assetNamePrefix: 'roborev',
        targetByPlatform: {
          'darwin-arm64': 'darwin_arm64',
          'darwin-x64': 'darwin_amd64',
          'win32-arm64': 'windows_arm64',
          'win32-x64': 'windows_amd64',
          'linux-arm64-gnu': 'linux_arm64',
          'linux-arm64-musl': 'linux_arm64',
          'linux-x64-gnu': 'linux_amd64',
          'linux-x64-musl': 'linux_amd64',
        },
      }],
    },
  },
});

export const { manifest: PLUGIN_MANIFEST, activate } = PANELS_PLUGIN;
