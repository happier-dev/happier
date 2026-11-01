import { describe, expect, it } from 'vitest';

import {
  addSessionTeamsToShareStatementV1,
  createSessionOwnerMetadataV1,
  projectSessionOwnerCompatibilityViewV1,
  projectSessionSharedMetadataV1,
  readSessionModesMetadata,
  SessionOwnerModeCatalogV1Schema,
  SessionOwnerModeCatalogV2Schema,
  SessionSharedMetadataV1Schema,
} from './sessionMetadataSchemasV1.js';
import { SessionPermissionApprovalReviewerClaimV1Schema } from '../permissions/v1.js';

describe('Team share statement', () => {
  it('survives the rewrite every metadata writer performs, and stays out of owner-private metadata', () => {
    const metadata = addSessionTeamsToShareStatementV1(
      addSessionTeamsToShareStatementV1({ path: '/work', host: 'holder' }, ['team-a']), ['team-b', 'team-a']);
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata });
    expect(sharedMetadata.teamShareStatementV1).toEqual({ v: 1, teamIds: ['team-a', 'team-b'] });
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Expected owner metadata');
    expect(JSON.stringify(owner.ownerMetadata)).not.toContain('team-a');
    const rewritten = projectSessionOwnerCompatibilityViewV1({ sharedMetadata, ownerMetadata: owner.ownerMetadata });
    expect(projectSessionSharedMetadataV1({ metadata: rewritten }).teamShareStatementV1).toEqual(sharedMetadata.teamShareStatementV1);
  });

  it('commits nothing when the Team is already stated', () => {
    const metadata = addSessionTeamsToShareStatementV1({}, ['team-a']);
    expect(addSessionTeamsToShareStatementV1(metadata, ['team-a'])).toBe(metadata);
  });
});

describe('retained metadata projection', () => {
  it('projects the hidden retained linked-session descriptor without losing its native Agent state', () => {
    const descriptor = { v: 1, agentId: 'example-agent', agent: { nativeState: { keep: true } } };
    const link = { v: 1, agentId: 'example-agent', machineId: 'machine', remoteSessionId: 'native',
      source: { kind: 'plugin-owned-source', contractVersion: 1, pluginCursor: { keep: true } },
      runtimeDescriptorV1: descriptor };
    const expected = createSessionOwnerMetadataV1({ metadata: { externalSessionV1: link } });
    expect(expected.ok).toBe(true);
    const retained = { ...link, runtimeDescriptorV1: { ...descriptor, retired: true } };
    expect(createSessionOwnerMetadataV1({ metadata: { externalSessionV1: retained } }, 'stored')).toEqual(expected);
    expect(createSessionOwnerMetadataV1({ metadata: { externalSessionV1: retained } }).ok).toBe(false);
    expect(createSessionOwnerMetadataV1({ metadata: { externalSessionV1: { ...retained,
      runtimeDescriptorV1: { ...descriptor, v: 2, retired: true } } } }, 'stored').ok).toBe(false);
  });
  it('projects an unsigned retained reviewer display claim without accepting invalid origin or scope', () => {
    const claim = { version: 1, origin: 'approvalReviewer', decision: 'approved', scope: 'request' };
    const request = { tool: 'Tool', createdAt: 10, completedAt: 11, status: 'approved', permissionDecisionClaimV1: claim };
    const expected = { v: 1, publicAgentState: { completedRequests: { request } } };
    expect(projectSessionSharedMetadataV1({ metadata: {}, agentState: { completedRequests: { request } } })).toEqual(expected);
    const project = (value: unknown) => projectSessionSharedMetadataV1({ metadata: {},
      agentState: { completedRequests: { request: { ...request, permissionDecisionClaimV1: value } } } });
    expect(project({ ...claim, retired: true })).toEqual(expected);
    expect(SessionPermissionApprovalReviewerClaimV1Schema.safeParse({ ...claim, retired: true }).success).toBe(false);
    for (const invalid of [{ ...claim, origin: 'presentUser', retired: true }, { ...claim, scope: 'session', retired: true }]) {
      expect(project(invalid)).not.toHaveProperty('publicAgentState.completedRequests.request.permissionDecisionClaimV1');
    }
  });

  it('keeps opaque Agent recovery data while projecting retained descriptor and legacy goal annotations', () => {
    const metadata = { runtimeDescriptorV1: { v: 1, agentId: 'codex',
      agent: { providerSessionId: 'thread', opaqueNativeState: { retired: true } } },
      sessionGoalV1: { objective: 'Goal', updatedAt: 10 } };
    const expected = createSessionOwnerMetadataV1({ metadata });
    expect(expected.ok).toBe(true);
    const retained = { runtimeDescriptorV1: { ...metadata.runtimeDescriptorV1, retired: true },
      sessionGoalV1: { ...metadata.sessionGoalV1, retired: true } };
    expect(createSessionOwnerMetadataV1({ metadata: retained }, 'stored')).toEqual(expected);
    expect(createSessionOwnerMetadataV1({ metadata: retained }).ok).toBe(false);
    expect(createSessionOwnerMetadataV1({ metadata: { ...retained,
      sessionGoalV1: { ...retained.sessionGoalV1, updatedAt: -1 } } }, 'stored').ok).toBe(false);
  });

  it('reads current and predecessor mode catalogs while fresh mode facts stay closed', () => {
    const catalog = { v: 2, agentId: 'codex', updatedAt: 10, currentModeId: null,
      availableModes: [{ id: 'plan', name: 'Plan' }] };
    const retained = { ...catalog, retired: true,
      availableModes: [{ ...catalog.availableModes[0], retired: true }] };
    expect(readSessionModesMetadata({ sessionModesV2: retained })).toEqual(catalog);
    const predecessor = { ...catalog, v: 1, currentModeId: 'plan' };
    expect(readSessionModesMetadata({ sessionModesV1: { ...predecessor, retired: true,
      availableModes: retained.availableModes } })).toEqual({ ...predecessor, v: 2 });
    expect(readSessionModesMetadata({ sessionModesV2: { ...retained, updatedAt: -1 } })).toBeNull();
    expect(SessionOwnerModeCatalogV2Schema.safeParse(retained).success).toBe(false);
    expect(SessionOwnerModeCatalogV1Schema.safeParse({ ...predecessor, retired: true }).success).toBe(false);
  });

  it('projects typed retained display facts without forwarding their unknown fields', () => {
    const metadata = { summary: { text: 'Summary', updatedAt: 10 },
      agentPresentation: { agentId: 'codex', label: 'Codex' },
      sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes: null },
      actionConfirmationsV1: { v: 1, requests: {}, completedRequests: {} },
      forkVisualsV1: { v: 1, copies: [{ status: 'not_copied', originServerId: 'home',
        originSessionId: 'parent', originItemId: 'original' }] } };
    const retained = { summary: { ...metadata.summary, retired: true },
      agentPresentation: { ...metadata.agentPresentation, retired: true },
      sessionGuardStateV1: { ...metadata.sessionGuardStateV1, retired: true },
      actionConfirmationsV1: { ...metadata.actionConfirmationsV1, retired: true },
      forkVisualsV1: { ...metadata.forkVisualsV1, retired: true,
        copies: [{ ...metadata.forkVisualsV1.copies[0], retired: true }] } };
    expect(projectSessionSharedMetadataV1({ metadata: retained })).toEqual({ v: 1, ...metadata });
    expect(projectSessionSharedMetadataV1({ metadata: { summary: { ...retained.summary, updatedAt: -1 } } }))
      .toEqual({ v: 1 });
    expect(SessionSharedMetadataV1Schema.safeParse({ v: 1, ...retained }).success).toBe(false);
  });

  it('separates retained legacy owner conversion from fresh metadata admission', () => {
    const metadata = { work: { memoryEnabled: true, viewPreferences: { showToolCalls: true } },
      sessionModesV2: { v: 2, agentId: 'codex', updatedAt: 10, currentModeId: null,
        availableModes: [{ id: 'plan', name: 'Plan' }] } };
    const expected = createSessionOwnerMetadataV1({ metadata });
    expect(expected.ok).toBe(true);
    const retained = { ...metadata, retired: true,
      work: { ...metadata.work, retired: true,
        viewPreferences: { ...metadata.work.viewPreferences, retired: true } },
      sessionModesV2: { ...metadata.sessionModesV2, retired: true,
        availableModes: [{ ...metadata.sessionModesV2.availableModes[0], retired: true }] } };
    expect(createSessionOwnerMetadataV1({ metadata: retained }, 'stored')).toEqual(expected);
    expect(createSessionOwnerMetadataV1({ metadata: retained }).ok).toBe(false);
    expect(createSessionOwnerMetadataV1({ metadata: { ...retained, work: { memoryEnabled: 'yes' } } }, 'stored').ok).toBe(false);
  });
});
