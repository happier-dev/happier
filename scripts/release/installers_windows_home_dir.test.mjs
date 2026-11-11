import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const powerShell of ['powershell.exe', 'pwsh']) {
  const available = spawnSync(powerShell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`Windows installer keeps terminal and background-service homes aligned under ${powerShell}`, {
    skip: !available && 'PowerShell is unavailable',
  }, async () => {
    const source = (await readFile(join(repoRoot, 'scripts/release/installers/install.ps1'), 'utf8')).replaceAll('\r\n', '\n');
    const resolution = source.match(/^\$InstallDir = .*\n\$DaemonServiceStateHomeDir = .*$/m)?.[0];
    const environmentSetup = source.match(/  if \(\$LegacyBinDir -ne \$BinDir\) \{[\s\S]*?\n  \}\n([\s\S]*?)\n  \$invoker = Resolve-InstalledCliInvoker/)?.[1];
    const syncInstallerPath = source.match(/^function Sync-InstallerPath \{[\s\S]*?\n\}$/m)?.[0];
    assert.ok(resolution && environmentSetup && syncInstallerPath, 'expected installed CLI environment setup');
    // The Windows user/machine environment is an OS boundary. Keep the real
    // installer resolution and setup, but avoid changing the test user's registry.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Add-Type -TypeDefinition @'
namespace InstallerTest {
  public static class Environment {
    public static System.Collections.Generic.Dictionary<string, string> User = new System.Collections.Generic.Dictionary<string, string>();
    public static string GetEnvironmentVariable(string name, System.EnvironmentVariableTarget target) {
      return target == System.EnvironmentVariableTarget.User && User.ContainsKey(name) ? User[name] : null;
    }
    public static void SetEnvironmentVariable(string name, string value, System.EnvironmentVariableTarget target) {
      if (target != System.EnvironmentVariableTarget.User) throw new System.Exception("Unexpected environment scope");
      User[name] = value;
    }
  }
}
'@`,
      syncInstallerPath.replaceAll('[Environment]', '[InstallerTest.Environment]'),
      '$env:USERPROFILE = [IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar)',
      'foreach ($case in @("custom-install", "separate-home", "home-only", "default", "no-path-update")) {',
      '  [InstallerTest.Environment]::User.Clear()',
      '  $env:HAPPIER_INSTALL_DIR = $null; $env:HAPPIER_HOME_DIR = $null',
      '  $NoPathUpdate = if ($case -eq "no-path-update") { "1" } else { "0" }',
      '  $expected = Join-Path $env:USERPROFILE ".happier"',
      '  if ($case -in @("custom-install", "separate-home", "no-path-update")) { $env:HAPPIER_INSTALL_DIR = Join-Path $env:USERPROFILE "Programs\\happier"; $expected = $env:HAPPIER_INSTALL_DIR }',
      '  if ($case -in @("separate-home", "home-only")) { $env:HAPPIER_HOME_DIR = Join-Path $env:USERPROFILE "happier-data"; $expected = $env:HAPPIER_HOME_DIR }',
      resolution,
      '  $BinDir = Join-Path $InstallDir "bin"',
      environmentSetup.replaceAll('[Environment]', '[InstallerTest.Environment]'),
      '  if ($env:HAPPIER_HOME_DIR -ne $expected) { throw ("Installer CLI home differs from service home: " + $case) }',
      // A new terminal receives user-scoped environment, not the installer's
      // temporary process environment or HAPPIER_INSTALL_DIR input.
      '  $env:HAPPIER_INSTALL_DIR = $null; $env:HAPPIER_HOME_DIR = $null',
      '  $env:HAPPIER_HOME_DIR = [InstallerTest.Environment]::GetEnvironmentVariable("HAPPIER_HOME_DIR", [EnvironmentVariableTarget]::User)',
      '  if ($env:HAPPIER_HOME_DIR -ne $DaemonServiceStateHomeDir -or $env:HAPPIER_HOME_DIR -ne $expected) { throw ("New terminal home differs from service home: " + $case) }',
      '}',
      'Write-Output "installer-homes-aligned"',
    ].join('\n');
    const result = spawnSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installer-homes-aligned/);
  });
}
