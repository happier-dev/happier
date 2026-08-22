import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadDesktopNative,
  resolveAddonArtifactName,
  resolveAddonPath,
  SUPPORTED_ADDON_TARGETS,
} from "./index";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("resolveAddonArtifactName", () => {
  it("names the addon for every supported target", () => {
    expect(resolveAddonArtifactName("darwin", "arm64")).toBe(
      "happier-desktop-native.darwin-arm64.node",
    );
    expect(resolveAddonArtifactName("darwin", "x64")).toBe(
      "happier-desktop-native.darwin-x64.node",
    );
  });

  it("refuses a platform the addon is not built for", () => {
    expect(() => resolveAddonArtifactName("linux", "x64")).toThrowError(/no addon for linux-x64/);
    expect(() => resolveAddonArtifactName("win32", "x64")).toThrowError(/no addon for win32-x64/);
  });

  it("refuses an architecture macOS is not built for", () => {
    expect(() => resolveAddonArtifactName("darwin", "ia32")).toThrowError(
      /no addon for darwin-ia32/,
    );
  });

  it("covers exactly the advertised target list", () => {
    expect([...SUPPORTED_ADDON_TARGETS]).toEqual(["darwin-arm64", "darwin-x64"]);
  });
});

describe("resolveAddonPath", () => {
  it("places the addon under the package's native directory", () => {
    expect(resolveAddonPath("/pkg", "darwin", "arm64")).toBe(
      join("/pkg", "native", "happier-desktop-native.darwin-arm64.node"),
    );
  });
});

const artifact = existsSync(join(packageRoot, "native"))
  ? (() => {
      try {
        return resolveAddonPath(packageRoot);
      } catch {
        return undefined;
      }
    })()
  : undefined;
const addonIsBuilt = artifact !== undefined && existsSync(artifact);

describe.skipIf(!addonIsBuilt)("the built addon", () => {
  it("exposes the documented entry points and guards a malformed handle", () => {
    const addon = loadDesktopNative(artifact as string);

    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(0x6000_0123_4560n);
    expect(addon.decodeWindowHandle(handle)).toBe("0x600001234560");

    expect(() => addon.decodeWindowHandle(Buffer.alloc(0))).toThrowError(/at least 8 bytes/);
    expect(() => addon.decodeWindowHandle(Buffer.alloc(8))).toThrowError(/null pointer/);
    expect(() => addon.inspectWindow(Buffer.alloc(0))).toThrowError(/at least 8 bytes/);
  });
});
