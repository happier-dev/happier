import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildStackFixtureEnv } from './core/env_scope.mjs';
import { ensureMinimalMonorepoLayout } from './core/minimal_monorepo_layout.mjs';
import { runNodeCapture } from './core/run_node_capture.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export function runNode(args, { cwd, env }) {
  return runNodeCapture(args, { cwd, env }).then((result) => ({
    ...result,
    stderr: result.signal ? `${result.stderr}\nprocess terminated by signal: ${result.signal}` : result.stderr,
  }));
}

export function createMonorepoWorktreeEnv({ homeDir, workspaceDir, sandboxDir, extraEnv = {} }) {
  return buildStackFixtureEnv({
    homeDir,
    workspaceDir,
    sandboxDir,
    extraEnv: {
      HAPPIER_STACK_OWNER: 'test',
      ...extraEnv,
    },
  });
}

export async function createMonorepoWorktreeFixture(t, { prefix }) {
  const fixture = await createTempFixture(t, { prefix });
  const tmp = fixture.root;

  const workspaceDir = join(tmp, 'workspace');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const monoRoot = join(workspaceDir, 'tmp', 'test', 'mono-wt');

  await ensureMinimalMonorepoLayout(monoRoot, { writeGitDirMarker: true });

  return { homeDir, monoRoot, sandboxDir, tmp, workspaceDir };
}
