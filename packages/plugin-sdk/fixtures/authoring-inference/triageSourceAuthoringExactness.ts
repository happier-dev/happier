import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  triageSourceInspectionInputSchema,
  triageSourceInspectionResultSchema,
  triageSourcesV1,
} from '@happier-dev/triage-sources-protocol/v1';

/**
 * Compile-only regressions for the public authoring envelope. The actual
 * target and contributor examples remain ordinary copyable plugin source.
 */
if (false) {
  triageSourcesV1.contribute({
    // @ts-expect-error A contributor descriptor must retain the protocol schema's string label.
    descriptor: { kind: 'issue', label: 1 },
    operations: {
      inspect: triageSourcesV1.operations.inspect.bind('inspect-triage-source'),
    },
    surfaces: {
      detail: { renderer: 'triage-detail-card' },
    },
  });

  triageSourcesV1.contribute({
    descriptor: { kind: 'issue', label: 'Project issues' },
    operations: {
      inspect: triageSourcesV1.operations.inspect.bind('inspect-triage-source'),
    },
    // @ts-expect-error The target's required detail role cannot be omitted.
    surfaces: {},
  });

  // @ts-expect-error A protocol that declares a descriptor schema requires one.
  triageSourcesV1.contribute({
    operations: {
      inspect: triageSourcesV1.operations.inspect.bind('inspect-triage-source'),
    },
    surfaces: {
      detail: { renderer: 'triage-detail-card' },
    },
  });

  triageSourcesV1.contribute({
    descriptor: { kind: 'issue', label: 'Project issues' },
    operations: {
      inspect: triageSourcesV1.operations.inspect.bind('inspect-triage-source'),
    },
    surfaces: {
      // @ts-expect-error An author cannot bind a surface role absent from the target protocol.
      unexpected: { renderer: 'triage-detail-card' },
    },
  });

  definePlugin({
    id: 'examples.invalid-triage-source-contributor',
    version: '0.1.0',
    actions: {
      'declared-action': {
        title: 'Declared action',
        execution: { target: 'daemon' },
        surfaces: ['plugin'],
        inputSchema: triageSourceInspectionInputSchema,
        resultSchema: triageSourceInspectionResultSchema,
        run: async (input) => ({
          inspected: true,
          entryId: input.entryId,
        }),
      },
    },
    contributesTo: {
      'examples.triage-source-target': {
        sources: {
          // @ts-expect-error A contribution operation must bind one of this contributor's declared actions.
          'invalid-triage-source': triageSourcesV1.contribute({
            descriptor: { kind: 'issue', label: 'Project issues' },
            operations: {
              inspect: triageSourcesV1.operations.inspect.bind('undeclared-action'),
            },
            surfaces: {
              detail: { renderer: 'triage-detail-card' },
            },
          }),
        },
      },
    },
  });
}

export {};
