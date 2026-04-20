import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  assert.match(installSh, /Signature verified\./);
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
  assert.match(installPs1, /&\s+\$exe\.FullName\s+--version\s+\*>\s+\$null/);
  assert.match(installPs1, /winget\s+install\s+--id\s+jedisct1\.minisign\s+--accept-source-agreements\s+--accept-package-agreements/i);
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
    /\$wingetInstallResult\.ExitCode -ne 0 -and \$wingetInstallResult\.Output[\s\S]*?\$wingetMinisign = Resolve-MinisignExecutablePath[\s\S]*?if \(\$wingetMinisign\) \{[\s\S]*?if \(\$wingetInstallResult\.ExitCode -ne 0\) \{[\s\S]*?throw "winget install failed\."/,
  );
  assert.match(installPs1, /minisign is not available and could not be installed automatically/);
  assert.match(installPs1, /Payload promotion failed, falling back to direct binary copy\./);
  assert.doesNotMatch(installPs1, /\$promotionOutput = & \$binary self __install-payload .*2>&1 \| Out-String/);
  assert.doesNotMatch(installPs1, /Unknown self subcommand:\s+__install-payload/);
  assert.ok(publicKeyPayload.length > 10);
  assert.ok(installPs1.includes(publicKeyPayload), 'install.ps1 should embed the release minisign public key payload');
});

test('release-owned minisign public key exists', async () => {
  const publicKey = await readFile(publicKeyPath, 'utf8');
  assert.match(publicKey, /minisign public key/i);
  assert.match(publicKey, /^RWQ/m);
});
