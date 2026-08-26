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

  func update(
    summary: String,
    accepted: Bool,
    terminalLabel: String,
    fallbackValue: String,
    focusActionLabel: String,
    copySelectionActionLabel: String
  ) {
    self.summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    self.isAccepted = accepted
    self.terminalLabel = terminalLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    self.fallbackValue = fallbackValue.trimmingCharacters(in: .whitespacesAndNewlines)
    self.focusActionLabel = focusActionLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    self.copySelectionActionLabel = copySelectionActionLabel.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func accessibilityElements(for surfaceView: GhosttySurfaceView) -> [UIAccessibilityElement] {
    guard !terminalLabel.isEmpty,
          !fallbackValue.isEmpty,
          !focusActionLabel.isEmpty,
          !copySelectionActionLabel.isEmpty else {
      return []
    }
    let element = UIAccessibilityElement(accessibilityContainer: surfaceView)
    element.accessibilityFrameInContainerSpace = surfaceView.bounds
    element.accessibilityTraits = [.staticText, .updatesFrequently]
    element.accessibilityLabel = terminalLabel
    element.accessibilityValue = summary.isEmpty
      ? fallbackValue
      : summary
    element.accessibilityCustomActions = [
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
    return [element]
  }

  func apply(to surfaceView: GhosttySurfaceView) {
    surfaceView.isAccessibilityElement = false
    surfaceView.accessibilityElements = accessibilityElements(for: surfaceView)
  }
}
