package dev.happier.ssh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.exception.CodedException
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

object HappierSshNativeBridge {
  private const val MODULE_VERSION = "0.0.0"
  private val promptResponses = ConcurrentHashMap<String, CompletableFuture<Map<String, Any?>>>()
  private val rustLibraryLoaded: Boolean by lazy {
    runCatching { System.loadLibrary("happier_ssh_native") }.isSuccess
  }

  fun availability(): Map<String, Any> {
    if (!rustLibraryLoaded) {
      return mapOf(
        "available" to false,
        "reason" to "engine-unavailable",
        "detail" to "HappierSshNative russh core is not linked in this build."
      )
    }
    return mapOf(
      "available" to true,
      "platform" to "android",
      "engine" to "russh",
      "moduleVersion" to MODULE_VERSION,
      "supportsLoopbackTunnel" to true,
      "supportsPersistentHostKeyStorage" to false
    )
  }

  fun respondToHostKeyPrompt(promptId: String, response: Map<String, Any?>) {
    promptResponses.remove(promptId)?.complete(response)
  }

  fun respondToAuthPrompt(promptId: String, response: Map<String, Any?>) {
    promptResponses.remove(promptId)?.complete(response)
  }

  fun cancelRequest(requestId: String) {
    val trimmedRequestId = requestId.trim()
    val cancellablePromptIds = setOf(
      "host-key-$trimmedRequestId",
      "auth-passphrase-$trimmedRequestId",
      "auth-kbi-$trimmedRequestId"
    )
    promptResponses.entries
      .filter { cancellablePromptIds.contains(it.key) }
      .forEach { entry ->
        promptResponses.remove(entry.key)?.complete(mapOf(
          "decision" to "reject",
          "reason" to "Native SSH request was cancelled."
        ))
      }
    if (rustLibraryLoaded) {
      HappierSshNativeRust.cancelRequestJson(requestId)
    }
  }

  fun exec(module: Module, request: Map<String, Any?>): Map<String, Any?> {
    if (!rustLibraryLoaded) {
      throw NativeSshException("engine-unavailable", "HappierSshNative russh core is not linked in this build.")
    }
    return withProgress(module, request, "connecting") {
      val response = callRustWithPrompts(module, request) { requestJson ->
        HappierSshNativeRust.execJson(requestJson)
      }
      jsonObjectToMap(response)
    }
  }

  fun startLoopbackTunnel(module: Module, request: Map<String, Any?>): Map<String, Any?> {
    if (!rustLibraryLoaded) {
      throw NativeSshException("engine-unavailable", "HappierSshNative russh core is not linked in this build.")
    }
    return withProgress(module, request, "connecting") {
      val response = callRustWithPrompts(module, request) { requestJson ->
        HappierSshNativeRust.startLoopbackTunnelJson(requestJson)
      }
      jsonObjectToMap(response)
    }
  }

  private fun callRustWithPrompts(
    module: Module,
    request: Map<String, Any?>,
    operation: (String) -> String,
  ): JSONObject {
    var currentRequest = request
    repeat(8) {
      val response = callRust(currentRequest, operation)
      if (response.optBoolean("ok", false)) {
        return response.getJSONObject("result")
      }
      val error = response.optJSONObject("error")
      val code = error?.optString("code") ?: "engine-internal"
      val hostKeyPrompt = error?.optJSONObject("hostKeyPrompt")
      val authPrompt = error?.optJSONObject("authPrompt")
      if ((code == "host-key-untrusted" || code == "host-key-mismatch") && hostKeyPrompt != null) {
        val promptResponse = waitForPromptResponse(
          module,
          currentRequest,
          "hostKeyPrompt",
          hostKeyPrompt,
          "verifying-host-key",
          "host-key-untrusted",
          "SSH host key trust prompt timed out."
        )
        if (promptResponse["decision"] == "reject") {
          throw NativeSshException("host-key-rejected", "SSH host key trust was declined.")
        }
        currentRequest = currentRequest.toMutableMap().also {
          it["hostKeyVerification"] = promptResponse
        }
        return@repeat
      }
      if (code == "auth-prompt-required" && authPrompt != null) {
        val promptResponse = waitForPromptResponse(
          module,
          currentRequest,
          "authPrompt",
          authPrompt,
          "authenticating",
          "authentication-failed",
          "SSH authentication prompt timed out."
        )
        if (promptResponse["decision"] == "cancel" || promptResponse["decision"] == "reject") {
          throw NativeSshException("auth-prompt-cancelled", "SSH authentication prompt was cancelled.")
        }
        currentRequest = retryRequestWithAuthPromptResponse(currentRequest, promptResponse)
        return@repeat
      }
      throw NativeSshException(
        code,
        error?.optString("message") ?: "Native SSH engine failed."
      )
    }
    throw NativeSshException("authentication-failed", "SSH authentication required too many prompt rounds.")
  }

  private fun waitForPromptResponse(
    module: Module,
    request: Map<String, Any?>,
    eventName: String,
    prompt: JSONObject,
    phase: String,
    timeoutCode: String,
    timeoutMessage: String,
  ): Map<String, Any?> {
    val promptId = prompt.getString("promptId")
    val future = CompletableFuture<Map<String, Any?>>()
    promptResponses[promptId] = future
    sendProgress(module, request, phase)
    module.sendEvent(eventName, jsonObjectToMap(prompt))
    return try {
      future.get(readPositiveLong(request, "authTimeoutMs", 15_000L), TimeUnit.MILLISECONDS)
    } catch (_: TimeoutException) {
      throw NativeSshException(timeoutCode, timeoutMessage)
    } finally {
      promptResponses.remove(promptId)
    }
  }

  private fun retryRequestWithAuthPromptResponse(
    request: Map<String, Any?>,
    response: Map<String, Any?>,
  ): Map<String, Any?> {
    val retryRequest = request.toMutableMap()
    val auth = mutableMapOf<String, Any?>()
    (request["auth"] as? Map<*, *>)?.forEach { entry ->
      auth[entry.key.toString()] = entry.value
    }
    val value = response["value"]
    if (value is String) {
      auth["privateKeyPassphrase"] = value
      val previousAttempts = (auth["privateKeyPassphraseAttempts"] as? Number)?.toInt() ?: 0
      auth["privateKeyPassphraseAttempts"] = previousAttempts + 1
    }
    val promptAnswers = response["answers"]
    if (promptAnswers is Iterable<*>) {
      val existingAnswers = (auth["keyboardInteractiveAnswers"] as? Iterable<*>)
        ?.mapNotNull { it as? String }
        ?: emptyList()
      val newAnswers = promptAnswers.mapNotNull { entry ->
        (entry as? Map<*, *>)?.get("value") as? String
      }
      auth["keyboardInteractiveAnswers"] = existingAnswers + newAnswers
    }
    retryRequest["auth"] = auth
    return retryRequest
  }

  private fun callRust(request: Map<String, Any?>, operation: (String) -> String): JSONObject {
    return JSONObject(operation(toJsonValue(request).toString()))
  }

  fun stopLoopbackTunnel(nativeTunnelId: String) {
    if (rustLibraryLoaded) {
      HappierSshNativeRust.stopLoopbackTunnelJson(nativeTunnelId)
    }
  }

  private fun <T> withProgress(
    module: Module,
    request: Map<String, Any?>,
    phase: String,
    operation: () -> T,
  ): T {
    sendProgress(module, request, phase)
    try {
      return operation()
    } finally {
      sendProgress(module, request, "closing")
    }
  }

  private fun sendProgress(module: Module, request: Map<String, Any?>, phase: String) {
    module.sendEvent("progress", mapOf(
      "requestId" to readString(request, "requestId"),
      "phase" to phase,
      "host" to readString(request, "host"),
      "port" to readPositiveInt(request, "port", 22),
    ))
  }
}

object HappierSshNativeRust {
  external fun execJson(requestJson: String): String
  external fun startLoopbackTunnelJson(requestJson: String): String
  external fun stopLoopbackTunnelJson(nativeTunnelId: String): String
  external fun cancelRequestJson(requestId: String): String
}

class NativeSshException(
  val nativeSshCode: String,
  message: String
) : CodedException(nativeSshCode, message, null)

private fun toJsonValue(value: Any?): Any {
  return when (value) {
    null -> JSONObject.NULL
    is Map<*, *> -> {
      val json = JSONObject()
      value.forEach { entry -> json.put(entry.key.toString(), toJsonValue(entry.value)) }
      json
    }
    is Iterable<*> -> {
      val json = JSONArray()
      value.forEach { item -> json.put(toJsonValue(item)) }
      json
    }
    is Array<*> -> {
      val json = JSONArray()
      value.forEach { item -> json.put(toJsonValue(item)) }
      json
    }
    else -> value
  }
}

private fun jsonObjectToMap(json: JSONObject): Map<String, Any?> {
  val result = mutableMapOf<String, Any?>()
  val keys = json.keys()
  while (keys.hasNext()) {
    val key = keys.next()
    result[key] = fromJsonValue(json.get(key))
  }
  return result
}

private fun fromJsonValue(value: Any?): Any? {
  return when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> jsonObjectToMap(value)
    is JSONArray -> (0 until value.length()).map { index -> fromJsonValue(value.get(index)) }
    else -> value
  }
}

private fun readPositiveLong(value: Map<String, Any?>, key: String, fallback: Long): Long {
  val raw = value[key]
  return when (raw) {
    is Number -> raw.toLong()
    is String -> raw.toLongOrNull()
    else -> null
  }?.takeIf { it > 0 } ?: fallback
}

private fun readPositiveInt(value: Map<String, Any?>, key: String, fallback: Int): Int {
  val raw = value[key]
  return when (raw) {
    is Number -> raw.toInt()
    is String -> raw.toIntOrNull()
    else -> null
  }?.takeIf { it > 0 && it <= 65_535 } ?: fallback
}

private fun readString(value: Map<String, Any?>, key: String): String {
  return (value[key] as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: ""
}
