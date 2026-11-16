import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createArtifactAccessActionsV1 } from './executor/artifactAccessActions.js';
import type { ArtifactAccessGrantRowV1 } from '../artifacts/artifactAccessV1.js';

const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;

function createFixture(executorDeps: Pick<ActionExecutorDeps, 'readActionsSettings'> = {  }) {
  // Authenticated storage is the external boundary; Action/kind logic stays real.
  let grants: ArtifactAccessGrantRowV1[] = [];
  let removed = false;
  let readFailure: Error | undefined;
  const projection = () => ({ artifactId: 'artifact-1', ownerAccountId: 'owner', access: 'owner' as const, grants });
  const artifactAccessAction = createArtifactAccessActionsV1({
    read: async () => {
      if (readFailure) throw readFailure;
      return removed ? null : ({ artifactId: 'artifact-1', access: 'owner',
      header: { kind: 'workflow-definition.v1', definitionId: 'artifact-1', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Workflow' } },
      revision: { headerVersion: 1, bodyVersion: 1 } });
    },
    transport: {
      list: async () => {
        if (readFailure) throw readFailure;
        if (removed) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
        return projection();
      },
      set: async (input) => {
        grants = [{ principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'owner', createdAt: 1, display: { name: 'Team' } }];
        return { ...projection(), changed: true };
      },
      remove: async () => { grants = []; return { ...projection(), changed: true }; },
    },
  });
  return { executor: createActionExecutor({ artifactAccessAction, ...executorDeps } as unknown as ActionExecutorDeps),
    readGrants: () => grants, removeArtifact: () => { removed = true; }, failRead: (error: Error) => { readFailure = error; } };
}

describe('Artifact access Action family', () => {
  it('preserves the canonical not-found refusal when a previously readable source disappears', async () => {
    const { executor, removeArtifact, failRead } = createFixture({});
    const input = { artifactId: 'artifact-1' };
    await expect(executor.execute('artifact.access.grants.list', input, context)).resolves.toMatchObject({ ok: true });
    removeArtifact();
    await expect(executor.execute('artifact.access.grants.list', input, context)).resolves.toEqual({
      ok: false, errorCode: 'artifact_not_found', error: 'artifact_not_found',
      failureCause: { errorClass: 'Error', errorCode: 'artifact_not_found', httpStatus: null, phase: 'dispatch' },
    });
    failRead(Object.assign(new Error('unexpected_storage_failure'), { code: 'unexpected_storage_failure' }));
    await expect(executor.execute('artifact.access.grants.list', input, context)).resolves.toEqual({
      ok: false, errorCode: 'action_failed', error: 'unexpected_storage_failure',
      failureCause: { errorClass: 'Error', errorCode: 'unexpected_storage_failure', httpStatus: null, phase: 'dispatch' },
    });
  });
  it('persists and lists semantic grants through the canonical Action and kind owners', async () => {
    const { executor, readGrants } = createFixture();
    const input = { artifactId: 'artifact-1', principal: { kind: 'team', teamId: 'team-1' }, accessLevel: 'edit' };
    await expect(executor.execute('artifact.access.grants.set', input, context)).resolves.toMatchObject({ ok: true, result: { changed: true } });
    expect(readGrants()).toMatchObject([{ principal: input.principal, accessLevel: 'edit' }]);
    await expect(executor.execute('artifact.access.grants.list', { artifactId: 'artifact-1' }, context)).resolves.toMatchObject({ ok: true, result: { grants: readGrants() } });
    await expect(executor.execute('artifact.access.grants.remove', { artifactId: 'artifact-1', principal: input.principal }, context)).resolves.toMatchObject({ ok: true, result: { changed: true } });
    expect(readGrants()).toEqual([]);
  });

  it('admits an account-automation caller like Session access grants (agents reach it through the shared approval policy)', async () => {
    const { executor, readGrants } = createFixture();
    const result = await executor.execute('artifact.access.grants.set', { artifactId: 'artifact-1', principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view' }, {
      ...context, authority: 'account_automation',
    });
    expect(result).toMatchObject({ ok: true, result: { changed: true } });
    expect(readGrants()).toHaveLength(1);
  });

  it('does not allow prepared envelopes through public semantic Action inputs', async () => {
    const { executor, readGrants } = createFixture();
    const result = await executor.execute('artifact.access.grants.set', {
      artifactId: 'artifact-1', principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view',
      recipientKeyEnvelopes: [],
    }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(readGrants()).toEqual([]);
  });
});

describe('document sharing surfaces (INT review F-18)', () => {
  it('lets agents and MCP call document sharing under the same approval policy as Session access grants', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const sessionGrant = getActionSpec('session.access.grant.set');
    for (const id of ['artifact.access.grants.list', 'artifact.access.grants.set', 'artifact.access.grants.remove'] as const) {
      const spec = getActionSpec(id);
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true });
      expect(spec.requiredAuthority).toBe(sessionGrant.requiredAuthority);
    }
    // Widening access still asks: mutations keep the danger safety the shared approval policy reads.
    expect(getActionSpec('artifact.access.grants.set').safety).toBe(sessionGrant.safety);
    expect(getActionSpec('artifact.access.grants.remove').safety).toBe('danger');
    expect(getActionSpec('artifact.access.grants.list').safety).toBe('safe');
  });
});
