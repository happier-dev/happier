import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export type InstalledIosSimulatorAppBundleIdentity = Readonly<{
  appBundleFileSetSha256: string;
}>;

function xcrunCommand(env: NodeJS.ProcessEnv): string {
  return String(env.HAPPIER_E2E_XCRUN_BIN ?? '').trim() || 'xcrun';
}

function successfulStdout(result: ReturnType<typeof spawnSync>): string | null {
  if (result.error || result.status !== 0) return null;
  const stdout = typeof result.stdout === 'string'
    ? result.stdout
    : result.stdout?.toString('utf8') ?? '';
  return stdout.trim() || null;
}

function updateEntryDigest(
  digest: ReturnType<typeof createHash>,
  kind: 'file' | 'symlink',
  path: string,
  bytes: Uint8Array,
): void {
  digest.update(`${kind}\0${path}\0${bytes.byteLength}\0`);
  digest.update(bytes);
  digest.update('\0');
}

function digestAppBundleFileSet(appBundlePath: string): string {
  const digest = createHash('sha256');
  const visit = (directory: string, relativeDirectory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path, relativePath);
        continue;
      }
      if (entry.isFile()) {
        updateEntryDigest(digest, 'file', relativePath, readFileSync(path));
        continue;
      }
      if (entry.isSymbolicLink()) {
        updateEntryDigest(
          digest,
          'symlink',
          relativePath,
          Buffer.from(readlinkSync(path), 'utf8'),
        );
        continue;
      }
      throw new Error(`Unsupported iOS app bundle entry: ${relativePath}`);
    }
  };
  visit(appBundlePath, '');
  return `sha256:${digest.digest('hex')}`;
}

export function resolveInstalledIosSimulatorAppBundleIdentity(params: Readonly<{
  appId: string;
  deviceId: string;
  env: NodeJS.ProcessEnv;
}>): InstalledIosSimulatorAppBundleIdentity | null {
  const appId = params.appId.trim();
  const deviceId = params.deviceId.trim();
  if (!appId || !deviceId) return null;

  const result = spawnSync(
    xcrunCommand(params.env),
    ['simctl', 'get_app_container', deviceId, appId, 'app'],
    {
      encoding: 'utf8',
      env: { ...process.env, ...params.env },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  const appBundlePath = successfulStdout(result);
  if (!appBundlePath) return null;

  try {
    return Object.freeze({
      appBundleFileSetSha256: digestAppBundleFileSet(appBundlePath),
    });
  } catch {
    return null;
  }
}
