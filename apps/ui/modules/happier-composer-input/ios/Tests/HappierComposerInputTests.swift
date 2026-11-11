import UIKit
import XCTest
import UniformTypeIdentifiers
import ObjectiveC
@testable import HappierComposerInputNative

@MainActor
final class HappierComposerInputTests: XCTestCase {
  private let token = "[Auth](happier-ref:session:auth)"

  func testDirectoryDropCopiesScopedFilesIntoTheSharedFolderSourceShapeIncludingEmptyDirectories() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("Design")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("icons/empty"), withIntermediateDirectories: true)
    try Data("svg".utf8).write(to: root.appendingPathComponent("icons/a.svg"))
    defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    let source = try ComposerAttachmentDrop.read(root)
    XCTAssertEqual(source["kind"] as? String, "folder")
    XCTAssertEqual(source["name"] as? String, "Design")
    XCTAssertEqual(source["mimeType"] as? String, "inode/directory")
    XCTAssertEqual(Set(source["directories"] as? [String] ?? []), Set(["icons", "icons/empty"]))
    let entries = try XCTUnwrap(source["entries"] as? [[String: Any]])
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries[0]["relativePath"] as? String, "icons/a.svg")
    let file = try XCTUnwrap(entries[0]["source"] as? [String: Any])
    XCTAssertEqual(file["kind"] as? String, "native")
    XCTAssertEqual(file["sizeBytes"] as? Int, 3)
    let cached = try XCTUnwrap(URL(string: try XCTUnwrap(file["uri"] as? String)))
    defer { try? FileManager.default.removeItem(at: cached.deletingLastPathComponent().deletingLastPathComponent()) }
    try FileManager.default.removeItem(at: root.appendingPathComponent("icons/a.svg"))
    XCTAssertEqual(try Data(contentsOf: cached), Data("svg".utf8))
  }

  func testNativeDropInteractionAdmitsFilesButRefusesRichTextProviders() {
    let input = makeInput()
    XCTAssertTrue(input.interactions.contains { $0 is UIDropInteraction && ($0 as? UIDropInteraction)?.delegate === input })
    let rich = NSItemProvider(item: "<b>foreign</b>" as NSString, typeIdentifier: UTType.html.identifier)
    XCTAssertNil(input.attachmentDropType(rich))
    let folder = NSItemProvider()
    folder.registerFileRepresentation(forTypeIdentifier: UTType.folder.identifier, fileOptions: .openInPlace, visibility: .all) { _ in nil }
    XCTAssertEqual(input.attachmentDropType(folder), UTType.folder.identifier)
  }

  private func makeInput(prefix: String = "😀 ", suffix: String = " done") -> HappierComposerTextView {
    let input = HappierComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 120))
    let start = (prefix as NSString).length
    input.setControlledDocument(value: prefix + token + suffix, references: [[
      "start": start, "end": start + (token as NSString).length,
      "ref": "session:auth", "kind": "session", "label": "Auth", "state": "ready",
      "marker": "@Session \"Auth\"", "accessibilityLabel": "Session, Auth",
    ]])
    return input
  }

  func testPlainEditorKeepsTypedGlyphsVisibleAndReturnsToOneLineAfterClearing() throws {
    let input = HappierComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 38))
    input.setTypography(["fontSize": 16.0, "lineHeight": 22.0])
    input.setTheme(["text": "#f5f5f5", "selection": "#4080ff"])
    input.setPadding(["top": 8, "bottom": 8])
    input.minimumHeight = 38
    input.maximumHeight = 120
    var measuredHeight: CGFloat?
    input.onContentHeightChange = { measuredHeight = $0 }
    input.layoutIfNeeded()
    let emptyHeight = try XCTUnwrap(measuredHeight)
    XCTAssertEqual(emptyHeight, input.minimumHeight, accuracy: 1)

    input.insertText("Visible")
    input.layoutIfNeeded()
    input.layoutManager.ensureLayout(for: input.textContainer)
    let glyphs = input.layoutManager.glyphRange(forCharacterRange: NSRange(location: 0, length: input.textStorage.length), actualCharacterRange: nil)
    let glyphBounds = input.layoutManager.boundingRect(forGlyphRange: glyphs, in: input.textContainer)
    XCTAssertGreaterThan(glyphBounds.width, 0)
    XCTAssertGreaterThan(glyphBounds.height, 0)
    XCTAssertLessThanOrEqual(glyphBounds.maxY + input.textContainerInset.top, input.bounds.height)
    let ink = try XCTUnwrap(input.textStorage.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    XCTAssertTrue(ink.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
    XCTAssertEqual(red, 245.0 / 255, accuracy: 0.001)
    XCTAssertEqual(alpha, 1, accuracy: 0.001)

    input.setControlledDocument(value: String(repeating: "A longer line of text ", count: 20), references: [])
    input.layoutIfNeeded()
    XCTAssertGreaterThan(try XCTUnwrap(measuredHeight), emptyHeight)
    input.setControlledDocument(value: "", references: [])
    input.layoutIfNeeded()
    XCTAssertEqual(try XCTUnwrap(measuredHeight), emptyHeight, accuracy: 1)
  }

  // Owner 2026-11-11 (phone 06/07): the typed line sat lower than the placeholder it replaced, so the text
  // jumped when typing began. Both are drawn from the same insets and line metrics.
  func testTypedTextStartsWhereThePlaceholderWasDrawn() throws {
    func inkBounds(_ configure: (HappierComposerTextView) -> Void) throws -> CGRect {
      let input = HappierComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 60))
      input.setTypography(["fontSize": 16.0, "lineHeight": 24.0])
      input.setTheme(["text": "#000000", "placeholder": "#000000"])
      input.setPadding(["top": 8, "left": 12, "bottom": 8, "right": 12])
      configure(input)
      input.layoutIfNeeded()
      input.layoutManager.ensureLayout(for: input.textContainer)
      let format = UIGraphicsImageRendererFormat(); format.scale = 2; format.opaque = false
      let image = UIGraphicsImageRenderer(bounds: input.bounds, format: format).image { input.layer.render(in: $0.cgContext) }
      let cgImage = try XCTUnwrap(image.cgImage)
      let width = cgImage.width, height = cgImage.height
      var pixels = [UInt8](repeating: 0, count: width * height * 4)
      let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      var minX = width, minY = height, maxX = -1, maxY = -1
      for y in 0..<height { for x in 0..<width where pixels[(y * width + x) * 4 + 3] > 96 {
        minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y)
      } }
      XCTAssertGreaterThanOrEqual(maxX, 0, "nothing was drawn")
      return CGRect(x: CGFloat(minX) / 2, y: CGFloat(minY) / 2, width: CGFloat(maxX - minX) / 2, height: CGFloat(maxY - minY) / 2)
    }
    let placeholder = try inkBounds { $0.placeholder = "What would" }
    let typed = try inkBounds { $0.setControlledDocument(value: "What would", references: []) }
    XCTAssertEqual(typed.minY, placeholder.minY, accuracy: 0.5)
    XCTAssertEqual(typed.minX, placeholder.minX, accuracy: 0.5)
  }

  func testActualTextViewUsesAnAttachmentAndReportsUTF16SourceSelection() {
    let input = makeInput()
    XCTAssertEqual(input.text, "😀 \u{fffc} done")
    XCTAssertNotNil(input.textStorage.attribute(.attachment, at: 3, effectiveRange: nil))
    input.setSourceSelection(["start": 4, "end": 4])
    XCTAssertEqual(input.sourceSelection["start"], 3)
    input.selectedRange = NSRange(location: 4, length: 0)
    XCTAssertEqual(input.sourceSelection["start"], 3 + (token as NSString).length)
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
  }

  func testFirstCharacterWithKeyboardControllerDelegateForwarding() throws {
    let previousKeyWindow = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }.first { $0.isKeyWindow }
    let input = HappierComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 38))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
    let controller = UIViewController()
    window.rootViewController = controller
    controller.view.addSubview(input)
    window.makeKeyAndVisible()
    defer {
      input.resignFirstResponder()
      input.removeFromSuperview()
      window.isHidden = true
      window.rootViewController = nil
      previousKeyWindow?.makeKey()
    }
    input.layoutIfNeeded()

    var changes: [String] = []
    var selection: [String: Int]?
    var focused = false
    input.onChange = { text, _ in changes.append(text) }
    input.onSelection = { selection = $0 }
    input.onFocus = { focused = true }
    input.onBlur = { focused = false }
    XCTAssertTrue(input.becomeFirstResponder())
    XCTAssertTrue(focused)

    // Keyboard Controller substitutes UITextView's private delegate ivar and forwards
    // selectors to the original delegate. Keep that native SDK boundary real-shaped.
    let originalDelegate = try XCTUnwrap(input.delegate)
    let composite = KeyboardControllerDelegateBoundary(original: originalDelegate)
    let delegateIvar = try XCTUnwrap(class_getInstanceVariable(UITextView.self, "_delegate"))
    object_setIvar(input, delegateIvar, composite)
    defer { input.delegate = originalDelegate }
    withExtendedLifetime(composite) {
      input.insertText("Q")
      input.layoutIfNeeded()
    }

    XCTAssertEqual(input.sourceText, "Q")
    XCTAssertEqual(changes, ["Q"])
    XCTAssertEqual(input.sourceSelection, ["start": 1, "end": 1])
    XCTAssertEqual(selection, ["start": 1, "end": 1])
    XCTAssertGreaterThan(try XCTUnwrap(input.sourceCaretRect()?["height"]), 0)
    XCTAssertTrue(input.resignFirstResponder())
    XCTAssertFalse(focused)
  }

  func testSoftKeyboardBackspaceSelectsThenDeletesTheWholeChipAndUndoRestoresIt() {
    let input = makeInput()
    // Test exact chip deletion independently of UIKit's keyboard-activated smart spacing.
    input.smartInsertDeleteType = .no
    input.selectedRange = NSRange(location: 4, length: 0)
    input.deleteBackward()
    XCTAssertEqual(input.selectedRange, NSRange(location: 3, length: 1))
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
    input.deleteBackward()
    XCTAssertEqual(input.sourceText, "😀  done")
    XCTAssertEqual(input.sourceSelection["start"], 3)
    input.undoManager?.undo()
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
    let restored = input.referenceSnapshots()
    XCTAssertEqual(restored.count, 1)
    XCTAssertEqual(restored.first?["ref"] as? String, "session:auth")
    XCTAssertEqual(restored.first?["token"] as? String, token)
    XCTAssertEqual(restored.first?["start"] as? Int, 3)
  }

  func testReplacingASelectionAcrossChipNeverLeaksItsTokenCharacters() {
    let input = makeInput()
    input.selectedRange = NSRange(location: 2, length: 3)
    input.insertText("new ")
    XCTAssertEqual(input.sourceText, "😀new done")
    XCTAssertFalse(input.sourceText.contains("happier-ref:"))
  }

  func testControlledUpdatesWaitUntilMarkedTextIsCommitted() {
    let input = makeInput(prefix: "", suffix: "")
    input.selectedRange = NSRange(location: 1, length: 0)
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    XCTAssertNotNil(input.markedTextRange)
    input.setControlledDocument(value: "external")
    XCTAssertTrue(input.sourceText.contains("に"))
    input.unmarkText()
    XCTAssertEqual(input.sourceText, "external")
  }

  func testSelectionRestoreDuringMarkedTextKeepsThePendingControlledDocument() {
    let input = makeInput(prefix: "", suffix: "")
    input.selectedRange = NSRange(location: 1, length: 0)
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    input.setControlledDocument(value: "external", references: [], eventCount: input.eventCount)
    input.setSourceSelection(["start": 4, "end": 4])
    input.unmarkText()
    XCTAssertEqual(input.sourceText, "external")
    XCTAssertEqual(input.sourceSelection, ["start": 4, "end": 4])
  }

  func testStaleControlledCompositionEchoCannotRestoreAnEarlierMarkedValue() {
    let input = makeInput(prefix: "", suffix: "")
    input.selectedRange = NSRange(location: 1, length: 0)
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    let intermediate = input.sourceText
    let acknowledgedEvent = input.eventCount
    input.setControlledDocument(value: intermediate, references: [], eventCount: acknowledgedEvent)
    input.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0))
    input.unmarkText()
    XCTAssertEqual(input.sourceText, token + "日本")
    XCTAssertEqual(input.referenceSnapshots().count, 1)
    input.setControlledDocument(value: intermediate, eventCount: acknowledgedEvent)
    XCTAssertEqual(input.sourceText, token + "日本")
  }

  func testIntentionalTextAndSelectionCommandWaitsForCompositionThenApplies() {
    let input = makeInput()
    input.selectedRange = NSRange(location: 4, length: 0)
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    input.setTextAndSelection("New draft", selection: ["start": 4, "end": 4], references: [])
    XCTAssertTrue(input.sourceText.contains("に"))
    input.unmarkText()
    XCTAssertEqual(input.sourceText, "New draft")
    XCTAssertEqual(input.sourceSelection, ["start": 4, "end": 4])
  }

  func testProgrammaticPrefixKeepsRequestedCaretBeforeRebasedChipAfterControlledEcho() {
    for composing in [false, true] {
      let input = makeInput(prefix: "", suffix: "")
      if composing {
        input.selectedRange = NSRange(location: 1, length: 0)
        input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
      }
      let shifted: [[String: Any]] = [["start": 3, "end": 3 + (token as NSString).length,
                                      "ref": "session:auth", "label": "Auth", "token": token]]
      input.setTextAndSelection("Hi " + token, selection: ["start": 3, "end": 3], references: shifted)
      if composing {
        input.setControlledDocument(value: token, references: [], eventCount: input.eventCount)
        input.unmarkText()
      }
      XCTAssertEqual(input.sourceSelection, ["start": 3, "end": 3], "before echo, composing=\(composing)")
      input.setControlledDocument(value: "Hi " + token, references: shifted, eventCount: input.eventCount)
      XCTAssertEqual(input.text, "Hi \u{fffc}", "composing=\(composing)")
      XCTAssertEqual(input.sourceSelection, ["start": 3, "end": 3], "composing=\(composing)")
    }
  }

  func testControlledDocumentAppliesTextAndBindingsTogetherImmediatelyAndAfterMarkedText() {
    for composing in [false, true] {
      let input = makeInput(prefix: "", suffix: "")
      input.setSourceSelection(["start": 0, "end": 0])
      if composing {
        input.selectedRange = NSRange(location: 1, length: 0)
        input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
      }
      input.setControlledDocument(value: "Hi " + token,
                                  references: [["start": 3, "end": 3 + (token as NSString).length,
                                                "ref": "session:auth", "label": "Auth", "token": token]],
                                  eventCount: input.eventCount)
      if composing { input.unmarkText() }
      XCTAssertEqual(input.text, "Hi \u{fffc}")
      XCTAssertEqual(input.referenceSnapshots().first?["token"] as? String, token)
      XCTAssertEqual(input.referenceSnapshots().first?["start"] as? Int, 3)
    }
  }

  func testLargeTextChipFitsPaddedContainerAndRemeasuresAfterRotationAndDynamicType() throws {
    guard #available(iOS 17.0, *) else { throw XCTSkip("Trait overrides require iOS 17") }
    let input = makeInput(prefix: "", suffix: "")
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 640, height: 400))
    window.addSubview(input)
    let label = String(repeating: "Long session title ", count: 12)
    input.setControlledDocument(references: [["start": 0, "end": (token as NSString).length, "ref": "session:auth",
                          "label": label, "accessibilityLabel": "Session, " + label]])
    input.setTypography(["fontSize": 28.0, "chipHeight": 40.0, "chipRadius": 12.0,
                         "chipPaddingLeft": 8.0, "chipPaddingRight": 12.0, "chipGlyphSize": 28.0,
                         "chipGap": 8.0, "chipMaxLabelWidth": 380.0])
    input.setPadding(["left": 12, "right": 16])
    input.textContainer.lineFragmentPadding = 5
    input.layoutIfNeeded()
    let attachment = try XCTUnwrap(input.textStorage.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment)
    let narrowWidth = attachment.bounds.width
    XCTAssertLessThanOrEqual(narrowWidth, input.bounds.width - 12 - 16 - 10)
    input.frame.size.width = 640
    input.setNeedsLayout()
    input.layoutIfNeeded()
    XCTAssertGreaterThan(attachment.bounds.width, narrowWidth)
    XCTAssertLessThanOrEqual(attachment.bounds.width, 640 - 12 - 16 - 10)
    let regularHeight = attachment.bounds.height
    input.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
    input.updateTraitsIfNeeded()
    XCTAssertEqual(input.traitCollection.preferredContentSizeCategory, .accessibilityExtraExtraExtraLarge)
    input.layoutIfNeeded()
    XCTAssertGreaterThan(attachment.bounds.height, regularHeight)
    XCTAssertLessThanOrEqual(attachment.bounds.width, 640 - 12 - 16 - 10)
    XCTAssertEqual(input.accessibleReferenceElements.first?.accessibilityLabel, "Session, " + label)
  }

  func testSubmitEnterMarksKeyAndCarriesModifiersInOneSubmitPayload() {
    let input = makeInput(prefix: "", suffix: "")
    input.submitBehavior = "submit"
    var keyPayloads: [[String: Any]] = []
    var submits: [[String: Any]] = []
    input.onKeyPress = { keyPayloads.append($0) }
    input.onSubmitEditing = { submits.append($0) }
    XCTAssertFalse(input.textView(input, shouldChangeTextIn: NSRange(location: 1, length: 0), replacementText: "\n"))
    XCTAssertEqual(keyPayloads.count, 1)
    XCTAssertEqual(keyPayloads.first?["key"] as? String, "Enter")
    XCTAssertEqual(keyPayloads.first?["submitting"] as? Bool, true)
    XCTAssertEqual(submits.count, 1)
    XCTAssertEqual(submits.first?["key"] as? String, "Enter")
    for modifier in ["shiftKey", "ctrlKey", "altKey", "metaKey"] { XCTAssertEqual(submits.first?[modifier] as? Bool, false) }
    input.submitBehavior = "newline"
    XCTAssertTrue(input.textView(input, shouldChangeTextIn: NSRange(location: 1, length: 0), replacementText: "\n"))
    XCTAssertNil(keyPayloads.last?["submitting"])
    XCTAssertEqual(submits.count, 1)
  }

  func testAdjacentChipsCRLFAndEmojiRemainInOneSourceOffsetSpace() {
    let input = makeInput(prefix: "", suffix: token + "\r\n😀")
    let length = (token as NSString).length
    input.setControlledDocument(references: [
      ["start": 0, "end": length, "ref": "session:auth", "label": "Auth"],
      ["start": length, "end": length * 2, "ref": "session:auth", "label": "Auth"],
    ])
    XCTAssertEqual(input.text, "\u{fffc}\u{fffc}\r\n😀")
    input.setSourceSelection(["start": length - 1, "end": length + 1])
    XCTAssertEqual(input.selectedRange, NSRange(location: 0, length: 2))
    XCTAssertEqual(input.sourceSelection, ["start": 0, "end": length * 2])
    input.selectedRange = NSRange(location: 6, length: 0)
    XCTAssertEqual(input.sourceSelection["start"], length * 2 + 4)
  }

  func testReferenceRangeEchoAfterTypingKeepsTheActualAttachmentAndUndo() {
    let input = makeInput()
    let attachment = input.textStorage.attribute(.attachment, at: 3, effectiveRange: nil) as? NSTextAttachment
    input.selectedRange = NSRange(location: 0, length: 0)
    input.insertText("Hi ")
    input.setControlledDocument(references: [["start": 6, "end": 6 + (token as NSString).length,
                          "ref": "session:auth", "label": "Updated"]])
    let retained = input.textStorage.attribute(.attachment, at: 6, effectiveRange: nil) as? NSTextAttachment
    XCTAssertTrue(attachment === retained)
    input.undoManager?.undo()
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
  }

  func testControlledBindingWithMismatchedTokenCannotRetainAnOldAttachment() {
    let input = makeInput(prefix: "", suffix: "")
    input.setControlledDocument(references: [["start": 0, "end": (token as NSString).length,
                                             "ref": "session:auth", "label": "Work",
                                             "token": token.replacingOccurrences(of: "[Auth]", with: "[Work]")]])
    XCTAssertEqual(input.sourceText, token)
    XCTAssertEqual(input.text, token)
    XCTAssertTrue(input.referenceSnapshots().isEmpty)
  }

  func testPlainClipboardProjectionDoesNotRebuildChipsOnPaste() {
    let input = makeInput(prefix: "", suffix: "")
    var clipboard: String?
    input.writeClipboardText = { clipboard = $0 }
    input.readClipboardText = { clipboard }
    input.selectedRange = NSRange(location: 0, length: 1)
    input.copy(nil)
    XCTAssertEqual(clipboard, "@Session \"Auth\"")
    input.setControlledDocument(value: "", references: [])
    clipboard = token
    input.paste(nil)
    XCTAssertEqual(input.sourceText, token)
    XCTAssertNil(input.textStorage.attribute(.attachment, at: 0, effectiveRange: nil))
  }

  func testPointAtEitherChipEdgeMapsToSourceEdgesInWindowCoordinates() {
    let input = makeInput()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
    window.addSubview(input)
    input.frame.origin = CGPoint(x: 30, y: 40)
    input.layoutIfNeeded()
    input.layoutManager.ensureLayout(for: input.textContainer)
    let glyphs = input.layoutManager.glyphRange(forCharacterRange: NSRange(location: 3, length: 1), actualCharacterRange: nil)
    var chip = input.layoutManager.boundingRect(forGlyphRange: glyphs, in: input.textContainer)
    chip.origin.x += input.textContainerInset.left
    chip.origin.y += input.textContainerInset.top
    let left = input.convert(CGPoint(x: chip.minX + 1, y: chip.midY), to: window)
    let right = input.convert(CGPoint(x: chip.maxX - 1, y: chip.midY), to: window)
    XCTAssertEqual(input.sourceOffsetAtWindowPoint(x: left.x, y: left.y), 3)
    XCTAssertEqual(input.sourceOffsetAtWindowPoint(x: right.x, y: right.y), 3 + (token as NSString).length)
  }

  func testEachChipHasOneAccessibleActivationAndForeignImagePasteIsRefused() {
    let input = makeInput()
    var activated: String?
    input.onReferencePress = { activated = $0 }
    input.layoutSubviews()
    let chip = input.accessibleReferenceElements.first
    XCTAssertEqual(chip?.accessibilityLabel, "Session, Auth")
    XCTAssertEqual(chip?.accessibilityActivate(), true)
    XCTAssertEqual(activated, "session:auth")
    let before = input.sourceText
    // A rich-only clipboard has no plain text. Clipboard access is the genuine OS boundary.
    input.readClipboardText = { nil }
    input.paste(nil)
    XCTAssertEqual(input.sourceText, before)
  }
}

// Mirrors only react-native-keyboard-controller's external Objective-C forwarding seam.
private final class KeyboardControllerDelegateBoundary: NSObject, UITextViewDelegate {
  private weak var original: UITextViewDelegate?

  init(original: UITextViewDelegate) { self.original = original }

  override func responds(to selector: Selector!) -> Bool {
    super.responds(to: selector) || original?.responds(to: selector) == true
  }

  override func forwardingTarget(for selector: Selector!) -> Any? {
    if original?.responds(to: selector) == true { return original }
    return super.forwardingTarget(for: selector)
  }
}
