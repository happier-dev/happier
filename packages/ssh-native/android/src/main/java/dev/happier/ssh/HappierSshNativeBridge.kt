package dev.happier.ssh

object HappierSshNativeBridge {
  const val unavailableDetail = "Native SSH Phase 0 engine selection is not complete."

  fun availability(): Map<String, Any> {
    return mapOf(
      "available" to false,
      "reason" to "engine-unavailable",
      "detail" to unavailableDetail
    )
  }
}
