import { describe, expect, it, vi } from 'vitest';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});
import { listProjectSetupEffect } from './ProjectSetupReview';
import { readProjectSetupReviewPresentation } from './projectSetupEffectPresentation';

describe('producer-backed Project Setup review model', () => {
  it('uses producer binding labels and identities instead of declared variable names and carries exact SCM provenance', () => {
    const manifest: ProjectManifestV1 = { version: 1, environmentVariables: [{ name: 'DECLARED', kind: 'secret', required: true }] };
    const bindings = [
      { name: 'TOKEN', ref: 'saved-secret:deployment', revision: 7, source: 'personal', displayName: 'Deployment account' },
      { name: 'SHARED', ref: 'shared-resource:build', revision: 2, source: 'shared_resource', displayName: null },
    ];
    const provenance = { file: '.happier/project.json', kind: 'repository', headCommit: 'abc123', branch: 'feature', fileState: 'modified' };
    const reviewedEffect = { presentation: { bindings, provenance }, configEnvironment: { TOKEN: 'private-secret' } };
    const model = { effect: listProjectSetupEffect(manifest, reviewedEffect), presentation: readProjectSetupReviewPresentation(reviewedEffect) };
    expect(model.presentation).toEqual({ bindings, provenance });
    expect(model.effect.filter(line => line.binding)).toMatchObject([
      { key: 'binding:TOKEN', value: 'Deployment account', binding: bindings[0] },
      { key: 'binding:SHARED', value: 'SHARED', binding: bindings[1] },
    ]);
    expect(model.effect.some(line => line.key === 'values')).toBe(false);
    expect(JSON.stringify(model)).not.toContain('private-secret');
    expect(JSON.stringify(model)).not.toContain('DECLARED');
  });

  it('preserves declared variable names only when no valid producer presentation exists', () => {
    const manifest: ProjectManifestV1 = { version: 1, environmentVariables: [{ name: 'DECLARED', kind: 'secret', required: true }] };
    const model = { effect: listProjectSetupEffect(manifest), presentation: readProjectSetupReviewPresentation(undefined) };
    expect(model.presentation).toBeNull();
    expect(model.effect).toMatchObject([{ key: 'values', value: 'DECLARED' }]);
  });
});
