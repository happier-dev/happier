import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildStackFixtureEnv } from './core/env_scope.mjs';
import { ensureMinimalMonorepoLayout } from './core/minimal_monorepo_layout.mjs';
import { runNodeCapture } from './core/run_node_capture.mjs';
import { writeStubHappierCliFiles } from './core/stub_happier_cli_files.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export const runNode = runNodeCapture;

export async function createDoctorWorkspaceFixture(t, { tmpPrefix = 'happier-stack-doctor-' } = {}) {
  const fixture = await createTempFixture(t, { prefix: tmpPrefix });
  const tmp = fixture.root;

  const monoRoot = join(tmp, 'workspace', 'happier');
  await ensureMinimalMonorepoLayout(monoRoot);
  await writeStubHappierCliFiles(monoRoot, {
    distIndexScript: 'export {};\n',
    binHappierScript: [
      `if (process.argv.includes('daemon') && process.argv.includes('status')) {`,
      `  console.log('Daemon is running');`,
      `  process.exit(0);`,
      `}`,
      `console.log('ok');`,
    ].join('\n'),
  });

  return { tmp, monoRoot };
}

export function doctorEnv({ monoRoot, extraEnv = {} } = {}) {
  return buildStackFixtureEnv({
    extraEnv: {
      HAPPIER_STACK_REPO_DIR: monoRoot,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      ...extraEnv,
    },
  });
}
