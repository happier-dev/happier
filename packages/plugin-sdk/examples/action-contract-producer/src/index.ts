import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  PUBLIC_TOOLCHAIN_COMPATIBILITY_V1,
  type BrowserActionContributionInput,
  type BrowserTargetContributionInput,
} from '@happier-dev/plugin-sdk/browser';
import type { PluginRequestInterceptor } from '@happier-dev/plugin-sdk/http';
import { triageSourcesV1 } from '@happier-dev/triage-sources-protocol/v1';

const documentReviewBrowserTarget = {
  title: 'Document review',
  url: 'https://review.example.test/documents',
  profile: 'session',
} satisfies Omit<BrowserTargetContributionInput, 'id'>;

const openDocumentReviewBrowserAction = {
  title: 'Open document review',
  action: 'open-document-review',
  target: 'document-review',
  placement: 'toolbar',
} satisfies Omit<BrowserActionContributionInput, 'id'>;

const documentReviewRequestPolicy: PluginRequestInterceptor = async (request) => ({
  decision: 'continue',
  request,
});

const plugin = definePlugin({
  id: 'examples.action-contract-producer',
  version: '0.1.0',
  displayName: 'Document Reviewer Target',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
    'open-document-review': {
      title: 'Open document review',
      surfaces: ['plugin'],
      run: async () => null,
    },
  },
  browserTargets: {
    'document-review': documentReviewBrowserTarget,
  },
  browserActions: {
    'open-document-review-surface': openDocumentReviewBrowserAction,
  },
  requestInterceptors: {
    'document-review-api-policy': {
      declaration: {
        origins: ['https://api.example.test'],
        methods: ['GET'],
      },
      interceptor: documentReviewRequestPolicy,
    },
  },
  contributionPoints: {
    'document-reviewers': triageSourcesV1.point(),
  },
});

export const { manifest, activate } = plugin;
