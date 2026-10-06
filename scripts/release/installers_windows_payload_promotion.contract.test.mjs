import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readInstallerSource(path) {
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
}

test('install.ps1 only falls back to direct binary copy for legacy payload installers', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /\$promotionResult\.ExitCode\s*-ne\s*0/i);
  assert.ok(
    trimmed.includes('Unknown self subcommand:\\s+__install-payload'),
    'expected payload promotion fallback to keep the legacy unknown-subcommand compatibility guard',
  );
  assert.ok(
    trimmed.includes('ENOENT: no such file or directory, open'),
    'expected payload promotion fallback to accept the released Windows payload-promotion ENOENT failure signature',
  );
  assert.ok(
    trimmed.includes('ENAMETOOLONG'),
    'expected payload promotion fallback logic to classify long-path ENAMETOOLONG failures',
  );
  assert.ok(
    trimmed.includes('name too long'),
    'expected payload promotion fallback logic to classify long-path "name too long" failures',
  );
  assert.ok(
    trimmed.includes('path too long'),
    'expected payload promotion fallback logic to classify long-path "path too long" failures',
  );
  assert.ok(
    trimmed.includes('Test-InstallerPayloadDirectCopyFallbackSafe'),
    'expected payload promotion fallback logic to use an explicit safety gate before direct-copy fallback',
  );
  assert.match(
    trimmed,
    /\$payloadPromotionFallbackSafe\s*=\s*Test-InstallerPayloadDirectCopyFallbackSafe/i,
    'expected payload promotion fallback safety result to be captured before evaluating fallback branches',
  );
  assert.match(
    trimmed,
    /\$payloadPromotionFallbackSafe\s*-and\s*\(\s*\$legacyFallbackCompatible\s*-or\s*\$longPathOrMissingSourceSignature\s*\)/i,
    'expected payload promotion fallback to require an explicit safety gate for long-path/missing-source signatures',
  );
  assert.match(trimmed, /Payload promotion failed\./i);
  assert.ok(
    trimmed.includes('$target = Join-Path $BinDir "$((Resolve-CliShimName)).exe"'),
    'expected legacy payload fallback to define the managed bin target explicitly',
  );
  assert.ok(
    trimmed.includes('Copy-Item -Path $binary -Destination $target -Force'),
    'expected legacy payload fallback to copy the extracted binary into the managed bin target',
  );
  assert.doesNotMatch(
    trimmed,
    /\$promotionResult\.ExitCode\s*-ne\s*0\s*\)\s*\{\s*Write-Warning\s+"Payload promotion failed, falling back to direct binary copy\."/i,
  );
});

test('install.ps1 payload promotion timeout avoids background jobs and enforces bounded process waits', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.doesNotMatch(trimmed, /\bStart-Job\b/);
  assert.doesNotMatch(trimmed, /\bWait-Job\b/);
  assert.doesNotMatch(trimmed, /\bStop-Job\b/);
  assert.match(trimmed, /\.WaitForExit\(\$timeoutMs\)/);
  assert.match(trimmed, /\.Kill\(\$true\)/);
});

test('install.ps1 payload promotion uses the local PowerShell executable instead of hard-coded pwsh', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const helper = raw.match(/function Invoke-InstallerPayloadPromotionWithTimeout\s*\{[\s\S]*?\n\}(?=\n\nfunction )/);

  assert.ok(helper, 'expected Invoke-InstallerPayloadPromotionWithTimeout to exist');
  assert.match(
    raw,
    /function Resolve-InstallerPowerShellExecutablePath/i,
    'expected installer to resolve a PowerShell executable available on the current Windows host',
  );
  assert.match(
    helper[0],
    /\$powerShellExecutablePath\s*=\s*Resolve-InstallerPowerShellExecutablePath/i,
    'expected payload promotion to resolve PowerShell before launching the child script',
  );
  assert.match(
    helper[0],
    /Start-Process\s+-FilePath\s+\$powerShellExecutablePath/i,
    'expected payload promotion to launch the resolved PowerShell executable',
  );
  assert.doesNotMatch(
    helper[0],
    /Start-Process\s+-FilePath\s+"pwsh"/i,
    'fresh Windows hosts may only have Windows PowerShell, so hard-coded pwsh breaks canonical payload promotion',
  );
});

test('install.ps1 runs payload promotion from a runner outside the extracted payload root', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const helper = raw.match(/function Invoke-InstallerPayloadPromotionWithTimeout\s*\{[\s\S]*?\n\}(?=\n\nfunction )/);

  assert.ok(helper, 'expected Invoke-InstallerPayloadPromotionWithTimeout to exist');
  assert.match(
    helper[0],
    /\$runnerBinaryPath\s*=\s*Join-Path\s+\$InstallerTempDir\s+"happier-payload-promotion-\$runToken\.exe"/i,
    'expected installer to allocate a temporary promotion runner outside the extracted payload root',
  );
  assert.match(
    helper[0],
    /Copy-Item\s+-Path\s+\$BinaryPath\s+-Destination\s+\$runnerBinaryPath\s+-Force/i,
    'expected installer to copy the extracted CLI binary to the temporary runner',
  );
  assert.match(
    helper[0],
    /& '\$\(& \$escapeSingleQuotedLiteral \$runnerBinaryPath\)' self __install-payload/i,
    'expected payload promotion to invoke the temporary runner so Windows can move the payload root atomically',
  );
  assert.doesNotMatch(
    helper[0],
    /& '\$\(& \$escapeSingleQuotedLiteral \$BinaryPath\)' self __install-payload/i,
    'running install-payload from inside the payload root locks happier.exe on Windows and forces slow copy fallback',
  );
  assert.match(
    helper[0],
    /Remove-InstallerTemporaryFiles\s+-Paths\s+@\(\$runnerBinaryPath,/i,
    'expected temporary promotion runner cleanup',
  );
});

test('install.ps1 keeps temporary files out of short-name provider cleanup', async () => {
  const raw = await readInstallerSource(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'));
  assert.doesNotMatch(raw, /Join-Path\s+\$env:TEMP\b/i);
  assert.match(raw, /\$InstallerTempDir\s*=\s*\(Get-Item\s+-LiteralPath\s+\(\[System\.IO\.Path\]::GetTempPath\(\)\)\)\.FullName/i);
  for (const name of ['Invoke-InstallerCommandWithDaemonServiceContextCapturingOutputWithTimeout', 'Invoke-InstallerPayloadPromotionWithTimeout']) {
    const body = raw.match(new RegExp(`function ${name}\\s*\\{[\\s\\S]*?\\n\\}(?=\\n\\nfunction )`))[0];
    assert.doesNotMatch(body, /Remove-Item\s+-Path\s+\$(?:runnerBinaryPath|runnerScriptPath|stdoutPath|stderrPath)/i);
    assert.match(body, /Remove-InstallerTemporaryFiles\s+-Paths/);
  }
});

for (const runnerTempName of ['runner-temp', 'runner temp', 'Reporter long profile.HEC']) {
for (const powerShell of ['powershell.exe', 'pwsh']) {
test(`install.ps1 runs lock hygiene and promotes from ${runnerTempName} under ${powerShell}`, {
  skip: process.platform !== 'win32' && 'Requires real Windows executable locking and PowerShell',
}, async (t) => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readInstallerSource(path);
  const functions = [
    'Resolve-InstallerPayloadPromotionTimeoutMs',
    'Resolve-InstallerPowerShellExecutablePath',
    'Stop-InstallerProcessTree',
    'Remove-InstallerTemporaryFiles',
    'Invoke-NativeCommandCapturingOutput',
    'Invoke-InstallerCommandWithDaemonServiceContext',
    'Test-DoctorRepairPreflightLooksLikePlainDoctorReport',
    'Test-DoctorRepairPreflightJsonIsSupported',
    'Test-InstallerCommandLooksUnsupported',
    'Get-InstalledBackgroundServiceInventory',
    'Test-BackgroundServiceInventoryHasDefaultFollowing',
    'Get-InstallerDisplayChannelLabel',
    'Get-BackgroundServiceDefaultFollowingChannel',
    'Test-BackgroundServiceInventoryHasMatchingDefaultFollowing',
    'Resolve-ExistingBackgroundServiceInstallStrategy',
    'Invoke-InstallerCommandWithDaemonServiceContextCapturingOutputWithTimeout',
    'Invoke-InstallerPayloadPromotionWithTimeout',
  ].map((name) => {
    const source = raw.match(new RegExp(`function ${name}\\s*\\{[\\s\\S]*?\\n\\}(?=\\n\\nfunction )`));
    assert.ok(source, `Missing installer function ${name}`);
    return source[0];
  });
  const scratch = await mkdtemp(join(tmpdir(), 'happier-promotion-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const payload = join(scratch, "payload with spaces and 'quote");
  const runnerTemp = join(scratch, runnerTempName);
  await mkdir(runnerTemp);
  await writeFile(join(runnerTemp, 'sentinel'), 'unrelated file');
  await mkdir(payload);
  await writeFile(join(payload, 'payload-marker'), 'payload contents');
  // The CLI executable is a genuine external process boundary for the installer.
  // Renaming its input payload proves the runner is detached from the executable
  // Windows locks. The real compiled CLI embeds its promotion-time process owner.
  const fixtureSource = join(scratch, 'Fixture.cs');
  await writeFile(fixtureSource, `
using System;
using System.IO;
class Fixture {
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "doctor") {
      if (Environment.GetEnvironmentVariable("HAPPIER_TEST_LEGACY_INVENTORY") == "1") {
        Console.Error.WriteLine("unknown command");
        return 1;
      }
      Console.WriteLine(Environment.GetEnvironmentVariable("HAPPIER_TEST_INVENTORY_JSON"));
      return 0;
    }
    if (args.Length > 1 && args[0] == "service" && args[1] == "list") {
      Console.WriteLine(Environment.GetEnvironmentVariable("HAPPIER_TEST_INVENTORY_JSON"));
      return 0;
    }
    if (args.Length > 0 && (args[0] == "service" || args[0] == "daemon")) {
      Console.WriteLine(String.Join(" ", args));
      Console.WriteLine(Environment.GetEnvironmentVariable("HAPPIER_HOME_DIR"));
      return 0;
    }
    if (args.Length < 2 || args[0] != "self" || args[1] != "__install-payload") return 3;
    Console.WriteLine("promotion-ready");
    if (Environment.GetEnvironmentVariable("HAPPIER_TEST_PROMOTION_FAIL") == "1") return 17;
    int payloadIndex = Array.IndexOf(args, "--payload-root");
    if (payloadIndex < 0 || payloadIndex + 1 >= args.Length) return 4;
    string payload = args[payloadIndex + 1];
    Directory.Move(payload, payload + ".promoted");
    Console.WriteLine("promoted");
    return 0;
  }
}
`);
  const binary = join(payload, 'happier.exe');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', `/out:${binary}`, fixtureSource], { encoding: 'utf8' });
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = join(scratch, 'exercise.ps1');
  await writeFile(script, [
    "$ErrorActionPreference = 'Stop'",
    ...functions,
    "$Channel = 'stable'",
    "$Noninteractive = '0'",
    `$DaemonServiceStateHomeDir = ${quote(join(scratch, 'home'))}`,
    runnerTempName.endsWith('.HEC')
      ? `$env:TEMP = (New-Object -ComObject Scripting.FileSystemObject).GetFolder(${quote(runnerTemp)}).ShortPath`
      : `$env:TEMP = ${quote(runnerTemp)}`,
    '$env:TMP = $env:TEMP',
    raw.match(/^\$InstallerTempDir\s*=.*$/m)[0],
    `if ($InstallerTempDir.TrimEnd('\\') -ne ${quote(runnerTemp)}.TrimEnd('\\')) { throw 'Installer did not resolve the long temporary directory' }`,
    // FileSystem-provider enumeration is the OS boundary that fails on the
    // reporter's Insider build. Keep all other filesystem/process logic real.
    `function Remove-Item {
      param($Path, [switch] $Force, $ErrorAction)
      if ($Path -like '*happier-pre-install-*' -or $Path -like '*happier-payload-promotion-*') {
        throw (New-Object System.Management.Automation.PSArgumentException 'Short-name enumeration failed')
      }
      Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters
    }`,
    '$env:HAPPIER_HOME_DIR = "prior-home"',
    `foreach ($command in @(@('service', 'stop', '--json'), @('daemon', 'stop', '--all', '--kill-sessions', '--json'))) {
      $stopped = Invoke-InstallerCommandWithDaemonServiceContextCapturingOutputWithTimeout -CliPath ${quote(binary)} -CommandArgs $command -HomeDir ${quote(join(scratch, 'home'))} -TimeoutMs 30000
      if ($stopped.ExitCode -ne 0 -or $stopped.TimedOut -or -not $stopped.Output.Contains(($command -join ' ')) -or -not $stopped.Output.Contains(${quote(join(scratch, 'home'))})) { throw ('Lock hygiene failed: ' + ($stopped | ConvertTo-Json -Compress)) }
      if ($env:HAPPIER_HOME_DIR -ne 'prior-home') { throw 'Lock hygiene did not restore the caller home' }
    }`,
    '$lockedPath = Join-Path $InstallerTempDir "locked.log"',
    '$locked = [IO.File]::Open($lockedPath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    'try { Remove-InstallerTemporaryFiles -Paths @($lockedPath, (Join-Path $InstallerTempDir "missing.log")) } finally { $locked.Dispose() }',
    'Remove-InstallerTemporaryFiles -Paths @($lockedPath)',
    `foreach ($legacy in @('0', '1')) {
      $env:HAPPIER_TEST_LEGACY_INVENTORY = $legacy
      foreach ($json in @('{"entries":[]}', '{"services":[]}', '{"entries":[],"services":[],"relays":[]}')) {
        $env:HAPPIER_TEST_INVENTORY_JSON = $json
        $inventory = Get-InstalledBackgroundServiceInventory -CliPath ${quote(binary)}
        if (-not $inventory.Supported -or $inventory.Entries -isnot [object[]] -or $inventory.Entries.Count -ne 0 -or $inventory.Services -isnot [object[]] -or $inventory.Relays -isnot [object[]]) { throw 'Fresh inventory must contain empty arrays' }
        if (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $inventory.Entries) { throw 'Empty inventory has no default' }
        if ((Get-BackgroundServiceDefaultFollowingChannel -Entries $inventory.Entries) -ne '') { throw 'Empty inventory has no channel' }
        if (Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries $inventory.Entries) { throw 'Empty inventory cannot match' }
        if ((Resolve-ExistingBackgroundServiceInstallStrategy -Entries $inventory.Entries) -ne '') { throw 'Fresh install must not replace a service' }
      }
    }
    $env:HAPPIER_TEST_LEGACY_INVENTORY = '0'
    $env:HAPPIER_TEST_INVENTORY_JSON = '{"existingServices":[]}'
    $inventory = Get-InstalledBackgroundServiceInventory -CliPath ${quote(binary)}
    if (-not $inventory.Supported -or $inventory.Entries -isnot [object[]] -or $inventory.Services -isnot [object[]]) { throw 'Legacy doctor inventory must retain empty arrays' }
    foreach ($key in @('entries', 'services', 'existingServices')) {
      $env:HAPPIER_TEST_INVENTORY_JSON = '{"' + $key + '":[{"targetMode":"default-following","releaseChannel":"stable"}]}'
      $inventory = Get-InstalledBackgroundServiceInventory -CliPath ${quote(binary)}
      if ($inventory.Entries -isnot [object[]] -or $inventory.Entries.Count -ne 1 -or -not (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $inventory.Entries)) { throw 'Singleton inventory must retain its service' }
      if ((Get-BackgroundServiceDefaultFollowingChannel -Entries $inventory.Entries) -ne 'stable') { throw 'Singleton inventory must retain its channel' }
      if ((Resolve-ExistingBackgroundServiceInstallStrategy -Entries $inventory.Entries -DefaultFollowingMatchesSelectedReleaseChannel $true) -ne 'skip') { throw 'Matching inventory must preserve its service' }
    }`,
    '$env:HAPPIER_TEST_PROMOTION_FAIL = "1"',
    `$failed = Invoke-InstallerPayloadPromotionWithTimeout -BinaryPath ${quote(binary)} -PayloadRoot ${quote(payload)} -Version '1.2.3' -ChannelValue 'dev' -InstallHomeDir ${quote(join(scratch, 'home'))}`,
    'if ($failed.ExitCode -ne 17 -or $failed.TimedOut -or -not $failed.Output.Contains("promotion-ready")) { throw "Cleanup hid the failed promotion result" }',
    '$env:HAPPIER_TEST_PROMOTION_FAIL = "0"',
    `$result = Invoke-InstallerPayloadPromotionWithTimeout -BinaryPath ${quote(binary)} -PayloadRoot ${quote(payload)} -Version '1.2.3' -ChannelValue 'dev' -InstallHomeDir ${quote(join(scratch, 'home'))}`,
    '$result | ConvertTo-Json -Compress',
  ].join('\n'));
  const result = JSON.parse(execFileSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' }).trim());
  assert.equal(result.TimedOut, false);
  assert.equal(result.ExitCode, 0, result.Output);
  assert.match(result.Output, /promotion-ready[\s\S]*promoted/);
  assert.equal(await readFile(join(`${payload}.promoted`, 'payload-marker'), 'utf8'), 'payload contents');
  assert.deepEqual(await readdir(runnerTemp), ['sentinel']);
});
}
}

test('install.ps1 fails closed on payload promotion timeout instead of accepting fallback success', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();
  const fallbackSignature = trimmed.match(/\$longPathOrMissingSourceSignature\s*=\s*\$promotionOutput\s+-match\s*'([^']+)'/i);

  assert.ok(fallbackSignature, 'expected explicit long-path or missing-source fallback classifier');
  assert.doesNotMatch(
    fallbackSignature[1],
    /timed out|ETIMEDOUT/i,
    'payload promotion timeouts must not be classified as safe direct-copy fallback signatures',
  );
  assert.match(
    trimmed,
    /if\s*\(\s*\$promotionResult\.TimedOut\s*\)\s*\{[\s\S]*throw "Payload promotion timed out\./i,
    'expected timeout to fail the installer instead of copying only the binary and leaving temp managed state',
  );
});

test('install.ps1 direct-copy fallback refuses partial temporary managed version state', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const fallbackSafety = raw.match(/function Test-InstallerPayloadDirectCopyFallbackSafe\s*\{[\s\S]*?\n\}(?=\n\nfunction )/);

  assert.ok(fallbackSafety, 'expected Test-InstallerPayloadDirectCopyFallbackSafe to exist');
  assert.match(
    fallbackSafety[0],
    /\$partialVersionDirs\s*=/i,
    'expected fallback safety check to inspect partial version directories',
  );
  assert.match(
    fallbackSafety[0],
    /\.tmp-/i,
    'expected fallback safety check to detect atomic-promotion temp version directories',
  );
  assert.match(
    fallbackSafety[0],
    /if\s*\(\s*\$partialVersionDirs\.Count\s+-gt\s+0\s*\)\s*\{\s*return\s+\$false/i,
    'expected direct-copy fallback to be unsafe after partial managed payload promotion',
  );
});

test('install.ps1 stages release archives under the install home instead of process temp', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function New-InstallerStagingDirectory/i,
    'expected installer to centralize staging directory creation',
  );
  assert.match(
    trimmed,
    /Join-Path\s+\$InstallHomeDir\s+".install-staging"/i,
    'expected installer staging to live under the target install home so Windows promotion can rename the extracted payload',
  );
  assert.match(
    trimmed,
    /\$tmpDir\s*=\s*New-InstallerStagingDirectory\s+-InstallHomeDir\s+\$InstallDir/i,
    'expected installer archive/checksum/extract temp directory to use install-home staging',
  );
  assert.doesNotMatch(
    trimmed,
    /New-Item\s+-ItemType\s+Directory\s+-Path\s+\(Join-Path\s+\$env:TEMP\s+\("happier-install-"/i,
    'process temp can be space-constrained and can force slow cross-root payload promotion on Windows',
  );
});

test('install.ps1 tells install-payload when native pre-install cleanup already ran', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS/i,
    'expected payload promotion runner to skip redundant old-CLI stop commands after installer lock hygiene',
  );
  assert.match(
    trimmed,
    /\$env:HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS\s*=\s*'1'/i,
    'expected installer-driven payload promotion to mark old-CLI stop commands as already handled',
  );
});

test('install.ps1 tells install-payload that installer-owned repair runs after promotion', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION/i,
    'expected installer-driven payload promotion to skip headless runtime migration',
  );
  assert.match(
    trimmed,
    /\$env:HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION\s*=\s*'1'/i,
    'expected installer-driven payload promotion to mark post-promotion migration as installer-owned',
  );
  assert.match(
    trimmed,
    /\$previousSkipInstallPayloadMigration/i,
    'expected installer-driven payload promotion to restore the prior skip-migration env value',
  );
});
