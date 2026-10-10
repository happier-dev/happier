import Foundation

/** Process-local, synchronously revocable source for caller-authored HTML. */
final class HostedInlineDocumentRegistry {
  static let shared = HostedInlineDocumentRegistry()
  private let lock = NSLock()
  private struct Document {
    let bytes: Data
    let contentSecurityPolicy: String
  }
  private var documents = [String: Document]()

  func register(_ input: [String: Any]) -> Bool {
    guard Set(input.keys) == Set(["token", "html", "contentSecurityPolicy"]),
          let token = input["token"] as? String,
          let html = input["html"] as? String,
          let contentSecurityPolicy = input["contentSecurityPolicy"] as? String,
          contentSecurityPolicy == "sandbox allow-scripts",
          Self.isToken(token),
          let bytes = html.data(using: .utf8) else { return false }
    return withLock {
      guard documents[token] == nil else { return false }
      documents[token] = Document(bytes: bytes, contentSecurityPolicy: contentSecurityPolicy)
      return true
    }
  }

  func unregister(_ token: String) -> Bool {
    guard Self.isToken(token) else { return false }
    return withLock { documents.removeValue(forKey: token); return true }
  }

  func clear() { withLock { documents.removeAll(keepingCapacity: false) } }

  func origin(for token: String) -> HostedWebArtifactOrigin? {
    withLock {
      guard documents[token] != nil else { return nil }
      return HostedWebArtifactOrigin.artifact(partitionId: token)
    }
  }

  func readResponse(token: String, requestPath: String) -> HostedWebArtifactLoadedResponse {
    withLock {
      guard requestPath == "/", let document = documents[token] else { return .rejected(404) }
      return .content(
        contentType: "text/html; charset=utf-8",
        headers: [
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": document.contentSecurityPolicy,
        ],
        bytes: document.bytes
      )
    }
  }

  private func withLock<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
  private static func isToken(_ value: String) -> Bool {
    guard value.hasPrefix("hpa_") else { return false }
    let suffix = value.dropFirst(4)
    return suffix.utf8.count == 64 && suffix.utf8.allSatisfy {
      (48...57).contains($0) || (97...102).contains($0)
    }
  }
}
