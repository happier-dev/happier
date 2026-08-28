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

func firstGhosttySafeLinkEvent(surfaceId: String, text: String) -> GhosttyLinkEvent? {
  guard !surfaceId.isEmpty, !text.isEmpty else { return nil }
  guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
    return nil
  }

  let source = text as NSString
  let range = NSRange(location: 0, length: source.length)
  for match in detector.matches(in: text, options: [], range: range) {
    guard let url = match.url, match.range.location != NSNotFound else { continue }
    let matchedText = source.substring(with: match.range)
    let lowercasedText = matchedText.lowercased()
    // Do not promote detector-inferred bare domains or non-web schemes. The
    // host receives only explicit HTTP(S) candidates and remains responsible
    // for the canonical terminal hyperlink prompt/allow/deny policy.
    guard lowercasedText.hasPrefix("http://") || lowercasedText.hasPrefix("https://") else {
      continue
    }
    if let event = makeGhosttyLinkEvent(surfaceId: surfaceId, url: url.absoluteString, text: matchedText) {
      return event
    }
  }
  return nil
}
