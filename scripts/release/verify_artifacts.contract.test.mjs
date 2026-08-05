import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

import { resolveTarCreateArgs } from '../pipeline/release/lib/archive-tar-options.mjs';
import { terminateProcessTreeByPid } from '../testing/process/processTree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const verifyArtifactsPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs');
const nodeArchivePath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'node-archive.mjs');

function normalizeArchivePlatform(platform) {
  return platform === 'win32' ? 'windows' : platform;
}

function normalizeArchiveArch(arch) {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

function createDeterministicIncompressiblePadding(byteLength) {
  // Keep scan-boundary fixtures below the independent archive expansion limit.
  const bytes = Buffer.alloc(byteLength);
  let state = 0x9e3779b9;
  for (let index = 0; index < byteLength; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function createCanonicalTarArchive({ archivePath, sourcePath, sourceName }) {
  createTarArchiveWithNumericOwner({
    archivePath,
    sourcePath,
    sourceName,
    uid: 0,
    gid: 0,
  });
}

function createTarArchiveWithNumericOwner({ archivePath, sourcePath, sourceName, uid, gid }) {
  const version = spawnSync('tar', ['--version'], { encoding: 'utf-8' });
  const isGnuTar = String(version.stdout ?? '').includes('GNU tar');
  const args = uid === 0 && gid === 0
    ? resolveTarCreateArgs({
        isGnuTar,
        excludeArgs: [],
        artifactArg: archivePath,
        sourceDirArg: sourcePath,
        sourceNameArg: sourceName,
        compressed: true,
      })
    : isGnuTar
      ? [
          '--sort=name',
          '--mtime=@0',
          `--owner=${uid}`,
          `--group=${gid}`,
          '--numeric-owner',
          '-czf',
          archivePath,
          '-C',
          sourcePath,
          sourceName,
        ]
      : [
          '--no-mac-metadata',
          '--uid',
          String(uid),
          '--gid',
          String(gid),
          '--numeric-owner',
          '-czf',
          archivePath,
          '-C',
          sourcePath,
          sourceName,
        ];
  execFileSync('tar', args, { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 });
}

async function createReleaseArchiveFixture({
  workspace,
  archiveStem = 'happier-v0.0.0-admission-linux-x64',
  archiveRoot = archiveStem,
  files,
}) {
  const artifactsDir = join(workspace, 'artifacts');
  const stageRoot = join(workspace, 'stage');
  const archiveStageDir = join(stageRoot, archiveRoot);
  const archiveName = `${archiveStem}.tar.gz`;
  const archivePath = join(artifactsDir, archiveName);
  const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-admission.txt');

  await mkdir(archiveStageDir, { recursive: true, mode: 0o755 });
  await chmod(archiveStageDir, 0o755);
  await mkdir(artifactsDir, { recursive: true });
  for (const file of files) {
    const filePath = join(archiveStageDir, file.path);
    await mkdir(dirname(filePath), { recursive: true, mode: 0o755 });
    await writeFile(filePath, file.contents, { mode: file.mode ?? 0o644 });
    await chmod(filePath, file.mode ?? 0o644);
  }

  execFileSync(
    process.execPath,
    [
      nodeArchivePath,
      '--artifact-path',
      archivePath,
      '--source-path',
      stageRoot,
      '--source-name',
      archiveRoot,
    ],
    { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 },
  );
  await writeFile(checksumsPath, `${await sha256(archivePath)}  ${archiveName}\n`, 'utf-8');
  return { archiveName, archivePath, archiveRoot, stageRoot, artifactsDir, checksumsPath };
}

function verifyArchiveFixture({
  artifactsDir,
  checksumsPath,
  env = process.env,
  extraArgs = [],
}) {
  return spawnSync(
    process.execPath,
    [
      verifyArtifactsPath,
      '--artifacts-dir',
      artifactsDir,
      '--checksums',
      checksumsPath,
      '--skip-smoke',
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf-8',
      timeout: 10_000,
    },
  );
}

test('verify-artifacts can require a signed checksum manifest', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-require-signature-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const artifactName = 'artifact.bin';
    const artifactPath = join(artifactsDir, artifactName);
    const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-test.txt');

    await mkdir(artifactsDir, { recursive: true });
    await writeFile(artifactPath, 'artifact\n', 'utf-8');
    await writeFile(checksumsPath, `${await sha256(artifactPath)}  ${artifactName}\n`, 'utf-8');

    const result = spawnSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
        '--require-signature',
        '--skip-smoke',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 5_000,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required checksum signature is missing/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts can require every archive to appear in the signed checksum manifest', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-complete-archives-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [{ path: 'happier', contents: 'binary\n', mode: 0o755 }],
    });
    await writeFile(
      join(fixture.artifactsDir, 'happier-v0.0.0-admission-linux-arm64.tar.gz'),
      'unchecksummed archive\n',
      'utf-8',
    );

    const result = verifyArchiveFixture({
      artifactsDir: fixture.artifactsDir,
      checksumsPath: fixture.checksumsPath,
      extraArgs: ['--require-all-archives-checksummed'],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive set does not match the checksum manifest/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts can require every candidate payload file to appear in the signed checksum manifest', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-complete-envelope-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [{ path: 'happier', contents: 'binary\n', mode: 0o755 }],
    });
    await writeFile(
      join(fixture.artifactsDir, 'darwin-x64.cli.json'),
      '{"tampered":true}\n',
      'utf-8',
    );

    const result = verifyArchiveFixture({
      artifactsDir: fixture.artifactsDir,
      checksumsPath: fixture.checksumsPath,
      extraArgs: ['--require-all-artifacts-checksummed'],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact set does not match the checksum manifest/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects notarization evidence changed after its checksum was signed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-tampered-evidence-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const evidenceName = 'darwin-arm64.cli.json';
    const evidencePath = join(artifactsDir, evidenceName);
    const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-test.txt');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(evidencePath, '{"status":"accepted"}\n', 'utf-8');
    await writeFile(checksumsPath, `${await sha256(evidencePath)}  ${evidenceName}\n`, 'utf-8');
    await writeFile(evidencePath, '{"status":"tampered"}\n', 'utf-8');

    const result = spawnSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
        '--require-all-artifacts-checksummed',
        '--skip-archive-admission',
        '--skip-smoke',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 5_000,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch for darwin-arm64\.cli\.json/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function rewriteFixtureChecksum(fixture) {
  await writeFile(
    fixture.checksumsPath,
    `${await sha256(fixture.archivePath)}  ${fixture.archiveName}\n`,
    'utf-8',
  );
}

async function rewriteFixtureWithoutExplicitNestedDirectory(fixture) {
  await tar.c(
    {
      cwd: fixture.stageRoot,
      file: fixture.archivePath,
      gzip: true,
      mtime: new Date(0),
      noDirRecurse: true,
      portable: true,
    },
    [
      fixture.archiveRoot,
      `${fixture.archiveRoot}/nested/tool`,
    ],
  );
  await rewriteFixtureChecksum(fixture);
}

function withoutExecutableSearchPath(env = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => name.toLowerCase() !== 'path'),
    ),
    PATH: '',
  };
}

async function runCommandWithWallTimeout(command, args, { cwd, env, timeoutMs }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let timedOut = false;
  let timer;

  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolvePromise, rejectPromise) => {
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };

    child.once('error', (error) => {
      settle(error);
    });
    child.once('close', (code, signal) => {
      if (timedOut) return;
      if ((code ?? 1) !== 0) {
        settle(
          new Error(
            `Command failed with status ${code ?? 1}${signal ? ` (${signal})` : ''}: ${[stdout, stderr]
              .map((value) => value.trim())
              .filter(Boolean)
              .join('\n')}`,
          ),
        );
        return;
      }
      settle();
    });

    timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTreeByPid(child.pid ?? 0, {
        graceMs: 250,
        pollMs: 25,
        skipAliveCheck: true,
      }).finally(() => {
        settle(new Error(`Command timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
  });
}

test('verify-artifacts discovers its checksum file without a POSIX shell', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-checksum-discovery-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const artifactName = 'artifact.bin';
    const artifactPath = join(artifactsDir, artifactName);
    const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-test.txt');

    await mkdir(artifactsDir, { recursive: true });
    await writeFile(artifactPath, 'artifact\n', 'utf-8');
    await writeFile(checksumsPath, `${await sha256(artifactPath)}  ${artifactName}\n`, 'utf-8');

    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--skip-smoke',
      ],
      {
        cwd: repoRoot,
        env: withoutExecutableSearchPath(),
        stdio: 'pipe',
        timeout: 5_000,
      },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts detects a signature without relying on a POSIX shell', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-signature-discovery-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const artifactName = 'artifact.bin';
    const artifactPath = join(artifactsDir, artifactName);
    const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-test.txt');

    await mkdir(artifactsDir, { recursive: true });
    await writeFile(artifactPath, 'artifact\n', 'utf-8');
    await writeFile(checksumsPath, `${await sha256(artifactPath)}  ${artifactName}\n`, 'utf-8');
    await writeFile(`${checksumsPath}.minisig`, 'signature\n', 'utf-8');

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            verifyArtifactsPath,
            '--artifacts-dir',
            artifactsDir,
            '--checksums',
            checksumsPath,
            '--skip-smoke',
          ],
          {
            cwd: repoRoot,
            env: withoutExecutableSearchPath(),
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5_000,
          },
        ),
      /signature found but no --public-key/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts smoke extraction uses the canonical in-process archive owner without system tar', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-smoke-no-tar-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      archiveStem: 'happier-v0.0.0-no-tar-windows-x64',
      files: [{
        path: 'happier.exe',
        contents: 'synthetic Windows binary is not executed on non-Windows hosts\n',
        mode: 0o755,
      }],
    });

    const result = spawnSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        fixture.artifactsDir,
        '--checksums',
        fixture.checksumsPath,
      ],
      {
        cwd: repoRoot,
        env: withoutExecutableSearchPath(),
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );

    assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects high-confidence credential bytes without echoing them', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-credential-admission-'));
  const syntheticCredential = `github_pat_${'A'.repeat(82)}`;
  try {
    const scanTempDir = join(workspace, 'scan-temp');
    await mkdir(scanTempDir, { recursive: true });
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [
        {
          path: 'happier',
          contents: Buffer.concat([
            createDeterministicIncompressiblePadding(65_530),
            Buffer.from(`\u0000${syntheticCredential}\u0000compiled-suffix`, 'utf-8'),
          ]),
          mode: 0o755,
        },
      ],
    });

    const result = verifyArchiveFixture({
      ...fixture,
      env: {
        ...process.env,
        TMPDIR: scanTempDir,
        TMP: scanTempDir,
        TEMP: scanTempDir,
      },
    });
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.notEqual(result.status, 0);
    assert.match(combinedOutput, /archive privacy admission failed.*credential-token/i);
    assert.doesNotMatch(combinedOutput, new RegExp(syntheticCredential));
    assert.deepEqual(await readdir(scanTempDir), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects absolute user/build paths embedded in release payloads', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-path-admission-'));
  const syntheticBuildPaths = [
    { value: '/Users/synthetic-release-builder/work/happier/dev/apps/cli/source.ts', rule: 'absolute-user-path' },
    { value: '/home/synthetic-release-builder/work/happier/dev/apps/cli/source.ts', rule: 'absolute-user-path' },
    { value: 'C:\\Users\\synthetic-release-builder\\work\\happier\\dev\\apps\\cli\\source.ts', rule: 'absolute-user-path' },
    { value: '/__w/happier/happier/apps/cli/source.ts', rule: 'absolute-build-path' },
    { value: 'D:\\a\\happier\\happier\\apps\\cli\\source.ts', rule: 'absolute-build-path' },
  ];
  try {
    for (const [index, syntheticBuildPath] of syntheticBuildPaths.entries()) {
      const fixture = await createReleaseArchiveFixture({
        workspace: join(workspace, String(index)),
        files: [
          {
            path: 'happier',
            contents: Buffer.from(`source-map\u0000${syntheticBuildPath.value}\u0000`, 'utf-8'),
            mode: 0o755,
          },
        ],
      });

      const result = verifyArchiveFixture(fixture);
      const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      assert.notEqual(result.status, 0);
      assert.match(
        combinedOutput,
        new RegExp(`archive privacy admission failed.*${syntheticBuildPath.rule}`, 'i'),
      );
      assert.equal(combinedOutput.includes(syntheticBuildPath.value), false);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects synthetic private-key envelopes without echoing matching bytes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-private-key-admission-'));
  const syntheticPrivateKey = [
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    'U1lOVEhFVElDX1BSSVZBVEVfS0VZX1NFTlRJTkVM',
    '-----END ENCRYPTED PRIVATE KEY-----',
    '',
  ].join('\n');
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [{ path: 'happier', contents: syntheticPrivateKey, mode: 0o755 }],
    });

    const result = verifyArchiveFixture(fixture);
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.notEqual(result.status, 0);
    assert.match(combinedOutput, /archive privacy admission failed.*private-key/i);
    assert.equal(combinedOutput.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----'), false);
    assert.equal(combinedOutput.includes('U1lOVEhFVElDX1BSSVZBVEVfS0VZX1NFTlRJTkVM'), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts detects boundary-spanning UTF-16LE Windows build paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-utf16-path-admission-'));
  const syntheticBuildPath =
    'C:\\Users\\synthetic-release-builder\\work\\happier\\dev\\apps\\cli\\source.ts';
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [
        {
          path: 'happier',
          contents: Buffer.concat([
            createDeterministicIncompressiblePadding(65_529),
            Buffer.from(syntheticBuildPath, 'utf16le'),
          ]),
          mode: 0o755,
        },
      ],
    });

    const result = verifyArchiveFixture(fixture);
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.notEqual(result.status, 0);
    assert.match(combinedOutput, /archive privacy admission failed.*absolute-user-path/i);
    assert.equal(combinedOutput.includes(syntheticBuildPath), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts allows binary data, public certificates, and license prose that are not credentials', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-privacy-false-positive-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [
        {
          path: 'happier',
          contents: Buffer.concat([
            Buffer.from([0x00, 0xff, 0x10, 0x80]),
            Buffer.from('sk-short\u0000token\u0000private key\u0000', 'utf-8'),
          ]),
          mode: 0o755,
        },
        {
          path: 'LICENSE.txt',
          contents: 'Permission is granted to use public-key cryptography. Keep your private key and token secure.\n',
        },
        {
          path: 'public-certificate.pem',
          contents: [
            '-----BEGIN CERTIFICATE-----',
            'U1lOVEhFVElDX1BVQkxJQ19DRVJUSUZJQ0FURQ==',
            '-----END CERTIFICATE-----',
            '',
          ].join('\n'),
        },
      ],
    });

    const result = verifyArchiveFixture(fixture);
    assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects a release archive whose payload root does not match its artifact name', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-root-admission-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      archiveRoot: 'unexpected-root',
      files: [{ path: 'happier', contents: 'binary\n', mode: 0o755 }],
    });

    const result = verifyArchiveFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /archive payload root.*artifact name/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects non-canonical archived owners', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-owner-admission-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [{ path: 'happier', contents: 'binary\n', mode: 0o755 }],
    });
    createTarArchiveWithNumericOwner({
      archivePath: fixture.archivePath,
      sourcePath: fixture.stageRoot,
      sourceName: fixture.archiveRoot,
      uid: 123,
      gid: 456,
    });
    await rewriteFixtureChecksum(fixture);

    const result = verifyArchiveFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /non-canonical-owner/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects non-canonical archived file modes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-mode-admission-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [{ path: 'happier', contents: 'binary\n', mode: 0o600 }],
    });
    createCanonicalTarArchive({
      archivePath: fixture.archivePath,
      sourcePath: fixture.stageRoot,
      sourceName: fixture.archiveRoot,
    });
    await rewriteFixtureChecksum(fixture);

    const result = verifyArchiveFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /non-canonical-mode/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts applies the non-executable mode contract to UI web archives', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-ui-mode-admission-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      archiveStem: 'happier-ui-web-v0.0.0-admission-web-any',
      archiveRoot: 'happier-ui-web-v0.0.0-admission-web-any',
      files: [{ path: 'index.html', contents: '<!doctype html>\n', mode: 0o755 }],
    });
    createCanonicalTarArchive({
      archivePath: fixture.archivePath,
      sourcePath: fixture.stageRoot,
      sourceName: fixture.archiveRoot,
    });
    await rewriteFixtureChecksum(fixture);

    const result = verifyArchiveFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /non-canonical-mode/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts admits canonical UI web archive roots and static-file modes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-ui-positive-admission-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      archiveStem: 'happier-ui-web-v0.0.0-admission-web-any',
      archiveRoot: 'happier-ui-web-v0.0.0-admission-web-any',
      files: [
        { path: 'index.html', contents: '<!doctype html>\n', mode: 0o644 },
        { path: 'assets/app.js', contents: 'console.log("synthetic public bundle");\n', mode: 0o644 },
      ],
    });

    const result = verifyArchiveFixture(fixture);
    assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects files whose parent directories have no explicit admitted archive entries', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-parent-admission-'));
  try {
    const fixture = await createReleaseArchiveFixture({
      workspace,
      files: [{ path: 'nested/tool', contents: 'binary\n', mode: 0o755 }],
    });
    await rewriteFixtureWithoutExplicitNestedDirectory(fixture);

    const result = verifyArchiveFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /explicit parent directory/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts smoke-runs packaged server binaries with isolated startup env instead of --help', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-server-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-test-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const markerPath = join(workspace, 'server-smoke-marker.txt');
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-test.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "${1-}" == "--help" ]]; then',
        '  echo "server smoke should not use --help"',
        '  exit 1',
        'fi',
        '[[ "${PORT-}" == "0" ]] || { echo "expected PORT=0 but got ${PORT-}"; exit 1; }',
        '[[ "${METRICS_PORT-}" == "0" ]] || { echo "expected METRICS_PORT=0 but got ${METRICS_PORT-}"; exit 1; }',
        '[[ -n "${HAPPIER_SERVER_LIGHT_DATA_DIR-}" ]] || { echo "missing HAPPIER_SERVER_LIGHT_DATA_DIR"; exit 1; }',
        `printf 'PORT=%s\\nMETRICS_PORT=%s\\nDATA=%s\\n' "$PORT" "$METRICS_PORT" "$HAPPIER_SERVER_LIGHT_DATA_DIR" > "${markerPath}"`,
        'exit 0',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    createCanonicalTarArchive({ archivePath, sourcePath: stageRoot, sourceName: archiveStem });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_SERVER_LIGHT_DATA_DIR: '',
          PORT: '',
          METRICS_PORT: '',
        },
        stdio: 'pipe',
      },
    );

    const marker = await readFile(markerPath, 'utf-8');
    assert.match(marker, /^PORT=0$/m);
    assert.match(marker, /^METRICS_PORT=0$/m);
    assert.match(marker, /^DATA=.+$/m);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts selects the packaged binary instead of a sibling sidecar directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-server-layout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-layout-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const markerPath = join(workspace, 'selected-binary.txt');
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-layout.txt');

    await mkdir(join(stageDir, 'generated', 'sqlite-client'), { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(stageDir, 'generated', 'sqlite-client', 'placeholder.txt'), 'placeholder\n', 'utf-8');
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `printf 'selected-binary\\n' > "${markerPath}"`,
        'exit 0',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    createCanonicalTarArchive({ archivePath, sourcePath: stageRoot, sourceName: archiveStem });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );

    assert.equal(await readFile(markerPath, 'utf-8'), 'selected-binary\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts includes stdout in smoke failures when stderr is empty', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-stdout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-v0.0.0-test-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-test.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier'),
      '#!/usr/bin/env bash\necho "stdout-only smoke failure"\nexit 1\n',
      { encoding: 'utf-8', mode: 0o755 },
    );

    createCanonicalTarArchive({ archivePath, sourcePath: stageRoot, sourceName: archiveStem });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            verifyArtifactsPath,
            '--artifacts-dir',
            artifactsDir,
            '--checksums',
            checksumsPath,
          ],
          { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' },
        ),
      /stdout-only smoke failure/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects a CLI version mismatch even when optional smoke is skipped', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-cli-version-'));
  try {
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const fixture = await createReleaseArchiveFixture({
      workspace,
      archiveStem: `happier-v1.2.3-${archivePlatform}-${archiveArch}`,
      files: [{
        path: 'happier',
        contents: "#!/bin/sh\nprintf '%s\\n' '1.2.3-preview.99'\n",
        mode: 0o755,
      }],
    });

    const result = verifyArchiveFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      /version mismatch.*expected 1\.2\.3.*got 1\.2\.3-preview\.99/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts accepts a CLI binary whose version matches its archive version', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-cli-version-match-'));
  try {
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const version = '1.2.3-preview.99';
    const fixture = await createReleaseArchiveFixture({
      workspace,
      archiveStem: `happier-v${version}-${archivePlatform}-${archiveArch}`,
      files: [{
        path: 'happier',
        contents: `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
        mode: 0o755,
      }],
    });

    const result = verifyArchiveFixture(fixture);
    assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts rejects a CLI that times out before its version can be attested', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-cli-version-timeout-'));
  try {
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const fixture = await createReleaseArchiveFixture({
      workspace,
      archiveStem: `happier-v1.2.3-${archivePlatform}-${archiveArch}`,
      files: [{
        path: 'happier',
        contents: [
          '#!/bin/sh',
          "printf 'version %s\\n' '1.2.3-preview.99'",
          'while true; do sleep 1; done',
          '',
        ].join('\n'),
        mode: 0o755,
      }],
    });

    const result = verifyArchiveFixture({
      ...fixture,
      env: {
        ...process.env,
        HAPPIER_RELEASE_BINARY_SMOKE_TIMEOUT_MS: '500',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /smoke test timed out/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts hard-times-out packaged server binaries that ignore SIGTERM', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-timeout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-timeout-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-timeout.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        "trap '' TERM",
        "printf 'ready\\n'",
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    createCanonicalTarArchive({ archivePath, sourcePath: stageRoot, sourceName: archiveStem });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    const startedAt = Date.now();
    await runCommandWithWallTimeout(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        timeoutMs: 30_000,
      },
    );
    assert.ok(
      Date.now() - startedAt < 28_000,
      'verify-artifacts should stop hung packaged server binaries on its internal smoke timeout',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts honors the packaged server smoke timeout override', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-timeout-override-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-timeout-override-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-timeout-override.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        "trap '' TERM",
        "printf 'ready\\n'",
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    createCanonicalTarArchive({ archivePath, sourcePath: stageRoot, sourceName: archiveStem });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    const startedAt = Date.now();
    await runCommandWithWallTimeout(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_RELEASE_SERVER_SMOKE_TIMEOUT_MS: '200',
        },
        timeoutMs: 5_000,
      },
    );
    assert.ok(
      Date.now() - startedAt < 4_000,
      'verify-artifacts should respect the shorter packaged server smoke timeout override',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
