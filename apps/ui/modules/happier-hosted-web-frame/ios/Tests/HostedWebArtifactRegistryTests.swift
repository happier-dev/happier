import CryptoKit
import Darwin
import Foundation

#if canImport(XCTest) && !HOSTED_WEB_REGISTRY_STANDALONE
import XCTest

final class HostedWebArtifactRegistryTests: XCTestCase {
  func testInlineDocumentTokenIsProcessLocalAndSynchronouslyRevoked() throws {
    try assertInlineDocumentTokenIsProcessLocalAndSynchronouslyRevoked()
  }

  func testRejectsSameSizeResourceMutationAfterRegistration() throws {
    try assertSameSizeResourceMutationIsRejected()
  }

  func testCurrentLoadBytesRemainTokenScopedAndNeedNoPersistentCacheRecord() throws {
    try assertCurrentLoadBytesRemainTokenScoped()
  }
}
#endif

private enum HostedWebArtifactRegistryTestFailure: Error, CustomStringConvertible {
  case assertionFailed(String)

  var description: String {
    switch self {
    case .assertionFailed(let message):
      return message
    }
  }
}

private func assertInlineDocumentTokenIsProcessLocalAndSynchronouslyRevoked() throws {
  let token = "hpa_\(String(repeating: "a", count: 64))"
  let html = "<!doctype html><main>\(String(repeating: "current", count: 300_000))</main>"
  let contentSecurityPolicy = "sandbox allow-scripts"
  let registry = HostedInlineDocumentRegistry.shared
  registry.clear()
  guard !registry.register(["token": token, "html": html]),
        !registry.register([
          "token": token, "html": html,
          "contentSecurityPolicy": "sandbox allow-scripts allow-same-origin",
        ]) else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("inline registration must refuse absent or widened sandbox policy")
  }

  guard registry.register(["token": token, "html": html, "contentSecurityPolicy": contentSecurityPolicy]) else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("inline registration must accept the exact opaque token")
  }
  guard registry.origin(for: token)?.serialized == "happier-hosted-artifact://\(token)" else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("inline registration must publish only its token-scoped origin")
  }
  let registeredResponse = registry.readResponse(token: token, requestPath: "/")
  guard registeredResponse.status == 200,
        registeredResponse.bytes == Data(html.utf8),
        registeredResponse.headers["Cache-Control"] == "no-store",
        registeredResponse.headers["Content-Security-Policy"] == contentSecurityPolicy else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("registered inline bytes must be reachable only through the current token")
  }
  guard registry.readResponse(token: token, requestPath: "/foreign").status == 404,
        registry.readResponse(token: "hpa_\(String(repeating: "b", count: 64))", requestPath: "/").status == 404 else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("inline registration must reject foreign paths and unregistered tokens")
  }

  guard registry.unregister(token) else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("inline revocation must acknowledge synchronously")
  }
  guard registry.origin(for: token) == nil,
        registry.readResponse(token: token, requestPath: "/").status == 404 else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("revoked inline tokens must reject every later read")
  }
}

private func assertSameSizeResourceMutationIsRejected() throws {
    let cacheRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("hosted-web-frame-test-\(UUID().uuidString)", isDirectory: true)
    defer {
      try? FileManager.default.removeItem(at: cacheRoot)
    }

    let registry = HostedWebArtifactRegistry(cacheDirectory: cacheRoot)
    let originalBytes = Data("console.log('frame')".utf8)
    let mutatedBytes = Data(originalBytes.map { $0 ^ 1 })
    guard originalBytes.count == mutatedBytes.count else {
      throw HostedWebArtifactRegistryTestFailure.assertionFailed("mutation must retain byte size")
    }
    guard originalBytes != mutatedBytes else {
      throw HostedWebArtifactRegistryTestFailure.assertionFailed("mutation must change bytes")
    }
    try writeResource(root: cacheRoot, bytes: originalBytes)

    guard registry.register(registration(digest: sha256Digest(originalBytes))) else {
      throw HostedWebArtifactRegistryTestFailure.assertionFailed("registration must accept canonical original digest")
    }
    let originalResponse = registry.readResponse(token: token, requestPath: "/assets/app.js")
    guard originalResponse.status == 200, originalResponse.bytes == originalBytes else {
      throw HostedWebArtifactRegistryTestFailure.assertionFailed("registered canonical bytes must receive a 200 response")
    }
    try writeResource(root: cacheRoot, bytes: mutatedBytes)

    let response = registry.readResponse(token: token, requestPath: "/assets/app.js")
    guard response.status != 200, response.bytes == nil else {
      throw HostedWebArtifactRegistryTestFailure.assertionFailed("same-size mutated bytes must not receive a 200 response")
    }
  }

private func assertCurrentLoadBytesRemainTokenScoped() throws {
  let cacheRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("hosted-web-frame-current-load-test-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: cacheRoot) }
  let registry = HostedWebArtifactRegistry(cacheDirectory: cacheRoot)
  let bytes = Data("console.log('current load')".utf8)
  let currentToken = "hpat_current_load_token"
  let digest = sha256Digest(bytes)
  let input: [String: Any] = [
    "token": currentToken,
    "storagePartitionId": "hpa_\(String(repeating: "e", count: 64))",
    "storage": [
      "kind": "currentLoad",
      "resources": [[
        "resourceId": "r0",
        "digest": digest,
        "byteSize": Int64(bytes.count),
        "bytesBase64": bytes.base64EncodedString(),
      ]],
    ],
    "policyTable": [
      "version": 1,
      "routes": [[
        "path": "assets/app.js",
        "outcome": [
          "kind": "content",
          "resourceId": "r0",
          "contentType": "text/javascript; charset=utf-8",
          "headers": [
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'",
            "ETag": "\"\(digest)\"",
            "X-Content-Type-Options": "nosniff",
          ],
        ],
      ]],
    ],
  ]

  var invalidInput = input
  var invalidStorage = input["storage"] as! [String: Any]
  var invalidResources = invalidStorage["resources"] as! [[String: Any]]
  invalidResources[0]["digest"] = "sha256:\(String(repeating: "0", count: 64))"
  invalidStorage["resources"] = invalidResources
  invalidInput["storage"] = invalidStorage
  guard !registry.register(invalidInput),
        registry.readResponse(token: currentToken, requestPath: "/assets/app.js").status == 404 else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("current-load registration must reject bytes that do not match their digest")
  }

  guard registry.register(input) else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("current-load registration must accept verified bytes")
  }
  let response = registry.readResponse(token: currentToken, requestPath: "/assets/app.js")
  guard response.status == 200,
        response.bytes == bytes,
        !FileManager.default.fileExists(atPath: cacheRoot.path) else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("current-load bytes must be served only from the token registration")
  }
  guard registry.unregister(currentToken), registry.readResponse(token: currentToken, requestPath: "/assets/app.js").status == 404 else {
    throw HostedWebArtifactRegistryTestFailure.assertionFailed("unregister must synchronously retire current-load bytes")
  }
}

  private func writeResource(root: URL, bytes: Data) throws {
    let directory = root
      .appendingPathComponent("happier-plugin-ui-artifacts-v1", isDirectory: true)
      .appendingPathComponent(accountKeyHash, isDirectory: true)
      .appendingPathComponent(artifactKeyHash, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try bytes.write(to: directory.appendingPathComponent(storedFileName, isDirectory: false))
  }

  private func registration(digest: String) -> [String: Any] {
    [
      "token": token,
      "storagePartitionId": "hpa_\(String(repeating: "e", count: 64))",
      "storage": [
        "kind": "persistent",
        "locator": [
          "namespace": "happier-plugin-ui-artifacts-v1",
          "accountKeyHash": accountKeyHash,
          "artifactKeyHash": artifactKeyHash,
        ],
        "resources": [[
          "resourceId": "r0",
          "storedFileName": storedFileName,
          "digest": digest,
          "byteSize": Int64("console.log('frame')".utf8.count),
        ]],
      ],
      "policyTable": [
        "version": 1,
        "routes": [[
          "path": "assets/app.js",
          "outcome": [
            "kind": "content",
            "resourceId": "r0",
            "contentType": "text/javascript; charset=utf-8",
            "headers": [
              "Cache-Control": "public, max-age=31536000, immutable",
              "Content-Security-Policy": "default-src 'none'",
              "ETag": "\"\(digest)\"",
              "X-Content-Type-Options": "nosniff",
            ],
          ],
        ]],
      ],
    ]
  }

  private func sha256Digest(_ bytes: Data) -> String {
    "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

private let token = "hpat_digest_mutation_token"
private let accountKeyHash = String(repeating: "a", count: 64)
private let artifactKeyHash = String(repeating: "b", count: 64)
private let storedFileName = String(repeating: "c", count: 64) + ".bin"

#if !canImport(XCTest) || HOSTED_WEB_REGISTRY_STANDALONE
@main
private struct HostedWebArtifactRegistryTestRunner {
  static func main() {
    do {
      try assertInlineDocumentTokenIsProcessLocalAndSynchronouslyRevoked()
      print("PASS HostedWebArtifactRegistryTests.testInlineDocumentTokenIsProcessLocalAndSynchronouslyRevoked")
      try assertSameSizeResourceMutationIsRejected()
      print("PASS HostedWebArtifactRegistryTests.testRejectsSameSizeResourceMutationAfterRegistration")
      try assertCurrentLoadBytesRemainTokenScoped()
      print("PASS HostedWebArtifactRegistryTests.testCurrentLoadBytesRemainTokenScopedAndNeedNoPersistentCacheRecord")
      exit(EXIT_SUCCESS)
    } catch {
      fputs("FAIL HostedWebArtifactRegistryTests: \(error)\n", stderr)
      exit(EXIT_FAILURE)
    }
  }
}
#endif
