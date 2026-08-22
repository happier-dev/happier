import {
  inspectSourceDevSharedDepsForSourceDev,
  readSourceDevSharedDepsWorkspaceNamesFromArgv,
  readSourceDevSharedDepsWorkspaceNamesFromEnv,
  syncSharedDepsForSourceDev,
} from './buildSharedDeps.mjs';

async function main() {
  const json = process.argv.includes('--json');
  const includeRuntimeDependencies = !process.argv.includes('--no-runtime-dependencies');
  const workspaceNames =
    readSourceDevSharedDepsWorkspaceNamesFromArgv()
    ?? readSourceDevSharedDepsWorkspaceNamesFromEnv();
  if (process.argv.includes('--check')) {
    const inspection = inspectSourceDevSharedDepsForSourceDev({ workspaceNames });
    if (!inspection.current) {
      throw new Error(
        'Source-dev CLI shared dependencies are not current; wait for the canonical stack publisher and retry.',
      );
    }
    return;
  }
  const result = await syncSharedDepsForSourceDev({
    workspaceNames,
    includeRuntimeDependencies,
    lockOptions: {
      heldLockValue: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      lockPath: process.env.HAPPIER_SOURCE_DEV_SHARED_DEPS_LOCK_PATH,
    },
  });
  if (json) {
    process.stdout.write(`__HAPPIER_SOURCE_DEV_SYNC_RESULT__=${JSON.stringify(result ?? null)}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
