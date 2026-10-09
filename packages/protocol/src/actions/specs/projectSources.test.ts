import { describe, expect, it } from 'vitest';
import { getActionSpec, listActionSpecsForSurface } from '../actionSpecs.js';
import { resolveActionApprovalRouting } from '../actionApprovalPolicy.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { updatePersonalProjectContextV1 } from '../../projects/projectContextV1.js';
import { ProjectAccountOrganizationV1Schema } from '../../projects/projectAccountRowsV1.js';

describe('Project Source Action admission', () => {
  it('runs personal context edits through the Account owner without an answering client', async () => {
    const spec = getActionSpec('projects.context.update');
    expect(spec.executionPlacement).toBe('account');
    expect(spec.safety).toBe('safe');
    expect(spec.approval).toEqual({ result: 'required' });
    expect(listActionSpecsForSurface('cli').some(row => row.id === spec.id)).toBe(true);
    const row = ProjectAccountOrganizationV1Schema.parse({
      hidden: true, pinned: true,
      promptStack: [{ id: 'context', ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' }, placement: 'system_append' }],
    });
    const deps = {
      // Reverse RPC and persistent row transport are genuine system boundaries.
      clientActionExecute: async () => ({ ok: false as const, errorCode: 'client_unavailable', error: 'client_unavailable' }),
      projectsContextUpdate: (input, context) => updatePersonalProjectContextV1({
        accountScope: () => ({ serverId: 'home', accountId: 'alice' }),
        readArtifact: async () => null,
        mutateOrganization: async ({ mutate }) => ({ status: 'updated', revision: 1, value: mutate(row) }),
      }, input, context),
    } satisfies Pick<ActionExecutorDeps, 'clientActionExecute' | 'projectsContextUpdate'>;
    // Only this Action's transport ports are reachable in this boundary fixture.
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute(spec.id, {
      target: { serverId: 'home', projectKey: 'repo' }, expectedRevision: 0,
      intent: { kind: 'detach', entryId: 'context' },
    }, { surface: 'cli', authority: 'account_automation', serverId: 'home' })).toMatchObject({
      ok: true, result: { ok: true, revision: 1, row: { hidden: true, pinned: true, promptStack: [] } },
    });
  });

  it('loads the catalog and preserves required results and confirmation for Source writes', () => {
    for (const [id, mutates] of [
      ['projects.sources.list', false],
      ['projects.sources.read', false],
      ['projects.sources.create', true],
      ['projects.sources.update', true],
      ['projects.sources.delete', true],
    ] as const) {
      const spec = getActionSpec(id);
      expect(spec.approval).toEqual({ result: 'required' });
      expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface: 'agent' } }).required)
        .toBe(mutates);
    }
  });
});
