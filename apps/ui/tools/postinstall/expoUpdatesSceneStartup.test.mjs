import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const handlerPath = 'ios/EXUpdates/ReactDelegateHandler/ExpoUpdatesReactDelegateHandler.swift';

// UIKit and the Expo/RN caller interfaces are external native boundaries. The
// update-completion callback, window lookup and cleanup below come from the SDK
// source, including our patch; none of their decisions are recreated here.
const nativeBoundary = String.raw`
import Foundation
import CoreGraphics
final class UIColor { static let white = UIColor() }
struct UIViewAutoresizing: OptionSet {
  let rawValue: Int
  static let flexibleWidth = Self(rawValue: 1)
  static let flexibleHeight = Self(rawValue: 2)
}
class UIView {
  var frame = CGRect.zero
  var bounds: CGRect { CGRect(origin: .zero, size: frame.size) }
  var backgroundColor: UIColor?
  var autoresizingMask: UIViewAutoresizing = []
  var subviews: [UIView] = []
  weak var superview: UIView?
  func addSubview(_ view: UIView) { view.removeFromSuperview(); subviews.append(view); view.superview = self }
  func removeFromSuperview() { superview?.subviews.removeAll { $0 === self }; superview = nil }
}
final class EXDeferredRCTRootView: UIView {}
final class UIViewController { var view = UIView() }
final class UIWindow {
  var rootViewController: UIViewController?
  var isKeyWindow = false
  func makeKeyAndVisible() { isKeyWindow = true }
}
protocol UIApplicationDelegate: AnyObject { var window: UIWindow? { get } }
final class UIApplication {
  static let shared = UIApplication()
  var windows: [UIWindow] = []
  var delegate: (any UIApplicationDelegate)?
}
protocol ReactNativeFactoryProvider {
  func recreateRootView(withBundleURL: URL?, moduleName: String?, initialProps: [AnyHashable: Any]?, launchOptions: [AnyHashable: Any]?) -> UIView
}
final class FactoryBoundary: NSObject, UIApplicationDelegate, ReactNativeFactoryProvider {
  var window: UIWindow?
  let completedView = UIView()
  var selectedAsset: URL?
  var receivedModule: String?
  var receivedLaunchOptions: [AnyHashable: Any]?
  func recreateRootView(withBundleURL: URL?, moduleName: String?, initialProps: [AnyHashable: Any]?, launchOptions: [AnyHashable: Any]?) -> UIView {
    selectedAsset = withBundleURL; receivedModule = moduleName; receivedLaunchOptions = launchOptions
    return completedView
  }
}
final class ExpoReactDelegate {
  let reactNativeFactory: FactoryBoundary
  init(_ factory: FactoryBoundary) { reactNativeFactory = factory }
  func createRootViewController() -> UIViewController { UIViewController() }
}
protocol AppControllerInterface {}
final class AppController: AppControllerInterface {
  static let sharedInstance = AppController()
  func launchAssetUrl() -> URL? { URL(fileURLWithPath: "/selected-ota/main.jsbundle") }
}
enum UpdatesUtils { static func isUsingCustomInitialization() -> Bool { false } }
func expect(_ condition: @autoclosure () -> Bool, _ message: String) { if !condition() { fatalError(message) } }
`;

const scenarios = String.raw`
let factory = FactoryBoundary()
UIApplication.shared.delegate = factory
let reactDelegate = ExpoReactDelegate(factory)
let deferred = EXDeferredRCTRootView()
deferred.frame = CGRect(x: 0, y: 0, width: 320, height: 640)
let splash = UIView()
deferred.addSubview(splash)
let originalController = UIViewController()
originalController.view = deferred
let handler = HandlerUnderTest(reactDelegate, deferred)
let foreground = CommandLine.arguments.contains("foreground")
if foreground {
  let window = UIWindow()
  window.rootViewController = originalController
  factory.window = window
  UIApplication.shared.windows = [window]
}

handler.appController(AppController.sharedInstance, didStartWithSuccess: true)
expect(factory.selectedAsset == AppController.sharedInstance.launchAssetUrl(), "The completed root must use the selected OTA asset")
expect(factory.receivedModule == "main", "Completion must preserve the root module")
expect(factory.receivedLaunchOptions?["launch"] as? String == "background", "Completion must preserve launch options")
expect(handler.didCleanUp, "Completion must release temporary handler state")

if foreground {
  let window = factory.window!
  expect(window.rootViewController !== originalController, "An existing window must retain Expo's controller replacement")
  expect(window.rootViewController?.view === factory.completedView, "The visible controller must contain the completed root")
  expect(window.isKeyWindow, "The existing window must become visible")
  expect(deferred.subviews.first === splash, "Foreground replacement must not mutate the retired placeholder")
  print("FOREGROUND_UPDATES_REPLACEMENT_PASS")
} else {
  expect(originalController.view === deferred, "Headless completion must preserve the original retained controller")
  expect(deferred.subviews.count == 1 && deferred.subviews.first === factory.completedView, "Headless completion must replace splash content in the original deferred view")
  expect(factory.completedView.frame == deferred.bounds, "The completed root must fill the placeholder")
  expect(factory.completedView.autoresizingMask == [.flexibleWidth, .flexibleHeight], "The completed root must resize when its scene attaches")
  expect(factory.window == nil && UIApplication.shared.windows.isEmpty, "Headless completion must not manufacture a window")
  let sceneWindow = UIWindow()
  sceneWindow.rootViewController = originalController
  sceneWindow.makeKeyAndVisible()
  expect(sceneWindow.rootViewController === originalController, "Scene attachment must reuse the retained controller")
  expect(sceneWindow.rootViewController?.view.subviews.first === factory.completedView, "Scene attachment must preserve the completed root")
  print("HEADLESS_UPDATES_AND_SCENE_ATTACHMENT_PASS")
}
`;

function method(source, declaration) {
  const start = source.indexOf(`  ${declaration}`);
  const end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, `Missing Expo Updates method: ${declaration}`);
  return source.slice(start, end + '\n  }'.length);
}

function swiftProgram(source) {
  const callback = method(source, 'public func appController(').replace('public func', 'func');
  const cleanup = method(source, 'private func cleanup(');
  const window = method(source, 'private func getWindow(');
  // Execute the iOS branch on the macOS Swift host, without copying its logic.
  const methods = [callback, cleanup, window].join('\n').replaceAll('#if os(iOS) || os(tvOS)', '#if true').replaceAll('#if os(macOS)', '#if false');
  return `${nativeBoundary}
final class HandlerUnderTest {
  private weak var reactDelegate: ExpoReactDelegate?
  private var launchOptions: [AnyHashable: Any]? = ["launch": "background"]
  private var deferredRootView: EXDeferredRCTRootView?
  private var rootViewModuleName: String? = "main"
  private var rootViewInitialProperties: [AnyHashable: Any]? = [:]
  init(_ delegate: ExpoReactDelegate, _ view: EXDeferredRCTRootView) { reactDelegate = delegate; deferredRootView = view }
  var didCleanUp: Bool { reactDelegate == nil && launchOptions == nil && deferredRootView == nil && rootViewModuleName == nil && rootViewInitialProperties == nil }
${methods}
}
${scenarios}`;
}

test('Expo Updates completes a headless root for later scene attachment and preserves foreground replacement', (t) => {
  if (process.platform !== 'darwin' || spawnSync('swiftc', ['--version']).status !== 0) {
    t.skip('Requires the configured mac-host Swift compiler');
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-updates-scene-'));
  try {
    const target = path.join(temporary, 'node_modules/expo-updates', handlerPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(uiDir, 'node_modules/expo-updates', handlerPath), target);
    const patch = fs.readFileSync(path.join(uiDir, 'patches/expo-updates+29.0.16.patch'), 'utf8');
    const applyPatch = (args) => spawnSync('patch', ['--batch', ...args, '-p1', '-d', temporary], { input: patch, encoding: 'utf8' });
    const applied = applyPatch(['--forward']);
    if (applied.status !== 0) {
      const reversed = applyPatch(['--reverse', '--dry-run']);
      assert.equal(reversed.status, 0, applied.stdout + applied.stderr);
    }
    const patched = fs.readFileSync(target, 'utf8');
    const reverse = applyPatch(['--reverse']);
    assert.equal(reverse.status, 0, reverse.stdout + reverse.stderr);
    const unpatched = fs.readFileSync(target, 'utf8');
    const run = (source, name, scenario) => {
      const swift = path.join(temporary, `${name}.swift`);
      const binary = path.join(temporary, name);
      fs.writeFileSync(swift, swiftProgram(source));
      const compile = spawnSync('swiftc', ['-swift-version', '5', swift, '-o', binary], { encoding: 'utf8' });
      assert.equal(compile.status, 0, compile.stdout + compile.stderr);
      return spawnSync(binary, [scenario], { encoding: 'utf8' });
    };
    const baseline = run(unpatched, 'baseline', 'headless');
    assert.notEqual(baseline.status, 0, 'Unpatched Expo Updates must reject windowless startup');
    assert.match(baseline.stderr, /Cannot find the current window\./);
    t.diagnostic('Unpatched source failed at its original nil-window fatalError (expected RED)');
    for (const scenario of ['headless', 'foreground']) {
      const result = run(patched, `patched-${scenario}`, scenario);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, scenario === 'headless' ? /HEADLESS_UPDATES_AND_SCENE_ATTACHMENT_PASS/ : /FOREGROUND_UPDATES_REPLACEMENT_PASS/);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
