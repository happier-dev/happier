import ExpoModulesCore
import UIKit

public final class HappierComposerInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierComposerInput")
    View(HappierComposerInputView.self) {
      Events("onComposerChange", "onComposerSelection", "onComposerKeyPress", "onComposerSubmitEditing", "onComposerFocus", "onComposerBlur",
             "onComposerContentHeightChange", "onComposerScroll", "onComposerReferencePress", "onComposerDecorationPress", "onComposerAttachmentDrop")
      Prop("acceptsAttachmentDrops") { (view: HappierComposerInputView, value: Bool) in view.input.acceptsAttachmentDrops = value }
      Prop("attachmentDropScope") { (view: HappierComposerInputView, value: String) in view.input.attachmentDropScope = value }
      Prop("value") { (view: HappierComposerInputView, value: String) in view.pendingValue = value }
      Prop("mostRecentEventCount") { (view: HappierComposerInputView, value: Int) in view.mostRecentEventCount = value }
      Prop("references") { (view: HappierComposerInputView, value: [[String: Any]]) in view.pendingReferences = value }
      Prop("decorations") { (view: HappierComposerInputView, value: [[String: Any]]) in view.pendingDecorations = value }
      Prop("theme") { (view: HappierComposerInputView, value: [String: String]) in view.input.setTheme(value) }
      Prop("typography") { (view: HappierComposerInputView, value: [String: Any]) in view.input.setTypography(value) }
      Prop("padding") { (view: HappierComposerInputView, value: [String: Double]) in view.input.setPadding(value) }
      Prop("maxHeight") { (view: HappierComposerInputView, value: Double?) in view.input.maximumHeight = value.map { CGFloat($0) } }
      Prop("minHeight") { (view: HappierComposerInputView, value: Double?) in view.input.minimumHeight = value.map { CGFloat($0) } ?? 0 }
      Prop("editable") { (view: HappierComposerInputView, value: Bool) in view.input.isEditable = value }
      Prop("placeholder") { (view: HappierComposerInputView, value: String?) in view.input.placeholder = value ?? "" }
      Prop("referenceMenuLabels") { (view: HappierComposerInputView, value: [String: String]) in view.input.referenceMenuLabels = value }
      Prop("returnKeyType") { (view: HappierComposerInputView, value: String?) in
        view.input.returnKeyType = value == "send" ? .send : value == "done" ? .done : value == "go" ? .go : .default
      }
      Prop("submitBehavior") { (view: HappierComposerInputView, value: String?) in view.input.submitBehavior = value ?? "newline" }
      Prop("autoFocus") { (view: HappierComposerInputView, value: Bool) in view.autoFocus = value }
      Prop("accessibilityLabel") { (view: HappierComposerInputView, value: String?) in view.input.accessibilityLabel = value }
      Prop("accessibilityHint") { (view: HappierComposerInputView, value: String?) in view.input.composerAccessibilityHint = value }
      Prop("autoCorrect") { (view: HappierComposerInputView, value: Bool) in view.input.autocorrectionType = value ? .yes : .no }
      Prop("autoCapitalize") { (view: HappierComposerInputView, value: String?) in
        switch value {
        case "none": view.input.autocapitalizationType = .none
        case "words": view.input.autocapitalizationType = .words
        case "characters": view.input.autocapitalizationType = .allCharacters
        default: view.input.autocapitalizationType = .sentences
        }
      }
      Prop("initialScrollY") { (view: HappierComposerInputView, value: Double?) in view.input.restoreScrollY(value.map { CGFloat($0) } ?? 0) }
      Prop("scrollRestoreToken") { (view: HappierComposerInputView, value: String?) in view.input.setScrollRestoreToken(value) }
      OnViewDidUpdateProps { (view: HappierComposerInputView) in view.applyControlledProps() }
      AsyncFunction("focus") { (view: HappierComposerInputView) in view.input.becomeFirstResponder() }
      AsyncFunction("blur") { (view: HappierComposerInputView) in view.input.resignFirstResponder() }
      AsyncFunction("setTextAndSelection") { (view: HappierComposerInputView, text: String, selection: [String: Int], references: [[String: Any]]) in
        view.input.setTextAndSelection(text, selection: selection, references: references)
      }
      AsyncFunction("setSelection") { (view: HappierComposerInputView, selection: [String: Int]) in view.input.setSourceSelection(selection) }
      AsyncFunction("offsetAtPoint") { (view: HappierComposerInputView, x: Double, y: Double) -> Int? in
        view.input.sourceOffsetAtWindowPoint(x: CGFloat(x), y: CGFloat(y))
      }
      AsyncFunction("setDropCaret") { (view: HappierComposerInputView, offset: Int?) in view.input.setDropCaret(offset) }
      AsyncFunction("getCaretRect") { (view: HappierComposerInputView) -> [String: Double]? in view.input.sourceCaretRect() }
    }
  }
}
