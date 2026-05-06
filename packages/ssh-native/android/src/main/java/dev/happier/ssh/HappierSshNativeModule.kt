package dev.happier.ssh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierSshNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierSshNative")

    Events("hostKeyPrompt", "progress")

    Function("getAvailability") {
      return@Function HappierSshNativeBridge.availability()
    }

    AsyncFunction("exec") { _: Map<String, Any> ->
      throw IllegalStateException(HappierSshNativeBridge.unavailableDetail)
    }
  }
}
