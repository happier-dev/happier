import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  finalizeDarwinReleaseArchive,
  listDarwinPayloadMachOCode,
  notarizeDarwinPayload,
  repairAdHocDarwinPayloadSignatures,
  resolveGatekeeperAssessmentCommand,
  resolveDarwinPayloadNotarizationCommands,
  runGatekeeperAssessment,
  snapshotDarwinPayload,
  verifyDarwinPayloadNotarizationEvidence,
} from './notarize-standalone-binary.mjs';

const MACH_O_64_LE_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

function writeMachOFixture(filePath, suffix) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat([MACH_O_64_LE_MAGIC, Buffer.from(suffix)]));
  chmodSync(filePath, 0o755);
}

test('Darwin payload Mach-O discovery is exhaustive, deterministic, inside-out, and ignores executable scripts', () => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), 'happier-darwin-payload-discovery-'));
  try {
    writeMachOFixture(path.join(payloadDir, 'happier'), 'root');
    writeMachOFixture(path.join(payloadDir, 'tools', 'rg'), 'tool');
    writeMachOFixture(
      path.join(payloadDir, 'node_modules', 'esbuild', 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'),
      'esbuild',
    );
    const dylibPath = path.join(payloadDir, 'node_modules', 'native', 'addon.node');
    writeMachOFixture(dylibPath, 'addon');
    chmodSync(dylibPath, 0o644);
    const scriptPath = path.join(payloadDir, 'scripts', 'run.sh');
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(scriptPath, 0o755);
    const javaClassPath = path.join(payloadDir, 'node_modules', 'example', 'Main.class');
    mkdirSync(path.dirname(javaClassPath), { recursive: true });
    writeFileSync(
      javaClassPath,
      Buffer.from('cafebabe0000003d00100a00020003070004', 'hex'),
    );
    chmodSync(javaClassPath, 0o755);

    assert.deepEqual(
      listDarwinPayloadMachOCode(payloadDir).map(({ relativePath, executable }) => ({
        relativePath,
        executable,
      })),
      [
        {
          relativePath: 'node_modules/esbuild/node_modules/@esbuild/darwin-arm64/bin/esbuild',
          executable: true,
        },
        {
          relativePath: 'node_modules/native/addon.node',
          executable: false,
        },
        { relativePath: 'tools/rg', executable: true },
        { relativePath: 'happier', executable: true },
      ],
    );
  } finally {
    rmSync(payloadDir, { recursive: true, force: true });
  }
});

test('Darwin payload notarization signs and strictly verifies every Mach-O leaf before archiving the complete payload', () => {
  const commands = resolveDarwinPayloadNotarizationCommands({
    payloadPath: '/tmp/happier-v1.2.3-darwin-arm64',
    identity: 'Developer ID Application: Happier Dev (TEAMID)',
    machOCode: [
      {
        path: '/tmp/happier-v1.2.3-darwin-arm64/node_modules/@esbuild/darwin-arm64/bin/esbuild',
        relativePath: 'node_modules/@esbuild/darwin-arm64/bin/esbuild',
        executable: true,
      },
      {
        path: '/tmp/happier-v1.2.3-darwin-arm64/node_modules/native/addon.node',
        relativePath: 'node_modules/native/addon.node',
        executable: false,
      },
      {
        path: '/tmp/happier-v1.2.3-darwin-arm64/happier',
        relativePath: 'happier',
        executable: true,
      },
    ],
    zipPath: '/tmp/notary/happier-payload.zip',
    keyPath: '/tmp/notary/AuthKey_KEY.p8',
    keyId: 'KEY',
    issuerId: 'ISSUER',
    submissionId: '00000000-0000-0000-0000-000000000000',
    logPath: '/tmp/notary/notary-log.json',
  });

  assert.deepEqual(
    commands.codesign.map(([, args]) => args.at(-1)),
    [
      '/tmp/happier-v1.2.3-darwin-arm64/node_modules/@esbuild/darwin-arm64/bin/esbuild',
      '/tmp/happier-v1.2.3-darwin-arm64/node_modules/native/addon.node',
      '/tmp/happier-v1.2.3-darwin-arm64/happier',
    ],
  );
  assert.equal(commands.codesign.every(([, args]) => (
    args.includes('--options')
    && args.includes('runtime')
    && args.includes('--timestamp')
    && args.includes('--preserve-metadata=identifier,entitlements,launch-constraints,library-constraints')
  )), true);
  assert.deepEqual(
    commands.verify.map(([, args]) => args.at(-1)),
    commands.codesign.map(([, args]) => args.at(-1)),
  );
  assert.equal(commands.verify.every(([, args]) => args.includes('--strict=all')), true);
  assert.deepEqual(commands.archive, [
    'ditto',
    [
      '-c',
      '-k',
      '--keepParent',
      '/tmp/happier-v1.2.3-darwin-arm64',
      '/tmp/notary/happier-payload.zip',
    ],
  ]);
  assert.deepEqual(
    commands.assess.map(([, args]) => args.at(-1)),
    [
      '/tmp/happier-v1.2.3-darwin-arm64/node_modules/@esbuild/darwin-arm64/bin/esbuild',
      '/tmp/happier-v1.2.3-darwin-arm64/happier',
    ],
  );
  assert.equal(commands.assess.every(([, args]) => (
    args.includes('--ignore-cache') && args.includes('--no-cache')
  )), true, 'Gatekeeper propagation retries must bypass and not repopulate stale assessment results');
  assert.deepEqual(commands.submit, [
    'xcrun',
    [
      'notarytool',
      'submit',
      '/tmp/notary/happier-payload.zip',
      '--key',
      '/tmp/notary/AuthKey_KEY.p8',
      '--key-id',
      'KEY',
      '--issuer',
      'ISSUER',
      '--wait',
      '--timeout',
      '15m',
      '--output-format',
      'json',
    ],
  ]);
  assert.deepEqual(commands.log, [
    'xcrun',
    [
      'notarytool',
      'log',
      '00000000-0000-0000-0000-000000000000',
      '/tmp/notary/notary-log.json',
      '--key',
      '/tmp/notary/AuthKey_KEY.p8',
      '--key-id',
      'KEY',
      '--issuer',
      'ISSUER',
    ],
  ]);
  assert.equal(commands.ticketDelivery, 'online');
  assert.equal(commands.stapled, false);
  assert.equal(Object.values(commands).flat(Infinity).includes('stapler'), false);
});

test('Gatekeeper assessment retries only transient online-ticket propagation failures', () => {
  const command = ['spctl', ['--assess', '--type', 'execute', '/tmp/happier']];
  const retryDelays = [];
  let attempts = 0;
  const ticketPropagationError = new Error('spctl rejected the payload');
  ticketPropagationError.stderr = 'source=Unnotarized Developer ID\n';

  assert.equal(
    runGatekeeperAssessment(command, {
      attempts: 4,
      retryDelayMs: 10,
      runCommand: () => {
        attempts += 1;
        if (attempts < 3) throw ticketPropagationError;
      },
      sleep: (delayMs) => retryDelays.push(delayMs),
      logger: { warn: () => {} },
    }),
    true,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(retryDelays, [10, 20]);

  const policyError = new Error('spctl rejected the payload');
  policyError.stderr = 'source=Insufficient Context\n';
  let policyAttempts = 0;

  assert.throws(
    () => runGatekeeperAssessment(command, {
      attempts: 4,
      retryDelayMs: 10,
      runCommand: () => {
        policyAttempts += 1;
        throw policyError;
      },
      sleep: () => assert.fail('non-transient Gatekeeper errors must not sleep'),
      logger: { warn: () => {} },
    }),
    policyError,
  );
  assert.equal(policyAttempts, 1);
});

test('every Gatekeeper assessment bypasses and does not repopulate stale cached results', () => {
  const [, args] = resolveGatekeeperAssessmentCommand('/tmp/happier');
  assert.equal(args.includes('--ignore-cache'), true);
  assert.equal(args.includes('--no-cache'), true);
});

test('Gatekeeper assessment keeps a bounded thirty-minute window for accepted ticket propagation', () => {
  const command = ['spctl', ['--assess', '--type', 'execute', '/tmp/happier']];
  const retryDelays = [];
  let attempts = 0;
  const ticketPropagationError = new Error('spctl rejected the payload');
  ticketPropagationError.stderr = 'source=Unnotarized Developer ID\n';

  assert.throws(
    () => runGatekeeperAssessment(command, {
      runCommand: () => {
        attempts += 1;
        throw ticketPropagationError;
      },
      sleep: (delayMs) => retryDelays.push(delayMs),
      logger: { warn: () => {} },
    }),
    ticketPropagationError,
  );
  assert.equal(attempts, 18);
  assert.deepEqual(retryDelays.slice(0, 4), [15_000, 30_000, 60_000, 120_000]);
  assert.equal(retryDelays.length, 17);
  assert.equal(retryDelays.slice(3).every((delayMs) => delayMs === 120_000), true);
  assert.equal(retryDelays.reduce((total, delayMs) => total + delayMs, 0), 29 * 60_000 + 45_000);
});

test('Darwin payload evidence binds every staged byte, mode, symlink, and discovered Mach-O path', () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'happier-darwin-payload-evidence-'));
  const payloadDir = path.join(workDir, 'happier-v1.2.3-darwin-arm64');
  const evidencePath = path.join(workDir, 'payload.notary.json');
  try {
    writeMachOFixture(path.join(payloadDir, 'happier'), 'root');
    writeMachOFixture(path.join(payloadDir, 'tools', 'nested'), 'nested');
    mkdirSync(path.join(payloadDir, 'scripts'), { recursive: true });
    writeFileSync(path.join(payloadDir, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(path.join(payloadDir, 'scripts', 'run.sh'), 0o755);
    const scriptLinkPath = path.join(payloadDir, 'scripts', 'run-link');
    symlinkSync('run.sh', scriptLinkPath);

    const snapshot = snapshotDarwinPayload(payloadDir);
    writeFileSync(evidencePath, `${JSON.stringify({
      schemaVersion: 2,
      payload: path.basename(payloadDir),
      payloadSha256: snapshot.payloadSha256,
      entryCount: snapshot.entryCount,
      machO: snapshot.machO,
      signingIdentity: '0123456789ABCDEF0123456789ABCDEF01234567',
      notarization: {
        submissionId: '00000000-0000-0000-0000-000000000000',
        status: 'Accepted',
        archiveSha256: 'a'.repeat(64),
        ticketDelivery: 'online',
        stapled: false,
      },
    }, null, 2)}\n`, 'utf8');

    assert.equal(
      verifyDarwinPayloadNotarizationEvidence({
        payloadPath: payloadDir,
        evidencePath,
        verifyCode: () => {},
        assessCode: () => {},
      }).payloadSha256,
      snapshot.payloadSha256,
    );

    writeFileSync(path.join(payloadDir, 'scripts', 'run.sh'), '#!/bin/sh\nexit 9\n', 'utf8');
    assert.throws(
      () => verifyDarwinPayloadNotarizationEvidence({
        payloadPath: payloadDir,
        evidencePath,
        verifyCode: () => {},
        assessCode: () => {},
      }),
      /payload evidence does not match the exact staged payload/i,
    );

    writeFileSync(path.join(payloadDir, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    rmSync(scriptLinkPath);
    symlinkSync('../happier', scriptLinkPath);
    assert.throws(
      () => verifyDarwinPayloadNotarizationEvidence({
        payloadPath: payloadDir,
        evidencePath,
        verifyCode: () => {},
        assessCode: () => {},
      }),
      /payload evidence does not match the exact staged payload/i,
    );

    rmSync(scriptLinkPath);
    symlinkSync('run.sh', scriptLinkPath);
    chmodSync(path.join(payloadDir, 'scripts', 'run.sh'), 0o644);
    assert.throws(
      () => verifyDarwinPayloadNotarizationEvidence({
        payloadPath: payloadDir,
        evidencePath,
        verifyCode: () => {},
        assessCode: () => {},
      }),
      /payload evidence does not match the exact staged payload/i,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Darwin payload execution completes every sign and strict verification before archive submission', () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'happier-darwin-payload-execution-'));
  const payloadDir = path.join(workDir, 'happier-v1.2.3-darwin-arm64');
  const evidencePath = path.join(workDir, 'payload.notary.json');
  const invocations = [];
  const loggedEvidence = [];
  try {
    writeMachOFixture(path.join(payloadDir, 'happier'), 'root');
    writeMachOFixture(path.join(payloadDir, 'tools', 'nested'), 'nested');

    const evidence = notarizeDarwinPayload({
      payloadPath: payloadDir,
      identity: '0123456789ABCDEF0123456789ABCDEF01234567',
      outPath: evidencePath,
      githubOutput: '',
      environment: {
        APPLE_API_KEY_ID: 'KEY',
        APPLE_API_ISSUER_ID: 'ISSUER',
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----',
      },
      logger: { log: (value) => loggedEvidence.push(String(value)) },
      finalizePayloadBeforeSnapshot: () => {
        invocations.push({ command: 'refresh-runtime-asset-manifest', args: [] });
        writeFileSync(
          path.join(payloadDir, 'runtime-asset-manifest'),
          'post-codesign-digest',
          'utf8',
        );
      },
      runCommand: ([command, args], options = {}) => {
        invocations.push({ command, args: [...args] });
        if (command === 'ditto') {
          writeFileSync(args.at(-1), 'exact-submitted-archive', 'utf8');
        }
        if (command === 'xcrun' && args[1] === 'submit') {
          assert.equal(options.capture, true);
          return JSON.stringify({
            id: '00000000-0000-0000-0000-000000000000',
            status: 'Accepted',
          });
        }
        return '';
      },
    });

    const archiveIndex = invocations.findIndex(({ command }) => command === 'ditto');
    const refreshIndex = invocations.findIndex(({ command }) => (
      command === 'refresh-runtime-asset-manifest'
    ));
    const submitIndex = invocations.findIndex(({ command, args }) => (
      command === 'xcrun' && args[1] === 'submit'
    ));
    const signInvocations = invocations.filter(({ command, args }) => (
      command === 'codesign' && args.includes('--sign')
    ));
    const verifyInvocations = invocations.filter(({ command, args }) => (
      command === 'codesign' && args.includes('--verify')
    ));
    assert.deepEqual(signInvocations.map(({ args }) => args.at(-1)), [
      path.join(payloadDir, 'tools', 'nested'),
      path.join(payloadDir, 'happier'),
    ]);
    assert.equal(signInvocations.length, evidence.machO.length);
    assert.equal(verifyInvocations.length, evidence.machO.length);
    assert.equal(refreshIndex > invocations.lastIndexOf(verifyInvocations.at(-1)), true);
    assert.equal(refreshIndex < archiveIndex, true);
    assert.equal(submitIndex > archiveIndex, true);
    assert.equal(
      invocations.slice(submitIndex + 1).some(({ command }) => command === 'spctl'),
      true,
    );
    assert.equal(evidence.notarization.archiveSha256.length, 64);
    assert.equal(evidence.payloadSha256, snapshotDarwinPayload(payloadDir).payloadSha256);
    const persistedEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal('logPath' in persistedEvidence.notarization, false);
    assert.equal(JSON.stringify(persistedEvidence).includes(workDir), false);
    assert.equal(loggedEvidence.some((value) => value.includes(workDir)), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('rejected Darwin notarization reports its log without exposing the absolute workspace path', () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'happier-darwin-payload-rejected-'));
  const payloadDir = path.join(workDir, 'happier-v1.2.3-darwin-arm64');
  const evidencePath = path.join(workDir, 'payload.notary.json');
  try {
    writeMachOFixture(path.join(payloadDir, 'happier'), 'root');
    assert.throws(
      () => notarizeDarwinPayload({
        payloadPath: payloadDir,
        identity: 'Developer ID Application: Happier Dev (TEAMID)',
        outPath: evidencePath,
        githubOutput: '',
        environment: {
          APPLE_API_KEY_ID: 'KEY',
          APPLE_API_ISSUER_ID: 'ISSUER',
          APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----',
        },
        logger: { log: () => {} },
        runCommand: ([command, args]) => {
          if (command === 'ditto') {
            writeFileSync(args.at(-1), 'exact-submitted-archive', 'utf8');
          }
          if (command === 'xcrun' && args[1] === 'submit') {
            return JSON.stringify({
              id: '00000000-0000-0000-0000-000000000000',
              status: 'Invalid',
            });
          }
          return '';
        },
      }),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.equal(error.message.includes(workDir), false);
        assert.match(error.message, /payload\.notary\.json\.notary-log\.json/u);
        return true;
      },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Darwin release archive replacement is atomic and verifies the exact repackaged payload evidence first', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'happier-darwin-release-archive-'));
  const archivePath = path.join(workDir, 'hstack-v1.2.3-darwin-arm64.tar.gz');
  const evidencePath = path.join(workDir, 'darwin-arm64.hstack.json');
  const expectedPayloadName = 'hstack-v1.2.3-darwin-arm64';
  const events = [];
  try {
    writeFileSync(archivePath, 'unsigned-archive', 'utf8');
    const result = await finalizeDarwinReleaseArchive({
      archivePath,
      expectedPayloadName,
      identity: '0123456789ABCDEF0123456789ABCDEF01234567',
      evidencePath,
      platform: 'darwin',
      extractArchiveImpl: async ({ extractDir }) => {
        const payloadDir = path.join(extractDir, expectedPayloadName);
        mkdirSync(payloadDir, { recursive: true });
        writeMachOFixture(path.join(payloadDir, 'hstack'), 'signed-payload');
        events.push(`extract:${path.basename(extractDir)}`);
      },
      notarizePayloadImpl: (argv, { finalizePayloadBeforeSnapshot }) => {
        events.push('notarize');
        assert.deepEqual(argv, [
          '--payload',
          path.join(resultWorkDir(events), 'source', expectedPayloadName),
          '--identity',
          '0123456789ABCDEF0123456789ABCDEF01234567',
          '--out',
          evidencePath,
        ]);
        finalizePayloadBeforeSnapshot();
        writeFileSync(evidencePath, '{}\n', 'utf8');
      },
      finalizePayloadBeforeSnapshot: (payloadPath) => {
        events.push('refresh');
        assert.equal(path.basename(payloadPath), expectedPayloadName);
      },
      createArchiveImpl: async ({ artifactPath, sourceName }) => {
        events.push(`archive:${sourceName}`);
        assert.equal(readFileSync(archivePath, 'utf8'), 'unsigned-archive');
        writeFileSync(artifactPath, 'signed-archive', 'utf8');
      },
      verifyEvidenceImpl: ({ payloadPath, evidencePath: observedEvidencePath }) => {
        events.push('verify');
        assert.equal(path.basename(payloadPath), expectedPayloadName);
        assert.equal(observedEvidencePath, evidencePath);
        assert.equal(readFileSync(archivePath, 'utf8'), 'unsigned-archive');
        return { payload: expectedPayloadName };
      },
      makeWorkDirImpl: () => {
        const deterministicWorkDir = path.join(workDir, 'work');
        mkdirSync(deterministicWorkDir, { recursive: true });
        events.push(`work:${deterministicWorkDir}`);
        return deterministicWorkDir;
      },
    });

    assert.deepEqual(events.map((event) => event.split(':')[0]), [
      'work',
      'extract',
      'notarize',
      'refresh',
      'archive',
      'extract',
      'verify',
    ]);
    assert.equal(readFileSync(archivePath, 'utf8'), 'signed-archive');
    assert.equal(result.archivePath, archivePath);
    assert.equal(result.payload, expectedPayloadName);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function resultWorkDir(events) {
  const event = events.find((entry) => entry.startsWith('work:'));
  assert.ok(event);
  return event.slice('work:'.length);
}

test('local payload repair signs every nested Mach-O while preserving executable scripts', {
  skip: process.platform !== 'darwin',
}, () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'happier-payload-adhoc-signature-'));
  const payloadDir = path.join(workDir, 'happier-v0.0.0-darwin-local');
  const binaryPath = path.join(payloadDir, 'happier');
  const nestedBinaryPath = path.join(payloadDir, 'tools', 'nested-bun');
  const scriptPath = path.join(payloadDir, 'scripts', 'run.sh');
  try {
    const bunTarget = process.arch === 'x64' ? 'bun-darwin-x64' : 'bun-darwin-arm64';
    mkdirSync(path.dirname(nestedBinaryPath), { recursive: true });
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    for (const outputPath of [binaryPath, nestedBinaryPath]) {
      execFileSync('bun', [
        'build',
        '--compile',
        '--no-cache',
        `--target=${bunTarget}`,
        fileURLToPath(new URL('./notarize-standalone-binary.mjs', import.meta.url)),
        '--outfile',
        outputPath,
      ], { stdio: 'pipe' });
    }
    writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(scriptPath, 0o755);
    const scriptBefore = Buffer.from('#!/bin/sh\nexit 0\n');

    const evidence = repairAdHocDarwinPayloadSignatures(payloadDir);

    assert.equal(evidence.signatureType, 'adhoc');
    assert.equal(evidence.payload, path.basename(payloadDir));
    assert.deepEqual(evidence.machO.map((entry) => entry.path), [
      'tools/nested-bun',
      'happier',
    ]);
    for (const outputPath of [binaryPath, nestedBinaryPath]) {
      assert.doesNotThrow(() => {
        execFileSync('codesign', ['--verify', '--strict=all', outputPath], { stdio: 'pipe' });
      });
    }
    assert.deepEqual(readFileSync(scriptPath), scriptBefore);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
