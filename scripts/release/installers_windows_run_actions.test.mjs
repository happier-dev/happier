import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 supports a whitelisted post-install -Run action', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /\[string\]\s*\$Run\b/i);
  assert.match(trimmed, /\$RunArgs\b/i);
  assert.match(trimmed, /ValueFromRemainingArguments\s*=\s*\$true/i);
  assert.match(trimmed, /\$SetupRelay\b/i);
  assert.match(trimmed, /HAPPIER_INSTALLER_RUN_ACTION/i);
  assert.match(trimmed, /HAPPIER_INSTALLER_SETUP_RELAY/i);
  assert.match(trimmed, /HAPPIER_DAEMON_SERVICE_CHANNEL/i);
  assert.match(trimmed, /HAPPIER_PUBLIC_RELEASE_CHANNEL/i);
  assert.match(trimmed, /HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY/i);
  assert.match(trimmed, /auth-login/i);
  assert.match(trimmed, /service-install/i);
  assert.match(trimmed, /providers-setup/i);

  // Ensure the script does not accept arbitrary execution.
  assert.doesNotMatch(trimmed, /Invoke-Expression\s+\$Run/i);
});

test('install.ps1 resolves post-install relay actions through the requested lane shim', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const resolverMatch = raw.match(/function Resolve-InstalledCliInvoker\s*\{[\s\S]*?\n\}/);

  assert.ok(resolverMatch, 'expected Resolve-InstalledCliInvoker to exist');
  assert.match(resolverMatch[0], /\$shim\s*=\s*Resolve-CliShimName/i);
  assert.doesNotMatch(
    resolverMatch[0],
    /\$target\b/,
    'preview/dev run actions must not fall back to the generic stable happier.exe invoker',
  );
});

test('install.ps1 applies setup-relay default relay-host arguments for both shortcut and explicit -Run usage', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const invokePostInstallAction = raw.match(/function Invoke-PostInstallAction\s*\{[\s\S]*?\n\}/);

  assert.ok(invokePostInstallAction, 'expected Invoke-PostInstallAction to exist');
  assert.match(
    invokePostInstallAction[0],
    /\$setupRelayDefaultArgs\s*=\s*@\("--mode",\s*"user",\s*"--yes",\s*"--channel",\s*\$\(if \(\$Channel -eq "publicdev"\) \{ "dev" \} else \{ \$Channel \}\),\s*"--preserve-active-server"\)/i,
    'expected setup-relay default args to include preserve-active-server and the normalized channel',
  );
  assert.match(
    invokePostInstallAction[0],
    /if \(\$runValue -eq "setup-relay" -and \$setupRelayDefaultArgs\.Count -eq 0\) \{\s*\$setupRelayDefaultArgs = @\("--mode", "user", "--yes", "--channel", \$\(if \(\$Channel -eq "publicdev"\) \{ "dev" \} else \{ \$Channel \}\), "--preserve-active-server"\)\s*\}/i,
    'expected explicit -Run setup-relay to receive the same default relay-host arguments as the setup-relay shortcut',
  );
  assert.match(
    raw,
    /function Get-SupportedSetupRelayDefaultArgs[\s\S]*relay host install --help/i,
    'expected PowerShell installer to filter setup-relay defaults against relay host install help',
  );
  assert.match(
    invokePostInstallAction[0],
    /Get-SupportedSetupRelayDefaultArgs\s+-CliPath\s+\$CliPath/i,
    'expected PowerShell setup-relay invocation to filter unsupported default args before invoking older CLIs',
  );
});
