package dev.happier.terminal

enum class TermuxSelectionState {
  STARTED,
  CHANGED,
  ENDED,
  CLEARED,
  COPIED,
}

data class TermuxSelectionEvent(
  val surfaceId: String,
  val state: TermuxSelectionState,
  val text: String?,
)

fun makeTermuxSelectionEvent(
  surfaceId: String,
  state: TermuxSelectionState,
  text: String? = null,
): TermuxSelectionEvent? {
  if (surfaceId.isEmpty()) return null
  return TermuxSelectionEvent(surfaceId = surfaceId, state = state, text = text)
}
