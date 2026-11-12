import Foundation
import CoreFoundation

enum ActivityNotificationEnricher {
  struct Enrichment {
    let title: String?
    let body: String?
  }
  typealias OpenSessionDataKey = (_ envelopeBase64: String, _ recipientSecretKeyOrSeedBase64: String) -> String?
  typealias DecryptSessionPayload = (_ ciphertextBase64: String, _ sessionDataKeyBase64: String) -> String?

  static func fetchEnrichment(alert: MachineRemoteAlert, prepared: ActivityPreparedHomeContext,
                              completion: @escaping (Enrichment?) -> Void) {
    guard alert.phase == "offline", effectivePreviewBehavior(alert.previewBehavior, prepared.previewCeiling) != "status_only" else {
      completion(nil)
      return
    }
    let currentnessURL = prepared.apiEndpoint.appendingPathComponent("v1/account/encryption/currentness")
    requestJSON(url: currentnessURL, token: prepared.token) { currentness in
      guard let currentness, isAccountEncryptionCurrent(currentness, prepared: prepared) else { completion(nil); return }
      let detailURL = prepared.apiEndpoint.appendingPathComponent("v1/machines").appendingPathComponent(alert.machineId)
      requestJSON(url: detailURL, token: prepared.token, machineStoredContent: true) { root in
        guard let machine = root?["machine"] as? [String: Any],
              let name = openMachineName(machine: machine, alert: alert, prepared: prepared,
                                        openDataKey: productionOpenSessionDataKey,
                                        decryptPayload: productionDecryptMachinePayload) else { completion(nil); return }
        completion(Enrichment(title: name, body: nil))
      }
    }
  }

  static func openMachineName(machine: [String: Any], alert: MachineRemoteAlert, prepared: ActivityPreparedHomeContext,
                              openDataKey: OpenSessionDataKey, decryptPayload: DecryptSessionPayload) -> String? {
    guard prepared.serverId == alert.serverId, prepared.accountId == alert.accountId,
          machine["id"] as? String == alert.machineId,
          let kind = machine["kind"] as? String, ["persistent", "ephemeral_session_runner"].contains(kind),
          machine["revokedAt"] is NSNull, machine["replacedByMachineId"] is NSNull,
          let access = machine["access"] as? [String: Any],
          let custodian = access["custodian"] as? [String: Any], custodian["accountId"] as? String == alert.accountId,
          exactKeys(access, ["custodian", "role", "resourceMode", "accessState"]), access["role"] as? String == "manage",
          exactKeys(custodian, ["accountId", "displayName"]), custodian["displayName"] is String,
          access["accessState"] as? String == "ready",
          let mode = machine["storageMode"] as? String, access["resourceMode"] as? String == mode,
          let stored = requiredString(machine["metadata"]) else { return nil }
    let metadata: [String: Any]
    if prepared.encryptionMode == "plain" {
      guard mode == "plain", let marker = requiredString(machine["dataEncryptionKey"]),
            let openedMarker = openPlainMachineEnvelope(marker), openedMarker["v"] is NSNull,
            let envelope = openPlainMachineEnvelope(stored), let value = envelope["v"] as? [String: Any] else { return nil }
      metadata = value
    } else {
      guard ["e2ee", "legacy_e2ee"].contains(prepared.encryptionMode), mode == "e2ee",
            let envelope = requiredString(machine["dataEncryptionKey"]), let recipientKey = prepared.machineKey,
            let key = openDataKey(envelope, recipientKey), let serialized = decryptPayload(stored, key),
            let data = serialized.data(using: .utf8),
            let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
      metadata = value
    }
    for key in ["displayName", "host"] {
      if let value = metadata[key] as? String {
        let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
      }
    }
    return nil
  }

  private static func openPlainMachineEnvelope(_ encoded: String) -> [String: Any]? {
    guard let data = Data(base64Encoded: encoded),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          root["t"] as? String == "plain", root["v"] != nil else { return nil }
    return root
  }

  private static func productionDecryptMachinePayload(_ ciphertext: String, _ key: String) -> String? {
    #if canImport(Clibsodium)
    return HappierCryptoWorkerSessionCrypto.decryptMachinePayload(ciphertextBase64: ciphertext, machineDataKeyBase64: key)
    #else
    return nil
    #endif
  }

  private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
      completionHandler(nil)
    }
  }

  static func fetchEnrichment(alert: ActivityRemoteAlert, prepared: ActivityPreparedHomeContext,
                              completion: @escaping (Enrichment?) -> Void) {
    fetchEnrichment(alert: alert, prepared: prepared, openSessionDataKey: productionOpenSessionDataKey,
                 decryptSessionPayload: productionDecryptSessionPayload, completion: completion)
  }

  static func fetchEnrichment(alert: ActivityRemoteAlert, prepared: ActivityPreparedHomeContext,
                              openSessionDataKey: @escaping OpenSessionDataKey,
                              decryptSessionPayload: @escaping DecryptSessionPayload,
                              completion: @escaping (Enrichment?) -> Void) {
    guard effectivePreviewBehavior(alert.previewBehavior, prepared.previewCeiling) != "status_only" else {
      completion(nil)
      return
    }

    let currentnessURL = prepared.apiEndpoint.appendingPathComponent("v1")
      .appendingPathComponent("account").appendingPathComponent("encryption")
      .appendingPathComponent("currentness")
    requestJSON(url: currentnessURL, token: prepared.token) { currentness in
      guard let currentness,
            isAccountEncryptionCurrent(currentness, prepared: prepared) else {
        completion(nil)
        return
      }
    var detail = URLComponents(url: prepared.apiEndpoint.appendingPathComponent("v2")
      .appendingPathComponent("sessions").appendingPathComponent(alert.sessionId), resolvingAgainstBaseURL: false)
    detail?.queryItems = [URLQueryItem(name: "accessProjectionVersion", value: "1")]
    guard let detailURL = detail?.url else { completion(nil); return }
    requestJSON(url: detailURL, token: prepared.token) { root in
      guard let session = root?["session"] as? [String: Any],
            session["id"] as? String == alert.sessionId,
            let access = session["effectiveAccess"] as? [String: Any], exactInteger(access["v"]) == 1,
            let capabilities = access["capabilities"] as? [String: Any],
            exactBoolean(capabilities["readTranscript"]) == true,
            isCurrentAssignment(session: session, alert: alert),
            let sessionMode = session["encryptionMode"] as? String,
            let contentKey = resolveContentKey(session: session, sessionMode: sessionMode, prepared: prepared,
                                               openSessionDataKey: openSessionDataKey) else {
        completion(nil)
        return
      }
      let title = openMetadataTitle(session: session, contentKey: contentKey,
                                    decryptSessionPayload: decryptSessionPayload)
      guard effectivePreviewBehavior(alert.previewBehavior, prepared.previewCeiling) == "include_preview",
            alert.canFetchMessagePreview,
            let sequence = alert.messageSeq, sequence > 0 else {
        completion(title.map { Enrichment(title: $0, body: nil) })
        return
      }
      fetchMessage(alert: alert, prepared: prepared, sequence: sequence, contentKey: contentKey,
                   decryptSessionPayload: decryptSessionPayload) { body in
        completion(title == nil && body == nil ? nil : Enrichment(title: title, body: body))
      }
    }
    }
  }

  static func isCurrentAssignment(session: [String: Any], alert: ActivityRemoteAlert) -> Bool {
    alert.eventType != "assigned" || session["responsibleAccountId"] as? String == alert.accountId
  }

  static func isAccountEncryptionCurrent(_ root: [String: Any],
                                         prepared: ActivityPreparedHomeContext) -> Bool {
    guard exactKeys(root, ["mode", "version", "settingsVersion", "signingKeyFingerprint",
                           "contentKeyFingerprint", "updatedAt", "recipientEnvelopeReadiness"]),
          let mode = requiredString(root["mode"]),
          exactInteger(root["version"]) == prepared.accountEncryptionVersion,
          exactInteger(root["settingsVersion"]) == prepared.settingsVersion,
          exactInteger(root["updatedAt"]) != nil,
          (root["signingKeyFingerprint"] is NSNull || requiredString(root["signingKeyFingerprint"]) != nil),
          (root["contentKeyFingerprint"] is NSNull || requiredString(root["contentKeyFingerprint"]) != nil),
          let readiness = root["recipientEnvelopeReadiness"] as? [String: Any] else { return false }
    if prepared.encryptionMode == "plain" {
      return mode == "plain"
        && exactKeys(readiness, ["status", "reason"])
        && readiness["status"] as? String == "unavailable"
        && readiness["reason"] as? String == "plain_account"
    }
    return (prepared.encryptionMode == "e2ee" || prepared.encryptionMode == "legacy_e2ee")
      && mode == "e2ee"
      && exactKeys(readiness, ["status"])
      && readiness["status"] as? String == "available"
  }

  private static func effectivePreviewBehavior(_ submitted: String, _ prepared: String) -> String {
    let order = ["status_only", "title_only", "include_preview"]
    guard let submittedIndex = order.firstIndex(of: submitted),
          let preparedIndex = order.firstIndex(of: prepared) else { return "status_only" }
    return order[min(submittedIndex, preparedIndex)]
  }

  // Empty string is the plain-mode marker; nil always fails closed.
  static func resolveContentKey(session: [String: Any], sessionMode: String,
                                prepared: ActivityPreparedHomeContext,
                                openSessionDataKey: OpenSessionDataKey) -> String? {
    if prepared.encryptionMode == "plain" {
      guard sessionMode == "plain", session["dataEncryptionKey"] is NSNull else { return nil }
      return ""
    }
    guard (prepared.encryptionMode == "e2ee" || prepared.encryptionMode == "legacy_e2ee"),
          sessionMode == "e2ee", let envelope = requiredString(session["dataEncryptionKey"]),
          let machineKey = prepared.machineKey else { return nil }
    return openSessionDataKey(envelope, machineKey)
  }

  private static func fetchMessage(alert: ActivityRemoteAlert, prepared: ActivityPreparedHomeContext,
                                   sequence: Int64, contentKey: String,
                                   decryptSessionPayload: @escaping DecryptSessionPayload,
                                   completion: @escaping (String?) -> Void) {
    let messageOwnerURL: URL
    if alert.canFetchDiscussionPreview, let discussionId = alert.discussionId {
      messageOwnerURL = prepared.apiEndpoint.appendingPathComponent("v2")
        .appendingPathComponent("sessions").appendingPathComponent(alert.sessionId)
        .appendingPathComponent("discussions").appendingPathComponent(discussionId)
        .appendingPathComponent("messages")
    } else if alert.canFetchSessionTranscriptPreview {
      messageOwnerURL = prepared.apiEndpoint.appendingPathComponent("v1")
        .appendingPathComponent("sessions").appendingPathComponent(alert.sessionId)
        .appendingPathComponent("messages")
    } else {
      completion(nil)
      return
    }
    var components = URLComponents(url: messageOwnerURL, resolvingAgainstBaseURL: false)
    var queryItems = [
      URLQueryItem(name: "afterSeq", value: String(sequence - 1)),
      URLQueryItem(name: "limit", value: "1"),
    ]
    if alert.canFetchSessionTranscriptPreview {
      queryItems.insert(URLQueryItem(name: "scope", value: "main"), at: 0)
    }
    components?.queryItems = queryItems
    guard let url = components?.url else { completion(nil); return }
    requestJSON(url: url, token: prepared.token) { root in
      guard let messages = root?["messages"] as? [[String: Any]],
            let message = messages.first(where: { exactSequence($0["seq"]) == sequence }),
            let content = message["content"] as? [String: Any],
            let value = openContent(content, contentKey: contentKey,
                                    decryptSessionPayload: decryptSessionPayload),
            let raw = previewText(value["content"]) else { completion(nil); return }
      let preview = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      completion(preview.isEmpty ? nil : preview)
    }
  }

  static func openContent(_ content: [String: Any], contentKey: String,
                          decryptSessionPayload: DecryptSessionPayload) -> [String: Any]? {
    if contentKey.isEmpty {
      guard content["t"] as? String == "plain" else { return nil }
      return content["v"] as? [String: Any]
    }
    guard content["t"] as? String == "encrypted", let ciphertext = requiredString(content["c"]),
          let decrypted = decryptSessionPayload(ciphertext, contentKey),
          let data = decrypted.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  static func openMetadataTitle(session: [String: Any], contentKey: String,
                                decryptSessionPayload: DecryptSessionPayload) -> String? {
    guard exactInteger(session["metadataLayoutVersion"]) == 1,
          let stored = requiredString(session["metadata"]) else { return nil }
    let serialized: String
    if contentKey.isEmpty {
      serialized = stored
    } else {
      guard let opened = decryptSessionPayload(stored, contentKey) else { return nil }
      serialized = opened
    }
    guard let data = serialized.data(using: .utf8),
          let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactInteger(metadata["v"]) == 1,
          let summary = metadata["summary"] as? [String: Any],
          let raw = summary["text"] as? String else { return nil }
    let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return title.isEmpty ? nil : title
  }

  private static func productionOpenSessionDataKey(_ envelope: String, _ machineKey: String) -> String? {
    #if canImport(Clibsodium)
    return HappierCryptoWorkerSessionCrypto.openSessionDataKey(
      envelopeBase64: envelope, recipientSecretKeyOrSeedBase64: machineKey)
    #else
    return nil
    #endif
  }

  private static func productionDecryptSessionPayload(_ ciphertext: String, _ contentKey: String) -> String? {
    #if canImport(Clibsodium)
    return HappierCryptoWorkerSessionCrypto.decryptSessionPayload(
      ciphertextBase64: ciphertext, sessionDataKeyBase64: contentKey)
    #else
    return nil
    #endif
  }

  private static func requestJSON(url: URL, token: String, machineStoredContent: Bool = false,
                                  completion: @escaping ([String: Any]?) -> Void) {
    var request = URLRequest(url: url, timeoutInterval: 2.5)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if machineStoredContent { request.setValue("2", forHTTPHeaderField: "x-happier-account-stored-content-protocol") }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    let session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    session.dataTask(with: request) { data, response, _ in
      defer { session.finishTasksAndInvalidate() }
      guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        completion(nil)
        return
      }
      completion(root)
    }.resume()
  }

  private static func exactBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  private static func exactInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let raw = number.doubleValue
    guard raw.isFinite, raw.rounded() == raw, raw >= 0, raw <= Double(Int.max) else { return nil }
    return number.intValue
  }

  private static func exactSequence(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let raw = number.doubleValue
    guard raw.isFinite, raw.rounded() == raw, raw > 0, raw <= Double(Int64.max) else { return nil }
    return number.int64Value
  }

  private static func requiredString(_ value: Any?) -> String? {
    guard let value = value as? String, !value.isEmpty,
          value.trimmingCharacters(in: .whitespacesAndNewlines) == value else { return nil }
    return value
  }

  private static func exactKeys(_ value: [String: Any], _ keys: Set<String>) -> Bool {
    Set(value.keys) == keys
  }

  private static func previewText(_ content: Any?) -> String? {
    if let block = content as? [String: Any], block["type"] as? String == "text" { return block["text"] as? String }
    if let blocks = content as? [[String: Any]] {
      return blocks.first { $0["type"] as? String == "text" }?["text"] as? String
    }
    return nil
  }
}
