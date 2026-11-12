import CryptoKit
import Foundation
import zlib

// This is the native adapter for Protocol's contentByteCodec frame. Keeping it
// beside the byte cipher also lets the notification extension use the same path.
enum HappierCryptoWorkerContentCodec {
  // Protocol CONTENT_VALUE_MAX_DECODED_BYTES projection; shared fixtures verify parity.
  static let maxDecodedBytes = 100 * 1024 * 1024
  static func encode(_ json: Data) -> Data? {
    guard let compressed = gzip(json, encode: true) else { return nil }
    return compressed.count < json.count ? Data([1]) + compressed : Data([0]) + json
  }

  static func decode(_ frame: Data) -> Data? {
    guard let encoding = frame.first else { return nil }
    switch encoding {
    case 0: return frame.count - 1 <= maxDecodedBytes ? Data(frame.dropFirst()) : nil
    case 1: return gzip(Data(frame.dropFirst()), encode: false)
    default: return nil
    }
  }

  static func decodeLegacy(_ bytes: Data) -> Data? {
    bytes.first == 0 || bytes.first == 1 ? decode(bytes) : bytes
  }

  private static func gzip(_ input: Data, encode: Bool) -> Data? {
    var stream = z_stream()
    let initialized = encode
      ? deflateInit2_(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, MAX_WBITS + 16, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
      : inflateInit2_(&stream, MAX_WBITS + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
    guard initialized == Z_OK else { return nil }
    defer { if encode { deflateEnd(&stream) } else { inflateEnd(&stream) } }
    return input.withUnsafeBytes { bytes -> Data? in
      stream.next_in = UnsafeMutablePointer(mutating: bytes.bindMemory(to: Bytef.self).baseAddress)
      stream.avail_in = uInt(input.count)
      var output = Data()
      var chunk = [UInt8](repeating: 0, count: 32 * 1024)
      while true {
        let status = chunk.withUnsafeMutableBytes { buffer -> Int32 in
          stream.next_out = buffer.bindMemory(to: Bytef.self).baseAddress
          stream.avail_out = uInt(buffer.count)
          return encode ? deflate(&stream, Z_FINISH) : inflate(&stream, Z_NO_FLUSH)
        }
        let produced = chunk.count - Int(stream.avail_out)
        if !encode && produced > maxDecodedBytes - output.count { return nil }
        output.append(contentsOf: chunk.prefix(produced))
        if status == Z_STREAM_END { return stream.avail_in == 0 ? output : nil }
        guard status == Z_OK, produced > 0 else { return nil }
      }
    }
  }
}

enum HappierCryptoWorkerAesGcm {
  private static let keyBytes = 32
  private static let nonceBytes = 12
  private static let tagBytes = 16

  static func encodeContentValueBase64(_ jsonBase64: String) -> String? {
    guard let json = HappierCryptoWorkerBase64.decode(jsonBase64),
          let frame = HappierCryptoWorkerContentCodec.encode(json) else { return nil }
    return frame.base64EncodedString()
  }

  static func encryptAesGcmContentBatch(_ items: [[String: String]]) -> [String?] {
    items.map { item in
      guard let json = HappierCryptoWorkerBase64.decode(item["jsonBase64"] ?? ""),
            let key = HappierCryptoWorkerBase64.decode(item["keyBase64"] ?? ""), key.count == keyBytes,
            let nonce = HappierCryptoWorkerBase64.decode(item["nonceBase64"] ?? ""), nonce.count == nonceBytes,
            let frame = HappierCryptoWorkerContentCodec.encode(json) else { return nil }
      do {
        let sealed = try AES.GCM.seal(frame, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce))
        return (Data([1]) + nonce + sealed.ciphertext + sealed.tag).base64EncodedString()
      } catch { return nil }
    }
  }

  static func decryptAesGcmJsonBatch(_ items: [[String: String]]) -> [String?] {
    openAesGcmContentBatch(items).map { $0["serializedJson"] }
  }

  static func openAesGcmContentBatch(_ items: [[String: String]]) -> [[String: String]] {
    items.map { item in
      guard let payload = HappierCryptoWorkerBase64.decode(item["encryptedPayloadBase64"] ?? ""),
            let key = HappierCryptoWorkerBase64.decode(item["keyBase64"] ?? ""),
            key.count == keyBytes, payload.count >= 1 + nonceBytes + tagBytes,
            payload.first == 0 || payload.first == 1 else { return ["status": "unsupported"] }
      guard let opened = decryptAesGcm(payload: payload, key: key) else {
        return ["status": "authentication_failed"]
      }
      let json = payload.first == 1 ? HappierCryptoWorkerContentCodec.decode(opened) : opened
      guard let bytes = json, let serializedJson = String(data: bytes, encoding: .utf8) else {
        return ["status": "invalid_payload"]
      }
      return ["status": "authenticated", "serializedJson": serializedJson]
    }
  }

  private static func decryptAesGcm(payload: Data, key: Data) -> Data? {
    do {
      let combined = payload.dropFirst()
      let sealedBox = try AES.GCM.SealedBox(combined: Data(combined))
      let symmetricKey = SymmetricKey(data: key)
      return try AES.GCM.open(sealedBox, using: symmetricKey)
    } catch {
      return nil
    }
  }
}
