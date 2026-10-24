import CryptoKit
import Foundation

enum HappierCryptoWorkerFileHash {
  private static let readChunkBytes = 1024 * 1024

  struct InvalidFileUri: Error, CustomStringConvertible {
    let fileUri: String
    var description: String { "Unsupported file URI '\(fileUri)'" }
  }

  /// Streams a local file through SHA-256 off the JS thread; returns lowercase hex.
  static func sha256File(_ fileUri: String) throws -> String {
    let url: URL
    if let parsed = URL(string: fileUri), parsed.isFileURL {
      url = parsed
    } else if fileUri.hasPrefix("/") {
      url = URL(fileURLWithPath: fileUri)
    } else {
      throw InvalidFileUri(fileUri: fileUri)
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let chunk = try autoreleasepool { try handle.read(upToCount: readChunkBytes) }
      guard let chunk, !chunk.isEmpty else { break }
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
