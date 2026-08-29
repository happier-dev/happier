package dev.happier.iroh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Lifecycle/status only; native Rust owns all stream bytes. */
class HappierIrohNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierIrohNative")
    Function("getAvailability") { mapOf("available" to false, "platform" to "android", "engine" to "iroh", "supportsHomeTunnel" to false) }
    AsyncFunction("startHomeTunnel") { _: Map<String, Any?> -> throw IllegalStateException("Iroh native engine is not linked in this build.") }
    AsyncFunction("stopHomeTunnel") { _: String -> Unit }
    AsyncFunction("getHomeTunnelStatus") { _: String -> null }
  }
}
