import ExpoModulesCore
import UIKit

struct SystemTabItem: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var sfSymbol: String = ""
  @Field var badge: String?
  @Field var accessibilityLabel: String?
  @Field var action: Bool = false
  @Field var disabled: Bool = false
}

public final class HappierSystemTabBarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierSystemTabBar")
    Constants(["isSupported": Self.isSupported])
    View(HappierSystemTabBarView.self) {
      Events("onTabPress", "onSessionNavigate")
      Prop("items") { (view: HappierSystemTabBarView, items: [SystemTabItem]) in view.items = items; view.reconcile() }
      Prop("selectedId") { (view: HappierSystemTabBarView, id: String) in view.selectedId = id; view.reconcile() }
      Prop("hidden") { (view: HappierSystemTabBarView, hidden: Bool) in view.barHidden = hidden; view.reconcile() }
      Prop("showLabels") { (view: HappierSystemTabBarView, show: Bool) in view.showLabels = show; view.reconcile() }
      Prop("tintColor") { (view: HappierSystemTabBarView, color: UIColor) in view.accent = color; view.reconcile() }
      Prop("sessionSwipeEnabled") { (view: HappierSystemTabBarView, enabled: Bool) in view.sessionSwipeEnabled = enabled; view.reconcile() }
      Prop("sessionNavigationLabels") { (view: HappierSystemTabBarView, labels: [String: String]?) in view.sessionNavigationLabels = labels; view.reconcile() }
    }
  }

  fileprivate static var isSupported: Bool {
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) { return true }
    #endif
    return false
  }
}

/// UIKit presents the tabs; every press is vetoed until JS acknowledges selection.
/// The retained React root is moved, never recreated. Empty tab controllers own no app navigation.
final class HappierSystemTabBarView: ExpoView, UITabBarControllerDelegate {
  let onTabPress = EventDispatcher()
  let onSessionNavigate = EventDispatcher()
  var items: [SystemTabItem] = []
  var selectedId = ""
  var barHidden = false
  var showLabels = true
  var accent: UIColor?
  var sessionSwipeEnabled = false
  var sessionNavigationLabels: [String: String]?
  private lazy var sessionNavigation = SystemTabBarSessionNavigation { [weak self] event in
    self?.onSessionNavigate(event)
  }
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

  func reconcile() {
    guard #available(iOS 18.0, *), HappierSystemTabBarModule.isSupported, !changingHierarchy,
          let window, !items.isEmpty else { return }
    // A placement change can remove the selected item as its route hides the bar.
    // Visibility and input must still settle before the next selected item is available.
    defer {
      controller?.setTabBarHidden(barHidden, animated: false)
      if let controller {
        sessionNavigation.update(bar: controller.tabBar, container: controller.view, content: content?.view,
                                 swipeEnabled: sessionSwipeEnabled && !barHidden,
                                 labels: barHidden ? nil : sessionNavigationLabels)
      }
    }
    // JS may select More to host a destination that is no longer pinned.
    guard items.contains(where: { $0.id == selectedId }) else { return }
    changingHierarchy = true
    defer { changingHierarchy = false }

    if controller == nil {
      guard let root = window.rootViewController else { return }
      let focused = firstResponder(in: window)
      let tabs = SystemTabBarController()
      tabs.delegate = self
      tabs.onBarLayout = { [weak self] in self?.sessionNavigation.refreshAccessibilityActions() }
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
  }

  @available(iOS 18.0, *)
  private func updateItems(_ tabs: UITabBarController) {
    let previous = Dictionary(uniqueKeysWithValues: tabs.tabs.map { ($0.identifier, $0) })
    let next = items.map { item in
      let tab = previous[item.id] ?? UITab(title: item.title, image: nil, identifier: item.id) { _ in RailContentHost() }
      tab.title = showLabels ? item.title : ""
      tab.image = UIImage(systemName: item.sfSymbol)
      tab.badgeValue = item.badge
      tab.accessibilityLabel = item.accessibilityLabel ?? item.title
      tab.preferredPlacement = item.action ? .pinned : .fixed
      tab.allowsHiding = false
      if #available(iOS 18.4, *) { tab.isEnabled = !item.disabled }
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
    sessionNavigation.detach()
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

private final class SystemTabBarController: UITabBarController {
  var onBarLayout: (() -> Void)?

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    onBarLayout?()
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

/// Reports native input only. JS owns swipe commitment, Session order and navigation.
private final class SystemTabBarSessionNavigation: NSObject, UIGestureRecognizerDelegate {
  private let emit: ([String: Any]) -> Void
  private weak var bar: UITabBar?
  private weak var container: UIView?
  private weak var content: UIView?
  private let actionViews = NSHashTable<UIView>.weakObjects()
  private var direction = "next"
  private var maxAbsTranslationX: CGFloat = 0
  private var accessibilityActions: [UIAccessibilityCustomAction]?
  private lazy var pan: UIPanGestureRecognizer = {
    let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
    recognizer.delegate = self
    recognizer.maximumNumberOfTouches = 1
    // Taps pass through unchanged; a recognized horizontal pan cancels the tab's press.
    recognizer.delaysTouchesBegan = false
    recognizer.delaysTouchesEnded = false
    return recognizer
  }()

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    super.init()
  }

  func update(bar: UITabBar, container: UIView, content: UIView?, swipeEnabled: Bool, labels: [String: String]?) {
    if self.container !== container {
      detach()
      self.container = container
      // On iOS 27.1 the visible rail buttons are siblings of UITabBar, not its children.
      container.addGestureRecognizer(pan)
    }
    self.bar = bar
    self.content = content
    pan.isEnabled = swipeEnabled
    accessibilityActions = labels.map { labels in
      ["previous", "next"].compactMap { direction in
        guard let label = labels[direction] else { return nil }
        return UIAccessibilityCustomAction(name: label) { [weak self] _ in
          guard let self else { return false }
          self.emit(["direction": direction, "source": "accessibility"])
          return true
        }
      }
    }
    refreshAccessibilityActions()
  }

  func refreshAccessibilityActions() {
    for view in actionViews.allObjects { view.accessibilityCustomActions = nil }
    actionViews.removeAllObjects()
    guard let bar, let container, let accessibilityActions else { return }
    let barFrame = bar.convert(bar.bounds, to: container)
    var pending = [container]
    while let view = pending.popLast() {
      // Only UIKit chrome participates; never walk or decorate the retained React tree.
      if view === content { continue }
      pending.append(contentsOf: view.subviews)
      let frame = view.convert(view.bounds, to: container)
      if view.isAccessibilityElement && barFrame.contains(CGPoint(x: frame.midX, y: frame.midY)) {
        view.accessibilityCustomActions = accessibilityActions
        actionViews.add(view)
      }
    }
  }

  func detach() {
    for view in actionViews.allObjects { view.accessibilityCustomActions = nil }
    actionViews.removeAllObjects()
    container?.removeGestureRecognizer(pan)
    accessibilityActions = nil
    bar = nil
    container = nil
    content = nil
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard let bar else { return false }
    return bar.bounds.contains(touch.location(in: bar))
  }

  // UIKit's rail selection otherwise wins before this pan can begin. Let selection
  // wait for our horizontal pan to fail, preserving ordinary taps and vertical input.
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    return true
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    let velocity = pan.velocity(in: bar)
    return abs(velocity.x) > abs(velocity.y)
  }

  @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
    let translation = recognizer.translation(in: bar)
    switch recognizer.state {
    case .began:
      direction = translation.x > 0 ? "next" : "previous"
      maxAbsTranslationX = abs(translation.x)
    case .changed:
      maxAbsTranslationX = max(maxAbsTranslationX, abs(translation.x))
    case .ended:
      emit(["direction": direction, "source": "swipe", "translationX": translation.x,
            "translationY": translation.y, "velocityX": recognizer.velocity(in: bar).x,
            "maxAbsTranslationX": max(maxAbsTranslationX, abs(translation.x))])
    default:
      break
    }
  }
}
