import ExpoModulesCore
import Foundation

@_silgen_name("happier_ssh_native_exec_json")
private func happierSshNativeExecJson(_ requestJson: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

@_silgen_name("happier_ssh_native_start_loopback_tunnel_json")
private func happierSshNativeStartLoopbackTunnelJson(_ requestJson: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

@_silgen_name("happier_ssh_native_stop_loopback_tunnel_json")
private func happierSshNativeStopLoopbackTunnelJson(_ tunnelId: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

@_silgen_name("happier_ssh_native_cancel_request_json")
private func happierSshNativeCancelRequestJson(_ requestId: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

@_silgen_name("happier_ssh_native_free_string")
private func happierSshNativeFreeString(_ value: UnsafeMutablePointer<CChar>?)

public enum HappierSshNativeBridge {
  private static let moduleVersion = "0.0.0"
  private static let rustWorkQueue = DispatchQueue(
    label: "dev.happier.ssh-native.rust-work",
    qos: .userInitiated,
    attributes: .concurrent
  )
  fileprivate static let promptLock = NSLock()
  fileprivate static var promptResponses: [String: HostKeyPromptWaiter] = [:]

  public static func availability() -> [String: Any] {
    [
      "available": true,
      "platform": "ios",
      "engine": "russh",
      "moduleVersion": moduleVersion,
      "supportsLoopbackTunnel": true,
      "supportsPersistentHostKeyStorage": false,
    ]
  }

  public static func respondToHostKeyPrompt(promptId: String, response: [String: Any]) {
    promptLock.lock()
    let waiter = promptResponses.removeValue(forKey: promptId)
    promptLock.unlock()
    waiter?.complete(response)
  }

  public static func respondToAuthPrompt(promptId: String, response: [String: Any]) {
    promptLock.lock()
    let waiter = promptResponses.removeValue(forKey: promptId)
    promptLock.unlock()
    waiter?.complete(response)
  }

  public static func cancelRequest(requestId: String) {
    let trimmedRequestId = requestId.trimmingCharacters(in: .whitespacesAndNewlines)
    let cancellablePromptIds = Set([
      "host-key-\(trimmedRequestId)",
      "auth-passphrase-\(trimmedRequestId)",
      "auth-kbi-\(trimmedRequestId)",
    ])
    promptLock.lock()
    let matchingPromptIds = promptResponses.keys.filter { cancellablePromptIds.contains($0) }
    let waiters = matchingPromptIds.compactMap { promptResponses.removeValue(forKey: $0) }
    promptLock.unlock()
    for waiter in waiters {
      waiter.complete([
        "decision": "reject",
        "reason": "Native SSH request was cancelled.",
      ])
    }
    requestId.withCString { pointer in
      if let response = happierSshNativeCancelRequestJson(pointer) {
        happierSshNativeFreeString(response)
      }
    }
  }

  public static func exec(module: Module, request: [String: Any]) throws -> [String: Any] {
    try withProgress(module: module, request: request, phase: "connecting") {
      try callRustJsonWithPrompts(module: module, request: request, happierSshNativeExecJson)
    }
  }

  public static func execAsync(module: Module, request: [String: Any]) async throws -> [String: Any] {
    try await runBlockingRustWork {
      try exec(module: module, request: request)
    }
  }

  public static func startLoopbackTunnel(module: Module, request: [String: Any]) throws -> [String: Any] {
    try withProgress(module: module, request: request, phase: "connecting") {
      try callRustJsonWithPrompts(module: module, request: request, happierSshNativeStartLoopbackTunnelJson)
    }
  }

  public static func startLoopbackTunnelAsync(module: Module, request: [String: Any]) async throws -> [String: Any] {
    try await runBlockingRustWork {
      try startLoopbackTunnel(module: module, request: request)
    }
  }

  public static func stopLoopbackTunnel(nativeTunnelId: String) {
    nativeTunnelId.withCString { pointer in
      if let response = happierSshNativeStopLoopbackTunnelJson(pointer) {
        happierSshNativeFreeString(response)
      }
    }
  }

  private static func runBlockingRustWork<T>(_ operation: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      rustWorkQueue.async {
        do {
          continuation.resume(returning: try operation())
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }
}

private func withProgress<T>(
  module: Module,
  request: [String: Any],
  phase: String,
  operation: () throws -> T
) throws -> T {
  sendProgress(module: module, request: request, phase: phase)
  defer {
    sendProgress(module: module, request: request, phase: "closing")
  }
  return try operation()
}

private func callRustJsonWithPrompts(
  module: Module,
  request: [String: Any],
  _ function: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
) throws -> [String: Any] {
  var currentRequest = request
  for _ in 0..<8 {
    let response = try callRustEnvelope(currentRequest, function)
    if response["ok"] as? Bool == true {
      guard let result = response["result"] as? [String: Any] else {
        throw nativeSshError(code: "engine-internal", message: "Native SSH engine returned an invalid result.")
      }
      return result
    }

    guard let error = response["error"] as? [String: Any] else {
      throw nativeSshError(code: "engine-internal", message: "Native SSH engine failed.")
    }
    let code = error["code"] as? String ?? "engine-internal"
    if (code == "host-key-untrusted" || code == "host-key-mismatch"),
       let prompt = error["hostKeyPrompt"] as? [String: Any] {
      let promptResponse = try waitForPromptResponse(
        module: module,
        request: currentRequest,
        eventName: "hostKeyPrompt",
        prompt: prompt,
        phase: "verifying-host-key",
        timeoutCode: "host-key-untrusted",
        timeoutMessage: "SSH host key trust prompt timed out."
      )
      if promptResponse["decision"] as? String == "reject" {
        throw nativeSshError(code: "host-key-rejected", message: "SSH host key trust was declined.")
      }
      currentRequest["hostKeyVerification"] = promptResponse
      continue
    }
    if code == "auth-prompt-required",
       let prompt = error["authPrompt"] as? [String: Any] {
      let promptResponse = try waitForPromptResponse(
        module: module,
        request: currentRequest,
        eventName: "authPrompt",
        prompt: prompt,
        phase: "authenticating",
        timeoutCode: "authentication-failed",
        timeoutMessage: "SSH authentication prompt timed out."
      )
      let decision = promptResponse["decision"] as? String
      if decision == "cancel" || decision == "reject" {
        throw nativeSshError(code: "auth-prompt-cancelled", message: "SSH authentication prompt was cancelled.")
      }
      currentRequest = retryRequestWithAuthPromptResponse(currentRequest, promptResponse)
      continue
    }
    throw nativeSshError(
      code: code,
      message: error["message"] as? String ?? "Native SSH engine failed."
    )
  }
  throw nativeSshError(code: "authentication-failed", message: "SSH authentication required too many prompt rounds.")
}

private func waitForPromptResponse(
  module: Module,
  request: [String: Any],
  eventName: String,
  prompt: [String: Any],
  phase: String,
  timeoutCode: String,
  timeoutMessage: String
) throws -> [String: Any] {
  guard let promptId = prompt["promptId"] as? String else {
    throw nativeSshError(code: "engine-internal", message: "Native SSH engine returned an invalid prompt.")
  }
  let waiter = HostKeyPromptWaiter()
  HappierSshNativeBridge.promptLock.lock()
  HappierSshNativeBridge.promptResponses[promptId] = waiter
  HappierSshNativeBridge.promptLock.unlock()
  sendProgress(module: module, request: request, phase: phase)
  module.sendEvent(eventName, prompt)
  let authTimeoutMs = readPositiveInt(request, "authTimeoutMs", fallback: 15_000)
  guard let response = waiter.wait(timeoutMs: authTimeoutMs) else {
    HappierSshNativeBridge.promptLock.lock()
    HappierSshNativeBridge.promptResponses.removeValue(forKey: promptId)
    HappierSshNativeBridge.promptLock.unlock()
    throw nativeSshError(code: timeoutCode, message: timeoutMessage)
  }
  return response
}

private func retryRequestWithAuthPromptResponse(
  _ request: [String: Any],
  _ response: [String: Any]
) -> [String: Any] {
  var retryRequest = request
  var auth = request["auth"] as? [String: Any] ?? [:]
  if let value = response["value"] as? String {
    auth["privateKeyPassphrase"] = value
    let previousAttempts = (auth["privateKeyPassphraseAttempts"] as? NSNumber)?.intValue
      ?? auth["privateKeyPassphraseAttempts"] as? Int
      ?? 0
    auth["privateKeyPassphraseAttempts"] = previousAttempts + 1
  }
  if let answers = response["answers"] as? [[String: Any]] {
    let existingAnswers = auth["keyboardInteractiveAnswers"] as? [String] ?? []
    let newAnswers = answers.compactMap { $0["value"] as? String }
    auth["keyboardInteractiveAnswers"] = existingAnswers + newAnswers
  }
  retryRequest["auth"] = auth
  return retryRequest
}

private func sendProgress(module: Module, request: [String: Any], phase: String) {
  module.sendEvent("progress", [
    "requestId": readString(request, "requestId"),
    "phase": phase,
    "host": readString(request, "host"),
    "port": readPositiveInt(request, "port", fallback: 22),
  ])
}

private func callRustJson(
  _ request: [String: Any],
  _ function: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
) throws -> [String: Any] {
  let response = try callRustEnvelope(request, function)
  if response["ok"] as? Bool == true {
    guard let result = response["result"] as? [String: Any] else {
      throw nativeSshError(code: "engine-internal", message: "Native SSH engine returned an invalid result.")
    }
    return result
  }
  let error = response["error"] as? [String: Any]
  throw nativeSshError(
    code: error?["code"] as? String ?? "engine-internal",
    message: error?["message"] as? String ?? "Native SSH engine failed."
  )
}

private func callRustEnvelope(
  _ request: [String: Any],
  _ function: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
) throws -> [String: Any] {
  let requestJson = try jsonString(request)
  guard let responsePointer = requestJson.withCString({ function($0) }) else {
    throw nativeSshError(code: "engine-internal", message: "Native SSH engine returned no result.")
  }
  defer { happierSshNativeFreeString(responsePointer) }

  let responseJson = String(cString: responsePointer)
  guard
    let responseData = responseJson.data(using: .utf8),
    let response = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
  else {
    throw nativeSshError(code: "engine-internal", message: "Native SSH engine returned an invalid result.")
  }
  return response
}

private func jsonString(_ value: [String: Any]) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: value, options: [])
  guard let text = String(data: data, encoding: .utf8) else {
    throw nativeSshError(code: "engine-internal", message: "Invalid native SSH request.")
  }
  return text
}

private final class HostKeyPromptWaiter {
  private let condition = NSCondition()
  private var response: [String: Any]?

  func complete(_ response: [String: Any]) {
    condition.lock()
    self.response = response
    condition.signal()
    condition.unlock()
  }

  func wait(timeoutMs: Int) -> [String: Any]? {
    let deadline = Date().addingTimeInterval(TimeInterval(timeoutMs) / 1_000)
    condition.lock()
    while response == nil && Date() < deadline {
      condition.wait(until: deadline)
    }
    let value = response
    condition.unlock()
    return value
  }
}

private func readPositiveInt(_ value: [String: Any], _ key: String, fallback: Int) -> Int {
  if let number = value[key] as? Int, number > 0 {
    return number
  }
  if let number = value[key] as? NSNumber, number.intValue > 0 {
    return number.intValue
  }
  if let text = value[key] as? String, let number = Int(text), number > 0 {
    return number
  }
  return fallback
}

private func readString(_ value: [String: Any], _ key: String) -> String {
  (value[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

private func nativeSshError(code: String, message: String) -> NSError {
  NSError(
    domain: "HappierSshNative",
    code: 1,
    userInfo: [
      "code": code,
      "message": message,
      NSLocalizedDescriptionKey: message,
    ]
  )
}
