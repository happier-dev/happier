import ExpoModulesCore
import Foundation
import React
import UIKit

private final class ShiftEnterShortcutRegistration {
  private let returnInput = "\r"
  private let modifierFlags: UIKeyModifierFlags = .shift
  private var isEnabled = false
  private var isRegistered = false
  private var onShiftEnter: (() -> Void)?

  func setEnabled(_ enabled: Bool, onShiftEnter: (() -> Void)?) {
    dispatchPrecondition(condition: .onQueue(.main))
    isEnabled = enabled
    self.onShiftEnter = onShiftEnter
    syncRegistration()
  }

  private func syncRegistration() {
    guard let keyCommands = RCTKeyCommands.sharedInstance() else {
      isRegistered = false
      return
    }

    let shouldRegister = isEnabled && onShiftEnter != nil

    if shouldRegister {
      if isRegistered || keyCommands.isKeyCommandRegistered(forInput: returnInput, modifierFlags: modifierFlags) {
        isRegistered = true
        return
      }

      keyCommands.registerKeyCommand(withInput: returnInput, modifierFlags: modifierFlags) { [weak self] _ in
        guard let self, self.isEnabled else {
          return
        }
        self.onShiftEnter?()
      }
      isRegistered = true
      return
    }

    if isRegistered || keyCommands.isKeyCommandRegistered(forInput: returnInput, modifierFlags: modifierFlags) {
      keyCommands.unregisterKeyCommand(withInput: returnInput, modifierFlags: modifierFlags)
      isRegistered = false
    }
  }
}

public final class HappierHardwareKeyboardShortcutsModule: Module {
  private let registration = ShiftEnterShortcutRegistration()

  public func definition() -> ModuleDefinition {
    Name("HappierHardwareKeyboardShortcuts")

    Events("shiftEnter")

    AsyncFunction("setShiftEnterEnabled") { [weak self] (enabled: Bool) in
      guard let self else {
        return
      }

      let updateRegistration = {
        self.registration.setEnabled(enabled) { [weak self] in
          self?.sendEvent("shiftEnter", [:])
        }
      }

      if Thread.isMainThread {
        updateRegistration()
      } else {
        DispatchQueue.main.sync(execute: updateRegistration)
      }
    }
  }

  deinit {
    DispatchQueue.main.async { [registration] in
      registration.setEnabled(false, onShiftEnter: nil)
    }
  }
}
