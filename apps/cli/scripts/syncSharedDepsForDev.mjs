import {
  readSourceDevSharedDepsWorkspaceNamesFromEnv,
  syncSharedDepsForSourceDev,
} from './buildSharedDeps.mjs';

async function main() {
  await syncSharedDepsForSourceDev({
    workspaceNames: readSourceDevSharedDepsWorkspaceNamesFromEnv(),
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
