import { expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { prepareHostReviewedChildrenV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleApproval';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import {
  buildSessionProjectFilesSourceOpenInputV1,
  SESSION_PROJECT_FILES_OPEN_CHILDREN_V1,
} from '@happier-dev/protocol/sessions/creation/sessionProjectFilesOpenV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createCliActionDeps } from './createCliActionDeps';

const managedWorkspace = {
  v: 2 as const,
  kind: 'managed' as const,
  serverId: 'home-1',
  workspaceId: 'ws-ssh-1',
  managedId: 'ssh-managed-1',
  controller: { machineId: 'controller-1', installationId: 'controller-installation-1' },
  rootPath: '/home/qa-remote/qa-rws-repo',
};

const sshWorkspacePlacement = {
  kind: 'machine' as const,
  target: { serverId: 'home-1', machineId: 'controller-1' },
  projectFilesSource: { kind: 'managed' as const, workspace: managedWorkspace },
  projectFiles: { kind: 'copy_once' as const },
};

const baseSpawnInput = SessionSpawnNewInputV2Schema.parse({
  executionTarget: { serverId: 'home-1', machineId: 'controller-1' },
  directory: { kind: 'managed' as const },
  agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  sessionPlacement: sshWorkspacePlacement,
});

function createTestDeps(sessionSpawnBirthContext?: Parameters<typeof createCliActionDeps>[0]['sessionSpawnBirthContext']) {
  return createCliActionDeps({
    token: 'session-bearer',
    sessionId: 'session-1',
    mode: 'plain',
    ctx: null,
    serverId: 'home-1',
    serverHttpBaseUrl: 'https://home-1.test',
    runtimeActionMachineId: 'controller-1',
    ...(sessionSpawnBirthContext ? { sessionSpawnBirthContext } : {}),
  });
}

it('does not duplicate spec-declared session project-files reviewed children on copy-work session.spawn_new', async () => {
  const deps = createTestDeps();
  const spec = getActionSpec('session.spawn_new');
  const declaredChildren = typeof spec.hostReviewedChildren === 'function'
    ? spec.hostReviewedChildren(baseSpawnInput)
    : spec.hostReviewedChildren;
  const context = { surface: 'ui' as const, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };

  const review = await prepareHostReviewedChildrenV1({
    actionId: 'session.spawn_new',
    input: baseSpawnInput,
    context,
    deps,
    declaredChildren,
    admitCredentialScope: async () => null,
    approvalReplay: false,
    isSameHome: async () => true,
  });
  expect(review, JSON.stringify(review)).not.toHaveProperty('ok', false);
  if ('ok' in review) throw new Error('Spawn review unavailable');

  expect(review.plan?.children).toHaveLength(2);
  expect(review.plan?.children.map(child => child.role)).toEqual([
    SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role,
    SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target.role,
  ]);

  const executed: unknown[] = [];
  const port = createHostReviewedChildPortV1({
    actionId: 'session.spawn_new',
    input: baseSpawnInput,
    context,
    plan: review.plan,
    policies: review.policies,
    reviewAdmitted: true,
    execute: async input => {
      executed.push(input);
      return { ok: true, result: { ok: true } };
    },
  });
  const sourceOpenInput = buildSessionProjectFilesSourceOpenInputV1(sshWorkspacePlacement);
  expect(sourceOpenInput).not.toBeNull();
  const childResult = await port.invoke({
    action: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.action,
    role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role,
    input: sourceOpenInput!,
  });
  expect(childResult).toEqual({ ok: true, result: { ok: true } });
  expect(executed).toHaveLength(1);
});

it('still appends birth-context project-files children when absent from input and deduplicates overlaps', async () => {
  const context = { surface: 'agent' as const, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
  const spec = getActionSpec('session.spawn_new');

  const inputWithoutPlacement = SessionSpawnNewInputV2Schema.parse({
    executionTarget: baseSpawnInput.executionTarget,
    directory: baseSpawnInput.directory,
    agentTarget: baseSpawnInput.agentTarget,
  });
  const depsWithBirth = createTestDeps({
    sessionPlacement: sshWorkspacePlacement,
    projectFiles: { kind: 'copy_once' },
  });
  const birthDeclared = typeof spec.hostReviewedChildren === 'function'
    ? spec.hostReviewedChildren(inputWithoutPlacement)
    : spec.hostReviewedChildren;
  const birthReview = await prepareHostReviewedChildrenV1({
    actionId: 'session.spawn_new',
    input: inputWithoutPlacement,
    context,
    deps: depsWithBirth,
    declaredChildren: birthDeclared,
    admitCredentialScope: async () => null,
    approvalReplay: false,
    isSameHome: async () => true,
  });
  expect(birthReview, JSON.stringify(birthReview)).not.toHaveProperty('ok', false);
  if ('ok' in birthReview) throw new Error('Birth spawn review unavailable');
  expect(birthReview.plan?.children).toHaveLength(2);
  expect(birthReview.plan?.children.map(child => child.role)).toEqual([
    SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role,
    SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target.role,
  ]);

  const overlapDeclared = typeof spec.hostReviewedChildren === 'function'
    ? spec.hostReviewedChildren(baseSpawnInput)
    : spec.hostReviewedChildren;
  const overlapReview = await prepareHostReviewedChildrenV1({
    actionId: 'session.spawn_new',
    input: baseSpawnInput,
    context,
    deps: depsWithBirth,
    declaredChildren: overlapDeclared,
    admitCredentialScope: async () => null,
    approvalReplay: false,
    isSameHome: async () => true,
  });
  expect(overlapReview, JSON.stringify(overlapReview)).not.toHaveProperty('ok', false);
  if ('ok' in overlapReview) throw new Error('Overlap spawn review unavailable');
  expect(overlapReview.plan?.children).toHaveLength(2);
});
