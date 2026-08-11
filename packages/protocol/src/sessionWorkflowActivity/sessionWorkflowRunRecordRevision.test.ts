import { describe, expect, it } from 'vitest';

import {
  bumpWorkflowRunRecordRevision,
  isWorkflowRunSnapshotMaterialChange,
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowRunSnapshotV1,
} from './index.js';

function snapshot(overrides: Partial<SessionWorkflowRunSnapshotV1> = {}): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: 'wf_demo',
    backendId: 'claude',
    title: 'Demo workflow',
    status: 'active',
    recordRevision: '1',
    updatedAt: 1000,
    totalAgents: 2,
    completedAgents: 1,
    phases: [{ id: 'phase:1', title: 'Research', order: 1, agentIds: ['a1', 'a2'] }],
    agents: [
      { id: 'a1', title: 'web_search', status: 'complete', phaseIndex: 1, updatedAt: 900 },
      { id: 'a2', title: 'reader', status: 'active', phaseIndex: 1, updatedAt: 950 },
    ],
    ...overrides,
  };
}

describe('bumpWorkflowRunRecordRevision', () => {
  it('starts at 1 for a first material publication', () => {
    expect(bumpWorkflowRunRecordRevision(undefined, true)).toBe('1');
  });

  it('increments monotonically on material change', () => {
    expect(bumpWorkflowRunRecordRevision('1', true)).toBe('2');
    expect(bumpWorkflowRunRecordRevision('41', true)).toBe('42');
  });

  it('does not bump on a non-material change', () => {
    expect(bumpWorkflowRunRecordRevision('7', false)).toBe('7');
  });

  it('treats a malformed previous revision as zero', () => {
    expect(bumpWorkflowRunRecordRevision('not-a-number', true)).toBe('1');
    expect(bumpWorkflowRunRecordRevision('', true)).toBe('1');
  });
});

describe('isWorkflowRunSnapshotMaterialChange', () => {
  it('treats a first snapshot (no previous) as material', () => {
    expect(isWorkflowRunSnapshotMaterialChange(undefined, snapshot())).toBe(true);
  });

  it('does not treat display-ordering timestamp or recordRevision changes as material', () => {
    const prev = snapshot();
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ updatedAt: 99999 }))).toBe(false);
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ recordRevision: '999' }))).toBe(false);
    expect(isWorkflowRunSnapshotMaterialChange(
      prev,
      snapshot({ agents: [
        { id: 'a1', title: 'web_search', status: 'complete', phaseIndex: 1, updatedAt: 1 },
        { id: 'a2', title: 'reader', status: 'active', phaseIndex: 1, updatedAt: 2 },
      ] }),
    )).toBe(false);
  });

  it('does not treat agent reordering with identical content as material', () => {
    const prev = snapshot();
    const reordered = snapshot({ agents: [...prev.agents].reverse() });
    expect(isWorkflowRunSnapshotMaterialChange(prev, reordered)).toBe(false);
  });

  it('treats run status / title / id changes as material', () => {
    const prev = snapshot();
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ status: 'complete' }))).toBe(true);
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ title: 'Renamed' }))).toBe(true);
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ workflowToolUseId: 'toolu_9' }))).toBe(true);
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ sourceRevision: 'uuid_99' }))).toBe(true);
  });

  it('treats phase list/order/title/membership changes as material', () => {
    const prev = snapshot();
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({
      phases: [{ id: 'phase:1', title: 'Renamed phase', order: 1, agentIds: ['a1', 'a2'] }],
    }))).toBe(true);
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({
      phases: [{ id: 'phase:1', title: 'Research', order: 1, agentIds: ['a1'] }],
    }))).toBe(true);
  });

  it('treats agent add/remove and agent field changes as material', () => {
    const prev = snapshot();
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({
      agents: [
        { id: 'a1', title: 'web_search', status: 'complete', phaseIndex: 1, updatedAt: 900 },
        { id: 'a2', title: 'reader', status: 'failed', phaseIndex: 1, updatedAt: 950 },
      ],
    }))).toBe(true); // a2 status active -> failed
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({
      agents: [
        ...prev.agents,
        { id: 'a3', title: 'writer', status: 'pending', phaseIndex: 1, updatedAt: 980 },
      ],
    }))).toBe(true); // agent added
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({
      agents: [
        { id: 'a1', title: 'web_search', status: 'complete', phaseIndex: 1, resultPreview: 'found it', updatedAt: 900 },
        { id: 'a2', title: 'reader', status: 'active', phaseIndex: 1, updatedAt: 950 },
      ],
    }))).toBe(true); // resultPreview added
  });

  it('treats aggregate count and lifecycle timestamp changes as material', () => {
    const prev = snapshot();
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ completedAgents: 2 }))).toBe(true);
    expect(isWorkflowRunSnapshotMaterialChange(prev, snapshot({ completedAt: 5000 }))).toBe(true);
  });
});

/**
 * An agent becoming OPENABLE is a material change.
 *
 * The sidechain id arrives after the agent already exists — the transcript is imported once its
 * sidecar file appears — so it typically lands on a tick where nothing else moved. A material-change
 * table that cannot see it leaves the committed record and the published headline describing an
 * agent with no transcript, and the row stays unopenable until some unrelated change happens to
 * rewrite the record.
 */
describe('isWorkflowRunSnapshotMaterialChange — the open target', () => {
  it('treats an agent gaining its imported sidechain as material', () => {
    const before = snapshot();
    const after = snapshot({
      agents: [
        { id: 'a1', title: 'web_search', status: 'complete', phaseIndex: 1, updatedAt: 900 },
        {
          id: 'a2',
          title: 'reader',
          status: 'active',
          phaseIndex: 1,
          updatedAt: 950,
          sidechainId: 'workflow_agent_sidechain:toolu_wf:a2',
        },
      ],
    });

    expect(isWorkflowRunSnapshotMaterialChange(before, after)).toBe(true);
  });

  it('treats one agent’s sidechain moving to another agent as material', () => {
    const withA1 = snapshot({
      agents: [
        { id: 'a1', title: 'web_search', status: 'complete', phaseIndex: 1, updatedAt: 900, sidechainId: 'sc:1' },
        { id: 'a2', title: 'reader', status: 'active', phaseIndex: 1, updatedAt: 950 },
      ],
    });
    const withA2 = snapshot({
      agents: [
        { id: 'a1', title: 'web_search', status: 'complete', phaseIndex: 1, updatedAt: 900 },
        { id: 'a2', title: 'reader', status: 'active', phaseIndex: 1, updatedAt: 950, sidechainId: 'sc:1' },
      ],
    });

    expect(isWorkflowRunSnapshotMaterialChange(withA1, withA2)).toBe(true);
  });

  it('stays immaterial when the same sidechain is republished', () => {
    const agents = [
      { id: 'a1', title: 'web_search', status: 'complete' as const, phaseIndex: 1, updatedAt: 900 },
      { id: 'a2', title: 'reader', status: 'active' as const, phaseIndex: 1, updatedAt: 950, sidechainId: 'sc:1' },
    ];

    expect(isWorkflowRunSnapshotMaterialChange(
      snapshot({ agents }),
      snapshot({ agents, updatedAt: 2000 }),
    )).toBe(false);
  });
});
