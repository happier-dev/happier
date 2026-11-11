import { afterEach, expect, it, vi } from 'vitest';
import { DeploymentMoveToRepositoryResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentMoveFixture } from './deploymentMove.testkit';

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])('switches exact merged bytes through the reviewed definition writer (edited=%s)', async edited => {
  const fixture = await createDeploymentMoveFixture({ attach: false, create: false });
  try {
    const { continuation, mergedCommit } = await fixture.seedMergedPullRequest({ edited });
    expect(mergedCommit).not.toBe(continuation.headCommit);
    fixture.detail.content = { ...fixture.detail.content, name: 'Renamed while PR open' };
    fixture.detail.environment.revision += 1;
    const input = { ...fixture.input, mode: 'apply' as const, continuation };
    const resumed = await fixture.executeMove(input);
    if (!edited) expect(fixture.reviewedDefinitionWrites).toEqual([true]);
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) throw new Error(resumed.errorCode);
    let result = DeploymentMoveToRepositoryResultV1Schema.parse(resumed.result);
    if (edited) {
      expect(result.kind).toBe('reviewMerged');
      expect(fixture.detail.content.definition).toEqual(fixture.initial);
      if (result.kind !== 'reviewMerged') throw new Error('Expected explicit merged review');
      const accepted = await fixture.executeMove({ ...input, useMergedVersion: result.review });
      expect(fixture.reviewedDefinitionWrites).toEqual([true]);
      expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
      if (!accepted.ok) throw new Error(accepted.errorCode);
      result = DeploymentMoveToRepositoryResultV1Schema.parse(accepted.result);
    }
    expect(result).toMatchObject({ kind: 'switched', commitSha: mergedCommit });
    expect(fixture.detail.content).toMatchObject({ name: 'Renamed while PR open',
      definition: { kind: 'repository', ref: mergedCommit, compose: { path: fixture.input.path, services: ['app'] } } });
    expect(fixture.forge.httpRequests.filter(request => request.method === 'POST')).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});
