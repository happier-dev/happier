import { prepareReleasedServerV021Artifact } from '../src/testkit/process/releasedServerLight';

const artifactDir = process.env.HAPPIER_E2E_RELEASED_SERVER_V0_2_1_DIR?.trim();
if (!artifactDir) {
  throw new Error(
    'HAPPIER_E2E_RELEASED_SERVER_V0_2_1_DIR is required for the exact server-v0.2.1 compatibility gate',
  );
}

const prepared = await prepareReleasedServerV021Artifact({ artifactDir });

// eslint-disable-next-line no-console
console.log(
  `Prepared immutable server-v0.2.1 artifact: ${prepared.archivePath} (${prepared.expectedArchiveSha256})`,
);
