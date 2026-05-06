import Foundation

public enum HappierSshNativeBridge {
  public static let unavailableReason = "engine-unavailable"
  public static let unavailableDetail = "Native SSH Phase 0 engine selection is not complete."

  public static func availability() -> [String: Any] {
    [
      "available": false,
      "reason": unavailableReason,
      "detail": unavailableDetail,
    ]
  }
}
