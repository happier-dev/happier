const { withBaseMod } = require('@expo/config-plugins');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const sceneDelegate = readFileSync(join(__dirname, 'ios', 'SceneDelegate.swift'), 'utf8').trimEnd();
const legacyStartup = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;
const sceneStartup = `#if os(iOS) || os(tvOS)
#if DEBUG
    // Dev-launcher completion needs its root view attached to a scene window.
    launchOptionsForScene = launchOptions ?? [:]
#else
    // Start once even when a background notification action never requests a scene.
    // UIKit reports .background here for ordinary user launches too; do not infer
    // launch intent from applicationState. A scene attaches the retained controller.
    factory.startReactNative(withModuleName: "main", in: nil, launchOptions: launchOptions)
#endif
#endif`;
const sceneProperties = `#if DEBUG
  var launchOptionsForScene: [UIApplication.LaunchOptionsKey: Any] = [:]
#endif`;
const sceneReactDelegate = `class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  private(set) var rootViewControllerForScene: UIViewController?

  override func createRootViewController() -> UIViewController {
    let controller = super.createRootViewController()
    if (UIApplication.shared.delegate as? AppDelegate)?.window == nil {
      rootViewControllerForScene = controller
    }
    return controller
  }

  func takeRootViewControllerForScene() -> UIViewController? {
    defer { rootViewControllerForScene = nil }
    return rootViewControllerForScene
  }
`;

function replaceOnce(contents, anchor, replacement) {
  if (contents.split(anchor).length !== 2) {
    throw new Error('Unrecognized Expo 55 native template; refusing a partial UIScene migration');
  }
  return contents.replace(anchor, replacement);
}

function applyAppDelegate(contents) {
  if (contents.includes('// BEGIN happier-scene-delegate')) {
    if (!contents.endsWith(`${sceneDelegate}\n`) || !contents.includes(sceneStartup) ||
        !contents.includes(sceneReactDelegate) || !contents.includes(sceneProperties) || contents.includes(legacyStartup)) {
      throw new Error('Incomplete AppDelegate UIScene migration');
    }
    return contents;
  }
  if (!contents.includes('class AppDelegate: ExpoAppDelegate {') ||
      !contents.includes('    reactNativeFactory = factory')) {
    throw new Error('Unrecognized Expo 55 AppDelegate factory');
  }
  let next = replaceOnce(contents, legacyStartup, sceneStartup);
  next = replaceOnce(next, '  var window: UIWindow?\n', `  var window: UIWindow?\n${sceneProperties}\n`);
  next = replaceOnce(next, '  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?', '  var reactNativeDelegate: ReactNativeDelegate?');
  next = replaceOnce(next, 'class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {\n', sceneReactDelegate);
  // Preserve Expo 55's subscriber, URL/activity overrides and bundle-URL owner.
  return `${next.trimEnd()}\n\n${sceneDelegate}\n`;
}

function applySceneManifest(infoPlist) {
  const manifest = {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [{
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      }],
    },
  };
  if (infoPlist.UIApplicationSceneManifest && !isDeepStrictEqual(infoPlist.UIApplicationSceneManifest, manifest)) {
    throw new Error('Conflicting UIApplicationSceneManifest; refusing to replace another scene owner');
  }
  return { ...infoPlist, UIApplicationSceneManifest: manifest };
}

function afterMods(config, mod, transform) {
  return withBaseMod(config, {
    platform: 'ios',
    mod,
    async action(config) {
      const result = await config.modRequest.nextMod(config);
      result.modResults = transform(result.modResults);
      return result;
    },
  });
}

function withIosSceneLifecycle(config) {
  config = afterMods(config, 'appDelegate', (result) => {
    if (result.language !== 'swift') throw new Error('UIScene requires the Expo 55 Swift AppDelegate');
    return { ...result, contents: applyAppDelegate(result.contents) };
  });
  return afterMods(config, 'infoPlist', applySceneManifest);
}

module.exports = withIosSceneLifecycle;
