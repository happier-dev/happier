import ExpoModulesCore
import Foundation
import ObjectiveC
import UIKit

private typealias PressesBeganImplementation = @convention(c) (
  AnyObject,
  Selector,
  NSSet,
  UIPressesEvent?
) -> Void

private typealias HardwareKeyHandler = ([String: Any]) -> Void

private enum HardwareKeyboardShortcutMode: Hashable {
  case genericHardwareKey
  case legacyShiftEnter
}

private final class HardwareKeyboardTextViewInterceptor {
  static let shared = HardwareKeyboardTextViewInterceptor()

  private let textViewClassName = "RCTUITextView"
  private let originalSelector = #selector(UIResponder.pressesBegan(_:with:))
  private let interceptedSelector = Selector(("happierHardwareKeyboardShortcuts_pressesBegan:withEvent:"))
  private let methodEncoding = "v@:@@"

  private var activeModes = Set<HardwareKeyboardShortcutMode>()
  private var nativeConsumableEventSignatures = Set<String>()
  private var isInstalled = false
  private var onHardwareKey: HardwareKeyHandler?

  private init() {}

  func setModes(
    _ modes: Set<HardwareKeyboardShortcutMode>,
    nativeConsumableEventSignatures: Set<String>,
    onHardwareKey: HardwareKeyHandler?
  ) {
    dispatchPrecondition(condition: .onQueue(.main))
    activeModes = modes
    self.nativeConsumableEventSignatures = nativeConsumableEventSignatures
    self.onHardwareKey = onHardwareKey

    if !modes.isEmpty {
      installIfNeeded()
    }
  }

  private func installIfNeeded() {
    guard !isInstalled else {
      return
    }

    guard let textViewClass = NSClassFromString(textViewClassName) else {
      return
    }

    let interceptedBlock: @convention(block) (AnyObject, NSSet, UIPressesEvent?) -> Void = { receiver, presses, event in
      if HardwareKeyboardTextViewInterceptor.shared.handlePresses(receiver: receiver, presses: presses) {
        return
      }

      HardwareKeyboardTextViewInterceptor.callOriginalPressesBegan(
        receiver: receiver,
        selector: HardwareKeyboardTextViewInterceptor.shared.interceptedSelector,
        presses: presses,
        event: event
      )
    }

    let interceptedImplementation = imp_implementationWithBlock(interceptedBlock)
    guard class_addMethod(textViewClass, interceptedSelector, interceptedImplementation, methodEncoding) else {
      isInstalled = class_getInstanceMethod(textViewClass, interceptedSelector) != nil
      return
    }

    guard
      let originalMethod = class_getInstanceMethod(textViewClass, originalSelector),
      let interceptedMethod = class_getInstanceMethod(textViewClass, interceptedSelector)
    else {
      return
    }

    if class_addMethod(
      textViewClass,
      originalSelector,
      method_getImplementation(interceptedMethod),
      method_getTypeEncoding(interceptedMethod)
    ) {
      class_replaceMethod(
        textViewClass,
        interceptedSelector,
        method_getImplementation(originalMethod),
        method_getTypeEncoding(originalMethod)
      )
    } else {
      method_exchangeImplementations(originalMethod, interceptedMethod)
    }

    isInstalled = true
  }

  private func handlePresses(receiver: AnyObject, presses: NSSet) -> Bool {
    guard !activeModes.isEmpty, let onHardwareKey else {
      return false
    }

    guard let responder = receiver as? UIResponder, responder.isFirstResponder else {
      return false
    }

    guard let payload = makePayload(presses: presses) else {
      return false
    }

    onHardwareKey(payload)
    return shouldConsume(payload: payload)
  }

  private func makePayload(presses: NSSet) -> [String: Any]? {
    guard #available(iOS 13.4, *) else {
      return nil
    }

    for object in presses.allObjects {
      guard let press = object as? UIPress, let key = press.key else {
        continue
      }
      guard let normalizedKey = normalizeKey(key) else {
        continue
      }

      let modifiers = modifierPayload(flags: key.modifierFlags)
      guard shouldEmit(key: normalizedKey, modifiers: modifiers) else {
        continue
      }

      return [
        "key": normalizedKey,
        "code": codeName(for: key.keyCode),
        "characters": key.characters,
        "modifiers": modifiers,
        "repeat": false,
        "target": "reactNativeTextInput",
      ]
    }

    return nil
  }

  @available(iOS 13.4, *)
  private func normalizeKey(_ key: UIKey) -> String? {
    switch key.keyCode {
    case UIKeyboardHIDUsage.keyboardReturnOrEnter, UIKeyboardHIDUsage.keypadEnter:
      return "Enter"
    case UIKeyboardHIDUsage.keyboardEscape:
      return "Escape"
    default:
      if key.characters == "\n" || key.characters == "\r" {
        return "Enter"
      }
      return nil
    }
  }

  @available(iOS 13.4, *)
  private func codeName(for keyCode: UIKeyboardHIDUsage) -> String {
    switch keyCode {
    case UIKeyboardHIDUsage.keyboardReturnOrEnter:
      return "Enter"
    case UIKeyboardHIDUsage.keypadEnter:
      return "NumpadEnter"
    case UIKeyboardHIDUsage.keyboardEscape:
      return "Escape"
    default:
      return "Unidentified"
    }
  }

  @available(iOS 13.4, *)
  private func modifierPayload(flags: UIKeyModifierFlags) -> [String: Bool] {
    [
      "shift": flags.contains(.shift),
      "ctrl": flags.contains(.control),
      "meta": flags.contains(.command),
      "alt": flags.contains(.alternate),
    ]
  }

  private func shouldEmit(key: String, modifiers: [String: Bool]) -> Bool {
    if activeModes.contains(.genericHardwareKey),
       nativeConsumableEventSignatures.contains(signatureForKey(key: key, modifiers: modifiers)) {
      return true
    }
    if activeModes.contains(.legacyShiftEnter) {
      return key == "Enter" && isPureShiftEnter(modifiers)
    }
    return false
  }

  private func isSupportedEnterModifier(_ modifiers: [String: Bool]) -> Bool {
    modifiers["shift"] == true || modifiers["ctrl"] == true || modifiers["meta"] == true
  }

  private func isPureShiftEnter(_ modifiers: [String: Bool]) -> Bool {
    modifiers["shift"] == true &&
      modifiers["ctrl"] != true &&
      modifiers["meta"] != true &&
      modifiers["alt"] != true
  }

  private func shouldConsume(payload: [String: Any]) -> Bool {
    if activeModes.contains(.genericHardwareKey), shouldConsumeGenericHardwareKey(payload: payload) {
      return true
    }
    if activeModes.contains(.legacyShiftEnter), shouldConsumeLegacyShiftEnter(payload: payload) {
      return true
    }
    return false
  }

  private func shouldConsumeGenericHardwareKey(payload: [String: Any]) -> Bool {
    nativeConsumableEventSignatures.contains(signatureForPayload(payload: payload))
  }

  private func shouldConsumeLegacyShiftEnter(payload: [String: Any]) -> Bool {
    guard payload["key"] as? String == "Enter" else {
      return false
    }
    guard let modifiers = payload["modifiers"] as? [String: Bool] else {
      return false
    }
    return isPureShiftEnter(modifiers)
  }

  private func signatureForPayload(payload: [String: Any]) -> String {
    let key = payload["key"] as? String ?? "Unidentified"
    let modifiers = payload["modifiers"] as? [String: Bool] ?? [:]
    return signatureForKey(key: key, modifiers: modifiers)
  }

  private func signatureForKey(key: String, modifiers: [String: Bool]) -> String {
    return [
      key,
      "shift=\(modifiers["shift"] == true)",
      "ctrl=\(modifiers["ctrl"] == true)",
      "meta=\(modifiers["meta"] == true)",
      "alt=\(modifiers["alt"] == true)",
    ].joined(separator: "|")
  }

  private static func callOriginalPressesBegan(
    receiver: AnyObject,
    selector: Selector,
    presses: NSSet,
    event: UIPressesEvent?
  ) {
    guard let implementation = class_getMethodImplementation(object_getClass(receiver), selector) else {
      return
    }

    let original = unsafeBitCast(implementation, to: PressesBeganImplementation.self)
    original(receiver, selector, presses, event)
  }
}

public final class HappierHardwareKeyboardShortcutsModule: Module {
  private let interceptor = HardwareKeyboardTextViewInterceptor.shared
  private var hardwareKeyEventsEnabled = false
  private var legacyShiftEnterEnabled = false
  private var nativeConsumableEventSignatures = Set<String>()

  public func definition() -> ModuleDefinition {
    Name("HappierHardwareKeyboardShortcuts")

    Events("hardwareKey", "shiftEnter")

    AsyncFunction("setHardwareKeyEventsEnabled") { [weak self] (enabled: Bool) in
      self?.setHardwareKeyEventsEnabled(enabled)
    }

    AsyncFunction("setHardwareKeyConsumableEventSignatures") { [weak self] (signatures: [String]) in
      self?.setHardwareKeyConsumableEventSignatures(signatures)
    }

    AsyncFunction("setShiftEnterEnabled") { [weak self] (enabled: Bool) in
      self?.setLegacyShiftEnterEnabled(enabled)
    }
  }

  private func setHardwareKeyEventsEnabled(_ enabled: Bool) {
    hardwareKeyEventsEnabled = enabled
    updateInterceptorRegistration()
  }

  private func setHardwareKeyConsumableEventSignatures(_ signatures: [String]) {
    nativeConsumableEventSignatures = Set(signatures)
    updateInterceptorRegistration()
  }

  private func setLegacyShiftEnterEnabled(_ enabled: Bool) {
    // Legacy composer wiring only owns pure Shift+Enter. Generic shortcuts must
    // enable genericHardwareKey separately so Cmd/Ctrl+Enter and Escape are not
    // consumed before the registry subscription is installed.
    legacyShiftEnterEnabled = enabled
    updateInterceptorRegistration()
  }

  private func updateInterceptorRegistration() {
    let updateRegistration = { [weak self] in
      guard let self else {
        return
      }
      var modes = Set<HardwareKeyboardShortcutMode>()
      if self.hardwareKeyEventsEnabled {
        modes.insert(.genericHardwareKey)
      }
      if self.legacyShiftEnterEnabled {
        modes.insert(.legacyShiftEnter)
      }

      self.interceptor.setModes(
        modes,
        nativeConsumableEventSignatures: self.nativeConsumableEventSignatures
      ) { [weak self] payload in
        guard let self else {
          return
        }
        if self.hardwareKeyEventsEnabled {
          self.sendEvent("hardwareKey", payload)
        }
        if self.legacyShiftEnterEnabled, Self.isShiftEnter(payload: payload) {
          self.sendEvent("shiftEnter", [:])
        }
      }
    }

    if Thread.isMainThread {
      updateRegistration()
    } else {
      DispatchQueue.main.sync(execute: updateRegistration)
    }
  }

  private static func isShiftEnter(payload: [String: Any]) -> Bool {
    guard payload["key"] as? String == "Enter" else {
      return false
    }
    guard let modifiers = payload["modifiers"] as? [String: Bool] else {
      return false
    }
    return modifiers["shift"] == true &&
      modifiers["ctrl"] != true &&
      modifiers["meta"] != true &&
      modifiers["alt"] != true
  }

  deinit {
    DispatchQueue.main.async { [interceptor] in
      interceptor.setModes([], nativeConsumableEventSignatures: [], onHardwareKey: nil)
    }
  }
}
