import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('iOS Ghostty re-announces readiness after JavaScript installs native event listeners', async () => {
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
    join(packageRoot, 'ios/GhosttySelection.swift'),
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

test('iOS Ghostty distinguishes initial surface readiness from later terminal resize events', async () => {
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');

  assert.match(surfaceBridgeSource, /let isInitialSize = lastPixelSize == \.zero/);
  assert.match(
    surfaceBridgeSource,
    /if isInitialSize \{\s*emitSurfaceReady\(\)\s*\} else \{\s*emitResize\(cols: Int\(size\.columns\), rows: Int\(size\.rows\)\)\s*\}/,
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
    /private func drawIfVisible\(_ surface: ghostty_surface_t\)\s*\{\s*guard isVisible else \{ return \}\s*ghostty_surface_draw\(surface\)/,
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

  assert.match(surfaceViewSource, /final class GhosttySurfaceView: UIView, UITextInput, UITextInputTraits/);
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
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');
  const accessibilitySource = await readFile(join(packageRoot, 'ios/GhosttyAccessibility.swift'), 'utf-8');

  assert.match(surfaceViewSource, /func updateNativeAccessibilitySummary\(_ summary: String\)/);
  assert.match(surfaceViewSource, /@objc func accessibilityFocusTerminalAction\(\) -> Bool/);
  assert.match(surfaceViewSource, /@objc func accessibilityCopySelectionAction\(\) -> Bool/);
  assert.match(surfaceBridgeSource, /private func refreshAccessibilitySummary\(\)/);
  assert.match(surfaceBridgeSource, /ghostty_surface_read_text\(surface, selection, &output\)/);
  assert.match(surfaceBridgeSource, /GHOSTTY_POINT_VIEWPORT/);
  assert.match(surfaceBridgeSource, /updateNativeAccessibilitySummary\(makeGhosttyAccessibilitySummary/);
  assert.match(accessibilitySource, /func makeGhosttyAccessibilitySummary\(_ value: String/);
  assert.match(accessibilitySource, /UIAccessibilityCustomAction\([\s\S]*name: "Focus terminal"/);
  assert.match(accessibilitySource, /UIAccessibilityCustomAction\([\s\S]*name: "Copy selection"/);
});

test('Android Termux bridge enforces hard gates before creating or driving sessions', async () => {
  const bridgeSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxBridge.kt'), 'utf-8');
  const remoteSessionSource = await readFile(join(packageRoot, 'android/src/main/java/dev/happier/terminal/TermuxRemoteSession.kt'), 'utf-8');

  assert.match(bridgeSource, /private fun unavailableDiagnostic\(\): TermuxBridgeDiagnostic\?/);
  assert.match(bridgeSource, /fun createSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return it \}/);
  assert.match(bridgeSource, /fun writeBytes[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun sendInputBytes[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun sendTextInput[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun resizeSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return rejectUnavailable\(it\)\.toMap\(\) \}/);
  assert.match(bridgeSource, /fun focusSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return \}/);
  assert.match(bridgeSource, /fun drawSurface[\s\S]*unavailableDiagnostic\(\)\?\.let \{ return \}/);
  assert.match(remoteSessionSource, /val diagnostic = makeTermuxBridgeDiagnostic\(\)[\s\S]*if \(!diagnostic\.available\)/);
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
    },
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, 'blocked');
  assert.equal(payload.platform, 'ios');
  assert.equal(payload.renderer, 'ios-ghosttykit');
  assert.equal(payload.fallbackRenderer, 'xterm-webview');
  assert.equal(payload.fallbackRequired, true);
  assert.ok(payload.requiredGates.includes('checksum-pinned-artifact'));
  assert.ok(payload.remediation.includes('Provide a pinned/checksummed libghostty-spm GhosttyKit.xcframework or trigger the direct Ghostty build escape hatch.'));
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

  try {
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_ARTIFACT_PATH: artifactPath,
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

  try {
    const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/probeIos.mjs')], {
      env: {
        ...process.env,
        HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_ARTIFACT_PATH: artifactPath,
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
  assert.ok(payload.interaction.remainingGaps.includes('custom-accessibility'));
  assert.ok(payload.interaction.requiresDeviceQa.includes('ime-keyboard-and-mouse-smoke'));
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

test('license notice reports Android Termux module scope without approving the full app', async () => {
  const { stdout } = await execFileAsync(process.execPath, [join(packageRoot, 'scripts/licenseNotice.mjs')]);
  const payload = JSON.parse(stdout);

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
});

test('iOS GhosttyKit XCFramework is ignored and not package-included before proof-gated acceptance', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));

  assert.equal(packageJson.files.includes('ios/Vendor'), false);
  assert.ok(packageJson.files.includes('ios/Vendor/README.md'));

  const { stdout } = await execFileAsync('git', [
    'check-ignore',
    '-v',
    join(packageRoot, 'ios/Vendor/GhosttyKit.xcframework'),
  ]);
  assert.match(stdout, /ios\/Vendor\/GhosttyKit\.xcframework/);
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

  assert.match(bridgeSource, /private val focusRequesters = ConcurrentHashMap<String, \(\) -> Unit>\(\)/);
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
    policy.iosGhostty.upstream.observedCommit,
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
  await execFileAsync('zip', ['-qry', zipPath, 'GhosttyKit.xcframework'], { cwd: root });
  return zipPath;
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
