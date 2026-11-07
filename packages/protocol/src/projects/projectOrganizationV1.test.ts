import { describe, expect, it } from 'vitest';
import { ProjectAccountOrganizationV1Schema, type ProjectAccountOrganizationV1 } from './projectAccountRowsV1.js';
import { ProjectOrganizationUpdateInputV1Schema, ProjectOrganizationUpdateOutputV1Schema, updateProjectOrganizationV1 } from './projectOrganizationV1.js';
import type { ProjectContextActionOwnerDepsV1 } from './projectContextV1.js';

const projectRef = { serverId: 'home', projectKey: 'project' };
const personal = { ref: 'personal-secret' };
const shared = { ref: 'happier:shared-secret:v1:resource', revision: 2 };

function harness(initial: ProjectAccountOrganizationV1) {
  let value = initial;
  let revision = 3;
  let accountId = 'account';
  const deps: Pick<ProjectContextActionOwnerDepsV1, 'accountScope' | 'mutateOrganization'> = {
    accountScope: () => ({ serverId: 'home', accountId }),
    // In-memory persistent CAS boundary; the mutation and all schemas remain real.
    mutateOrganization: async input => {
      if (input.expectedRevision !== revision) return { status: 'conflict', revision };
      value = ProjectAccountOrganizationV1Schema.parse(input.mutate(value));
      return { status: 'updated', revision: ++revision, value };
    },
  };
  return { deps, current: () => ({ value, revision }), switchAccount: () => { accountId = 'other'; } };
}

describe('Project organization reference bindings', () => {
  it('sets, replaces and removes one binding while preserving the label and unrelated organization fields', async () => {
    const initial = { label: 'Project', hidden: true, pinned: true, atmosphere: 'home' } as const;
    const fixture = harness(initial);
    const update = (name: string, reference: typeof personal | typeof shared | null, label?: string | null) =>
      updateProjectOrganizationV1(fixture.deps, ProjectOrganizationUpdateInputV1Schema.parse({ projectRef,
        expectedRevision: fixture.current().revision, environmentBinding: { name, reference },
        ...(label === undefined ? {} : { label }),
      }));
    expect(ProjectOrganizationUpdateOutputV1Schema.parse(await update('API_KEY', personal)))
      .toMatchObject({ ok: true, row: { ...initial, environmentBindings: { v: 1, bindings: { API_KEY: personal } } } });
    await update('OTHER_KEY', personal);
    await update('API_KEY', shared, 'Renamed');
    expect(fixture.current().value).toEqual({ ...initial, label: 'Renamed',
      environmentBindings: { v: 1, bindings: { API_KEY: shared, OTHER_KEY: personal } } });
    await updateProjectOrganizationV1(fixture.deps, { projectRef, expectedRevision: fixture.current().revision, label: 'Label only' });
    expect(fixture.current().value).toEqual({ ...initial, label: 'Label only',
      environmentBindings: { v: 1, bindings: { API_KEY: shared, OTHER_KEY: personal } } });
    await update('API_KEY', null, null);
    expect(fixture.current().value).toEqual({ hidden: true, pinned: true, atmosphere: 'home',
      environmentBindings: { v: 1, bindings: { OTHER_KEY: personal } } });
    await update('OTHER_KEY', null);
    expect(fixture.current().value).toEqual({ hidden: true, pinned: true, atmosphere: 'home' });
  });

  it('keeps reference semantics and rejects empty edits, plaintext, malformed names and unknown operands', () => {
    const input = { projectRef, expectedRevision: 3 };
    expect(ProjectOrganizationUpdateInputV1Schema.safeParse(input).success).toBe(false);
    expect(ProjectOrganizationUpdateInputV1Schema.safeParse({ ...input, label: null }).success).toBe(true);
    for (const environmentBinding of [
      { name: 'API_KEY', reference: personal }, { name: 'API_KEY', reference: shared },
      { name: 'API_KEY', reference: null },
    ]) expect(ProjectOrganizationUpdateInputV1Schema.safeParse({ ...input, environmentBinding }).success).toBe(true);
    for (const environmentBinding of [
      { name: 'API_KEY', reference: { ref: shared.ref } },
      { name: 'API_KEY', reference: { ...personal, revision: 2 } },
      { name: 'API_KEY', reference: { ...personal, value: 'secret' } },
      { name: 'INVALID-NAME', reference: personal },
      { name: 'API_KEY', reference: personal, value: 'secret' },
    ]) expect(ProjectOrganizationUpdateInputV1Schema.safeParse({ ...input, environmentBinding }).success).toBe(false);
    expect(ProjectOrganizationUpdateInputV1Schema.safeParse({ ...input, label: 'Project', env: { API_KEY: 'secret' } }).success).toBe(false);
  });

  it('retains the existing exact CAS and Account-scope protections for binding edits', async () => {
    const fixture = harness({ pinned: true });
    const input = ProjectOrganizationUpdateInputV1Schema.parse({ projectRef, expectedRevision: 2,
      environmentBinding: { name: 'API_KEY', reference: personal } });
    expect(await updateProjectOrganizationV1(fixture.deps, input)).toEqual({ ok: false,
      errorCode: 'project_organization_conflict', currentRevision: 3 });
    expect(await updateProjectOrganizationV1(fixture.deps, { ...input, projectRef: { ...projectRef, serverId: 'other' } }))
      .toEqual({ ok: false, errorCode: 'project_organization_access_denied' });
    expect(await updateProjectOrganizationV1({ ...fixture.deps, mutateOrganization: async request => {
      fixture.switchAccount();
      return fixture.deps.mutateOrganization(request);
    } }, { ...input, expectedRevision: 3 })).toEqual({ ok: false, errorCode: 'project_organization_access_denied' });
    expect(fixture.current()).toEqual({ value: { pinned: true }, revision: 3 });
  });
});
