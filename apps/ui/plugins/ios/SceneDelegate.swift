// BEGIN happier-scene-delegate
// Expo 55 bridge. AppDelegate remains the sole subscriber/link dispatcher.
// Compiled beside it to avoid a competing Xcode source-file list.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate {
    guard let delegate = UIApplication.shared.delegate as? AppDelegate else {
      fatalError("UIScene requires Happier's Expo AppDelegate")
    }
    return delegate
  }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    // Reconnects may follow an OTA controller replacement; prefer the current root.
    let existingController = appDelegate.window?.rootViewController ?? appDelegate.reactNativeDelegate?.takeRootViewControllerForScene()
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    if let existingController {
      window.rootViewController = existingController
      window.makeKeyAndVisible()
    } else {
#if DEBUG
      guard let factory = appDelegate.reactNativeFactory else {
        fatalError("AppDelegate must prepare the factory before connecting a scene")
      }
      var launchOptions = appDelegate.launchOptionsForScene
      appDelegate.launchOptionsForScene = [:]
      // RN 0.83's getInitialURL still reads these legacy launch-option keys.
      if let url = connectionOptions.urlContexts.first?.url {
        launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
      }
      if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) {
        launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
          "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
          "UIApplicationLaunchOptionsUserActivityKey": activity
        ]
      }
      factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
#else
      fatalError("Release bootstrap must provide its root controller before a scene connects")
#endif
    }

    // ExpoLinkingRegistry caches cold links as well as emitting them, so forwarding
    // works whether JavaScript subscribes before or after this scene connects.
    forwardURLs(connectionOptions.urlContexts)
    for activity in connectionOptions.userActivities {
      _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    forwardURLs(contexts)
  }

  private func forwardURLs(_ contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      if let source = context.options.sourceApplication { options[.sourceApplication] = source }
      if let annotation = context.options.annotation { options[.annotation] = annotation }
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue activity: NSUserActivity) {
    _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate.applicationWillResignActive(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate.applicationDidEnterBackground(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate.applicationWillEnterForeground(UIApplication.shared)
  }
}
