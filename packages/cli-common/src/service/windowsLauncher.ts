import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSelfContainedCliRuntimeRootPath } from '../firstPartyRuntime/resolveSelfContainedCliRuntimeRoot.js';

export const WINDOWS_SERVICE_LAUNCHER_BUILD_VERSION = '1';
export const WINDOWS_SERVICE_LAUNCHER_FILE_NAME = 'happier-service-launcher.exe';
export const WINDOWS_SERVICE_LAUNCHER_PROVENANCE_MARKER = 'HAPPIER_SERVICE_LAUNCHER_V1';

export type WindowsServiceLauncherInstallSpec = Readonly<{
  sourcePath: string;
  version: string;
}>;

/**
 * Self-contained binaries (including the `<home>/bin` CLI shortcuts) carry the launcher in their
 * runtime root; npm and source checkouts carry it in this package's native asset directory.
 */
export function resolvePackagedWindowsServiceLauncherInstallSpec(
  params: Readonly<{ execPath?: string }> = {},
): WindowsServiceLauncherInstallSpec {
  const runtimeRoot = resolveSelfContainedCliRuntimeRootPath(params.execPath ?? process.execPath);
  if (runtimeRoot) {
    return resolveWindowsServiceLauncherInstallSpec(join(runtimeRoot, WINDOWS_SERVICE_LAUNCHER_FILE_NAME));
  }
  const packageAsset = join(
    resolveCliCommonPackageRoot(),
    'native',
    'windows',
    'bin',
    'windows-x64',
    WINDOWS_SERVICE_LAUNCHER_FILE_NAME,
  );
  return resolveWindowsServiceLauncherInstallSpec(packageAsset);
}

const CLI_COMMON_PACKAGE_NAME = '@happier-dev/cli-common';

/**
 * Root of the installed cli-common package. The CLI build inlines this module into its own dist,
 * so the root comes from resolving the package, not from this module's URL. If the package cannot
 * be resolved, the module-relative root (correct when unbundled) is kept; staging then fails
 * closed on a missing asset with that path in the error.
 */
function resolveCliCommonPackageRoot(): string {
  const moduleRelativeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let dir: string;
  try {
    dir = dirname(createRequire(import.meta.url).resolve(`${CLI_COMMON_PACKAGE_NAME}/service`));
  } catch {
    return moduleRelativeRoot;
  }
  while (true) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath) && readPackageName(manifestPath) === CLI_COMMON_PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) return moduleRelativeRoot;
    dir = parent;
  }
}

function readPackageName(manifestPath: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
    return typeof manifest.name === 'string' ? manifest.name : null;
  } catch {
    return null;
  }
}

/**
 * The staged directory is keyed by the launcher bytes: a running launcher cannot be replaced
 * in place, and release builds from different toolchains are not byte-identical.
 * An unreadable source keeps the bare build version; staging then fails closed on the copy.
 */
export function resolveWindowsServiceLauncherInstallSpec(sourcePath: string): WindowsServiceLauncherInstallSpec {
  let bytes: Buffer;
  try {
    bytes = readFileSync(sourcePath);
  } catch {
    return { sourcePath, version: WINDOWS_SERVICE_LAUNCHER_BUILD_VERSION };
  }
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return { sourcePath, version: `${WINDOWS_SERVICE_LAUNCHER_BUILD_VERSION}-${digest}` };
}

export function resolveInstalledWindowsServiceLauncherPaths(params: Readonly<{
  definitionPath: string;
  label: string;
  version: string;
}>): Readonly<{ launcherPath: string; diagnosticLogPath: string }> {
  const definitionPath = String(params.definitionPath ?? '').trim();
  if (!definitionPath) throw new Error('definitionPath is required for Windows service launcher paths');
  const label = sanitizeWindowsServiceLauncherSegment(params.label, 'label');
  const version = sanitizeWindowsServiceLauncherSegment(params.version, 'version');
  const definition = win32.parse(definitionPath);
  return {
    launcherPath: win32.join(definition.dir, label, `launcher-${version}`, WINDOWS_SERVICE_LAUNCHER_FILE_NAME),
    diagnosticLogPath: win32.join(definition.dir, `${definition.name}.launcher.log`),
  };
}

export async function readValidatedWindowsServiceLauncher(path: string): Promise<Buffer> {
  const sourcePath = String(path ?? '').trim();
  if (!sourcePath) throw new Error('[service] Windows service launcher source path is required');
  let bytes: Buffer;
  try {
    bytes = await readFile(sourcePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    throw new Error(
      `[service] packaged Windows service launcher is unavailable: ${sourcePath}: ${message}. `
      + 'Source checkouts must build it with scripts/pipeline/release/build-windows-service-launcher.mjs; installed packages must include the prebuilt asset.',
    );
  }
  validateWindowsServiceLauncherPe(bytes, sourcePath);
  return bytes;
}

export function validateWindowsServiceLauncherPe(bytes: Uint8Array, source = 'Windows service launcher'): void {
  const fail = (reason: string): never => {
    throw new Error(`[service] invalid ${source}: ${reason}`);
  };
  if (bytes.byteLength < 256) fail('file is too small to be a PE executable');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x5a4d) fail('missing MZ header');
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset < 0x40 || peOffset + 24 + 70 > bytes.byteLength) fail('invalid PE header offset');
  if (view.getUint32(peOffset, true) !== 0x00004550) fail('missing PE signature');
  if (view.getUint16(peOffset + 4, true) !== 0x8664) fail('expected x64 PE machine');
  const optionalHeaderOffset = peOffset + 24;
  if (view.getUint16(optionalHeaderOffset, true) !== 0x20b) fail('expected PE32+ optional header');
  if (view.getUint16(optionalHeaderOffset + 68, true) !== 2) fail('expected Windows GUI subsystem');
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(WINDOWS_SERVICE_LAUNCHER_PROVENANCE_MARKER, 'ascii'))) {
    fail(`missing provenance marker ${WINDOWS_SERVICE_LAUNCHER_PROVENANCE_MARKER}`);
  }
}

function sanitizeWindowsServiceLauncherSegment(value: string, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/u.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`invalid Windows service launcher ${field}: ${normalized || '(empty)'}`);
  }
  return normalized;
}
