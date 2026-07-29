import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

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
    /\$runnerBinaryPath\s*=\s*Join-Path\s+\$env:TEMP\s+"happier-payload-promotion-\$runToken\.exe"/i,
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
    /Remove-Item\s+-Path\s+\$runnerBinaryPath\s+-Force\s+-ErrorAction\s+SilentlyContinue/i,
    'expected temporary promotion runner cleanup',
  );
});

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
