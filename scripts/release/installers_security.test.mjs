import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sourceRoot = join(repoRoot, 'scripts', 'release', 'installers');
const installShPath = join(sourceRoot, 'install.sh');
const installPs1Path = join(sourceRoot, 'install.ps1');
const publicKeyPath = join(sourceRoot, 'happier-release.pub');

test('release-owned installer scripts enforce minisign verification defaults', async () => {
  const installSh = await readFile(installShPath, 'utf8');
  const publicKey = (await readFile(publicKeyPath, 'utf8')).trim();
  const publicKeyLines = publicKey.split('\n').map((line) => line.trim()).filter(Boolean);
  const publicKeyPayload = publicKeyLines.at(-1) ?? '';

  assert.match(installSh, /HAPPIER_MINISIGN_PUBKEY_URL/);
  assert.match(installSh, /HAPPIER_RELEASE_ASSETS_DIR/);
  assert.match(installSh, /https:\/\/happier\.dev\/happier-release\.pub/);
  assert.match(installSh, /verify_release_signature/);
  assert.doesNotMatch(installSh, /skipped signature verification/i);
  assert.ok(publicKeyPayload.length > 10);
  assert.ok(installSh.includes(publicKeyPayload), 'install.sh should embed the release minisign public key payload');
});

test('release-owned windows installer enforces minisign verification defaults', async () => {
  const installPs1 = await readFile(installPs1Path, 'utf8');
  const publicKey = (await readFile(publicKeyPath, 'utf8')).trim();
  const publicKeyLines = publicKey.split('\n').map((line) => line.trim()).filter(Boolean);
  const publicKeyPayload = publicKeyLines.at(-1) ?? '';
  assert.match(installPs1, /HAPPIER_MINISIGN_PUBKEY_URL/);
  assert.match(installPs1, /HAPPIER_RELEASE_ASSETS_DIR/);
  assert.match(installPs1, /https:\/\/happier\.dev\/happier-release\.pub/);
  assert.match(installPs1, /Signature verified\./);
  assert.doesNotMatch(installPs1, /skip.*signature/i);
  assert.match(installPs1, /&\s+\$exe\.FullName\s+-v\s+\*>\s+\$null/);
  assert.match(
    installPs1,
    /winget\s+install\s+--id\s+jedisct1\.minisign\s+--accept-source-agreements\s+--accept-package-agreements/i,
    'expected install.ps1 to install the minisign verification prerequisite through winget when the self-contained fallback is incompatible',
  );
  assert.match(installPs1, /Downloaded minisign binary is not compatible with this system/);
  assert.match(installPs1, /\$env:LOCALAPPDATA\)\s*\{\s*\$pathEntries \+= Join-Path \$env:LOCALAPPDATA "Microsoft\\WinGet\\Links"/);
  assert.match(installPs1, /\$pathEntries \+= Join-Path \$env:LOCALAPPDATA "Microsoft\\WinGet\\Packages"/);
  assert.match(installPs1, /\$trimmedEntry -match '\[\\\\\/\]WinGet\[\\\\\/\]Packages\$'/);
  assert.match(installPs1, /\[Environment\]::GetEnvironmentVariable\("Path", \[EnvironmentVariableTarget\]::User\)/);
  assert.match(installPs1, /\[Environment\]::GetEnvironmentVariable\("Path", \[EnvironmentVariableTarget\]::Machine\)/);
  assert.match(installPs1, /function Invoke-NativeCommandCapturingOutput/);
  assert.match(installPs1, /\$previousErrorActionPreference = \$ErrorActionPreference/);
  assert.match(installPs1, /\$ErrorActionPreference = "Continue"/);
  assert.match(installPs1, /\$ErrorActionPreference = \$previousErrorActionPreference/);
  assert.match(installPs1, /Invoke-NativeCommandCapturingOutput\s+\{/);
  assert.match(installPs1, /\$wingetInstallResult/i);
  assert.match(installPs1, /\$wingetInstallResult\.ExitCode\s+-ne\s+0/i);
  assert.doesNotMatch(installPs1, /\$wingetInstallResult\.Ok/i);
  assert.match(installPs1, /Unable to install minisign via winget/i);
  assert.match(installPs1, /Payload promotion is unsupported by this CLI build, falling back to legacy direct binary copy\./);
  assert.match(installPs1, /Payload promotion failed without a safe fallback\./);
  assert.match(installPs1, /Refusing direct binary copy to avoid partial install state drift/);
  assert.doesNotMatch(installPs1, /\$promotionOutput = & \$binary self __install-payload .*2>&1 \| Out-String/);
  assert.match(installPs1, /Unknown self subcommand:\\s\+__install-payload/);
  assert.ok(publicKeyPayload.length > 10);
  assert.ok(installPs1.includes(publicKeyPayload), 'install.ps1 should embed the release minisign public key payload');
});

test('release-owned minisign public key exists', async () => {
  const publicKey = await readFile(publicKeyPath, 'utf8');
  assert.match(publicKey, /minisign public key/i);
  assert.match(publicKey, /^RWQ/m);
});

test('install.ps1 extracts bundled minisign with the Windows PowerShell .NET API', async () => {
  const raw = (await readFile(installPs1Path, 'utf8')).replaceAll('\r\n', '\n');
  const ensureMinisign = raw.match(/function Ensure-Minisign\s*\{[\s\S]*?\n\}(?=\n\nfunction )/)?.[0];
  assert.ok(ensureMinisign);
  // Expand-Archive modules can select the overwrite overload absent from .NET
  // Framework. Its two-argument API works in both Windows PowerShell and pwsh.
  assert.doesNotMatch(ensureMinisign, /\bExpand-Archive\b/);
  assert.match(ensureMinisign, /Add-Type -AssemblyName System\.IO\.Compression\.FileSystem/);
  assert.match(ensureMinisign, /\[System\.IO\.Compression\.ZipFile\]::ExtractToDirectory\(\$zipPath, \$extractDir\)/);
  const cleanup = ensureMinisign.indexOf('Remove-Item -LiteralPath $extractDir -Recurse -Force');
  const extract = ensureMinisign.indexOf('::ExtractToDirectory(');
  assert.ok(cleanup >= 0 && cleanup < extract, 'replace the previous extraction before using the non-overwriting API');
});

async function createMinisignBootstrapFixture(t) {
  const raw = (await readFile(installPs1Path, 'utf8')).replaceAll('\r\n', '\n');
  const functions = ['Resolve-MinisignExecutablePath', 'Invoke-NativeCommandCapturingOutput',
    'Test-InstallerTransientWebException', 'Invoke-InstallerWebRequestWithRetry', 'Ensure-Minisign'].map((name) => {
    const source = raw.match(new RegExp(`function ${name}\\s*\\{[\\s\\S]*?\\n\\}(?=\\n\\nfunction )`));
    assert.ok(source, `Missing installer function ${name}`);
    return source[0];
  });
  // PowerShell expands Windows 8.3 TEMP aliases when returning executable paths.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-minisign-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const binary = join(scratch, 'minisign.exe');
  if (process.platform === 'win32') {
    const fixtureSource = join(scratch, 'Fixture.cs');
    await writeFile(fixtureSource, 'class Fixture { static int Main(string[] args) { return args.Length == 1 && args[0] == "-v" ? 0 : 17; } }');
    execFileSync(join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      ['/nologo', '/target:exe', `/out:${binary}`, fixtureSource], { encoding: 'utf8' });
  } else {
    await writeFile(binary, '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "-v" ]\n');
    await chmod(binary, 0o755);
  }
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = join(scratch, 'exercise.ps1');
  const hash = raw.match(/\$expectedSha = "([a-f0-9]{64})"/)[1];
  const prelude = [
    "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
    `$fixtureRoot = ${quote(scratch)}`,
    process.platform === 'win32' ? '$env:PATH = "$env:SystemRoot\\System32;$env:SystemRoot"' : '$env:PATH = "/usr/bin:/bin"',
    '$env:LOCALAPPDATA = $fixtureRoot', '$env:HAPPIER_NO_ANIMATION = "1"',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archiveRoot = Join-Path $fixtureRoot "archive"',
    // Both directories model the vendor archive. Native execution is an OS
    // boundary; the fixture verifies selection and successful version probing.
    'foreach ($arch in @("aarch64", "x86_64")) {',
    '  $dir = Join-Path (Join-Path $archiveRoot "minisign-win64") $arch',
    '  [IO.Directory]::CreateDirectory($dir) | Out-Null',
    `  [IO.File]::Copy(${quote(binary)}, (Join-Path $dir 'minisign.exe'))`, '}',
    '$fixtureZip = Join-Path $fixtureRoot "fixture.zip"',
    '[IO.Compression.ZipFile]::CreateFromDirectory($archiveRoot, $fixtureZip)',
    '$staleExtraction = Join-Path $fixtureRoot "minisign-extract"',
    '[IO.Directory]::CreateDirectory($staleExtraction) | Out-Null',
    '[IO.File]::WriteAllText((Join-Path $staleExtraction "stale.txt"), "previous extraction")',
    // Installed system commands must not bypass the fallback under test.
    'function Get-Command { param($Name, $ErrorAction); if ($Name -eq "minisign") { return $null }; Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters }',
    // Network/download bytes and filesystem visibility are genuine system
    // boundaries. Hash the real vendor archive separately in live validation;
    // here the fake network artifact has the pinned checksum at that boundary.
    'function Invoke-WebRequest { param($Uri, $OutFile, [switch] $UseBasicParsing, $Headers); [IO.File]::Copy($fixtureZip, $OutFile, $true) }',
    `function Get-FileHash { param($Path, $Algorithm); return @{ Hash = '${hash}' } }`,
    `function Test-Path {
      param($Path, $LiteralPath, $PathType)
      if ($LiteralPath) { $Path = $LiteralPath }
      if ($Path -like '*minisign.exe' -and -not $Path.StartsWith($fixtureRoot)) { return $false }
      if ($Path -like '*WinGet*') { return $false }
      if ($PathType) { return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $Path -PathType $PathType }
      return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $Path
    }`,
    'function winget { throw "Bundled minisign must work without installing a system package" }',
  ];
  return { scratch, script, prelude, functions };
}

for (const powerShell of ['powershell.exe', 'pwsh']) {
test(`install.ps1 bootstraps the native minisign executable without winget under ${powerShell}`, {
  skip: process.platform !== 'win32' && 'Requires Windows executable and PowerShell boundaries',
}, async (t) => {
  const { script, prelude, functions } = await createMinisignBootstrapFixture(t);
  await writeFile(script, [
    ...prelude, ...functions,
    '$selected = Ensure-Minisign -TempRoot $fixtureRoot',
    'if (-not (Test-Path -LiteralPath $selected -PathType Leaf)) { throw "Bundled minisign is missing" }',
    'if (Test-Path -LiteralPath (Join-Path $staleExtraction "stale.txt")) { throw "Previous extraction was not replaced" }',
    'Write-Output "native-minisign-ready"',
  ].join('\n'));
  assert.match(execFileSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' }), /native-minisign-ready/);
});
}

const architectureCases = [
  { name: 'runtime x64 wins over the environment', runtime: 'X64', wow64: 'ARM64', processor: 'ARM64', expected: 'x86_64' },
  { name: 'runtime ARM64 wins over the environment', runtime: 'Arm64', wow64: 'AMD64', processor: 'AMD64', expected: 'aarch64' },
  { name: 'null runtime uses AMD64 environment', runtime: null, wow64: '', processor: 'AMD64', expected: 'x86_64' },
  { name: 'WOW64 uses OS architecture before x86 process architecture', runtime: null, wow64: 'AMD64', processor: 'x86', expected: 'x86_64' },
  { name: 'WOW64 ARM64 wins over AMD64 process architecture', runtime: '', wow64: 'ARM64', processor: 'AMD64', expected: 'aarch64' },
  { name: 'empty runtime uses ARM64 environment case-insensitively', runtime: '', wow64: '', processor: 'arm64', expected: 'aarch64' },
  { name: 'unsupported x86 is rejected', runtime: null, wow64: '', processor: 'x86', expected: null },
  { name: 'missing architecture is rejected', runtime: null, wow64: '', processor: '', expected: null },
];

for (const powerShell of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh']) {
  const available = spawnSync(powerShell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`install.ps1 selects bundled minisign from runtime and fallback architectures under ${powerShell}`, {
    skip: process.platform !== 'win32' && !available && `${powerShell} is unavailable`,
  }, async (t) => {
    const { scratch, script, prelude, functions } = await createMinisignBootstrapFixture(t);
    // Replace only the .NET OS query boundary; execute the real installer logic.
    const boundaryFunctions = functions.map((source) => source.replaceAll(
      '[System.Runtime.InteropServices.RuntimeInformation]', '[FixtureRuntimeInformation]',
    ));
    for (const scenario of architectureCases) {
      await t.test(scenario.name, async () => {
        const quote = (value) => value === null ? '$null' : `'${value}'`;
        await writeFile(script, [
          ...prelude,
          'Add-Type "public static class FixtureRuntimeInformation { public static object OSArchitecture; }"',
          `[FixtureRuntimeInformation]::OSArchitecture = ${quote(scenario.runtime)}`,
          `$env:PROCESSOR_ARCHITEW6432 = ${quote(scenario.wow64)}`,
          `$env:PROCESSOR_ARCHITECTURE = ${quote(scenario.processor)}`,
          ...boundaryFunctions,
          '$selected = Ensure-Minisign -TempRoot $fixtureRoot',
          'Write-Output $selected',
        ].join('\n'));
        // Recreate the archive for each case; extraction and native probing stay real.
        await rm(join(scratch, 'archive'), { recursive: true, force: true });
        await rm(join(scratch, 'fixture.zip'), { force: true });
        const result = spawnSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
        assert.ifError(result.error);
        if (scenario.expected === null) {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /Unsupported Windows architecture for bundled minisign/);
        } else {
          assert.equal(result.status, 0, result.stderr);
          const expected = join(scratch, 'minisign-extract', 'minisign-win64', scenario.expected, 'minisign.exe');
          assert.equal(result.stdout.trim(), expected);
        }
      });
    }
  });
}
