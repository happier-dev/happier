// Finite pointer probe restricted to this lane's exact private process and control bounds.
import AppKit
import CoreGraphics
import ApplicationServices

let owner = Int32(CommandLine.arguments[1])!
precondition(CGPreflightPostEventAccess(), "Event posting is unavailable; never request permission")
if NSWorkspace.shared.frontmostApplication!.processIdentifier == owner {
    let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first!
    finder.activate(options: [.activateIgnoringOtherApps])
    Thread.sleep(forTimeInterval: 0.5)
}
let before = NSWorkspace.shared.frontmostApplication!.processIdentifier
precondition(before != owner, "Another app must be frontmost before input")
func windows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
}
func bounds(_ entry: [String: Any]) -> CGRect {
    CGRect(dictionaryRepresentation: entry[kCGWindowBounds as String] as! CFDictionary)!
}
let control = windows().first {
    ($0[kCGWindowOwnerPID as String] as? Int32) == owner && bounds($0).width == 253 && bounds($0).height == 44
}!
let frame = bounds(control)
precondition(abs(frame.origin.x - 99) < 1 && abs(frame.origin.y - 693) < 1, "Own control not at expected test position")
let start = CGPoint(x: frame.minX + 12, y: frame.midY)
let top = windows().first { bounds($0).contains(start) }!
var hit: AXUIElement?
let hitResult = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(start.x), Float(start.y), &hit)
var hitOwner: pid_t = 0
if let hit { AXUIElementGetPid(hit, &hitOwner) }
print("OWN_DRAG_WINDOW level=\(control[kCGWindowLayer as String]!) frame=\(frame)")
// A transparent Dock-owned full-display window can precede the actual event recipient in the
// CG list. AX hit testing identifies the recipient without sending a click to another app.
guard (hitResult == .success && hitOwner == owner) || (top[kCGWindowOwnerPID as String] as? Int32) == owner else {
    print("OWN_REAL_DRAG_BLOCKED topOwner=\(top[kCGWindowOwnerName as String] ?? "unknown") topLevel=\(top[kCGWindowLayer as String]!) topFrame=\(bounds(top)); no input posted")
    exit(3)
}
func post(_ type: CGEventType, _ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
}
post(.mouseMoved, start)
post(.leftMouseDown, start)
Thread.sleep(forTimeInterval: 0.5)
for step in 1...10 {
    post(.leftMouseDragged, CGPoint(x: start.x + Double(step) * 7, y: start.y - Double(step) * 3.5))
    Thread.sleep(forTimeInterval: 0.04)
}
post(.leftMouseUp, CGPoint(x: start.x + 70, y: start.y - 35))
Thread.sleep(forTimeInterval: 0.5)
let after = NSWorkspace.shared.frontmostApplication!.processIdentifier
let moved = windows().first { ($0[kCGWindowNumber as String] as? Int) == (control[kCGWindowNumber as String] as? Int) }!
let end = bounds(moved)
print("OWN_REAL_DRAG before=\(frame) after=\(end) frontmostBefore=\(before) frontmostAfter=\(after)")
guard end.origin != frame.origin else { print("OWN_REAL_DRAG_FAILED no displacement"); exit(1) }
guard after == before else { print("OWN_REAL_DRAG_FAILED control activated Happier"); exit(1) }
print("OWN_REAL_DRAG_PASS")
