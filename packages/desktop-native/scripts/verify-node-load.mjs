#!/usr/bin/env node
// Headless portability check: the addon must load in a plain Node process (and
// therefore under `ELECTRON_RUN_AS_NODE`), not only inside an Electron renderer
// or main process. Exercises only the platform-independent entry point, so it
// needs no window and no GUI session.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifact = join(
  packageDir,
  "native",
  `happier-desktop-native.${process.platform}-${process.arch}.node`,
);

const addon = require(artifact);

const expected = ["decodeWindowHandle", "listDisplays", "inspectWindow", "configureWindow"];
const missing = expected.filter((name) => typeof addon[name] !== "function");
if (missing.length > 0) {
  throw new Error(`addon is missing exports: ${missing.join(", ")}`);
}

const handle = Buffer.alloc(8);
handle.writeBigUInt64LE(0x6000_0123_4560n);
const decoded = addon.decodeWindowHandle(handle);
if (decoded !== "0x600001234560") {
  throw new Error(`decodeWindowHandle returned ${decoded}`);
}

let rejected = false;
try {
  addon.decodeWindowHandle(Buffer.alloc(0));
} catch (error) {
  rejected = /at least/.test(String(error && error.message));
}
if (!rejected) {
  throw new Error("decodeWindowHandle accepted an empty buffer");
}

process.stdout.write(
  `loaded ${artifact} in node ${process.versions.node} (exports: ${expected.join(", ")})\n`,
);
