import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import {
  TriageGetInputV1Schema,
  TriageGetResultV1Schema,
  TriageListInstancesInputV1Schema,
  TriageListInstancesResultV1Schema,
  TriageScanInputV1Schema,
  TriageScanResultV1Schema,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

const unavailable = {
  class: 'unknown' as const,
  code: 'example-not-connected',
  detail: 'This copyable example has no provider connection.',
};

const sources = TriageSourcesContributionProtocolV1;

const plugin = definePlugin({
  id: 'examples.action-contract-consumer',
  version: '0.1.0',
  displayName: 'Document Reviewer Contributor',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
    'list-document-review-instances': {
      title: 'List document review instances',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema: TriageListInstancesInputV1Schema,
      resultSchema: TriageListInstancesResultV1Schema,
      run: async () => ({ kind: 'failed' as const, failure: unavailable }),
    },
    'scan-document-reviews': {
      title: 'Scan document reviews',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema: TriageScanInputV1Schema,
      resultSchema: TriageScanResultV1Schema,
      run: async () => ({ kind: 'failed' as const, failure: unavailable }),
    },
    'get-document-review': {
      title: 'Get document review',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema: TriageGetInputV1Schema,
      resultSchema: TriageGetResultV1Schema,
      run: async () => ({ kind: 'failed' as const, failure: unavailable }),
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
        'local-document-reviewer': sources.contribute({
          descriptor: {
            v: 1,
            purpose: 'document-review',
            displayName: 'Document review',
            kinds: [{
              id: 'document-review',
              workflowSubject: 'issue',
              displayName: 'Document review',
              pluralDisplayName: 'Document reviews',
            }],
          },
          operations: {
            listInstances: sources.operations.listInstances.bind('list-document-review-instances'),
            scan: sources.operations.scan.bind('scan-document-reviews'),
            get: sources.operations.get.bind('get-document-review'),
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
