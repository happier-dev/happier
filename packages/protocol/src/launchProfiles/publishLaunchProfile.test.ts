import { describe, expect, it, vi } from 'vitest';
import { createLaunchProfilePublisherV1 } from '../index.js';
import { LaunchProfileArtifactV1Schema, launchProfileArtifactSharingAdapterV1, listSharedLaunchProfileArtifactsV1 } from './launchProfileArtifactV1.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from '../actions/actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from '../actions/actionSettings.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';

const profile = {
  v: 2 as const, id: 'work', name: 'Work', createdAt: 1, updatedAt: 1,
  extraEnvironmentVariables: [], envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret' as const, required: true }],
};

function harness(candidate: unknown = profile) {
  // Settings CAS and Artifact reads/creates are persistence boundaries. The publisher is real.
  let settings: Record<string, unknown> = { profiles: [candidate], secretBindingsByProfileId: { work: { DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy' } }, other: 'keep' };
  const artifacts = new Map<string, { artifactId: string; header: Record<string, unknown>; body: string; revision: { headerVersion: number; bodyVersion: number } }>();
  const create = vi.fn(async (input: { header: Readonly<Record<string, unknown>>; body: string }) => {
    const artifactId = `artifact-${artifacts.size + 1}`;
    artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
    return { artifactId };
  });
  const publisher = createLaunchProfilePublisherV1({
    readSettings: async () => settings,
    mutateSettings: async (mutate) => { settings = mutate(settings); },
    artifactStore: { read: async (id) => artifacts.get(id) ?? null, create },
  });
  return { publisher, create, artifacts, readSettings: () => settings, changeSettings: (next: Record<string, unknown>) => { settings = next; } };
}

describe('launch_profiles.publish', () => {
  it.each([
    { context: { surface: 'ui', runtimeAccountId: 'account', actionCaller: { kind: 'host' } }, savedBy: { kind: 'person', accountId: 'account' } },
    { context: { surface: 'cli', runtimeAccountId: 'account', defaultSessionId: 'other-session', actionCaller: { kind: 'session', sessionId: 'admitted-session' } },
      savedBy: { kind: 'agent', accountId: 'account', sessionId: 'admitted-session' } },
  ] satisfies readonly { context: ActionExecutorContext; savedBy: unknown }[])('retains the admitted actor when publishing through Actions ($savedBy.kind)', async ({ context, savedBy }) => {
    const state = harness();
    const executor = createActionExecutor({ launchProfilePublish: state.publisher.publish } as unknown as ActionExecutorDeps);
    expect(await executor.execute('launch_profiles.publish', { profileId: 'work' }, { ...context, authority: 'present_user' })).toMatchObject({ ok: true });
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({ savedBy });
    const artifact = [...state.artifacts.values()][0]!;
    expect(artifact.header).not.toHaveProperty('savedBy');
    expect(JSON.parse(artifact.body)).not.toHaveProperty('savedBy');
  });
  it.each(['cli', 'ui'] as const)('retains its Artifact result through deferred %s approval custody', async surface => {
    const state = harness();
    let stored: ApprovalRequest | null = null;
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
      'launch_profiles.publish': { approvalRequiredSurfaces: [surface] },
    } });
    // Only Artifact persistence is substituted; policy, transitions, replay and publication remain real.
    const executor = createActionExecutor({
      launchProfilePublish: state.publisher.publish,
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id, settings, context, undefined, undefined, input),
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'approval-profile' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) return { ok: false, errorCode: 'not_found', error: 'not_found' };
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    expect(await executor.execute('launch_profiles.publish', { profileId: 'work' }, {
      surface, authority: 'present_user', serverId: 'home', runtimeAccountId: 'account',
      actionRequestId: 'publish-work', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-profile' } });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.readSettings().profiles).toEqual([profile]);
    if (!stored) throw new Error('Expected persisted approval');
    stored = ApprovalRequestV2Schema.parse({ ...ApprovalRequestV2Schema.parse(stored), status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 } });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'approval-profile' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(stored).toMatchObject({ status: 'executed', execution: {
      ok: true, result: { artifactId: [...state.artifacts.keys()][0] },
    } });
    expect(state.readSettings().profiles).toEqual([{ artifactId: [...state.artifacts.keys()][0] }]);
  });

  it('admits Account automation for value-free publication while enforcing its configured approval policy', async () => {
    const state = harness();
    // Unused host ports are omitted in this boundary harness; the publish owner is real.
    const executor = createActionExecutor({ launchProfilePublish: state.publisher.publish,
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
        context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, input),
    });
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
    expect(getActionSpec('launch_profiles.publish')).toMatchObject({ executionPlacement: 'account', requiredAuthority: 'account_automation' });
    await expect(executor.execute('launch_profiles.publish', { profileId: 'work' }, { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'launch_profiles.publish': { approvalRequiredSurfaces: ['agent'] } } }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(state.artifacts.size).toBe(0);
    expect(state.readSettings().profiles).toEqual([profile]);
    await expect(executor.execute('launch_profiles.publish', { profileId: 'work' }, context))
      .resolves.toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
    expect(state.readSettings().profiles).toEqual([{ artifactId: [...state.artifacts.keys()][0] }]);
    await expect(executor.execute('launch_profiles.publish', { profileId: 'work' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: true, result: { artifactId: [...state.artifacts.keys()][0] } });
    expect(state.artifacts.size).toBe(1);
  });

  it('refuses filled environment values before any write, even when a caller labels them non-secret', async () => {
    const state = harness({ ...profile, extraEnvironmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'private', isSecret: false }] });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_contains_secret_values' });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.readSettings().profiles).toEqual([{ ...profile, extraEnvironmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'private', isSecret: false }] }]);
  });

  it('moves content and Saved Secret references into one Artifact and replaces the inline row', async () => {
    const state = harness();
    const result = await state.publisher.publish({ profileId: 'work' });
    expect(state.readSettings()).toEqual({ profiles: [{ artifactId: result.artifactId }], secretBindingsByProfileId: {}, other: 'keep' });
    const artifact = state.artifacts.get(result.artifactId)!;
    const content = LaunchProfileArtifactV1Schema.parse(JSON.parse(artifact.body));
    expect(content.profile.id).toBe('work');
    expect(content.secretBindings).toEqual({ DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy' });
    expect(launchProfileArtifactSharingAdapterV1.canShare(artifact)).toBe(true);
    expect(await state.publisher.publish({ profileId: 'work' })).toEqual(result);
    expect(state.artifacts.size).toBe(1);
  });

  it('refuses to replace a profile edited while the Artifact write was in flight', async () => {
    const state = harness();
    state.create.mockImplementationOnce(async (input) => {
      const artifactId = 'concurrent-publish';
      state.artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
      state.changeSettings({ ...state.readSettings(), profiles: [{ ...profile, name: 'Edited elsewhere' }] });
      return { artifactId };
    });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_publish_conflict' });
    expect(state.readSettings().profiles).toEqual([{ ...profile, name: 'Edited elsewhere' }]);
  });

  it('preserves sibling writes but refuses changing Saved Secret references during publication', async () => {
    const state = harness();
    state.create.mockImplementationOnce(async (input) => {
      const artifactId = 'changed-binding';
      state.artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
      state.changeSettings({ ...state.readSettings(), other: 'updated', secretBindingsByProfileId: { work: { DEPLOY_TOKEN: 'new-secret' } } });
      return { artifactId };
    });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_publish_conflict' });
    expect(state.readSettings()).toMatchObject({ other: 'updated', secretBindingsByProfileId: { work: { DEPLOY_TOKEN: 'new-secret' } } });
  });

  it('replaces only the published row in the current CAS winner, preserving unrelated concurrent Settings', async () => {
    const state = harness();
    state.create.mockImplementationOnce(async (input) => {
      const artifactId = 'sibling-write';
      state.artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
      state.changeSettings({ ...state.readSettings(), other: 'updated' });
      return { artifactId };
    });
    expect(await state.publisher.publish({ profileId: 'work' })).toEqual({ artifactId: 'sibling-write' });
    expect(state.readSettings()).toEqual({ profiles: [{ artifactId: 'sibling-write' }], secretBindingsByProfileId: {}, other: 'updated' });
  });

  it('refuses ambiguous duplicate profile ids instead of deleting either inline document', async () => {
    const state = harness();
    state.changeSettings({ ...state.readSettings(), profiles: [profile, { ...profile, name: 'Other document' }] });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_id_ambiguous' });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.readSettings().profiles).toHaveLength(2);
  });

  it('does not sanitize an unreadable Account binding map while publishing one profile', async () => {
    const state = harness();
    state.changeSettings({ ...state.readSettings(), secretBindingsByProfileId: 'retained-unreadable-data' });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_secret_bindings_invalid' });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.readSettings().secretBindingsByProfileId).toBe('retained-unreadable-data');
  });

  it('does not replace Settings with an invalid Artifact reference returned by persistence', async () => {
    const state = harness();
    state.create.mockResolvedValueOnce({ artifactId: '' });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_publish_failed' });
    expect(state.readSettings().profiles).toEqual([profile]);
  });

  it('honors cancellation before Settings replacement without pretending an Artifact write was undone', async () => {
    const state = harness();
    const controller = new AbortController();
    state.create.mockImplementationOnce(async (input) => {
      const artifactId = 'cancelled-publish';
      state.artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
      controller.abort();
      return { artifactId };
    });
    await expect(state.publisher.publish({ profileId: 'work' }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(state.readSettings().profiles).toEqual([profile]);
    expect(state.artifacts.size).toBe(1);
  });

  it('publishes predecessor-shaped profiles through canonical target-key normalization', async () => {
    const state = harness({ id: 'work', name: 'Legacy work', createdAt: 1, updatedAt: 1,
      defaultPermissionModeByTargetKey: { 'backend:claude': 'default' }, environmentVariables: [{ name: 'DEPLOY_TOKEN', value: '' }],
      codingPromptBehaviorV1: { v: 1, responseOptions: 'disabled' } });
    const result = await state.publisher.publish({ profileId: 'work' });
    const content = LaunchProfileArtifactV1Schema.parse(JSON.parse(state.artifacts.get(result.artifactId)!.body));
    expect(content.profile.envVarRequirements).toEqual([{ name: 'DEPLOY_TOKEN', kind: 'secret', required: false }]);
    expect(content.profile).toMatchObject({ environmentVariables: [], codingPromptBehaviorV1: { v: 1, responseOptions: 'disabled' } });
    expect(Object.keys(content.profile.defaultPermissionModeByTargetKey)).toHaveLength(1);
  });

  it('uses the canonical reader’s normalized profile identity when locating and replacing an inline row', async () => {
    const state = harness({ ...profile, id: ' work ' });
    const result = await state.publisher.publish({ profileId: 'work' });
    expect(state.readSettings().profiles).toEqual([{ artifactId: result.artifactId }]);
    expect(LaunchProfileArtifactV1Schema.parse(JSON.parse(state.artifacts.get(result.artifactId)!.body)).profile.id).toBe('work');
  });

  it('rejects a secret-bearing opened Artifact before it can enter the grant path', () => {
    expect(launchProfileArtifactSharingAdapterV1.canShare({
      artifactId: 'profile', header: { kind: 'launch-profile.v1', profileId: 'work', name: 'Work' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { ...profile, extraEnvironmentVariables: [{ name: 'TOKEN', value: 'private' }] }, secretBindings: {} }),
    })).toBe(false);
  });

  it('does not let a legacy parser discard unknown secret-bearing fields and authorize sharing', () => {
    expect(launchProfileArtifactSharingAdapterV1.canShare({ artifactId: 'profile',
      header: { kind: 'launch-profile.v1', profileId: 'legacy', name: 'Legacy' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { id: 'legacy', name: 'Legacy', token: 'private' }, secretBindings: {} }),
    })).toBe(false);
  });

  it('projects only current, opened profile grants and removes a revoked profile without retaining its document', async () => {
    const state = harness();
    const published = await state.publisher.publish({ profileId: 'work' });
    const resource = state.artifacts.get(published.artifactId)!;
    const grant = { ...resource, access: 'view' as const };
    expect(listSharedLaunchProfileArtifactsV1([grant, resource, { ...grant, header: { kind: 'role.v1' } }, { ...grant, body: '{}' }]))
      .toMatchObject([{ artifactId: published.artifactId, viewOnly: true, shared: true, profile: { id: 'work' }, revision: resource.revision }]);
    expect(listSharedLaunchProfileArtifactsV1([{ ...grant, access: 'edit' }])[0]?.viewOnly).toBe(false);
    expect(listSharedLaunchProfileArtifactsV1([])).toEqual([]);
  });
});
