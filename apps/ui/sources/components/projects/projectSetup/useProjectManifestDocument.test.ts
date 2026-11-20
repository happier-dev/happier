import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type { ProjectSetupSetInputV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProjectManifestActionClient } from './projectManifestActionClient';
import { useProjectManifestDocument, type ProjectManifestDocumentInput } from './useProjectManifestDocument';

const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/repo' };
const repositoryBytes = '{"version":1,"scripts":{"build":{"source":{"kind":"command","command":"repo"}}}}';
const repositoryDefinition = { basis: { kind: 'present' as const, hash: 'a'.repeat(64) }, document: readProjectManifestDocument(repositoryBytes) };
const projectRef = { serverId: 'home', projectKey: 'project' };
const pointer = { artifactId: 'private-setup', headerVersion: 1, bodyVersion: 2 };
const personal = { projectRef, revision: 7, organization: { setupContent: pointer } };
const inheritedRequirements = [{ name: 'TOKEN', kind: 'secret' as const, required: true }];
const inspect = { definition: { basis: { kind: 'absent' }, document: null },
  detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
  environmentImport: { kind: 'environment', file: '.env.example', diagnostics: [], requirements: [
    { name: 'TOKEN', kind: 'config', required: false }, { name: 'PORT', kind: 'config', required: false },
  ] } };
function artifact(bodyVersion = 2) {
  return { artifactId: pointer.artifactId, ownerAccountId: 'alice', access: 'owner', publicAudience: 'none',
    header: { kind: 'project_setup.v1' }, revision: { headerVersion: 1, bodyVersion }, seq: 1, createdAt: 1, updatedAt: 1,
    body: JSON.stringify({ kind: 'project_setup.v1', setupOverrides: { version: 1,
      environmentVariables: [{ name: 'AUTHORED', kind: 'config', required: true }] } }) };
}
function client(overrides: Parameters<typeof createActionExecutorBoundaryFixture>[0], scope = { workspace, accountId: 'alice' }) {
  return createProjectManifestActionClient({ workspace: scope.workspace, expectedAccountId: scope.accountId, execute:
    createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture(overrides), scope.accountId)) });
}

afterEach(() => standardCleanup());

describe('Project manifest document target controller', () => {
  it('loads Personal only on demand, imports names without shadowing inherited secrets, and saves its row CAS', async () => {
    const requests: Array<{ actionId: string; input: unknown; accountId?: string; serverId?: string }> = [];
    const writes: ProjectSetupSetInputV1[] = [];
    const actions = client({
      artifactAction: async request => { requests.push({ actionId: request.actionId, input: request.input,
        accountId: request.context?.expectedAccountId ?? undefined, serverId: request.context?.serverId ?? undefined }); return { artifact: artifact() }; },
      projectDefinitionAction: async request => { requests.push({ actionId: request.actionId, input: request.input }); return inspect; },
      projectsSetupSet: async ({ input }) => { writes.push(input); return { ok: true, row: personal.organization, revision: 8,
        effectiveDefinition: { effectiveManifest: null, origins: [] } }; },
    });
    const input: ProjectManifestDocumentInput = { workspace, accountId: 'alice', client: actions,
      repositoryDefinition, personal, inheritedRequirements };
    // A rendered caller may recreate the captured row wrapper without changing its revision.
    const hook = await renderHook(() => useProjectManifestDocument({ ...input, personal: { ...personal } }));
    expect(hook.getCurrent().target).toBe('repository');
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).toBe(repositoryBytes);
    expect(requests).toEqual([]);
    act(() => { hook.getCurrent().model!.setRaw('{"version":1,"description":"repo draft"}'); });
    await act(async () => { hook.getCurrent().selectTarget('personal'); });
    expect(hook.getCurrent()).toMatchObject({ loading: false, error: null });
    expect(hook.getCurrent().model?.getSnapshot().draft).toMatchObject({ status: 'valid', manifest: {
      environmentVariables: [{ name: 'AUTHORED', kind: 'config', required: true }],
    } });
    expect(requests).toEqual([{ actionId: 'artifact.get', input: { artifactId: pointer.artifactId }, accountId: 'alice', serverId: 'home' }]);
    await act(async () => { expect(await hook.getCurrent().importEnvironmentNames()).toBe(true); });
    expect(hook.getCurrent().environmentImport).toEqual(inspect.environmentImport);
    expect(hook.getCurrent().model?.getSnapshot().draft).toMatchObject({ manifest: { environmentVariables: [
      { name: 'AUTHORED', kind: 'config', required: true }, { name: 'PORT', kind: 'config', required: false },
    ] } });
    expect(requests.at(-1)).toEqual({ actionId: 'projects.inspect', input: { workspace, read: { kind: 'imports' } } });
    await act(async () => { expect((await hook.getCurrent().save())?.status).toBe('saved'); });
    expect(writes).toEqual([{ workspace, projectRef, expectedRevision: 7,
      intent: { kind: 'personal', setupOverrides: { version: 1, environmentVariables: [
        { name: 'AUTHORED', kind: 'config', required: true }, { name: 'PORT', kind: 'config', required: false },
      ] } } }]);
    act(() => { hook.getCurrent().selectTarget('repository'); });
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).toContain('repo draft');
    act(() => { hook.getCurrent().selectTarget('personal'); });
    expect(hook.getCurrent().model?.getSnapshot().dirty).toBe(false);
    expect(requests.filter(request => request.actionId === 'artifact.get')).toHaveLength(1);
  });

  it('keeps a dirty Personal draft on a newer row and requires reviewing that actual CAS basis', async () => {
    let bodyVersion = 2;
    const writes: ProjectSetupSetInputV1[] = [];
    const scopedWorkspace = { ...workspace, rootPath: '/outside-change' };
    const actions = client({ artifactAction: async () => ({ artifact: artifact(bodyVersion) }),
      projectsSetupSet: async ({ input }) => { writes.push(input); return { ok: true, row: {}, revision: 10,
        effectiveDefinition: { effectiveManifest: null, origins: [] } }; } }, { workspace: scopedWorkspace, accountId: 'alice' });
    const input: ProjectManifestDocumentInput = { workspace: scopedWorkspace, accountId: 'alice',
      client: actions, repositoryDefinition, personal };
    const hook = await renderHook(props => useProjectManifestDocument(props), { initialProps: input });
    await act(async () => { hook.getCurrent().selectTarget('personal'); });
    act(() => { hook.getCurrent().model!.setRaw('{"version":1,"scripts":{"build":{"source":{"kind":"command","command":"personal draft"}}}}'); });
    bodyVersion = 3;
    await hook.rerender({ ...input, personal: { ...personal, revision: 9,
      organization: { setupContent: { ...pointer, bodyVersion } } } });
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).toContain('personal draft');
    expect(hook.getCurrent().model?.getSnapshot().conflict?.basis).toEqual({ kind: 'personal', revision: 9 });
    await act(async () => { expect(await hook.getCurrent().save()).toBeNull(); });
    expect(writes).toEqual([]);
    act(() => { hook.getCurrent().model!.reviewCurrentBasis(); });
    await act(async () => { await hook.getCurrent().save(); });
    expect(writes[0]).toMatchObject({ expectedRevision: 9, intent: { kind: 'personal', setupOverrides: { scripts: { build: { source: { kind: 'command', command: 'personal draft' } } } } } });
  });

  it('opens a Project with no personal changes yet as a clean, unsaved-free draft (live L6, 1120)', async () => {
    const scopedWorkspace = { ...workspace, rootPath: '/no-personal-setup' };
    const actions = client({}, { workspace: scopedWorkspace, accountId: 'alice' });
    const hook = await renderHook(() => useProjectManifestDocument({ workspace: scopedWorkspace, accountId: 'alice',
      client: actions, repositoryDefinition, personal: { projectRef, revision: 'absent', organization: {} } }));
    await act(async () => { hook.getCurrent().selectTarget('personal'); });
    expect(hook.getCurrent()).toMatchObject({ target: 'personal', loading: false, error: null });
    expect(hook.getCurrent().model?.getSnapshot()).toMatchObject({ dirty: false, draft: { status: 'valid' } });
  });

  it('preserves repository editing when the protected Personal detail is unavailable', async () => {
    const scopedWorkspace = { ...workspace, rootPath: '/unavailable' };
    const actions = client({ artifactAction: async () => ({ artifact: artifact(99) }) }, { workspace: scopedWorkspace, accountId: 'alice' });
    const hook = await renderHook(() => useProjectManifestDocument({ workspace: scopedWorkspace,
      accountId: 'alice', client: actions, repositoryDefinition, personal }));
    await act(async () => { hook.getCurrent().selectTarget('personal'); });
    expect(hook.getCurrent()).toMatchObject({ target: 'personal', model: null, loading: false, error: 'project_setup_review_unavailable' });
    expect(await hook.getCurrent().save()).toBeNull();
    act(() => { hook.getCurrent().selectTarget('repository'); });
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).toBe(repositoryBytes);
  });
  it('binds Personal drafts and writes to the selected Project identity when its row changes', async () => {
    const nextDetail = createDeferred<void>();
    let reads = 0;
    const writes: ProjectSetupSetInputV1[] = [];
    const scopedWorkspace = { ...workspace, rootPath: '/changed-project' };
    const actions = client({ artifactAction: async () => {
      if (++reads === 2) await nextDetail.promise;
      return { artifact: artifact() };
    }, projectsSetupSet: async ({ input }) => { writes.push(input); return { ok: true, row: {}, revision: 8,
      effectiveDefinition: { effectiveManifest: null, origins: [] } }; } }, { workspace: scopedWorkspace, accountId: 'alice' });
    const input: ProjectManifestDocumentInput = { workspace: scopedWorkspace, accountId: 'alice',
      client: actions, repositoryDefinition, personal };
    const hook = await renderHook(props => useProjectManifestDocument(props), { initialProps: input });
    await act(async () => { hook.getCurrent().selectTarget('personal'); });
    const firstModel = hook.getCurrent().model!;
    act(() => { firstModel.setRaw('{"version":1,"scripts":{"build":{"source":{"kind":"command","command":"first Project draft"}}}}'); });
    const nextPersonal = { ...personal, projectRef: { ...projectRef, projectKey: 'next-project' } };
    await hook.rerender({ ...input, personal: nextPersonal });
    expect(hook.getCurrent()).toMatchObject({ loading: true, model: null });
    await act(async () => { nextDetail.resolve(); });
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).not.toContain('first Project draft');
    act(() => { hook.getCurrent().model!.setRaw('{"version":1,"scripts":{"build":{"source":{"kind":"command","command":"second Project draft"}}}}'); });
    await act(async () => { await hook.getCurrent().save(); });
    expect(writes).toMatchObject([{ projectRef: nextPersonal.projectRef, expectedRevision: 7,
      intent: { kind: 'personal', setupOverrides: { scripts: { build: { source: { command: 'second Project draft' } } } } } }]);
    await hook.rerender(input);
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).toContain('first Project draft');
  });

  it.each(['offer', 'failure'] as const)('keeps completed and late old-Home import %s state out of a new Account/workspace', async outcome => {
    const oldPending = createDeferred<void>();
    const newPending = createDeferred<void>();
    let oldReads = 0;
    const oldWorkspace = { ...workspace, rootPath: `/old-home-${outcome}` };
    const oldActions = client({ projectDefinitionAction: async () => {
      if (++oldReads === 2) await oldPending.promise;
      if (outcome === 'failure') throw new Error('Old Home unavailable');
      return { ...inspect, environmentImport: { ...inspect.environmentImport, requirements: [{ name: 'OLD_HOME', kind: 'config', required: false }] } };
    } }, { workspace: oldWorkspace, accountId: 'alice' });
    const newWorkspace = { ...workspace, serverId: 'other-home', rootPath: `/other-account-${outcome}` };
    const newActions = client({ projectDefinitionAction: async () => {
      await newPending.promise;
      return { ...inspect, environmentImport: { ...inspect.environmentImport, requirements: [{ name: 'NEW_HOME', kind: 'config', required: false }] } };
    } }, { workspace: newWorkspace, accountId: 'bob' });
    const input: ProjectManifestDocumentInput = { workspace: oldWorkspace, accountId: 'alice',
      client: oldActions, repositoryDefinition, personal: null };
    const hook = await renderHook(props => useProjectManifestDocument(props), { initialProps: input });
    await act(async () => { await hook.getCurrent().importEnvironmentNames(); });
    if (outcome === 'offer') expect(hook.getCurrent().environmentImport?.requirements[0]?.name).toBe('OLD_HOME');
    else expect(hook.getCurrent().error).not.toBeNull();
    let oldRequest: Promise<boolean> | null = null;
    act(() => { oldRequest = hook.getCurrent().importEnvironmentNames(); });
    expect(hook.getCurrent().importing).toBe(true);
    await hook.rerender({ ...input, workspace: newWorkspace, accountId: 'bob', client: newActions });
    expect(hook.getCurrent()).toMatchObject({ environmentImport: null, error: null, importing: false });
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).toBe(repositoryBytes);
    let newRequest: Promise<boolean> | null = null;
    act(() => { newRequest = hook.getCurrent().importEnvironmentNames(); });
    expect(hook.getCurrent().importing).toBe(true);
    await act(async () => { oldPending.resolve(); await oldRequest; });
    expect(hook.getCurrent()).toMatchObject({ environmentImport: null, error: null, importing: true });
    expect(hook.getCurrent().model?.getSnapshot().draft.bytes).toBe(repositoryBytes);
    await act(async () => { newPending.resolve(); await newRequest; });
    expect(hook.getCurrent()).toMatchObject({ error: null, importing: false, environmentImport: { requirements: [{ name: 'NEW_HOME' }] } });
    expect(hook.getCurrent().model?.getSnapshot().draft).toMatchObject({ manifest: { environmentVariables: [{ name: 'NEW_HOME' }] } });
  });

});
