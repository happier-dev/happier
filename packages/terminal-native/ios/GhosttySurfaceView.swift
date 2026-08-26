import UIKit

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
import libghostty
#endif

final class GhosttySurfaceView: UIView, UITextInput, UITextInputTraits {
  typealias EventEmitter = (_ eventName: String, _ payload: [String: Any]) -> Void

  private(set) var diagnostic = makeGhosttyRuntimeDiagnostic()
  private let accessibilityModel = GhosttyAccessibilityModel()
  private var bridge: GhosttySurfaceBridge?
  private var eventEmitter: EventEmitter?
  private var applicationLifecycleObservers: [NSObjectProtocol] = []
  private var applicationIsActive = UIApplication.shared.applicationState == .active
  private var hardwareKeyHandled = false
  private var markedTextValue: String?
  private var markedTextSelectedRange = NSRange(location: 0, length: 0)
  private var markedTextAttributes: [NSAttributedString.Key: Any]?
  weak var inputDelegate: UITextInputDelegate?
  lazy var tokenizer: UITextInputTokenizer = UITextInputStringTokenizer(textInput: self)
  private lazy var scrollGesture: UIPanGestureRecognizer = {
    let gesture = UIPanGestureRecognizer(target: self, action: #selector(handleScrollGesture(_:)))
    gesture.minimumNumberOfTouches = 2
    gesture.cancelsTouchesInView = false
    return gesture
  }()

  var surfaceId: String = "" {
    didSet {
      if oldValue != surfaceId {
        cancelMarkedText()
        bridge?.dispose()
        bridge = nil
      }
      GhosttySurfaceRegistry.shared.update(view: self, oldSurfaceId: oldValue, newSurfaceId: surfaceId)
      initializeSurfaceIfPossible()
      setNeedsLayout()
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
    observeApplicationLifecycle()
    refreshAccessibility()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    backgroundColor = .black
    isOpaque = true
    isMultipleTouchEnabled = true
    addGestureRecognizer(scrollGesture)
    observeApplicationLifecycle()
    refreshAccessibility()
  }

  deinit {
    cancelMarkedText()
    MainActor.assumeIsolated {
      bridge?.dispose()
      bridge = nil
    }
    applicationLifecycleObservers.forEach { observer in
      NotificationCenter.default.removeObserver(observer)
    }
    GhosttySurfaceRegistry.shared.unregister(view: self)
  }

  func setEventEmitter(_ eventEmitter: EventEmitter?) {
    self.eventEmitter = eventEmitter
  }

  func prepareSurface() -> Bool {
    initializeSurfaceIfPossible()
    return bridge?.announceSurfaceReady() == true
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
    guard diagnostic.isAvailable, !surfaceId.isEmpty else { return }
    _ = ensureBridge()
    _ = becomeFirstResponder()
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
    cancelMarkedText()
    bridge?.dispose()
    bridge = nil
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

  override func becomeFirstResponder() -> Bool {
    let didBecomeFirstResponder = super.becomeFirstResponder()
    if didBecomeFirstResponder {
      bridge?.setFocused(true)
    }
    return didBecomeFirstResponder
  }

  override func resignFirstResponder() -> Bool {
    cancelMarkedText()
    let didResignFirstResponder = super.resignFirstResponder()
    if didResignFirstResponder {
      bridge?.setFocused(false)
    }
    return didResignFirstResponder
  }

  func insertText(_ text: String) {
    guard !hardwareKeyHandled else {
      hardwareKeyHandled = false
      return
    }
    commitText(text)
  }

  func deleteBackward() {
    deleteBackwardFromTextInput()
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
    let handled = handlePresses(presses, action: GHOSTTY_ACTION_RELEASE)
    hardwareKeyHandled = false
    if !handled {
      super.pressesEnded(presses, with: event)
    }
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let handled = handlePresses(presses, action: GHOSTTY_ACTION_RELEASE)
    hardwareKeyHandled = false
    if !handled {
      super.pressesCancelled(presses, with: event)
    }
  }
#endif

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    if diagnostic.isAvailable, !surfaceId.isEmpty {
      _ = ensureBridge()
    }
    _ = becomeFirstResponder()
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
    initializeSurfaceIfPossible()
    refreshAccessibility()
  }

  private func initializeSurfaceIfPossible() {
    guard diagnostic.isAvailable,
          !surfaceId.isEmpty,
          bounds.width > 0,
          bounds.height > 0 else { return }
    guard ensureBridge().ensureSurface(fontSize: fontSize) else { return }
    bridge?.updateSize()
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
    next.setVisible(applicationIsActive)
    bridge = next
    return next
  }

  private func observeApplicationLifecycle() {
    let notificationCenter = NotificationCenter.default
    applicationLifecycleObservers = [
      notificationCenter.addObserver(
        forName: UIApplication.didEnterBackgroundNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
          Task { @MainActor [weak self] in
            guard let self else { return }
            self.applicationIsActive = false
            self.bridge?.setVisible(false)
          }
        },
      notificationCenter.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
          Task { @MainActor [weak self] in
            guard let self else { return }
            self.applicationIsActive = true
            self.bridge?.setVisible(true)
        }
      },
    ]
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
      if action == GHOSTTY_ACTION_PRESS, shouldSuppressUIKeyInput(for: press) {
        hardwareKeyHandled = true
      }
      let pressHandled = bridge.handlePress(
        press,
        action: action,
        composing: markedTextValue != nil
      )
      handled = pressHandled || handled
    }
    return handled
  }

  private func shouldSuppressUIKeyInput(for press: UIPress) -> Bool {
    guard let key = press.key else { return false }
    guard !key.modifierFlags.contains(.command) else { return false }
    guard key.modifierFlags.intersection([.alternate, .control]).isEmpty else { return false }
    return !key.characters.isEmpty || key.keyCode == .keyboardDeleteOrBackspace
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

extension GhosttySurfaceView {
  // The terminal owns its rendered selection. UITextInput only models the active
  // composing buffer so UIKit keyboards can drive Ghostty preedit and commits.
  var hasText: Bool {
    true
  }

  var selectedTextRange: UITextRange? {
    get {
      GhosttyTextRange(range: markedTextSelectedRange)
    }
    set {
      guard let range = newValue as? GhosttyTextRange else { return }
      let nextRange = clampedMarkedRange(range.range)
      guard !NSEqualRanges(nextRange, markedTextSelectedRange) else { return }
      inputDelegate?.selectionWillChange(self)
      markedTextSelectedRange = nextRange
      inputDelegate?.selectionDidChange(self)
    }
  }

  var markedTextRange: UITextRange? {
    guard let markedTextValue else { return nil }
    return GhosttyTextRange(range: NSRange(location: 0, length: (markedTextValue as NSString).length))
  }

  var markedTextStyle: [NSAttributedString.Key: Any]? {
    get { markedTextAttributes }
    set { markedTextAttributes = newValue }
  }

  var beginningOfDocument: UITextPosition {
    GhosttyTextPosition(offset: 0)
  }

  var endOfDocument: UITextPosition {
    GhosttyTextPosition(offset: markedTextLength)
  }

  var autocapitalizationType: UITextAutocapitalizationType {
    get { .none }
    set {}
  }

  var autocorrectionType: UITextAutocorrectionType {
    get { .no }
    set {}
  }

  var spellCheckingType: UITextSpellCheckingType {
    get { .no }
    set {}
  }

  var keyboardType: UIKeyboardType {
    get { .default }
    set {}
  }

  var keyboardAppearance: UIKeyboardAppearance {
    get { .default }
    set {}
  }

  var returnKeyType: UIReturnKeyType {
    get { .default }
    set {}
  }

  var enablesReturnKeyAutomatically: Bool {
    get { false }
    set {}
  }

  var isSecureTextEntry: Bool {
    get { false }
    set {}
  }

  var textContentType: UITextContentType? {
    get { nil }
    set {}
  }

  func text(in range: UITextRange) -> String? {
    guard let markedRange = range as? GhosttyTextRange else { return nil }
    let text = markedTextValue ?? ""
    return (text as NSString).substring(with: clampedMarkedRange(markedRange.range))
  }

  func replace(_ range: UITextRange, withText text: String) {
    guard markedTextValue != nil else {
      commitText(text)
      return
    }
    guard let markedRange = range as? GhosttyTextRange, let bridge = textInputBridge() else { return }

    let current = markedTextValue ?? ""
    let replacementRange = clampedMarkedRange(markedRange.range)
    inputDelegate?.textWillChange(self)
    inputDelegate?.selectionWillChange(self)
    let updated = (current as NSString).replacingCharacters(in: replacementRange, with: text)
    markedTextValue = updated.isEmpty ? nil : updated
    markedTextSelectedRange = NSRange(
      location: replacementRange.location + (text as NSString).length,
      length: 0
    )
    markedTextSelectedRange = clampedMarkedRange(markedTextSelectedRange)
    _ = bridge.setPreedit(updated)
    inputDelegate?.selectionDidChange(self)
    inputDelegate?.textDidChange(self)
  }

  func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    guard let bridge = textInputBridge() else { return }
    let nextText = markedText ?? ""
    inputDelegate?.textWillChange(self)
    inputDelegate?.selectionWillChange(self)
    markedTextValue = nextText.isEmpty ? nil : nextText
    markedTextSelectedRange = clampedMarkedRange(selectedRange, text: nextText)
    _ = bridge.setPreedit(nextText)
    inputDelegate?.selectionDidChange(self)
    inputDelegate?.textDidChange(self)
  }

  func unmarkText() {
    guard let markedText = markedTextValue, let bridge = textInputBridge() else { return }
    inputDelegate?.textWillChange(self)
    inputDelegate?.selectionWillChange(self)
    clearMarkedTextState()
    _ = bridge.setPreedit("")
    if !markedText.isEmpty {
      _ = bridge.submitText(markedText)
    }
    inputDelegate?.selectionDidChange(self)
    inputDelegate?.textDidChange(self)
  }

  func textRange(from fromPosition: UITextPosition, to toPosition: UITextPosition) -> UITextRange? {
    guard let from = fromPosition as? GhosttyTextPosition, let to = toPosition as? GhosttyTextPosition else {
      return nil
    }
    let start = clampedMarkedOffset(from.offset)
    let end = clampedMarkedOffset(to.offset)
    guard start <= end else { return nil }
    return GhosttyTextRange(range: NSRange(location: start, length: end - start))
  }

  func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
    guard let position = position as? GhosttyTextPosition else { return nil }
    return GhosttyTextPosition(offset: clampedMarkedOffset(position.offset + offset))
  }

  func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? {
    let signedOffset: Int
    switch direction {
    case .left, .up:
      signedOffset = -offset
    case .right, .down:
      signedOffset = offset
    @unknown default:
      signedOffset = offset
    }
    return self.position(from: position, offset: signedOffset)
  }

  func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
    guard let lhs = position as? GhosttyTextPosition, let rhs = other as? GhosttyTextPosition else {
      return .orderedSame
    }
    if lhs.offset < rhs.offset { return .orderedAscending }
    if lhs.offset > rhs.offset { return .orderedDescending }
    return .orderedSame
  }

  func offset(from: UITextPosition, to toPosition: UITextPosition) -> Int {
    guard let from = from as? GhosttyTextPosition, let to = toPosition as? GhosttyTextPosition else {
      return 0
    }
    return to.offset - from.offset
  }

  func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? {
    guard let range = range as? GhosttyTextRange else { return nil }
    switch direction {
    case .left, .up:
      return GhosttyTextPosition(offset: clampedMarkedOffset(range.range.location))
    case .right, .down:
      return GhosttyTextPosition(offset: clampedMarkedOffset(NSMaxRange(range.range)))
    @unknown default:
      return GhosttyTextPosition(offset: clampedMarkedOffset(NSMaxRange(range.range)))
    }
  }

  func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? {
    guard let position = position as? GhosttyTextPosition else { return nil }
    let offset = clampedMarkedOffset(position.offset)
    let text = (markedTextValue ?? "") as NSString
    switch direction {
    case .left, .up:
      guard offset > 0 else { return GhosttyTextRange(range: NSRange(location: 0, length: 0)) }
      return GhosttyTextRange(range: text.rangeOfComposedCharacterSequence(at: offset - 1))
    case .right, .down:
      guard offset < text.length else {
        return GhosttyTextRange(range: NSRange(location: text.length, length: 0))
      }
      return GhosttyTextRange(range: text.rangeOfComposedCharacterSequence(at: offset))
    @unknown default:
      return GhosttyTextRange(range: NSRange(location: offset, length: 0))
    }
  }

  func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection {
    .natural
  }

  func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {
    _ = writingDirection
    _ = range
  }

  func firstRect(for range: UITextRange) -> CGRect {
    _ = range
    return textInputRect()
  }

  func caretRect(for position: UITextPosition) -> CGRect {
    _ = position
    return textInputRect()
  }

  func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
    _ = range
    return []
  }

  func closestPosition(to point: CGPoint) -> UITextPosition? {
    guard bounds.insetBy(dx: -1, dy: -1).contains(point) else { return nil }
    return GhosttyTextPosition(offset: markedTextSelectedRange.location)
  }

  func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? {
    guard bounds.insetBy(dx: -1, dy: -1).contains(point), let range = range as? GhosttyTextRange else {
      return nil
    }
    return GhosttyTextPosition(offset: clampedMarkedOffset(range.range.location))
  }

  func characterRange(at point: CGPoint) -> UITextRange? {
    guard closestPosition(to: point) != nil else { return nil }
    return GhosttyTextRange(range: NSRange(location: markedTextSelectedRange.location, length: 0))
  }

  var textInputView: UIView {
    self
  }

  private var markedTextLength: Int {
    (markedTextValue as NSString?)?.length ?? 0
  }

  private func commitText(_ text: String) {
    guard !text.isEmpty, let bridge = textInputBridge() else { return }
    if markedTextValue != nil {
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      clearMarkedTextState()
      _ = bridge.setPreedit("")
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
    }
    _ = bridge.submitText(text)
  }

  private func deleteBackwardFromTextInput() {
    if markedTextValue != nil {
      hardwareKeyHandled = false
    } else if hardwareKeyHandled {
      hardwareKeyHandled = false
      return
    }
    guard let bridge = textInputBridge() else { return }
    guard let markedText = markedTextValue else {
      _ = bridge.deleteBackward()
      return
    }

    let selection = clampedMarkedRange(markedTextSelectedRange, text: markedText)
    let text = markedText as NSString
    let deletionRange: NSRange
    if selection.length > 0 {
      deletionRange = selection
    } else if selection.location > 0 {
      deletionRange = text.rangeOfComposedCharacterSequence(at: selection.location - 1)
    } else {
      return
    }

    inputDelegate?.textWillChange(self)
    inputDelegate?.selectionWillChange(self)
    let updated = text.replacingCharacters(in: deletionRange, with: "")
    markedTextValue = updated.isEmpty ? nil : updated
    markedTextSelectedRange = clampedMarkedRange(
      NSRange(location: deletionRange.location, length: 0),
      text: updated
    )
    _ = bridge.setPreedit(updated)
    inputDelegate?.selectionDidChange(self)
    inputDelegate?.textDidChange(self)
  }

  private func cancelMarkedText() {
    hardwareKeyHandled = false
    guard markedTextValue != nil else { return }
    inputDelegate?.textWillChange(self)
    inputDelegate?.selectionWillChange(self)
    clearMarkedTextState()
    _ = bridge?.setPreedit("")
    inputDelegate?.selectionDidChange(self)
    inputDelegate?.textDidChange(self)
  }

  private func clearMarkedTextState() {
    markedTextValue = nil
    markedTextSelectedRange = NSRange(location: 0, length: 0)
    markedTextAttributes = nil
  }

  private func textInputBridge() -> GhosttySurfaceBridge? {
    guard diagnostic.isAvailable, !surfaceId.isEmpty else { return nil }
    let bridge = ensureBridge()
    guard bridge.ensureSurface(fontSize: fontSize) else { return nil }
    return bridge
  }

  private func textInputRect() -> CGRect {
    let imeRect = bridge?.imeRect() ?? .zero
    if imeRect.width > 0, imeRect.height > 0 {
      return imeRect
    }
    return CGRect(x: bounds.minX, y: bounds.minY, width: 1, height: max(bounds.height, 1))
  }

  private func clampedMarkedOffset(_ offset: Int, text: String? = nil) -> Int {
    let length = ((text ?? markedTextValue ?? "") as NSString).length
    return min(max(offset, 0), length)
  }

  private func clampedMarkedRange(_ range: NSRange, text: String? = nil) -> NSRange {
    let location = clampedMarkedOffset(range.location, text: text)
    let length = min(max(range.length, 0), clampedMarkedOffset(Int.max, text: text) - location)
    return NSRange(location: location, length: length)
  }
}

private final class GhosttyTextPosition: UITextPosition {
  let offset: Int

  init(offset: Int) {
    self.offset = offset
    super.init()
  }
}

private final class GhosttyTextRange: UITextRange {
  let range: NSRange

  init(range: NSRange) {
    self.range = range
    super.init()
  }

  override var start: UITextPosition {
    GhosttyTextPosition(offset: range.location)
  }

  override var end: UITextPosition {
    GhosttyTextPosition(offset: NSMaxRange(range))
  }

  override var isEmpty: Bool {
    range.length == 0
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
