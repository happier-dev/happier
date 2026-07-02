import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

import { deepsecReviewDescriptor } from './agent/reviews/descriptor.js';
import { createDeepSecReviewExecutionProfile } from './agent/reviews/profile.js';

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.review.deepsec',
  version: '0.0.0',
  displayName: 'DeepSec review engine',
  description: 'Runs DeepSec as a review and security-review execution engine.',
  source: {
    kind: 'package',
    locator: '@happier-dev/plugins-review-deepsec',
    trustPolicy: 'local_trusted',
    installPolicy: 'link',
    resolvedVersion: '0.0.0',
  },
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends', 'executionRunProfiles'] },
  targets: {},
  capabilities: {
    permissions: [{
      capability: 'env',
      reason: 'Read AI_GATEWAY_API_KEY for DeepSec readiness checks and AI Gateway-backed review execution.',
      scope: 'AI_GATEWAY_API_KEY',
    }],
    optionalPermissions: [{
      capability: 'reviews.comments.write.direct',
      reason: 'Write approved DeepSec review comments directly when the user grants direct-write authority.',
    }],
  },
  contributes: {
    backends: [{
      kindVersion: 1,
      id: deepsecReviewDescriptor.id,
      agentId: deepsecReviewDescriptor.id,
      title: 'DeepSec',
      engine: { kind: 'custom' },
      capabilities: deepsecReviewDescriptor.capabilities,
      surfaceHandlers: [],
    }],
    executionRunProfiles: [
      createDeepSecReviewExecutionProfile('review'),
      createDeepSecReviewExecutionProfile('repository_security_audit'),
    ],
    systemTools: [{
      toolId: 'deepsec',
      displayName: 'DeepSec',
      source: 'system',
      lookupNames: ['deepsec'],
    }],
  },
} satisfies PluginManifestV2);
