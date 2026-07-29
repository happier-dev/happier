import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_AGENT_OBSERVATION_KEY_MAX_CODE_UNITS_V1,
  EXTERNAL_AGENT_OBSERVATION_MAX_FACTS_PER_LINK_V1,
  EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1,
  ExternalAgentObservationEvidenceV1Schema,
  ExternalAgentObservationLeafFactV1Schema,
  ExternalAgentObservationLinkEvidenceBatchV1Schema,
  ExternalAgentObservationLinkKeyV1Schema,
  ExternalAgentObservationReconcileRequestV1Schema,
  ExternalAgentObservationReconcileResultV1Schema,
  ExternalAgentObservationResourceGroupingV1Schema,
  ExternalAgentObservationResourceDescriptorV1Schema,
  ExternalAgentObservationResourceKeyV1Schema,
  ExternalAgentObservationSnapshotV1Schema,
  ExternalAgentObservationTargetV1Schema,
  attachExternalAgentObservationTargetV1,
} from './externalAgentObservationV1.js';

const target = {
  qualifiedLinkIdentity: {
    v: 1,
    agent: {
      pluginId: 'happier.claude',
      localId: 'claude',
    },
    source: {
      kind: 'claudeConfig',
      contractVersion: 1,
    },
  },
  linkGeneration: 'link-generation-7',
} as const;

describe('external-Agent observation contract', () => {
  it('keeps resource grouping strict and authority-free', () => {
    expect(ExternalAgentObservationResourceGroupingV1Schema.parse({
      resourceKey: 'resource-1',
      linkKey: 'link-1',
    })).toEqual({
      resourceKey: 'resource-1',
      linkKey: 'link-1',
    });
    expect(ExternalAgentObservationResourceGroupingV1Schema.safeParse({
      resourceKey: 'resource-1',
      linkKey: 'link-1',
      changeObservation: 'observe_resource',
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceGroupingV1Schema.safeParse({
      resourceKey: 'resource-1',
      linkKey: 'link-1',
      watchFileChanges: { files: ['/tmp/session.jsonl'] },
    }).success).toBe(false);
  });

  it('requires the canonical qualified link identity and a nonempty string generation', () => {
    expect(ExternalAgentObservationTargetV1Schema.parse(target)).toEqual(target);

    expect(ExternalAgentObservationTargetV1Schema.safeParse({
      qualifiedLinkIdentity: 'claude:machine-1:session-1',
      linkGeneration: 7,
    }).success).toBe(false);
    expect(ExternalAgentObservationTargetV1Schema.safeParse({
      ...target,
      linkGeneration: '   ',
    }).success).toBe(false);
  });

  it('keeps successful-empty evidence distinct from retrieval failure', () => {
    expect(ExternalAgentObservationEvidenceV1Schema.parse({
      target,
      kind: 'successful_empty',
      emptyTurnPhase: 'idle',
      observedAtMs: 100,
      expiresAtMs: 150,
    })).toMatchObject({
      kind: 'successful_empty',
      emptyTurnPhase: 'idle',
    });

    expect(ExternalAgentObservationEvidenceV1Schema.parse({
      target,
      kind: 'retrieval_failed',
      axis: 'turn_phase',
      observedAtMs: 100,
    })).toMatchObject({
      kind: 'retrieval_failed',
      axis: 'turn_phase',
    });

    expect(ExternalAgentObservationEvidenceV1Schema.safeParse({
      target,
      kind: 'turn_phase',
      value: 'working',
      observedAtMs: 100,
      expiresAtMs: 99,
    }).success).toBe(false);
  });

  it('accepts only the six-state, content-free strict snapshot', () => {
    const snapshot = {
      v: 1,
      ...target,
      status: 'waiting',
      observedAtMs: 100,
      expiresAtMs: 150,
      boundary: {
        id: 'turn-17',
        observedAtMs: 90,
      },
    } as const;

    expect(ExternalAgentObservationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(ExternalAgentObservationSnapshotV1Schema.safeParse({
      ...snapshot,
      status: 'busy',
    }).success).toBe(false);
    expect(ExternalAgentObservationSnapshotV1Schema.safeParse({
      ...snapshot,
      transcriptText: 'must never synchronize',
    }).success).toBe(false);
    expect(ExternalAgentObservationSnapshotV1Schema.safeParse({
      ...snapshot,
      externalProvider: { status: 'waiting' },
    }).success).toBe(false);
    expect(ExternalAgentObservationSnapshotV1Schema.safeParse({
      ...snapshot,
      status: 'unknown',
    }).success).toBe(false);
    expect(ExternalAgentObservationSnapshotV1Schema.safeParse({
      ...snapshot,
      expiresAtMs: 99,
    }).success).toBe(false);

    for (const status of [
      'working',
      'waiting',
      'retrying',
      'idle',
      'recentlyActive',
    ] as const) {
      expect(ExternalAgentObservationSnapshotV1Schema.safeParse({
        ...snapshot,
        status,
      }).success).toBe(true);
    }
    expect(ExternalAgentObservationSnapshotV1Schema.safeParse({
      v: 1,
      ...target,
      status: 'unknown',
    }).success).toBe(true);
  });
});

describe('external-Agent leaf observation contract', () => {
  const fact = {
    kind: 'turn_phase',
    value: 'waiting',
    evidenceClass: 'agent_native',
    observedAtMs: 100,
    expiresAtMs: 150,
  } as const;

  it('bounds opaque resource and link keys at the owner-local ceiling', () => {
    const exact = 'k'.repeat(EXTERNAL_AGENT_OBSERVATION_KEY_MAX_CODE_UNITS_V1);
    const over = `${exact}k`;

    expect(ExternalAgentObservationResourceKeyV1Schema.parse(exact)).toBe(exact);
    expect(ExternalAgentObservationLinkKeyV1Schema.parse(exact)).toBe(exact);
    expect(ExternalAgentObservationResourceKeyV1Schema.safeParse(over).success).toBe(false);
    expect(ExternalAgentObservationLinkKeyV1Schema.safeParse(over).success).toBe(false);
    expect(ExternalAgentObservationResourceKeyV1Schema.safeParse('   ').success).toBe(false);

    expect(ExternalAgentObservationResourceDescriptorV1Schema.parse({
      resourceKey: 'endpoint-auth-generation',
      linkKey: 'native-session-17',
      changeObservation: 'observe_resource',
    })).toEqual({
      resourceKey: 'endpoint-auth-generation',
      linkKey: 'native-session-17',
      changeObservation: 'observe_resource',
    });
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      resourceKey: 'endpoint-auth-generation',
      linkKey: 'native-session-17',
      changeObservation: 'observe_resource',
      sessionId: 'must-not-be-leaf-owned',
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      resourceKey: 'endpoint-auth-generation',
      linkKey: 'native-session-17',
    }).success).toBe(false);
  });

  it('requires one truthful change-observation disposition and a file set only for host watching', () => {
    const files = Array.from({ length: 32 }, (_, index) => `/tmp/session-${index}.jsonl`);
    const descriptor = {
      resourceKey: 'file-generation',
      linkKey: 'native-session-17',
      changeObservation: 'watch_file_changes',
      watchFileChanges: { files },
    } as const;

    expect(ExternalAgentObservationResourceDescriptorV1Schema.parse(descriptor))
      .toEqual(descriptor);
    for (const topologyDirectories of [
      ['/tmp/codex/sessions'],
      ['/tmp/codex/sessions', 'C:\\Users\\alice\\.codex\\archived_sessions'],
    ] as const) {
      const descriptorWithTopology = {
        ...descriptor,
        watchFileChanges: {
          files: ['/tmp/codex/sessions/2026/07/25/rollout.jsonl'],
          topologyDirectories,
        },
      };
      expect(ExternalAgentObservationResourceDescriptorV1Schema.parse(
        descriptorWithTopology,
      )).toEqual(descriptorWithTopology);
    }
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      resourceKey: 'file-generation',
      linkKey: 'native-session-17',
      changeObservation: 'watch_file_changes',
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: {
        topologyDirectories: ['/tmp/codex/sessions'],
      },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      resourceKey: 'native-resource',
      linkKey: 'native-session-17',
      changeObservation: 'observe_resource',
      watchFileChanges: { files: ['/tmp/session.jsonl'] },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      resourceKey: 'reconcile-resource',
      linkKey: 'native-session-17',
      changeObservation: 'reconcile_only',
      watchFileChanges: { files: ['/tmp/session.jsonl'] },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: { files: [] },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: { files: [...files, '/tmp/session-over.jsonl'] },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: { files: [files[0], files[0]] },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: { files: ['relative/session.jsonl'] },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: { files: ['/tmp/project/../session.jsonl'] },
    }).success).toBe(false);
    for (const topologyDirectories of [
      [],
      [
        '/tmp/codex/sessions',
        '/tmp/codex/archived_sessions',
        '/tmp/codex/third-topology',
      ],
      ['/tmp/codex/sessions', '/tmp/codex/sessions'],
      ['relative/codex/sessions'],
      ['/tmp/codex/../sessions'],
      ['/tmp/codex/sessions/'],
      ['/'],
      ['C:\\'],
      ['\\\\server\\share'],
    ]) {
      expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
        ...descriptor,
        watchFileChanges: {
          files: ['/tmp/codex/sessions/2026/07/25/rollout.jsonl'],
          topologyDirectories,
        },
      }).success).toBe(false);
    }
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: { files: ['/tmp/session.jsonl'], recursive: true },
    }).success).toBe(false);
    expect(ExternalAgentObservationResourceDescriptorV1Schema.safeParse({
      ...descriptor,
      watchFileChanges: {
        files: ['/tmp/session.jsonl'],
        topologyDirectories: ['/tmp/codex/sessions'],
        directoryReadAccess: true,
      },
    }).success).toBe(false);
  });

  it('represents only the three independent axes and keeps empty distinct from failure', () => {
    const accepted = [
      {
        kind: 'liveness',
        value: 'running',
        evidenceClass: 'process_probe',
        observedAtMs: 100,
        expiresAtMs: 150,
      },
      fact,
      {
        kind: 'recent_activity',
        evidenceClass: 'file_watch',
        observedAtMs: 100,
        expiresAtMs: 150,
      },
      {
        kind: 'completed_boundary',
        boundaryId: 'turn-17',
        evidenceClass: 'qualified_hook',
        observedAtMs: 100,
      },
      {
        kind: 'successful_empty',
        emptyTurnPhase: 'idle',
        evidenceClass: 'reconciliation',
        observedAtMs: 100,
        expiresAtMs: 150,
      },
      {
        kind: 'retrieval_failed',
        axis: 'turn_phase',
        evidenceClass: 'reconciliation',
        observedAtMs: 100,
      },
      {
        kind: 'unsupported',
        axis: 'boundary',
        evidenceClass: 'agent_native',
        observedAtMs: 100,
      },
    ] as const;

    for (const value of accepted) {
      expect(ExternalAgentObservationLeafFactV1Schema.parse(value)).toEqual(value);
    }

    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      kind: 'completed_boundary',
      boundaryId: 'b'.repeat(1_024),
      evidenceClass: 'qualified_hook',
      observedAtMs: 100,
    }).success).toBe(true);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      kind: 'completed_boundary',
      boundaryId: 'b'.repeat(1_025),
      evidenceClass: 'qualified_hook',
      observedAtMs: 100,
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      expiresAtMs: 99,
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      rawPayload: { status: 'waiting' },
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      transcriptText: 'secret',
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      path: '/secret/session.jsonl',
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      processId: 42,
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      target,
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      resourceKey: 'resource-1',
    }).success).toBe(false);
    expect(ExternalAgentObservationLeafFactV1Schema.safeParse({
      ...fact,
      linkKey: 'link-1',
    }).success).toBe(false);
  });

  it('bounds strict link-keyed observer batches and rejects duplicate link keys', () => {
    const makeItem = (index: number) => ({
      linkKey: `link-${index}`,
      facts: [fact],
    });
    const exactItems = Array.from(
      { length: EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1 },
      (_, index) => makeItem(index),
    );

    expect(ExternalAgentObservationLinkEvidenceBatchV1Schema.safeParse({
      items: exactItems,
    }).success).toBe(true);
    expect(ExternalAgentObservationLinkEvidenceBatchV1Schema.safeParse({
      items: [...exactItems, makeItem(exactItems.length)],
    }).success).toBe(false);
    expect(ExternalAgentObservationLinkEvidenceBatchV1Schema.safeParse({
      items: [makeItem(1), makeItem(1)],
    }).success).toBe(false);
    expect(ExternalAgentObservationLinkEvidenceBatchV1Schema.safeParse({
      items: [],
    }).success).toBe(false);

    const exactFacts = Array.from(
      { length: EXTERNAL_AGENT_OBSERVATION_MAX_FACTS_PER_LINK_V1 },
      () => fact,
    );
    expect(ExternalAgentObservationLinkEvidenceBatchV1Schema.safeParse({
      items: [{ linkKey: 'link-1', facts: exactFacts }],
    }).success).toBe(true);
    expect(ExternalAgentObservationLinkEvidenceBatchV1Schema.safeParse({
      items: [{ linkKey: 'link-1', facts: [...exactFacts, fact] }],
    }).success).toBe(false);
  });

  it('keeps resource lifecycle host-owned and empty distinct from per-link failure', () => {
    expect(ExternalAgentObservationLinkEvidenceBatchV1Schema.safeParse({
      state: 'unavailable',
      evidenceClass: 'reconciliation',
      observedAtMs: 100,
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'observation_evidence',
      resourceUnavailable: true,
      outcomes: [],
    }).success).toBe(false);

    expect(ExternalAgentObservationReconcileResultV1Schema.parse({
      purpose: 'observation_evidence',
      outcomes: [
        {
          linkKey: 'link-empty',
          facts: [{
            kind: 'successful_empty',
            emptyTurnPhase: 'idle',
            evidenceClass: 'reconciliation',
            observedAtMs: 100,
            expiresAtMs: 150,
          }],
        },
        {
          linkKey: 'link-failed',
          facts: [{
            kind: 'retrieval_failed',
            axis: 'turn_phase',
            evidenceClass: 'reconciliation',
            observedAtMs: 100,
          }],
        },
      ],
    })).toMatchObject({
      purpose: 'observation_evidence',
      outcomes: [
        { linkKey: 'link-empty', facts: [{ kind: 'successful_empty' }] },
        { linkKey: 'link-failed', facts: [{ kind: 'retrieval_failed' }] },
      ],
    });
  });

  it('requires an explicit reconciliation purpose and validates both result branches', () => {
    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      linkKeys: ['link-1'],
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      purpose: 'observation_evidence',
      linkKeys: ['link-1'],
    }).success).toBe(true);
    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      purpose: 'resource_descriptors',
      linkKeys: ['link-1'],
    }).success).toBe(true);

    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      outcomes: [{ linkKey: 'link-1', facts: [fact] }],
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'observation_evidence',
      outcomes: [{ linkKey: 'link-1', facts: [fact] }],
    }).success).toBe(true);
    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'resource_descriptors',
      outcomes: [
        {
          kind: 'described',
          descriptor: {
            resourceKey: 'resource-1',
            linkKey: 'link-1',
            changeObservation: 'observe_resource',
          },
        },
        {
          kind: 'unavailable',
          linkKey: 'link-2',
        },
      ],
    }).success).toBe(true);
    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        linkKey: 'link-1',
        descriptor: {
          resourceKey: 'resource-1',
          linkKey: 'link-1',
          changeObservation: 'observe_resource',
        },
      }],
    }).success).toBe(false);
  });

  it('bounds unique resource-wide reconciliation requests and results', () => {
    const exactKeys = Array.from(
      { length: EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1 },
      (_, index) => `link-${index}`,
    );
    const exactOutcomes = exactKeys.map((linkKey) => ({ linkKey, facts: [fact] }));

    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      purpose: 'observation_evidence',
      linkKeys: exactKeys,
    }).success).toBe(true);
    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      purpose: 'observation_evidence',
      linkKeys: [...exactKeys, 'one-too-many'],
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      purpose: 'observation_evidence',
      linkKeys: ['duplicate', 'duplicate'],
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      purpose: 'observation_evidence',
      linkKeys: [],
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileRequestV1Schema.safeParse({
      purpose: 'observation_evidence',
      linkKeys: ['link-1'],
      sessionId: 'target-data-is-forbidden',
    }).success).toBe(false);

    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'observation_evidence',
      outcomes: exactOutcomes,
    }).success).toBe(true);
    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'observation_evidence',
      outcomes: [...exactOutcomes, {
        linkKey: 'one-too-many',
        facts: [fact],
      }],
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'observation_evidence',
      outcomes: [exactOutcomes[0], exactOutcomes[0]],
    }).success).toBe(false);
    expect(ExternalAgentObservationReconcileResultV1Schema.safeParse({
      purpose: 'observation_evidence',
      outcomes: [],
    }).success).toBe(false);
  });

  it('adds the host target through one constructor while preserving reducer evidence', () => {
    expect(attachExternalAgentObservationTargetV1(target, [
      {
        kind: 'liveness',
        value: 'running',
        evidenceClass: 'process_probe',
        observedAtMs: 100,
        expiresAtMs: 150,
      },
      fact,
    ])).toEqual([
      {
        target,
        kind: 'liveness',
        value: 'running',
        evidenceClass: 'process_probe',
        observedAtMs: 100,
        expiresAtMs: 150,
      },
      {
        target,
        ...fact,
      },
    ]);
  });
});
