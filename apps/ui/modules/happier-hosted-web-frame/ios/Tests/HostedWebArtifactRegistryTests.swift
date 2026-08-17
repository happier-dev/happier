import CryptoKit
import Darwin
import Foundation

#if canImport(XCTest)
import XCTest

final class HostedWebArtifactRegistryTests: XCTestCase {
  func testRejectsSameSizeResourceMutationAfterRegistration() throws {
    try assertSameSizeResourceMutationIsRejected()
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
      "storageLocator": [
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

#if !canImport(XCTest)
@main
private struct HostedWebArtifactRegistryTestRunner {
  static func main() {
    do {
      try assertSameSizeResourceMutationIsRejected()
      print("PASS HostedWebArtifactRegistryTests.testRejectsSameSizeResourceMutationAfterRegistration")
      exit(EXIT_SUCCESS)
    } catch {
      fputs("FAIL HostedWebArtifactRegistryTests.testRejectsSameSizeResourceMutationAfterRegistration: \(error)\n", stderr)
      exit(EXIT_FAILURE)
    }
  }
}
#endif
