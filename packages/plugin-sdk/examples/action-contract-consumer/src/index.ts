import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import {
  triageSourceInspectionInputSchema,
  triageSourceInspectionResultSchema,
  triageSourcesV1,
} from '@happier-dev/triage-sources-protocol/v1';

const plugin = definePlugin({
  id: 'examples.action-contract-consumer',
  version: '0.1.0',
  displayName: 'Document Reviewer Contributor',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
    'prepare-document-review': {
      title: 'Prepare document review',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema: triageSourceInspectionInputSchema,
      resultSchema: triageSourceInspectionResultSchema,
      run: async (input) => ({
        inspected: true,
        entryId: input.entryId,
      }),
    },
  },
  ui: {
    renderers: [{
      id: 'document-review-detail',
      kind: 'declarative',
      root: { kind: 'text', text: 'Document review detail' },
    }],
    translations: [],
  },
  contributesTo: {
    'examples.action-contract-producer': {
      'document-reviewers': {
        'local-document-reviewer': triageSourcesV1.contribute({
          descriptor: { kind: 'issue', label: 'Document review' },
          operations: {
            inspect: triageSourcesV1.operations.inspect.bind('prepare-document-review'),
          },
          surfaces: {
            detail: { renderer: 'document-review-detail' },
          },
        }),
      },
    },
  },
});

export const { manifest, activate } = plugin;
