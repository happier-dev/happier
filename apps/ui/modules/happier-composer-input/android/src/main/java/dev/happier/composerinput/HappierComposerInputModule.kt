package dev.happier.composerinput

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierComposerInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierComposerInput")
    View(HappierComposerInputView::class) {
      Events("onComposerChange", "onComposerSelection", "onComposerKeyPress", "onComposerSubmitEditing", "onComposerFocus", "onComposerBlur", "onComposerContentHeightChange", "onComposerScroll", "onComposerReferencePress", "onComposerDecorationPress", "onComposerAttachmentDrop")
      Prop("acceptsAttachmentDrops") { view: HappierComposerInputView, value: Boolean -> view.editor.acceptsAttachmentDrops = value }
      Prop("attachmentDropScope") { view: HappierComposerInputView, value: String -> view.editor.attachmentDropScope = value }
      Prop("value") { view: HappierComposerInputView, value: String -> view.stageValue(value) }
      Prop("mostRecentEventCount") { view: HappierComposerInputView, value: Int -> view.stageEventCount(value) }
      Prop("references") { view: HappierComposerInputView, value: List<Map<String, Any?>> -> view.stageReferences(value) }
      Prop("decorations") { view: HappierComposerInputView, value: List<Map<String, Any?>> -> view.stageDecorations(value) }
      Prop("theme") { view: HappierComposerInputView, value: Map<String, Any?> -> view.editor.setThemeTokens(value) }
      Prop("typography") { view: HappierComposerInputView, value: Map<String, Any?> -> view.editor.setTypographyTokens(value) }
      Prop("padding") { view: HappierComposerInputView, value: Map<String, Any?> -> view.editor.setPaddingTokens(value) }
      Prop("minHeight") { view: HappierComposerInputView, value: Double? -> view.editor.minHeight = ((value ?: 0.0) * view.resources.displayMetrics.density).toInt() }
      Prop("maxHeight") { view: HappierComposerInputView, value: Double? -> view.editor.maxHeight = value?.let { (it * view.resources.displayMetrics.density).toInt() } ?: Int.MAX_VALUE }
      Prop("editable") { view: HappierComposerInputView, value: Boolean -> view.setEditable(value) }
      Prop("forwardHardwareBack") { view: HappierComposerInputView, value: Boolean -> view.editor.forwardHardwareBack = value }
      Prop("placeholder") { view: HappierComposerInputView, value: String? -> view.editor.hint = value }
      Prop("referenceMenuLabels") { view: HappierComposerInputView, value: Map<String, String> -> view.editor.referenceMenuLabels = value }
      Prop("returnKeyType") { view: HappierComposerInputView, value: String -> view.setReturnKeyType(value) }
      Prop("submitBehavior") { view: HappierComposerInputView, value: String -> view.editor.submitBehavior = value }
      Prop("autoFocus") { view: HappierComposerInputView, value: Boolean -> view.setAutoFocus(value) }
      Prop("autoCorrect") { view: HappierComposerInputView, value: Boolean -> view.editor.setAutocorrect(value) }
      Prop("autoCapitalize") { view: HappierComposerInputView, value: String -> view.editor.setAutocapitalize(value) }
      Prop("accessibilityLabel") { view: HappierComposerInputView, value: String? -> view.editor.contentDescription = value }
      Prop("accessibilityHint") { view: HappierComposerInputView, value: String? -> view.editor.composerAccessibilityHint = value }
      Prop("initialScrollY") { view: HappierComposerInputView, value: Double? -> view.setInitialScrollY(value ?: 0.0) }
      Prop("scrollRestoreToken") { view: HappierComposerInputView, value: String? -> view.setScrollRestoreToken(value) }
      AsyncFunction("focus") { view: HappierComposerInputView -> view.focusEditor() }
      AsyncFunction("blur") { view: HappierComposerInputView -> view.blurEditor() }
      AsyncFunction("setTextAndSelection") { view: HappierComposerInputView, text: String, selection: Map<String, Int>, references: List<Map<String, Any?>> -> view.editor.setTextAndSelection(text, selection, references) }
      AsyncFunction("setSelection") { view: HappierComposerInputView, selection: Map<String, Int> -> view.editor.setSourceSelection(selection) }
      AsyncFunction("offsetAtPoint") { view: HappierComposerInputView, x: Double, y: Double -> view.editor.offsetAtWindowPoint(x.toFloat(), y.toFloat()) }
      AsyncFunction("setDropCaret") { view: HappierComposerInputView, offset: Int? -> view.editor.setDropCaret(offset) }
      AsyncFunction("getCaretRect") { view: HappierComposerInputView -> view.editor.caretRect() }
      OnViewDidUpdateProps { view: HappierComposerInputView -> view.applyControlledProps() }
    }
  }
}
