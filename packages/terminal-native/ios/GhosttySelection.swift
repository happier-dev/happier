import Foundation

enum GhosttySelectionState: String {
  case started
  case changed
  case ended
  case cleared
  case copied
}

struct GhosttySelectionEvent {
  let surfaceId: String
  let state: GhosttySelectionState
  let text: String?
}
