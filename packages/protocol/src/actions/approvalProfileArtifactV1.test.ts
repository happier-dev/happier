import { describe, expect, it } from 'vitest';
import { ActionPolicyInputSchemas, ActionPolicyOutputSchemas } from './actionPolicyActionFamily.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { getArtifactKindPolicyV1, getArtifactUseTargetV1 } from '../artifacts/artifactSharingV1.js';
import { executeApprovalProfileArtifactChangeV1, bindApprovalProfileV1, listReadableApprovalProfilesV1,
  type ApprovalProfileArtifactStoreV1 } from './approvalProfileArtifactV1.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { createActionExecutor } from './actionExecutor.js';

describe('Artifact-backed approval profile contract', () => {
  it('returns a visible admission refusal when a cold profile cannot be opened', async () => {
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
      targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const executor = createActionExecutor({
      readApprovalProfile: async () => { throw new Error('transport unavailable'); },
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' } }),
      deploymentAction: async () => { throw new Error('Must refuse before deployment'); },
    });
    await expect(executor.execute('deployments.deploy', input, {
      surface: 'agent', authority: 'account_automation', approvalProfileId: 'picked', serverId: 'home',
      interactivePresentation: 'unavailable', actionsSettings: normalizeActionsSettingsV1({ v: 1 }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
  });
  it('creates without a caller id and requires a revision for changes', () => {
    const profile = { name: 'Review', actions: { 'session.stop': { approvalRequiredSurfaces: ['agent'] } } };
    expect(ActionPolicyInputSchemas['actions.policy.set'].safeParse({ profileChange: { kind: 'create', profile } }).success).toBe(true);
    expect(ActionPolicyInputSchemas['actions.policy.set'].safeParse({ profileChange: { kind: 'create', profile: { ...profile, id: 'chosen' } } }).success).toBe(false);
    expect(ActionPolicyInputSchemas['actions.policy.set'].safeParse({ profileChange: { kind: 'delete', id: 'stored' } }).success).toBe(false);
    expect(ActionPolicyOutputSchemas['actions.policy.set'].safeParse({ profileChange: { kind: 'create', id: 'generated', revision: { headerVersion: 1, bodyVersion: 1 } } }).success).toBe(true);
  });

  it('keeps only Machine default preferences in Account settings', () => {
    expect(normalizeActionsSettingsV1({ v: 1, actions: {}, approvalProfiles: [{ id: 'old', name: 'Old' }], machineApprovalProfiles: { machine: 'stored' } }))
      .toMatchObject({ machineApprovalProfiles: { machine: 'stored' } });
    expect(normalizeActionsSettingsV1({ v: 1, actions: {}, approvalProfiles: [{ id: 'old', name: 'Old' }] })).not.toHaveProperty('approvalProfiles');
  });

  it('shares with people while keeping profiles private and out of generic mutation', () => {
    expect(getArtifactKindPolicyV1('approval-profile.v1')).toMatchObject({ browserListed: false,
      ownerDeleteAllowed: false, publicLinkAllowed: false, peopleSharingAllowed: true });
    expect(getArtifactUseTargetV1({ artifactId: 'profile', header: { kind: 'approval-profile.v1', name: 'Review' },
      body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: 'Review' } }) })).toMatchObject({
        artifactId: 'profile', kind: 'approval_profile', canShare: true, browserListed: false, publicLinkAllowed: false });
  });

  it('uses generated storage identity, rejects stale and read-only changes, and skips unchanged writes', async () => {
    // Persistent storage is the boundary; content, CAS, access and binding remain real.
    let current: Awaited<ReturnType<ApprovalProfileArtifactStoreV1['read']>> = null;
    let writes = 0;
    const store: ApprovalProfileArtifactStoreV1 = {
      read: async () => current,
      create: async input => {
        writes++;
        current = { artifactId: 'generated', header: input.header, body: input.body,
          access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 } };
        return current;
      },
      update: async input => {
        writes++;
        const revision = { headerVersion: 2, bodyVersion: 2 };
        current = { ...current!, header: input.header, body: input.body, revision };
        return { ok: true, revision };
      },
      delete: async () => { writes++; current = null; return { ok: true }; },
    };
    const created = await executeApprovalProfileArtifactChangeV1(store, { kind: 'create', profile: { name: 'Review' } });
    expect(created).toMatchObject({ ok: true, result: { profileChange: { id: 'generated' } } });
    const revision = { headerVersion: 1, bodyVersion: 1 };
    expect(await executeApprovalProfileArtifactChangeV1(store, { kind: 'update', id: 'generated',
      expectedRevision: revision, profile: { name: 'Review' } })).toMatchObject({ ok: true });
    expect(writes).toBe(1);
    expect(await executeApprovalProfileArtifactChangeV1(store, { kind: 'update', id: 'generated',
      expectedRevision: { headerVersion: 0, bodyVersion: 0 }, profile: { name: 'Stale' } })).toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    current = { ...current!, access: 'view' };
    expect(await executeApprovalProfileArtifactChangeV1(store, { kind: 'update', id: 'generated',
      expectedRevision: revision, profile: { name: 'Forbidden' } })).toMatchObject({ ok: false, errorCode: 'forbidden' });
    current = { ...current, access: 'admin' };
    expect(await executeApprovalProfileArtifactChangeV1(store, { kind: 'delete', id: 'generated',
      expectedRevision: revision })).toMatchObject({ ok: false, errorCode: 'forbidden' });
    expect(await executeApprovalProfileArtifactChangeV1(store, { kind: 'update', id: 'generated',
      expectedRevision: revision, profile: { name: 'Edited' } })).toMatchObject({ ok: true });
    const rows = listReadableApprovalProfilesV1([current!]);
    expect(bindApprovalProfileV1(rows, 'generated')).toMatchObject({ profile: { name: 'Edited' }, resolution: { status: 'available' } });
    expect(bindApprovalProfileV1([], 'generated')).toMatchObject({ profile: null, resolution: { status: 'missing' } });
    current = { ...current!, access: 'owner' };
    expect(await executeApprovalProfileArtifactChangeV1(store, { kind: 'delete', id: 'generated',
      expectedRevision: current.revision })).toMatchObject({ ok: true });
    expect(writes).toBe(3);
  });

  it('omits malformed, mismatched and unreadable Artifact bodies', () => {
    const resource: ArtifactSharingResourceV1 = { artifactId: 'stored', access: 'view',
      header: { kind: 'approval-profile.v1', name: 'Review' }, body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: 'Review' } }),
      revision: { headerVersion: 1, bodyVersion: 1 } };
    expect(listReadableApprovalProfilesV1([resource])).toHaveLength(1);
    expect(listReadableApprovalProfilesV1([{ ...resource, body: null }, { ...resource, header: { ...resource.header, name: 'Mismatch' } },
      { ...resource, body: JSON.stringify({ kind: 'approval-profile.v1', profile: { id: 'forged', name: 'Review' } }) }])).toEqual([]);
  });
});
