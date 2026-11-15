import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installVersionedPayload,
  readInstalledVersionMarkers,
  resolveFirstPartyInstallLayout,
  resolveInstalledFirstPartyComponentPaths,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import packageJson from '../../../package.json';
import { handleSelfCliCommand } from './self';

// Executable fixtures use POSIX shell; the installer and version probe remain real.
describe.skipIf(process.platform === 'win32')('managed guest payload admission', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR', 'HAPPIER_FIRST_PARTY_INSTALL_HOME', 'HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION', 'DEBUG',
  ]);
  const initialExitCode = process.exitCode;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'happier-managed-install-'));
    envScope.patch({
      HAPPIER_HOME_DIR: join(root, 'home'),
      HAPPIER_FIRST_PARTY_INSTALL_HOME: join(root, 'home'),
      HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION: '1',
      DEBUG: '1',
    });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('command exited'); }) as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = initialExitCode;
    envScope.restore();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function payload(name: string, version: string): string {
    const path = join(root, name);
    mkdirSync(join(path, 'package-dist'), { recursive: true });
    writeFileSync(join(path, 'package-dist', 'index.mjs'), 'export {};\n');
    writeFileSync(join(path, 'happier'), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(join(path, 'happier'), 0o755);
    return path;
  }

  async function seedInstalled(version: string): Promise<void> {
    await installVersionedPayload({
      componentId: 'happier-cli', channel: 'stable', versionId: version,
      payloadRoot: payload('installed', version), processEnv: process.env,
    });
  }

  async function run(payloadRoot: string, managed = true, versionId = packageJson.version): Promise<void> {
    const args = ['self', '__install-payload', '--component', 'happier-cli', '--channel', 'stable',
      '--payload-root', payloadRoot, '--version', versionId, ...(managed ? ['--managed-guest'] : [])];
    await handleSelfCliCommand({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
  }

  function expectRefusal(code: string): void {
    expect(vi.mocked(console.error).mock.calls.flat()).toContainEqual(expect.objectContaining({ code }));
  }

  it('refuses a newer installed CLI before promotion even when --version claims a newer candidate', async () => {
    await seedInstalled('999.0.0');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: process.env });
    const paths = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', processEnv: process.env });
    const before = readFileSync(paths.binaryPath, 'utf8');
    const staged = payload('staged', packageJson.version);

    await expect(run(staged, true, '1000.0.0')).rejects.toThrow('command exited');

    expectRefusal('managed_guest_cli_release_downgrade');
    expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: '999.0.0', previousVersionId: null });
    expect(readdirSync(layout.versionsDir)).toEqual(['999.0.0']);
    expect(readFileSync(paths.binaryPath, 'utf8')).toBe(before);
    expect(existsSync(staged)).toBe(true);
  });

  it.each(['unreadable', 'dangling-binary', 'dangling-current'])('refuses an existing %s installation without promotion', async (kind) => {
    const paths = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', processEnv: process.env });
    mkdirSync(paths.installRoot, { recursive: true });
    if (kind === 'dangling-current') {
      symlinkSync(join(root, 'missing-payload'), paths.currentPath);
    } else {
      mkdirSync(paths.currentPath);
      if (kind === 'dangling-binary') symlinkSync(join(root, 'missing-binary'), paths.binaryPath);
      else {
        writeFileSync(paths.binaryPath, '#!/bin/sh\nexit 1\n');
        chmodSync(paths.binaryPath, 0o755);
      }
    }
    const staged = payload('staged', packageJson.version);

    await expect(run(staged)).rejects.toThrow('command exited');

    expectRefusal('guest_cli_version_unavailable');
    expect(existsSync(paths.versionsDir)).toBe(false);
    expect(existsSync(staged)).toBe(true);
  });

  it.each([undefined, packageJson.version, '0.0.1'])('promotes with installed version %s', async (installedVersion) => {
    if (installedVersion) await seedInstalled(installedVersion);
    const staged = payload('staged', packageJson.version);

    await run(staged);

    const paths = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', processEnv: process.env });
    expect(readFileSync(paths.binaryPath, 'utf8')).toContain(packageJson.version);
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: process.env });
    expect((await readInstalledVersionMarkers(layout)).currentVersionId).toBe(packageJson.version);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('preserves an ordinary explicit installer downgrade when --managed-guest is absent', async () => {
    await seedInstalled('999.0.0');

    await run(payload('staged', packageJson.version), false);

    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: process.env });
    expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: packageJson.version, previousVersionId: '999.0.0' });
    expect(process.exit).not.toHaveBeenCalled();
  });
});
