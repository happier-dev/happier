import UIKit

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
import libghostty
#endif

final class GhosttySurfaceView: UIView, UIKeyInput {
  typealias EventEmitter = (_ eventName: String, _ payload: [String: Any]) -> Void

  private(set) var diagnostic = makeGhosttyRuntimeDiagnostic()
  private let accessibilityModel = GhosttyAccessibilityModel()
  private var bridge: GhosttySurfaceBridge?
  private var eventEmitter: EventEmitter?
  private lazy var scrollGesture: UIPanGestureRecognizer = {
    let gesture = UIPanGestureRecognizer(target: self, action: #selector(handleScrollGesture(_:)))
    gesture.minimumNumberOfTouches = 2
    gesture.cancelsTouchesInView = false
    return gesture
  }()

  var surfaceId: String = "" {
    didSet {
      if oldValue != surfaceId {
        bridge?.dispose()
        bridge = nil
      }
      GhosttySurfaceRegistry.shared.update(view: self, oldSurfaceId: oldValue, newSurfaceId: surfaceId)
      refreshAccessibility()
    }
  }

  var fontSize: Double = 14
  var lineHeightPx: Double = 18

  var accessibilitySummary: String = "" {
    didSet {
      refreshAccessibility()
    }
  }

  var accessibilityAccepted: Bool = false {
    didSet {
      refreshAccessibility()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isOpaque = true
    isMultipleTouchEnabled = true
    addGestureRecognizer(scrollGesture)
    refreshAccessibility()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    backgroundColor = .black
    isOpaque = true
    isMultipleTouchEnabled = true
    addGestureRecognizer(scrollGesture)
    refreshAccessibility()
  }

  deinit {
    GhosttySurfaceRegistry.shared.unregister(view: self)
  }

  func setEventEmitter(_ eventEmitter: EventEmitter?) {
    self.eventEmitter = eventEmitter
  }

  func writeBytes(_ bytes: Data, byteOffset: Int64) -> [String: Any] {
    guard !surfaceId.isEmpty else {
      return [
        "accepted": false,
        "reason": "surface-not-ready",
        "detail": "Native terminal surfaceId is missing.",
      ]
    }

    guard !bytes.isEmpty, byteOffset >= 0 else {
      return [
        "accepted": false,
        "reason": "invalid-ack",
        "detail": "Native terminal write requires non-empty bytes and a non-negative byte offset.",
      ]
    }

    guard diagnostic.isAvailable else {
      return GhosttyRuntime.unavailableWriteResult
    }

    return ensureBridge().write(bytes: bytes, byteOffset: byteOffset, fontSize: fontSize)
  }

  func resize(cols: Int, rows: Int) {
    guard cols > 0, rows > 0, !surfaceId.isEmpty else { return }
    eventEmitter?("resize", [
      "surfaceId": surfaceId,
      "cols": cols,
      "rows": rows,
    ])
  }

  func focusSurface() {
    ensureBridge().setFocused(true)
    becomeFirstResponder()
  }

  func clearSurface() {
    guard diagnostic.isAvailable, !surfaceId.isEmpty else { return }
    let bridge = ensureBridge()
    guard bridge.ensureSurface(fontSize: fontSize) else { return }
    bridge.clear()
  }

  func copySelection() -> [String: Any] {
    if diagnostic.isAvailable {
      return ensureBridge().copySelection()
    }

    return [
      "copied": false,
      "reason": diagnostic.reason,
    ]
  }

  func disposeSurface() {
    bridge?.dispose()
    bridge = nil
    GhosttySurfaceRegistry.shared.unregister(view: self)
    eventEmitter = nil
  }

  func updateNativeAccessibilitySummary(_ summary: String) {
    guard accessibilityAccepted else { return }
    accessibilitySummary = summary
  }

  @objc func accessibilityFocusTerminalAction() -> Bool {
    focusSurface()
    return true
  }

  @objc func accessibilityCopySelectionAction() -> Bool {
    let result = copySelection()
    return result["copied"] as? Bool == true
  }

  override var canBecomeFirstResponder: Bool {
    true
  }

  var hasText: Bool {
    true
  }

  func insertText(_ text: String) {
    guard diagnostic.isAvailable, !surfaceId.isEmpty, !text.isEmpty else { return }
    let bridge = ensureBridge()
    guard bridge.ensureSurface(fontSize: fontSize) else { return }
    _ = bridge.submitText(text)
  }

  func deleteBackward() {
    guard diagnostic.isAvailable, !surfaceId.isEmpty else { return }
    let bridge = ensureBridge()
    guard bridge.ensureSurface(fontSize: fontSize) else { return }
    _ = bridge.deleteBackward()
  }

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if !handlePresses(presses, action: GHOSTTY_ACTION_PRESS) {
      super.pressesBegan(presses, with: event)
    }
  }

  override func pressesChanged(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if !handlePresses(presses, action: GHOSTTY_ACTION_REPEAT) {
      super.pressesChanged(presses, with: event)
    }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if !handlePresses(presses, action: GHOSTTY_ACTION_RELEASE) {
      super.pressesEnded(presses, with: event)
    }
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if !handlePresses(presses, action: GHOSTTY_ACTION_RELEASE) {
      super.pressesCancelled(presses, with: event)
    }
  }
#endif

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    becomeFirstResponder()
    handleTouches(touches)
    super.touchesBegan(touches, with: event)
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    handleTouches(touches)
    super.touchesMoved(touches, with: event)
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    handleTouches(touches)
    super.touchesEnded(touches, with: event)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    handleTouches(touches)
    super.touchesCancelled(touches, with: event)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if diagnostic.isAvailable, !surfaceId.isEmpty {
      _ = ensureBridge().ensureSurface(fontSize: fontSize)
      bridge?.updateSize()
    }
    refreshAccessibility()
  }

  private func ensureBridge() -> GhosttySurfaceBridge {
    if let bridge {
      return bridge
    }

    let next = GhosttySurfaceBridge(
      hostView: self,
      surfaceId: { [weak self] in self?.surfaceId ?? "" },
      eventEmitter: { [weak self] in self?.eventEmitter }
    )
    bridge = next
    return next
  }

  private func handleTouches(_ touches: Set<UITouch>) {
    guard diagnostic.isAvailable, !surfaceId.isEmpty else { return }
    let bridge = ensureBridge()
    guard bridge.ensureSurface(fontSize: fontSize) else { return }
    for touch in touches {
      bridge.handleTouch(touch, phase: touch.phase)
    }
  }

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
  private func handlePresses(_ presses: Set<UIPress>, action: ghostty_input_action_e) -> Bool {
    guard diagnostic.isAvailable, !surfaceId.isEmpty else { return false }
    let bridge = ensureBridge()
    guard bridge.ensureSurface(fontSize: fontSize) else { return false }
    var handled = false
    for press in presses {
      handled = bridge.handlePress(press, action: action) || handled
    }
    return handled
  }
#endif

  @objc private func handleScrollGesture(_ gesture: UIPanGestureRecognizer) {
    guard diagnostic.isAvailable, !surfaceId.isEmpty else { return }
    let translation = gesture.translation(in: self)
    guard translation != .zero else { return }
    let bridge = ensureBridge()
    guard bridge.ensureSurface(fontSize: fontSize) else { return }
    bridge.handleScroll(dx: Double(-translation.x), dy: Double(-translation.y))
    gesture.setTranslation(.zero, in: self)
  }

  private func refreshAccessibility() {
    accessibilityModel.update(
      summary: accessibilitySummary,
      accepted: accessibilityAccepted
    )
    accessibilityModel.apply(to: self)
  }
}

final class GhosttySurfaceRegistry {
  static let shared = GhosttySurfaceRegistry()

  private let lock = NSLock()
  private var surfaces: [String: WeakGhosttySurfaceView] = [:]

  func update(view: GhosttySurfaceView, oldSurfaceId: String, newSurfaceId: String) {
    lock.lock()
    defer { lock.unlock() }

    if !oldSurfaceId.isEmpty {
      surfaces.removeValue(forKey: oldSurfaceId)
    }
    if !newSurfaceId.isEmpty {
      surfaces[newSurfaceId] = WeakGhosttySurfaceView(view)
    }
  }

  func surface(id: String) -> GhosttySurfaceView? {
    lock.lock()
    defer { lock.unlock() }

    guard let weak = surfaces[id] else { return nil }
    guard let view = weak.value else {
      surfaces.removeValue(forKey: id)
      return nil
    }
    return view
  }

  func unregister(view: GhosttySurfaceView) {
    lock.lock()
    defer { lock.unlock() }

    surfaces = surfaces.filter { _, weak in
      weak.value !== view && weak.value != nil
    }
  }
}

private final class WeakGhosttySurfaceView {
  weak var value: GhosttySurfaceView?

  init(_ value: GhosttySurfaceView) {
    self.value = value
  }
}
