import { createMinimalMonorepoFixture } from './core/minimal_monorepo_layout.mjs';
import { writeStubHappierCliFiles } from './core/stub_happier_cli_files.mjs';

export async function createHappierCliMonorepoFixture(
  t,
  {
    prefix,
    distIndexScript,
    srcIndexScript,
    binHappierScript,
    tsconfigContent,
    includeServerPrisma = false,
    writeGitDirMarker = false,
  } = {},
) {
  const fixture = await createMinimalMonorepoFixture(t, {
    prefix,
    includeServerPrisma,
    writeGitDirMarker,
  });
  const cliFiles = await writeStubHappierCliFiles(fixture.rootDir, {
    distIndexScript,
    srcIndexScript,
    binHappierScript,
    tsconfigContent,
  });
  return {
    ...fixture,
    ...cliFiles,
  };
}
