import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createCodeRabbitExecutionRunFactory } from './agent/reviews/nativeRun.js';
import { createCodeRabbitReviewExecutionProfile } from './agent/reviews/profile.js';
import { CODERABBIT_SYSTEM_TOOL_ID } from './agent/reviews/systemTool.js';

const createCodeRabbitRuntime: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: createCodeRabbitExecutionRunFactory(),
});

export const CODERABBIT_PLUGIN = definePlugin({
  id: 'happier.review.coderabbit',
  version: '0.0.0',
  displayName: 'CodeRabbit review engine',
  description: 'Runs CodeRabbit as a review-only execution engine.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'coderabbit-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted execution-run workspace as the CodeRabbit process working directory.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'coderabbit-process',
      capability: 'process',
      reason: 'Launch the user-installed CodeRabbit review CLI for an admitted review run.',
      scope: {
        executables: [{ kind: 'systemTool', id: CODERABBIT_SYSTEM_TOOL_ID }],
        envKeys: [
          'CODERABBIT_API_KEY',
          'HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS',
          'HAPPIER_CODERABBIT_REVIEW_RATE_LIMIT_MAX_ATTEMPTS',
          'HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES',
        ],
      },
    }],
    optional: [],
  },
  agents: {
    coderabbit: {
      declaration: {
        title: 'CodeRabbit',
        runtime: { kind: 'custom' },
        cli: {
          executable: {
            binaryName: 'coderabbit',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: null,
            manual: { kind: 'command' },
            guideUrl: null,
            docsUrl: null,
          },
          auth: {
            support: 'status_only',
            environmentVariables: ['CODERABBIT_API_KEY'],
            missingCredentialState: 'unknown',
            loginLaunches: [],
          },
        },
        primary: 'executionRuns',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, { executionRuns: { open: ['create'], checkpoint: false, stop: true } }),
      },
      factory: createCodeRabbitRuntime,
    },
  },
  executionRunProfiles: {
    review: createCodeRabbitReviewExecutionProfile(),
  },
  resources: {
    'review-prompt-resource': {
      kind: 'prompt',
      path: './resources/review-prompt.md',
      contentType: 'text/markdown',
    },
  },
  promptAssets: {
    'review-prompt': {
      kind: 'systemPrompt',
      resource: 'review-prompt-resource',
      target: { kind: 'agent', agent: 'coderabbit' },
    },
  },
  systemTools: {
    [CODERABBIT_SYSTEM_TOOL_ID]: {
      title: 'CodeRabbit CLI',
      executableNames: ['coderabbit'],
    },
  },
});

export const PLUGIN_MANIFEST = CODERABBIT_PLUGIN.manifest;
