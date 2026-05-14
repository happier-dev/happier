package dev.happier.hardwarekeyboardshortcuts

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierHardwareKeyboardShortcutsModule : Module() {
  @Volatile
  private var hardwareKeyEventsEnabled = false

  @Volatile
  private var hasHardwareKeyListener = false

  @Volatile
  private var nativeConsumableEventSignatures = emptySet<String>()

  override fun definition() = ModuleDefinition {
    Name("HappierHardwareKeyboardShortcuts")

    Events("hardwareKey")

    // Expo calls these at first-listener/zero-listener boundaries; the bridge
    // must not consume Activity keys unless JS has a live native listener.
    OnStartObserving("hardwareKey") {
      hasHardwareKeyListener = true
      updateBridgeRegistration()
    }

    OnStopObserving("hardwareKey") {
      hasHardwareKeyListener = false
      updateBridgeRegistration()
    }

    AsyncFunction("setHardwareKeyEventsEnabled") { enabled: Boolean ->
      hardwareKeyEventsEnabled = enabled
      updateBridgeRegistration()
    }

    AsyncFunction("setHardwareKeyConsumableEventSignatures") { signatures: List<String> ->
      nativeConsumableEventSignatures = signatures.toSet()
    }
  }

  fun canReceiveHardwareKeyEvents(): Boolean = hardwareKeyEventsEnabled && hasHardwareKeyListener

  fun emitHardwareKey(payload: Map<String, Any>) {
    sendEvent("hardwareKey", payload)
  }

  fun shouldConsumeHardwareKey(payload: Map<String, Any>): Boolean =
    nativeConsumableEventSignatures.contains(signatureForPayload(payload))

  private fun signatureForPayload(payload: Map<String, Any>): String {
    val key = payload["key"] as? String ?: "Unidentified"
    val modifiers = payload["modifiers"] as? Map<*, *> ?: emptyMap<String, Boolean>()
    return listOf(
      key,
      "shift=${modifiers["shift"] == true}",
      "ctrl=${modifiers["ctrl"] == true}",
      "meta=${modifiers["meta"] == true}",
      "alt=${modifiers["alt"] == true}"
    ).joinToString("|")
  }

  private fun updateBridgeRegistration() {
    HappierHardwareKeyboardShortcutsBridge.setModule(this)
    HappierHardwareKeyboardShortcutsBridge.setEnabled(canReceiveHardwareKeyEvents())
  }
}
