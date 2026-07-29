import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { createCodeRabbitReviewExecutionProfile } from './agent/reviews/profile.js';
import { CODERABBIT_SYSTEM_TOOL_ID } from './agent/reviews/systemTool.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.review.coderabbit',
  version: '0.0.0',
  displayName: 'CodeRabbit review engine',
  description: 'Runs CodeRabbit as a review-only execution engine.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
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
  contributes: {
    agents: [{
      id: 'coderabbit',
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
          probe: {
            parser: 'unknown',
            backgroundChecks: 'safe',
            statusArgs: null,
            envVars: ['CODERABBIT_API_KEY'],
          },
          loginLaunches: [],
        },
      },
      primary: 'executionRuns',
      capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
    }],
    executionRunProfiles: [createCodeRabbitReviewExecutionProfile()],
    resources: [{
      id: 'review-prompt-resource',
      kind: 'prompt',
      path: './resources/review-prompt.md',
      contentType: 'text/markdown',
    }],
    promptAssets: [{
      id: 'review-prompt',
      kind: 'systemPrompt',
      resource: 'review-prompt-resource',
      target: { kind: 'agent', agent: 'coderabbit' },
    }],
    systemTools: [{ id: CODERABBIT_SYSTEM_TOOL_ID, title: 'CodeRabbit CLI', executableNames: ['coderabbit'] }],
  },
} satisfies PluginManifest;
