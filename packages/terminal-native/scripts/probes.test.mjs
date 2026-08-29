import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('iOS GhosttyKit policy records distinct zip and expanded artifact checksums', async () => {
  const rendererPolicy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
  const artifact = rendererPolicy.iosGhostty.artifact;

  assert.equal(
    artifact.upstreamZipSha256,
    'f1484a5411559bf4a5b665b82a5bb91cb8a3ca2065467dc15202fb191d7a5c9d',
  );
  assert.equal(
    artifact.upstreamDownloadUrl,
    'https://github.com/Lakr233/libghostty-spm/releases/download/storage.1.2.4/GhosttyKit.xcframework.zip',
  );
  assert.equal(
    artifact.expandedSha256,
    'f59c864108a9ef3002f6dcaaa00f87e5b56ce4966fb6c90d5ad744cc7aef37c7',
  );
  assert.notEqual(artifact.upstreamZipSha256, artifact.expandedSha256);
  assert.equal(artifact.directGhosttyBuild.implemented, false);
  assert.equal(artifact.directGhosttyBuild.status, 'future-contingency');
});

test('iOS Ghostty build copy isolates the complete Wuffs namespace on every Apple slice', { skip: process.platform !== 'darwin' }, async () => {
  const fixtureRoot = await mkdtempPath();
  const isolationScript = join(packageRoot, 'ios', 'namespaceGhosttyWuffs.sh');
  const cases = [
    {
      source: join(packageRoot, 'ios', 'Vendor', 'GhosttyKit.xcframework', 'ios-arm64', 'libghostty.a'),
      platform: 'iphoneos',
      effectivePlatform: '-iphoneos',
      sdk: 'iphoneos',
    },
    {
      source: join(packageRoot, 'ios', 'Vendor', 'GhosttyKit.xcframework', 'ios-arm64_x86_64-simulator', 'libghostty.a'),
      platform: 'iphonesimulator',
      effectivePlatform: '-iphonesimulator',
      sdk: 'iphonesimulator',
    },
  ];

  try {
    for (const [index, input] of cases.entries()) {
      const archive = join(fixtureRoot, `libghostty-${index}.a`);
      await copyFile(input.source, archive);
      const { stdout: sdkVersion } = await execFileAsync('xcrun', [
        '--sdk',
        input.sdk,
        '--show-sdk-version',
      ]);
      const env = {
        ...process.env,
        PLATFORM_NAME: input.platform,
        EFFECTIVE_PLATFORM_NAME: input.effectivePlatform,
        IPHONEOS_DEPLOYMENT_TARGET: '15.1',
        SDK_VERSION: sdkVersion.trim(),
      };

      await execFileAsync('/bin/bash', [isolationScript, archive], { env });
      await execFileAsync('/bin/bash', [isolationScript, archive], { env });
      const { stdout: symbols } = await execFileAsync('nm', ['-g', archive], {
        maxBuffer: 32 * 1024 * 1024,
      });

      assert.doesNotMatch(symbols, / [TDSB] _(?:(?:sizeof__)?wuffs_|WUFFS_)/);
      assert.match(symbols, / [TDSB] _ghostty_surface_new$/m);

      const { stdout: architectureList } = await execFileAsync('lipo', ['-archs', archive]);
      const architectures = architectureList.trim().split(/\s+/);
      for (const architecture of architectures) {
        const thinArchive = join(fixtureRoot, `libghostty-${index}-${architecture}.a`);
        if (architectures.length === 1) {
          await copyFile(archive, thinArchive);
        } else {
          await execFileAsync('lipo', [archive, '-thin', architecture, '-output', thinArchive]);
        }
        const { stdout: members } = await execFileAsync('ar', ['-t', thinArchive]);
        assert.match(members, /^libghostty_zcu_wuffs_private\.o$/m);
      }
    }
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test('pinned native build-input archive cache verifies a downloaded archive before reusing it', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });
  const zipPath = await zipGhosttyKitFixture(artifactPath);
  const cacheRoot = await mkdtempPath();
  const { computeSha256ForPath } = await import('./checksum.mjs');
  const expectedSha256 = await computeSha256ForPath(zipPath);
  const archiveBytes = await readFile(zipPath);

  try {
    const { ensurePinnedNativeBuildInputArchive } = await import('./nativeBuildInputArchive.mjs');
    const downloaded = await ensurePinnedNativeBuildInputArchive({
      sourceUrl: 'https://github.com/Lakr233/libghostty-spm/releases/download/storage.1.2.4/GhosttyKit.xcframework.zip',
      expectedSha256,
      cacheRoot,
      cacheKey: 'ios-ghosttykit.zip',
      fetchImpl: async (url) => {
        assert.equal(url, 'https://github.com/Lakr233/libghostty-spm/releases/download/storage.1.2.4/GhosttyKit.xcframework.zip');
        return new Response(archiveBytes, { status: 200 });
      },
    });

    assert.equal(downloaded.status, 'downloaded');
    assert.equal(downloaded.checksum.sha256, expectedSha256);
    assert.equal(await computeSha256ForPath(downloaded.path), expectedSha256);
  } finally {
    await rm(cacheRoot, { force: true, recursive: true });
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS GhosttyKit verifier accepts the pinned host-managed static XCFramework shape', async () => {
  const { validateGhosttyKitArtifact } = await import('./probeIos.mjs');
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });

  try {
    const result = await validateGhosttyKitArtifact({ artifactPath });

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.slices.map((slice) => slice.identifier).sort(), [
      'ios-arm64',
      'ios-arm64_x86_64-simulator',
    ]);
    assert.equal(result.headerHints.missing.length, 0);
    assert.equal(result.checksum.status, 'not-provided');
  } finally {
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS GhosttyKit verifier rejects artifacts without host-managed I/O header hints', async () => {
  const { validateGhosttyKitArtifact } = await import('./probeIos.mjs');
  const artifactPath = await createGhosttyKitFixture({
    header: 'void ghostty_surface_refresh(void*);',
  });

  try {
    const result = await validateGhosttyKitArtifact({ artifactPath });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'missing-host-managed-io-api');
    assert.ok(result.missingHeaderHints.includes('ghostty_surface_write_buffer'));
    assert.ok(result.missingHeaderHints.includes('GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED'));
  } finally {
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS GhosttyKit build script installs only an explicitly provided verified artifact', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });
  const { computeSha256ForPath } = await import('./checksum.mjs');
  const expectedSha256 = await computeSha256ForPath(artifactPath);
  const vendoredArtifactPath = join(await mkdtempPath(), 'GhosttyKit.xcframework');

  try {
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/buildGhosttyKitIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_XCFRAMEWORK: artifactPath,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256: expectedSha256,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_INSTALL_PATH: vendoredArtifactPath,
      },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, 'ok');
    assert.equal(payload.renderer, 'ios-ghosttykit');
    assert.equal(payload.installedArtifactPath, vendoredArtifactPath);
    assert.deepEqual(payload.slices.map((slice) => slice.identifier).sort(), [
      'ios-arm64',
      'ios-arm64_x86_64-simulator',
    ]);
    for (const slice of payload.slices) {
      assert.equal(slice.libraryPath.startsWith(vendoredArtifactPath), true);
      assert.equal(slice.headerPath.startsWith(vendoredArtifactPath), true);
      assert.equal(slice.modulemapPath.startsWith(vendoredArtifactPath), true);
      assert.equal(await pathExists(slice.libraryPath), true);
      assert.equal(await pathExists(slice.headerPath), true);
      assert.equal(await pathExists(slice.modulemapPath), true);
    }
  } finally {
    await rm(vendoredArtifactPath, { force: true, recursive: true });
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS GhosttyKit build script installs the current libghostty-spm zipped artifact shape', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });
  const zipPath = await zipGhosttyKitFixture(artifactPath);
  const { computeSha256ForPath } = await import('./checksum.mjs');
  const expectedSha256 = await computeSha256ForPath(zipPath);
  const vendoredArtifactPath = join(await mkdtempPath(), 'GhosttyKit.xcframework');

  try {
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/buildGhosttyKitIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_XCFRAMEWORK: zipPath,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256: expectedSha256,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_INSTALL_PATH: vendoredArtifactPath,
      },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, 'ok');
    assert.equal(payload.source, 'explicit-local-xcframework-zip');
    assert.equal(payload.checksum.sha256, expectedSha256);
    assert.deepEqual(payload.slices.map((slice) => slice.identifier).sort(), [
      'ios-arm64',
      'ios-arm64_x86_64-simulator',
    ]);
  } finally {
    await rm(vendoredArtifactPath, { force: true, recursive: true });
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS GhosttyKit build script refuses an unpinned explicit artifact', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });
  const vendoredArtifactPath = join(await mkdtempPath(), 'GhosttyKit.xcframework');

  try {
    await execFileAsync(process.execPath, [join(packageRoot, 'scripts/buildGhosttyKitIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_XCFRAMEWORK: artifactPath,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256: '',
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_INSTALL_PATH: vendoredArtifactPath,
      },
    });
    assert.fail('buildGhosttyKitIos.mjs should reject explicit GhosttyKit artifacts without a checksum pin');
  } catch (error) {
    assert.equal(error.code, 1);
    const payload = JSON.parse(error.stdout);

    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'missing-checksum-pinned-artifact');
    assert.equal(payload.fallbackRenderer, 'xterm-webview');
    assert.equal(payload.checksumEnv, 'HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256');
  } finally {
    await rm(vendoredArtifactPath, { force: true, recursive: true });
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS GhosttyKit probe blocks an unpinned artifact override even after hard gates pass', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });

  try {
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_ARTIFACT_PATH: artifactPath,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256: '',
        HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED: '1',
        HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN: '1',
      },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'missing-checksum-pinned-artifact');
    assert.equal(payload.fallbackRenderer, 'xterm-webview');
    assert.equal(payload.checksumEnv, 'HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256');
  } finally {
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS Ghostty clear routes through the bridge instead of no-oping', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(
    surfaceViewSource,
    /func clearSurface\(\)\s*\{[\s\S]*bridge\.clear\(\)[\s\S]*\}/,
  );
  assert.match(surfaceBridgeSource, /private static let clearScreenSequence = Data\(\[/);
  assert.match(surfaceBridgeSource, /0x1B,\s*0x5B,\s*0x33,\s*0x4A/);
  assert.match(surfaceBridgeSource, /ghostty_surface_write_buffer\(surface, pointer, UInt\(Self\.clearScreenSequence\.count\)\)/);
  assert.match(surfaceBridgeSource, /ghostty_surface_draw\(surface\)/);
});

test('iOS Ghostty initializes after Expo assigns surfaceId to an already-laid-out view', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');

  assert.match(surfaceViewSource, /import ExpoModulesCore/);
  assert.match(surfaceViewSource, /final class GhosttySurfaceView: ExpoView, UITextInput, UITextInputTraits/);
  assert.match(surfaceViewSource, /required init\(appContext: AppContext\? = nil\)/);
  assert.match(
    surfaceViewSource,
    /var surfaceId: String = ""[\s\S]*didSet[\s\S]*initializeSurfaceIfPossible\(\)[\s\S]*setNeedsLayout\(\)/,
  );
  assert.match(
    surfaceViewSource,
    /private func initializeSurfaceIfPossible\(\)[\s\S]*bounds\.width > 0[\s\S]*bounds\.height > 0[\s\S]*ensureBridge\(\)\.ensureSurface\(fontSize: fontSize\)/,
  );
  assert.match(
    surfaceViewSource,
    /override func layoutSubviews\(\)[\s\S]*initializeSurfaceIfPossible\(\)/,
  );
});

test('iOS Ghostty announces readiness exactly once through the post-listener createSurface handshake', async () => {
  const moduleSource = await readFile(join(packageRoot, 'ios/HappierTerminalNativeModule.swift'), 'utf-8');
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(
    moduleSource,
    /AsyncFunction\("createSurface"\)[\s\S]*await MainActor\.run[\s\S]*GhosttySurfaceRegistry\.shared\.surface\(id: surfaceId\)[\s\S]*prepareSurface\(\)/,
  );
  assert.match(
    surfaceViewSource,
    /func prepareSurface\(\) -> Bool[\s\S]*initializeSurfaceIfPossible\(\)[\s\S]*announceSurfaceReady\(\)/,
  );
  assert.match(
    surfaceBridgeSource,
    /func announceSurfaceReady\(\) -> Bool[\s\S]*emitSurfaceReady\(\)/,
  );
  assert.match(
    surfaceViewSource,
    /func prepareSurface\(\) -> Bool[\s\S]*initializeSurfaceIfPossible\(\)[\s\S]*bridge\?\.announceSurfaceReady\(\) == true/,
  );
  assert.match(surfaceBridgeSource, /private var surfaceReadyEmitted = false/);
  assert.match(surfaceBridgeSource, /private func emitSurfaceReady\(\) -> Bool[\s\S]*if surfaceReadyEmitted \{ return true \}/);
  assert.match(
    surfaceBridgeSource,
    /if isInitialSize \{\s*appTickPending = true\s*scheduleAppTick\(\)\s*\} else \{\s*emitResize/,
  );
});

test('iOS Ghostty host actions route title bell and safe URL events through the bridge', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');
  const linksSource = await readFile(join(packageRoot, 'ios/GhosttyLinks.swift'), 'utf-8');

  assert.match(surfaceBridgeSource, /action_cb:\s*Self\.actionCallback/);
  assert.match(surfaceBridgeSource, /private static let actionCallback: ghostty_runtime_action_cb/);
  assert.match(surfaceBridgeSource, /ghostty_surface_userdata\(surface\)/);
  assert.match(surfaceBridgeSource, /GHOSTTY_ACTION_SET_TITLE[\s\S]*emitEvent\("title"/);
  assert.match(surfaceBridgeSource, /GHOSTTY_ACTION_SET_TAB_TITLE[\s\S]*emitEvent\("title"/);
  assert.match(surfaceBridgeSource, /GHOSTTY_ACTION_RING_BELL[\s\S]*emitEvent\("bell"/);
  assert.match(surfaceBridgeSource, /GHOSTTY_ACTION_OPEN_URL[\s\S]*makeGhosttyLinkEvent/);
  assert.match(surfaceBridgeSource, /emitEvent\("link"/);
  assert.match(linksSource, /scheme == "http" \|\| scheme == "https"/);
  assert.match(linksSource, /func firstGhosttySafeLinkEvent/);
  assert.match(linksSource, /NSDataDetector/);
  assert.match(linksSource, /hasPrefix\("http:\/\/"\) \|\| lowercasedText\.hasPrefix\("https:\/\/"\)/);
});

test('iOS Ghostty copies borrowed action payloads before dispatching onto the main actor', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceBridgeSource, /private enum PendingAction/);
  assert.match(
    surfaceBridgeSource,
    /private static let actionCallback:[\s\S]*?guard let pendingAction = pendingAction\(from: action\)[\s\S]*?Task\s*\{\s*@MainActor\s*\[weak bridge\]\s+in\s*bridge\?\.handleAction\(pendingAction\)/,
  );
  assert.doesNotMatch(
    surfaceBridgeSource,
    /Task\s*\{\s*@MainActor\s*\[weak bridge\]\s+in\s*bridge\?\.handleAction\(action\)/,
  );
});

test('iOS Ghostty hardware keyboard presses route through ghostty_surface_key', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');
  const inputSource = await readFile(join(packageRoot, 'ios/GhosttyInput.swift'), 'utf-8');

  assert.match(surfaceViewSource, /override func pressesBegan\(_ presses: Set<UIPress>, with event: UIPressesEvent\?\)/);
  assert.match(surfaceViewSource, /handlePresses\(presses, action: GHOSTTY_ACTION_PRESS/);
  assert.match(surfaceViewSource, /override func pressesEnded\(_ presses: Set<UIPress>, with event: UIPressesEvent\?\)/);
  assert.match(surfaceViewSource, /handlePresses\(presses, action: GHOSTTY_ACTION_RELEASE/);
  assert.match(surfaceBridgeSource, /func handlePress\([\s\S]*?_ press: UIPress,[\s\S]*?action: ghostty_input_action_e,[\s\S]*?composing: Bool[\s\S]*?\) -> Bool/);
  assert.match(surfaceBridgeSource, /ghostty_surface_key\(surface, key\)/);
  assert.match(inputSource, /func withGhosttyInputKey/);
  assert.match(inputSource, /private func ghosttyAppKitKeyCode\(forHIDUsage usage: Int\) -> UInt32/);
  assert.match(inputSource, /case 0x29: return 0x35/);
});

test('iOS Ghostty hardware input uses native AppKit keycodes and suppresses duplicate UIKeyInput delivery', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');
  const inputSource = await readFile(join(packageRoot, 'ios/GhosttyInput.swift'), 'utf-8');

  assert.match(inputSource, /keycode: ghosttyAppKitKeyCode\(forHIDUsage:/);
  assert.match(inputSource, /case 0x04: return 0x00/);
  assert.match(inputSource, /case 0x4F: return 0x7C/);
  assert.match(inputSource, /composing: composing/);
  assert.doesNotMatch(inputSource, /keycode: UInt32\(translated\.rawValue\)/);
  assert.match(surfaceBridgeSource, /func handlePress\([\s\S]*?composing: Bool/);
  assert.match(surfaceViewSource, /private var hardwareKeyHandled = false/);
  assert.match(surfaceViewSource, /func insertText\(_ text: String\)\s*\{\s*guard !hardwareKeyHandled else/);
  assert.match(surfaceViewSource, /private func deleteBackwardFromTextInput\(\)[\s\S]*?hardwareKeyHandled = false/);
  assert.match(surfaceViewSource, /private func shouldSuppressUIKeyInput\(for press: UIPress\) -> Bool/);
  assert.match(surfaceViewSource, /composing: markedTextValue != nil/);
  const pressLoopStart = surfaceViewSource.indexOf('for press in presses');
  const pressLoopEnd = surfaceViewSource.indexOf('return handled', pressLoopStart);
  const pressLoop = surfaceViewSource.slice(pressLoopStart, pressLoopEnd);
  assert.ok(
    pressLoop.indexOf('hardwareKeyHandled = true') < pressLoop.indexOf('bridge.handlePress'),
    'hardware-key duplicate suppression must be armed before Ghostty reports whether it consumed the key',
  );
});

test('iOS Ghostty bridge typechecks without linked GhosttyKit fallback', { skip: process.platform !== 'darwin' }, async () => {
  const stubRoot = await mkdtempPath();
  const surfaceViewStub = join(stubRoot, 'GhosttySurfaceViewStub.swift');

  await writeFile(surfaceViewStub, [
    'import UIKit',
    'final class GhosttySurfaceView {',
    '  typealias EventEmitter = (_ eventName: String, _ payload: [String: Any]) -> Void',
    '}',
  ].join('\n'));

  try {
    await typecheckIosSwift([
      surfaceViewStub,
      join(packageRoot, 'ios/GhosttyRuntime.swift'),
      join(packageRoot, 'ios/GhosttyInput.swift'),
      join(packageRoot, 'ios/GhosttySurfaceBridge.swift'),
    ]);
  } finally {
    await rm(stubRoot, { force: true, recursive: true });
  }
});

test('iOS Ghostty runtime reports proof blockers even when GhosttyKit is not linked', { skip: process.platform !== 'darwin' }, async () => {
  const packageProofBlocked = await runGhosttyRuntimeDiagnostic();
  assert.equal(packageProofBlocked.state, 'unavailable');
  assert.equal(packageProofBlocked.reason, 'package-proof-unaccepted');

  const fallbackProofBlocked = await runGhosttyRuntimeDiagnostic({
    defines: ['HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED'],
  });
  assert.equal(fallbackProofBlocked.state, 'unavailable');
  assert.equal(fallbackProofBlocked.reason, 'renderer-unavailable');
  assert.equal(fallbackProofBlocked.detail, 'iOS Ghostty crash-to-WebView fallback proof has not passed.');
});

test('iOS Ghostty keyboard bridge typechecks against vendored GhosttyKit input symbols', { skip: process.platform !== 'darwin' }, async () => {
  await typecheckIosSwift([
      join(packageRoot, 'ios/GhosttyRuntime.swift'),
      join(packageRoot, 'ios/GhosttyInput.swift'),
      join(packageRoot, 'ios/GhosttyLinks.swift'),
    join(packageRoot, 'ios/GhosttyAccessibility.swift'),
    join(packageRoot, 'ios/GhosttySurfaceBridge.swift'),
    join(packageRoot, 'ios/GhosttySurfaceView.swift'),
  ], {
    defines: ['HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY'],
    warningsAsErrors: true,
    includePaths: [
      join(packageRoot, 'ios/Vendor/GhosttyKit.xcframework/ios-arm64_x86_64-simulator/Headers'),
    ],
  });
});

test('iOS Ghostty two-finger scroll routes through ghostty_surface_mouse_scroll', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceViewSource, /private lazy var scrollGesture: UIPanGestureRecognizer/);
  assert.match(surfaceViewSource, /minimumNumberOfTouches = 2/);
  assert.match(surfaceViewSource, /@objc private func handleScrollGesture/);
  assert.match(surfaceBridgeSource, /func handleScroll\(dx: Double, dy: Double\)/);
  assert.match(surfaceBridgeSource, /ghostty_surface_mouse_scroll\(surface, dx, dy,/);
});

test('iOS Ghostty preserves one-finger selection drags without opening the keyboard mid-gesture', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const touchesBegan = surfaceViewSource.slice(
    surfaceViewSource.indexOf('override func touchesBegan'),
    surfaceViewSource.indexOf('override func touchesMoved'),
  );
  const touchesEnded = surfaceViewSource.slice(
    surfaceViewSource.indexOf('override func touchesEnded'),
    surfaceViewSource.indexOf('override func touchesCancelled'),
  );

  assert.doesNotMatch(touchesBegan, /becomeFirstResponder/);
  assert.match(touchesEnded, /handleTouches\(touches\)[\s\S]*becomeFirstResponder/);
  assert.match(surfaceViewSource, /cancelFocusCandidateAfterDrag\(touches\)/);
  assert.match(surfaceViewSource, /hypot\(location\.x - origin\.x, location\.y - origin\.y\) > 8/);
});

test('iOS Ghostty distinguishes initial surface setup from later terminal resize events', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceBridgeSource, /let isInitialSize = lastPixelSize == \.zero/);
  assert.match(
    surfaceBridgeSource,
    /if isInitialSize \{\s*appTickPending = true\s*scheduleAppTick\(\)\s*\} else \{\s*emitResize\(cols: Int\(size\.columns\), rows: Int\(size\.rows\)\)\s*\}/,
  );
});

test('iOS Ghostty synchronizes responder focus and app foreground lifecycle with the native surface', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceViewSource, /override func becomeFirstResponder\(\) -> Bool/);
  assert.match(surfaceViewSource, /bridge\?\.setFocused\(true\)/);
  assert.match(surfaceViewSource, /override func resignFirstResponder\(\) -> Bool/);
  assert.match(surfaceViewSource, /bridge\?\.setFocused\(false\)/);
  assert.match(surfaceViewSource, /UIApplication\.shared\.applicationState == \.active/);
  assert.match(surfaceViewSource, /UIApplication\.didEnterBackgroundNotification/);
  assert.match(surfaceViewSource, /UIApplication\.didBecomeActiveNotification/);
  assert.match(
    surfaceViewSource,
    /UIApplication\.didEnterBackgroundNotification[\s\S]*?Task\s*\{\s*@MainActor(?:\s+\[weak self\])?\s+in[\s\S]*?bridge\?\.setVisible\(false\)/,
  );
  assert.match(
    surfaceViewSource,
    /UIApplication\.didBecomeActiveNotification[\s\S]*?Task\s*\{\s*@MainActor(?:\s+\[weak self\])?\s+in[\s\S]*?bridge\?\.setVisible\(true\)/,
  );
  assert.match(surfaceBridgeSource, /func setVisible\(_ visible: Bool\)/);
  assert.match(surfaceBridgeSource, /ghostty_surface_set_occlusion\(surface, visible\)/);
  assert.match(surfaceBridgeSource, /ghostty_surface_refresh\(surface\)/);
  assert.match(
    surfaceBridgeSource,
    /private func drawIfVisible\(_ surface: ghostty_surface_t\)\s*\{\s*guard isVisible, let hostView else \{ return \}[\s\S]*ghostty_surface_refresh\(surface\)[\s\S]*ghostty_surface_draw\(surface\)/,
  );
  assert.equal(
    surfaceBridgeSource.match(/ghostty_surface_draw\(surface\)/g)?.length,
    1,
    'all drawing must pass through the application-visibility guard',
  );
});

test('iOS Ghostty coalesces runtime wakeups onto the main actor and drops them after teardown', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceBridgeSource, /wakeup_cb:\s*Self\.wakeupCallback/);
  assert.match(surfaceBridgeSource, /private var tickScheduled = false/);
  assert.match(surfaceBridgeSource, /private var isDisposed = false/);
  assert.match(surfaceBridgeSource, /private static let wakeupCallback: ghostty_runtime_wakeup_cb/);
  assert.match(
    surfaceBridgeSource,
    /Task\s*\{\s*@MainActor\s*\[weak bridge\]\s+in\s*bridge\?\.scheduleAppTick\(\)\s*\}/,
  );
  assert.match(
    surfaceBridgeSource,
    /func scheduleAppTick\(\)\s*\{[\s\S]*?guard !isDisposed, app != nil[\s\S]*?guard isVisible[\s\S]*?appTickPending = true[\s\S]*?tickScheduled = true[\s\S]*?ghostty_app_tick\(app\)/,
  );
  assert.match(surfaceBridgeSource, /func dispose\(\)\s*\{[\s\S]*?isDisposed = true[\s\S]*?tickScheduled = false[\s\S]*?appTickPending = false/);
});

test('iOS Ghostty processes initial size through an app tick before the explicit readiness handshake', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceBridgeSource, /private var surfaceReadyEmitted = false/);
  assert.match(
    surfaceBridgeSource,
    /if isInitialSize\s*\{[\s\S]*?appTickPending = true[\s\S]*?scheduleAppTick\(\)/,
  );
  assert.match(
    surfaceBridgeSource,
    /ghostty_app_tick\(app\)[\s\S]*?self\.drawIfVisible\(surface\)[\s\S]*?self\.refreshAccessibilitySummary\(\)/,
  );
  assert.match(
    surfaceBridgeSource,
    /private func emitSurfaceReady\(\) -> Bool\s*\{[\s\S]*?if surfaceReadyEmitted \{ return true \}[\s\S]*?size\.columns > 0, size\.rows > 0[\s\S]*?surfaceReadyEmitted = true/,
  );
  assert.match(surfaceBridgeSource, /func dispose\(\)\s*\{[\s\S]*?surfaceReadyEmitted = false/);
});

test('iOS Ghostty refreshes, draws, and normalizes IOSurface sublayers for every visible frame', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(
    surfaceBridgeSource,
    /private func drawIfVisible[\s\S]*ghostty_surface_refresh\(surface\)[\s\S]*ghostty_surface_draw\(surface\)/,
  );
  assert.match(surfaceBridgeSource, /hostView\.layer\.sublayers\?\.forEach[\s\S]*layer\.frame = hostView\.bounds/);
  assert.match(surfaceBridgeSource, /layer\.contentsScale = scale[\s\S]*layer\.setNeedsDisplay\(\)/);
  assert.match(surfaceBridgeSource, /hostView\.layer\.setNeedsDisplay\(\)/);
});

test('iOS Ghostty view tears down the callback owner before releasing its bridge', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');

  assert.match(
    surfaceViewSource,
    /deinit\s*\{[\s\S]*?bridge\?\.dispose\(\)[\s\S]*?bridge = nil[\s\S]*?removeObserver/,
  );
});

test('iOS Ghostty uses UITextInput composition to preedit, commit, and cancel marked text', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceViewSource, /final class GhosttySurfaceView: ExpoView, UITextInput, UITextInputTraits/);
  assert.match(surfaceViewSource, /func setMarkedText\(_ markedText: String\?, selectedRange: NSRange\)/);
  assert.match(surfaceViewSource, /func unmarkText\(\)/);
  assert.match(surfaceViewSource, /var markedTextRange: UITextRange\?/);
  assert.match(surfaceViewSource, /var selectedTextRange: UITextRange\?/);
  assert.match(surfaceViewSource, /cancelMarkedText\(\)/);
  assert.match(surfaceBridgeSource, /func setPreedit\(_ text: String\) -> Bool/);
  assert.match(surfaceBridgeSource, /ghostty_surface_preedit\(surface, pointer, UInt\(text\.utf8\.count\)\)/);
  assert.match(surfaceBridgeSource, /func imeRect\(\) -> CGRect/);
  assert.match(surfaceBridgeSource, /ghostty_surface_ime_point\(surface,/);
  assert.match(surfaceBridgeSource, /ghostty_surface_text\(surface, pointer, UInt\(buffer\.count - 1\)\)/);
  const characterRangeStart = surfaceViewSource.indexOf('func characterRange(byExtending');
  const characterRangeEnd = surfaceViewSource.indexOf('func baseWritingDirection', characterRangeStart);
  assert.notEqual(characterRangeStart, -1);
  assert.notEqual(characterRangeEnd, -1);
  assert.match(
    surfaceViewSource.slice(characterRangeStart, characterRangeEnd),
    /rangeOfComposedCharacterSequence/,
  );
});

test('iOS Ghostty accessibility summary reads visible viewport text when native accessibility is accepted', async () => {
  const moduleSource = await readFile(join(packageRoot, 'ios/HappierTerminalNativeModule.swift'), 'utf-8');
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');
  const accessibilitySource = await readFile(join(packageRoot, 'ios/GhosttyAccessibility.swift'), 'utf-8');

  assert.match(surfaceViewSource, /func updateNativeAccessibilitySummary\(_ summary: String\)/);
  assert.match(surfaceViewSource, /@objc func accessibilityFocusTerminalAction\(\) -> Bool/);
  assert.match(surfaceViewSource, /@objc func accessibilityCopySelectionAction\(\) -> Bool/);
  assert.match(surfaceViewSource, /@objc func accessibilitySelectAllAction\(\) -> Bool/);
  assert.match(surfaceViewSource, /@objc func accessibilityOpenLinkAction\(\) -> Bool/);
  assert.match(surfaceBridgeSource, /private func refreshAccessibilitySummary\(\)/);
  assert.match(surfaceBridgeSource, /ghostty_surface_read_text\(surface, viewport, &output\)/);
  assert.match(surfaceBridgeSource, /GHOSTTY_POINT_VIEWPORT/);
  assert.match(surfaceBridgeSource, /updateNativeAccessibilitySummary\(makeGhosttyAccessibilitySummary/);
  assert.match(accessibilitySource, /func makeGhosttyAccessibilitySummary\(_ value: String/);
  assert.match(accessibilitySource, /guard isAccepted,[\s\S]*!terminalLabel\.isEmpty/);
  assert.match(accessibilitySource, /let exposedSummary = summary\.isEmpty \? fallbackValue : summary/);
  assert.match(accessibilitySource, /surfaceView\.isAccessibilityElement = true/);
  assert.match(accessibilitySource, /surfaceView\.accessibilityLabel = "\\\(terminalLabel\)\. \\\(exposedSummary\)"/);
  assert.match(accessibilitySource, /surfaceView\.accessibilityValue = exposedSummary/);
  assert.match(accessibilitySource, /summary\.isEmpty\s*\? fallbackValue/);
  assert.match(accessibilitySource, /UIAccessibilityCustomAction\([\s\S]*name: focusActionLabel/);
  assert.match(accessibilitySource, /UIAccessibilityCustomAction\([\s\S]*name: copySelectionActionLabel/);
  assert.match(accessibilitySource, /UIAccessibilityCustomAction\([\s\S]*name: selectAllActionLabel/);
  assert.match(accessibilitySource, /UIAccessibilityCustomAction\([\s\S]*name: openLinkActionLabel/);
  assert.match(surfaceViewSource, /override var accessibilityCustomActions: \[UIAccessibilityCustomAction\]\?/);
  assert.match(accessibilitySource, /surfaceView\.setTerminalAccessibilityCustomActions\(actions\)/);
  assert.doesNotMatch(accessibilitySource, /"Terminal"|"Focus terminal"|"Copy selection"|"Native terminal renderer unavailable/);
  for (const propName of [
    'accessibilityTerminalLabel',
    'accessibilityFallbackValue',
    'accessibilityFocusActionLabel',
    'accessibilityCopySelectionActionLabel',
    'accessibilitySelectAllActionLabel',
    'accessibilityOpenLinkActionLabel',
  ]) {
    assert.match(moduleSource, new RegExp(`Prop\\("${propName}"`));
    assert.match(surfaceViewSource, new RegExp(`var ${propName}: String`));
  }
});

test('Android Termux accessibility surface fails closed until native accessibility is accepted', async () => {
  const source = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxView.kt'), 'utf-8');

  assert.match(source, /if \(!accessibilityAccepted \|\| surfaceId\.isBlank\(\)\) return/);
  assert.match(source, /override fun performAccessibilityAction[\s\S]*if \(!accessibilityAccepted \|\| surfaceId\.isBlank\(\)\) \{[\s\S]*return super\.performAccessibilityAction/);
  assert.match(source, /if \(!accessibilityAccepted\) \{[\s\S]*IMPORTANT_FOR_ACCESSIBILITY_NO[\s\S]*contentDescription = null/);
  assert.match(source, /importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES[\s\S]*TermuxBridge\.accessibilitySummary/);
});

test('iOS Ghostty accessibility summary never crosses surface identities', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceIdentityChange = surfaceViewSource.match(
    /if oldValue != surfaceId \{([\s\S]*?)\n\s*\}/,
  )?.[1] ?? '';
  const disposeSurface = surfaceViewSource.match(
    /func disposeSurface\(\) \{([\s\S]*?)\n\s*\}/,
  )?.[1] ?? '';

  assert.match(surfaceIdentityChange, /bridge\?\.dispose\(\)/);
  assert.match(surfaceIdentityChange, /accessibilitySummary = ""/);
  assert.match(disposeSurface, /bridge\?\.dispose\(\)/);
  assert.match(disposeSurface, /accessibilitySummary = ""/);
});

test('iOS Ghostty accessibility selection is Ghostty-owned and link routing remains host-policy-owned', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');
  const linksSource = await readFile(join(packageRoot, 'ios/GhosttyLinks.swift'), 'utf-8');

  assert.equal(await pathExists(join(packageRoot, 'ios/GhosttySelection.swift')), false);
  assert.match(surfaceBridgeSource, /func selectAll\(\) -> \[String: Any\]/);
  assert.match(surfaceBridgeSource, /ghostty_surface_binding_action\(surface, pointer, UInt\(action\.utf8\.count\)\)/);
  assert.match(surfaceBridgeSource, /let action = "select_all"/);
  assert.match(surfaceBridgeSource, /readSelectionText\(surface\)/);
  assert.match(surfaceBridgeSource, /emitEvent\("selection"/);
  assert.match(surfaceBridgeSource, /emitEvent\("copy"/);
  assert.match(surfaceBridgeSource, /func openAccessibleLink\(\) -> \[String: Any\]/);
  assert.match(surfaceBridgeSource, /firstGhosttySafeLinkEvent/);
  assert.match(surfaceBridgeSource, /emitEvent\("link"/);
  assert.doesNotMatch(surfaceBridgeSource, /UIApplication\.shared\.open|openURL:/);
  assert.match(linksSource, /explicit HTTP\(S\) candidates/);
});

test('Android Termux bridge enforces hard gates before creating or driving sessions', async () => {
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const remoteSessionSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxRemoteSession.kt'), 'utf-8');

  assert.match(bridgeSource, /private fun unavailableDiagnostic\(\): TermuxBridgeDiagnostic\?/);
  assert.match(bridgeSource, /fun createSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return surfaceAvailability\(it\) \}/);
  assert.match(bridgeSource, /fun writeBytes[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun sendInputBytes[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun sendTextInput[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun resizeSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun focusSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return \}/);
  assert.match(bridgeSource, /fun drawSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return \}/);
  assert.match(remoteSessionSource, /val diagnostic = makeTermuxBridgeDiagnostic\(\)[\s\S]*if \(!diagnostic\.available\)/);
});

test('Android Termux engineering QA override cannot replace the public legal gate', async () => {
  const buildGradle = await readFile(join(packageRoot, 'android/build.gradle'), 'utf-8');
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const rendererPolicy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));

  assert.match(buildGradle, /HAPPIER_TERMINAL_NATIVE_ANDROID_ENGINEERING_QA/);
  assert.deepEqual(
    rendererPolicy.engineeringQa.allowedAppEnvironments,
    ['internaldev', 'internalpreview'],
  );
  assert.match(buildGradle, /engineeringQaAllowedAppEnvironments\.contains\(appEnvironment\)/);
  assert.match(buildGradle, /engineeringQaOverride[\s\S]*internalEngineeringBuild/);
  assert.match(buildGradle, /qaCrashInjectionEnabled[\s\S]*internalEngineeringBuild/);
  assert.doesNotMatch(buildGradle, /APP_ENV"\)\s*!=/);
  assert.match(bridgeSource, /!BuildConfig\.HAPPIER_TERMINAL_NATIVE_ANDROID_LEGAL_ACCEPTED &&\s*!BuildConfig\.HAPPIER_TERMINAL_NATIVE_ANDROID_ENGINEERING_QA/);
  assert.match(bridgeSource, /engineeringQaOverride = BuildConfig\.HAPPIER_TERMINAL_NATIVE_ANDROID_ENGINEERING_QA/);
});

test('Android Termux accessibility uses host-localized labels and exposes focus, copy, select, and link actions', async () => {
  const moduleSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/HappierTerminalNativeModule.kt'), 'utf-8');
  const viewSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxView.kt'), 'utf-8');
  const remoteSessionSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxRemoteSession.kt'), 'utf-8');
  const adapterSource = await readFile(join(packageRoot, 'android/termux/adapter-src/main/java/dev/happier/terminal/termux/TermuxBackedRemoteSession.kt'), 'utf-8');

  for (const propName of [
    'accessibilityTerminalLabel',
    'accessibilityFallbackValue',
    'accessibilityFocusActionLabel',
    'accessibilityCopySelectionActionLabel',
    'accessibilitySelectAllActionLabel',
    'accessibilityOpenLinkActionLabel',
  ]) {
    assert.match(moduleSource, new RegExp(`Prop\\("${propName}"`));
  }
  assert.match(viewSource, /override fun onInitializeAccessibilityNodeInfo/);
  assert.match(viewSource, /AccessibilityNodeInfo\.AccessibilityAction\(/);
  assert.match(viewSource, /override fun performAccessibilityAction/);
  assert.match(viewSource, /TermuxBridge\.copySelection\(surfaceId\)/);
  assert.match(viewSource, /TermuxBridge\.selectAll\(surfaceId\)/);
  assert.match(viewSource, /TermuxBridge\.openAccessibleLink\(surfaceId\)/);
  assert.match(adapterSource, /override fun selectAll\(\): Boolean/);
  assert.match(adapterSource, /override fun openAccessibleLink\(\): Boolean/);
  assert.match(adapterSource, /mapNotNull\(::extractHttpUrlCandidate\)/);
  assert.match(viewSource, /takeUnless \{ it\.isNullOrBlank\(\) \}/);
  assert.doesNotMatch(viewSource, /"Terminal"|"Focus terminal"|"Copy selection"|"Native terminal renderer unavailable/);
  assert.doesNotMatch(remoteSessionSource, /Android native terminal unavailable/);
  assert.doesNotMatch(adapterSource, /Android native terminal surface/);
});

test('Android Termux serializes every terminal session operation on the Android main owner', async () => {
  const moduleSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/HappierTerminalNativeModule.kt'), 'utf-8');
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const adapterSource = await readFile(join(packageRoot, 'android/termux/adapter-src/main/java/dev/happier/terminal/termux/TermuxBackedRemoteSession.kt'), 'utf-8');

  assert.match(moduleSource, /import expo\.modules\.kotlin\.functions\.Queues/);
  for (const functionName of [
    'createSurface',
    'writeBytes',
    'sendInputBytes',
    'resizeSurface',
    'focusSurface',
    'clearSurface',
    'disposeSurface',
    'copySelection',
  ]) {
    assert.match(asyncFunctionDefinition(moduleSource, functionName), /\.runOnQueue\(Queues\.MAIN\)/);
  }

  assert.match(
    bridgeSource,
    /internal fun requireTermuxMainThread\(\) \{\s*check\(Looper\.myLooper\(\) == Looper\.getMainLooper\(\)\)/,
  );
  for (const functionName of [
    'createSurface',
    'writeBytes',
    'sendInputBytes',
    'sendTextInput',
    'sendKeyEvent',
    'handleMotionEvent',
    'resizeSurface',
    'focusSurface',
    'clearSurface',
    'copySelection',
    'accessibilitySummary',
    'drawSurface',
    'disposeSurface',
    'disposeAll',
  ]) {
    assert.match(kotlinFunctionBody(bridgeSource, functionName), /^\s*requireTermuxMainThread\(\)/);
  }

  assert.match(
    adapterSource,
    /private val emulator: TerminalEmulator = run \{\s*requireTermuxMainThread\(\)[\s\S]*TerminalEmulator\(/,
  );
  for (const functionName of [
    'writeBytes',
    'sendInputBytes',
    'sendTextInput',
    'sendKeyEvent',
    'handleMotionEvent',
    'resize',
    'focus',
    'clear',
    'copySelection',
    'accessibilitySummary',
    'draw',
    'dispose',
  ]) {
    assert.match(kotlinFunctionBody(adapterSource, functionName), /^\s*requireTermuxMainThread\(\)/);
  }
});

test('Android Termux reports adapter load failure per surface instead of an available no-op', async () => {
  const moduleSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/HappierTerminalNativeModule.kt'), 'utf-8');
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const remoteSessionSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxRemoteSession.kt'), 'utf-8');

  const moduleCreateSurface = asyncFunctionDefinition(moduleSource, 'createSurface');
  assert.match(moduleCreateSurface, /return@AsyncFunction TermuxBridge\.createSurface\(surfaceId\) \{/);
  assert.doesNotMatch(moduleCreateSurface, /TermuxBridge\.availability\(\)/);

  const bridgeCreateSurface = kotlinFunctionBody(bridgeSource, 'createSurface');
  assert.match(bridgeCreateSurface, /return surfaceAvailability\(surface\.diagnostic\)/);
  assert.match(bridgeCreateSurface, /emitSurfaceFailure\(surfaceId, eventSink, surface\.diagnostic\)/);
  assert.doesNotMatch(bridgeCreateSurface, /return diagnostic\(\)/);

  const factoryCreate = kotlinFunctionBody(remoteSessionSource, 'create');
  assert.match(factoryCreate, /catch \(error: Throwable\) \{\s*if \(error is CancellationException \|\| error is VirtualMachineError \|\| error is ThreadDeath\) throw error/);
  assert.match(remoteSessionSource, /override val diagnostic: TermuxBridgeDiagnostic = makeUnavailableTermuxBridgeDiagnostic\(overrideDetail\)/);

  const unavailableSessionSource = remoteSessionSource.slice(
    remoteSessionSource.indexOf('private class UnavailableTermuxRemoteSession'),
  );
  const unavailableInput = kotlinFunctionBody(unavailableSessionSource, 'sendInputBytes');
  const unavailableText = kotlinFunctionBody(unavailableSessionSource, 'sendTextInput');
  const unavailableResize = kotlinFunctionBody(unavailableSessionSource, 'resize');
  assert.match(unavailableInput, /return rejected\(\s*"renderer-unavailable"/);
  assert.doesNotMatch(unavailableInput, /callbacks\.emitInputBytes/);
  assert.match(unavailableText, /return rejected\(\s*"renderer-unavailable"/);
  assert.doesNotMatch(unavailableText, /callbacks\.emitInputBytes/);
  assert.match(unavailableResize, /return rejected\(\s*"renderer-unavailable"/);
  assert.doesNotMatch(unavailableResize, /callbacks\.emitResize/);
});

test('Android Termux adapter routes safe link taps through the native event contract', async () => {
  const remoteSessionSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxRemoteSession.kt'), 'utf-8');
  const adapterSource = await readFile(join(packageRoot, 'android/termux/adapter-src/main/java/dev/happier/terminal/termux/TermuxBackedRemoteSession.kt'), 'utf-8');
  const policy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));

  assert.match(remoteSessionSource, /fun emitLink\(url: String, text: String\?\s*=\s*null\)/);
  assert.match(adapterSource, /private fun emitLinkAt\(event: MotionEvent\): Boolean/);
  assert.match(adapterSource, /emulator\.getScreen\(\)\.getWordAtLocation\(column, row\)/);
  assert.match(adapterSource, /private fun extractHttpUrlCandidate\(rawWord: String\): String\?/);
  assert.match(adapterSource, /scheme != "http" && scheme != "https"/);
  assert.match(adapterSource, /callbacks\.emitLink\(url, text = word\)/);
  assert.ok(policy.androidTermux.interactionModel.implementedInAdapter.includes('safe-http-link-tap-routing'));
});

test('iOS probe reports structured fail-closed fallback diagnostics', async () => {
  const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeIos.mjs')], {
    env: {
      ...process.env,
      HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_ARTIFACT_PATH: join(await mkdtempPath(), 'missing-GhosttyKit.xcframework'),
      HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256: '0'.repeat(64),
    },
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, 'blocked');
  assert.equal(payload.platform, 'ios');
  assert.equal(payload.renderer, 'ios-ghosttykit');
  assert.equal(payload.fallbackRenderer, 'xterm-webview');
  assert.equal(payload.fallbackRequired, true);
  assert.ok(payload.requiredGates.includes('checksum-pinned-artifact'));
  assert.ok(payload.remediation.includes('Provide the pinned/checksummed libghostty-spm GhosttyKit.xcframework. If that supply path is unusable, stop and open the unimplemented direct-source-build contingency packet.'));
});

test('iOS probe blocks a linked GhosttyKit artifact until package and crash proof gates pass', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });
  const { computeSha256ForPath } = await import('./checksum.mjs');
  const expectedSha256 = await computeSha256ForPath(artifactPath);

  try {
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_ARTIFACT_PATH: artifactPath,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256: expectedSha256,
      },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'package-proof-unaccepted');
    assert.equal(payload.fallbackRequired, true);
    assert.equal(payload.gates.packageProofAccepted, false);
    assert.equal(payload.gates.crashFallbackProven, false);
  } finally {
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('iOS probe reports fallback-required availability after hard gates pass without native accessibility', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });
  const { computeSha256ForPath } = await import('./checksum.mjs');
  const expectedSha256 = await computeSha256ForPath(artifactPath);

  try {
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_ARTIFACT_PATH: artifactPath,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256: expectedSha256,
        HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED: '1',
        HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN: '1',
      },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, 'ok');
    assert.equal(payload.reason, 'available');
    assert.equal(payload.fallbackRequired, true);
    assert.deepEqual(payload.availability, {
      available: true,
      platform: 'ios',
      renderer: 'ios-ghosttykit',
      moduleVersion: '0.0.0',
      accessibility: 'fallback-required',
    });
    assert.equal(payload.gates.nativeAccessibilityProven, false);
  } finally {
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

test('Android probe reports structured fail-closed license and fallback diagnostics', async () => {
  const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeAndroid.mjs')], {
    env: {
      ...process.env,
      HAPPIER_TERMINAL_NATIVE_TERMUX_VENDOR: join(await mkdtempPath(), 'missing-vendor'),
    },
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, 'blocked');
  assert.equal(payload.platform, 'android');
  assert.equal(payload.renderer, 'android-termux');
  assert.equal(payload.reason, 'artifact-missing');
  assert.equal(payload.fallbackRenderer, 'xterm-webview');
  assert.equal(payload.fallbackRequired, true);
  assert.equal(payload.source.strategy.kind, 'ignored-source-extract');
  assert.equal(payload.source.status, 'missing');
  assert.equal(payload.license.kind, 'Apache-2.0');
  assert.equal(payload.license.bundleFullTermuxApp, false);
  assert.deepEqual(payload.requiredModules, [
    { name: 'terminal-view', path: 'terminal-view', license: 'Apache-2.0' },
    { name: 'terminal-emulator', path: 'terminal-emulator', license: 'Apache-2.0' },
  ]);
  assert.deepEqual(payload.forbiddenModules.map((entry) => entry.name), ['app', 'termux-shared']);
  assert.equal(payload.remoteSessionAdapter.required, true);
  assert.equal(payload.interaction.kind, 'happier-owned-remote-session-adapter');
  assert.deepEqual(payload.interaction.uses, ['TerminalEmulator', 'TerminalRenderer']);
  assert.ok(payload.interaction.implementedInAdapter.includes('ime-commit-text'));
  assert.ok(payload.interaction.implementedInAdapter.includes('hardware-key-escape-mapping'));
  assert.ok(payload.interaction.implementedInAdapter.includes('mouse-tracking-and-scrollback'));
  assert.ok(payload.interaction.implementedInAdapter.includes('long-press-drag-range-selection'));
  assert.ok(payload.interaction.implementedInAdapter.includes('selected-range-rendering-and-copy'));
  assert.equal(payload.interaction.remainingGaps.includes('selection-handles'), false);
  assert.ok(payload.interaction.completedDeviceQa.includes('localized-accessibility-summary-and-actions'));
  assert.ok(payload.interaction.completedDeviceQa.includes('renderer-crash-event'));
  assert.deepEqual(payload.interaction.remainingGaps, ['complete-term-7b-loaded-workload-matrix']);
  assert.deepEqual(payload.interaction.requiresDeviceQa, ['complete-term-7b-loaded-workload-matrix']);
  assert.equal(payload.gradle.status, 'source-missing');
  assert.equal(payload.abi.status, 'unverified');
  assert.ok(payload.requiredGates.includes('dependency-closure-review'));
  assert.equal(payload.requiredGates.includes('legal-product-approval'), true);
  assert.ok(payload.remediation.includes('Set HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT to a locally audited Termux checkout, then run scripts/fetchTermuxAndroid.mjs to extract only terminal-view and terminal-emulator into android/termux/vendor.'));
});

test('Android probe reports source-present state blocked by hard package gates before native selection', async () => {
  const { installTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const sourceRoot = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });
  const vendorRoot = await mkdtempPath();

  try {
    await installTermuxAndroidSource({
      sourceRoot,
      vendorRoot,
      observedCommit: '401bbe54b8f4e68302b1ff70678015a24628fb1d',
    });
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeAndroid.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_TERMUX_VENDOR: vendorRoot,
      },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'dependency-closure-unapproved');
    assert.equal(payload.source.status, 'ok');
    assert.equal(payload.source.metadata.observedCommit, '401bbe54b8f4e68302b1ff70678015a24628fb1d');
    assert.equal(payload.gradle.status, 'source-present');
    assert.equal(payload.requiredGates.includes('legal-product-approval'), true);
    assert.equal(payload.gates.dependencyClosureApproved, false);
    assert.equal(payload.gates.legalAccepted, false);
    assert.ok(payload.remediation.includes('Keep xterm WebView selected until source, legal, package, ABI, crash fallback, and accessibility gates pass.'));
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(vendorRoot, { force: true, recursive: true });
  }
});

test('Android probe reports fallback-required availability after hard gates pass without native accessibility', async () => {
  const { installTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const sourceRoot = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });
  const vendorRoot = await mkdtempPath();

  try {
    await installTermuxAndroidSource({
      sourceRoot,
      vendorRoot,
      observedCommit: '401bbe54b8f4e68302b1ff70678015a24628fb1d',
    });
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeAndroid.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_TERMUX_VENDOR: vendorRoot,
        HAPPIER_TERMINAL_NATIVE_ANDROID_DEPENDENCY_CLOSURE_APPROVED: '1',
        HAPPIER_TERMINAL_NATIVE_ANDROID_LEGAL_ACCEPTED: '1',
        HAPPIER_TERMINAL_NATIVE_ANDROID_GRADLE_BUILD_PROVEN: '1',
        HAPPIER_TERMINAL_NATIVE_ANDROID_ABI_SMOKE_PASSED: '1',
        HAPPIER_TERMINAL_NATIVE_ANDROID_CRASH_FALLBACK_PROVEN: '1',
      },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, 'ok');
    assert.equal(payload.reason, 'available');
    assert.deepEqual(payload.availability, {
      available: true,
      platform: 'android',
      renderer: 'android-termux',
      moduleVersion: '0.0.0',
      accessibility: 'fallback-required',
    });
    assert.equal(payload.fallbackRequired, true);
    assert.equal(payload.gates.nativeAccessibilityProven, false);
    assert.ok(payload.remediation.includes('Use terminalRendererPreference=native to opt into Android native while the custom accessibility model is still fallback-required.'));
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(vendorRoot, { force: true, recursive: true });
  }
});

test('license notice independently gates installed iOS GhosttyKit license, notice, and provenance', async () => {
  const fixtureRoot = await createNativeLicenseFixture();

  try {
    const { createLicenseNoticeReport } = await import('./licenseNotice.mjs');
    const payload = await createLicenseNoticeReport({ packageRoot: fixtureRoot });

    assert.equal(payload.status, 'ok');
    assert.equal(payload.vendoredRendererArtifacts, true);
    assert.equal(payload.iosGhostty.status, 'ok');
    assert.equal(payload.iosGhostty.artifact.status, 'present');
    assert.deepEqual(payload.iosGhostty.license, {
      kind: 'MIT',
      path: 'ios/Vendor/LICENSE-libghostty-spm.txt',
      sourceUrl: 'https://raw.githubusercontent.com/Lakr233/libghostty-spm/c069f05e0a4ef50143e943e954ed75e52e947009/LICENSE',
      status: 'present',
    });
    assert.equal(payload.iosGhostty.notice.status, 'present');
    assert.deepEqual(payload.iosGhostty.notice.missingProvenance, []);

    await rm(join(fixtureRoot, 'ios', 'Vendor', 'GhosttyKit.xcframework'), { force: true, recursive: true });
    const missingArtifact = await createLicenseNoticeReport({ packageRoot: fixtureRoot });
    assert.equal(missingArtifact.status, 'blocked');
    assert.equal(missingArtifact.iosGhostty.status, 'blocked');
    assert.equal(missingArtifact.iosGhostty.artifact.status, 'missing');
    assert.equal(missingArtifact.vendoredRendererArtifacts, false);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test('license notice retains Android Termux module scope without approving the full app', async () => {
  const fixtureRoot = await createNativeLicenseFixture();

  try {
    const { createLicenseNoticeReport } = await import('./licenseNotice.mjs');
    const payload = await createLicenseNoticeReport({ packageRoot: fixtureRoot });

    assert.equal(payload.androidTermux.license.kind, 'Apache-2.0');
    assert.equal(payload.androidTermux.license.fullTermuxAppLicense, 'GPL-3.0-only');
    assert.equal(payload.androidTermux.license.bundleFullTermuxApp, false);
    assert.deepEqual(payload.androidTermux.requiredModules, [
      { name: 'terminal-view', path: 'terminal-view', license: 'Apache-2.0' },
      { name: 'terminal-emulator', path: 'terminal-emulator', license: 'Apache-2.0' },
    ]);
    assert.deepEqual(payload.androidTermux.forbiddenModules.map((entry) => entry.name), ['app', 'termux-shared']);
    assert.equal(payload.androidTermux.remoteSessionAdapter.required, true);
    assert.equal(payload.androidTermux.sourceStrategy.kind, 'ignored-source-extract');
    assert.equal(payload.androidTermux.notice.path, 'android/termux/NOTICE.md');
    assert.equal(payload.androidTermux.notice.status, 'present');
    assert.equal(payload.androidTermux.engineeringEvidenceStatus, 'ok');
    assert.equal(payload.androidTermux.releaseApprovalStatus, 'not-recorded-in-repository');
    assert.equal(payload.androidTermux.approvalBoundary.currentStatus, 'not-recorded-in-repository');
    assert.match(payload.androidTermux.approvalBoundary.environmentGateSemantics, /assertion only/);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test('iOS GhosttyKit XCFramework is ignored and not package-included before proof-gated acceptance', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));
  const packageIgnore = await readFile(join(packageRoot, '.gitignore'), 'utf-8');

  assert.equal(packageJson.files.includes('ios/Vendor'), false);
  assert.ok(packageJson.files.includes('ios/Vendor/README.md'));
  assert.match(packageIgnore, /^ios\/Vendor\/GhosttyKit\.xcframework\/$/m);
  assert.match(packageIgnore, /^ios\/Vendor\/GhosttyKit\.xcframework\.zip$/m);

  try {
    const { stdout } = await execFileAsync('git', [
      'check-ignore',
      '-v',
      join(packageRoot, 'ios/Vendor/GhosttyKit.xcframework'),
    ]);
    assert.match(stdout, /ios\/Vendor\/GhosttyKit\.xcframework/);
  } catch (error) {
    // Preferred execution mirrors intentionally omit repository metadata. The
    // checked-in package ignore policy remains the canonical portable proof.
    if (error?.code !== 128) throw error;
  }
});

test('iOS podspec links GhosttyKit only when package proof gates are explicitly accepted', async () => {
  const podspec = await readFile(join(packageRoot, 'ios/HappierTerminalNative.podspec'), 'utf-8');
  const linkageGateIndex = podspec.indexOf('if ghostty_framework_link_allowed');
  const packageProofFlagIndex = podspec.indexOf('-DHAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED');
  const crashFallbackFlagIndex = podspec.indexOf('-DHAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN');
  const linkedFrameworkFlagIndex = podspec.indexOf('-DHAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY');

  assert.match(podspec, /ghostty_framework_link_allowed/);
  assert.match(podspec, /HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED/);
  assert.match(podspec, /HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN/);
  assert.doesNotMatch(podspec, /^\s*if File\.exist\?\(ghostty_framework_path\)\s*$/m);
  assert.ok(packageProofFlagIndex > -1 && packageProofFlagIndex < linkageGateIndex);
  assert.ok(crashFallbackFlagIndex > -1 && crashFallbackFlagIndex < linkageGateIndex);
  assert.ok(linkedFrameworkFlagIndex > linkageGateIndex);
});

test('size budget script measures recursive directory bytes for XCFramework artifacts', async () => {
  const root = await mkdtempPath();
  const artifactPath = join(root, 'Fixture.xcframework');
  await mkdir(join(artifactPath, 'ios-arm64'), { recursive: true });
  await mkdir(join(artifactPath, 'ios-arm64_x86_64-simulator'), { recursive: true });
  await writeFile(join(artifactPath, 'ios-arm64', 'libghostty.a'), '1234567890');
  await writeFile(join(artifactPath, 'ios-arm64_x86_64-simulator', 'libghostty.a'), 'abcde');

  try {
    await execFileAsync(process.execPath, [join(packageRoot, 'scripts/sizeBudget.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_ARTIFACT: artifactPath,
        HAPPIER_TERMINAL_NATIVE_MAX_BYTES: '14',
      },
    });
    assert.fail('sizeBudget.mjs should fail when recursive artifact contents exceed the budget');
  } catch (error) {
    assert.equal(error.code, 1);
    const payload = JSON.parse(error.stdout);

    assert.equal(payload.status, 'over-budget');
    assert.equal(payload.bytes, 15);
    assert.equal(payload.maxBytes, 14);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Android artifact evidence reports size delta and packaged ABI closure without claiming device smoke', async () => {
  const outputRoot = await mkdtempPath();
  const fakeBin = await mkdtempPath();
  const baselinePath = join(outputRoot, 'baseline.apk');
  const candidatePath = join(outputRoot, 'candidate.apk');
  const fakeUnzip = join(fakeBin, 'unzip');
  const originalPath = process.env.PATH;

  try {
    await writeFile(baselinePath, 'baseline-apk');
    await writeFile(candidatePath, 'candidate-apk-with-native-renderer');
    await writeFile(fakeUnzip, [
      '#!/bin/sh',
      'case "$2" in',
      '  *candidate.apk) printf "lib/arm64-v8a/libapp.so\\nlib/x86_64/libapp.so\\n" ;;',
      '  *) printf "lib/arm64-v8a/libapp.so\\n" ;;',
      'esac',
    ].join('\n'));
    await chmod(fakeUnzip, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

    const { createAndroidArtifactEvidence } = await import('./androidArtifactEvidence.mjs');
    const report = await createAndroidArtifactEvidence({
      candidatePath,
      baselinePath,
      requiredAbis: ['arm64-v8a', 'x86_64'],
    });

    assert.equal(report.status, 'ok');
    assert.deepEqual(report.candidate.packagedAbis, ['arm64-v8a', 'x86_64']);
    assert.deepEqual(report.missingAbis, []);
    assert.equal(report.sizeDeltaBytes, report.candidate.bytes - report.baseline.bytes);
    assert.match(report.candidate.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.evidenceScope, 'static-apk-package-only');
    assert.equal(report.abiSmokeStillRequired, true);
  } finally {
    process.env.PATH = originalPath;
    await rm(fakeBin, { force: true, recursive: true });
    await rm(outputRoot, { force: true, recursive: true });
  }
});

test('Android Termux source verifier requires provenance and license closure in addition to terminal-only modules', async () => {
  const { validateTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const root = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });

  try {
    const result = await validateTermuxAndroidSource({ sourceRoot: root });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'termux-source-provenance-unverified');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Android Termux source verifier rejects forbidden GPL/dependency modules', async () => {
  const { validateTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const root = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator', 'app', 'termux-shared'],
  });

  try {
    const result = await validateTermuxAndroidSource({ sourceRoot: root });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'forbidden-termux-modules-present');
    assert.deepEqual(result.forbiddenPresent.sort(), ['app', 'termux-shared']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Android Termux source installer extracts allowed modules and records pinned provenance', async () => {
  const { installTermuxAndroidSource, validateTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const sourceRoot = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });
  const vendorRoot = await mkdtempPath();

  try {
    const result = await installTermuxAndroidSource({
      sourceRoot,
      vendorRoot,
      observedCommit: '401bbe54b8f4e68302b1ff70678015a24628fb1d',
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.metadata.observedCommit, '401bbe54b8f4e68302b1ff70678015a24628fb1d');
    assert.deepEqual(result.metadata.modules.map((entry) => entry.name).sort(), ['terminal-emulator', 'terminal-view']);
    assert.equal(await pathExists(join(vendorRoot, 'terminal-view', 'src', 'main', 'java', 'com', 'termux', 'view', 'TerminalView.java')), true);
    assert.equal(await pathExists(join(vendorRoot, 'terminal-emulator', 'src', 'main', 'java', 'com', 'termux', 'terminal', 'TerminalEmulator.java')), true);
    assert.equal(await pathExists(join(vendorRoot, 'app')), false);
    assert.equal(await pathExists(join(vendorRoot, 'termux-shared')), false);

    const validation = await validateTermuxAndroidSource({ sourceRoot: vendorRoot });
    assert.equal(validation.status, 'ok');
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(vendorRoot, { force: true, recursive: true });
  }
});

test('Android Termux source installer rejects an unpinned revision before copying source', async () => {
  const { installTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const sourceRoot = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });
  const vendorRoot = await mkdtempPath();

  try {
    const result = await installTermuxAndroidSource({
      sourceRoot,
      vendorRoot,
      observedCommit: '0000000000000000000000000000000000000000',
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'termux-source-revision-mismatch');
    assert.equal(await pathExists(join(vendorRoot, 'terminal-view')), false);
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(vendorRoot, { force: true, recursive: true });
  }
});

test('Android Termux source installer preserves the Apache notice closure with pinned provenance', async () => {
  const { installTermuxAndroidSource, validateTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const sourceRoot = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });
  const vendorRoot = await mkdtempPath();

  try {
    await writeFile(join(sourceRoot, 'NOTICE.md'), 'Terminal Emulator for Android notice.');
    const result = await installTermuxAndroidSource({
      sourceRoot,
      vendorRoot,
      observedCommit: '401bbe54b8f4e68302b1ff70678015a24628fb1d',
    });

    assert.equal(result.status, 'ok');
    assert.equal(
      await readFile(join(vendorRoot, 'TERMUX-UPSTREAM-LICENSE.md'), 'utf-8'),
      'Termux GPL root with Apache terminal exceptions.',
    );
    assert.equal(
      await readFile(join(vendorRoot, 'TERMUX-UPSTREAM-NOTICE.md'), 'utf-8'),
      'Terminal Emulator for Android notice.',
    );
    assert.deepEqual(result.metadata.licenseClosure, {
      upstreamLicensePath: 'TERMUX-UPSTREAM-LICENSE.md',
      upstreamNoticePath: 'TERMUX-UPSTREAM-NOTICE.md',
      noticePath: 'android/termux/NOTICE.md',
    });

    const validation = await validateTermuxAndroidSource({ sourceRoot: vendorRoot });
    assert.equal(validation.status, 'ok');
    assert.deepEqual(validation.metadata.licenseClosure, result.metadata.licenseClosure);
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(vendorRoot, { force: true, recursive: true });
  }
});

test('Android Termux programmatic focus reaches the mounted native view without recreating the process-backed widget', async () => {
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const viewSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxView.kt'), 'utf-8');

  assert.match(bridgeSource, /private val focusRequesters = mutableMapOf<String, \(\) -> Unit>\(\)/);
  assert.match(bridgeSource, /fun registerSurfaceFocusRequester\(surfaceId: String, focusRequester: \(\) -> Unit\)/);
  assert.match(bridgeSource, /focusRequesters\[surfaceId\]\?\.invoke\(\)/);
  assert.match(viewSource, /TermuxBridge\.registerSurfaceFocusRequester\(surfaceId, surfaceFocusRequester\)/);
  assert.match(viewSource, /private fun requestNativeViewFocus\(\)/);
  assert.doesNotMatch(viewSource, /com\.termux\.view\.TerminalView/);
});

test('Android Termux view teardown cannot unregister native callbacks a newer view now owns', async () => {
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const viewSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxView.kt'), 'utf-8');

  assert.match(bridgeSource, /fun unregisterSurfaceInvalidator\(surfaceId: String, invalidator: \(\) -> Unit\)/);
  assert.match(bridgeSource, /invalidators\.remove\(surfaceId, invalidator\)/);
  assert.match(bridgeSource, /fun unregisterSurfaceFocusRequester\(surfaceId: String, focusRequester: \(\) -> Unit\)/);
  assert.match(bridgeSource, /focusRequesters\.remove\(surfaceId, focusRequester\)/);
  assert.match(viewSource, /private val surfaceInvalidator: \(\) -> Unit = \{[\s\S]*?postInvalidateOnAnimation\(\)[\s\S]*?refreshAccessibility\(\)[\s\S]*?TYPE_WINDOW_CONTENT_CHANGED[\s\S]*?\n  }/);
  assert.match(viewSource, /private val surfaceFocusRequester: \(\) -> Unit = \{\s*requestNativeViewFocus\(\)\s*}/);
  assert.match(viewSource, /TermuxBridge\.unregisterSurfaceInvalidator\(currentSurfaceId, surfaceInvalidator\)/);
  assert.match(viewSource, /TermuxBridge\.unregisterSurfaceFocusRequester\(currentSurfaceId, surfaceFocusRequester\)/);
  assert.doesNotMatch(viewSource, /TermuxBridge\.disposeSurface/);
});

test('Android module disposal preserves callbacks owned by a still-mounted Termux view', async () => {
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const disposeSurfaceBody = bridgeSource.match(/fun disposeSurface\(surfaceId: String\) \{([\s\S]*?)\n  }/)?.[1] ?? '';

  assert.match(disposeSurfaceBody, /surfaces\.remove\(surfaceId\)\?\.dispose\(\)/);
  assert.doesNotMatch(disposeSurfaceBody, /invalidators\.remove/);
  assert.doesNotMatch(disposeSurfaceBody, /focusRequesters\.remove/);
});

test('iOS module disposal preserves the mounted Ghostty view registration across effect replay', async () => {
  const viewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const disposeSurfaceBody = viewSource.match(/func disposeSurface\(\) \{([\s\S]*?)\n  }/)?.[1] ?? '';

  assert.match(disposeSurfaceBody, /bridge\?\.dispose\(\)/);
  assert.doesNotMatch(disposeSurfaceBody, /GhosttySurfaceRegistry\.shared\.unregister/);
  assert.doesNotMatch(disposeSurfaceBody, /eventEmitter = nil/);
  assert.match(viewSource, /deinit \{[\s\S]*GhosttySurfaceRegistry\.shared\.unregister\(view: self\)/);
});

test('Android Termux reattaches native callbacks after a retained view returns to the window', async () => {
  const viewSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxView.kt'), 'utf-8');

  assert.match(viewSource, /override fun onAttachedToWindow\(\) \{\s*super\.onAttachedToWindow\(\)\s*val currentSurfaceId = surfaceId\s*if \(currentSurfaceId\.isNotBlank\(\)\) \{\s*TermuxBridge\.registerSurfaceInvalidator\(currentSurfaceId, surfaceInvalidator\)\s*TermuxBridge\.registerSurfaceFocusRequester\(currentSurfaceId, surfaceFocusRequester\)/);
});

test('Android Gradle consumes Termux source only when the pinned license closure is present', async () => {
  const buildGradle = await readFile(join(packageRoot, 'android/build.gradle'), 'utf-8');

  assert.match(buildGradle, /new groovy\.json\.JsonSlurper\(\)\.parse\(termuxSourceMetadataFile\)/);
  assert.match(buildGradle, /termuxSourceMetadata\.observedCommit == termuxPolicy\.upstream\.observedCommit/);
  assert.match(buildGradle, /TERMUX-UPSTREAM-LICENSE\.md/);
  assert.match(buildGradle, /TERMUX-UPSTREAM-NOTICE\.md/);
});

test('Android Termux fetch rejects a checkout whose Git revision differs from the policy pin', async () => {
  const { ensureTermuxAndroidSourceFromEnvironment } = await import('./termuxAndroidSource.mjs');
  const sourceRoot = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });
  const vendorRoot = await mkdtempPath();
  const fakeBin = await mkdtempPath();
  const fakeGit = join(fakeBin, 'git');
  const originalPath = process.env.PATH;

  await writeFile(fakeGit, [
    '#!/bin/sh',
    'case "$*" in',
    '  *"rev-parse HEAD") printf "0000000000000000000000000000000000000000\\n" ;;',
    '  *"status --porcelain") exit 0 ;;',
    '  *) exit 72 ;;',
    'esac',
  ].join('\n'));
  await chmod(fakeGit, 0o755);

  try {
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    const result = await ensureTermuxAndroidSourceFromEnvironment({ sourceRoot, vendorRoot });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'termux-source-revision-mismatch');
    assert.equal(await pathExists(join(vendorRoot, 'terminal-view')), false);
  } finally {
    process.env.PATH = originalPath;
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(vendorRoot, { force: true, recursive: true });
    await rm(fakeBin, { force: true, recursive: true });
  }
});

test('Android Termux fetch script requires an explicit local source root', async () => {
  const fakeBin = await mkdtempPath();
  const fakeGit = join(fakeBin, 'git');
  await writeFile(fakeGit, [
    '#!/bin/sh',
    'printf "git should not be called without explicit Termux source root\\n" >&2',
    'exit 23',
  ].join('\n'));
  await chmod(fakeGit, 0o755);

  try {
    await execFileAsync(process.execPath, [join(packageRoot, 'scripts/fetchTermuxAndroid.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE: '',
        HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT: '',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });
    assert.fail('fetchTermuxAndroid.mjs should fail without an explicit local source root');
  } catch (error) {
    assert.equal(error.code, 1);
    assert.equal(error.stderr, '');
    const payload = JSON.parse(error.stdout);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'missing-termux-source-root-env');
    assert.equal(payload.sourceEnv, 'HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT');
  } finally {
    await rm(fakeBin, { force: true, recursive: true });
  }
});

test('native build-input policy pins both archives and binds notices to immutable provenance', async () => {
  const policy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
  const ghosttyNotice = await readFile(join(packageRoot, 'ios', 'Vendor', 'NOTICE.md'), 'utf-8');
  const termuxNotice = await readFile(join(packageRoot, 'android', 'termux', 'NOTICE.md'), 'utf-8');

  assert.match(policy.iosGhostty.artifact.upstreamDownloadUrl, /^https:\/\//);
  assert.match(policy.iosGhostty.artifact.upstreamZipSha256, /^[a-f0-9]{64}$/);
  assert.match(policy.androidTermux.upstream.sourceArchive.url, /^https:\/\//);
  assert.match(policy.androidTermux.upstream.sourceArchive.sha256, /^[a-f0-9]{64}$/);
  assert.equal(policy.androidTermux.upstream.sourceArchive.commit, policy.androidTermux.upstream.observedCommit);

  for (const token of [
    policy.iosGhostty.artifact.source,
    policy.iosGhostty.artifact.upstreamRelease,
    policy.iosGhostty.artifact.upstreamZipSha256,
    policy.iosGhostty.artifact.expandedSha256,
    policy.iosGhostty.upstream.observedCommit,
    policy.iosGhostty.license.kind,
    policy.iosGhostty.license.bundledPath,
    policy.iosGhostty.license.sourceUrl,
  ]) {
    assert.ok(ghosttyNotice.includes(token), `Expected Ghostty notice to record ${token}`);
  }

  for (const token of [
    policy.androidTermux.upstream.observedCommit,
    policy.androidTermux.upstream.sourceArchive.url,
    policy.androidTermux.upstream.sourceArchive.sha256,
    'terminal-view',
    'terminal-emulator',
    'Apache',
  ]) {
    assert.ok(termuxNotice.includes(token), `Expected Termux notice to record ${token}`);
  }
});

test('iOS native build-input materialization validates the archive cache before preserving a verified destination', async () => {
  const artifactPath = await createGhosttyKitFixture({
    header: [
      'typedef enum { GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED = 1 } ghostty_surface_io_backend_e;',
      'typedef void (*ghostty_surface_receive_buffer_cb)(void*, const unsigned char*, unsigned long);',
      'typedef void (*ghostty_surface_receive_resize_cb)(void*, unsigned short, unsigned short, unsigned int, unsigned int);',
      'void ghostty_surface_write_buffer(void*, const unsigned char*, unsigned long);',
      'void ghostty_surface_process_exit(void*, unsigned int, unsigned long long);',
    ].join('\n'),
  });
  const zipPath = await zipGhosttyKitFixture(artifactPath);
  const archiveBytes = await readFile(zipPath);
  const { computeSha256ForPath } = await import('./checksum.mjs');
  const archiveSha256 = await computeSha256ForPath(zipPath);
  const expandedSha256 = await computeSha256ForPath(artifactPath);
  const cacheRoot = await mkdtempPath();
  const noticeRoot = await mkdtempPath();
  const destinationPath = join(await mkdtempPath(), 'GhosttyKit.xcframework');
  const policy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
  policy.iosGhostty.artifact.upstreamDownloadUrl = 'https://example.invalid/GhosttyKit.xcframework.zip';
  policy.iosGhostty.artifact.upstreamZipSha256 = archiveSha256;
  policy.iosGhostty.artifact.expandedSha256 = expandedSha256;

  await mkdir(join(noticeRoot, 'ios', 'Vendor'), { recursive: true });
  await writeFile(join(noticeRoot, 'ios', 'Vendor', 'NOTICE.md'), [
    policy.iosGhostty.artifact.source,
    policy.iosGhostty.artifact.upstreamRelease,
    policy.iosGhostty.artifact.upstreamZipSha256,
    policy.iosGhostty.upstream.observedCommit,
  ].join('\n'));

  try {
    const { materializeNativeBuildInputs } = await import('./materializeNativeBuildInputs.mjs');
    const first = await materializeNativeBuildInputs({
      platform: 'ios',
      packageRoot: noticeRoot,
      cacheRoot,
      destinationPath,
      policy,
      fetchImpl: async (url) => {
        assert.equal(url, policy.iosGhostty.artifact.upstreamDownloadUrl);
        return new Response(archiveBytes, { status: 200 });
      },
    });

    assert.equal(first.platform, 'ios');
    assert.equal(first.cache.status, 'downloaded');
    assert.equal(
      (await (await import('./probeIos.mjs')).validateGhosttyKitArtifact({
        artifactPath: destinationPath,
        expectedSha256: expandedSha256,
      })).status,
      'ok',
    );

    const second = await materializeNativeBuildInputs({
      platform: 'ios',
      packageRoot: noticeRoot,
      cacheRoot,
      destinationPath,
      policy,
      fetchImpl: async () => assert.fail('Expected a verified archive-cache hit without another download.'),
    });
    assert.equal(second.cache.status, 'hit');

    await writeFile(first.cache.path, 'corrupt archive cache');
    await assert.rejects(
      () => materializeNativeBuildInputs({
        platform: 'ios',
        packageRoot: noticeRoot,
        cacheRoot,
        destinationPath,
        policy,
        fetchImpl: async () => new Response('still corrupt', { status: 200 }),
      }),
      /checksum/i,
    );

    assert.equal(
      (await (await import('./probeIos.mjs')).validateGhosttyKitArtifact({
        artifactPath: destinationPath,
        expectedSha256: expandedSha256,
      })).status,
      'ok',
      'A failed cache refresh must leave the last verified GhosttyKit destination in place.',
    );
  } finally {
    await rm(cacheRoot, { force: true, recursive: true });
    await rm(noticeRoot, { force: true, recursive: true });
    await rm(dirname(destinationPath), { force: true, recursive: true });
    await rm(dirname(artifactPath), { force: true, recursive: true });
  }
});

async function createGhosttyKitFixture({ header }) {
  const root = await mkdtempPath();
  const artifactPath = join(root, 'GhosttyKit.xcframework');
  await mkdir(artifactPath, { recursive: true });
  await writeFile(join(artifactPath, 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>AvailableLibraries</key><array>',
    '<dict>',
    '<key>LibraryIdentifier</key><string>ios-arm64</string>',
    '<key>LibraryPath</key><string>libghostty.a</string>',
    '<key>HeadersPath</key><string>Headers</string>',
    '<key>SupportedPlatform</key><string>ios</string>',
    '</dict>',
    '<dict>',
    '<key>LibraryIdentifier</key><string>ios-arm64_x86_64-simulator</string>',
    '<key>LibraryPath</key><string>libghostty.a</string>',
    '<key>HeadersPath</key><string>Headers</string>',
    '<key>SupportedPlatform</key><string>ios</string>',
    '<key>SupportedPlatformVariant</key><string>simulator</string>',
    '</dict>',
    '</array>',
    '</dict></plist>',
  ].join('\n'));

  for (const slice of ['ios-arm64', 'ios-arm64_x86_64-simulator']) {
    const headersPath = join(artifactPath, slice, 'Headers');
    await mkdir(headersPath, { recursive: true });
    await writeFile(join(artifactPath, slice, 'libghostty.a'), 'not-a-real-archive-but-present');
    await writeFile(join(headersPath, 'ghostty.h'), header);
    await writeFile(join(headersPath, 'module.modulemap'), 'module libghostty { header "ghostty.h" export * }');
  }

  return artifactPath;
}

async function zipGhosttyKitFixture(artifactPath) {
  const root = dirname(artifactPath);
  const zipPath = join(root, 'GhosttyKit.xcframework.zip');
  const entries = await collectZipFixtureEntries(artifactPath, 'GhosttyKit.xcframework');
  await writeFile(zipPath, createStoredZip(entries));
  return zipPath;
}

async function collectZipFixtureEntries(path, archivePath) {
  const entries = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childPath = join(path, entry.name);
    const childArchivePath = `${archivePath}/${entry.name}`;
    if (entry.isDirectory()) {
      entries.push(...await collectZipFixtureEntries(childPath, childArchivePath));
    } else if (entry.isFile()) {
      entries.push({ name: childArchivePath, data: await readFile(childPath) });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

// Stored ZIP fixtures avoid a host `zip` prerequisite while exercising the real unzip/validation path.
function createStoredZip(entries) {
  const localEntries = [];
  const centralEntries = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const checksum = crc32(entry.data);
    const local = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length),
      uint16(name.length), uint16(0), name, entry.data,
    ]);
    localEntries.push(local);
    centralEntries.push(Buffer.concat([
      uint32(0x02014b50), uint16(0x031e), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length),
      uint16(name.length), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32((0o100644 << 16) >>> 0), uint32(offset), name,
    ]));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralEntries);
  return Buffer.concat([
    ...localEntries,
    centralDirectory,
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralDirectory.length), uint32(offset), uint16(0),
  ]);
}

async function createTermuxSourceFixture({ modules }) {
  const root = await mkdtempPath();
  await writeFile(join(root, 'LICENSE.md'), 'Termux GPL root with Apache terminal exceptions.');
  for (const moduleName of modules) {
    if (moduleName === 'terminal-view') {
      await mkdir(join(root, moduleName, 'src', 'main', 'java', 'com', 'termux', 'view'), { recursive: true });
      await mkdir(join(root, moduleName, 'src', 'main', 'res', 'values'), { recursive: true });
      await writeFile(join(root, moduleName, 'src', 'main', 'java', 'com', 'termux', 'view', 'TerminalView.java'), [
        'package com.termux.view;',
        'import com.termux.view.R;',
        'public final class TerminalView {}',
      ].join('\n'));
      await writeFile(join(root, moduleName, 'src', 'main', 'res', 'values', 'strings.xml'), '<resources />');
    } else if (moduleName === 'terminal-emulator') {
      await mkdir(join(root, moduleName, 'src', 'main', 'java', 'com', 'termux', 'terminal'), { recursive: true });
      await writeFile(join(root, moduleName, 'src', 'main', 'java', 'com', 'termux', 'terminal', 'TerminalEmulator.java'), [
        'package com.termux.terminal;',
        'public final class TerminalEmulator {}',
      ].join('\n'));
      await writeFile(join(root, moduleName, 'src', 'main', 'java', 'com', 'termux', 'terminal', 'TerminalOutput.java'), [
        'package com.termux.terminal;',
        'public abstract class TerminalOutput {}',
      ].join('\n'));
    } else {
      await mkdir(join(root, moduleName), { recursive: true });
      await writeFile(join(root, moduleName, 'README.md'), moduleName);
    }
  }
  return root;
}

async function createNativeLicenseFixture() {
  const root = await mkdtempPath();
  const policyText = await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8');
  const packageJsonText = await readFile(join(packageRoot, 'package.json'), 'utf-8');
  const vendorRoot = join(root, 'ios', 'Vendor');

  await mkdir(join(vendorRoot, 'GhosttyKit.xcframework'), { recursive: true });
  await mkdir(join(root, 'android', 'termux'), { recursive: true });
  await writeFile(join(root, 'native-renderers.json'), policyText);
  await writeFile(join(root, 'package.json'), packageJsonText);
  await writeFile(join(vendorRoot, 'LICENSE-libghostty-spm.txt'), [
    'MIT License',
    '',
    'Copyright (c) 2026 @Lakr233',
  ].join('\n'));
  await writeFile(join(vendorRoot, 'NOTICE.md'), [
    'libghostty-spm',
    'storage.1.2.4',
    'https://github.com/Lakr233/libghostty-spm/releases/download/storage.1.2.4/GhosttyKit.xcframework.zip',
    'f1484a5411559bf4a5b665b82a5bb91cb8a3ca2065467dc15202fb191d7a5c9d',
    'f59c864108a9ef3002f6dcaaa00f87e5b56ce4966fb6c90d5ad744cc7aef37c7',
    'c069f05e0a4ef50143e943e954ed75e52e947009',
    'MIT',
    'ios/Vendor/LICENSE-libghostty-spm.txt',
    'https://raw.githubusercontent.com/Lakr233/libghostty-spm/c069f05e0a4ef50143e943e954ed75e52e947009/LICENSE',
  ].join('\n'));
  await writeFile(join(root, 'android', 'termux', 'NOTICE.md'), 'Terminal Emulator for Android notice.');
  return root;
}

function asyncFunctionDefinition(source, name) {
  const marker = `AsyncFunction("${name}")`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected AsyncFunction ${name}`);
  const next = source.indexOf('AsyncFunction(', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function kotlinFunctionBody(source, name) {
  const marker = `fun ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected Kotlin function ${name}`);
  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `expected body for Kotlin function ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }

  assert.fail(`expected closing brace for Kotlin function ${name}`);
}

async function pathExists(path) {
  const { access } = await import('node:fs/promises');
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function typecheckIosSwift(files, { defines = [], includePaths = [], warningsAsErrors = false } = {}) {
  await execFileAsync('xcrun', [
    '--sdk',
    'iphonesimulator',
    'swiftc',
    '-typecheck',
    '-parse-as-library',
    '-target',
    'x86_64-apple-ios15.1-simulator',
    ...(warningsAsErrors ? ['-warnings-as-errors'] : []),
    ...defines.flatMap((define) => ['-D', define]),
    ...includePaths.flatMap((includePath) => ['-I', includePath]),
    ...files,
  ], { cwd: packageRoot });
}

async function runGhosttyRuntimeDiagnostic({ defines = [] } = {}) {
  const root = await mkdtempPath();
  const mainPath = join(root, 'main.swift');
  const binaryPath = join(root, 'diagnostic');
  await writeFile(mainPath, [
    'import Foundation',
    'let diagnostic = makeGhosttyRuntimeDiagnostic()',
    'let payload: [String: String] = [',
    '  "state": diagnostic.state.rawValue,',
    '  "reason": diagnostic.reason,',
    '  "detail": diagnostic.detail,',
    ']',
    'let data = try JSONSerialization.data(withJSONObject: payload, options: [])',
    'FileHandle.standardOutput.write(data)',
  ].join('\n'));

  try {
    await execFileAsync('swiftc', [
      ...defines.flatMap((define) => ['-D', define]),
      join(packageRoot, 'ios/GhosttyRuntime.swift'),
      mainPath,
      '-o',
      binaryPath,
    ], { cwd: packageRoot });
    const { stdout } = await execFileAsync(binaryPath, [], { cwd: packageRoot });
    return JSON.parse(stdout);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function mkdtempPath() {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'happier-terminal-native-'));
}
