import CoreFoundation
import CryptoKit
import Foundation

/**
 The iOS owner of registered opaque Artifact tokens. JavaScript provides only
 the Artifact cache locator, stored-file names, opaque resource ids, and the
 Protocol-produced response table. It never provides a local path, byte array,
 URL source, or request-path/MIME policy input.

 `unregister` is synchronous: after it returns true, a later scheme request
 cannot resolve the token. A request already copying response bytes is
 linearized before that acknowledgement, so the Artifact cache owner may delete
 physical files only after native denies the token.
 */
final class HostedWebArtifactRegistry {
  private let cacheDirectory: URL
  private let lock = NSLock()
  private var registrations = [String: Registration]()

  init(cacheDirectory: URL) {
    self.cacheDirectory = cacheDirectory.standardizedFileURL.resolvingSymlinksInPath()
  }

  func register(_ input: [String: Any]) -> Bool {
    guard let registration = Registration.parse(input, cacheDirectory: cacheDirectory) else {
      return false
    }
    return withLock {
      guard registrations[registration.token] == nil else {
        return false
      }
      registrations[registration.token] = registration
      return true
    }
  }

  func unregister(_ token: String) -> Bool {
    guard Self.isOpaqueId(token) else {
      return false
    }
    return withLock {
      // An unknown syntactically valid token is already denied. This mirrors
      // the Android registry and lets Artifact retry failed registration
      // cleanup without retaining a second state owner.
      registrations.removeValue(forKey: token)
      return true
    }
  }

  func clear() {
    withLock {
      registrations.removeAll(keepingCapacity: false)
    }
  }

  func origin(for token: String) -> HostedWebArtifactOrigin? {
    withLock {
      registrations[token]?.origin
    }
  }

  /**
   Resolves and copies a request while holding the registry lock. The returned
   bytes are safe to hand to WebKit after the lock is released; no native file
   descriptor or cache path escapes this owner across revocation.
   */
  func readResponse(token: String, requestPath: String) -> HostedWebArtifactLoadedResponse {
    withLock {
      let response = resolveLocked(token: token, requestPath: requestPath)
      guard response.status == 200,
            let fileURL = response.fileURL,
            let contentType = response.contentType,
            let digest = response.digest else {
        return HostedWebArtifactLoadedResponse.rejected(response.status)
      }
      guard let data = try? Data(contentsOf: fileURL),
            data.count == response.byteSize,
            Self.sha256Digest(data) == digest else {
        return HostedWebArtifactLoadedResponse.rejected(404)
      }
      return HostedWebArtifactLoadedResponse.content(
        contentType: contentType,
        headers: response.headers,
        bytes: data,
      )
    }
  }

  private func resolveLocked(token: String, requestPath: String) -> HostedWebArtifactStoredResponse {
    guard let registration = registrations[token] else {
      return .rejected(404)
    }
    guard let normalized = Self.normalizeRequestPath(requestPath) else {
      return .rejected(400)
    }
    if normalized.directoryRequest && !normalized.path.isEmpty {
      return .rejected(404)
    }

    let selection: (outcome: PolicyOutcome, fallback: Bool)
    if let exact = registration.table.routes[normalized.path] {
      selection = (exact, false)
    } else if let fallback = registration.table.pathFallback, !Self.hasFileExtension(normalized.path) {
      selection = (fallback, true)
    } else {
      return .rejected(404)
    }

    switch selection.outcome {
    case .rejected(let status):
      return .rejected(status)
    case .content(let resourceId, let contentType, let headers):
      guard let resource = registration.resources[resourceId], let fileURL = registration.resolveResourceFile(resource) else {
        return .rejected(404)
      }
      return .content(
        contentType: contentType,
        headers: headers,
        fileURL: fileURL,
        digest: resource.digest,
        byteSize: resource.byteSize,
        fallback: selection.fallback,
      )
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private struct Registration {
    let token: String
    let origin: HostedWebArtifactOrigin
    let baseDirectory: URL
    let resources: [String: Resource]
    let table: PolicyTable

    func resolveResourceFile(_ resource: Resource) -> URL? {
      let candidate = baseDirectory.appendingPathComponent(resource.storedFileName, isDirectory: false)
        .standardizedFileURL.resolvingSymlinksInPath()
      guard candidate.deletingLastPathComponent() == baseDirectory else {
        return nil
      }
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        return nil
      }
      guard let attributes = try? FileManager.default.attributesOfItem(atPath: candidate.path),
            let size = (attributes[.size] as? NSNumber)?.int64Value,
            size == resource.byteSize else {
        return nil
      }
      return candidate
    }

    static func parse(_ input: [String: Any], cacheDirectory: URL) -> Registration? {
      guard Self.hasExactKeys(input, expected: ["token", "storagePartitionId", "storageLocator", "resources", "policyTable"]),
            let token = Self.requiredString(input, key: "token"),
            let partition = Self.requiredString(input, key: "storagePartitionId"),
            HostedWebArtifactRegistry.isOpaqueId(token),
            HostedWebArtifactRegistry.isPartitionId(partition),
            let locator = StorageLocator.parse(input["storageLocator"]),
            let baseDirectory = locator.resolveBaseDirectory(cacheDirectory),
            let resources = parseResources(input["resources"]),
            let table = PolicyTable.parse(input["policyTable"], resourceIds: Set(resources.keys)),
            Set(resources.keys) == table.referencedResourceIds else {
        return nil
      }
      let registration = Registration(
        token: token,
        origin: HostedWebArtifactOrigin.artifact(partitionId: partition),
        baseDirectory: baseDirectory,
        resources: resources,
        table: table,
      )
      guard resources.values.allSatisfy({ registration.resolveResourceFile($0) != nil }) else {
        return nil
      }
      return registration
    }

    private static func parseResources(_ value: Any?) -> [String: Resource]? {
      guard let values = value as? [Any] else {
        return nil
      }
      var resources = [String: Resource]()
      var storedNames = Set<String>()
      for value in values {
        guard let map = value as? [String: Any],
              hasExactKeys(map, expected: ["resourceId", "storedFileName", "digest", "byteSize"]),
              let resourceId = requiredString(map, key: "resourceId"),
              let storedFileName = requiredString(map, key: "storedFileName"),
              let digest = requiredString(map, key: "digest"),
              let byteSize = HostedWebArtifactRegistry.nonNegativeInteger(map["byteSize"]),
              isNativeResourceId(resourceId),
              isStoredFileName(storedFileName),
              HostedWebArtifactRegistry.isSha256Digest(digest),
              resources[resourceId] == nil,
              !storedNames.contains(storedFileName) else {
          return nil
        }
        resources[resourceId] = Resource(storedFileName: storedFileName, digest: digest, byteSize: byteSize)
        storedNames.insert(storedFileName)
      }
      return resources
    }

    private static func requiredString(_ map: [String: Any], key: String) -> String? {
      map[key] as? String
    }

    private static func hasExactKeys(_ map: [String: Any], expected: Set<String>) -> Bool {
      Set(map.keys) == expected
    }

    private static func isNativeResourceId(_ value: String) -> Bool {
      HostedWebArtifactRegistry.matches(HostedWebArtifactRegistry.resourceIdRegex, value)
    }

    private static func isStoredFileName(_ value: String) -> Bool {
      HostedWebArtifactRegistry.matches(HostedWebArtifactRegistry.storedFileNameRegex, value)
    }
  }

  private struct Resource {
    let storedFileName: String
    let digest: String
    let byteSize: Int64
  }

  private struct StorageLocator {
    let namespace: String
    let accountKeyHash: String
    let artifactKeyHash: String

    static func parse(_ value: Any?) -> StorageLocator? {
      guard let map = value as? [String: Any],
            Set(map.keys) == Set(["namespace", "accountKeyHash", "artifactKeyHash"]),
            let namespace = map["namespace"] as? String,
            let accountKeyHash = map["accountKeyHash"] as? String,
            let artifactKeyHash = map["artifactKeyHash"] as? String,
            namespace == HostedWebArtifactRegistry.persistentArtifactNamespace,
            HostedWebArtifactRegistry.isHash(accountKeyHash),
            HostedWebArtifactRegistry.isHash(artifactKeyHash) else {
        return nil
      }
      return StorageLocator(
        namespace: namespace,
        accountKeyHash: accountKeyHash,
        artifactKeyHash: artifactKeyHash,
      )
    }

    func resolveBaseDirectory(_ cacheDirectory: URL) -> URL? {
      let root = cacheDirectory.standardizedFileURL.resolvingSymlinksInPath()
      let candidate = root
        .appendingPathComponent(namespace, isDirectory: true)
        .appendingPathComponent(accountKeyHash, isDirectory: true)
        .appendingPathComponent(artifactKeyHash, isDirectory: true)
        .standardizedFileURL.resolvingSymlinksInPath()
      guard candidate.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() == root else {
        return nil
      }
      return candidate
    }
  }

  private enum PolicyOutcome {
    case content(resourceId: String, contentType: String, headers: [String: String])
    case rejected(status: Int)
  }

  private struct PolicyTable {
    let routes: [String: PolicyOutcome]
    let pathFallback: PolicyOutcome?
    let referencedResourceIds: Set<String>

    static func parse(_ value: Any?, resourceIds: Set<String>) -> PolicyTable? {
      guard let map = value as? [String: Any],
            Set(map.keys) == Set(["version", "routes"]) || Set(map.keys) == Set(["version", "routes", "pathFallback"]),
            let version = HostedWebArtifactRegistry.nonNegativeInteger(map["version"]), version == 1,
            let rawRoutes = map["routes"] as? [Any] else {
        return nil
      }

      var routes = [String: PolicyOutcome]()
      var referencedResourceIds = Set<String>()
      for rawRoute in rawRoutes {
        guard let route = rawRoute as? [String: Any],
              Set(route.keys) == Set(["path", "outcome"]),
              let path = route["path"] as? String,
              isCanonicalPolicyPath(path),
              routes[path] == nil,
              let outcome = parseOutcome(route["outcome"], resourceIds: resourceIds) else {
          return nil
        }
        if case .content(let resourceId, _, _) = outcome {
          referencedResourceIds.insert(resourceId)
        }
        routes[path] = outcome
      }

      let fallback: PolicyOutcome?
      if let rawFallback = map["pathFallback"] {
        guard let parsed = parseContent(rawFallback, resourceIds: resourceIds) else {
          return nil
        }
        if case .content(let resourceId, _, _) = parsed {
          referencedResourceIds.insert(resourceId)
        }
        fallback = parsed
      } else {
        fallback = nil
      }
      return PolicyTable(
        routes: routes,
        pathFallback: fallback,
        referencedResourceIds: referencedResourceIds,
      )
    }

    private static func parseOutcome(_ value: Any?, resourceIds: Set<String>) -> PolicyOutcome? {
      guard let map = value as? [String: Any], let kind = map["kind"] as? String else {
        return nil
      }
      switch kind {
      case "content":
        return parseContent(map, resourceIds: resourceIds)
      case "rejected":
        guard Set(map.keys) == Set(["kind", "code", "status"]),
              let code = map["code"] as? String,
              let status = HostedWebArtifactRegistry.nonNegativeInteger(map["status"]),
              status <= Int64(Int.max),
              statusForPolicyFailure(code) == Int(status) else {
          return nil
        }
        return .rejected(status: Int(status))
      default:
        return nil
      }
    }

    private static func parseContent(_ value: Any?, resourceIds: Set<String>) -> PolicyOutcome? {
      guard let map = value as? [String: Any],
            Set(map.keys) == Set(["kind", "resourceId", "contentType", "headers"]),
            map["kind"] as? String == "content",
            let resourceId = map["resourceId"] as? String,
            resourceIds.contains(resourceId),
            let contentType = map["contentType"] as? String, !contentType.isEmpty,
            let headers = parseHeaders(map["headers"]) else {
        return nil
      }
      return .content(resourceId: resourceId, contentType: contentType, headers: headers)
    }

    private static func parseHeaders(_ value: Any?) -> [String: String]? {
      guard let map = value as? [String: Any], Set(map.keys) == HostedWebArtifactRegistry.requiredHeaders else {
        return nil
      }
      var headers = [String: String]()
      for name in HostedWebArtifactRegistry.requiredHeaders {
        guard let value = map[name] as? String, !value.isEmpty else {
          return nil
        }
        headers[name] = value
      }
      return headers
    }

    private static func isCanonicalPolicyPath(_ path: String) -> Bool {
      guard !path.contains("\0") else {
        return false
      }
      if path.isEmpty {
        return true
      }
      return HostedWebArtifactRegistry.normalizeArtifactPath(path) == path
    }

    private static func statusForPolicyFailure(_ code: String) -> Int? {
      switch code {
      case "invalid_request_path":
        return 400
      case "mime_type_not_allowed":
        return 415
      case "asset_not_declared", "directory_listing_disabled", "source_map_unavailable":
        return 404
      default:
        return nil
      }
    }
  }

  private static let persistentArtifactNamespace = "happier-plugin-ui-artifacts-v1"
  private static let opaqueIdRegex = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9_-]{1,255}$")
  private static let partitionIdRegex = try! NSRegularExpression(pattern: "^hpa_[a-f0-9]{64}$")
  private static let hashRegex = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")
  private static let sha256DigestRegex = try! NSRegularExpression(pattern: "^sha256:[a-f0-9]{64}$")
  private static let resourceIdRegex = try! NSRegularExpression(pattern: "^r(?:0|[1-9]\\d*)$")
  private static let storedFileNameRegex = try! NSRegularExpression(pattern: "^[a-f0-9]{64}\\.bin$")
  private static let windowsDriveSegmentRegex = try! NSRegularExpression(pattern: "(?:^|/)[A-Za-z]:")
  private static let requiredHeaders: Set<String> = [
    "Cache-Control",
    "Content-Security-Policy",
    "ETag",
    "X-Content-Type-Options",
  ]

  private static func isOpaqueId(_ value: String) -> Bool {
    matches(opaqueIdRegex, value)
  }

  private static func isPartitionId(_ value: String) -> Bool {
    matches(partitionIdRegex, value)
  }

  private static func isHash(_ value: String) -> Bool {
    matches(hashRegex, value)
  }

  private static func isSha256Digest(_ value: String) -> Bool {
    matches(sha256DigestRegex, value)
  }

  private static func sha256Digest(_ bytes: Data) -> String {
    "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

  private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return regex.firstMatch(in: value, range: range)?.range == range
  }

  private static func nonNegativeInteger(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    let double = number.doubleValue
    guard double.isFinite, double >= 0, double.rounded(.towardZero) == double,
          double <= Double(Int64.max) else {
      return nil
    }
    return number.int64Value
  }

  private static func normalizeRequestPath(_ requestPath: String) -> NormalizedRequestPath? {
    let rawPath = String(requestPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    guard !hasEncodedTraversalOrSeparator(rawPath), let decoded = rawPath.removingPercentEncoding,
          !decoded.contains("\0"), !hasWindowsPathSyntax(decoded) else {
      return nil
    }
    let directoryRequest = decoded.hasSuffix("/")
    let trimmed = String(decoded.drop(while: { $0 == "/" }))
    if trimmed.isEmpty {
      return NormalizedRequestPath(path: "", directoryRequest: false)
    }
    guard let normalized = normalizeArtifactPath(trimmed) else {
      return nil
    }
    return NormalizedRequestPath(path: normalized, directoryRequest: directoryRequest)
  }

  private static func normalizeArtifactPath(_ path: String) -> String? {
    guard !path.contains("\0"), !hasWindowsPathSyntax(path) else {
      return nil
    }
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !trimmed.isEmpty else {
      return nil
    }
    var segments = [String]()
    for segment in trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init) {
      switch segment {
      case "", ".":
        continue
      case "..":
        guard !segments.isEmpty else {
          return nil
        }
        segments.removeLast()
      default:
        segments.append(segment)
      }
    }
    return segments.isEmpty ? nil : segments.joined(separator: "/")
  }

  private static func hasWindowsPathSyntax(_ path: String) -> Bool {
    path.contains("\\")
      || path.hasPrefix("//")
      || path.hasPrefix("\\\\")
      || matches(windowsDriveSegmentRegex, path)
  }

  private static func hasEncodedTraversalOrSeparator(_ rawPath: String) -> Bool {
    for rawSegment in rawPath.split(separator: "/", omittingEmptySubsequences: false) {
      let segment = String(rawSegment)
      guard segment.contains("%") else {
        continue
      }
      guard let decoded = segment.removingPercentEncoding else {
        return true
      }
      if decoded == "." || decoded == ".." || decoded.contains("/") || decoded.contains("\\") {
        return true
      }
    }
    return false
  }

  private static func hasFileExtension(_ path: String) -> Bool {
    let basename = path.split(separator: "/").last.map(String.init) ?? path
    guard let lastDot = basename.lastIndex(of: ".") else {
      return false
    }
    return lastDot != basename.startIndex
  }
}

struct HostedWebArtifactOrigin: Hashable {
  // Must match Protocol's one admitted non-HTTP bridge origin grammar.
  static let localScheme = "happier-hosted-artifact"

  let scheme: String
  let host: String
  let port: Int?

  static func artifact(partitionId: String) -> HostedWebArtifactOrigin {
    HostedWebArtifactOrigin(scheme: localScheme, host: partitionId, port: nil)
  }

  var serialized: String {
    if let port {
      return "\(scheme)://\(host):\(port)"
    }
    return "\(scheme)://\(host)"
  }

  func matches(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
      return false
    }
    return scheme == self.scheme && host == self.host && effectivePort(scheme: scheme, port: url.port) == effectivePort(scheme: self.scheme, port: port)
  }

  static func navigationOrigin(_ value: String) -> HostedWebArtifactOrigin? {
    guard let components = URLComponents(string: value),
          let scheme = components.scheme?.lowercased(),
          let host = components.host?.lowercased(),
          scheme == "https" || scheme == "http",
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          components.path.isEmpty || components.path == "/" else {
      return nil
    }
    let port = effectivePort(scheme: scheme, port: components.port)
    guard let port, (1...65535).contains(port) else {
      return nil
    }
    return HostedWebArtifactOrigin(scheme: scheme, host: host, port: port)
  }

  private func effectivePort(scheme: String, port: Int?) -> Int? {
    Self.effectivePort(scheme: scheme, port: port)
  }

  private static func effectivePort(scheme: String, port: Int?) -> Int? {
    if let port {
      return port
    }
    switch scheme {
    case "https":
      return 443
    case "http":
      return 80
    default:
      return nil
    }
  }
}

struct HostedWebArtifactLoadedResponse {
  let status: Int
  let contentType: String?
  let headers: [String: String]
  let bytes: Data?

  static func rejected(_ status: Int) -> HostedWebArtifactLoadedResponse {
    HostedWebArtifactLoadedResponse(status: status, contentType: nil, headers: [:], bytes: nil)
  }

  static func content(contentType: String, headers: [String: String], bytes: Data) -> HostedWebArtifactLoadedResponse {
    HostedWebArtifactLoadedResponse(status: 200, contentType: contentType, headers: headers, bytes: bytes)
  }
}

private struct HostedWebArtifactStoredResponse {
  let status: Int
  let contentType: String?
  let headers: [String: String]
  let fileURL: URL?
  let digest: String?
  let byteSize: Int
  let fallback: Bool

  static func rejected(_ status: Int) -> HostedWebArtifactStoredResponse {
    HostedWebArtifactStoredResponse(
      status: status,
      contentType: nil,
      headers: [:],
      fileURL: nil,
      digest: nil,
      byteSize: 0,
      fallback: false,
    )
  }

  static func content(
    contentType: String,
    headers: [String: String],
    fileURL: URL,
    digest: String,
    byteSize: Int64,
    fallback: Bool,
  ) -> HostedWebArtifactStoredResponse {
    guard byteSize <= Int64(Int.max) else {
      return .rejected(404)
    }
    return HostedWebArtifactStoredResponse(
      status: 200,
      contentType: contentType,
      headers: headers,
      fileURL: fileURL,
      digest: digest,
      byteSize: Int(byteSize),
      fallback: fallback,
    )
  }
}

private struct NormalizedRequestPath {
  let path: String
  let directoryRequest: Bool
}

/** One app-local registry instance, never a second artifact/cache owner. */
final class HostedWebArtifactRegistryOwner {
  static let shared = HostedWebArtifactRegistryOwner()

  private let registry: HostedWebArtifactRegistry?

  private init() {
    guard let cacheDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      registry = nil
      return
    }
    registry = HostedWebArtifactRegistry(cacheDirectory: cacheDirectory)
  }

  func register(_ input: [String: Any]) -> Bool {
    registry?.register(input) ?? false
  }

  func unregister(_ token: String) -> Bool {
    registry?.unregister(token) ?? false
  }

  func clear() {
    registry?.clear()
  }

  func origin(for token: String) -> HostedWebArtifactOrigin? {
    registry?.origin(for: token)
  }

  func readResponse(token: String, requestPath: String) -> HostedWebArtifactLoadedResponse {
    registry?.readResponse(token: token, requestPath: requestPath) ?? .rejected(404)
  }
}
