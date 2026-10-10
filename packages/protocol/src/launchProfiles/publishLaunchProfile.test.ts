import { describe, expect, it, vi } from 'vitest';
import { createLaunchProfilePublisherV1 } from '../index.js';
import { LaunchProfileArtifactV1Schema, launchProfileArtifactSharingAdapterV1, listSharedLaunchProfileArtifactsV1, readLaunchProfileArtifactV1 } from './launchProfileArtifactV1.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from '../actions/actionApprovalPolicy.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { ActionsSettingsV1Schema } from '../actions/actionSettings.js';
import { StoredProfileRecordV1Schema, type ProfileRecordV1 } from '../profiles/profileRecordSchemaV1.js';

const profile = {
  v: 2 as const, id: 'work', name: 'Work', createdAt: 1, updatedAt: 1,
  extraEnvironmentVariables: [], envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret' as const, required: true }],
};
const publishWaiver = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
  approvalWaivedSurfaces: { 'launch_profiles.publish': ['ui', 'cli', 'agent'] } });
const defaultActionSettings = ActionsSettingsV1Schema.parse({ v: 1 });

function publisherExecutor(publish: ReturnType<typeof createLaunchProfilePublisherV1>['publish']) {
  // The host policy port consumes the real canonical policy, not a mocked
  // allow/deny result. Unused host boundaries remain omitted in this harness.
  const deps = {
    launchProfilePublish: publish,
    isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(actionId,
      context.actionsSettings ?? defaultActionSettings, context, getActionSpec(actionId).safety, undefined, input),
  } satisfies Pick<ActionExecutorDeps, 'launchProfilePublish' | 'isActionApprovalRequired'>;
  return createActionExecutor(deps as unknown as ActionExecutorDeps);
}

function harness(candidate: unknown = profile) {
  // Profile row CAS and Artifact reads/creates are persistence boundaries. The publisher is real.
  const isVersioned = candidate !== null && typeof candidate === 'object' && 'v' in candidate;
  const id = candidate !== null && typeof candidate === 'object' && 'id' in candidate ? candidate.id : 'work';
  let record = StoredProfileRecordV1Schema.parse({ v: 1, id, definition: {
    kind: isVersioned ? 'inline' : 'legacy', profile: candidate,
  }, enabled: false, promptStack: [], secretBindings: { DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy' } });
  let revision = 3;
  const artifacts = new Map<string, { artifactId: string; header: Record<string, unknown>; body: string; revision: { headerVersion: number; bodyVersion: number } }>();
  const create = vi.fn(async (input: { header: Readonly<Record<string, unknown>>; body: string }) => {
    const artifactId = `artifact-${artifacts.size + 1}`;
    artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
    return { artifactId };
  });
  const publisher = createLaunchProfilePublisherV1({
    profileStore: {
      read: async requestedId => record.id === requestedId ? { record, revision } : null,
      updateDefinition: async input => {
        if (input.profileId !== record.id || input.expectedRevision !== revision) {
          throw Object.assign(new Error('profile_revision_conflict'), { code: 'profile_revision_conflict' });
        }
        record = { ...record, definition: { kind: 'artifact', artifactId: input.artifactId } };
        revision += 1;
      },
    },
    artifactStore: { read: async (id) => artifacts.get(id) ?? null, create },
  });
  return { publisher, create, artifacts, readRecord: () => record,
    changeRecord: (next: ProfileRecordV1) => { record = next; revision += 1; } };
}

describe('launch_profiles.publish', () => {
  it('drops additive saved profile and Artifact fields while keeping publication admission strict', async () => {
    const extended = { ...profile, future: true, envVarRequirements: [{ ...profile.envVarRequirements[0], future: true }] };
    const state = harness(extended);
    const result = await state.publisher.publish({ profileId: 'work' });
    const artifact = state.artifacts.get(result.artifactId)!;
    expect(artifact.body).not.toContain('future');
    const content = JSON.parse(artifact.body) as Record<string, unknown>;
    const stored = { ...content, future: true, profile: extended };
    expect(() => LaunchProfileArtifactV1Schema.parse(stored)).toThrow();
    expect(launchProfileArtifactSharingAdapterV1.canShare({ ...artifact, body: JSON.stringify(stored) })).toBe(false);
    expect(readLaunchProfileArtifactV1({ ...artifact, body: JSON.stringify(stored) })).toEqual(content);
    expect(readLaunchProfileArtifactV1({ ...artifact, body: JSON.stringify({ ...stored, profile: { ...extended, createdAt: 'invalid' } }) })).toBeNull();
    expect(await state.publisher.publish({ profileId: 'work' })).toEqual(result);
  });
  it('does not reinterpret a corrupt versioned profile as a published reference on retry', async () => {
    const state = harness();
    const result = await state.publisher.publish({ profileId: 'work' });
    const artifact = state.artifacts.get(result.artifactId)!;
    artifact.body = JSON.stringify({ kind: 'launch-profile.v1', profile: { ...profile, createdAt: 'invalid' }, secretBindings: {} });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_artifact_unavailable' });
    expect(state.artifacts.size).toBe(1);
  });
  it.each([
    { context: { surface: 'ui', runtimeAccountId: 'account', actionCaller: { kind: 'host' } }, savedBy: { kind: 'person', accountId: 'account' } },
    { context: { surface: 'cli', runtimeAccountId: 'account', defaultSessionId: 'other-session', actionCaller: { kind: 'session', sessionId: 'admitted-session' } },
      savedBy: { kind: 'agent', accountId: 'account', sessionId: 'admitted-session' } },
  ] satisfies readonly { context: ActionExecutorContext; savedBy: unknown }[])('retains the admitted actor when publishing through Actions ($savedBy.kind)', async ({ context, savedBy }) => {
    const state = harness();
    const executor = publisherExecutor(state.publisher.publish);
    const published = await executor.execute('launch_profiles.publish', { profileId: 'work' },
      { ...context, authority: 'present_user', actionsSettings: publishWaiver });
    expect(published, JSON.stringify(published)).toMatchObject({ ok: true });
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({ savedBy });
    const artifact = [...state.artifacts.values()][0]!;
    expect(artifact.header).not.toHaveProperty('savedBy');
    expect(JSON.parse(artifact.body)).not.toHaveProperty('savedBy');
  });
  it('retains its Artifact result through the canonical approval lifecycle', () => {
    const spec = getActionSpec('launch_profiles.publish');
    expect(spec.executionPlacement).toBe('account');
    const cliRouting = resolveActionApprovalRouting({ actionId: spec.id, spec, requiredByPolicy: true,
      context: { surface: 'cli', authority: 'present_user' } });
    expect(cliRouting, JSON.stringify(cliRouting))
      .toMatchObject({ required: true, result: 'required', flow: 'deferred' });
    // The mounted UI presenter follows approval custody; it must retain the typed result.
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, requiredByPolicy: true,
      context: { surface: 'ui', authority: 'present_user' } }))
      .toMatchObject({ required: true, result: 'required', flow: 'deferred' });
  });

  it('executes through the Action front door only after its configurable default approval is waived', async () => {
    const state = harness();
    const executor = publisherExecutor(state.publisher.publish);
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(resolveActionApprovalRouting({ actionId: 'launch_profiles.publish', spec: getActionSpec('launch_profiles.publish'),
      context: { ...context, authority: 'account_automation' }, defaultSafety: 'danger' }))
      .toMatchObject({ required: true, flow: 'blocking' });
    const autonomous = await executor.execute('launch_profiles.publish', { profileId: 'work' }, { ...context, authority: 'account_automation' });
    expect(autonomous, JSON.stringify(autonomous)).toMatchObject({ ok: false });
    expect(state.artifacts.size).toBe(0);
    await expect(executor.execute('launch_profiles.publish', { profileId: 'work' },
      { ...context, authority: 'account_automation', actionsSettings: publishWaiver }))
      .resolves.toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
  });

  it('refuses filled environment values before any write, even when a caller labels them non-secret', async () => {
    const state = harness({ ...profile, extraEnvironmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'private', isSecret: false }] });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_contains_secret_values' });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.readRecord().definition).toMatchObject({ profile: { extraEnvironmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'private', isSecret: false }] } });
  });

  it('publishes the definition while preserving private row attachments and binding masks', async () => {
    const state = harness();
    state.changeRecord({ ...state.readRecord(), promptStack: [{ id: 'private', ref: { kind: 'doc', artifactId: 'private-doc' },
      enabled: false, placement: 'system_append' }], secretBindings: { DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy', MASKED: null } });
    const original = state.readRecord();
    const result = await state.publisher.publish({ profileId: 'work' });
    expect(state.readRecord()).toEqual({ ...original, definition: { kind: 'artifact', artifactId: result.artifactId } });
    const artifact = state.artifacts.get(result.artifactId)!;
    const content = LaunchProfileArtifactV1Schema.parse(JSON.parse(artifact.body));
    expect(content.profile.id).toBe('work');
    expect(content.secretBindings).toEqual({});
    expect(launchProfileArtifactSharingAdapterV1.canShare(artifact)).toBe(true);
    expect(await state.publisher.publish({ profileId: 'work' })).toEqual(result);
    expect(state.artifacts.size).toBe(1);
  });

  it('refuses to replace a profile edited while the Artifact write was in flight', async () => {
    const state = harness();
    state.create.mockImplementationOnce(async (input) => {
      const artifactId = 'concurrent-publish';
      state.artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
      const record = state.readRecord();
      if (record.definition.kind !== 'inline') throw new Error('expected inline definition');
      state.changeRecord({ ...record, definition: { ...record.definition, profile: { ...record.definition.profile, name: 'Edited elsewhere' } } });
      return { artifactId };
    });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_revision_conflict' });
    expect(state.readRecord().definition).toMatchObject({ profile: { name: 'Edited elsewhere' } });
  });

  it('refuses changing private Saved Secret references during publication', async () => {
    const state = harness();
    state.create.mockImplementationOnce(async (input) => {
      const artifactId = 'changed-binding';
      state.artifacts.set(artifactId, { ...input, artifactId, revision: { headerVersion: 1, bodyVersion: 1 } });
      state.changeRecord({ ...state.readRecord(), secretBindings: { DEPLOY_TOKEN: 'new-secret' } });
      return { artifactId };
    });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_revision_conflict' });
    expect(state.readRecord().secretBindings).toEqual({ DEPLOY_TOKEN: 'new-secret' });
  });

  it('does not replace the Profile definition with an invalid Artifact reference returned by persistence', async () => {
    const state = harness();
    state.create.mockResolvedValueOnce({ artifactId: '' });
    await expect(state.publisher.publish({ profileId: 'work' })).rejects.toMatchObject({ code: 'profile_publish_failed' });
    expect(state.readRecord().definition.kind).toBe('inline');
  });

  it('honors cancellation before Profile replacement without pretending an Artifact write was undone', async () => {
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
    expect(state.readRecord().definition.kind).toBe('inline');
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

  it('preserves an exact stored profile identity while keeping bindings private', async () => {
    const state = harness({ ...profile, id: ' work ' });
    const result = await state.publisher.publish({ profileId: ' work ' });
    expect(state.readRecord()).toMatchObject({ id: ' work ', definition: { kind: 'artifact', artifactId: result.artifactId },
      secretBindings: { DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy' } });
    expect(LaunchProfileArtifactV1Schema.parse(JSON.parse(state.artifacts.get(result.artifactId)!.body)))
      .toMatchObject({ profile: { id: ' work ' }, secretBindings: {} });
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
