import Foundation

enum HappierCryptoWorkerBase64 {
  static func decode(_ value: String?) -> Data? {
    guard let value else {
      return nil
    }
    return Data(base64Encoded: normalize(value))
  }

  private static func normalize(_ value: String) -> String {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(value.utf8.count)

    for byte in value.utf8 where isBase64Byte(byte) {
      bytes.append(byte)
    }

    if bytes.count % 4 == 1 {
      bytes.removeLast()
    }

    let padding = bytes.count % 4
    if padding != 0 {
      bytes.append(contentsOf: Array(repeating: 61, count: 4 - padding))
    }

    return String(decoding: bytes, as: UTF8.self)
  }

  private static func isBase64Byte(_ byte: UInt8) -> Bool {
    (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      (byte >= 48 && byte <= 57) ||
      byte == 43 ||
      byte == 47
  }
}
