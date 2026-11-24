import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import { AGENT_DEFINITION } from './agent/definition.js';
import { createClawpatchExecutionRunFactory } from './agent/reviews/execution.js';
import { reviewPresentationResource } from './ui/reviewPresentation.js';

const createRuntime: AgentRuntimeFactory = () => Object.freeze({ executionRuns: createClawpatchExecutionRunFactory() });

export const CLAWPATCH_PLUGIN = definePlugin({
  id: 'happier.review.clawpatch', version: '0.0.0', displayName: 'clawpatch',
  description: 'Review repository slices with native evidence and resumable engine state.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'clawpatch-workspace', capability: 'filesystem', reason: 'Read the admitted repository with clawpatch.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] } },
    { id: 'clawpatch-process', capability: 'process', reason: 'Run the managed clawpatch reviewer.',
      scope: { executables: [{ kind: 'managedDependency', id: 'review-executable' }] } },
  ], optional: [] },
  agents: { clawpatch: { declaration: { title: 'clawpatch', primary: 'executionRuns', runtime: { kind: 'custom' },
    sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
    catalog: { vendorResume: { support: 'unsupported' } },
    capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
      skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' },
      executionRuns: { open: ['create'], checkpoint: false, stop: true, workspaceWrites: 'deny' },
    }),
  }, factory: createRuntime } },
  executionRunProfiles: { review: {
    id: 'review', intent: 'review', title: 'clawpatch', description: 'Hunt for defects across repository slices.',
    promptAsset: 'review-prompt', compatibleAgents: ['clawpatch'],
    actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
    defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
    optionsSchema: { type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', title: 'Native provider' },
      model: { type: 'string', title: 'Model' },
      featureIds: { type: 'array', title: 'Selected slice IDs', items: { type: 'string' } },
    } },
    metadata: { reviewScopes: ['repository'] },
  } },
  ui: {
    views: [
      { id: 'finding-evidence', container: 'reviewFinding', target: { kind: 'app' }, renderer: 'review-content-renderer',
        title: { key: 'plugins.reviewClawpatch.finding', fallback: 'clawpatch evidence' } },
      { id: 'engine-options', container: 'reviewEngineOptions', target: { kind: 'app' }, renderer: 'review-content-renderer',
        title: { key: 'plugins.reviewClawpatch.options', fallback: 'clawpatch options' } },
      { id: 'review-overview', container: 'appPage', target: { kind: 'app', context: 'review' }, renderer: 'review-content-renderer',
        title: { key: 'plugins.reviewClawpatch.page', fallback: 'clawpatch' } },
    ],
    renderers: [{ id: 'review-content-renderer', kind: 'declarative',
      root: { kind: 'text', text: { key: 'plugins.reviewClawpatch.unavailable', fallback: 'clawpatch evidence is unavailable.' } },
      documentSource: { kind: 'resource', resourceId: 'review-presentation' } }],
  },
  resources: {
    'review-presentation': reviewPresentationResource,
    'review-prompt-resource': { kind: 'prompt', path: './resources/review-prompt.md', contentType: 'text/markdown' },
  },
  promptAssets: { 'review-prompt': { kind: 'systemPrompt', resource: 'review-prompt-resource', target: { kind: 'agent', agent: 'clawpatch' } } },
  managedDependencies: {
    'review-executable': {
      title: 'clawpatch executable', executable: 'clawpatch',
      platforms: ['linux', 'macos', 'windows'], architectures: ['x64', 'arm64'],
      sources: [{ kind: 'managedJavaScriptPackage', installId: 'dep.review-clawpatch',
        packageName: 'clawpatch', version: '0.8.4' }],
    },
  },
});

export const PLUGIN_MANIFEST = CLAWPATCH_PLUGIN.manifest;
export const activate = CLAWPATCH_PLUGIN.activate;
