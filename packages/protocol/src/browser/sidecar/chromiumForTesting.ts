import { z } from 'zod';

/**
 * Pinned Chrome-for-Testing (CfT) product source descriptor (BRW-7 / FP-BRW-SOURCE-1).
 *
 * This is the protocol-owned, pinned, provenance-bearing descriptor for the ONE managed Browser
 * binary the agent-automation / CDP / recording tier is allowed to launch. It is NOT for human
 * browsing (human `externalUrl` on desktop routes to the native WebView engine) and it does NOT
 * widen the product whitelist — system/PATH Chrome, floating CfT, Playwright caches and Electron
 * Chromium are never product sources.
 *
 * Chrome-for-Testing is published by the Chromium team as per-platform `chrome-{platform}.zip`
 * archives addressable by an exact, immutable version under
 * `https://storage.googleapis.com/chrome-for-testing-public/<version>/<platform>/chrome-<platform>.zip`.
 * The archive layout places the executable at a known per-platform subpath.
 *
 * INTEGRITY BOUNDARY: this descriptor pins the version/channel/license, the exact per-platform
 * archive URL + executable subpath, and the per-platform `integrityDigest` — the real sha256 of
 * the hosted CfT archive bytes for the pinned build (verified locally before unpack). The schema
 * still permits `null` so a future un-digested build fails closed, but the pinned
 * `127.0.6533.88` build records the real digest for every supported platform. A digest is NEVER
 * trusted from a caller; it is pinned here and verified locally before unpack.
 *
 * The digests below were computed by downloading the four public Chrome-for-Testing archives for
 * `127.0.6533.88` from `storage.googleapis.com/chrome-for-testing-public` and running sha256 over
 * the archive bytes (cross-checked against the host-published md5 in the object headers).
 */

export const ChromiumForTestingPlatformSchema = z.enum([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'win32-x64',
]);
export type ChromiumForTestingPlatform = z.infer<typeof ChromiumForTestingPlatformSchema>;

const Sha256DigestSchema = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Integrity digest must be a lowercase sha256:<hex64> string');

export const ChromiumForTestingPlatformAssetSchema = z
  .object({
    /** Exact, immutable archive URL for the pinned CfT build on this platform. */
    archiveUrl: z.string().trim().url(),
    /**
     * Pinned sha256 of the hosted archive bytes, verified locally before unpack. `null` marks the
     * external-artifact remainder: the source resolver fails closed for that platform until the
     * real digest of the pinned build is recorded here.
     */
    integrityDigest: Sha256DigestSchema.nullable(),
    /** Relative path of the chrome executable inside the extracted archive root. */
    executableSubpath: z.string().trim().min(1).refine((value) => {
      if (value.startsWith('/') || value.startsWith('\\')) return false;
      return !value.split(/[\\/]+/).some((segment) => segment === '' || segment === '.' || segment === '..');
    }, 'Executable subpath must be a relative, traversal-free path'),
  })
  .strict();
export type ChromiumForTestingPlatformAsset = z.infer<typeof ChromiumForTestingPlatformAssetSchema>;

export const ChromiumForTestingProductSourceV1Schema = z
  .object({
    /** Stable managed-tools key; also the managed install dir under `<happyHomeDir>/tools/<key>`. */
    key: z.literal('browser-chromium'),
    /** Exact pinned CfT build (immutable version, never "latest"). */
    pinnedVersion: z.string().trim().regex(/^[0-9]+(?:\.[0-9]+){3}$/, 'CfT version must be an exact x.y.z.w build'),
    channel: z.enum(['stable', 'beta', 'dev', 'canary']),
    license: z.string().trim().min(1),
    assetsByPlatform: z.record(ChromiumForTestingPlatformSchema, ChromiumForTestingPlatformAssetSchema),
  })
  .strict();
export type ChromiumForTestingProductSourceV1 = z.infer<typeof ChromiumForTestingProductSourceV1Schema>;

/**
 * The single pinned managed Chrome-for-Testing descriptor. Version/channel/license + per-platform
 * archive URL + executable subpath are pinned here, together with the per-platform
 * `integrityDigest` (real sha256 of the pinned build's archive bytes). The CfT zip extracts to a
 * single `chrome-<platform>` root directory; the executable subpath is relative to that root.
 */
export const CHROMIUM_FOR_TESTING_PRODUCT_SOURCE = ChromiumForTestingProductSourceV1Schema.parse({
  key: 'browser-chromium',
  pinnedVersion: '127.0.6533.88',
  channel: 'stable',
  license: 'BSD-3-Clause',
  assetsByPlatform: {
    'darwin-arm64': {
      archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/mac-arm64/chrome-mac-arm64.zip',
      integrityDigest: 'sha256:268ac56d0cdf3d64779f7c336a27defb81ec46e9c9d96dbc28dfb3739c0114b6',
      executableSubpath: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    },
    'darwin-x64': {
      archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/mac-x64/chrome-mac-x64.zip',
      integrityDigest: 'sha256:91a010d846597e068f63b0d6ebb56f6a242ced697bc2b8375e22a24fc668582a',
      executableSubpath: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    },
    'linux-x64': {
      archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/linux64/chrome-linux64.zip',
      integrityDigest: 'sha256:20e2000334f8cefa115ad3e2c55d6ad0e3e254be33a5fd0b9178c3d1a9c78ba9',
      executableSubpath: 'chrome',
    },
    'win32-x64': {
      archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/win64/chrome-win64.zip',
      integrityDigest: 'sha256:3c334d94c0f539e70d64aa46f5e117096f32ff5d3db5d6957f04e76d0746e7a0',
      executableSubpath: 'chrome.exe',
    },
  },
} satisfies ChromiumForTestingProductSourceV1);

export function resolveChromiumForTestingPlatform(
  platform: string,
  arch: string,
): ChromiumForTestingPlatform | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64';
    if (arch === 'x64') return 'darwin-x64';
    return null;
  }
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}
