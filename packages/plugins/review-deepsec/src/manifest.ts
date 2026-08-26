import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createDeepSecExecutionRunFactory } from './agent/reviews/execution.js';
import { createDeepSecReviewExecutionProfile } from './agent/reviews/profile.js';
import { DEEPSEC_SYSTEM_TOOL_ID } from './agent/reviews/systemTool.js';

const createDeepSecRuntime: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: createDeepSecExecutionRunFactory(),
});

export const DEEPSEC_PLUGIN = definePlugin({
  id: 'happier.review.deepsec',
  version: '0.0.0',
  displayName: 'DeepSec review engine',
  description: 'Runs DeepSec as a review and security-review execution engine.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'deepsec-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the DeepSec process working directory.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'ai-gateway-api-key',
      capability: 'environment',
      reason: 'Read AI_GATEWAY_API_KEY for DeepSec readiness and admitted review execution.',
      scope: { keys: ['AI_GATEWAY_API_KEY'] },
    }, {
      id: 'deepsec-process',
      capability: 'process',
      reason: 'Launch the user-installed DeepSec CLI for an admitted review run.',
      scope: {
        executables: [{ kind: 'systemTool', id: DEEPSEC_SYSTEM_TOOL_ID }],
        envKeys: ['AI_GATEWAY_API_KEY'],
      },
    }],
    optional: [],
  },
  agents: {
    deepsec: {
      declaration: {
        title: 'DeepSec',
        runtime: { kind: 'custom' },
        cli: {
          executable: {
            binaryName: 'deepsec',
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
            environmentVariables: ['AI_GATEWAY_API_KEY'],
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
      factory: createDeepSecRuntime,
    },
  },
  executionRunProfiles: {
    review: createDeepSecReviewExecutionProfile('review'),
    'repository-security-audit': createDeepSecReviewExecutionProfile('repository_security_audit'),
  },
  resources: {
    'review-prompt-resource': {
      kind: 'prompt',
      path: './resources/review-prompt.md',
      contentType: 'text/markdown',
    },
    'repository-security-audit-prompt-resource': {
      kind: 'prompt',
      path: './resources/repository-security-audit-prompt.md',
      contentType: 'text/markdown',
    },
  },
  promptAssets: {
    'review-prompt': {
      kind: 'systemPrompt',
      resource: 'review-prompt-resource',
      target: { kind: 'agent', agent: 'deepsec' },
    },
    'repository-security-audit-prompt': {
      kind: 'systemPrompt',
      resource: 'repository-security-audit-prompt-resource',
      target: { kind: 'agent', agent: 'deepsec' },
    },
  },
  systemTools: {
    [DEEPSEC_SYSTEM_TOOL_ID]: {
      title: 'DeepSec CLI',
      executableNames: ['deepsec'],
    },
  },
});

export const PLUGIN_MANIFEST = DEEPSEC_PLUGIN.manifest;
