import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import { AGENT_DEFINITION } from './agent/definition.js';
import { createRoborevExecutionRunFactory } from './agent/reviews/execution.js';
import { createRoborevReviewExecutionProfile } from './agent/reviews/profile.js';

const createRoborevRuntime: AgentRuntimeFactory = () => Object.freeze({ executionRuns: createRoborevExecutionRunFactory() });

export const ROBOREV_PLUGIN = definePlugin({
  id: 'happier.review.roborev',
  version: '0.0.0',
  displayName: 'roborev',
  description: 'Native single and panel code reviews on the selected Machine.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [{ id: 'roborev-workspace', capability: 'filesystem',
    reason: 'Review the admitted workspace with the native reviewer.', scope: { locations: [{ root: 'workspace' }], access: ['read'] } },
  { id: 'roborev-process', capability: 'process', reason: 'Run and stop the native reviewer for one admitted review.',
    scope: { executables: [{ kind: 'managedDependency', id: 'review-executable' }], envKeys: ['ROBOREV_DATA_DIR', 'ROBOREV_TELEMETRY_ENABLED', 'ROBOREV_CLAUDE_PROXY_TOKEN', 'NO_COLOR'] } }], optional: [] },
  agents: { roborev: { declaration: { title: 'roborev', runtime: { kind: 'custom' }, primary: 'executionRuns',
    runnerAgents: [
      { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, providerProtocols: ['openai-responses'] },
      { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, providerProtocols: ['anthropic'] },
    ],
    runnerSelection: 'perMember',
    connectedAccounts: [], sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
    capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
      skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' },
      // Native v0.75.0 reviews use a read-only Codex sandbox or Claude read
      // tools; the per-run data directory owns the global unsafe settings.
      executionRuns: { open: ['create'], checkpoint: false, stop: true, workspaceWrites: 'deny' },
    }),
  }, factory: createRoborevRuntime } },
  executionRunProfiles: { review: createRoborevReviewExecutionProfile() },
  resources: { 'review-prompt-resource': { kind: 'prompt', path: './resources/review-prompt.md', contentType: 'text/markdown' } },
  promptAssets: { 'review-prompt': { kind: 'systemPrompt', resource: 'review-prompt-resource', target: { kind: 'agent', agent: 'roborev' } } },
  managedDependencies: {
    'review-executable': {
      title: 'roborev executable',
      executable: 'roborev',
      platforms: ['linux', 'macos', 'windows'],
      architectures: ['x64', 'arm64'],
      sources: [{
        kind: 'githubReleaseBinary',
        installId: 'dep.review-roborev',
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

export const { manifest: PLUGIN_MANIFEST, activate } = ROBOREV_PLUGIN;
