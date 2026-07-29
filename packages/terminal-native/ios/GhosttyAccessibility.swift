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

  func update(summary: String, accepted: Bool) {
    self.summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    self.isAccepted = accepted
  }

  func accessibilityElements(for surfaceView: GhosttySurfaceView) -> [UIAccessibilityElement] {
    let element = UIAccessibilityElement(accessibilityContainer: surfaceView)
    element.accessibilityFrameInContainerSpace = surfaceView.bounds
    element.accessibilityTraits = [.staticText, .updatesFrequently]
    element.accessibilityLabel = "Terminal"
    element.accessibilityValue = summary.isEmpty
      ? "Native terminal renderer unavailable. xterm WebView fallback is required for accessible terminal content."
      : summary
    element.accessibilityCustomActions = [
      UIAccessibilityCustomAction(
        name: "Focus terminal",
        target: surfaceView,
        selector: #selector(GhosttySurfaceView.accessibilityFocusTerminalAction)
      ),
      UIAccessibilityCustomAction(
        name: "Copy selection",
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
