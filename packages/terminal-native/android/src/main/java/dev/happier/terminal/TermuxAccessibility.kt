package dev.happier.terminal

data class TermuxAccessibilityDiagnostic(
  val accepted: Boolean,
  val reason: String,
  val fallbackRenderer: String,
  val summaryStrategy: String,
)

fun makeTermuxAccessibilityDiagnostic(): TermuxAccessibilityDiagnostic {
  return TermuxAccessibilityDiagnostic(
    accepted = false,
    reason = "custom-accessibility-model-unproven",
    fallbackRenderer = "xterm-webview",
    summaryStrategy = "host-provided-terminal-summary-required-before-native-default",
  )
}
