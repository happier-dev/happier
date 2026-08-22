/**
 * Typed surface of the `happier-desktop-native` N-API addon.
 *
 * The addon owns the macOS window and display primitives a desktop shell cannot
 * express itself. It is host-agnostic on purpose: the only thing it needs from a
 * shell is the content view's native handle, so the same addon serves an Electron
 * `BrowserWindow.getNativeWindowHandle()` and a Tauri `WebviewWindow::ns_view()`.
 *
 * No shell in this repository is wired to it yet — see `README.md`.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A rectangle in AppKit's bottom-left-origin screen coordinate space, in points. */
export type ScreenRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** `NSEdgeInsets`, in points. */
export type ScreenInsets = {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
};

/** Physical notch extents, in points. */
export type NotchSize = {
  readonly width: number;
  readonly height: number;
};

/** What the stable per-display storage key was derived from. */
export type DisplayIdentitySource = "edidComposite" | "cgDisplayId" | "unknown";

/** A display identity stable enough to key persisted per-display placement. */
export type DisplayIdentity = {
  readonly storageKey: string;
  readonly source: DisplayIdentitySource;
  readonly cgDisplayId?: number;
  readonly vendorId?: number;
  readonly modelId?: number;
  readonly serialNumber?: number;
};

/** Everything the addon reads off one attached display. */
export type DisplayGeometry = {
  readonly localizedName: string;
  readonly frame: ScreenRect;
  readonly visibleFrame: ScreenRect;
  readonly safeAreaInsets: ScreenInsets;
  readonly auxiliaryTopLeftArea: ScreenRect;
  readonly auxiliaryTopRightArea: ScreenRect;
  readonly backingScaleFactor: number;
  readonly maximumFramesPerSecond: number;
  readonly isBuiltin: boolean;
  readonly hasPhysicalNotch: boolean;
  readonly physicalNotchSize?: NotchSize;
  readonly identity: DisplayIdentity;
};

/**
 * Read-back of the window state the addon can influence. `collectionBehavior`
 * and `styleMask` are `NSUInteger` bit masks rendered as hexadecimal strings
 * because they exceed the range JavaScript numbers represent exactly.
 */
export type WindowFacts = {
  readonly viewClass: string;
  readonly windowClass: string;
  readonly level: number;
  readonly collectionBehavior: string;
  readonly styleMask: string;
  readonly isPanel: boolean;
  readonly opaque: boolean;
  readonly hasShadow: boolean;
  readonly hidesOnDeactivate: boolean;
  readonly canBecomeKeyWindow: boolean;
  readonly canBecomeMainWindow: boolean;
  readonly hasKeyMainSplit: boolean;
};

/** Requested window configuration. Omitted fields leave the current value alone. */
export type WindowConfiguration = {
  readonly canJoinAllSpaces?: boolean;
  readonly fullScreenAuxiliary?: boolean;
  readonly stationary?: boolean;
  readonly ignoresCycle?: boolean;
  /** Arbitrary integer `NSWindow.level`. */
  readonly level?: number;
  readonly hidesOnDeactivate?: boolean;
  /**
   * Install the runtime subclass that reports `canBecomeKeyWindow === true`
   * while `canBecomeMainWindow === false` — the combination no shell-level
   * `focusable` boolean can express.
   */
  readonly splitKeyAndMain?: boolean;
};

/**
 * The addon's exports. Every window and display entry point must be called on
 * the process main thread; the addon returns a typed error otherwise.
 */
export type DesktopNativeAddon = {
  /** Validate a native window handle and return its address. Thread-agnostic. */
  decodeWindowHandle(handle: Buffer): string;
  /** Enumerate attached displays in `NSScreen.screens` order. */
  listDisplays(): DisplayGeometry[];
  /** Read the window that owns `handle`'s content view, without changing it. */
  inspectWindow(handle: Buffer): WindowFacts;
  /** Apply `configuration` to that window and return the resulting state. */
  configureWindow(handle: Buffer, configuration: WindowConfiguration): WindowFacts;
};

/** Targets the addon is built for. */
export const SUPPORTED_ADDON_TARGETS = ["darwin-arm64", "darwin-x64"] as const;

export type SupportedAddonTarget = (typeof SUPPORTED_ADDON_TARGETS)[number];

/**
 * File name of the prebuilt addon for a platform/architecture pair.
 *
 * @throws when the pair has no build; callers must treat the addon as
 * unavailable rather than degrade silently.
 */
export function resolveAddonArtifactName(platform: string, arch: string): string {
  const target = `${platform}-${arch}`;
  if (!(SUPPORTED_ADDON_TARGETS as readonly string[]).includes(target)) {
    throw new Error(
      `@happier-dev/desktop-native has no addon for ${target}; supported: ${SUPPORTED_ADDON_TARGETS.join(", ")}`,
    );
  }
  return `happier-desktop-native.${target}.node`;
}

/**
 * Absolute path of the prebuilt addon inside an installed copy of this package.
 * `packageRoot` is the directory containing this package's `package.json`; the
 * caller supplies it so the resolution works identically from CommonJS and ESM
 * hosts and stays testable.
 */
export function resolveAddonPath(
  packageRoot: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return join(packageRoot, "native", resolveAddonArtifactName(platform, arch));
}

/** Load the addon at `addonPath`. */
export function loadDesktopNative(addonPath: string): DesktopNativeAddon {
  const requireFromAddon = createRequire(pathToFileURL(addonPath));
  return requireFromAddon(addonPath) as DesktopNativeAddon;
}
