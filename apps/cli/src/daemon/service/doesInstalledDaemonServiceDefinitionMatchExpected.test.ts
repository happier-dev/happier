import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { withTempDir } from '@/testkit/fs/tempDir';

import { doesInstalledDaemonServiceDefinitionMatchExpected } from './doesInstalledDaemonServiceDefinitionMatchExpected';

// Fixtures modelled on the actual plist shapes we produce for the
// `com.happier.cli.daemon.default` default-following service. The key point
// is that two definitions can *differ* in their `ProgramArguments` launcher
// and `PATH` env var yet still launch the same daemon under the same config.

const BOILERPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.happier.cli.daemon.default</string>
    <key>ProgramArguments</key>
    <array>__PROGRAM_ARGS__
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/tmp</string>
    <key>StandardOutPath</key>
    <string>/Users/me/.happier/logs/daemon-service.default.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/me/.happier/logs/daemon-service.default.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>__PATH__</string>
      <key>HAPPIER_HOME_DIR</key>
      <string>/Users/me/.happier</string>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>dev</string>
      <key>HAPPIER_DAEMON_STARTUP_SOURCE</key>
      <string>background-service</string>
      <key>HAPPIER_DAEMON_SERVICE_LABEL</key>
      <string>com.happier.cli.daemon.default</string>
      <key>HAPPIER_DAEMON_SERVICE_TARGET_MODE</key>
      <string>default-following</string>
      <key>HAPPIER_NO_BROWSER_OPEN</key>
      <string>1</string>
      <key>HAPPIER_DAEMON_WAIT_FOR_AUTH</key>
      <string>1</string>
      <key>HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS</key>
      <string>0</string>
    </dict>
  </dict>
</plist>
`;

const PROGRAM_ARGS_NODE_ENTRY = `
      <string>/Users/me/.local/share/fnm/node-versions/v22.22.1/installation/bin/node</string>
      <string>/Users/me/.happier/cli-dev/current/package-dist/index.mjs</string>
      <string>daemon</string>
      <string>start-sync</string>`;

const PROGRAM_ARGS_SHIM = `
      <string>/Users/me/.happier/bin/happier</string>
      <string>daemon</string>
      <string>start-sync</string>`;

const PATH_A = '/Users/me/.local/share/fnm/node-versions/v22.22.1/installation/bin:/Users/me/.local/share/fnm/fnm_multishells/53200_1776691283247/bin:/opt/homebrew/bin:/usr/bin:/bin';
const PATH_B = '/Users/me/.local/share/fnm/node-versions/v22.22.1/installation/bin:/Users/me/.local/share/fnm/fnm_multishells/26938_1776667547724/bin:/Users/me/node_modules/.bin:/opt/homebrew/bin:/usr/bin:/bin';

function plist(programArgs: string, path: string): string {
  return BOILERPLATE.replace('__PROGRAM_ARGS__', programArgs).replace('__PATH__', path);
}

function writePlistFile(dir: string, contents: string): string {
  const filePath = join(dir, 'com.happier.cli.daemon.default.plist');
  writeFileSync(filePath, contents, 'utf-8');
  return filePath;
}

describe('doesInstalledDaemonServiceDefinitionMatchExpected', () => {
  const systemdUnit = (path: string) => renderSystemdServiceUnit({
    description: 'Happier CLI daemon (default)',
    execStart: ['/home/test/.happier/bin/happier', 'daemon', 'start-sync', '--takeover'],
    workingDirectory: '%h',
    env: { PATH: path, HAPPIER_HOME_DIR: '/home/test/.happier', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable' },
    killMode: 'process',
    restart: 'on-failure',
  });

  it('matches systemd units across inherited PATH changes, including quoted values', async () => {
    await withTempDir('systemd-path-drift-', async (dir) => {
      const installedPath = join(dir, 'happier-daemon.default.service');
      writeFileSync(installedPath, systemdUnit('/home/test/.happier/bin:/usr/bin:/bin'));
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents: systemdUnit('/home/test/shell tools/bin:/usr/bin:/bin'),
      })).toBe(true);
    });
  });

  it.each([
    ['launcher', (unit: string) => unit.replace('/bin/happier daemon', '/bin/hprev daemon')],
    ['command', (unit: string) => unit.replace('--takeover', '--other')],
    ['environment', (unit: string) => unit.replace('HAPPIER_PUBLIC_RELEASE_CHANNEL=stable', 'HAPPIER_PUBLIC_RELEASE_CHANNEL=preview')],
    ['lifecycle', (unit: string) => unit.replace('KillMode=process', 'KillMode=control-group')],
    ['missing PATH', (unit: string) => unit.replace(/^Environment=PATH=.*\n/m, '')],
    ['extra assignment', (unit: string) => unit.replace(/^(Environment=PATH=.*)$/m, '$1 HAPPIER_HOME_DIR=/other')],
  ])('still detects systemd %s drift alongside a different PATH', async (_name, change) => {
    await withTempDir('systemd-real-drift-', async (dir) => {
      const installedPath = join(dir, 'happier-daemon.default.service');
      writeFileSync(installedPath, systemdUnit('/usr/bin:/bin'));
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents: change(systemdUnit('/home/test/shell tools/bin:/usr/bin:/bin')),
      })).toBe(false);
    });
  });

  it('returns true when installed and expected are byte-identical', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const content = plist(PROGRAM_ARGS_SHIM, PATH_A);
      const installedPath = writePlistFile(dir, content);
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents: content,
      })).toBe(true);
    });
  });

  it('returns true when PATH drifts but everything else matches (main reported bug)', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = writePlistFile(dir, plist(PROGRAM_ARGS_SHIM, PATH_A));
      const expectedContents = plist(PROGRAM_ARGS_SHIM, PATH_B);
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents,
      })).toBe(true);
    });
  });

  it('returns true when ProgramArguments shape differs (shim vs node+entry) but env vars match', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = writePlistFile(dir, plist(PROGRAM_ARGS_NODE_ENTRY, PATH_A));
      const expectedContents = plist(PROGRAM_ARGS_SHIM, PATH_B);
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents,
      })).toBe(true);
    });
  });

  it('returns true when BOTH PATH and ProgramArguments form drift together (the actual screenshot scenario)', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = writePlistFile(dir, plist(PROGRAM_ARGS_NODE_ENTRY, PATH_A));
      const expectedContents = plist(PROGRAM_ARGS_SHIM, PATH_B);
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents,
      })).toBe(true);
    });
  });

  it('returns false when the release channel env var differs', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = writePlistFile(dir, plist(PROGRAM_ARGS_SHIM, PATH_A));
      const expectedContents = plist(PROGRAM_ARGS_SHIM, PATH_A)
        .replace('<string>dev</string>', '<string>stable</string>');
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents,
      })).toBe(false);
    });
  });

  it('returns false when the target mode env var differs', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = writePlistFile(dir, plist(PROGRAM_ARGS_SHIM, PATH_A));
      const expectedContents = plist(PROGRAM_ARGS_SHIM, PATH_A)
        .replace('<string>default-following</string>', '<string>pinned</string>');
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents,
      })).toBe(false);
    });
  });

  it('returns false when the Label differs', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = writePlistFile(dir, plist(PROGRAM_ARGS_SHIM, PATH_A));
      const expectedContents = plist(PROGRAM_ARGS_SHIM, PATH_A)
        .replaceAll('com.happier.cli.daemon.default', 'com.happier.cli.daemon.other');
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents,
      })).toBe(false);
    });
  });

  it('returns false when ProgramArguments trailing command differs', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = writePlistFile(dir, plist(PROGRAM_ARGS_SHIM, PATH_A));
      const different = plist(
        `
      <string>/Users/me/.happier/bin/happier</string>
      <string>daemon</string>
      <string>start-verbose</string>`,
        PATH_A,
      );
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents: different,
      })).toBe(false);
    });
  });

  it('returns false when the installed file does not exist', () => {
    expect(doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath: '/tmp/does-not-exist-12345.plist',
      expectedContents: 'irrelevant',
    })).toBe(false);
  });

  it('returns false when the file is not a recognisable plist', async () => {
    await withTempDir('plist-signature-', async (dir) => {
      const installedPath = join(dir, 'junk.plist');
      writeFileSync(installedPath, 'not a plist', 'utf-8');
      expect(doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath,
        expectedContents: plist(PROGRAM_ARGS_SHIM, PATH_A),
      })).toBe(false);
    });
  });
});
