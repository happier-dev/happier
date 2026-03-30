import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runNodeCapture } from './core/run_node_capture.mjs';
import { writeRuntimeSnapshotLayout } from './core/runtime_snapshot_layout.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export const runNode = runNodeCapture;

export async function createRuntimeSnapshotFixture(
  t,
  {
    stackName = 'prod-dev',
    cliEntrypoint = 'cli/happier',
    cliStdout = 'SNAPSHOT CLI HELP',
    cliSource = '',
  } = {},
) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-runtime-fixture-' });
  const root = fixture.root;
  const storageDir = join(root, 'storage');
  const stackDir = join(storageDir, stackName);
  const cliRuntimeSource = cliEntrypoint.endsWith('.mjs') || cliEntrypoint.endsWith('.js') || cliEntrypoint.endsWith('.cjs')
    ? (cliSource || `process.stdout.write(${JSON.stringify(`${cliStdout}\n`)});\n`)
    : `#!/bin/sh\necho ${cliStdout}\n`;
  const { snapshotDir } = await writeRuntimeSnapshotLayout({
    stackDir,
    snapshotId: 'snap-1',
    sourceFingerprint: 'src-1',
    writeCurrentMirror: true,
    web: {
      content: '<html></html>\n',
      artifactFingerprint: 'web-1',
    },
    server: {
      content: '#!/bin/sh\nexit 0\n',
      artifactFingerprint: 'srv-1',
    },
    daemon: {
      entrypoint: cliEntrypoint,
      content: cliRuntimeSource,
      executable: !cliEntrypoint.endsWith('.mjs') && !cliEntrypoint.endsWith('.js') && !cliEntrypoint.endsWith('.cjs'),
      artifactFingerprint: 'cli-1',
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: 'export {};\n',
    },
  });
  await writeFile(join(stackDir, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n', 'utf-8');

  return {
    root,
    storageDir,
    stackDir,
    snapshotDir,
    stackName,
  };
}
