import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  TriageListInstancesInputV1Schema,
  TriageListInstancesResultV1Schema,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * Compile-only regressions for the public authoring envelope. The actual
 * target and contributor examples remain ordinary copyable plugin source.
 */
if (false) {
  const sources = TriageSourcesContributionProtocolV1;

  sources.contribute({
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
      detail: { renderer: 'triage-detail-card' },
    },
  });

  sources.contribute({
    descriptor: {
      v: 1,
      // @ts-expect-error A contributor descriptor field must retain the protocol schema's declared type.
      purpose: 1,
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
      detail: { renderer: 'triage-detail-card' },
    },
  });

  sources.contribute({
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
    // @ts-expect-error Every required protocol operation role must be bound.
    operations: {
      listInstances: sources.operations.listInstances.bind('list-project-issue-instances'),
      get: sources.operations.get.bind('get-project-issue'),
    },
    surfaces: {
      detail: { renderer: 'triage-detail-card' },
    },
  });

  sources.contribute({
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
    // @ts-expect-error The target's required detail role cannot be omitted.
    surfaces: {},
  });

  // @ts-expect-error A protocol that declares a descriptor schema requires one.
  sources.contribute({
    operations: {
      listInstances: sources.operations.listInstances.bind('list-project-issue-instances'),
      scan: sources.operations.scan.bind('scan-project-issues'),
      get: sources.operations.get.bind('get-project-issue'),
    },
    surfaces: {
      detail: { renderer: 'triage-detail-card' },
    },
  });

  sources.contribute({
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
      detail: { renderer: 'triage-detail-card' },
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
        inputSchema: TriageListInstancesInputV1Schema,
        resultSchema: TriageListInstancesResultV1Schema,
        run: async (input) => ({
          kind: 'failed' as const,
          failure: {
            class: 'unknown' as const,
            code: 'example-not-connected',
            detail: `unsupported protocol v${input.v}`,
          },
        }),
      },
    },
    contributesTo: {
      'examples.triage-source-target': {
        sources: {
          // @ts-expect-error A contribution operation must bind one of this contributor's declared actions.
          'invalid-triage-source': sources.contribute({
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
              listInstances: sources.operations.listInstances.bind('undeclared-action'),
              scan: sources.operations.scan.bind('declared-action'),
              get: sources.operations.get.bind('declared-action'),
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
