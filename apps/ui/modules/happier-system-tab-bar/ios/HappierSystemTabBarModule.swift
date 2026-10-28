import ExpoModulesCore
import UIKit

struct SystemTabItem: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var sfSymbol: String = ""
  @Field var badge: String?
  @Field var accessibilityLabel: String?
  @Field var action: Bool = false
}

public final class HappierSystemTabBarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierSystemTabBar")
    View(HappierSystemTabBarView.self) {
      Events("onTabPress")
      Prop("items") { (view: HappierSystemTabBarView, items: [SystemTabItem]) in view.items = items; view.reconcile() }
      Prop("selectedId") { (view: HappierSystemTabBarView, id: String) in view.selectedId = id; view.reconcile() }
      Prop("hidden") { (view: HappierSystemTabBarView, hidden: Bool) in view.barHidden = hidden; view.reconcile() }
      Prop("tintColor") { (view: HappierSystemTabBarView, color: UIColor) in view.accent = color; view.reconcile() }
    }
  }
}

/// UIKit presents the tabs; every press is vetoed until JS acknowledges selection.
/// The retained React root is moved, never recreated. Empty tab controllers own no app navigation.
final class HappierSystemTabBarView: ExpoView, UITabBarControllerDelegate {
  let onTabPress = EventDispatcher()
  var items: [SystemTabItem] = []
  var selectedId = ""
  var barHidden = false
  var accent: UIColor?
  // UIKit owns these through the window/containment tree. Strong references here would cycle
  // through the React root back to this mounted view, preventing scene teardown.
  private weak var controller: UITabBarController?
  private weak var content: UIViewController?
  private weak var hostWindow: UIWindow?
  private var changingHierarchy = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // A fullscreen native presentation can temporarily remove the presenting tree from its
    // window. That is not a React unmount and must not replace the modal's window root.
    if window != nil { reconcile() }
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    if newSuperview == nil { deactivate() }
    super.willMove(toSuperview: newSuperview)
  }

  private var supportsRail: Bool {
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) { return true }
    #endif
    return false
  }

  func reconcile() {
    guard #available(iOS 18.0, *), supportsRail, !changingHierarchy,
          let window, !items.isEmpty,
          items.contains(where: { $0.id == selectedId && !$0.action }) else { return }
    changingHierarchy = true
    defer { changingHierarchy = false }

    if controller == nil {
      guard let root = window.rootViewController else { return }
      let focused = firstResponder(in: window)
      let tabs = UITabBarController()
      tabs.delegate = self
      content = root
      hostWindow = window
      controller = tabs
      updateItems(tabs)
      window.rootViewController = tabs
      attachContent(tabs, in: window)
      if focused?.isFirstResponder == false { focused?.becomeFirstResponder() }
    } else if let controller {
      // Scene reconnection can move the retained controller into a new window.
      hostWindow = window
      updateItems(controller)
      attachContent(controller, in: window)
    }
    controller?.view.tintColor = accent
    controller?.setTabBarHidden(barHidden, animated: false)
  }

  @available(iOS 18.0, *)
  private func updateItems(_ tabs: UITabBarController) {
    let previous = Dictionary(uniqueKeysWithValues: tabs.tabs.map { ($0.identifier, $0) })
    let next = items.map { item in
      let tab = previous[item.id] ?? UITab(title: item.title, image: nil, identifier: item.id) { _ in RailContentHost() }
      tab.title = item.title
      tab.image = UIImage(systemName: item.sfSymbol)
      tab.badgeValue = item.badge
      tab.accessibilityLabel = item.accessibilityLabel ?? item.title
      tab.preferredPlacement = item.action ? .pinned : .fixed
      tab.allowsHiding = false
      return tab
    }
    if tabs.tabs.map(\.identifier) != next.map(\.identifier) { tabs.setTabs(next, animated: false) }
  }

  @available(iOS 18.0, *)
  private func attachContent(_ tabs: UITabBarController, in window: UIWindow) {
    guard let content,
          let selected = tabs.tabs.first(where: { $0.identifier == selectedId }),
          let host = selected.viewController else { return }
    if content.parent !== host {
      let focused = firstResponder(in: window)
      content.willMove(toParent: nil)
      content.view.removeFromSuperview()
      content.removeFromParent()
      tabs.selectedTab = selected
      host.addChild(content)
      content.view.frame = host.view.bounds
      host.view.addSubview(content.view)
      content.didMove(toParent: host)
      window.layoutIfNeeded()
      if focused?.isFirstResponder == false { focused?.becomeFirstResponder() }
    }
  }

  private func deactivate() {
    guard !changingHierarchy, let controller else { return }
    changingHierarchy = true
    defer { changingHierarchy = false }
    if let window = hostWindow, window.rootViewController === controller, let content {
      let focused = firstResponder(in: window)
      content.willMove(toParent: nil)
      content.view.removeFromSuperview()
      content.removeFromParent()
      window.rootViewController = content
      window.layoutIfNeeded()
      if focused?.isFirstResponder == false { focused?.becomeFirstResponder() }
    }
    self.controller = nil
    content = nil
    hostWindow = nil
  }

  private func firstResponder(in view: UIView) -> UIResponder? {
    if view.isFirstResponder { return view }
    for child in view.subviews {
      if let responder = firstResponder(in: child) { return responder }
    }
    return nil
  }

  @available(iOS 18.0, *)
  func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
    onTabPress(["id": tab.identifier])
    return false
  }
}

private final class RailContentHost: UIViewController {
  override var childForStatusBarStyle: UIViewController? { children.first }
  override var childForStatusBarHidden: UIViewController? { children.first }
  override var childForHomeIndicatorAutoHidden: UIViewController? { children.first }
  override var childForScreenEdgesDeferringSystemGestures: UIViewController? { children.first }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    children.first?.view.frame = view.bounds
  }
}
