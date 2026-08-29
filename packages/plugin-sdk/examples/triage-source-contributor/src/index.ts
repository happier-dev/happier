import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import {
  TriageGetInputV1Schema,
  TriageGetResultV1Schema,
  TriageListInstancesInputV1Schema,
  TriageListInstancesResultV1Schema,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TriageScanInputV1Schema,
  TriageScanResultV1Schema,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

const sources = TriageSourcesContributionProtocolV1;

/**
 * This minimal example has no provider connection. Every bound role returns
 * the protocol's own closed failure shape instead of inventing a success.
 */
const unavailable = {
  class: 'unknown' as const,
  code: 'example-not-connected',
  detail: 'This example has no provider connection.',
};

const plugin = definePlugin({
  id: 'examples.triage-source-contributor',
  version: '0.1.0',
  displayName: 'Triage Source Contributor',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
    'list-project-issue-instances': {
      title: 'List project issue instances',
      surfaces: sources.operations.listInstances.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      inputSchema: TriageListInstancesInputV1Schema,
      resultSchema: TriageListInstancesResultV1Schema,
      run: async () => ({ kind: 'failed' as const, failure: unavailable }),
    },
    'scan-project-issues': {
      title: 'Scan project issues',
      surfaces: sources.operations.scan.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      inputSchema: TriageScanInputV1Schema,
      resultSchema: TriageScanResultV1Schema,
      run: async () => ({ kind: 'failed' as const, failure: unavailable }),
    },
    'get-project-issue': {
      title: 'Get project issue',
      surfaces: sources.operations.get.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: TriageGetInputV1Schema,
      resultSchema: TriageGetResultV1Schema,
      run: async (input) => ({
        kind: 'unresolved' as const,
        localRef: input.localRef,
        failure: unavailable,
      }),
    },
  },
  ui: {
    renderers: [
      {
        id: 'triage-detail-card',
        kind: 'declarative',
        root: { kind: 'text', text: 'Triage source detail' },
      },
      {
        id: 'triage-detail-fallback',
        kind: 'declarative',
        root: { kind: 'text', text: 'Triage source detail fallback' },
      },
    ],
    translations: [],
  },
  contributesTo: {
    'examples.triage-source-target': {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        'local-triage-source': sources.contribute({
          descriptor: {
            v: 1,
            purpose: 'project-issues',
            displayName: 'Project issues',
            kinds: [{
              id: 'issue',
              workflowSubject: 'issue',
              displayName: 'Issue',
              pluralDisplayName: 'Issues',
            }],
          },
          operations: {
            listInstances: sources.operations.listInstances.bind('list-project-issue-instances'),
            scan: sources.operations.scan.bind('scan-project-issues'),
            get: sources.operations.get.bind('get-project-issue'),
          },
          surfaces: {
            detail: {
              renderer: 'triage-detail-card',
              fallbackRenderers: ['triage-detail-fallback'],
            },
          },
        }),
      },
    },
  },
});

export const { manifest, activate } = plugin;
