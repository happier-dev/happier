import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

for (const powerShell of process.env.HAPPIER_TEST_POWERSHELL ? [process.env.HAPPIER_TEST_POWERSHELL] : ['powershell.exe', 'pwsh']) {
  const available = spawnSync(powerShell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`Windows installer uninstall preserves data and other channels under ${powerShell}`, {
    skip: !available && 'PowerShell is unavailable',
  }, async (t) => {
    const source = (await readFile(join(repoRoot, 'scripts/release/installers/install.ps1'), 'utf8')).replace(/^\uFEFF/, '');
    for (const scenario of ['selected-channel', 'other-default', 'default-fallback', 'last-channel', 'last-channel-no-path-update', 'service-failure', 'unsupported-cli', 'missing-cli']) {
      await t.test(scenario, async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-windows-uninstall-'));
        try {
          const installDir = join(root, 'programs');
          const dataDir = join(root, 'data');
          const binDir = join(installDir, 'bin');
          const managedRoot = join(installDir, 'cli-preview');
          const desktopOwnershipPath = `${managedRoot}.desktop-ownership.json`;
          const desktopOwnership = JSON.stringify({ version: 1, createdByDesktop: true, consumers: ['dev.happier.app'] });
          const cliPath = join(binDir, 'hprev.exe');
          const callsPath = join(root, 'calls.jsonl');
          const pathState = join(root, 'user-path');
          const installerPath = join(root, 'install.ps1');
          const extraBin = `${binDir}-other`;
          const originalPath = `${scenario.startsWith('last-channel') ? `${binDir.toUpperCase()}\\` : binDir};${extraBin}`;
          await Promise.all([mkdir(managedRoot, { recursive: true }), mkdir(binDir, { recursive: true }), mkdir(dataDir)]);
          if (scenario === 'default-fallback') {
            await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
            await writeFile(join(installDir, 'cli', 'current', 'happier.exe'), 'remaining stable binary');
          }
          await Promise.all([
            writeFile(join(managedRoot, 'payload'), 'managed payload'),
            writeFile(desktopOwnershipPath, desktopOwnership),
            writeFile(join(installDir, 'cli.desktop-ownership.json'), desktopOwnership),
            writeFile(join(dataDir, 'settings.json'), 'retained settings'),
            writeFile(join(installDir, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: scenario === 'other-default' ? 'stable' : 'preview' })),
            writeFile(join(binDir, 'happier.exe'), 'managed default shim'),
            writeFile(pathState, originalPath),
            ...(scenario === 'missing-cli' ? [] : [writeFile(cliPath, 'managed preview shim')]),
            ...(scenario.startsWith('last-channel') ? [] : [writeFile(join(binDir, 'hdev.exe'), 'other channel shim')]),
            writeFile(installerPath, `\uFEFF${source.replaceAll('[Environment]::GetEnvironmentVariable', '[InstallerTest.Environment]::GetEnvironmentVariable').replaceAll('[Environment]::SetEnvironmentVariable', '[InstallerTest.Environment]::SetEnvironmentVariable')}`),
          ]);
          // The registry and external CLI process are system boundaries. Keep
          // the complete installer dispatch, context, and filesystem logic real.
          const script = [
            "$ErrorActionPreference = 'Stop'",
            `$env:HAPPIER_INSTALL_DIR = ${quote(installDir)}`,
            `$env:HAPPIER_HOME_DIR = ${quote(dataDir)}`,
            `$env:USERPROFILE = ${quote(root)}`,
            '$env:HAPPIER_INSTALLER_ACTION = "uninstall"',
            '$env:HAPPIER_INSTALLER_SETUP_RELAY = $null',
            '$env:HAPPIER_INSTALLER_RUN_ACTION = $null',
            `$env:HAPPIER_NO_PATH_UPDATE = ${scenario === 'last-channel-no-path-update' ? '"1"' : '$null'}`,
            `$env:Path = ${quote(originalPath)}`,
            `Add-Type -TypeDefinition @'
namespace InstallerTest {
  public static class Environment {
    public static string GetEnvironmentVariable(string name, System.EnvironmentVariableTarget target) {
      return name == "Path" && target == System.EnvironmentVariableTarget.User
        ? System.IO.File.ReadAllText(${JSON.stringify(pathState)}) : null;
    }
    public static void SetEnvironmentVariable(string name, string value, System.EnvironmentVariableTarget target) {
      if (name != "Path" || target != System.EnvironmentVariableTarget.User) throw new System.Exception("Unexpected registry mutation");
      System.IO.File.WriteAllText(${JSON.stringify(pathState)}, value ?? "");
    }
  }
}
'@`,
            `Set-Item -Path ${quote(`Function:global:${cliPath}`)} -Value {`,
            `  Add-Content -LiteralPath ${quote(callsPath)} -Value (ConvertTo-Json -Compress -InputObject @{ args = @($args); home = $env:HAPPIER_HOME_DIR; channel = $env:HAPPIER_DAEMON_SERVICE_CHANNEL })`,
            '  if ($args -contains "--help") {',
            `    Write-Output '${scenario === 'unsupported-cli' ? '{"flags":[]}' : '{"flags":["--install-root"]}'}'`,
            '    $global:LASTEXITCODE = 0',
            '  } else {',
            `    $global:LASTEXITCODE = ${scenario === 'service-failure' ? 23 : 0}`,
            '  }',
            '}',
            `& ${quote(installerPath)} -Uninstall -Channel preview -Yes`,
          ].join('\n');
          const scriptPath = join(root, 'exercise.ps1');
          await writeFile(scriptPath, `\uFEFF${script}`);
          const result = spawnSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8', maxBuffer: 2 ** 20 });
          const failed = ['service-failure', 'unsupported-cli', 'missing-cli'].includes(scenario);
          assert.equal(result.status === 0, !failed, result.stderr || result.stdout);
          assert.equal(existsSync(managedRoot), failed, 'payload removal must follow successful service teardown');
          if (failed) assert.equal(await readFile(desktopOwnershipPath, 'utf8'), desktopOwnership, 'failed uninstall must preserve Desktop ownership');
          else assert.equal(existsSync(desktopOwnershipPath), false, 'successful uninstall removes the selected channel ownership claim');
          assert.equal(await readFile(join(installDir, 'cli.desktop-ownership.json'), 'utf8'), desktopOwnership, 'other channel ownership is retained');
          assert.equal(existsSync(join(binDir, 'happier.exe')), failed || scenario === 'other-default' || scenario === 'default-fallback', 'default shim follows its selected channel');
          assert.equal(existsSync(join(installDir, 'default-cli-release-channel.json')), failed || scenario === 'other-default' || scenario === 'default-fallback', 'default marker must not point to a removed channel');
          if (scenario === 'default-fallback') {
            assert.equal(await readFile(join(binDir, 'happier.exe'), 'utf8'), 'remaining stable binary');
            assert.equal(JSON.parse(await readFile(join(installDir, 'default-cli-release-channel.json'), 'utf8')).releaseChannel, 'stable');
          }
          assert.equal(existsSync(cliPath), failed && scenario !== 'missing-cli');
          assert.equal(await readFile(join(dataDir, 'settings.json'), 'utf8'), 'retained settings');
          assert.equal(existsSync(join(binDir, 'hdev.exe')), !scenario.startsWith('last-channel'));
          assert.equal(await readFile(pathState, 'utf8'), scenario === 'last-channel' ? extraBin : originalPath);
          if (scenario === 'missing-cli') {
            assert.equal(existsSync(callsPath), false, 'missing managed CLI must not fall back to a command on PATH');
          } else {
            const calls = (await readFile(callsPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
            assert.deepEqual(calls[0].args, ['service', 'uninstall', '--help', '--json']);
            assert.equal(calls.length, scenario === 'unsupported-cli' ? 1 : 2);
            if (calls.length === 2) assert.deepEqual(calls[1].args, ['service', 'uninstall', '--all', '--install-root', managedRoot, '--yes']);
            assert.ok(calls.every((call) => call.home === dataDir && call.channel === 'preview'));
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  });
}
