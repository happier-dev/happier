import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { packageRunnerBinary, RUNNER_BINARY_TARGETS } from './build-runner-binaries.mjs';
import { RUNNER_PUBLICATION_ELIGIBLE_TARGET_IDS, resolveRunnerPublicationEligibleBinaryTargets } from './lib/runner-packaging.mjs';
import { smokeTestArchive, verifyReleaseArchiveAdmission } from './verify-artifacts.mjs';
import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

const SAFE_RUNNER_STARTUP_FAILURE = 'Happier Runner could not continue. Open Happier for details.';

async function packageFixtureRunner({ root, body }) {
  const payloadPath = join(root, 'built-payload');
  await writeFile(payloadPath, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(payloadPath, 0o755);
  return await packageRunnerBinary({
    version: '0.3.0-dev.1',
    target: { os: 'linux', arch: 'x64' },
    payloadPath,
    outDir: root,
  });
}

test('the Linux Runner release archive preserves one executable root and passes canonical admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-release-'));
  try {
    const payloadPath = join(root, 'built-payload');
    await writeFile(payloadPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(payloadPath, 0o755);
    const artifact = await packageRunnerBinary({
      version: '0.3.0-dev.1',
      target: { os: 'linux', arch: 'x64' },
      payloadPath,
      outDir: root,
    });

    const admitted = await verifyReleaseArchiveAdmission({
      archivePath: artifact.path,
      archiveName: artifact.name,
    });

    assert.deepEqual(admitted.map((entry) => [entry.path, entry.kind, entry.mode]), [
      ['happier-runner', 'file', 0o755],
    ]);
    assert.equal((await stat(payloadPath)).mode & 0o777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Runner admission derives exact closed-ZIP bounds while generic extraction retains its compression-ratio ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-closed-zip-bounds-'));
  try {
    const payloadPath = join(root, 'built-payload');
    await writeFile(
      payloadPath,
      `#!/bin/sh\n#${'runner-payload-'.repeat(256 * 1024)}\nexit 0\n`,
      'utf8',
    );
    await chmod(payloadPath, 0o755);
    const artifact = await packageRunnerBinary({
      version: '0.3.0-dev.1',
      target: { os: 'linux', arch: 'x64' },
      payloadPath,
      outDir: root,
    });

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archivePath: artifact.path,
        archiveName: artifact.name,
        extractDir: join(root, 'generic-extract'),
      }),
      /archive exceeds compression ratio limit/u,
    );

    const admitted = await verifyReleaseArchiveAdmission({
      archivePath: artifact.path,
      archiveName: artifact.name,
    });
    assert.deepEqual(admitted.map(({ path, kind, sizeBytes, mode }) => ({ path, kind, sizeBytes, mode })), [
      {
        path: 'happier-runner',
        kind: 'file',
        sizeBytes: (await stat(payloadPath)).size,
        mode: 0o755,
      },
    ]);

    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(
      verifyReleaseArchiveAdmission({
        archivePath: artifact.path,
        archiveName: artifact.name,
        signal: cancellation.signal,
      }),
      error => error === cancellation.signal.reason,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Runner closed-ZIP admission retains central/local-header validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-closed-zip-header-'));
  try {
    const artifact = await packageFixtureRunner({ root, body: 'exit 0' });
    const archive = await readFile(artifact.path);
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    archive.writeUInt16LE(archive.readUInt16LE(8) === 0 ? 8 : 0, 8);
    await writeFile(artifact.path, archive);

    await assert.rejects(
      verifyReleaseArchiveAdmission({
        archivePath: artifact.path,
        archiveName: artifact.name,
      }),
      /ZIP central and local headers disagree/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Runner publication accepts only the target whose native release admission exists', () => {
  // The shell is composable for every declared platform, but publication
  // eligibility additionally needs native release admission and trust evidence.
  // This list does not make a Home claim availability; that requires a verified
  // immutable release record.
  assert.deepEqual(
    RUNNER_BINARY_TARGETS.map(({ os, arch }) => `${os}-${arch}`).sort(),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'],
  );
  assert.deepEqual([...RUNNER_PUBLICATION_ELIGIBLE_TARGET_IDS], ['linux-x64']);
  assert.deepEqual(
    resolveRunnerPublicationEligibleBinaryTargets(RUNNER_BINARY_TARGETS).map(({ os, arch }) => `${os}-${arch}`),
    ['linux-x64'],
  );
});

test('a publication-ineligible Runner target is refused by release admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-unadvertised-'));
  try {
    const payloadPath = join(root, 'built-payload');
    await writeFile(payloadPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(payloadPath, 0o755);
    const artifact = await packageRunnerBinary({
      version: '0.3.0-dev.1',
      target: { os: 'linux', arch: 'arm64' },
      payloadPath,
      outDir: root,
    });

    await assert.rejects(
      verifyReleaseArchiveAdmission({ archivePath: artifact.path, archiveName: artifact.name }),
      /Runner target is not eligible for publication/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Windows Runner package is the closed portable directory with its pinned core sidecar', async () => {
  // Running the packaged shell needs a Windows host; the closed-layout read is
  // the admission half this host can prove, and the smoke reaches it before any
  // `.exe` candidate would be launched.
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-windows-'));
  try {
    const payloadRoot = join(root, 'Happier Runner');
    await mkdir(payloadRoot, { recursive: true });
    await writeFile(join(payloadRoot, 'Happier Runner.exe'), 'shell fixture', 'utf8');
    await writeFile(join(payloadRoot, 'happier-runner-core.exe'), 'core fixture', 'utf8');
    const artifact = await packageRunnerBinary({
      version: '0.3.0-dev.1',
      target: { os: 'windows', arch: 'x64' },
      payloadPath: payloadRoot,
      outDir: root,
    });

    await smokeTestArchive({ archivePath: artifact.path });

    // Authenticode evidence does not exist yet, so the Windows payload shape is
    // modelled and buildable while publication stays Linux-only.
    await assert.rejects(
      verifyReleaseArchiveAdmission({ archivePath: artifact.path, archiveName: artifact.name }),
      /Runner target is not eligible for publication/u,
    );

    const archiver = (await import('archiver')).default;
    const renamedPath = join(root, 'happier-runner-v0.3.0-dev.2-windows-x64.zip');
    await new Promise((resolvePromise, reject) => {
      const output = createWriteStream(renamedPath, { flags: 'wx', mode: 0o600 });
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolvePromise); output.on('error', reject); archive.on('error', reject);
      archive.pipe(output);
      archive.append(null, { name: 'Happier Runner/', date: new Date(0), mode: 0o755 });
      archive.file(join(payloadRoot, 'Happier Runner.exe'), { name: 'Happier Runner/Happier Runner.exe', mode: 0o755, date: new Date(0) });
      archive.file(join(payloadRoot, 'happier-runner-core.exe'), { name: 'Happier Runner/core.exe', mode: 0o755, date: new Date(0) });
      void archive.finalize();
    });
    await assert.rejects(
      smokeTestArchive({ archivePath: renamedPath }),
      /Runner archive must contain exactly/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS Runner packaging refuses to archive a signed bundle off macOS', async () => {
  if (process.platform === 'darwin') return;
  await assert.rejects(
    packageRunnerBinary({
      version: '0.3.0-dev.1',
      target: { os: 'darwin', arch: 'arm64' },
      payloadPath: '/nonexistent/Happier Runner.app',
      outDir: tmpdir(),
    }),
    /macOS Runner packaging must run on macOS/u,
  );
});

test('the packed Runner smoke rejects an executable that only implements the version probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-version-only-'));
  try {
    const artifact = await packageFixtureRunner({
      root,
      body: 'printf "happier-runner 0.3.0-dev.1\\n"',
    });

    await assert.rejects(
      smokeTestArchive({ archivePath: artifact.path }),
      /Runner startup smoke did not fail at the activation-file boundary/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the packed Runner smoke reaches the safe missing-activation startup boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-startup-'));
  try {
    const artifact = await packageFixtureRunner({
      root,
      body: [
        'if [ "$1" = "--version" ]; then',
        '  printf "happier-runner 0.3.0-dev.1\\n"',
        '  exit 0',
        'fi',
        `printf "${SAFE_RUNNER_STARTUP_FAILURE}\\n" >&2`,
        'exit 1',
      ].join('\n'),
    });

    await smokeTestArchive({ archivePath: artifact.path });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the packed Runner smoke rejects ambient Bun executable dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-bun-dispatch-'));
  try {
    const artifact = await packageFixtureRunner({
      root,
      body: [
        'if [ "$1" = "--version" ]; then',
        '  printf "happier-runner 0.3.0-dev.1\\n"',
        '  exit 0',
        'fi',
        'if [ "$BUN_BE_BUN" = "1" ]; then',
        '  printf "HAPPIER_RUNNER_BUN_DISPATCH_EXECUTED\\n"',
        '  exit 0',
        'fi',
        `printf "${SAFE_RUNNER_STARTUP_FAILURE}\\n" >&2`,
        'exit 1',
      ].join('\n'),
    });

    await assert.rejects(
      smokeTestArchive({ archivePath: artifact.path }),
      /Runner candidate permits ambient Bun executable dispatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the packed Runner smoke accepts a launcher that scrubs Bun dispatch before core startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-bun-scrubbed-'));
  try {
    const artifact = await packageFixtureRunner({
      root,
      body: [
        'if [ "$1" = "--version" ]; then',
        '  printf "happier-runner 0.3.0-dev.1\\n"',
        '  exit 0',
        'fi',
        'unset BUN_BE_BUN',
        `printf "${SAFE_RUNNER_STARTUP_FAILURE}\\n" >&2`,
        'exit 1',
      ].join('\n'),
    });

    await smokeTestArchive({ archivePath: artifact.path });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
