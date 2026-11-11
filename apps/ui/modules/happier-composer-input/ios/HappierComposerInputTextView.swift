import UIKit
import UniformTypeIdentifiers

private final class ComposerReferenceAttachment: NSTextAttachment {
  let token: String
  var reference: [String: Any]
  var selected = false
  init(token: String, reference: [String: Any]) {
    self.token = token
    self.reference = reference
    super.init(data: nil, ofType: nil)
  }
  required init?(coder: NSCoder) { nil }
}

private final class ComposerReferenceAccessibilityElement: UIAccessibilityElement {
  var activate: (() -> Void)?
  override func accessibilityActivate() -> Bool {
    guard let activate else { return false }
    activate()
    return true
  }
}

// A reference tap observes alongside UITextView's own gestures. Winning exclusively would
// stop the text interaction's tap, and a tap on the composer would never begin editing.
final class ComposerReferenceTapDelegate: NSObject, UIGestureRecognizerDelegate {
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool { true }
}

// Keep the delegate separate from UITextView: Keyboard Controller forwards unknown
// delegate selectors, which must never resolve back to UIKit's text view itself.
private final class ComposerTextViewDelegate: NSObject, UITextViewDelegate {
  private weak var owner: HappierComposerTextView?

  init(owner: HappierComposerTextView) { self.owner = owner }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    owner?.textView(textView, shouldChangeTextIn: range, replacementText: text) ?? true
  }

  func textViewDidChange(_ textView: UITextView) { owner?.textViewDidChange(textView) }
  func textViewDidChangeSelection(_ textView: UITextView) { owner?.textViewDidChangeSelection(textView) }
  func textViewDidBeginEditing(_ textView: UITextView) { owner?.textViewDidBeginEditing(textView) }
  func textViewDidEndEditing(_ textView: UITextView) { owner?.textViewDidEndEditing(textView) }
  func scrollViewDidScroll(_ scrollView: UIScrollView) { owner?.scrollViewDidScroll(scrollView) }
}

/// The native owner of token-bearing UTF-16 source offsets versus UIKit attachment offsets.
/// User edits retain UIKit's text storage, marked text and undo history.
@objc(HappierComposerTextView)
final class HappierComposerTextView: UITextView, UITextDropDelegate, UIContextMenuInteractionDelegate, UIDropInteractionDelegate {
  private lazy var composerDelegate = ComposerTextViewDelegate(owner: self)
  private let referenceTapDelegate = ComposerReferenceTapDelegate()
  var acceptsAttachmentDrops = false
  var attachmentDropScope = ""
  var onAttachmentDrop: (([String: Any]) -> Void)?
  var onChange: ((String, [String: Int]) -> Void)?
  var onSelection: (([String: Int]) -> Void)?
  var onKeyPress: (([String: Any]) -> Void)?
  var onSubmitEditing: (([String: Any]) -> Void)?
  var onFocus: (() -> Void)?
  var onBlur: (() -> Void)?
  var onContentHeightChange: ((CGFloat) -> Void)?
  var onScroll: ((CGFloat) -> Void)?
  var onReferencePress: ((String) -> Void)?
  var onDecorationPress: ((String) -> Void)?
  var referenceMenuLabels: [String: String] = [:]
  var onReferenceAccessibilityChange: (() -> Void)?
  // The system clipboard is a process boundary; native tests replace only these OS operations.
  var readClipboardText: () -> String? = { UIPasteboard.general.string }
  var writeClipboardText: (String) -> Void = { UIPasteboard.general.string = $0 }
  var clipboardHasText: () -> Bool = { UIPasteboard.general.hasStrings }
  var maximumHeight: CGFloat? { didSet { setNeedsLayout() } }
  var minimumHeight: CGFloat = 0 { didSet { setNeedsLayout() } }
  var submitBehavior = "newline"
  var placeholder = "" { didSet { updatePlaceholder() } }
  var composerAccessibilityHint: String? { didSet { updateAccessibility() } }
  private(set) var accessibleReferenceElements: [UIAccessibilityElement] = []
  private(set) var eventCount = 0

  private let placeholderLabel = UILabel()
  private let dropCaret = UIView()
  private var references: [[String: Any]] = []
  private var decorations: [[String: Any]] = []
  private var theme: [String: String] = [:]
  private var typography: [String: Any] = [:]
  private struct DocumentUpdate {
    var text: String?
    var references: [[String: Any]]?
    var selection: [String: Int]?
    var acknowledgedEventCount: Int?
    var isCommand: Bool
  }
  private var pendingDocument: DocumentUpdate?
  private var pendingPresentation = false
  private var rendering = false
  private var dropOffset: Int?
  private var lastHeight: CGFloat = -1
  private var lastEmittedText = ""
  private var initialScrollY: CGFloat = 0
  private var scrollRestoreToken: String?
  private var pendingScrollRestore = false
  private var hardwareModifiers: UIKeyModifierFlags = []
  private var handlingHardwareKey = false
  private var measuredChipContainerWidth: CGFloat = -1

  override init(frame: CGRect, textContainer: NSTextContainer? = nil) {
    let storage = NSTextStorage()
    let layout = NSLayoutManager()
    let container = textContainer ?? NSTextContainer(size: .zero)
    storage.addLayoutManager(layout)
    layout.addTextContainer(container)
    super.init(frame: frame, textContainer: container)
    delegate = composerDelegate
    textDropDelegate = self
    textDragInteraction?.isEnabled = false
    addInteraction(UIDropInteraction(delegate: self))
    allowsEditingTextAttributes = false
    backgroundColor = .clear
    textContainerInset = .zero
    self.textContainer.lineFragmentPadding = 0
    self.textContainer.widthTracksTextView = true
    font = UIFont.preferredFont(forTextStyle: .body)
    adjustsFontForContentSizeCategory = true
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (view: HappierComposerTextView, _: UITraitCollection) in
        view.updatePresentation()
      }
    }
    placeholderLabel.isAccessibilityElement = false
    placeholderLabel.numberOfLines = 0
    addSubview(placeholderLabel)
    dropCaret.isUserInteractionEnabled = false
    dropCaret.isAccessibilityElement = false
    dropCaret.isHidden = true
    addSubview(dropCaret)
    addInteraction(UIContextMenuInteraction(delegate: self))
    let tap = UITapGestureRecognizer(target: self, action: #selector(referenceTapped(_:)))
    tap.cancelsTouchesInView = false
    tap.delegate = referenceTapDelegate
    addGestureRecognizer(tap)
    updatePresentation()
  }
  required init?(coder: NSCoder) { nil }

  private var fullRange: NSRange { NSRange(location: 0, length: textStorage.length) }
  private func referenceRuns() -> [(range: NSRange, attachment: ComposerReferenceAttachment)] {
    var result: [(NSRange, ComposerReferenceAttachment)] = []
    textStorage.enumerateAttribute(.attachment, in: fullRange) { value, range, _ in
      if let attachment = value as? ComposerReferenceAttachment { result.append((range, attachment)) }
    }
    return result
  }
  var sourceText: String {
    let result = NSMutableString(string: textStorage.string)
    for run in referenceRuns().reversed() { result.replaceCharacters(in: run.range, with: run.attachment.token) }
    return result as String
  }
  var sourceSelection: [String: Int] {
    ["start": sourceOffset(forDisplay: selectedRange.location), "end": sourceOffset(forDisplay: NSMaxRange(selectedRange))]
  }
  func referenceSnapshots() -> [[String: Any]] {
    referenceRuns().compactMap { run in
      guard let ref = run.attachment.reference["ref"] as? String else { return nil }
      return ["ref": ref, "token": run.attachment.token,
              "start": sourceOffset(forDisplay: run.range.location), "end": sourceOffset(forDisplay: NSMaxRange(run.range))]
    }
  }
  private func sourceOffset(forDisplay offset: Int) -> Int {
    let bounded = min(max(0, offset), textStorage.length)
    return referenceRuns().reduce(bounded) { result, run in
      result + (NSMaxRange(run.range) <= bounded ? (run.attachment.token as NSString).length - run.range.length : 0)
    }
  }
  private func displayOffset(forSource offset: Int, edge: Int = 0) -> Int {
    let bounded = min(max(0, offset), (sourceText as NSString).length)
    var delta = 0
    for run in referenceRuns() {
      let start = run.range.location + delta
      let end = start + (run.attachment.token as NSString).length
      if bounded > start && bounded < end {
        if edge < 0 { return run.range.location }
        if edge > 0 { return NSMaxRange(run.range) }
        return bounded - start <= end - bounded ? run.range.location : NSMaxRange(run.range)
      }
      if bounded >= end { delta += end - start - run.range.length }
    }
    return bounded - delta
  }
  func setTextAndSelection(_ value: String, selection: [String: Int], references: [[String: Any]]) {
    admitDocument(DocumentUpdate(text: value, references: references, selection: selection, isCommand: true))
  }
  func setControlledDocument(value: String? = nil, references: [[String: Any]]? = nil, eventCount acknowledgedEventCount: Int? = nil) {
    if let acknowledgedEventCount, acknowledgedEventCount < eventCount { return }
    guard pendingDocument?.isCommand != true else { return }
    let pending = pendingDocument?.acknowledgedEventCount == acknowledgedEventCount ? pendingDocument : nil
    admitDocument(DocumentUpdate(text: value ?? pending?.text,
                                 references: references ?? pending?.references,
                                 selection: pendingDocument?.selection,
                                 acknowledgedEventCount: acknowledgedEventCount, isCommand: false))
  }
  private func admitDocument(_ update: DocumentUpdate) {
    if markedTextRange != nil { pendingDocument = update; return }
    applyDocument(update)
  }
  private func applyDocument(_ update: DocumentUpdate) {
    let value = update.text ?? sourceText
    let selection = update.selection ?? sourceSelection
    let referencesChanged = update.references.map { !NSArray(array: references).isEqual(to: $0) } ?? false
    if let updatedReferences = update.references { references = updatedReferences }
    if value != sourceText { render(value, selection: selection) }
    else if referencesChanged { updateReferencePresentation(selection: selection) }
    else if update.selection != nil { setSourceSelection(selection) }
    if update.text != nil { lastEmittedText = value }
  }
  private func updateReferencePresentation(selection: [String: Int]) {
    let runs = referenceRuns()
    // The document echoes shifted ranges after typing. Keep UIKit's storage/undo in that case.
    if runs.count == references.count && zip(runs, references).allSatisfy({ run, reference in
      sourceOffset(forDisplay: run.range.location) == reference["start"] as? Int &&
      sourceOffset(forDisplay: NSMaxRange(run.range)) == reference["end"] as? Int &&
      run.attachment.reference["ref"] as? String == reference["ref"] as? String &&
      ((reference["token"] as? String).map { $0 == run.attachment.token } ?? true)
    }) {
      for (run, reference) in zip(runs, references) {
        run.attachment.reference = reference
        drawChip(run.attachment)
        layoutManager.invalidateDisplay(forCharacterRange: run.range)
      }
      setSourceSelection(selection)
      updateAccessibility()
      return
    }
    render(sourceText, selection: selection)
  }
  func setSourceSelection(_ selection: [String: Int]) {
    if markedTextRange != nil {
      if pendingDocument != nil { pendingDocument?.selection = selection }
      else { pendingDocument = DocumentUpdate(selection: selection, isCommand: false) }
      return
    }
    let start = selection["start"] ?? 0
    let end = selection["end"] ?? start
    let collapsed = start == end
    let lower = displayOffset(forSource: min(start, end), edge: collapsed ? 0 : -1)
    let upper = displayOffset(forSource: max(start, end), edge: collapsed ? 0 : 1)
    selectedRange = NSRange(location: lower, length: upper - lower)
    updateSelectionPresentation()
  }
  private func render(_ value: String, selection: [String: Int]) {
    guard !rendering else { return }
    rendering = true
    let source = value as NSString
    let attributed = NSMutableAttributedString(string: value, attributes: baseAttributes())
    var previousEnd = 0
    var admitted: [(NSRange, [String: Any])] = []
    for reference in references.sorted(by: { ($0["start"] as? Int ?? 0) < ($1["start"] as? Int ?? 0) }) {
      guard let start = reference["start"] as? Int, let end = reference["end"] as? Int,
            reference["ref"] is String, start >= previousEnd, start >= 0, end > start, end <= source.length else { continue }
      let range = NSRange(location: start, length: end - start)
      if let token = reference["token"] as? String, token != source.substring(with: range) { continue }
      admitted.append((range, reference))
      previousEnd = end
    }
    for (range, reference) in admitted.reversed() {
      let attachment = ComposerReferenceAttachment(token: source.substring(with: range), reference: reference)
      drawChip(attachment)
      attributed.replaceCharacters(in: range, with: NSAttributedString(attachment: attachment))
    }
    let scroll = contentOffset
    attributedText = attributed
    typingAttributes = baseAttributes()
    rendering = false
    setSourceSelection(selection)
    applyDecorations()
    setContentOffset(scroll, animated: false)
    updatePlaceholder()
    setNeedsLayout()
  }
  override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    super.setMarkedText(markedText, selectedRange: selectedRange)
    textViewDidChange(self)
  }
  override func unmarkText() { super.unmarkText(); flushDeferredUpdates() }
  private func flushDeferredUpdates() {
    guard markedTextRange == nil else { return }
    let update = pendingDocument
    pendingDocument = nil
    if let update {
      if update.acknowledgedEventCount.map({ $0 < eventCount }) != true { applyDocument(update) }
      else if let selection = update.selection { setSourceSelection(selection) }
    }
    if pendingPresentation { pendingPresentation = false; updatePresentation() }
  }

  override func deleteBackward() {
    if markedTextRange == nil && selectedRange.length == 0 && selectedRange.location > 0,
       textStorage.attribute(.attachment, at: selectedRange.location - 1, effectiveRange: nil) is ComposerReferenceAttachment {
      selectedRange = NSRange(location: selectedRange.location - 1, length: 1)
      updateSelectionPresentation()
      onSelection?(sourceSelection)
      if !handlingHardwareKey { emitKey("Backspace") }
      return
    }
    super.deleteBackward()
    textViewDidChange(self)
  }
  override func insertText(_ text: String) {
    super.insertText(text)
    textViewDidChange(self)
  }
  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    if handlingHardwareKey { return true }
    if markedTextRange == nil && text == "\n" {
      if !hardwareModifiers.isEmpty { return true }
      emitKey("Enter", submitting: submitBehavior != "newline")
      if submitBehavior != "newline" {
        onSubmitEditing?(keyPayload("Enter"))
        if submitBehavior == "blurAndSubmit" { resignFirstResponder() }
        return false
      }
    } else if hardwareModifiers.isEmpty && markedTextRange == nil { emitKey(text.isEmpty ? "Backspace" : text) }
    return true
  }
  func textViewDidChange(_ textView: UITextView) {
    guard !rendering else { return }
    let value = sourceText
    if value != lastEmittedText { lastEmittedText = value; eventCount += 1; onChange?(value, sourceSelection) }
    updatePlaceholder()
    if markedTextRange == nil { flushDeferredUpdates(); applyDecorations() }
    updateSelectionPresentation()
    setNeedsLayout()
  }
  func textViewDidChangeSelection(_ textView: UITextView) {
    guard !rendering else { return }
    onSelection?(sourceSelection)
    updateSelectionPresentation()
  }
  func textViewDidBeginEditing(_ textView: UITextView) { onFocus?() }
  func textViewDidEndEditing(_ textView: UITextView) { flushDeferredUpdates(); onBlur?() }
  func scrollViewDidScroll(_ scrollView: UIScrollView) { onScroll?(contentOffset.y); updateDropCaret(); updateAccessibility() }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    guard markedTextRange == nil else { super.pressesBegan(presses, with: event); return }
    handlingHardwareKey = true
    defer { handlingHardwareKey = false; hardwareModifiers = [] }
    for press in presses {
      guard let key = press.key else { continue }
      hardwareModifiers = key.modifierFlags
      let normalized: String
      switch key.keyCode {
      case .keyboardReturnOrEnter, .keypadEnter: normalized = "Enter"
      case .keyboardDeleteOrBackspace: normalized = "Backspace"
      case .keyboardDeleteForward: normalized = "Delete"
      case .keyboardLeftArrow: normalized = "ArrowLeft"
      case .keyboardRightArrow: normalized = "ArrowRight"
      case .keyboardUpArrow: normalized = "ArrowUp"
      case .keyboardDownArrow: normalized = "ArrowDown"
      case .keyboardEscape: normalized = "Escape"
      case .keyboardTab: normalized = "Tab"
      default: normalized = key.charactersIgnoringModifiers
      }
      emitKey(normalized, submitting: normalized == "Enter" && !key.modifierFlags.contains(.shift) && submitBehavior != "newline")
      if normalized == "Enter" {
        if key.modifierFlags.contains(.shift) { super.insertText("\n"); textViewDidChange(self) }
        else if submitBehavior != "newline" {
          onSubmitEditing?(keyPayload("Enter"))
          if submitBehavior == "blurAndSubmit" { resignFirstResponder() }
        } else { super.insertText("\n"); textViewDidChange(self) }
        return
      }
    }
    super.pressesBegan(presses, with: event)
  }
  private func keyPayload(_ key: String) -> [String: Any] {
    ["key": key, "shiftKey": hardwareModifiers.contains(.shift), "ctrlKey": hardwareModifiers.contains(.control),
     "altKey": hardwareModifiers.contains(.alternate), "metaKey": hardwareModifiers.contains(.command)]
  }
  private func emitKey(_ key: String, submitting: Bool = false) {
    var payload = keyPayload(key)
    if submitting { payload["submitting"] = true }
    onKeyPress?(payload)
  }
  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else { return }
    writeClipboardText(readableText(in: selectedRange))
  }
  override func cut(_ sender: Any?) {
    guard isEditable, selectedRange.length > 0 else { return }
    copy(sender)
    super.insertText("")
    textViewDidChange(self)
  }
  override func paste(_ sender: Any?) {
    guard isEditable, let plain = readClipboardText() else { return }
    insertText(plain)
  }
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)) { return isEditable && clipboardHasText() }
    return super.canPerformAction(action, withSender: sender)
  }
  func textDroppableView(_ textDroppableView: UIView & UITextDroppable, proposalForDrop drop: UITextDropRequest) -> UITextDropProposal {
    // Shared entity/attachment intake owns drops; UIKit may never install foreign attachments.
    UITextDropProposal(operation: .cancel)
  }
  func attachmentDropType(_ provider: NSItemProvider) -> String? {
    if provider.hasItemConformingToTypeIdentifier(UTType.folder.identifier) { return UTType.folder.identifier }
    let file = provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
    return provider.registeredTypeIdentifiers.first { identifier in
      guard let type = UTType(identifier), type.conforms(to: .data) else { return false }
      return file || type.conforms(to: .image) || (provider.suggestedName != nil && !type.conforms(to: .text))
    } ?? (file ? UTType.fileURL.identifier : nil)
  }
  func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
    isEditable && acceptsAttachmentDrops && !session.items.isEmpty && session.items.allSatisfy { attachmentDropType($0.itemProvider) != nil }
  }
  func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
    guard dropInteraction(interaction, canHandle: session), let window else { setDropCaret(nil); return UIDropProposal(operation: .cancel) }
    let point = session.location(in: window)
    setDropCaret(sourceOffsetAtWindowPoint(x: point.x, y: point.y))
    return UIDropProposal(operation: .copy)
  }
  func dropInteraction(_ interaction: UIDropInteraction, sessionDidExit session: UIDropSession) { setDropCaret(nil) }
  func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnd session: UIDropSession) { setDropCaret(nil) }
  func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
    guard dropInteraction(interaction, canHandle: session), let window else { return }
    let point = session.location(in: window)
    guard let offset = sourceOffsetAtWindowPoint(x: point.x, y: point.y) else { return }
    let scope = attachmentDropScope
    setDropCaret(nil)
    let providers = session.items.map(\.itemProvider)
    // Preserve provider order even when asynchronous file-provider loads finish out of order.
    func load(_ index: Int, sources: [[String: Any]]) {
      guard index < providers.count else {
        onAttachmentDrop?(["sources": sources, "offset": offset, "scope": scope]); return
      }
      let provider = providers[index]
      guard let type = attachmentDropType(provider) else { return }
      let receive: (URL?, Error?) -> Void = { url, error in
        let result = Result { () throws -> [String: Any] in
          if let error { throw error }
          guard let url else { throw CocoaError(.fileReadUnknown) }
          return try ComposerAttachmentDrop.read(url)
        }
        DispatchQueue.main.async {
          guard self.acceptsAttachmentDrops, self.isEditable, self.attachmentDropScope == scope else { return }
          switch result {
          case .success(let source): load(index + 1, sources: sources + [source])
          case .failure: self.onAttachmentDrop?(["sources": [], "offset": offset, "scope": scope, "error": true])
          }
        }
      }
      if type == UTType.fileURL.identifier {
        provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
          receive(item as? URL, error)
        }
      } else {
        provider.loadInPlaceFileRepresentation(forTypeIdentifier: type) { url, _, error in receive(url, error) }
      }
    }
    load(0, sources: [])
  }
  private func readableText(in range: NSRange) -> String {
    let result = NSMutableString(string: (textStorage.string as NSString).substring(with: range))
    for run in referenceRuns().reversed() where NSIntersectionRange(run.range, range).length > 0 {
      let marker = run.attachment.reference["marker"] as? String ?? run.attachment.reference["label"] as? String ?? ""
      result.replaceCharacters(in: NSRange(location: run.range.location - range.location, length: run.range.length), with: marker)
    }
    return result as String
  }

  func sourceOffsetAtWindowPoint(x: CGFloat, y: CGFloat) -> Int? {
    guard let window else { return nil }
    let point = convert(CGPoint(x: x, y: y), from: window)
    for run in referenceRuns() {
      let rect = referenceRect(run.range)
      if rect.contains(point) { return sourceOffset(forDisplay: point.x <= rect.midX ? run.range.location : NSMaxRange(run.range)) }
    }
    guard let position = closestPosition(to: point) else { return nil }
    return sourceOffset(forDisplay: offset(from: beginningOfDocument, to: position))
  }
  func sourceCaretRect() -> [String: Double]? {
    guard let window, let selection = selectedTextRange else { return nil }
    let rect = convert(caretRect(for: selection.end), to: window)
    return ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
  }
  func setDropCaret(_ offset: Int?) { dropOffset = offset; updateDropCaret() }
  private func updateDropCaret() {
    guard let dropOffset, let position = position(from: beginningOfDocument, offset: displayOffset(forSource: dropOffset)) else { dropCaret.isHidden = true; return }
    dropCaret.frame = caretRect(for: position)
    dropCaret.isHidden = false
    bringSubviewToFront(dropCaret)
  }
  func restoreScrollY(_ value: CGFloat) { initialScrollY = max(0, value); pendingScrollRestore = true; setNeedsLayout() }
  func setScrollRestoreToken(_ token: String?) {
    guard token != scrollRestoreToken else { return }
    scrollRestoreToken = token; pendingScrollRestore = true; setNeedsLayout()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    if measuredChipContainerWidth != availableChipWidth {
      measuredChipContainerWidth = availableChipWidth
      remeasureChips()
    }
    updatePlaceholder()
    let measured = sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
    let height = max(minimumHeight, measured)
    isScrollEnabled = maximumHeight.map { height > $0 } ?? false
    if lastHeight != height { lastHeight = height; onContentHeightChange?(height) }
    if pendingScrollRestore && bounds.width > 0 {
      pendingScrollRestore = false
      setContentOffset(CGPoint(x: 0, y: min(initialScrollY, max(0, contentSize.height - bounds.height))), animated: false)
    }
    updateDropCaret(); updateAccessibility()
  }
  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if #available(iOS 17.0, *) { return }
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { updatePresentation() }
  }
  func setTheme(_ value: [String: String]) { theme = value; updatePresentation() }
  func setTypography(_ value: [String: Any]) { typography = value; updatePresentation() }
  func setPadding(_ value: [String: Double]) {
    textContainerInset = UIEdgeInsets(top: value["top"] ?? 0, left: value["left"] ?? 0, bottom: value["bottom"] ?? 0, right: value["right"] ?? 0)
    setNeedsLayout()
  }
  func setDecorations(_ value: [[String: Any]]) {
    decorations = value
    if markedTextRange != nil { pendingPresentation = true; return }
    applyDecorations(); updateAccessibility()
  }
  private func ink(_ key: String, fallback: UIColor = .label) -> UIColor {
    guard var hex = theme[key]?.trimmingCharacters(in: .whitespacesAndNewlines) else { return fallback }
    if hex == "transparent" { return .clear }
    if hex.hasPrefix("rgb(") || hex.hasPrefix("rgba(") {
      let parts = hex.components(separatedBy: CharacterSet(charactersIn: "(), ")).filter { !$0.isEmpty }
      guard parts.count == 4 || parts.count == 5,
            let red = Double(parts[1]), let green = Double(parts[2]), let blue = Double(parts[3]),
            let alpha = parts.count == 5 ? Double(parts[4]) : 1 else { return fallback }
      return UIColor(red: CGFloat(red / 255), green: CGFloat(green / 255), blue: CGFloat(blue / 255), alpha: CGFloat(alpha))
    }
    guard hex.hasPrefix("#") else { return fallback }
    hex.removeFirst()
    if hex.count == 3 || hex.count == 4 { hex = hex.map { "\($0)\($0)" }.joined() }
    guard (hex.count == 6 || hex.count == 8), let value = UInt64(hex, radix: 16) else { return fallback }
    let alpha = hex.count == 8 ? CGFloat(value & 255) / 255 : 1
    let rgb = hex.count == 8 ? value >> 8 : value
    return UIColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: alpha)
  }
  private func baseAttributes() -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    if let lineHeight = typography["lineHeight"] as? Double { paragraph.minimumLineHeight = UIFontMetrics(forTextStyle: .body).scaledValue(for: CGFloat(lineHeight), compatibleWith: traitCollection) }
    return [.font: font ?? UIFont.preferredFont(forTextStyle: .body), .foregroundColor: ink("text"), .paragraphStyle: paragraph]
  }
  private func updatePresentation() {
    if markedTextRange != nil { pendingPresentation = true; return }
    let size = CGFloat(typography["fontSize"] as? Double ?? Double(UIFont.preferredFont(forTextStyle: .body).pointSize))
    let family = typography["fontFamily"] as? String
    let weightNumber = Double(typography["fontWeight"] as? String ?? "400") ?? typography["fontWeight"] as? Double ?? 400
    let weight: UIFont.Weight = weightNumber >= 600 ? .semibold : weightNumber >= 500 ? .medium : .regular
    let authored = family.flatMap { UIFont(name: $0, size: size) } ?? UIFont.systemFont(ofSize: size, weight: weight)
    font = UIFontMetrics(forTextStyle: .body).scaledFont(for: authored, compatibleWith: traitCollection)
    textColor = ink("text"); tintColor = ink("selection", fallback: .systemBlue)
    dropCaret.backgroundColor = tintColor
    textStorage.addAttributes(baseAttributes(), range: fullRange)
    typingAttributes = baseAttributes()
    remeasureChips()
    applyDecorations(); updatePlaceholder(); setNeedsLayout()
  }
  private func updatePlaceholder() {
    // The typed line's own attributes (its line height included), so the first typed glyph lands where the
    // placeholder's did and nothing shifts when typing replaces it.
    var attributes = baseAttributes(); attributes[.foregroundColor] = ink("placeholder", fallback: .placeholderText)
    placeholderLabel.attributedText = NSAttributedString(string: placeholder, attributes: attributes)
    placeholderLabel.isHidden = textStorage.length > 0
    let available = max(0, bounds.width - textContainerInset.left - textContainerInset.right)
    let size = placeholderLabel.sizeThatFits(CGSize(width: available, height: .greatestFiniteMagnitude))
    placeholderLabel.frame = CGRect(x: textContainerInset.left, y: textContainerInset.top, width: available, height: size.height)
  }
  private func applyDecorations() {
    guard markedTextRange == nil else { return }
    textStorage.beginEditing()
    for key in [NSAttributedString.Key.foregroundColor, .backgroundColor, .underlineStyle, .underlineColor, .font, .link] { textStorage.removeAttribute(key, range: fullRange) }
    textStorage.addAttributes(baseAttributes(), range: fullRange)
    for decoration in decorations {
      guard let start = decoration["start"] as? Int, let end = decoration["end"] as? Int, end > start else { continue }
      let lower = displayOffset(forSource: start, edge: -1), upper = displayOffset(forSource: end, edge: 1)
      let treatment = decoration["treatment"] as? String ?? (decoration["treatment"] as? [String: Any])?["kind"] as? String
      var attributes: [NSAttributedString.Key: Any] = [:]
      switch treatment {
      case "muted": attributes[.foregroundColor] = ink("muted", fallback: .secondaryLabel)
      case "warning", "success":
        attributes[.underlineStyle] = NSUnderlineStyle.patternDot.rawValue | NSUnderlineStyle.single.rawValue
        attributes[.underlineColor] = ink(treatment ?? "text")
      case "highlight": attributes[.backgroundColor] = ink("chipBackground", fallback: .secondarySystemFill)
      case "code":
        let size = font?.pointSize ?? UIFont.preferredFont(forTextStyle: .body).pointSize
        attributes[.font] = (typography["monoFontFamily"] as? String).flatMap { UIFont(name: $0, size: size) } ?? UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
      case "link": attributes[.foregroundColor] = ink("link", fallback: tintColor); attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
      default: break
      }
      textStorage.addAttributes(attributes, range: NSRange(location: lower, length: upper - lower))
    }
    textStorage.endEditing()
    typingAttributes = baseAttributes()
  }
  /// One CA painter consumes the JS theme/typography owner; no chip has embedded controls.
  private var availableChipWidth: CGFloat {
    let viewWidth = max(0, bounds.width - textContainerInset.left - textContainerInset.right)
    let containerWidth = textContainer.size.width > 0 ? min(viewWidth, textContainer.size.width) : viewWidth
    return max(0, containerWidth - 2 * textContainer.lineFragmentPadding)
  }
  private func remeasureChips() {
    guard markedTextRange == nil else { pendingPresentation = true; return }
    for run in referenceRuns() {
      drawChip(run.attachment)
      layoutManager.invalidateLayout(forCharacterRange: run.range, actualCharacterRange: nil)
      layoutManager.invalidateDisplay(forCharacterRange: run.range)
    }
  }
  private func drawChip(_ attachment: ComposerReferenceAttachment) {
    let font = self.font ?? UIFont.preferredFont(forTextStyle: .body)
    let scale = UIFontMetrics(forTextStyle: .body).scaledValue(for: 1, compatibleWith: traitCollection)
    let height = CGFloat(typography["chipHeight"] as? Double ?? Double(font.lineHeight)) * scale
    let radius = CGFloat(typography["chipRadius"] as? Double ?? 0) * scale
    let inset = CGFloat(typography["chipPaddingLeft"] as? Double ?? 0) * scale
    let rightInset = CGFloat(typography["chipPaddingRight"] as? Double ?? 0) * scale
    let glyphSize = CGFloat(typography["chipGlyphSize"] as? Double ?? 0) * scale
    let gap = CGFloat(typography["chipGap"] as? Double ?? 0) * scale
    let label = attachment.reference["label"] as? String ?? ""
    let maxLabel = CGFloat(typography["chipMaxLabelWidth"] as? Double ?? Double(bounds.width)) * scale
    let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
    let foreground = ink("chipForeground")
    let chipFont = (typography["chipFontFamily"] as? String).flatMap { UIFont(name: $0, size: font.pointSize) } ?? font
    let attributes: [NSAttributedString.Key: Any] = [.font: chipFont, .foregroundColor: foreground, .paragraphStyle: paragraph]
    let chromeWidth = inset + rightInset + glyphSize + gap
    let labelWidth = min(maxLabel, max(0, availableChipWidth - chromeWidth), ceil((label as NSString).size(withAttributes: attributes).width))
    let width = min(availableChipWidth, chromeWidth + labelWidth)
    guard width > 0, height > 0 else { attachment.image = nil; attachment.bounds = .zero; return }
    let state = attachment.reference["state"] as? String
    let opacity: CGFloat = state == "pending" || state == "removed" || state == "unavailable" ? 0.55 : 1
    let image = (attachment.reference["glyph"] as? String).flatMap { UIImage(systemName: $0) }
    attachment.image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height)).image { context in
      context.cgContext.setAlpha(opacity)
      ink("chipBackground", fallback: .secondarySystemFill).setFill()
      UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: width, height: height), cornerRadius: radius).fill()
      if attachment.selected {
        ink("selection", fallback: tintColor).setStroke()
        let border = UIBezierPath(roundedRect: CGRect(x: 0.5, y: 0.5, width: width - 1, height: height - 1), cornerRadius: radius)
        border.lineWidth = 1; border.stroke()
      }
      image?.withTintColor(ink("chipGlyphForeground", fallback: foreground), renderingMode: .alwaysOriginal).draw(in: CGRect(x: inset, y: (height - glyphSize) / 2, width: glyphSize, height: glyphSize))
      (label as NSString).draw(in: CGRect(x: inset + glyphSize + gap, y: (height - font.lineHeight) / 2, width: labelWidth, height: font.lineHeight), withAttributes: attributes)
    }
    attachment.bounds = CGRect(x: 0, y: (font.capHeight - height) / 2, width: width, height: height)
  }
  private func updateSelectionPresentation() {
    guard markedTextRange == nil else { return }
    for run in referenceRuns() {
      let selected = NSIntersectionRange(run.range, selectedRange).length > 0
      if run.attachment.selected != selected {
        run.attachment.selected = selected; drawChip(run.attachment)
        layoutManager.invalidateDisplay(forCharacterRange: run.range)
      }
    }
    updateAccessibility()
  }
  private func referenceRect(_ range: NSRange) -> CGRect {
    layoutManager.ensureLayout(for: textContainer)
    let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    return layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer).offsetBy(dx: textContainerInset.left, dy: textContainerInset.top)
  }
  private func updateAccessibility() {
    accessibleReferenceElements = referenceRuns().map { run in
      let element = ComposerReferenceAccessibilityElement(accessibilityContainer: self)
      element.accessibilityLabel = run.attachment.reference["accessibilityLabel"] as? String ?? run.attachment.reference["label"] as? String
      element.accessibilityTraits = .button
      element.accessibilityFrameInContainerSpace = referenceRect(run.range)
      element.activate = { [weak self] in if let ref = run.attachment.reference["ref"] as? String { self?.onReferencePress?(ref) } }
      return element
    }
    accessibilityCustomActions = referenceRuns().map { run in
      let name = run.attachment.reference["accessibilityLabel"] as? String ?? run.attachment.reference["label"] as? String ?? ""
      return UIAccessibilityCustomAction(name: name) { [weak self] _ in
        guard let ref = run.attachment.reference["ref"] as? String else { return false }
        self?.onReferencePress?(ref); return true
      }
    }
    accessibilityValue = readableText(in: fullRange)
    accessibilityHint = ([composerAccessibilityHint].compactMap { $0 } + decorations.compactMap { $0["label"] as? String }).joined(separator: ". ")
    onReferenceAccessibilityChange?()
  }
  @objc private func referenceTapped(_ recognizer: UITapGestureRecognizer) {
    let point = recognizer.location(in: self)
    if let run = referenceRuns().first(where: { referenceRect($0.range).contains(point) }), let ref = run.attachment.reference["ref"] as? String { onReferencePress?(ref) }
  }
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    if let run = referenceRuns().first(where: { referenceRect($0.range).contains(location) }), let ref = run.attachment.reference["ref"] as? String {
      return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
        var actions: [UIAction] = []
        if let title = self?.referenceMenuLabels["open"] {
          actions.append(UIAction(title: title, image: UIImage(systemName: "arrow.up.forward")) { _ in self?.onReferencePress?(ref) })
        }
        if let self, self.isEditable, let title = self.referenceMenuLabels["remove"] {
          actions.append(UIAction(title: title, image: UIImage(systemName: "trash")) { [weak self] _ in
            guard let self, let current = self.referenceRuns().first(where: { $0.attachment === run.attachment }) else { return }
            self.selectedRange = current.range
            self.insertText("")
          })
        }
        return UIMenu(children: actions)
      }
    }
    guard let position = closestPosition(to: location) else { return nil }
    let source = sourceOffset(forDisplay: offset(from: beginningOfDocument, to: position))
    guard let decoration = decorations.first(where: { ($0["start"] as? Int ?? 0) <= source && source < ($0["end"] as? Int ?? 0) }),
      let treatment = decoration["treatment"] as? [String: Any], treatment["kind"] as? String == "link",
      let destination = treatment["url"] as? String, let title = referenceMenuLabels["open"] else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(children: [UIAction(title: title, image: UIImage(systemName: "arrow.up.forward")) { _ in self?.onDecorationPress?(destination) }])
    }
  }
}
