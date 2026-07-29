package dev.happier.terminal

private const val TERMINAL_REPLACEMENT_CODE_POINT = 0xfffd

data class TermuxInputEvent(
  val surfaceId: String,
  val data: String,
)

data class TermuxRemoteInputBytes(
  val surfaceId: String,
  val bytes: ByteArray,
)

fun makeTermuxInputEvent(surfaceId: String, data: String): TermuxInputEvent? {
  if (surfaceId.isEmpty() || data.isEmpty()) return null
  return TermuxInputEvent(surfaceId = surfaceId, data = data)
}

fun makeTermuxRemoteInputBytes(surfaceId: String, bytes: ByteArray): TermuxRemoteInputBytes? {
  if (surfaceId.isEmpty() || bytes.isEmpty()) return null
  return TermuxRemoteInputBytes(surfaceId = surfaceId, bytes = bytes)
}

fun makeTermuxTextInputBytes(surfaceId: String, text: CharSequence): TermuxRemoteInputBytes? {
  val normalizedText = normalizeTermuxCommittedText(text)
  if (normalizedText.isEmpty()) return null
  return makeTermuxRemoteInputBytes(surfaceId, normalizedText.toByteArray(Charsets.UTF_8))
}

fun makeTermuxDeleteInputBytes(surfaceId: String, leftLength: Int): TermuxRemoteInputBytes? {
  if (leftLength <= 0) return null
  return makeTermuxRemoteInputBytes(surfaceId, ByteArray(leftLength) { 0x7f.toByte() })
}

fun normalizeTermuxCommittedText(text: CharSequence): String {
  if (text.isEmpty()) return ""

  val output = StringBuilder(text.length)
  var index = 0
  while (index < text.length) {
    val first = text[index]
    val codePoint = if (Character.isHighSurrogate(first)) {
      if (index + 1 < text.length && Character.isLowSurrogate(text[index + 1])) {
        index += 1
        Character.toCodePoint(first, text[index])
      } else {
        TERMINAL_REPLACEMENT_CODE_POINT
      }
    } else {
      first.code
    }

    output.appendCodePoint(if (codePoint == '\n'.code) '\r'.code else codePoint)
    index += 1
  }
  return output.toString()
}
