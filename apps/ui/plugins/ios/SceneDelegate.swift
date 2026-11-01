// BEGIN happier-scene-delegate
// Expo 54 bridge for UIKit's scene lifecycle. AppDelegate remains the sole
// subscriber/link dispatcher. Compiled beside it to avoid a second Xcode file list.
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
#if DEBUG
    guard let factory = appDelegate.reactNativeFactory else {
      fatalError("AppDelegate must prepare the React Native factory before connecting a scene")
    }
#endif
    let window = UIWindow(windowScene: windowScene)
    // Every Release launch bootstraps without a window. Reconnects may follow an
    // OTA controller replacement, so prefer the current window's controller.
    let existingController = appDelegate.window?.rootViewController ?? appDelegate.reactNativeDelegate?.takeRootViewControllerForScene()
    self.window = window
    appDelegate.window = window

#if DEBUG
    // RN 0.81's getInitialURL reads these legacy keys. Scene URL events alone
    // arrive before JS has subscribed on cold starts (Expo's SDK 57/58 bridge
    // reconstructs the same launch-options contract).
    var launchOptions = appDelegate.launchOptionsForScene
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
    }
    if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
    }
#endif
    if let existingController {
      window.rootViewController = existingController
      window.makeKeyAndVisible()
    } else {
#if DEBUG
      factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
#else
      fatalError("Release bootstrap must provide its root controller before a scene connects")
#endif
    }
    appDelegate.finishLaunchingFromScene()

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
