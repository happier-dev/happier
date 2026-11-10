import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  it('reads the workspace file with normalized provenance through the real SCM owner', async () => {
    const f = await fixture();
    expect(await readRepositoryWorkflow({ path: './workflows/ci.json', projectTarget: f.projectTarget }, deps))
      .toEqual({ json: f.json, commit: f.commit });
    await writeFile(join(f.root, 'workflows', 'ci.json'), f.json + '\n');
    expect(await readRepositoryWorkflow({ path: 'workflows/ci.json', projectTarget: f.projectTarget }, deps))
      .toEqual({ json: f.json + '\n', commit: f.commit });
  });
  it('refuses traversal and symlinks outside the selected Project', async () => {
    const f = await fixture();
    await expect(readRepositoryWorkflow({ path: '../outside.json', projectTarget: f.projectTarget }, deps))
      .rejects.toMatchObject({ code: 'workspace_path_outside_root' });
    const outside = await mkdtemp(join(tmpdir(), 'workflow-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'outside.json'), f.json);
    await symlink(outside, join(f.root, 'linked'), 'junction');
    await expect(readRepositoryWorkflow({ path: 'linked/outside.json', projectTarget: f.projectTarget }, deps))
      .rejects.toMatchObject({ code: 'workspace_path_outside_root' });
  });
  it('preserves missing-file errors and refuses repositories without a commit', async () => {
    const f = await fixture();
    await expect(readRepositoryWorkflow({ path: 'missing.json', projectTarget: f.projectTarget }, deps))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const empty = await mkdtemp(join(tmpdir(), 'workflow-unborn-'));
    roots.push(empty);
    execFileSync('git', ['init', empty], { stdio: 'ignore' });
    await writeFile(join(empty, 'ci.json'), f.json);
    await expect(readRepositoryWorkflow({ path: 'ci.json', projectTarget: { ...f.projectTarget, directory: empty } }, deps))
      .rejects.toMatchObject({ code: 'committed_revision_unavailable' });
  });
});
