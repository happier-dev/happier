import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
  assert.doesNotMatch(installPs1, /\$exe\.FullName\s+--version/);
  assert.match(installPs1, /\$LASTEXITCODE\s+-ne\s+0/);
  assert.match(installPs1, /RuntimeInformation\]::OSArchitecture/);
  assert.match(installPs1, /"X64"\s*\{\s*"x86_64"\s*\}/);
  assert.match(installPs1, /"Arm64"\s*\{\s*"aarch64"\s*\}/);
  assert.doesNotMatch(installPs1, /Get-ChildItem\s+-Path\s+\$extractDir\s+-Filter\s+"minisign\.exe"\s+-Recurse\s*\|\s*Select-Object\s+-First\s+1/);
  assert.match(installPs1, /winget\s+install\s+--id\s+jedisct1\.minisign\s+--source\s+winget\s+--accept-source-agreements\s+--accept-package-agreements/i);
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
  assert.match(
    installPs1,
    /\$wingetInstallResult\.ExitCode -ne 0 -and \$wingetInstallResult\.Output[\s\S]*?\$wingetMinisign = Resolve-MinisignExecutablePath[\s\S]*?\$wingetMinisignProbe = Invoke-NativeCommandCapturingOutput[\s\S]*?\$wingetMinisignProbe\.ExitCode -eq 0[\s\S]*?if \(\$wingetInstallResult\.ExitCode -ne 0\) \{[\s\S]*?throw "winget install failed\."/,
  );
  assert.match(installPs1, /minisign is not available and could not be installed automatically/);
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

for (const powerShell of ['powershell.exe', 'pwsh']) {
test(`install.ps1 bootstraps the native minisign executable without winget under ${powerShell}`, {
  skip: process.platform !== 'win32' && 'Requires Windows executable and PowerShell boundaries',
}, async (t) => {
  const raw = (await readFile(installPs1Path, 'utf8')).replaceAll('\r\n', '\n');
  const functions = ['Resolve-MinisignExecutablePath', 'Invoke-NativeCommandCapturingOutput',
    'Test-InstallerAnimationDisabled', 'Test-InstallerTransientWebException', 'Invoke-InstallerWebRequestWithRetry', 'Ensure-Minisign'].map((name) => {
    const source = raw.match(new RegExp(`function ${name}\\s*\\{[\\s\\S]*?\\n\\}(?=\\n\\nfunction )`));
    assert.ok(source, `Missing installer function ${name}`);
    return source[0];
  });
  const scratch = await mkdtemp(join(tmpdir(), 'happier-minisign-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fixtureSource = join(scratch, 'Fixture.cs');
  await writeFile(fixtureSource, 'class Fixture { static int Main(string[] args) { return args.Length == 1 && args[0] == "-v" ? 0 : 17; } }');
  const binary = join(scratch, 'minisign.exe');
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:exe', `/out:${binary}`, fixtureSource], { encoding: 'utf8' });
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = join(scratch, 'exercise.ps1');
  const hash = raw.match(/\$expectedSha = "([a-f0-9]{64})"/)[1];
  await writeFile(script, [
    "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
    `$fixtureRoot = ${quote(scratch)}`,
    '$env:PATH = "$env:SystemRoot\\System32;$env:SystemRoot"',
    '$env:LOCALAPPDATA = $fixtureRoot', '$env:HAPPIER_NO_ANIMATION = "1"',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archiveRoot = Join-Path $fixtureRoot "archive"',
    // Both directories model the vendor archive. Native execution is an OS
    // boundary; the fixture verifies selection and successful version probing.
    'foreach ($arch in @("aarch64", "x86_64")) {',
    '  $dir = Join-Path $archiveRoot ("minisign-win64\\" + $arch)',
    '  [IO.Directory]::CreateDirectory($dir) | Out-Null',
    `  [IO.File]::Copy(${quote(binary)}, (Join-Path $dir 'minisign.exe'))`, '}',
    '$fixtureZip = Join-Path $fixtureRoot "fixture.zip"',
    '[IO.Compression.ZipFile]::CreateFromDirectory($archiveRoot, $fixtureZip)',
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
    ...functions,
    '$selected = Ensure-Minisign -TempRoot $fixtureRoot',
    '$arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq "Arm64") { "aarch64" } else { "x86_64" }',
    '$expected = Join-Path $fixtureRoot ("minisign-extract\\minisign-win64\\" + $arch + "\\minisign.exe")',
    'if ($selected -ne $expected) { throw ("Wrong minisign selected: " + $selected) }',
    'Write-Output "native-minisign-ready"',
  ].join('\n'));
  assert.match(execFileSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' }), /native-minisign-ready/);
});
}
