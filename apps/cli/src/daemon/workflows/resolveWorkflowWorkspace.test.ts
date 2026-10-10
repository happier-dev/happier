import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkflowBlock, WorkflowDefinitionV1, WorkflowMaterializedLeafV1 } from '@happier-dev/protocol/workflows';

import {  WorkflowRuntimeInterruption, workflowInvocationKey } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import {
  createCoordinatorWorkspaceResolver,
  prepareWorkflowAcceptedWorkspaceTarget,
  resolveWorkflowWorkspace,
  restoreRecordedWorkflowWorkspace,
  verifyWorkflowWorkspaceCurrentness,
  type WorkflowWorkspaceCreationIntent,
  type WorkflowWorkspaceDescriptor,
} from './resolveWorkflowWorkspace';
import { createGitWorkflowWorkspaceTestDependencies } from './workflowWorkspace.testkit';

describe('recorded Workflow workspace restoration', () => {
  it('accepts only the intact dirty recorded Git worktree and refuses deletion or same-path replacement', async () => {
    const fixture = await createTemporaryGitProject();
    const git = createGitWorkflowWorkspaceTestDependencies();
    try {
      let creationIntent: WorkflowWorkspaceCreationIntent | undefined;
      const created = await resolveWorkflowWorkspace({
        selection: { kind: 'new_worktree', source: { kind: 'workflow' } },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace: {
          machineId: 'machine-1',
          directory: fixture.projectDirectory,
          checkoutRootPath: fixture.root,
        },
        runId: 'run-restore',
        logicalInvocationRecordId: 'step',
        deps: {
          ...git,
          persistCreationIntent: async (intent) => { creationIntent = intent; },
        },
      });
      if (!created.ok || !creationIntent) throw new Error('Git test fixture did not materialize a Workflow worktree');
      const workspace = { creationIntent, descriptor: created.workspace };
      await writeFile(join(created.workspace.checkoutRootPath, 'staged.txt'), 'staged\n', 'utf8');
      await execFileAsync('git', ['add', 'staged.txt'], { cwd: created.workspace.checkoutRootPath });
      await writeFile(join(created.workspace.checkoutRootPath, 'unstaged.txt'), 'unstaged\n', 'utf8');
      await writeFile(join(created.workspace.checkoutRootPath, 'untracked.txt'), 'untracked\n', 'utf8');
      const dirtyStatus = (await execFileAsync('git', ['status', '--short'], { cwd: created.workspace.checkoutRootPath })).stdout;

      await expect(restoreRecordedWorkflowWorkspace({
        workspace,
        verify: git.verifyRecordedWorkspace,
      })).resolves.toEqual({ ok: true });
      expect((await execFileAsync('git', ['status', '--short'], { cwd: created.workspace.checkoutRootPath })).stdout).toBe(dirtyStatus);

      // The agent may rename its branch while preserving the exact recorded
      // path, repository identity, and dirty contents. Recovery intentionally
      // does not require branch-name equality.
      await execFileAsync('git', ['branch', '-m', 'renamed-after-recording'], { cwd: created.workspace.checkoutRootPath });
      await expect(restoreRecordedWorkflowWorkspace({
        workspace,
        verify: git.verifyRecordedWorkspace,
      })).resolves.toEqual({ ok: true });
      expect((await execFileAsync('git', ['status', '--short'], { cwd: created.workspace.checkoutRootPath })).stdout).toBe(dirtyStatus);

      await rm(created.workspace.checkoutRootPath, { recursive: true, force: true });
      await expect(restoreRecordedWorkflowWorkspace({ workspace, verify: git.verifyRecordedWorkspace })).resolves.toEqual({
        ok: false,
        code: 'workflow_workspace_restore_unavailable',
      });

      await mkdir(created.workspace.checkoutRootPath, { recursive: true });
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: created.workspace.checkoutRootPath });
      await writeFile(join(created.workspace.checkoutRootPath, 'replacement.txt'), 'replacement\n', 'utf8');
      await expect(restoreRecordedWorkflowWorkspace({ workspace, verify: git.verifyRecordedWorkspace })).resolves.toEqual({
        ok: false,
        code: 'workflow_workspace_restore_unavailable',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

const project: WorkflowWorkspaceDescriptor = {
  machineId: 'machine-1', directory: '/repo/packages/app', checkoutRootPath: '/repo', workspaceRefId: 'workspace-1',
};

const execFileAsync = promisify(execFile);
const noProducerBinding = { resolve: async () => undefined };

async function createTemporaryGitProject() {
  const root = await mkdtemp(join(tmpdir(), 'happier-workflow-workspace-'));
  const projectDirectory = join(root, 'packages', 'app');
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(join(root, 'README.md'), 'original\n', 'utf8');
  await writeFile(join(projectDirectory, 'index.ts'), 'export const fixture = true;\n', 'utf8');
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: root });
  await execFileAsync('git', ['add', 'README.md', 'packages/app/index.ts'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Workflow Test',
    '-c', 'user.email=workflow-test@example.invalid',
    'commit', '-m', 'test: seed workflow workspace',
  ], { cwd: root });
  const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await writeFile(join(root, 'README.md'), 'staged\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: root });
  await writeFile(join(root, 'README.md'), 'unstaged-after-staged\n', 'utf8');
  await writeFile(join(root, 'untracked.txt'), 'untracked\n', 'utf8');
  const dirtyStatus = (await execFileAsync('git', ['status', '--short'], { cwd: root })).stdout;
  return { root, projectDirectory, revision, dirtyStatus };
}

describe('resolveWorkflowWorkspace', () => {
  it('preserves a predecessor worktree name and named base ref through the real SCM boundary', async () => {
    const fixture = await createTemporaryGitProject();
    try {
      const git = createGitWorkflowWorkspaceTestDependencies();
      let intent: WorkflowWorkspaceCreationIntent | undefined;
      const result = await resolveWorkflowWorkspace({
        selection: { kind: 'new_worktree', source: { kind: 'workflow' }, displayName: 'daily-check', baseRef: 'main' },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace: { machineId: 'machine-1', directory: fixture.projectDirectory, checkoutRootPath: fixture.root },
        runId: 'retained-automation', logicalInvocationRecordId: 'prompt',
        deps: { ...git, persistCreationIntent: async value => { intent = value; } },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(intent).toMatchObject({ displayName: 'daily-check', baseRef: 'main' });
      expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: result.workspace.checkoutRootPath })).stdout.trim())
        .toBe(fixture.revision);
      expect((await execFileAsync('git', ['status', '--short', '--', 'README.md', 'untracked.txt', 'packages/app/index.ts'], { cwd: fixture.root })).stdout)
        .toBe(fixture.dirtyStatus);
      expect((await execFileAsync('git', ['show', ':README.md'], { cwd: fixture.root })).stdout).toBe('staged\n');
      expect(await readFile(join(fixture.root, 'README.md'), 'utf8')).toBe('unstaged-after-staged\n');
      expect(await readFile(join(fixture.root, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('finds original-revision workspace selections through deeply nested authored blocks', async () => {
    let block: WorkflowBlock = { kind: 'wait', id: 'original',
      document: { text: 'Continue', references: [], attachments: [] },
      execution: { workspace: { kind: 'new_worktree', source: { kind: 'original' } } } };
    for (let depth = 0; depth < 12_000; depth += 1) {
      block = { kind: 'if', id: `branch-${depth}`,
        when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [block], otherwise: [] };
    }
    const prepare = (committedRevision?: string) => prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory: '/repo' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [block] },
      pathIsDirectory: async () => true,
      inspectLocation: async () => ({ inspection: { rootPath: '/repo', ...(committedRevision ? { committedRevision } : {}) } }),
    });
    await expect(prepare()).resolves.toEqual({ ok: false, code: 'committed_revision_unavailable' });
    await expect(prepare('a'.repeat(40))).resolves.toMatchObject({ ok: true,
      workspaceTarget: { originalCommittedRevision: 'a'.repeat(40) },
    });
  });
  it.each<Extract<WorkflowBlock, { kind: 'action' | 'wait' | 'workflow' }>>([
    { kind: 'action', id: 'action', actionId: 'session.goal.set', input: {} },
    { kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } },
    { kind: 'workflow', id: 'workflow', workflowRef: 'builtin:child', input: {} },
  ])('prepares the authored $kind workspace without treating the leaf as a Loop', async (leaf) => {
    const prepare = (block: typeof leaf, committedRevision?: string) => prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory: '/repo' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [block] },
      // Filesystem existence and SCM inspection are the genuine boundaries.
      pathIsDirectory: async () => true,
      inspectLocation: async () => ({ inspection: { rootPath: '/repo', ...(committedRevision ? { committedRevision } : {}) } }),
    });
    await expect(prepare(leaf)).resolves.toEqual({ ok: true,
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
    });
    const authoredOriginal = { ...leaf, execution: { workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } } } };
    await expect(prepare(authoredOriginal)).resolves.toEqual({ ok: false, code: 'committed_revision_unavailable' });
    await expect(prepare(authoredOriginal, 'a'.repeat(40))).resolves.toMatchObject({ ok: true,
      workspaceTarget: { originalCommittedRevision: 'a'.repeat(40) },
    });
  });

  it('carries generated producer provenance through dirty reuse, committed fork and recorded rejoin', async () => {
    const fixture = await createTemporaryGitProject();
    const git = createGitWorkflowWorkspaceTestDependencies();
    try {
      const store = createInMemoryWorkflowCoordinatorStore();
      const projectWorkspace = { machineId: 'machine-1', directory: fixture.projectDirectory, checkoutRootPath: fixture.root };
      const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [] };
      const producer = { blockId: 'a', scope: { kind: 'current' as const } };
      const invocation = async (id: string) => {
        const key = workflowInvocationKey({ runId: 'run-pair', blockId: id, scope: [], attempt: 0 });
        return await store.ensureIntent({ key, recordId: `inv-${id}`, runId: 'run-pair', blockId: id,
          blockKind: 'step', path: { blockId: id, scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'admitting' });
      };
      const step = (id: string, workspace: Parameters<typeof resolveWorkflowWorkspace>[0]['selection']) => ({
        kind: 'step' as const, id, document: { text: id, references: [], attachments: [] }, input: [],
        result: { kind: 'text' as const }, execution: { workspace },
      });
      const resolve = createCoordinatorWorkspaceResolver({ store, projectWorkspace, scm: git });
      const a = await invocation('a');
      const created = await resolve({ runId: 'run-pair', definition, step: step('a', { kind: 'new_worktree', source: { kind: 'workflow' } }), invocation: a, scope: [], producerBinding: noProducerBinding });
      if (!created.ok) throw new Error(created.code);
      await writeFile(join(created.workspace.checkoutRootPath, 'README.md'), 'committed A\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: created.workspace.checkoutRootPath });
      await execFileAsync('git', ['-c', 'user.name=Workflow Test', '-c', 'user.email=workflow-test@example.invalid', 'commit', '-m', 'test: advance producer'], { cwd: created.workspace.checkoutRootPath });
      const sourceRevision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: created.workspace.checkoutRootPath })).stdout.trim();
      await writeFile(join(created.workspace.checkoutRootPath, 'README.md'), 'staged A\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: created.workspace.checkoutRootPath });
      await writeFile(join(created.workspace.checkoutRootPath, 'README.md'), 'unstaged A\n');
      await writeFile(join(created.workspace.checkoutRootPath, 'untracked-A.txt'), 'untracked A\n');
      const userPaths = ['README.md', 'untracked-A.txt'];
      const dirtyStatus = (await execFileAsync('git', ['status', '--short', '--', ...userPaths], { cwd: created.workspace.checkoutRootPath })).stdout;
      const stagedDiff = (await execFileAsync('git', ['diff', '--cached'], { cwd: created.workspace.checkoutRootPath })).stdout;
      const unstagedDiff = (await execFileAsync('git', ['diff'], { cwd: created.workspace.checkoutRootPath })).stdout;
      const producerBinding = { resolve: async () => await store.read(a.key) };
      const b = await invocation('b');
      const reused = await resolve({ runId: 'run-pair', definition, step: step('b', { kind: 'from_step', producer }), invocation: b, scope: [], producerBinding });
      expect(reused).toMatchObject({ ok: true, workspace: { directory: created.workspace.directory, sourceInvocation: { invocationRecordId: a.recordId } } });
      if (!reused.ok) throw new Error(reused.code);
      expect(store.records.get(b.key)?.workspace?.creationIntent).toEqual(store.records.get(a.key)?.workspace?.creationIntent);
      expect(await readFile(join(reused.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('unstaged A\n');
      expect(await readFile(join(reused.workspace.checkoutRootPath, 'untracked-A.txt'), 'utf8')).toBe('untracked A\n');
      const d = await invocation('d');
      const sessionBound = await resolve({
        runId: 'run-pair', definition,
        step: { ...step('d', { kind: 'inherit' }), execution: { conversation: { kind: 'from_step', producer } } },
        invocation: d, scope: [], producerBinding, useConversationWorkspace: true,
        conversationWorkspace: { machineId: 'machine-1', directory: created.workspace.directory },
      });
      expect(sessionBound).toEqual(reused);
      expect(store.records.get(d.key)?.workspace).toEqual(store.records.get(b.key)?.workspace);
      const c = await invocation('c');
      const forked = await resolve({ runId: 'run-pair', definition, step: step('c', { kind: 'new_worktree', source: { kind: 'step', producer } }), invocation: c, scope: [], producerBinding });
      expect(forked).toMatchObject({ ok: true, workspace: { sourceInvocation: { invocationRecordId: a.recordId } } });
      if (!forked.ok) throw new Error(forked.code);
      expect(await readFile(join(forked.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('committed A\n');
      await expect(readFile(join(forked.workspace.checkoutRootPath, 'untracked-A.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(store.records.get(c.key)?.workspace?.creationIntent?.baseRef).toBe(sourceRevision);
      const reopened = createInMemoryWorkflowCoordinatorStore();
      for (const record of store.records.values()) await reopened.ensureIntent({ ...record, blockKind: 'step' });
      const worktreesBeforeRejoin = (await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.root })).stdout;
      const rejoin = createCoordinatorWorkspaceResolver({ store: reopened, projectWorkspace, scm: git });
      for (const target of [b, c, d]) {
        const recorded = await reopened.read(target.key);
        if (!recorded) throw new Error('Missing recorded test row');
        const result = await rejoin({ runId: 'run-pair', definition, step: step(target.blockId, { kind: 'from_step', producer }), invocation: recorded, scope: [], producerBinding });
        expect(result).toEqual({ ok: true, workspace: recorded.workspace?.descriptor });
      }
      expect((await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.root })).stdout).toBe(worktreesBeforeRejoin);
      // SCM places a fork under the producer's .dev directory. Preserve the
      // user's work rather than requiring the generated directory to be absent.
      expect((await execFileAsync('git', ['status', '--short', '--', ...userPaths], { cwd: created.workspace.checkoutRootPath })).stdout).toBe(dirtyStatus);
      expect((await execFileAsync('git', ['diff', '--cached'], { cwd: created.workspace.checkoutRootPath })).stdout).toBe(stagedDiff);
      expect((await execFileAsync('git', ['diff'], { cwd: created.workspace.checkoutRootPath })).stdout).toBe(unstagedDiff);
      expect(await readFile(join(created.workspace.checkoutRootPath, 'untracked-A.txt'), 'utf8')).toBe('untracked A\n');
      await rm(forked.workspace.checkoutRootPath, { recursive: true, force: true });
      const missing = await reopened.read(c.key);
      if (!missing) throw new Error('Missing recorded test row');
      expect(await rejoin({ runId: 'run-pair', definition, step: step('c', { kind: 'from_step', producer }), invocation: missing, scope: [], producerBinding })).toEqual({ ok: false, code: 'workspace_unavailable' });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('freezes the canonical nested project directory and original committed revision before admission', async () => {
    const inspectLocation = vi.fn(async () => ({
      inspection: {
        rootPath: '/repo',
        committedRevision: 'a'.repeat(40),
      },
    }));
    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory: '/repo/packages/app', workspaceRefId: 'workspace-1' },
      definition: {
        version: 1,
        inputs: [],
        defaults: { workspace: { kind: 'new_worktree', source: { kind: 'original' } } },
        blocks: [],
      },
      pathIsDirectory: async () => true,
      inspectLocation,
      currentServerId: 'server-1',
      resolveWorkspaceRef: () => ({
        id: 'workspace-1', serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo', createdAtMs: 1,
      }),
    })).resolves.toEqual({
      ok: true,
      workspaceTarget: {
        project,
        originalCommittedRevision: 'a'.repeat(40),
      },
    });
    expect(inspectLocation).toHaveBeenCalledWith({ candidatePath: '/repo/packages/app' });
  });

  it('requires a committed revision only when the accepted workflow forks from original', async () => {
    const prepare = (definition: Parameters<typeof prepareWorkflowAcceptedWorkspaceTarget>[0]['definition']) => (
      prepareWorkflowAcceptedWorkspaceTarget({
        projectTarget: { machineId: 'machine-1', directory: '/repo/packages/app' },
        definition,
        pathIsDirectory: async () => true,
        inspectLocation: async () => ({ inspection: { rootPath: '/repo' } }),
      })
    );

    await expect(prepare({
      version: 1,
      inputs: [],
      defaults: { workspace: { kind: 'new_worktree', source: { kind: 'original' } } },
      blocks: [],
    })).resolves.toEqual({ ok: false, code: 'committed_revision_unavailable' });

    await expect(prepare({
      version: 1,
      inputs: [],
      defaults: { workspace: { kind: 'project_checkout' } },
      blocks: [],
    })).resolves.toEqual({
      ok: true,
      workspaceTarget: {
        project: {
          machineId: 'machine-1',
          directory: '/repo/packages/app',
          checkoutRootPath: '/repo',
        },
      },
    });
  });

  it('rejects a stale Account workspace identity before accepting the project target', async () => {
    const inspectLocation = vi.fn(async () => ({
      inspection: { rootPath: '/repo', committedRevision: 'a'.repeat(40) },
    }));
    const resolveWorkspaceRef = vi.fn(() => ({
      id: 'workspace-1',
      serverId: 'server-1',
      machineId: 'machine-2',
      rootPath: '/repo',
      createdAtMs: 1,
    }));

    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory: '/repo/packages/app', workspaceRefId: 'workspace-1' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
      currentServerId: 'server-1',
      pathIsDirectory: async () => true,
      inspectLocation,
      resolveWorkspaceRef,
    })).resolves.toEqual({ ok: false, code: 'workspace_conflict' });
    expect(resolveWorkspaceRef).toHaveBeenCalledWith('workspace-1');
  });

  it('rejects an Account workspace identity whose canonical root differs from the inspected checkout', async () => {
    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory: '/repo/packages/app', workspaceRefId: 'workspace-1' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
      currentServerId: 'server-1',
      pathIsDirectory: async () => true,
      inspectLocation: async () => ({ inspection: { rootPath: '/repo' } }),
      resolveWorkspaceRef: () => ({
        id: 'workspace-1', serverId: 'server-1', machineId: 'machine-1',
        rootPath: '/other-repo', createdAtMs: 1,
      }),
    })).resolves.toEqual({ ok: false, code: 'workspace_conflict' });
  });

  it.each([
    {
      name: 'Windows drive and mixed separators',
      platform: 'win32' as const,
      env: { USERPROFILE: 'C:\\Users\\alice' },
      directory: '~\\repo/packages\\app',
      rootPath: 'C:\\Users\\alice\\repo',
      expectedDirectory: 'C:\\Users\\alice\\repo\\packages\\app',
    },
    {
      name: 'Windows UNC path',
      platform: 'win32' as const,
      env: {},
      directory: '\\\\server\\share\\repo\\packages\\app',
      rootPath: '\\\\server\\share\\repo',
      expectedDirectory: '\\\\server\\share\\repo\\packages\\app',
    },
    {
      name: 'POSIX home-relative nested path',
      platform: 'darwin' as const,
      env: { HOME: '/Users/alice' },
      directory: '~/repo/packages/app',
      rootPath: '/Users/alice/repo',
      expectedDirectory: '/Users/alice/repo/packages/app',
    },
  ])('uses canonical target path handling for $name', async ({ platform, env, directory, rootPath, expectedDirectory }) => {
    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
      env: { ...env, NODE_ENV: 'test' },
      platform,
      pathIsDirectory: async (path) => path === expectedDirectory,
      inspectLocation: async ({ candidatePath }) => ({ inspection: { rootPath: candidatePath === expectedDirectory ? rootPath : '/wrong' } }),
    })).resolves.toEqual({
      ok: true,
      workspaceTarget: { project: { machineId: 'machine-1', directory: expectedDirectory, checkoutRootPath: rootPath } },
    });
  });

  it('does not treat a sibling-prefixed Windows home as the selected home', async () => {
    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory: 'C:\\Users\\alice2\\repo' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
      env: { NODE_ENV: 'test', USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
      pathIsDirectory: async (path) => path === 'C:\\Users\\alice2\\repo',
      inspectLocation: async () => ({ inspection: { rootPath: 'C:\\Users\\alice2\\repo' } }),
    })).resolves.toEqual({
      ok: true,
      workspaceTarget: { project: { machineId: 'machine-1', directory: 'C:\\Users\\alice2\\repo', checkoutRootPath: 'C:\\Users\\alice2\\repo' } },
    });
  });

  it('resolves inherit to the stable workflow default and from-step to the exact scoped invocation', async () => {
    const prior = { machineId: 'machine-1', directory: '/repo/.dev/worktree/a', checkoutRootPath: '/repo/.dev/worktree/a' };
    const resolveProducerWorkspace = vi.fn(async () => ({ descriptor: prior }));
    const deps = { resolveProducerWorkspace };

    await expect(resolveWorkflowWorkspace({ selection: { kind: 'inherit' }, defaultSelection: { kind: 'project_checkout' }, projectWorkspace: project, runId: 'run-1', logicalInvocationRecordId: 'inv-b', deps })).resolves.toEqual({ ok: true, workspace: project });
    await expect(resolveWorkflowWorkspace({ selection: { kind: 'from_step', producer: { blockId: 'a', scope: { kind: 'current' } } }, defaultSelection: { kind: 'project_checkout' }, projectWorkspace: project, runId: 'run-1', logicalInvocationRecordId: 'inv-b', deps })).resolves.toEqual({ ok: true, workspace: prior });
    expect(resolveProducerWorkspace).toHaveBeenCalledWith({ blockId: 'a', scope: { kind: 'current' } });
  });

  it('persists one revision-pinned creation intent before SCM materialization and rejoins it on retry', async () => {
    const persistCreationIntent = vi.fn(async (_intent: WorkflowWorkspaceCreationIntent) => undefined);
    const persistWorkspace = vi.fn(async () => undefined);
    const realizeWorktree = vi.fn(async () => ({ directory: '/repo/.dev/worktree/workflow-run-1-inv-a/packages/app', checkoutRootPath: '/repo/.dev/worktree/workflow-run-1-inv-a', branchName: 'workflow-run-1-inv-a' }));
    const deps = {
      inspectCommittedRevision: vi.fn(async () => 'a'.repeat(40)),
      realizeWorktree,
      persistCreationIntent,
      persistWorkspace,
    };
    const base = { selection: { kind: 'new_worktree', source: { kind: 'workflow' } } as const, defaultSelection: { kind: 'project_checkout' } as const, projectWorkspace: project, runId: 'run-1', logicalInvocationRecordId: 'inv-a', deps };

    const first = await resolveWorkflowWorkspace(base);
    expect(first.ok).toBe(true);
    expect(persistCreationIntent).toHaveBeenCalledBefore(realizeWorktree);
    expect(realizeWorktree).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'a'.repeat(40), displayName: 'workflow-run-1-inv-a' }));

    const recordedIntent = persistCreationIntent.mock.calls[0]![0];
    await resolveWorkflowWorkspace({ ...base, recorded: { creationIntent: recordedIntent } });
    expect(deps.inspectCommittedRevision).toHaveBeenCalledTimes(1);
    expect(realizeWorktree).toHaveBeenLastCalledWith(recordedIntent);
  });

  it('returns typed preflight and unavailable outcomes before filesystem effects', async () => {
    const realizeWorktree = vi.fn();
    await expect(resolveWorkflowWorkspace({
      selection: { kind: 'new_worktree', source: { kind: 'original' } }, defaultSelection: { kind: 'project_checkout' }, projectWorkspace: project,
      conversationWorkspace: { machineId: project.machineId, directory: '/other' }, runId: 'run-1', logicalInvocationRecordId: 'inv-a',
      deps: { realizeWorktree },
    })).resolves.toEqual({ ok: false, code: 'conversation_workspace_mismatch' });
    expect(realizeWorktree).not.toHaveBeenCalled();

    await expect(resolveWorkflowWorkspace({
      selection: { kind: 'inherit' }, defaultSelection: { kind: 'project_checkout' }, projectWorkspace: project, runId: 'run-1', logicalInvocationRecordId: 'inv-a',
      recorded: { workspace: project }, deps: { verifyRecordedWorkspace: async () => 'missing' },
    })).resolves.toEqual({ ok: false, code: 'workspace_unavailable' });

    const producer = { ...project, directory: '/worktrees/producer/packages/app', checkoutRootPath: '/worktrees/producer' };
    await expect(resolveWorkflowWorkspace({
      selection: { kind: 'from_step', producer: { blockId: 'a', scope: { kind: 'current' } } },
      defaultSelection: { kind: 'project_checkout' }, projectWorkspace: project,
      runId: 'run-1', logicalInvocationRecordId: 'inv-a',
      deps: {
        resolveProducerWorkspace: async () => ({ descriptor: producer }),
        verifyRecordedWorkspace: async (workspace) => workspace === producer ? 'conflict' : 'available',
      },
    })).resolves.toEqual({ ok: false, code: 'workspace_conflict' });

    await expect(resolveWorkflowWorkspace({
      selection: { kind: 'inherit' }, defaultSelection: { kind: 'project_checkout' }, projectWorkspace: project,
      runId: 'run-1', logicalInvocationRecordId: 'inv-a',
      deps: { verifyRecordedWorkspace: async () => 'missing' },
    })).resolves.toEqual({ ok: false, code: 'workspace_unavailable' });

    await expect(resolveWorkflowWorkspace({
      selection: { kind: 'inherit' }, defaultSelection: { kind: 'project_checkout' }, projectWorkspace: project,
      conversationWorkspace: { machineId: project.machineId, directory: '/other' }, runId: 'run-1', logicalInvocationRecordId: 'inv-a',
      recorded: { workspace: project }, deps: { verifyRecordedWorkspace: async () => 'available' },
    })).resolves.toEqual({ ok: false, code: 'conversation_workspace_mismatch' });
  });

  it('checks an accepted project against the current canonical SCM root before first use', async () => {
    await expect(verifyWorkflowWorkspaceCurrentness(project, {
      pathIsDirectory: async () => true,
      inspectLocation: async () => ({ inspection: { rootPath: '/different-checkout' } }),
    })).resolves.toBe('conflict');

    const ordinaryDirectory = { machineId: 'machine-1', directory: '/plain', checkoutRootPath: '/plain' };
    await expect(verifyWorkflowWorkspaceCurrentness(ordinaryDirectory, {
      pathIsDirectory: async () => true,
      inspectLocation: async () => null,
    })).resolves.toBe('available');
  });

  it('binds exact producer scope and row-local creation progress through the coordinator store', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const sourceKey = workflowInvocationKey({ runId: 'run-1', blockId: 'a', scope: [], attempt: 0 });
    await store.ensureIntent({ key: sourceKey, recordId: 'inv-a', runId: 'run-1', blockId: 'a', blockKind: 'step', path: { blockId: 'a', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'completed', workspace: { descriptor: project } });
    const targetKey = workflowInvocationKey({ runId: 'run-1', blockId: 'b', scope: [], attempt: 0 });
    const target = await store.ensureIntent({ key: targetKey, recordId: 'inv-b', runId: 'run-1', blockId: 'b', blockKind: 'step', path: { blockId: 'b', scope: [] }, attempt: 0, acceptedAtMs: 2, lifecycle: 'admitting' });
    const resolver = createCoordinatorWorkspaceResolver({
      store,
      projectWorkspace: project,
      scm: { verifyRecordedWorkspace: async () => 'available' },
    });
    const result = await resolver({
      runId: 'run-1',
      definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
      step: { id: 'b', execution: { workspace: { kind: 'from_step', producer: { blockId: 'a', scope: { kind: 'current' } } } } },
      invocation: target,
      scope: [],
      producerBinding: { resolve: async () => await store.read(sourceKey) },
    });
    expect(result).toEqual({ ok: true, workspace: { ...project, sourceInvocation: { producer: { blockId: 'a', scope: { kind: 'current' } }, invocationRecordId: 'inv-a' } } });
    expect(store.records.get(targetKey)?.workspace?.descriptor).toEqual(result.ok ? result.workspace : undefined);
  });

  it('uses the latest producer attempt instead of reopening attempt zero', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const oldWorkspace = { ...project, directory: '/repo-old', checkoutRootPath: '/repo-old' };
    for (const [attempt, descriptor] of [[0, oldWorkspace], [1, project]] as const) {
      const key = workflowInvocationKey({ runId: 'run-1', blockId: 'a', scope: [], attempt });
      await store.ensureIntent({ key, recordId: `inv-a-${attempt}`, runId: 'run-1', blockId: 'a', blockKind: 'step', path: { blockId: 'a', scope: [] }, attempt, acceptedAtMs: attempt, lifecycle: 'completed', workspace: { descriptor } });
    }
    const targetKey = workflowInvocationKey({ runId: 'run-1', blockId: 'b', scope: [], attempt: 0 });
    const target = await store.ensureIntent({ key: targetKey, recordId: 'inv-b', runId: 'run-1', blockId: 'b', blockKind: 'step', path: { blockId: 'b', scope: [] }, attempt: 0, acceptedAtMs: 2, lifecycle: 'admitting' });
    const resolver = createCoordinatorWorkspaceResolver({
      store,
      projectWorkspace: project,
      scm: { verifyRecordedWorkspace: async () => 'available' },
    });
    const result = await resolver({
      runId: 'run-1',
      definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
      step: { id: 'b', execution: { workspace: { kind: 'from_step', producer: { blockId: 'a', scope: { kind: 'current' } } } } },
      invocation: target,
      scope: [],
      producerBinding: { resolve: async () => await store.read(workflowInvocationKey({ runId: 'run-1', blockId: 'a', scope: [], attempt: 1 })) },
    });
    expect(result).toEqual({ ok: true, workspace: { ...project, sourceInvocation: { producer: { blockId: 'a', scope: { kind: 'current' } }, invocationRecordId: 'inv-a-1' } } });
  });

  it('materializes one workflow-default worktree correspondence shared by inheriting steps', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const rootKey = workflowInvocationKey({ runId: 'run-1', blockId: '$root', scope: [], attempt: 0 });
    await store.ensureIntent({ key: rootKey, recordId: 'root-1', runId: 'run-1', blockId: '$root', blockKind: 'root', path: { blockId: '$root', scope: [] }, attempt: 0, acceptedAtMs: 0, lifecycle: 'running' });
    const realizeWorktree = vi.fn(async () => ({ directory: '/worktrees/shared/packages/app', checkoutRootPath: '/worktrees/shared', branchName: 'shared' }));
    const resolver = createCoordinatorWorkspaceResolver({
      store,
      projectWorkspace: project,
      originalCommittedRevision: 'a'.repeat(40),
      scm: { realizeWorktree, verifyRecordedWorkspace: async () => 'available' },
    });
    const definition = { version: 1 as const, inputs: [], defaults: { workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } } }, blocks: [] };
    const resolveStep = async (id: string) => {
      const key = workflowInvocationKey({ runId: 'run-1', blockId: id, scope: [], attempt: 0 });
      const invocation = await store.ensureIntent({ key, recordId: `inv-${id}`, runId: 'run-1', blockId: id, blockKind: 'step', path: { blockId: id, scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'admitting' });
      return await resolver({
        runId: 'run-1', definition,
        step: { id },
        invocation, scope: [], producerBinding: noProducerBinding,
      });
    };
    const first = await resolveStep('a');
    const second = await resolveStep('b');
    expect(first).toEqual(second);
    expect(realizeWorktree).toHaveBeenCalledTimes(1);
    expect(store.records.get(rootKey)?.workspace?.descriptor).toEqual(first.ok ? first.workspace : undefined);
    for (const id of ['a', 'b']) {
      const key = workflowInvocationKey({ runId: 'run-1', blockId: id, scope: [], attempt: 0 });
      expect(store.records.get(key)?.workspace).toEqual(store.records.get(rootKey)?.workspace);
    }
  });

  it('uses a continued session cwd for inherited workspace before materializing a workflow default', async () => {
    const fixture = await createTemporaryGitProject();
    const git = createGitWorkflowWorkspaceTestDependencies();
    try {
      const store = createInMemoryWorkflowCoordinatorStore();
      const key = workflowInvocationKey({ runId: 'run-session-cwd', blockId: 'bound', scope: [], attempt: 0 });
      const invocation = await store.ensureIntent({ key, recordId: 'bound', runId: 'run-session-cwd', blockId: 'bound',
        blockKind: 'step', path: { blockId: 'bound', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'admitting' });
      const resolver = createCoordinatorWorkspaceResolver({
        store, scm: git,
        projectWorkspace: { machineId: 'machine-1', directory: fixture.root, checkoutRootPath: fixture.root },
        originalCommittedRevision: fixture.revision,
      });
      const result = await resolver({
        runId: 'run-session-cwd',
        definition: { version: 1, inputs: [], defaults: { workspace: { kind: 'new_worktree', source: { kind: 'original' } } }, blocks: [] },
        step: { id: 'bound', execution: { conversation: { kind: 'existing_session', sessionId: 'existing', machineId: 'machine-1' } } },
        invocation, scope: [], producerBinding: noProducerBinding, useConversationWorkspace: true,
        conversationWorkspace: { machineId: 'machine-1', directory: fixture.projectDirectory },
      });
      expect(result).toEqual({ ok: true, workspace: { machineId: 'machine-1', directory: fixture.projectDirectory, checkoutRootPath: await realpath(fixture.root) } });
      expect(store.records.get(key)?.workspace?.descriptor).toEqual(result.ok ? result.workspace : undefined);
      expect((await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.root })).stdout.match(/^worktree /gm)).toHaveLength(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reuses and forks a generated workflow default with its real SCM provenance', async () => {
    const fixture = await createTemporaryGitProject();
    const git = createGitWorkflowWorkspaceTestDependencies();
    try {
      const store = createInMemoryWorkflowCoordinatorStore();
      const rootKey = workflowInvocationKey({ runId: 'run-default-pair', blockId: '$root', scope: [], attempt: 0 });
      await store.ensureIntent({ key: rootKey, recordId: 'default-root', runId: 'run-default-pair', blockId: '$root', blockKind: 'root', path: { blockId: '$root', scope: [] }, attempt: 0, acceptedAtMs: 0, lifecycle: 'running' });
      const resolve = createCoordinatorWorkspaceResolver({ store, scm: git, originalCommittedRevision: fixture.revision,
        projectWorkspace: { machineId: 'machine-1', directory: fixture.projectDirectory, checkoutRootPath: fixture.root } });
      const definition = { version: 1 as const, inputs: [], defaults: { workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } } }, blocks: [] };
      const resolveStep = async (id: string, workspace?: Parameters<typeof resolveWorkflowWorkspace>[0]['selection']) => {
        const key = workflowInvocationKey({ runId: 'run-default-pair', blockId: id, scope: [], attempt: 0 });
        const invocation = await store.ensureIntent({ key, recordId: id, runId: 'run-default-pair', blockId: id, blockKind: 'step', path: { blockId: id, scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'admitting' });
        return await resolve({ runId: 'run-default-pair', definition, invocation, scope: [], producerBinding: noProducerBinding,
          step: { id, ...(workspace ? { execution: { workspace } } : {}) } });
      };
      const inherited = await resolveStep('a');
      if (!inherited.ok) throw new Error(inherited.code);
      await writeFile(join(inherited.workspace.checkoutRootPath, 'README.md'), 'dirty default\n');
      expect(await resolveStep('b')).toEqual(inherited);
      const forked = await resolveStep('c', { kind: 'new_worktree', source: { kind: 'workflow' } });
      expect(forked.ok).toBe(true);
      if (!forked.ok) throw new Error(forked.code);
      expect(await readFile(join(forked.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('original\n');
      expect(await readFile(join(inherited.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('dirty default\n');
      for (const id of ['a', 'b']) {
        const key = workflowInvocationKey({ runId: 'run-default-pair', blockId: id, scope: [], attempt: 0 });
        expect(store.records.get(key)?.workspace).toEqual(store.records.get(rootKey)?.workspace);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('retains a shared conversation source pair through inherited workspace reuse and rejoin', async () => {
    const fixture = await createTemporaryGitProject();
    const scm = createGitWorkflowWorkspaceTestDependencies();
    try {
      const store = createInMemoryWorkflowCoordinatorStore();
      const runId = 'run-shared-pair';
      const projectWorkspace = { machineId: 'machine-1', directory: fixture.projectDirectory, checkoutRootPath: fixture.root };
      const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [] };
      const intent = async (id: string, blockKind: 'step' | 'parallel') => await store.ensureIntent({
        key: workflowInvocationKey({ runId, blockId: id, scope: [], attempt: 0 }),
        recordId: id, runId, blockId: id, blockKind, path: { blockId: id, scope: [] },
        attempt: 0, acceptedAtMs: 1, lifecycle: 'running',
      });
      const source = await intent('source', 'step');
      const resolver = createCoordinatorWorkspaceResolver({ store, projectWorkspace, scm });
      const created = await resolver({ runId, definition, step: { id: source.blockId,
        execution: { workspace: { kind: 'new_worktree', source: { kind: 'workflow' } } } },
        invocation: source, scope: [], producerBinding: noProducerBinding });
      if (!created.ok) throw new Error(created.code);
      await writeFile(join(created.workspace.checkoutRootPath, 'README.md'), 'dirty shared source\n');
      const owner = await intent('branch-owner', 'parallel');
      await store.commitFact({ key: owner.key, lifecycle: 'running',
        sharedConversationInvocationRecordId: { session: source.recordId } });
      const consumer = await intent('consumer', 'step');
      const params = { runId, definition, step: { id: consumer.blockId }, invocation: consumer,
        scope: [], producerBinding: noProducerBinding, useConversationWorkspace: true,
        conversationWorkspace: { machineId: 'machine-1', directory: created.workspace.directory },
        conversationBinding: { kind: 'shared' as const, scopeOwnerKey: owner.recordId,
          targetClass: 'session' as const },
      };
      expect(await resolver(params)).toEqual(created);
      expect(store.records.get(consumer.key)?.workspace).toEqual(store.records.get(source.key)?.workspace);
      const recorded = await store.read(consumer.key);
      if (!recorded) throw new Error('Missing recorded consumer');
      const worktrees = (await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.root })).stdout;
      const rejoin = createCoordinatorWorkspaceResolver({ store, projectWorkspace, scm });
      expect(await rejoin({ ...params, invocation: recorded })).toEqual(created);
      expect(await readFile(join(created.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('dirty shared source\n');
      expect((await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.root })).stdout).toBe(worktrees);
      await rm(created.workspace.checkoutRootPath, { recursive: true, force: true });
      expect(await rejoin({ ...params, invocation: recorded })).toEqual({ ok: false, code: 'workspace_unavailable' });
      await mkdir(created.workspace.directory, { recursive: true });
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: created.workspace.checkoutRootPath });
      expect(await rejoin({ ...params, invocation: recorded })).toEqual({ ok: false, code: 'workspace_conflict' });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(['project', 'generated'] as const)('materializes each child generated default relative to its selected $0 project and rejoins its frame', async (selectedProject) => {
    const fixture = await createTemporaryGitProject();
    const scm = createGitWorkflowWorkspaceTestDependencies();
    try {
      const store = createInMemoryWorkflowCoordinatorStore();
      const runId = 'run-child-workspace';
      const projectWorkspace = { machineId: 'machine-1', directory: fixture.projectDirectory, checkoutRootPath: fixture.root };
      const childRef = 'builtin:workspace-child';
      const leaf = (id: string) => ({ kind: 'step' as const, id,
        document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' as const } });
      const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } };
      const child: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget,
        workspace: { kind: 'new_worktree', source: { kind: 'workflow' } } }, blocks: [leaf('a'), leaf('b')] };
      const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {},
        blocks: [...['first', 'second'].map((id) => ({ kind: 'workflow' as const, id, workflowRef: childRef, input: {},
          ...(selectedProject === 'generated' ? { execution: { workspace: {
            kind: 'new_worktree' as const, source: { kind: 'workflow' as const },
          } } } : {}) })), { ...leaf('producer-consumer'), input: [{ kind: 'workspace',
            producer: { blockId: 'first', scope: { kind: 'current' } }, field: 'directory' }], execution: { agentTarget, workspace: {
            kind: 'from_step', producer: { blockId: 'first', scope: { kind: 'current' } },
          } } }] };
      const executionTarget = { kind: 'session' as const };
      const materializedLeaves: WorkflowMaterializedLeafV1[] = [
        ...['first', 'second'].map((blockId) => ({ authoredWorkspace: selectedProject === 'generated'
          ? { kind: 'new_worktree' as const, source: { kind: 'workflow' as const } } : { kind: 'inherit' as const }, sourceKey: '$root', blockId, kind: 'workflow' as const,
          childRef, selection: {}, executionTarget })),
        ...['a', 'b'].map((blockId) => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: childRef, blockId, kind: 'step' as const,
          selection: { agentTarget, workspace: child.defaults.workspace }, executionTarget })),
        { authoredWorkspace: { kind: 'from_step', producer: { blockId: 'first', scope: { kind: 'current' } } },
          sourceKey: '$root', blockId: 'producer-consumer', kind: 'step',
          selection: { agentTarget, workspace: { kind: 'from_step',
            producer: { blockId: 'first', scope: { kind: 'current' } } } }, executionTarget },
      ];
      const options = { runId, definition, frozenChildren: { [childRef]: child }, materializedLeaves,
        inputs: {}, executionTarget, authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const } };
      let interrupted = false;
      const observed: WorkflowWorkspaceDescriptor[] = [];
      let producerInput: readonly unknown[] | undefined;
      const coordinator = () => createWorkflowCoordinator({ store,
        resolveWorkspace: createCoordinatorWorkspaceResolver({ store, projectWorkspace, scm }),
        isAcceptedAuthorizationCurrent: async () => true,
        // Agent admission/observation is the process boundary; frame and SCM behavior stays real.
        executeStep: async (params) => {
          if (params.step.id === 'b' && !interrupted) {
            interrupted = true;
            throw new WorkflowRuntimeInterruption();
          }
          observed.push(params.workspace);
          if (params.step.id === 'producer-consumer') producerInput = params.input.values;
          await params.beforeInputAdmission();
          await params.onInputAccepted({ kind: 'session', sessionId: `session-${params.invocationRecordId}`,
            localInputId: `input-${params.invocationRecordId}` });
          return { kind: 'completed', result: params.step.id };
        },
      });
      await expect(coordinator().run(options)).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
      expect(observed[0]?.checkoutRootPath).not.toBe(fixture.root);
      expect(observed[0]?.directory).toBe(join(observed[0]!.checkoutRootPath, 'packages', 'app'));
      await writeFile(join(observed[0]!.checkoutRootPath, 'README.md'), 'dirty child default\n');
      const firstFrame = store.list().find((row) => row.blockId === 'first');
      if (firstFrame?.container?.kind !== 'body') throw new Error('Missing first frame');
      const firstProject = firstFrame.container.frameProjectWorkspace;
      if (!firstProject?.descriptor) throw new Error('Missing selected frame project');
      await store.commitFact({ key: firstFrame.key, lifecycle: 'pending' });
      const before = (await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.root })).stdout;
      expect(await coordinator().run(options)).toEqual({ state: 'succeeded' });
      expect(observed[1]).toEqual(observed[0]);
      expect(observed[2]?.checkoutRootPath).not.toBe(observed[0]?.checkoutRootPath);
      expect(observed[3]).toEqual(observed[2]);
      expect(observed[4]).toEqual({ ...firstProject.descriptor, sourceInvocation: {
        producer: { blockId: 'first', scope: { kind: 'current' } }, invocationRecordId: firstFrame.recordId,
      } });
      expect(producerInput).toEqual([firstProject.descriptor.directory]);
      expect(await readFile(join(observed[0]!.checkoutRootPath, 'README.md'), 'utf8')).toBe('dirty child default\n');
      const frames = store.list().filter((row) => row.blockKind === 'workflow');
      expect(frames).toHaveLength(2);
      for (const frame of frames) {
        expect(frame.container).toMatchObject({ kind: 'body', nextBlockOrdinal: '2' });
        if (frame.container?.kind !== 'body') throw new Error('Missing frame container');
        const selected = frame.container.frameProjectWorkspace;
        if (frame.blockId === 'first') expect(selected).toEqual(firstProject);
        expect(selected?.descriptor?.checkoutRootPath === fixture.root).toBe(selectedProject === 'project');
        expect(frame.workspace?.creationIntent?.sourceDirectory).toBe(selected?.descriptor?.directory);
        if (selectedProject === 'generated') {
          expect(frame.workspace?.creationIntent?.displayName).not.toBe(selected?.creationIntent?.displayName);
        }
        expect(frame.workspace?.descriptor?.checkoutRootPath).not.toBe(selected?.descriptor?.checkoutRootPath);
        expect(frame.workspace?.descriptor?.checkoutRootPath).not.toBe(fixture.root);
      }
      const after = (await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.root })).stdout;
      for (const worktree of before.trim().split('\n\n')) expect(after).toContain(worktree);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('materializes an explicit workflow-sourced worktree from the current shared default checkout', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const rootKey = workflowInvocationKey({ runId: 'run-1', blockId: '$root', scope: [], attempt: 0 });
    await store.ensureIntent({ key: rootKey, recordId: 'root-1', runId: 'run-1', blockId: '$root', blockKind: 'root', path: { blockId: '$root', scope: [] }, attempt: 0, acceptedAtMs: 0, lifecycle: 'running' });
    const targetKey = workflowInvocationKey({ runId: 'run-1', blockId: 'child', scope: [], attempt: 0 });
    const target = await store.ensureIntent({ key: targetKey, recordId: 'inv-child', runId: 'run-1', blockId: 'child', blockKind: 'step', path: { blockId: 'child', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'admitting' });
    const realizeWorktree = vi.fn(async (intent) => intent.displayName === 'workflow-run-1-root-1'
      ? { directory: '/worktrees/default/packages/app', checkoutRootPath: '/worktrees/default', branchName: 'default' }
      : { directory: '/worktrees/child/packages/app', checkoutRootPath: '/worktrees/child', branchName: 'child' });
    const inspectCommittedRevision = vi.fn(async (directory: string) => directory === '/worktrees/default'
      ? 'b'.repeat(40)
      : null);
    const resolver = createCoordinatorWorkspaceResolver({
      store,
      projectWorkspace: project,
      originalCommittedRevision: 'a'.repeat(40),
      scm: { inspectCommittedRevision, realizeWorktree, verifyRecordedWorkspace: async () => 'available' },
    });
    const definition = { version: 1 as const, inputs: [], defaults: { workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } } }, blocks: [] };
    const result = await resolver({
      runId: 'run-1', definition,
      step: { id: 'child', execution: { workspace: { kind: 'new_worktree', source: { kind: 'workflow' } } } },
      invocation: target, scope: [], producerBinding: noProducerBinding,
    });

    expect(result).toEqual({ ok: true, workspace: { machineId: 'machine-1', directory: '/worktrees/child/packages/app', checkoutRootPath: '/worktrees/child', checkout: { kind: 'git_worktree', branchName: 'child' } } });
    expect(inspectCommittedRevision).toHaveBeenCalledWith('/worktrees/default');
    expect(realizeWorktree).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceDirectory: '/worktrees/default/packages/app', baseRef: 'b'.repeat(40), displayName: 'workflow-run-1-inv-child',
    }));
  });

  it('preserves the exact source invocation when a new worktree forks from a repeated producer', async () => {
    const sourceInvocation = {
      producer: {
        blockId: 'analyze',
        scope: { kind: 'previous_iteration' as const, loopBlockId: 'items' },
      },
      invocationRecordId: 'inv-analyze-iteration-7',
    };
    const result = await resolveWorkflowWorkspace({
      selection: { kind: 'new_worktree', source: { kind: 'step', producer: sourceInvocation.producer } },
      defaultSelection: { kind: 'project_checkout' },
      projectWorkspace: project,
      runId: 'run-1',
      logicalInvocationRecordId: 'inv-child',
      deps: {
        resolveProducerWorkspace: async () => ({ descriptor: { ...project, sourceInvocation } }),
        verifyRecordedWorkspace: async () => 'available',
        inspectCommittedRevision: async () => 'a'.repeat(40),
        realizeWorktree: async () => ({
          directory: '/worktrees/child', checkoutRootPath: '/worktrees/child', branchName: 'child',
        }),
      },
    });

    expect(result).toEqual({
      ok: true,
      workspace: {
        machineId: 'machine-1',
        directory: '/worktrees/child',
        checkoutRootPath: '/worktrees/child',
        sourceInvocation,
        checkout: { kind: 'git_worktree', branchName: 'child' },
      },
    });
  });

  it('rejoins one invocation-qualified shared worktree when sibling first-use calls overlap', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const rootKey = workflowInvocationKey({ runId: 'run-1', blockId: '$root', scope: [], attempt: 0 });
    await store.ensureIntent({ key: rootKey, recordId: 'root-1', runId: 'run-1', blockId: '$root', blockKind: 'root', path: { blockId: '$root', scope: [] }, attempt: 0, acceptedAtMs: 0, lifecycle: 'running' });
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const realizeWorktree = vi.fn(async (_intent: WorkflowWorkspaceCreationIntent) => {
      if (realizeWorktree.mock.calls.length === 1) {
        releaseFirst();
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      } else {
        await firstStarted;
      }
      return { directory: '/worktrees/shared/packages/app', checkoutRootPath: '/worktrees/shared', branchName: 'workflow-run-1-root-1' };
    });
    const resolver = createCoordinatorWorkspaceResolver({
      store,
      projectWorkspace: project,
      originalCommittedRevision: 'a'.repeat(40),
      scm: { realizeWorktree, verifyRecordedWorkspace: async () => 'available' },
    });
    const definition = { version: 1 as const, inputs: [], defaults: { workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } } }, blocks: [] };
    const invocation = async (id: string) => {
      const key = workflowInvocationKey({ runId: 'run-1', blockId: id, scope: [], attempt: 0 });
      return await store.ensureIntent({ key, recordId: `inv-${id}`, runId: 'run-1', blockId: id, blockKind: 'step', path: { blockId: id, scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'admitting' });
    };
    const [a, b] = await Promise.all([invocation('a'), invocation('b')]);
    const step = (id: string) => ({ kind: 'step' as const, id, document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' as const } });
    const [first, second] = await Promise.all([
      resolver({ runId: 'run-1', definition, step: step('a'), invocation: a, scope: [], producerBinding: noProducerBinding }),
      resolver({ runId: 'run-1', definition, step: step('b'), invocation: b, scope: [], producerBinding: noProducerBinding }),
    ]);

    expect(first).toEqual(second);
    expect(realizeWorktree.mock.calls.every(([intent]) => intent.displayName === 'workflow-run-1-root-1')).toBe(true);
    expect(store.records.get(rootKey)?.workspace?.descriptor).toEqual(first.ok ? first.workspace : undefined);
  });

  it('keeps project-checkout work shared and materializes an isolated revision-pinned Git worktree through the canonical SCM owner', async () => {
    const fixture = await createTemporaryGitProject();
    const git = createGitWorkflowWorkspaceTestDependencies();
    try {
      const projectWorkspace: WorkflowWorkspaceDescriptor = {
        machineId: 'machine-1',
        directory: fixture.projectDirectory,
        checkoutRootPath: fixture.root,
      };

      const shared = await resolveWorkflowWorkspace({
        selection: { kind: 'project_checkout' },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace,
        runId: 'run-real-git',
        logicalInvocationRecordId: 'shared',
        deps: {},
      });
      expect(shared).toEqual({ ok: true, workspace: projectWorkspace });

      const creationIntents: unknown[] = [];
      const created = await resolveWorkflowWorkspace({
        selection: { kind: 'new_worktree', source: { kind: 'workflow' } },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace,
        runId: 'run-real-git',
        logicalInvocationRecordId: 'isolated',
        deps: {
          ...git,
          persistCreationIntent: async (intent) => { creationIntents.push(intent); },
        },
      });

      expect(created).toMatchObject({
        ok: true,
        workspace: {
          machineId: 'machine-1',
          checkout: { kind: 'git_worktree', branchName: 'workflow-run-real-git-isolated' },
        },
      });
      if (!created.ok) throw new Error(created.code);
      expect(created.workspace.checkoutRootPath).not.toBe(fixture.root);
      expect(created.workspace.directory).toBe(join(created.workspace.checkoutRootPath, 'packages', 'app'));
      expect(await readFile(join(created.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('original\n');
      await expect(readFile(join(created.workspace.checkoutRootPath, 'untracked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: created.workspace.checkoutRootPath })).stdout.trim())
        .toBe(fixture.revision);
      expect(await readFile(join(fixture.root, 'README.md'), 'utf8')).toBe('unstaged-after-staged\n');
      expect(await readFile(join(fixture.root, 'untracked.txt'), 'utf8')).toBe('untracked\n');
      const currentStatus = (await execFileAsync('git', ['status', '--short'], { cwd: fixture.root })).stdout;
      for (const originalEntry of fixture.dirtyStatus.trim().split('\n')) {
        expect(currentStatus).toContain(originalEntry);
      }
      expect(creationIntents).toEqual([{
        kind: 'git_worktree',
        sourceDirectory: fixture.projectDirectory,
        baseRef: fixture.revision,
        displayName: 'workflow-run-real-git-isolated',
        branchMode: 'new',
      }]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
