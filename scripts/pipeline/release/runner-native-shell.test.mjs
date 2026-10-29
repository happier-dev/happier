// Release-owner contract for the signed Linux/macOS Happier Runner shell.
//
// `apps/cli/runner-native-shell/tests/shell_contract.rs` keeps the crate's
// endpoint-visible behavior honest. This suite re-derives the facts that decide
// the published archive layout and native trust, because those belong to the
// release owner and must stay checkable on a machine that cannot compile the
// GTK/WebKit or Apple toolchains.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  RUNNER_PUBLICATION_ELIGIBLE_TARGET_IDS,
  RUNNER_CORE_SIDECAR_STEM,
  RUNNER_NATIVE_SHELL_DIR,
  RUNNER_PACKAGE_TARGET_IDS,
  RUNNER_SHELL_BINARY_STEM,
  finalizeRunnerPayload,
  isRunnerTargetEligibleForPublication,
  resolveRunnerPublicationEligibleBinaryTargets,
  resolveRunnerBundleArchiveCommand,
  resolveRunnerCoreSidecarPath,
  resolveRunnerPackageLayout,
  resolveRunnerShellBuildCommand,
  resolveRunnerShellBundleDirectory,
  resolveRunnerShellRustTarget,
  resolveRunnerShellPayload,
  runnerTargetId,
} from './lib/runner-packaging.mjs';
import { resolveDarwinAppBundleNotarizationCommands, snapshotDarwinPayload } from './notarize-standalone-binary.mjs';
import { smokeTestArchive, verifyRunnerArchiveAdmission, verifyReleaseArchiveAdmission } from './verify-artifacts.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shellDir = join(repoRoot, RUNNER_NATIVE_SHELL_DIR);
const shellConfig = JSON.parse(readFileSync(join(shellDir, 'tauri.conf.json'), 'utf8'));
const protocolLayoutSource = readFileSync(
  join(repoRoot, 'packages', 'protocol', 'src', 'ephemeralRunner', 'runnerPackageLayout.ts'),
  'utf8',
);

const ALL_TARGET_IDS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];

test('macOS candidate admission verifies the complete unchanged stapled bundle and contained links without enabling publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-macos-trust-'));
  const bundlePath = join(root, 'Happier Runner.app');
  const archiveName = 'happier-runner-v0.3.0-dev.1-darwin-arm64.zip';
  const archivePath = join(root, archiveName);
  const evidencePath = join(root, 'notarization.json');
  try {
    // Model the signed bundle's exact modes, independently of the host umask.
    for (const directory of ['', 'Contents', 'Contents/MacOS', 'Contents/_CodeSignature', 'Contents/Resources']) {
      const path = join(bundlePath, directory);
      await mkdir(path, { recursive: true, mode: 0o755 });
      await chmod(path, 0o755);
    }
    for (const name of ['happier-runner', 'happier-runner-core']) {
      const file = join(bundlePath, 'Contents/MacOS', name);
      await writeFile(file, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(name)]));
      await chmod(file, 0o755);
    }
    for (const [path, contents] of [
      ['Contents/Info.plist', '<plist/>'],
      ['Contents/_CodeSignature/CodeResources', 'sealed resources fixture'],
      ['Contents/CodeResources', 'stapled ticket fixture'],
    ]) {
      await writeFile(join(bundlePath, path), contents, { mode: 0o644 });
      await chmod(join(bundlePath, path), 0o644);
    }
    await symlink('../Info.plist', join(bundlePath, 'Contents/Resources/info'));
    const evidence = {
      schemaVersion: 3, payloadKind: 'app-bundle', payload: 'Happier Runner.app',
      ...snapshotDarwinPayload(bundlePath), signingIdentity: 'Developer ID Application: Fixture (TEAMID)',
      notarization: { submissionId: 'fixture-submission', status: 'Accepted', archiveSha256: 'a'.repeat(64), ticketDelivery: 'stapled', stapled: true },
    };
    await writeFile(evidencePath, JSON.stringify(evidence));
    const archive = (await import('archiver')).default('zip');
    await new Promise((resolvePromise, reject) => {
      const output = createWriteStream(archivePath);
      output.on('close', resolvePromise); output.on('error', reject); archive.on('error', reject);
      archive.pipe(output);
      archive.append(null, { name: 'Happier Runner.app/', mode: 0o755 });
      archive.directory(bundlePath, 'Happier Runner.app');
      void archive.finalize();
    });
    const commands = [];
    const options = { archivePath, archiveName, macOSNotarizationOutput: evidencePath, runCommand: command => { commands.push(command); return ''; } };
    const entries = await verifyRunnerArchiveAdmission(options);
    assert.equal(entries.find(entry => entry.path.endsWith('/Resources/info')).linkTarget, '../Info.plist');
    assert.equal(commands.some(([command, args]) => command === 'codesign' && args.at(-1).endsWith('/happier-runner-core')), true);
    assert.equal(commands.some(([command, args]) => command === 'xcrun' && args.slice(0, 2).join(' ') === 'stapler validate'), true);
    assert.equal(commands.some(([command]) => command === 'spctl'), true);
    await smokeTestArchive({ archivePath, execute: false, macOSNotarizationOutput: evidencePath });
    await assert.rejects(verifyRunnerArchiveAdmission({ ...options, runCommand: () => { throw new Error('native trust rejected'); } }), /native trust rejected/u);
    await writeFile(evidencePath, JSON.stringify({ ...evidence, payloadSha256: '0'.repeat(64) }));
    await assert.rejects(verifyRunnerArchiveAdmission(options), /evidence does not match/u);
    await assert.rejects(verifyReleaseArchiveAdmission(options), /not eligible for publication/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows finalization signs and verifies both exact portable executables with an explicit publisher and timestamp', async () => {
  const payloadPath = await mkdtemp(join(tmpdir(), 'happier-runner-windows-trust-'));
  const thumbprint = '0123456789ABCDEF0123456789ABCDEF01234567';
  const paths = ['Happier Runner.exe', 'happier-runner-core.exe'].map(name => join(payloadPath, name));
  try {
    await Promise.all(paths.map(file => writeFile(file, 'PE fixture')));
    const commands = [];
    const options = {
      payloadPath, target: { os: 'windows', arch: 'x64' }, platform: 'win32',
      windowsSigningIdentity: thumbprint, windowsTimestampUrl: 'https://timestamp.example.test',
      runCommand: (command) => {
        commands.push(command);
        if (command[0] === 'powershell.exe') return JSON.stringify({ status: 'Valid', thumbprint, timestamped: true });
        return '';
      },
    };
    await finalizeRunnerPayload(options);
    assert.deepEqual(commands.filter(([command, args]) => command === 'signtool.exe' && args[0] === 'sign'), paths.map(file => [
      'signtool.exe', ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', options.windowsTimestampUrl, '/td', 'SHA256', '/d', 'Happier Runner', file],
    ]));
    assert.deepEqual(commands.filter(([command, args]) => command === 'signtool.exe' && args[0] === 'verify'), paths.map(file => [
      'signtool.exe', ['verify', '/pa', '/all', '/tw', file],
    ]));
    await assert.rejects(finalizeRunnerPayload({ ...options, windowsSigningIdentity: '' }), /windows-signing-identity/u);
    await assert.rejects(finalizeRunnerPayload({ ...options, windowsTimestampUrl: '' }), /windows-timestamp-url/u);
    for (const facts of [
      { status: 'NotSigned', thumbprint, timestamped: true },
      { status: 'Valid', thumbprint, timestamped: false },
      { status: 'Valid', thumbprint: 'F'.repeat(40), timestamped: true },
    ]) {
      await assert.rejects(finalizeRunnerPayload({ ...options, runCommand: ([command]) => command === 'powershell.exe' ? JSON.stringify(facts) : '' }), /Authenticode/u);
    }
    const archiveName = 'happier-runner-v0.3.0-dev.1-windows-x64.zip';
    const archivePath = join(payloadPath, archiveName);
    const layout = resolveRunnerPackageLayout('windows-x64');
    const archive = (await import('archiver')).default('zip');
    await new Promise((resolvePromise, reject) => {
      const output = createWriteStream(archivePath);
      output.on('close', resolvePromise); output.on('error', reject); archive.on('error', reject);
      archive.pipe(output);
      archive.append(null, { name: `${layout.payloadRootName}/`, mode: 0o755 });
      for (const entryPath of [layout.executablePath, layout.sidecarPath]) {
        archive.file(join(payloadPath, entryPath.split('/').at(-1)), { name: entryPath, mode: 0o755 });
      }
      void archive.finalize();
    });
    const admission = { archivePath, archiveName, windowsSigningIdentity: thumbprint, platform: 'win32', runCommand: options.runCommand };
    assert.equal((await verifyRunnerArchiveAdmission(admission)).length, 3);
    await assert.rejects(verifyRunnerArchiveAdmission({ ...admission, runCommand: () => { throw new Error('native trust rejected'); } }), /native trust rejected/u);
    await assert.rejects(verifyReleaseArchiveAdmission(admission), /not eligible for publication/u);
  } finally {
    await rm(payloadPath, { recursive: true, force: true });
  }
});

test('the release packaging owner mirrors the canonical Protocol package layout exactly', () => {
  // The release pipeline must not import a built Protocol dist — the publisher
  // installs dependencies without guaranteeing that build. Pinning the mirror
  // here keeps one decision and turns any divergence into a loud failure. Every
  // declared target row is normalized from the Protocol source and compared as
  // a whole RunnerPackageLayoutV1 record, so a drifting target row, payload
  // kind, root name, executable path or activation filename fails by name.
  const eligible = protocolLayoutSource
    .match(/RUNNER_PUBLICATION_ELIGIBLE_ARTIFACT_TARGETS[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\)/u)[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/gu, ''))
    .filter(Boolean);
  assert.deepEqual(eligible, [...RUNNER_PUBLICATION_ELIGIBLE_TARGET_IDS]);

  // The Protocol owner is TypeScript whose imports resolve only in a built
  // dist, so this suite re-derives its record values from source text instead
  // of executing it. `const` string constants and template-literal references
  // are resolved exactly as the module itself would evaluate them.
  const protocolStringConstants = new Map(
    [...protocolLayoutSource.matchAll(/^const ([A-Za-z_$][\w$]*) = '((?:[^'\\]|\\.)*)';$/gmu)]
      .map((match) => [match[1], match[2]]),
  );
  const protocolConstant = (targetId, field, name) => {
    assert.ok(
      protocolStringConstants.has(name),
      `Protocol layout value for '${targetId}' ${field} references an unparsed constant: ${name}`,
    );
    return protocolStringConstants.get(name);
  };
  const resolveProtocolLayoutValue = (targetId, field, valueText) => {
    if (valueText.startsWith(`'`)) return valueText.slice(1, -1);
    if (valueText.startsWith('`')) {
      return valueText.slice(1, -1).replace(/\$\{([A-Za-z_$][\w$]*)\}/gu, (_, name) =>
        protocolConstant(targetId, field, name));
    }
    return protocolConstant(targetId, field, valueText);
  };
  // A layout field value is a single-quoted string, a template literal, or a
  // pinned `const` identifier.
  const protocolLayoutValuePattern = "'(?:[^'\\\\]|\\\\.)*'|`[^`]*`|[A-Za-z_$][\\w$]*";
  const parseProtocolLayoutField = (rowSource, targetId, field) => {
    const match = rowSource.match(new RegExp(`${field}:\\s*(${protocolLayoutValuePattern})`, 'u'));
    assert.ok(match, `the Protocol layout row for '${targetId}' must declare ${field}`);
    return resolveProtocolLayoutValue(targetId, field, match[1]);
  };

  const payloadBlock = protocolLayoutSource.match(/const PAYLOADS[\s\S]*?\n\};/u)[0];
  const protocolActivationFileName = protocolLayoutSource.match(
    /export const RUNNER_ACTIVATION_FILE_NAME = '([^']+)';/u,
  )[1];
  const rows = [...payloadBlock.matchAll(/'([a-z0-9]+-[a-z0-9]+)': \{/gu)];
  assert.deepEqual(
    rows.map((row) => row[1]).sort(),
    [...ALL_TARGET_IDS].sort(),
    'the Protocol layout must declare exactly one payload row per canonical target',
  );
  for (const [index, row] of rows.entries()) {
    const targetId = row[1];
    const rowSource = payloadBlock.slice(
      row.index,
      index + 1 < rows.length ? rows[index + 1].index : payloadBlock.length,
    );
    const payloadKind = parseProtocolLayoutField(rowSource, targetId, 'payloadKind');
    const payloadRootName = parseProtocolLayoutField(rowSource, targetId, 'payloadRootName');
    // Only a directory payload whose closed entry set must pin the adjacent core
    // sidecar declares one; the macOS sidecar lives inside the signed tree.
    const sidecarPath = rowSource.includes('sidecarPath:')
      ? parseProtocolLayoutField(rowSource, targetId, 'sidecarPath')
      : undefined;
    assert.deepEqual(
      resolveRunnerPackageLayout(targetId),
      {
        target: targetId,
        payloadKind,
        payloadRootName,
        executablePath: parseProtocolLayoutField(rowSource, targetId, 'executablePath'),
        ...(sidecarPath === undefined ? {} : { sidecarPath }),
        // The shell resolves its activation file beside the executable it
        // launches, popping out of the macOS bundle only, so a portable
        // directory payload carries the activation JSON inside its root.
        activationFilePath: payloadKind === 'portable-dir'
          ? `${payloadRootName}/${protocolActivationFileName}`
          : protocolActivationFileName,
      },
      `the release Runner package layout for '${targetId}' must mirror the canonical Protocol record`,
    );
  }
  // No release-side row may exist without a canonical Protocol counterpart:
  // the per-row comparison above catches missing rows, this catches extra ones.
  assert.deepEqual([...RUNNER_PACKAGE_TARGET_IDS].sort(), [...ALL_TARGET_IDS].sort());
});

test('only targets with implemented native release admission are publication eligible', () => {
  assert.deepEqual([...RUNNER_PUBLICATION_ELIGIBLE_TARGET_IDS], ['linux-x64']);
  assert.equal(isRunnerTargetEligibleForPublication('windows-x64'), false);
  assert.equal(isRunnerTargetEligibleForPublication('darwin-arm64'), false);
  assert.equal(runnerTargetId({ os: 'darwin', arch: 'arm64' }), 'darwin-arm64');
  assert.deepEqual(
    resolveRunnerPublicationEligibleBinaryTargets([
      { os: 'linux', arch: 'x64' },
      { os: 'linux', arch: 'arm64' },
      { os: 'darwin', arch: 'arm64' },
      { os: 'windows', arch: 'x64' },
    ]).map(runnerTargetId),
    ['linux-x64'],
  );
});

test('each Runner target compiles the shell for its exact Rust triple', () => {
  assert.equal(resolveRunnerShellRustTarget({ os: 'linux', arch: 'x64' }), 'x86_64-unknown-linux-gnu');
  assert.equal(resolveRunnerShellRustTarget({ os: 'linux', arch: 'arm64' }), 'aarch64-unknown-linux-gnu');
  assert.equal(resolveRunnerShellRustTarget({ os: 'darwin', arch: 'x64' }), 'x86_64-apple-darwin');
  assert.equal(resolveRunnerShellRustTarget({ os: 'darwin', arch: 'arm64' }), 'aarch64-apple-darwin');
  assert.equal(resolveRunnerShellRustTarget({ os: 'windows', arch: 'x64' }), 'x86_64-pc-windows-msvc');
});

test('the shell build asks the canonical Tauri CLI for exactly one one-shot bundle', () => {
  assert.deepEqual(
    resolveRunnerShellBuildCommand({
      tauriBin: '/repo/node_modules/.bin/tauri',
      target: { os: 'linux', arch: 'x64' },
      version: '0.3.0-dev.7',
    }),
    ['/repo/node_modules/.bin/tauri', [
      'build',
      '--target', 'x86_64-unknown-linux-gnu',
      '--bundles', 'appimage',
      '--config', '{"version":"0.3.0-dev.7"}',
    ]],
  );
  assert.deepEqual(
    resolveRunnerShellBuildCommand({
      tauriBin: '/repo/node_modules/.bin/tauri',
      target: { os: 'darwin', arch: 'arm64' },
      version: '0.3.0-dev.7',
    })[1].slice(0, 6),
    ['build', '--target', 'aarch64-apple-darwin', '--bundles', 'app', '--config'],
  );
  // The `app` bundle identifier and its output directory differ: Tauri emits
  // macOS bundles under `macos/`. Deriving the directory from the CLI argument
  // would look for the built `.app` in a folder that never exists.
  assert.equal(
    resolveRunnerShellBundleDirectory({ shellDir: '/shell', target: { os: 'darwin', arch: 'arm64' } }),
    '/shell/target/aarch64-apple-darwin/release/bundle/macos',
  );
  assert.equal(
    resolveRunnerShellBundleDirectory({ shellDir: '/shell', target: { os: 'linux', arch: 'x64' } }),
    '/shell/target/x86_64-unknown-linux-gnu/release/bundle/appimage',
  );
  // The Windows one-shot payload is the compiled shell plus its adjacent core
  // sidecar, composed into the payload directory by the release packager. Tauri
  // must therefore produce no bundle at all: every Windows bundle format it can
  // emit is an installer the one-shot Runner never publishes.
  assert.deepEqual(
    resolveRunnerShellBuildCommand({
      tauriBin: '/repo/node_modules/.bin/tauri',
      target: { os: 'windows', arch: 'x64' },
      version: '0.3.0-dev.7',
    }),
    ['/repo/node_modules/.bin/tauri', [
      'build',
      '--target', 'x86_64-pc-windows-msvc',
      '--no-bundle',
      '--config', '{"version":"0.3.0-dev.7"}',
    ]],
  );
  assert.equal(
    resolveRunnerShellBundleDirectory({ shellDir: '/shell', target: { os: 'windows', arch: 'x64' } }),
    '/shell/target/x86_64-pc-windows-msvc/release',
  );
  assert.equal(
    resolveRunnerCoreSidecarPath({ shellDir: '/shell', target: { os: 'windows', arch: 'x64' } }),
    `/shell/binaries/${RUNNER_CORE_SIDECAR_STEM}-x86_64-pc-windows-msvc.exe`,
  );
  assert.equal(
    resolveRunnerCoreSidecarPath({ shellDir: '/shell', target: { os: 'linux', arch: 'x64' } }),
    `/shell/binaries/${RUNNER_CORE_SIDECAR_STEM}-x86_64-unknown-linux-gnu`,
  );
});

test('Linux payload discovery accepts exactly one AppImage from the shell build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-appimage-'));
  try {
    const bundleDir = join(root, 'target', 'x86_64-unknown-linux-gnu', 'release', 'bundle', 'appimage');
    await mkdir(bundleDir, { recursive: true });
    await assert.rejects(
      resolveRunnerShellPayload({ shellDir: root, target: { os: 'linux', arch: 'x64' } }),
      /produced no AppImage/u,
    );
    await writeFile(join(bundleDir, 'Happier Runner_0.3.0_amd64.AppImage'), 'payload', 'utf8');
    assert.equal(
      await resolveRunnerShellPayload({ shellDir: root, target: { os: 'linux', arch: 'x64' } }),
      join(bundleDir, 'Happier Runner_0.3.0_amd64.AppImage'),
    );
    await writeFile(join(bundleDir, 'Happier Runner_0.3.1_amd64.AppImage'), 'payload', 'utf8');
    await assert.rejects(
      resolveRunnerShellPayload({ shellDir: root, target: { os: 'linux', arch: 'x64' } }),
      /exactly one AppImage/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS signing signs the nested Bun core before the app and staples the notarized bundle', () => {
  const commands = resolveDarwinAppBundleNotarizationCommands({
    bundlePath: '/out/Happier Runner.app',
    identity: 'Developer ID Application: Happier (TEAMID)',
    nestedCodePaths: ['/out/Happier Runner.app/Contents/MacOS/happier-runner-core'],
    zipPath: '/tmp/bundle.zip',
    keyPath: '/tmp/AuthKey.p8',
    keyId: 'KEY',
    issuerId: 'ISSUER',
    submissionId: 'SUB',
    logPath: '/tmp/log.json',
  });

  // Inside-out: the JIT-entitled Bun core is signed first, then the sealed app.
  assert.deepEqual(commands.codesign.map(([, args]) => args.at(-1)), [
    '/out/Happier Runner.app/Contents/MacOS/happier-runner-core',
    '/out/Happier Runner.app',
  ]);
  const [coreArgs, appArgs] = commands.codesign.map(([, args]) => args);
  assert.ok(coreArgs.includes('--entitlements'));
  assert.match(String(coreArgs[coreArgs.indexOf('--entitlements') + 1]), /bun-standalone\.entitlements\.plist$/u);
  assert.ok(coreArgs.includes('runtime') && appArgs.includes('runtime'));
  // The outer shell must never carry the embedded runtime's JIT entitlement.
  assert.equal(appArgs.includes('--entitlements'), false);
  assert.ok(appArgs.includes('--timestamp'));

  assert.deepEqual(commands.staple, [['xcrun', ['stapler', 'staple', '/out/Happier Runner.app']]]);
  assert.deepEqual(commands.validateStaple, [['xcrun', ['stapler', 'validate', '/out/Happier Runner.app']]]);
  assert.deepEqual(commands.assess, [[
    'spctl',
    ['--assess', '--ignore-cache', '--no-cache', '--type', 'execute', '--verbose=4', '/out/Happier Runner.app'],
  ]]);
  assert.equal(commands.ticketDelivery, 'stapled');
  assert.equal(commands.stapled, true);
  assert.deepEqual(commands.archive, ['ditto', ['-c', '-k', '--keepParent', '/out/Happier Runner.app', '/tmp/bundle.zip']]);

  // The release ZIP must be produced by `ditto` too: a generic zip writer drops
  // the symlinks and resource metadata the stapled bundle needs, so the endpoint
  // would extract a tree Gatekeeper rejects.
  assert.deepEqual(
    resolveRunnerBundleArchiveCommand({
      payloadPath: '/out/Happier Runner.app',
      archivePath: '/out/happier-runner-v0.3.0-darwin-arm64.zip',
    }),
    ['ditto', [
      '-c', '-k', '--sequesterRsrc', '--keepParent',
      '/out/Happier Runner.app',
      '/out/happier-runner-v0.3.0-darwin-arm64.zip',
    ]],
  );
});

test('macOS packaging refuses to produce an untrusted bundle without a Developer ID identity', () => {
  assert.throws(
    () => resolveDarwinAppBundleNotarizationCommands({
      bundlePath: '/out/Happier Runner.app',
      identity: 'happier-adhoc',
      nestedCodePaths: [],
      zipPath: '/tmp/bundle.zip',
      keyPath: '/tmp/AuthKey.p8',
      keyId: 'KEY',
      issuerId: 'ISSUER',
      submissionId: 'SUB',
      logPath: '/tmp/log.json',
    }),
    /Developer ID Application identity/u,
  );
});

test('the shell configuration declares the exact one-shot bundle and trust metadata', () => {
  assert.equal(shellConfig.productName, 'Happier Runner');
  // The release packager composes the Windows payload from the binary Tauri
  // emits, so the crate's main binary name is part of the packaging contract.
  assert.equal(shellConfig.mainBinaryName, RUNNER_SHELL_BINARY_STEM);
  assert.equal(RUNNER_SHELL_BINARY_STEM, 'happier-runner');
  assert.equal(shellConfig.identifier, 'dev.happier.runner');
  assert.deepEqual(shellConfig.bundle.targets, ['app', 'appimage']);
  assert.deepEqual(shellConfig.bundle.externalBin, [`binaries/${RUNNER_CORE_SIDECAR_STEM}`]);
  assert.equal(shellConfig.bundle.macOS.hardenedRuntime, true);
  assert.equal(shellConfig.bundle.macOS.signingIdentity, undefined);
  assert.equal(shellConfig.plugins?.updater, undefined);
  for (const forbidden of ['nsis', 'msi', 'deb', 'rpm', 'dmg', 'all']) {
    assert.equal(shellConfig.bundle.targets.includes(forbidden), false, forbidden);
  }
  // A stale `$schema` pointer silently disables config validation in editors and
  // hides an invalid bundle declaration until a release build fails.
  assert.ok(
    existsSync(join(shellDir, shellConfig.$schema)),
    `runner shell $schema does not resolve: ${shellConfig.$schema}`,
  );
});

test('the shell crate pins the repository Tauri runtime and carries no updater or installer surface', () => {
  const cargoToml = readFileSync(join(shellDir, 'Cargo.toml'), 'utf8');
  const shellLock = readFileSync(join(shellDir, 'Cargo.lock'), 'utf8');
  const desktopLock = readFileSync(join(repoRoot, 'apps', 'ui', 'src-tauri', 'Cargo.lock'), 'utf8');
  const lockedTauri = (lock) => lock.match(/\nname = "tauri"\nversion = "([^"]+)"/u)[1];
  assert.equal(lockedTauri(shellLock), lockedTauri(desktopLock));
  // The one-shot Runner has no update, install or service lifecycle at all, so
  // the updater must be absent from the whole crate graph rather than merely
  // ungranted. `tauri-plugin-fs` is a transitive dependency of the folder dialog
  // and is bounded by the capability grant asserted below, not by the lockfile.
  assert.equal(shellLock.includes('name = "tauri-plugin-updater"'), false);
  for (const forbidden of ['tauri-plugin-updater', 'tauri-plugin-fs', 'tauri-plugin-http']) {
    assert.equal(cargoToml.includes(forbidden), false, forbidden);
  }

  // Icons are copied from the one canonical Happier icon set rather than a
  // second copy of the brand assets, so the generated folder stays ignored.
  const buildRs = readFileSync(join(shellDir, 'build.rs'), 'utf8');
  const canonicalIcons = buildRs.match(/CANONICAL_ICONS[^=]*=\s*&\[([^\]]*)\]/u)[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/gu, ''))
    .filter(Boolean);
  assert.ok(canonicalIcons.includes('icon.icns'));
  for (const icon of canonicalIcons) {
    assert.ok(
      existsSync(join(repoRoot, 'apps', 'ui', 'src-tauri', 'icons', icon)),
      `canonical Happier icon is missing: ${icon}`,
    );
  }
  for (const icon of shellConfig.bundle.icon) {
    assert.ok(canonicalIcons.includes(icon.replace(/^icons\//u, '')), icon);
  }
  assert.match(readFileSync(join(shellDir, '.gitignore'), 'utf8'), /^\/icons\/$/mu);
});

test('the endpoint window reaches the folder picker only through the Runner-owned command', () => {
  const capability = JSON.parse(readFileSync(join(shellDir, 'capabilities', 'default.json'), 'utf8'));
  assert.deepEqual(capability.windows, ['main']);
  // The folder picker is `runner_pick_directory`, an application command that
  // calls `tauri-plugin-dialog`'s Rust API (`desktop.rs#pick_folder`), which
  // performs no ACL check. Granting the webview `dialog:default` would add the
  // generic `dialog.open`/`dialog.save` IPC surface — which the plan rejects as
  // an authorization boundary — without the picker needing it. `shell:`/`fs:`
  // would likewise turn the static consent page into a command surface.
  assert.deepEqual(capability.permissions, ['core:default']);
  for (const permission of capability.permissions) {
    assert.ok(
      !['shell:', 'fs:', 'dialog:'].some((prefix) => String(permission).startsWith(prefix)),
      `endpoint window must not receive ${permission}`,
    );
  }
  const shellSource = readFileSync(join(shellDir, 'src', 'main.rs'), 'utf8');
  assert.match(shellSource, /fn runner_pick_directory/u);
  const web = readFileSync(join(shellDir, 'web', 'main.js'), 'utf8');
  // The dedicated command carries the core-resolved dialog title, so the OS
  // dialog follows the same endpoint copy owner as the window contents.
  assert.match(web, /invoke\('runner_pick_directory',\{title:chooser\.dialogTitle\}\)/u);
  assert.match(shellSource, /\.set_title\(title\)/u);
  assert.ok(!/__TAURI__\.dialog/u.test(web), 'the consent page must not call the generic dialog API');
});

test('release admission derives Runner payload shape and publication eligibility from one owner', async () => {
  // `verify-artifacts.runner.test.mjs` proves the builder and admission agree on
  // real packaged bytes. This case covers the admission decision itself without
  // the builder's workspace-artifact import, so eligibility and layout
  // ownership stay checkable in every lane.
  const { verifyReleaseArchiveAdmission } = await import('./verify-artifacts.mjs');
  const archiver = (await import('archiver')).default;
  const { createWriteStream } = await import('node:fs');
  const root = await mkdtemp(join(tmpdir(), 'happier-runner-admission-'));
  try {
    const payloadPath = join(root, 'payload');
    await writeFile(payloadPath, '#!/bin/sh\nexit 0\n', 'utf8');

    const pack = async (archiveName, entryName) => {
      const archivePath = join(root, archiveName);
      await new Promise((resolvePromise, reject) => {
        const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolvePromise); output.on('error', reject); archive.on('error', reject);
        archive.pipe(output);
        archive.file(payloadPath, { name: entryName, mode: 0o755, date: new Date(0) });
        void archive.finalize();
      });
      return archivePath;
    };

    const eligible = await pack('happier-runner-v0.3.0-dev.1-linux-x64.zip', 'happier-runner');
    const payloadSizeBytes = (await stat(payloadPath)).size;
    assert.deepEqual(
      await verifyReleaseArchiveAdmission({
        archivePath: eligible,
        archiveName: 'happier-runner-v0.3.0-dev.1-linux-x64.zip',
      }),
      [{
        path: resolveRunnerPackageLayout('linux-x64').executablePath,
        kind: 'file',
        sizeBytes: payloadSizeBytes,
        mode: 0o755,
      }],
    );

    await assert.rejects(
      verifyReleaseArchiveAdmission({
        archivePath: await pack('happier-runner-v0.3.0-dev.1-darwin-arm64.zip', 'happier-runner'),
        archiveName: 'happier-runner-v0.3.0-dev.1-darwin-arm64.zip',
      }),
      /Runner target is not eligible for publication/u,
    );
    await assert.rejects(
      verifyReleaseArchiveAdmission({
        archivePath: await pack('happier-runner-v0.3.0-dev.2-linux-x64.zip', 'Happier Runner'),
        archiveName: 'happier-runner-v0.3.0-dev.2-linux-x64.zip',
      }),
      /Runner archive must contain exactly one happier-runner executable payload/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the tracked shell sources contain no build output or staged Bun core', () => {
  const tracked = execFileSync('git', ['ls-files', '--', RUNNER_NATIVE_SHELL_DIR], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
  for (const path of tracked) {
    assert.ok(
      !path.includes('/target/') && !path.includes('/binaries/') && !path.includes('/icons/'),
      `generated shell output must not be tracked: ${path}`,
    );
  }
});
