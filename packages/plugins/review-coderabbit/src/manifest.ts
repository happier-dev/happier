import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

import { coderabbitReviewDescriptor } from './agent/reviews/descriptor.js';
import { createCodeRabbitReviewExecutionProfile } from './agent/reviews/profile.js';

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.review.coderabbit',
  version: '0.0.0',
  displayName: 'CodeRabbit review engine',
  description: 'Runs CodeRabbit as a review-only execution engine.',
  source: {
    kind: 'package',
    locator: '@happier-dev/plugins-review-coderabbit',
    trustPolicy: 'local_trusted',
    installPolicy: 'link',
    resolvedVersion: '0.0.0',
  },
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends', 'executionRunProfiles'] },
  targets: {},
  capabilities: {
    permissions: [],
    optionalPermissions: [{
      capability: 'reviews.comments.write.direct',
      reason: 'Write approved CodeRabbit review comments directly when the user grants direct-write authority.',
    }],
  },
  contributes: {
    backends: [{
      kindVersion: 1,
      id: coderabbitReviewDescriptor.id,
      agentId: coderabbitReviewDescriptor.id,
      title: 'CodeRabbit',
      engine: { kind: 'custom' },
      capabilities: coderabbitReviewDescriptor.capabilities,
      surfaceHandlers: [],
    }],
    executionRunProfiles: [createCodeRabbitReviewExecutionProfile()],
    systemTools: [{
      toolId: 'coderabbit',
      displayName: 'CodeRabbit',
      source: 'system',
      lookupNames: ['coderabbit'],
    }],
  },
} satisfies PluginManifestV2);
