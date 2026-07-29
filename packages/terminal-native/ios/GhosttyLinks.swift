import Foundation

struct GhosttyLinkEvent {
  let surfaceId: String
  let url: String
  let text: String?
}

func makeGhosttyLinkEvent(surfaceId: String, url: String, text: String? = nil) -> GhosttyLinkEvent? {
  guard !surfaceId.isEmpty, let components = URLComponents(string: url) else { return nil }
  let scheme = components.scheme?.lowercased()
  guard scheme == "http" || scheme == "https" else { return nil }
  return GhosttyLinkEvent(surfaceId: surfaceId, url: url, text: text)
}
