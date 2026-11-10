import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitWorkflowWorkspaceTestDependencies } from '@/daemon/workflows/workflowWorkspace.testkit';
import { readRepositoryWorkflow } from './repositoryWorkflow';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-repository-'));
  roots.push(root);
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  await mkdir(join(root, 'workflows'));
  const json = JSON.stringify({ kind: 'happier.workflow', version: 1, definition: {
    version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
      document: { text: 'Continue', references: [], attachments: [] } }],
  } });
  await writeFile(join(root, 'workflows', 'ci.json'), json);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, json, commit, projectTarget: { machineId: 'machine', directory: root } };
}

describe('repository Workflow source filesystem boundary', () => {
  const deps = createGitWorkflowWorkspaceTestDependencies();
  const read = (input: Parameters<typeof readRepositoryWorkflow>[0]) => deps.runWithRuntime(
    () => readRepositoryWorkflow(input, { registry: deps.registry }),
  );
  it('reads committed bytes even when the working-tree file differs', async () => {
    const f = await fixture();
    expect(await read({ path: './workflows/ci.json', projectTarget: f.projectTarget }))
      .toEqual({ json: f.json, commit: f.commit });
    await writeFile(join(f.root, 'workflows', 'ci.json'), f.json + '\n');
    expect(await read({ path: 'workflows/ci.json', projectTarget: f.projectTarget }))
      .toEqual({ json: f.json, commit: f.commit });
  });
  it('refuses traversal and symlinks outside the selected Project', async () => {
    const f = await fixture();
    await expect(read({ path: '../outside.json', projectTarget: f.projectTarget }))
      .rejects.toMatchObject({ code: 'workspace_path_outside_root' });
    const outside = await mkdtemp(join(tmpdir(), 'workflow-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'outside.json'), f.json);
    await symlink(outside, join(f.root, 'linked'), 'junction');
    await expect(read({ path: 'linked/outside.json', projectTarget: f.projectTarget }))
      .rejects.toMatchObject({ code: 'workspace_path_outside_root' });
  });
  it('resolves a Project subdirectory against the repository and refuses untracked documents', async () => {
    const f = await fixture();
    const projectTarget = { ...f.projectTarget, directory: join(f.root, 'workflows') };
    expect(await read({ path: 'ci.json', projectTarget })).toEqual({ json: f.json, commit: f.commit });
    await writeFile(join(f.root, 'workflows', 'local.json'), f.json);
    await expect(read({ path: 'local.json', projectTarget })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('keeps the authored committed path when an in-root working-tree junction redirects it', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'other'));
    await writeFile(join(f.root, 'other', 'ci.json'), f.json + '\n');
    execFileSync('git', ['add', 'other'], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'other'], { cwd: f.root, stdio: 'ignore' });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
    await rename(join(f.root, 'workflows'), join(f.root, 'original'));
    await symlink(join(f.root, 'other'), join(f.root, 'workflows'), 'junction');
    expect(await read({ path: 'workflows/ci.json', projectTarget: f.projectTarget })).toEqual({ json: f.json, commit });
  });
  it('preserves missing-file errors and refuses repositories without a commit', async () => {
    const f = await fixture();
    await expect(read({ path: 'missing.json', projectTarget: f.projectTarget }))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const empty = await mkdtemp(join(tmpdir(), 'workflow-unborn-'));
    roots.push(empty);
    execFileSync('git', ['init', empty], { stdio: 'ignore' });
    await writeFile(join(empty, 'ci.json'), f.json);
    await expect(read({ path: 'ci.json', projectTarget: { ...f.projectTarget, directory: empty } }))
      .rejects.toMatchObject({ code: 'committed_revision_unavailable' });
  });
});
