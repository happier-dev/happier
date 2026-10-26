import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const managerPath = 'ios/EXNotifications/Notifications/NotificationCenterManager.swift';
const emitterPath = 'ios/EXNotifications/Notifications/Emitter/EmitterModule.swift';

// UIKit/UserNotifications are genuine OS boundaries. The production manager below
// is compiled unchanged apart from imports; these fakes control OS callbacks.
const osBoundary = String.raw`
import Foundation
public struct UNNotificationPresentationOptions: OptionSet { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue } }
public struct UNNotificationActionOptions: OptionSet, Hashable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let foreground = Self(rawValue: 1) }
public enum UIBackgroundFetchResult { case noData }
public typealias UIBackgroundTaskIdentifier = Int
extension Int { static let invalid = -1 }
public final class UIApplication {
  public static let shared = UIApplication()
  var expirations: [Int: () -> Void] = [:]
  var ended: [Int] = []
  var nextId = 0
  var denyAssertion = false
  var expireDuringStart = false
  public func beginBackgroundTask(withName: String?, expirationHandler: (() -> Void)?) -> Int {
    if denyAssertion { return .invalid }
    nextId += 1; expirations[nextId] = expirationHandler
    if expireDuringStart { expirationHandler?() }
    return nextId
  }
  public func endBackgroundTask(_ identifier: Int) { ended.append(identifier); expirations.removeValue(forKey: identifier) }
}
public struct UNNotificationAction: Hashable { public let identifier: String; public let options: UNNotificationActionOptions }
public struct UNNotificationCategory: Hashable { public let identifier: String; public let actions: [UNNotificationAction] }
public final class UNNotificationContent { public let categoryIdentifier: String; init(_ category: String) { categoryIdentifier = category } }
public final class UNNotificationRequest { public let content: UNNotificationContent; init(_ category: String) { content = UNNotificationContent(category) } }
public final class UNNotification { public let request: UNNotificationRequest; init(_ category: String) { request = UNNotificationRequest(category) } }
public final class UNNotificationResponse { public let notification: UNNotification; public let actionIdentifier: String; init(_ action: String, category: String = "permission") { notification = UNNotification(category); actionIdentifier = action } }
public let UNNotificationDefaultActionIdentifier = "default"
public let UNNotificationDismissActionIdentifier = "dismiss"
public protocol UNUserNotificationCenterDelegate: AnyObject {}
public final class UNUserNotificationCenter {
  static let instance = UNUserNotificationCenter()
  public static func current() -> UNUserNotificationCenter { instance }
  public weak var delegate: UNUserNotificationCenterDelegate?
  var categories: Set<UNNotificationCategory> = []
  public func getNotificationCategories(completionHandler: @escaping (Set<UNNotificationCategory>) -> Void) { DispatchQueue.main.async { completionHandler(self.categories) } }
}
func drain() { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
func expect(_ condition: @autoclosure () -> Bool, _ message: String) { if !condition() { fatalError(message) } }
`;

// Expo's native-module DSL/event emitter is the SDK boundary. Compile the real
// EmitterModule against this small registry so missing exported APIs fail at the
// same dynamic boundary as JavaScript, rather than as a Swift fixture error.
const expoBoundary = String.raw`
public struct FixtureComponent { public func runOnQueue(_ queue: DispatchQueue) -> Self { self } }
@resultBuilder public enum FixtureModuleBuilder { public static func buildBlock(_ components: FixtureComponent...) {} }
public typealias ModuleDefinition = Void
public protocol Module: AnyObject { @FixtureModuleBuilder func definition() -> ModuleDefinition }
public enum FixtureBridge {
  static var functions: [String: ([Any]) -> Any] = [:]
  static var events: [(String, [String: Any])] = []
  static var creates: [() -> Void] = []
  static var destroys: [() -> Void] = []
}
public extension Module { func sendEvent(_ name: String, _ body: [String: Any]) { FixtureBridge.events.append((name, body)) } }
public func Name(_ name: String) -> FixtureComponent { FixtureComponent() }
public func Events(_ names: [String]) -> FixtureComponent { FixtureComponent() }
public func OnCreate(_ body: @escaping () -> Void) -> FixtureComponent { FixtureBridge.creates.append(body); return FixtureComponent() }
public func OnDestroy(_ body: @escaping () -> Void) -> FixtureComponent { FixtureBridge.destroys.append(body); return FixtureComponent() }
public func Function<T>(_ name: String, @_implicitSelfCapture _ body: @escaping () -> T) -> FixtureComponent { FixtureBridge.functions[name] = { _ in body() }; return FixtureComponent() }
public func AsyncFunction<T>(_ name: String, @_implicitSelfCapture _ body: @escaping () -> T) -> FixtureComponent { FixtureBridge.functions[name] = { _ in body() }; return FixtureComponent() }
public func AsyncFunction<T>(_ name: String, @_implicitSelfCapture _ body: @escaping (String) -> T) -> FixtureComponent { FixtureBridge.functions[name] = { args in body(args[0] as! String) }; return FixtureComponent() }
public enum EXNotificationSerializer {
  static func serializedNotification(_ notification: UNNotification) -> [String: Any] { [:] }
  static func serializedNotificationResponse(_ response: UNNotificationResponse) -> [String: Any] { ["actionIdentifier": response.actionIdentifier] }
}
`;

const bridgeLifecycle = String.raw`
let center = UNUserNotificationCenter.current()
center.categories = [UNNotificationCategory(identifier: "permission", actions: [UNNotificationAction(identifier: "allow", options: [])])]
let manager = NotificationCenterManager.shared
let firstEmitter = EmitterModule()
firstEmitter.definition()
FixtureBridge.creates.forEach { $0() }
var completed = 0
manager.userNotificationCenter(center, didReceive: UNNotificationResponse("allow"), withCompletionHandler: { completed += 1 })
drain()
let pending = FixtureBridge.functions["getPendingBackgroundNotificationResponses"]!([]) as! [[String: Any]]
expect(pending.count == 1, "The native bridge must expose the live response")
expect(FixtureBridge.functions["getLastNotificationResponse"]!([]) as! [String: Any]? == nil, "A live background response must never enter cached lastResponse")
let deliveryId = pending[0]["deliveryId"] as! String
expect(FixtureBridge.functions["claimBackgroundNotificationResponse"] != nil, "The native bridge must export atomic live-response admission")
expect(FixtureBridge.functions["claimBackgroundNotificationResponse"]!([deliveryId]) as! Bool, "The first JS owner must claim the live response")
expect(!(FixtureBridge.functions["claimBackgroundNotificationResponse"]!([deliveryId]) as! Bool), "A live response may be admitted only once")
expect(completed == 0, "Claiming must retain Apple's completion until execution finishes")
FixtureBridge.destroys.forEach { $0() }
FixtureBridge.creates = []; FixtureBridge.destroys = []; FixtureBridge.events = []
let secondEmitter = EmitterModule()
secondEmitter.definition()
FixtureBridge.creates.forEach { $0() }
let replay = FixtureBridge.functions["getPendingBackgroundNotificationResponses"]!([]) as! [[String: Any]]
expect(replay.isEmpty, "Recreating the JavaScript/Expo runtime cannot replay an already admitted action")
expect(!FixtureBridge.events.contains(where: { $0.0 == "onDidReceiveBackgroundNotificationResponse" }), "Delegate recreation cannot emit an already claimed response")
expect(FixtureBridge.functions["completeBackgroundNotificationResponse"]!([deliveryId]) as! Bool, "The claimed live response remains completable")
expect(completed == 1, "Recreation and completion must finish Apple once")
expect(!(FixtureBridge.functions["claimBackgroundNotificationResponse"]!([deliveryId]) as! Bool), "Finished responses cannot regain authority")
manager.userNotificationCenter(center, didReceive: UNNotificationResponse("allow"), withCompletionHandler: { completed += 1 })
drain()
let fresh = FixtureBridge.functions["getPendingBackgroundNotificationResponses"]!([]) as! [[String: Any]]
expect(fresh.count == 1, "A new OS response still delivers after runtime recreation")
let freshId = fresh[0]["deliveryId"] as! String
expect(freshId != deliveryId, "New OS actions have distinct native lifetimes")
expect(FixtureBridge.functions["claimBackgroundNotificationResponse"]!([freshId]) as! Bool, "A fresh native response is admitted")
UIApplication.shared.expirations[UIApplication.shared.nextId]!()
expect(!(FixtureBridge.functions["claimBackgroundNotificationResponse"]!([freshId]) as! Bool), "Expiry cancels admission even after a prior claim")
expect(!(FixtureBridge.functions["completeBackgroundNotificationResponse"]!([freshId]) as! Bool), "Expiry and later JS cleanup cannot complete Apple twice")
expect(completed == 2, "Expired claimed responses complete once")
expect(FixtureBridge.events.contains(where: { $0.0 == "onDidExpireBackgroundNotificationResponse" && ($0.1["deliveryId"] as? String) == freshId }), "Expiry events identify only the canceled lifetime")
print("NATIVE_BRIDGE_RELOAD_ADMISSION_CONTRACT_PASS")
`;

const lifecycle = String.raw`
let center = UNUserNotificationCenter.current()
center.categories = [UNNotificationCategory(identifier: "permission", actions: [UNNotificationAction(identifier: "allow", options: []), UNNotificationAction(identifier: "deny", options: []), UNNotificationAction(identifier: "answer", options: [.foreground])])]
let manager = NotificationCenterManager.shared
var completed = 0
manager.userNotificationCenter(center, didReceive: UNNotificationResponse("allow"), withCompletionHandler: { completed += 1 })
drain()
expect(completed == 0, "A cold background action must retain Apple's completion until JavaScript finishes")
print("COLD_BACKGROUND_COMPLETION_RETAINED")
final class Observer: NotificationDelegate {
  var background: [String] = []
  var foreground: [String] = []
  var expired: [String] = []
  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    foreground.append(response.actionIdentifier)
    completionHandler(); completionHandler()
    return true
  }
  func didReceiveBackground(_ response: UNNotificationResponse, deliveryId: String) { background.append(deliveryId) }
  func didExpireBackgroundResponse(deliveryId: String) { expired.append(deliveryId) }
}
let observer = Observer()
manager.addDelegate(observer)
expect(observer.background.count == 1, "A delegate arriving after cold response classification must receive the live action")
expect(observer.foreground.isEmpty, "Background execution must not enter Expo's ordinary cached-response path")
let first = manager.getPendingBackgroundNotificationResponses().first!.deliveryId
expect(first == observer.background[0], "The event and drain must identify the same native lifetime")
expect(manager.completeBackgroundNotificationResponse(first), "JavaScript must be able to finish the live response")
expect(completed == 1 && UIApplication.shared.ended.count == 1, "JS completion must finish Apple and UIKit exactly once")
expect(!manager.completeBackgroundNotificationResponse(first), "Duplicate completion cannot finish another lifetime")
expect(manager.getPendingBackgroundNotificationResponses().isEmpty, "Finished responses must not replay")

manager.userNotificationCenter(center, didReceive: UNNotificationResponse("deny"), withCompletionHandler: { completed += 1 })
drain()
let second = manager.getPendingBackgroundNotificationResponses().first!.deliveryId
expect(second != first && completed == 1, "A fresh action must have its own held lifetime")
UIApplication.shared.expirations[UIApplication.shared.nextId]!()
expect(observer.expired == [second], "OS expiration must cancel exactly the matching JS delivery")
expect(completed == 2 && UIApplication.shared.ended.count == 2, "Expiration must finish both native lifetimes")
expect(!manager.completeBackgroundNotificationResponse(second), "An expired response must lose live authority")
expect(!manager.claimBackgroundNotificationResponse(second), "An expired response cannot be claimed")
expect(manager.getPendingBackgroundNotificationResponses().isEmpty, "Expired responses must not replay")

let assertionsBeforeDefault = UIApplication.shared.nextId
manager.userNotificationCenter(center, didReceive: UNNotificationResponse(UNNotificationDefaultActionIdentifier), withCompletionHandler: { completed += 1 })
expect(completed == 3 && observer.foreground.last == UNNotificationDefaultActionIdentifier, "DEFAULT must preserve foreground routing and complete once")
expect(UIApplication.shared.nextId == assertionsBeforeDefault, "DEFAULT must not acquire a background lifetime")
let assertionsBeforeAnswer = UIApplication.shared.nextId
manager.userNotificationCenter(center, didReceive: UNNotificationResponse("answer"), withCompletionHandler: { completed += 1 })
drain()
expect(completed == 4 && observer.foreground.last == "answer", "Foreground Answer must preserve ordinary response routing")
expect(UIApplication.shared.nextId == assertionsBeforeAnswer, "Foreground Answer must not request a UIKit background assertion")
expect(manager.getPendingBackgroundNotificationResponses().isEmpty, "Foreground Answer must not gain background execution authority")

UIApplication.shared.expireDuringStart = true
manager.userNotificationCenter(center, didReceive: UNNotificationResponse("allow"), withCompletionHandler: { completed += 1 })
drain()
expect(completed == 5, "Expiration during assertion acquisition must finish once")
expect(observer.background.count == 2, "An immediately expired assertion must not dispatch JavaScript")
expect(manager.getPendingBackgroundNotificationResponses().isEmpty, "An immediately expired assertion must not create a pending JS action")
UIApplication.shared.expireDuringStart = false
UIApplication.shared.denyAssertion = true
manager.userNotificationCenter(center, didReceive: UNNotificationResponse("answer"), withCompletionHandler: { completed += 1 })
drain()
expect(completed == 6 && observer.foreground.last == "answer", "Foreground Answer must work when UIKit background execution is unavailable")
manager.userNotificationCenter(center, didReceive: UNNotificationResponse("allow"), withCompletionHandler: { completed += 1 })
drain()
expect(completed == 7 && observer.background.count == 2, "OS background denial must fail closed without executing JavaScript")
expect(manager.getPendingBackgroundNotificationResponses().isEmpty, "Denied background execution must not replay")
print("NATIVE_COMPLETION_EXPIRATION_AND_FOREGROUND_CONTRACT_PASS")
`;

function runNativeLifecycle(t, includeEmitter) {
  if (spawnSync('swiftc', ['--version']).status !== 0) { t.skip('Swift compiler unavailable; run this native lane on configured mac-host'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-response-native-'));
  try {
    const target = path.join(temporary, 'node_modules/expo-notifications', managerPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(uiDir, 'node_modules/expo-notifications', managerPath), target);
    if (includeEmitter) {
      const emitter = path.join(temporary, 'node_modules/expo-notifications', emitterPath);
      fs.mkdirSync(path.dirname(emitter), { recursive: true });
      fs.copyFileSync(path.join(uiDir, 'node_modules/expo-notifications', emitterPath), emitter);
    }
    const patch = fs.readFileSync(path.join(uiDir, 'patches/expo-notifications+0.32.16.patch'), 'utf8');
    const managerPatch = patch.split(/(?=^diff --git )/m).filter((part) => part.startsWith('diff --git ') && [managerPath, ...(includeEmitter ? [emitterPath] : [])].some((name) => part.split('\n', 1)[0].includes(name))).join('');
    if (managerPatch) {
      const apply = spawnSync('patch', ['--batch', '--forward', '-p1', '-d', temporary], { input: managerPatch, encoding: 'utf8' });
      if (apply.status !== 0) {
        const alreadyApplied = spawnSync('patch', ['--batch', '--reverse', '--dry-run', '-p1', '-d', temporary], { input: managerPatch, encoding: 'utf8' });
        assert.equal(alreadyApplied.status, 0, apply.stdout + apply.stderr);
      }
    }
    const source = fs.readFileSync(target, 'utf8').replace(/^import (ExpoModulesCore|UserNotifications|UIKit)\n/gm, '');
    const emitter = includeEmitter ? fs.readFileSync(path.join(temporary, 'node_modules/expo-notifications', emitterPath), 'utf8').replace(/^import (ExpoModulesCore|UIKit|MachO)\n/gm, '') : '';
    fs.writeFileSync(path.join(temporary, 'main.swift'), osBoundary + (includeEmitter ? expoBoundary : '') + source + emitter + (includeEmitter ? bridgeLifecycle : lifecycle));
    const binary = path.join(temporary, 'lifecycle');
    const compile = spawnSync('swiftc', ['-swift-version', '5', path.join(temporary, 'main.swift'), '-o', binary], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (includeEmitter) assert.match(result.stdout, /NATIVE_BRIDGE_RELOAD_ADMISSION_CONTRACT_PASS/);
    else {
      assert.match(result.stdout, /COLD_BACKGROUND_COMPLETION_RETAINED/);
      assert.match(result.stdout, /NATIVE_COMPLETION_EXPIRATION_AND_FOREGROUND_CONTRACT_PASS/);
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('iOS notification response lifetime retains the OS completion across cold JS startup', (t) => {
  runNativeLifecycle(t, false);
});

test('iOS native bridge admits a live action once across Expo/JS runtime recreation', (t) => {
  runNativeLifecycle(t, true);
});
