import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

// POSIX executable fixtures stand in for Windows CLI/minisign processes. The
// full PowerShell installer, archive verification, promotion and fallback run.
for (const powerShell of process.env.HAPPIER_TEST_POWERSHELL ? [process.env.HAPPIER_TEST_POWERSHELL] : ['pwsh']) {
  const available = process.platform !== 'win32' && spawnSync(powerShell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`PowerShell explicit install relinquishes Desktop ownership only after promotion under ${powerShell}`, {
    skip: !available && 'Requires PowerShell with POSIX executable fixtures',
  }, async (t) => {
    const source = (await readFile(join(repoRoot, 'scripts/release/installers/install.ps1'), 'utf8')).replace(/^\uFEFF/, '');
    for (const scenario of ['promoted', 'legacy', 'promotion-failure', 'checksum-failure', 'rollback', 'run-action']) {
      await t.test(scenario, async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-windows-ownership-'));
        try {
          const installDir = join(root, 'install home');
          const binDir = join(installDir, 'bin');
          const fixtureDir = join(root, 'assets');
          const toolsDir = join(root, 'tools');
          const stem = 'happier-v1.2.3-windows-x64';
          const payloadDir = join(fixtureDir, stem);
          const claimPath = join(installDir, 'cli-preview.desktop-ownership.json');
          const otherClaimPath = join(installDir, 'cli.desktop-ownership.json');
          const claim = JSON.stringify({ version: 1, createdByDesktop: true, consumers: ['dev.happier.app'] });
          await Promise.all([mkdir(binDir, { recursive: true }), mkdir(payloadDir, { recursive: true }), mkdir(toolsDir)]);
          await Promise.all([writeFile(claimPath, claim), writeFile(otherClaimPath, claim)]);
          const binary = join(payloadDir, 'happier.exe');
          await writeFile(binary, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == self && "$2" == __install-payload ]]; then
  case "$HAPPIER_TEST_INSTALL_SCENARIO" in
    legacy) echo 'Unknown self subcommand: __install-payload' >&2; exit 1 ;;
    promotion-failure) echo 'promotion rejected' >&2; exit 23 ;;
  esac
  payload=''
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --payload-root ]]; then payload="$2"; shift; fi
    shift
  done
  cp "$payload/happier.exe" "$HAPPIER_INSTALL_DIR/bin/hprev.exe"
  exit 0
fi
if [[ "$1" == --version ]]; then echo 1.2.3; fi
if [[ "$1" == --help && "$HAPPIER_TEST_INSTALL_SCENARIO" == run-action ]]; then echo '  happier auth  Account authentication'; fi
exit 0
`);
          await chmod(binary, 0o755);
          for (const [name, body] of [['minisign', '#!/bin/sh\nexit 0\n'], ['tar.exe', '#!/bin/sh\nexec tar "$@"\n']]) {
            await writeFile(join(toolsDir, name), body);
            await chmod(join(toolsDir, name), 0o755);
          }
          const archiveName = `${stem}.tar.gz`;
          const archivePath = join(fixtureDir, archiveName);
          const archived = spawnSync('tar', ['-czf', archivePath, '-C', fixtureDir, stem], { encoding: 'utf8' });
          assert.equal(archived.status, 0, archived.stderr);
          const checksum = scenario === 'checksum-failure' ? '0'.repeat(64) : createHash('sha256').update(await readFile(archivePath)).digest('hex');
          await writeFile(join(fixtureDir, 'checksums-happier-v1.2.3.txt'), `${checksum}  ${archiveName}\n`);
          await writeFile(join(fixtureDir, 'checksums-happier-v1.2.3.txt.minisig'), 'signature fixture');
          if (scenario === 'run-action') {
            await writeFile(join(binDir, 'hprev.exe'), await readFile(binary));
            await chmod(join(binDir, 'hprev.exe'), 0o755);
          }
          const installerPath = join(root, 'install.ps1');
          // Registry writes, Windows inventory and process window visibility are
          // OS boundaries. No installer/domain functions are replaced.
          await writeFile(installerPath, source.replaceAll('[Environment]::SetEnvironmentVariable', '[InstallerTest.Environment]::SetEnvironmentVariable'));
          const scriptPath = join(root, 'exercise.ps1');
          await writeFile(scriptPath, [
            "$ErrorActionPreference = 'Stop'",
            `$env:HAPPIER_INSTALL_DIR = ${quote(installDir)}`,
            `$env:HAPPIER_HOME_DIR = ${quote(join(root, 'state'))}`,
            `$env:USERPROFILE = ${quote(root)}`,
            `$env:HAPPIER_RELEASE_ASSETS_DIR = ${quote(fixtureDir)}`,
            `$env:HAPPIER_TEST_INSTALL_SCENARIO = ${quote(scenario)}`,
            '$env:HAPPIER_NO_PATH_UPDATE = "1"',
            '$env:HAPPIER_INSTALLER_ACTION = $null',
            '$env:HAPPIER_INSTALLER_RUN_ACTION = $null',
            '$env:HAPPIER_INSTALLER_SETUP_RELAY = $null',
            `$env:PATH = ${quote(`${toolsDir}:${dirname(powerShell)}:${process.env.PATH}`)}`,
            "Add-Type -TypeDefinition 'namespace InstallerTest { public static class Environment { public static void SetEnvironmentVariable(string name, string value, System.EnvironmentVariableTarget target) {} } }'",
            'function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) }',
            'function Get-ScheduledTask { param($TaskPath, $ErrorAction) }',
            'function Start-Process { param($FilePath, $ArgumentList, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError, $WindowStyle) $PSBoundParameters.Remove("WindowStyle") | Out-Null; Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters }',
            `& ${quote(installerPath)} -Channel preview -Version 1.2.3 -Yes -WithoutDaemon${scenario === 'rollback' ? ' -Rollback' : scenario === 'run-action' ? ' -Run auth-login' : ''}`,
          ].join('\n'));
          const result = spawnSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8', maxBuffer: 2 ** 20 });
          const succeeded = ['promoted', 'legacy', 'run-action'].includes(scenario);
          assert.equal(result.status === 0, succeeded, result.stderr || result.stdout);
          if (scenario === 'promoted' || scenario === 'legacy') {
            assert.equal(existsSync(claimPath), false, 'successful explicit install must release ownership even when the payload cannot do so');
            assert.equal(existsSync(join(binDir, 'hprev.exe')), true);
          } else {
            assert.equal(await readFile(claimPath, 'utf8'), claim, 'failed installation and non-install actions must retain ownership');
          }
          assert.equal(await readFile(otherClaimPath, 'utf8'), claim, 'other release channels retain ownership');
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  });
}
