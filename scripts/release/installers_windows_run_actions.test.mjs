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
});

// PowerShell double-quoted strings do NOT treat backslash as an escape character (the escape
// character is a backtick). A regex written as "\\s" inside a double-quoted string therefore
// reaches .NET Regex as an escaped literal backslash followed by a literal "s" -- never
// whitespace. The -Run / -SetupRelay support gate builds its pattern in a double-quoted string
// (it needs $(...) subexpression interpolation), so a stray doubled backslash there silently
// makes the gate unmatchable and every -Run / -SetupRelay invocation throws
// "Installed Happier CLI does not support ...". No PowerShell host is available in CI, so this
// test reproduces the PowerShell string rule in JS and evaluates the resulting regex for real.
const POWERSHELL_HELP_FIXTURE = [
  'Usage: happier relay <command>',
  '',
  'Commands:',
  '  happier relay host        Manage relay hosts',
  '  happier relay status      Show relay status',
  '',
].join('\n');

const POWERSHELL_HELP_FIXTURE_WITHOUT_SUBCOMMAND = [
  'Usage: happier <command>',
  '',
  'Commands:',
  '  happier doctor            Diagnose the installation',
  '',
].join('\n');

const escapeForDotNetRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('install.ps1 -Run support gate builds a regex that actually matches CLI help output', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  const patternAssignment = raw.match(/\$pattern\s*=\s*"([^"\n]*)"/);
  assert.ok(patternAssignment, 'expected the -Run support gate to assign $pattern from a double-quoted string');

  // PowerShell interpolation of the two $([Regex]::Escape(...)) subexpressions. Everything else
  // in the literal is passed through verbatim, because backslash is not an escape here.
  const interpolated = patternAssignment[1]
    .replace('$([Regex]::Escape($invokerName))', escapeForDotNetRegex('happier.exe'))
    .replace('$([Regex]::Escape($requiredSubcommand))', escapeForDotNetRegex('relay'));

  assert.ok(
    interpolated.startsWith('(?m)'),
    `expected the gate pattern to be multiline; got ${interpolated}`,
  );
  const compiled = new RegExp(interpolated.slice('(?m)'.length), 'm');

  assert.ok(
    compiled.test(POWERSHELL_HELP_FIXTURE),
    `the -Run support gate regex ${compiled.source} does not match real 'happier relay --help' output, so every -Run/-SetupRelay invocation would throw`,
  );
  assert.ok(
    !compiled.test(POWERSHELL_HELP_FIXTURE_WITHOUT_SUBCOMMAND),
    `the -Run support gate regex ${compiled.source} matches help output that lacks the required subcommand`,
  );
});

test('install.ps1 never writes a regex shorthand class as a doubled backslash', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  const offenders = raw
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => /\\\\[sSdDwWbB]/.test(line))
    .map(({ line, lineNumber }) => `install.ps1:${lineNumber}: ${line.trim()}`);

  assert.deepEqual(
    offenders,
    [],
    'PowerShell does not treat backslash as an escape in double-quoted strings, so a doubled backslash before a regex shorthand class matches a literal backslash instead',
  );
});
