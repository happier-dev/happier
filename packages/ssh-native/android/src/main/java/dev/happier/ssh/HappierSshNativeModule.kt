package dev.happier.ssh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class HappierSshNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierSshNative")

    Events("hostKeyPrompt", "authPrompt", "progress")

    Function("getAvailability") {
      return@Function HappierSshNativeBridge.availability()
    }

    AsyncFunction("exec").SuspendBody { request: Map<String, Any?> ->
      withContext(Dispatchers.IO) {
        HappierSshNativeBridge.exec(this@HappierSshNativeModule, request)
      }
    }

    AsyncFunction("respondToHostKeyPrompt") { promptId: String, response: Map<String, Any?> ->
      return@AsyncFunction HappierSshNativeBridge.respondToHostKeyPrompt(promptId, response)
    }

    AsyncFunction("respondToAuthPrompt") { promptId: String, response: Map<String, Any?> ->
      return@AsyncFunction HappierSshNativeBridge.respondToAuthPrompt(promptId, response)
    }

    AsyncFunction("cancelRequest") { requestId: String ->
      return@AsyncFunction HappierSshNativeBridge.cancelRequest(requestId)
    }

    AsyncFunction("startLoopbackTunnel").SuspendBody { request: Map<String, Any?> ->
      withContext(Dispatchers.IO) {
        HappierSshNativeBridge.startLoopbackTunnel(this@HappierSshNativeModule, request)
      }
    }

    AsyncFunction("stopLoopbackTunnel") { nativeTunnelId: String ->
      return@AsyncFunction HappierSshNativeBridge.stopLoopbackTunnel(nativeTunnelId)
    }
  }
}
