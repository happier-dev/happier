import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import {
  triageSourceInspectionInputSchema,
  triageSourceInspectionResultSchema,
  triageSourcesV1,
} from '@happier-dev/triage-sources-protocol/v1';

const plugin = definePlugin({
  id: 'examples.triage-source-contributor',
  version: '0.1.0',
  displayName: 'Triage Source Contributor',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
    'inspect-triage-source': {
      title: 'Inspect Triage source',
      surfaces: ['plugin'],
      inputSchema: triageSourceInspectionInputSchema,
      resultSchema: triageSourceInspectionResultSchema,
      run: async (input) => ({
        inspected: true,
        entryId: input.entryId,
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
      sources: {
        'local-triage-source': triageSourcesV1.contribute({
          descriptor: { kind: 'issue', label: 'Project issues' },
          operations: {
            inspect: triageSourcesV1.operations.inspect.bind('inspect-triage-source'),
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
