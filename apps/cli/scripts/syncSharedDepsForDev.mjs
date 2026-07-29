import {
  inspectSourceDevSharedDepsForSourceDev,
  readSourceDevSharedDepsWorkspaceNamesFromArgv,
  readSourceDevSharedDepsWorkspaceNamesFromEnv,
  syncSharedDepsForSourceDev,
} from './buildSharedDeps.mjs';

async function main() {
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
  await syncSharedDepsForSourceDev({
    workspaceNames,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
