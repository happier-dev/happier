import UIKit

func makeGhosttyAccessibilitySummary(_ value: String, maxCharacters: Int = 4096) -> String {
  let cleaned = value
    .replacingOccurrences(of: "\u{0000}", with: "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard cleaned.count > maxCharacters else { return cleaned }
  return String(cleaned.prefix(maxCharacters))
}

final class GhosttyAccessibilityModel {
  private(set) var summary: String = ""
  private(set) var isAccepted = false
  private(set) var terminalLabel = ""
  private(set) var fallbackValue = ""
  private(set) var focusActionLabel = ""
  private(set) var copySelectionActionLabel = ""
  private(set) var selectAllActionLabel = ""
  private(set) var openLinkActionLabel = ""

  func update(
    summary: String,
    accepted: Bool,
    terminalLabel: String,
    fallbackValue: String,
    focusActionLabel: String,
    copySelectionActionLabel: String,
    selectAllActionLabel: String,
    openLinkActionLabel: String
  ) {
    self.summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    self.isAccepted = accepted
    self.terminalLabel = terminalLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    self.fallbackValue = fallbackValue.trimmingCharacters(in: .whitespacesAndNewlines)
    self.focusActionLabel = focusActionLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    self.copySelectionActionLabel = copySelectionActionLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    self.selectAllActionLabel = selectAllActionLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    self.openLinkActionLabel = openLinkActionLabel.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func apply(to surfaceView: GhosttySurfaceView) {
    guard isAccepted,
          !terminalLabel.isEmpty,
          !fallbackValue.isEmpty,
          !focusActionLabel.isEmpty,
          !copySelectionActionLabel.isEmpty else {
      surfaceView.isAccessibilityElement = false
      surfaceView.accessibilityLabel = nil
      surfaceView.accessibilityValue = nil
      surfaceView.accessibilityCustomActions = nil
      return
    }

    let exposedSummary = summary.isEmpty ? fallbackValue : summary
    // UIKit owns UITextInput value semantics, so XCTest and VoiceOver do not
    // reliably expose a separately assigned value. Include the bounded current
    // viewport in the node label while retaining the value for clients that do.
    surfaceView.isAccessibilityElement = true
    surfaceView.accessibilityTraits = [.staticText, .updatesFrequently]
    surfaceView.accessibilityLabel = "\(terminalLabel). \(exposedSummary)"
    surfaceView.accessibilityValue = exposedSummary
    var actions = [
      UIAccessibilityCustomAction(
        name: focusActionLabel,
        target: surfaceView,
        selector: #selector(GhosttySurfaceView.accessibilityFocusTerminalAction)
      ),
      UIAccessibilityCustomAction(
        name: copySelectionActionLabel,
        target: surfaceView,
        selector: #selector(GhosttySurfaceView.accessibilityCopySelectionAction)
      ),
    ]
    if !selectAllActionLabel.isEmpty {
      actions.append(UIAccessibilityCustomAction(
        name: selectAllActionLabel,
        target: surfaceView,
        selector: #selector(GhosttySurfaceView.accessibilitySelectAllAction)
      ))
    }
    if !openLinkActionLabel.isEmpty {
      actions.append(UIAccessibilityCustomAction(
        name: openLinkActionLabel,
        target: surfaceView,
        selector: #selector(GhosttySurfaceView.accessibilityOpenLinkAction)
      ))
    }
    surfaceView.accessibilityCustomActions = actions
  }
}
