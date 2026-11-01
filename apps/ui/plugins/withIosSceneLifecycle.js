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
const finishLaunch = '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)';
const sceneStartup = `    // UIKit delivers the window and cold-start links when the scene connects.
#if DEBUG
    launchOptionsForScene = launchOptions ?? [:]
#endif`;
const sceneFinishLaunch = `#if DEBUG
    // Expo 54's debug-only dev-launcher subscriber needs the scene's window and
    // prepared React delegate before autoSetupStart. Release/headless startup
    // still notifies subscribers here, including notification background launches.
    needsSceneLaunch = true
    return true
#else
    // UIKit reports .background here even for user cold launches. Bootstrap once
    // without a window; a scene attaches this controller if one is requested.
    // This also serves notification actions that never create a scene.
    factory.startReactNative(withModuleName: "main", in: nil, launchOptions: launchOptions)
${finishLaunch}
#endif`;
const sceneProperties = `#if DEBUG
  var launchOptionsForScene: [UIApplication.LaunchOptionsKey: Any] = [:]
  private var needsSceneLaunch = false
#endif`;
const sceneFinishMethod = `  func finishLaunchingFromScene() {
#if DEBUG
    guard needsSceneLaunch else { return }
    needsSceneLaunch = false
    _ = super.application(UIApplication.shared, didFinishLaunchingWithOptions: launchOptionsForScene)
    launchOptionsForScene = [:]
#endif
  }

`;

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
    throw new Error('Unrecognized Expo 54 native template; refusing a partial UIScene migration');
  }
  return contents.replace(anchor, replacement);
}

function applyAppDelegate(contents) {
  if (contents.includes('// BEGIN happier-scene-delegate')) {
    if (!contents.endsWith(`${sceneDelegate}\n`) || !contents.includes(sceneStartup) ||
        !contents.includes(sceneProperties) || !contents.includes(sceneFinishLaunch) ||
        !contents.includes(sceneFinishMethod) || !contents.includes(sceneReactDelegate) || contents.includes(legacyStartup)) {
      throw new Error('Incomplete AppDelegate UIScene migration');
    }
    return contents;
  }
  // Keep URL/activity overrides and ReactNativeDelegate customizations byte-for-byte.
  if (!contents.includes('public class AppDelegate: ExpoAppDelegate {') ||
      !contents.includes('    bindReactNativeFactory(factory)')) {
    throw new Error('Unrecognized Expo 54 AppDelegate factory');
  }
  let next = replaceOnce(contents, legacyStartup, sceneStartup);
  next = replaceOnce(next, finishLaunch, sceneFinishLaunch);
  next = replaceOnce(next, '  var window: UIWindow?\n', `  var window: UIWindow?\n${sceneProperties}\n`);
  next = replaceOnce(next, '  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?', '  var reactNativeDelegate: ReactNativeDelegate?');
  next = replaceOnce(next, '  // Linking API\n', `${sceneFinishMethod}  // Linking API\n`);
  next = replaceOnce(next, 'class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {\n', sceneReactDelegate);
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

// Config mods are a stack. Postprocess the previous mods so this migration sees
// the final delegate produced by Sentry, Expo and the other app plugins.
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
    if (result.language !== 'swift') throw new Error('UIScene requires the Expo 54 Swift AppDelegate');
    return { ...result, contents: applyAppDelegate(result.contents) };
  });
  return afterMods(config, 'infoPlist', applySceneManifest);
}

module.exports = Object.assign(withIosSceneLifecycle, { applyAppDelegate, applySceneManifest });
