import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';

import { runReviewRefresh } from './reviewAction.js';

export const PRODUCTION_HOSTED_REFERENCE_PLUGIN = definePlugin({
  id: 'examples.production-hosted-reference',
  version: '0.1.0',
  displayName: 'Production Hosted Review Reference',
  description: 'Production-shaped hosted-web reference with lifecycle, offline, and error handling.',
  ...(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.host.enginesHappier
    ? { engines: { happier: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.host.enginesHappier } }
    : {}),
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/daemon.js' },
  brand: { iconResourceId: 'brand-icon' },
  hostAccess: { required: [], optional: [] },
  actions: {
    'refresh-review': {
      title: 'Refresh review status',
      description: 'Checks the current review status through the declared Action.',
      scopes: ['global'],
      surfaces: ['cli', 'ui'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      resultSchema: {
        type: 'object',
        properties: {
          ready: { type: 'boolean' },
        },
        required: ['ready'],
        additionalProperties: false,
      },
      run: runReviewRefresh,
    },
  },
  resources: {
    'brand-icon': {
      source: 'packaged',
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
    'review-guide': {
      source: 'packaged',
      kind: 'template',
      path: 'resources/review-guide.md',
      contentType: 'text/markdown',
    },
  },
  ui: {
    views: [{
      id: 'review-dashboard',
      container: 'appPage',
      target: { kind: 'app' },
      renderer: 'review-hosted',
      fallbackRenderers: ['review-unavailable'],
      title: 'Review dashboard',
    }],
    renderers: [
      {
        id: 'review-hosted',
        kind: 'hostedWeb',
        source: {
          kind: 'artifact',
          artifact: 'review-hosted',
        },
        requiredHostMethods: ['context', 'executeAction', 'readResource', 'openSurface'],
      },
      {
        id: 'review-unavailable',
        kind: 'declarative',
        root: {
          kind: 'text',
          text: 'The review dashboard is unavailable.',
          tone: 'muted',
        },
      },
    ],
    translations: [],
  },
});
