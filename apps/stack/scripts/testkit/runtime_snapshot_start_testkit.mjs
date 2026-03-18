import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { createRuntimeSnapshotFixture, runNode } from './runtime_snapshot_testkit.mjs';

export function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

export async function createRuntimeSnapshotStartFixture(t, options = {}) {
  const fixture = await createRuntimeSnapshotFixture(t, options);
  const runtimeState = {
    version: 1,
    stackName: fixture.stackName,
    ports: {
      server: fixture.serverPort ?? 4102,
    },
  };
  const runtimeOwnerPid = Number(options.runtimeOwnerPid);
  if (Number.isFinite(runtimeOwnerPid) && runtimeOwnerPid > 1) {
    runtimeState.ownerPid = runtimeOwnerPid;
  }
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    `${JSON.stringify(runtimeState, null, 2)}\n`,
    'utf-8',
  );
  return fixture;
}

export function runtimeSnapshotEnv({ fixture, rootDir, extraEnv = {} } = {}) {
  return {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: fixture.envPath,
    HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_STACK_RUNTIME_MODE: 'prefer',
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_TAILSCALE_SERVE: '0',
    HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
    HAPPIER_HOME_DIR: join(fixture.root, '.happy-home'),
    ...(rootDir ? { HAPPIER_STACK_CLI_ROOT_DIR: rootDir } : {}),
    ...extraEnv,
  };
}

export { runNode };
