import { expect, it } from 'vitest';
import { DeploymentEnvironmentUpdateInputV1Schema } from './deploymentActionsV1.js';
import { projectDeploymentNativeAdmissionV1, isDeploymentEnvironmentUpdateNativeAdmissionV1,
  computeDeploymentEnvironmentUpdateInputDigestV1 } from './deploymentCandidatePublicationV1.js';

it('admits retention counts through the existing update and binds private publication to that exact reviewed policy', () => {
  const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 4,
    contentArtifactId: 'content', contentHeaderVersion: 2, contentBodyVersion: 3,
    patch: { backupRetention: { configRevision: 1, retention: { kind: 'keep', last: 7, monthly: 12 } } } };
  expect(DeploymentEnvironmentUpdateInputV1Schema.parse(input)).toEqual(input);
  const native = projectDeploymentNativeAdmissionV1('deployments.environments.update', input);
  expect(isDeploymentEnvironmentUpdateNativeAdmissionV1(native)).toBe(true);
  expect(native).toMatchObject({ environmentId: input.environmentId,
    inputDigest: computeDeploymentEnvironmentUpdateInputDigestV1(input) });
  expect(projectDeploymentNativeAdmissionV1('deployments.environments.update', { ...input,
    patch: { backupRetention: { ...input.patch.backupRetention, retention: { kind: 'keepEverything' } } } }))
    .not.toEqual(native);
  for (const retention of [{ kind: 'keep' }, { kind: 'keep', last: 0 }, { kind: 'keepEverything', last: 7 }]) {
    expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ ...input,
      patch: { backupRetention: { configRevision: 1, retention } } }).success).toBe(false);
  }
});

it.each([
  { ownServer: { rollout: 'startFirst' as const } },
  { ownServer: { autoRestorePreviousRelease: false } },
  { retainPreviousDeployments: 0 },
])('binds an authored release policy patch to the existing Environment admission', patch => {
  const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 4,
    contentArtifactId: 'content', contentHeaderVersion: 2, contentBodyVersion: 3, patch };
  expect(DeploymentEnvironmentUpdateInputV1Schema.parse(input)).toEqual(input);
  const native = projectDeploymentNativeAdmissionV1('deployments.environments.update', input);
  expect(isDeploymentEnvironmentUpdateNativeAdmissionV1(native)).toBe(true);
  expect(native).toMatchObject({ environmentId: input.environmentId,
    inputDigest: computeDeploymentEnvironmentUpdateInputDigestV1(input) });
  expect(projectDeploymentNativeAdmissionV1('deployments.environments.update', { ...input,
    patch: { ...patch, retainPreviousDeployments: 9 } })).not.toEqual(native);
});
