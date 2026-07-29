import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { createDeepSecReviewExecutionProfile } from './agent/reviews/profile.js';
import { DEEPSEC_SYSTEM_TOOL_ID } from './agent/reviews/systemTool.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.review.deepsec',
  version: '0.0.0',
  displayName: 'DeepSec review engine',
  description: 'Runs DeepSec as a review and security-review execution engine.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
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
  contributes: {
    agents: [{
      id: 'deepsec',
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
          probe: {
            parser: 'unknown',
            backgroundChecks: 'safe',
            statusArgs: null,
            envVars: ['AI_GATEWAY_API_KEY'],
          },
          loginLaunches: [],
        },
      },
      primary: 'executionRuns',
      capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
    }],
    executionRunProfiles: [
      createDeepSecReviewExecutionProfile('review'),
      createDeepSecReviewExecutionProfile('repository_security_audit'),
    ],
    resources: [{
      id: 'review-prompt-resource',
      kind: 'prompt',
      path: './resources/review-prompt.md',
      contentType: 'text/markdown',
    }, {
      id: 'repository-security-audit-prompt-resource',
      kind: 'prompt',
      path: './resources/repository-security-audit-prompt.md',
      contentType: 'text/markdown',
    }],
    promptAssets: [{
      id: 'review-prompt',
      kind: 'systemPrompt',
      resource: 'review-prompt-resource',
      target: { kind: 'agent', agent: 'deepsec' },
    }, {
      id: 'repository-security-audit-prompt',
      kind: 'systemPrompt',
      resource: 'repository-security-audit-prompt-resource',
      target: { kind: 'agent', agent: 'deepsec' },
    }],
    systemTools: [{ id: DEEPSEC_SYSTEM_TOOL_ID, title: 'DeepSec CLI', executableNames: ['deepsec'] }],
  },
} satisfies PluginManifest;
