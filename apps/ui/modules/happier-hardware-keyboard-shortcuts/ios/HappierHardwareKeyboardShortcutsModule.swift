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

private final class ShiftEnterTextViewInterceptor {
  static let shared = ShiftEnterTextViewInterceptor()

  private let textViewClassName = "RCTUITextView"
  private let originalSelector = #selector(UIResponder.pressesBegan(_:with:))
  private let interceptedSelector = Selector(("happierHardwareKeyboardShortcuts_pressesBegan:withEvent:"))
  private let methodEncoding = "v@:@@"

  private var isEnabled = false
  private var isInstalled = false
  private var onShiftEnter: (() -> Void)?

  private init() {}

  func setEnabled(_ enabled: Bool, onShiftEnter: (() -> Void)?) {
    dispatchPrecondition(condition: .onQueue(.main))
    isEnabled = enabled
    self.onShiftEnter = onShiftEnter

    if enabled {
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
      if ShiftEnterTextViewInterceptor.shared.handlePresses(receiver: receiver, presses: presses) {
        return
      }

      ShiftEnterTextViewInterceptor.callOriginalPressesBegan(
        receiver: receiver,
        selector: ShiftEnterTextViewInterceptor.shared.interceptedSelector,
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
    guard isEnabled, onShiftEnter != nil else {
      return false
    }

    guard let responder = receiver as? UIResponder, responder.isFirstResponder else {
      return false
    }

    guard isShiftReturn(presses: presses) else {
      return false
    }

    onShiftEnter?()
    return true
  }

  private func isShiftReturn(presses: NSSet) -> Bool {
    guard #available(iOS 13.4, *) else {
      return false
    }

    return presses.allObjects.contains { press in
      guard let key = (press as? UIPress)?.key else {
        return false
      }

      let isReturn =
        key.keyCode == UIKeyboardHIDUsage.keyboardReturnOrEnter ||
        key.keyCode == UIKeyboardHIDUsage.keypadEnter ||
        key.characters == "\n" ||
        key.characters == "\r"

      return isReturn && key.modifierFlags.contains(.shift)
    }
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
  private let interceptor = ShiftEnterTextViewInterceptor.shared

  public func definition() -> ModuleDefinition {
    Name("HappierHardwareKeyboardShortcuts")

    Events("shiftEnter")

    AsyncFunction("setShiftEnterEnabled") { [weak self] (enabled: Bool) in
      guard let self else {
        return
      }

      let updateRegistration = {
        self.interceptor.setEnabled(enabled) { [weak self] in
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
    DispatchQueue.main.async { [interceptor] in
      interceptor.setEnabled(false, onShiftEnter: nil)
    }
  }
}
