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
    artifact.expandedSha256,
    'f59c864108a9ef3002f6dcaaa00f87e5b56ce4966fb6c90d5ad744cc7aef37c7',
  );
  assert.notEqual(artifact.upstreamZipSha256, artifact.expandedSha256);
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

test('iOS Ghostty hardware keyboard presses route through ghostty_surface_key', async () => {
  const surfaceViewSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceView.swift'), 'utf-8');
  const surfaceBridgeSource = await readFile(join(packageRoot, 'ios/GhosttySurfaceBridge.swift'), 'utf-8');
  const inputSource = await readFile(join(packageRoot, 'ios/GhosttyInput.swift'), 'utf-8');

  assert.match(surfaceViewSource, /override func pressesBegan\(_ presses: Set<UIPress>, with event: UIPressesEvent\?\)/);
  assert.match(surfaceViewSource, /handlePresses\(presses, action: GHOSTTY_ACTION_PRESS/);
  assert.match(surfaceViewSource, /override func pressesEnded\(_ presses: Set<UIPress>, with event: UIPressesEvent\?\)/);
  assert.match(surfaceViewSource, /handlePresses\(presses, action: GHOSTTY_ACTION_RELEASE/);
  assert.match(surfaceBridgeSource, /func handlePress\(_ press: UIPress, action: ghostty_input_action_e\) -> Bool/);
  assert.match(surfaceBridgeSource, /ghostty_surface_key\(surface, key\)/);
  assert.match(inputSource, /func withGhosttyInputKey/);
  assert.match(inputSource, /GHOSTTY_KEY_ARROW_UP/);
  assert.match(inputSource, /GHOSTTY_KEY_ESCAPE/);
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
  assert.ok(payload.interaction.remainingGaps.includes('selection-handles'));
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
    assert.ok(payload.remediation.includes('Use terminalRendererPreference=native-experimental to opt into Android native while the custom accessibility model is still fallback-required.'));
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

test('Android Termux source verifier accepts only terminal-view and terminal-emulator modules', async () => {
  const { validateTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
  const root = await createTermuxSourceFixture({
    modules: ['terminal-view', 'terminal-emulator'],
  });

  try {
    const result = await validateTermuxAndroidSource({ sourceRoot: root });

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.modules.map((entry) => entry.name).sort(), ['terminal-emulator', 'terminal-view']);
    assert.deepEqual(result.forbiddenPresent, []);
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
  const { installTermuxAndroidSource } = await import('./termuxAndroidSource.mjs');
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
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(vendorRoot, { force: true, recursive: true });
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

async function typecheckIosSwift(files, { defines = [], includePaths = [] } = {}) {
  await execFileAsync('xcrun', [
    '--sdk',
    'iphonesimulator',
    'swiftc',
    '-typecheck',
    '-parse-as-library',
    '-target',
    'x86_64-apple-ios15.1-simulator',
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
