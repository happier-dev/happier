import Foundation
import UIKit

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
import libghostty
#endif

@MainActor
final class GhosttySurfaceBridge {
  typealias EventEmitter = GhosttySurfaceView.EventEmitter

  private weak var hostView: UIView?
  private let surfaceId: () -> String
  private let eventEmitter: () -> EventEmitter?

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
  private static let initLock = NSLock()
  private static var initialized = false
  private static var initializationFailed = false
  private static let clearScreenSequence = Data([
    0x1B, 0x5B, 0x33, 0x4A, // ESC[3J clears scrollback in xterm-compatible terminals.
    0x1B, 0x5B, 0x32, 0x4A, // ESC[2J clears the viewport.
    0x1B, 0x5B, 0x48, // ESC[H homes the cursor.
  ])

  private var app: ghostty_app_t?
  private var surface: ghostty_surface_t?
  private var lastPixelSize = CGSize.zero
#endif

  init(
    hostView: UIView,
    surfaceId: @escaping () -> String,
    eventEmitter: @escaping () -> EventEmitter?
  ) {
    self.hostView = hostView
    self.surfaceId = surfaceId
    self.eventEmitter = eventEmitter
  }

  deinit {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    let surfaceToFree = surface
    let appToFree = app
    surface = nil
    app = nil
    Task { @MainActor in
      if let surfaceToFree {
        ghostty_surface_free(surfaceToFree)
      }
      if let appToFree {
        ghostty_app_free(appToFree)
      }
    }
#endif
  }

  func ensureSurface(fontSize: Double) -> Bool {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard surface == nil else { return true }
    guard !surfaceId().isEmpty, let hostView, hostView.bounds.width > 0, hostView.bounds.height > 0 else {
      return false
    }
    guard Self.ensureInitialized() else {
      emitRendererCrash("ghostty-init-failed")
      return false
    }

    let userdata = Unmanaged.passUnretained(self).toOpaque()
    var runtimeConfig = ghostty_runtime_config_s(
      userdata: userdata,
      supports_selection_clipboard: false,
      wakeup_cb: { _ in },
      action_cb: Self.actionCallback,
      read_clipboard_cb: { _, _, _ in false },
      confirm_read_clipboard_cb: { _, _, _, _ in },
      write_clipboard_cb: { _, _, _, _, _ in },
      close_surface_cb: { userdata, processAlive in
        guard let userdata else { return }
        let bridge = Unmanaged<GhosttySurfaceBridge>.fromOpaque(userdata).takeUnretainedValue()
        Task { @MainActor in
          bridge.emitRendererCrash(processAlive ? "surface-closed-process-alive" : "surface-closed")
        }
      }
    )

    guard let config = ghostty_config_new() else {
      emitRendererCrash("ghostty-config-new-failed")
      return false
    }
    ghostty_config_finalize(config)
    defer { ghostty_config_free(config) }

    guard let nextApp = ghostty_app_new(&runtimeConfig, config) else {
      emitRendererCrash("ghostty-app-new-failed")
      return false
    }

    var surfaceConfig = ghostty_surface_config_new()
    surfaceConfig.platform_tag = GHOSTTY_PLATFORM_IOS
    surfaceConfig.platform.ios.uiview = Unmanaged.passUnretained(hostView).toOpaque()
    surfaceConfig.userdata = userdata
    surfaceConfig.backend = GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED
    surfaceConfig.receive_userdata = userdata
    surfaceConfig.receive_buffer = Self.receiveBufferCallback
    surfaceConfig.receive_resize = Self.receiveResizeCallback
    surfaceConfig.scale_factor = Double(hostView.contentScaleFactor)
    surfaceConfig.font_size = Float(max(fontSize, 1))
    surfaceConfig.context = GHOSTTY_SURFACE_CONTEXT_WINDOW

    guard let nextSurface = ghostty_surface_new(nextApp, &surfaceConfig) else {
      ghostty_app_free(nextApp)
      emitRendererCrash("ghostty-surface-new-failed")
      return false
    }

    app = nextApp
    surface = nextSurface
    updateSize()
    return true
#else
    _ = fontSize
    return false
#endif
  }

  func write(bytes: Data, byteOffset: Int64, fontSize: Double) -> [String: Any] {
    guard ensureSurface(fontSize: fontSize) else {
      return GhosttyRuntime.unavailableWriteResult
    }

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface else {
      return GhosttyRuntime.unavailableWriteResult
    }

    bytes.withUnsafeBytes { rawBuffer in
      guard let pointer = rawBuffer.bindMemory(to: UInt8.self).baseAddress else { return }
      ghostty_surface_write_buffer(surface, pointer, UInt(bytes.count))
    }
    ghostty_surface_draw(surface)
    refreshAccessibilitySummary()
    let nextByteOffset = byteOffset + Int64(bytes.count)
    emitWriteAck(nextByteOffset)
    return [
      "accepted": true,
      "byteOffset": nextByteOffset,
    ]
#else
    _ = bytes
    _ = byteOffset
    return GhosttyRuntime.unavailableWriteResult
#endif
  }

  func updateSize() {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface, let hostView else { return }
    let scale = hostView.contentScaleFactor
    let pixelSize = CGSize(
      width: floor(hostView.bounds.width * scale),
      height: floor(hostView.bounds.height * scale)
    )
    guard pixelSize.width > 0, pixelSize.height > 0, pixelSize != lastPixelSize else {
      return
    }
    lastPixelSize = pixelSize
    ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))
    ghostty_surface_set_size(surface, UInt32(pixelSize.width), UInt32(pixelSize.height))
    ghostty_surface_draw(surface)
    refreshAccessibilitySummary()
    emitSurfaceReady()
#endif
  }

  func setFocused(_ focused: Bool) {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface else { return }
    ghostty_surface_set_focus(surface, focused)
#else
    _ = focused
#endif
  }

  func submitText(_ text: String) -> Bool {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface, !text.isEmpty else { return false }
    let utf8CString = Array(text.utf8CString)
    utf8CString.withUnsafeBufferPointer { buffer in
      guard let pointer = buffer.baseAddress, buffer.count > 1 else { return }
      ghostty_surface_text(surface, pointer, UInt(buffer.count - 1))
    }
    ghostty_surface_draw(surface)
    refreshAccessibilitySummary()
    return true
#else
    _ = text
    return false
#endif
  }

  func deleteBackward() -> Bool {
    submitText("\u{7f}")
  }

  func clear() {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface else { return }
    Self.clearScreenSequence.withUnsafeBytes { rawBuffer in
      guard let pointer = rawBuffer.bindMemory(to: UInt8.self).baseAddress else { return }
      ghostty_surface_write_buffer(surface, pointer, UInt(Self.clearScreenSequence.count))
    }
    ghostty_surface_draw(surface)
    refreshAccessibilitySummary()
#endif
  }

  func handleTouch(_ touch: UITouch, phase: UITouch.Phase) {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface, let hostView else { return }
    let location = touch.location(in: hostView)
    ghostty_surface_mouse_pos(surface, Double(location.x), Double(location.y), GHOSTTY_MODS_NONE)

    switch phase {
    case .began:
      _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, GHOSTTY_MODS_NONE)
    case .ended, .cancelled:
      _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, GHOSTTY_MODS_NONE)
    default:
      break
    }

    ghostty_surface_draw(surface)
#else
    _ = touch
    _ = phase
#endif
  }

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
  func handlePress(_ press: UIPress, action: ghostty_input_action_e) -> Bool {
    guard let surface else { return false }
    let handled = withGhosttyInputKey(press: press, action: action) { key in
      ghostty_surface_key(surface, key)
    } ?? false
    if handled {
      ghostty_surface_draw(surface)
      refreshAccessibilitySummary()
    }
    return handled
  }
#endif

  func handleScroll(dx: Double, dy: Double) {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface, dx != 0 || dy != 0 else { return }
    ghostty_surface_mouse_scroll(surface, dx, dy, ghostty_input_scroll_mods_t(GHOSTTY_MODS_NONE.rawValue))
    ghostty_surface_draw(surface)
    refreshAccessibilitySummary()
#else
    _ = dx
    _ = dy
#endif
  }

  func copySelection() -> [String: Any] {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    guard let surface, ghostty_surface_has_selection(surface) else {
      return [
        "copied": false,
        "reason": "selection-empty",
      ]
    }

    var output = ghostty_text_s()
    guard ghostty_surface_read_selection(surface, &output) else {
      return [
        "copied": false,
        "reason": "selection-read-failed",
      ]
    }
    defer { ghostty_surface_free_text(surface, &output) }

    let text = decodeGhosttyText(output)
    emitEvent("copy", [
      "surfaceId": surfaceId(),
      "text": text,
    ])
    emitEvent("selection", [
      "surfaceId": surfaceId(),
      "state": "copied",
      "text": text,
    ])
    return [
      "copied": true,
      "text": text,
    ]
#else
    return [
      "copied": false,
      "reason": "renderer-unavailable",
    ]
#endif
  }

  func dispose() {
#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
    if let surface {
      ghostty_surface_free(surface)
    }
    if let app {
      ghostty_app_free(app)
    }
    surface = nil
    app = nil
#endif
  }

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
  private static func ensureInitialized() -> Bool {
    initLock.lock()
    defer { initLock.unlock() }
    if initialized { return true }
    if initializationFailed { return false }
    if ghostty_init(0, nil) == GHOSTTY_SUCCESS {
      initialized = true
      return true
    }
    initializationFailed = true
    return false
  }

  private static let receiveBufferCallback: ghostty_surface_receive_buffer_cb = { userdata, pointer, length in
    guard let userdata, let pointer, length > 0 else { return }
    let bridge = Unmanaged<GhosttySurfaceBridge>.fromOpaque(userdata).takeUnretainedValue()
    let data = Data(bytes: pointer, count: Int(length))
    Task { @MainActor in
      bridge.emitInput(data)
    }
  }

  private static let receiveResizeCallback: ghostty_surface_receive_resize_cb = { userdata, cols, rows, _, _ in
    guard let userdata else { return }
    let bridge = Unmanaged<GhosttySurfaceBridge>.fromOpaque(userdata).takeUnretainedValue()
    Task { @MainActor in
      bridge.emitResize(cols: Int(cols), rows: Int(rows))
    }
  }

  private static let actionCallback: ghostty_runtime_action_cb = { _, target, action in
    guard isHandledAction(action), target.tag == GHOSTTY_TARGET_SURFACE else { return false }
    guard let surface = target.target.surface else { return false }
    guard let userdata = ghostty_surface_userdata(surface) else { return false }
    let bridge = Unmanaged<GhosttySurfaceBridge>.fromOpaque(userdata).takeUnretainedValue()
    Task { @MainActor in
      bridge.handleAction(action)
    }
    return true
  }

  private static func isHandledAction(_ action: ghostty_action_s) -> Bool {
    switch action.tag {
    case GHOSTTY_ACTION_SET_TITLE,
      GHOSTTY_ACTION_SET_TAB_TITLE,
      GHOSTTY_ACTION_RING_BELL,
      GHOSTTY_ACTION_OPEN_URL:
      return true
    default:
      return false
    }
  }

  private func handleAction(_ action: ghostty_action_s) {
    switch action.tag {
    case GHOSTTY_ACTION_SET_TITLE:
      emitTitle(action.action.set_title.title)
    case GHOSTTY_ACTION_SET_TAB_TITLE:
      emitTitle(action.action.set_tab_title.title)
    case GHOSTTY_ACTION_RING_BELL:
      emitEvent("bell", [
        "surfaceId": surfaceId(),
      ])
    case GHOSTTY_ACTION_OPEN_URL:
      let url = decodeGhosttyString(
        pointer: action.action.open_url.url,
        length: Int(action.action.open_url.len)
      )
      if let event = makeGhosttyLinkEvent(surfaceId: surfaceId(), url: url, text: url) {
        emitEvent("link", [
          "surfaceId": event.surfaceId,
          "url": event.url,
          "text": event.text ?? event.url,
        ])
      }
    default:
      break
    }
  }

  private func emitSurfaceReady() {
    guard let surface else { return }
    let size = ghostty_surface_size(surface)
    guard size.columns > 0, size.rows > 0 else { return }
    emitEvent("surfaceReady", [
      "surfaceId": surfaceId(),
      "cols": Int(size.columns),
      "rows": Int(size.rows),
    ])
  }

  private func emitInput(_ data: Data) {
    guard !data.isEmpty else { return }
    emitEvent("input", [
      "surfaceId": surfaceId(),
      "data": String(decoding: data, as: UTF8.self),
    ])
  }

  private func emitResize(cols: Int, rows: Int) {
    guard cols > 0, rows > 0 else { return }
    emitEvent("resize", [
      "surfaceId": surfaceId(),
      "cols": cols,
      "rows": rows,
    ])
  }

  private func emitWriteAck(_ byteOffset: Int64) {
    emitEvent("writeAck", [
      "surfaceId": surfaceId(),
      "byteOffset": byteOffset,
    ])
  }

  private func emitRendererCrash(_ reason: String) {
    emitEvent("rendererCrash", [
      "surfaceId": surfaceId(),
      "reason": reason,
    ])
  }

  private func emitTitle(_ pointer: UnsafePointer<CChar>?) {
    let title = decodeGhosttyCString(pointer)
    guard !title.isEmpty else { return }
    emitEvent("title", [
      "surfaceId": surfaceId(),
      "title": title,
    ])
  }

  private func refreshAccessibilitySummary() {
    guard let surface, let surfaceView = hostView as? GhosttySurfaceView, surfaceView.accessibilityAccepted else {
      return
    }
    let selection = ghostty_selection_s(
      top_left: ghostty_point_s(
        tag: GHOSTTY_POINT_VIEWPORT,
        coord: GHOSTTY_POINT_COORD_TOP_LEFT,
        x: 0,
        y: 0
      ),
      bottom_right: ghostty_point_s(
        tag: GHOSTTY_POINT_VIEWPORT,
        coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
        x: 0,
        y: 0
      ),
      rectangle: false
    )
    var output = ghostty_text_s()
    guard ghostty_surface_read_text(surface, selection, &output) else { return }
    defer { ghostty_surface_free_text(surface, &output) }
    surfaceView.updateNativeAccessibilitySummary(makeGhosttyAccessibilitySummary(decodeGhosttyText(output)))
  }

  private func decodeGhosttyText(_ text: ghostty_text_s) -> String {
    guard let pointer = text.text, text.text_len > 0 else { return "" }
    let bytes = UnsafeBufferPointer(start: pointer, count: Int(text.text_len)).map {
      UInt8(bitPattern: $0)
    }
    return String(decoding: bytes, as: UTF8.self)
  }

  private func decodeGhosttyCString(_ pointer: UnsafePointer<CChar>?) -> String {
    guard let pointer else { return "" }
    return String(cString: pointer)
  }

  private func decodeGhosttyString(pointer: UnsafePointer<CChar>?, length: Int) -> String {
    guard let pointer, length > 0 else { return "" }
    let bytes = UnsafeBufferPointer(start: pointer, count: length).map {
      UInt8(bitPattern: $0)
    }
    return String(decoding: bytes, as: UTF8.self)
  }
#endif

  private func emitEvent(_ eventName: String, _ payload: [String: Any]) {
    guard !surfaceId().isEmpty else { return }
    eventEmitter()?(eventName, payload)
  }
}
