import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const installersRoot = join(repoRoot, 'scripts', 'release', 'installers');
const installShPath = join(installersRoot, 'install.sh');
const selfHostShPath = join(installersRoot, 'self-host.sh');

function extractArgCaseBlock(script, label) {
  const start = script.indexOf(label);
  assert.ok(start >= 0, `expected to find case label: ${label}`);
  const end = script.indexOf(';;', start);
  assert.ok(end >= 0, `expected to find end of case block (;;) for: ${label}`);
  return script.slice(start, end + 2);
}

function assertInstallerVerboseMode(script, name) {
  assert.ok(script.includes('HAPPIER_INSTALLER_VERBOSE'), `${name} should support HAPPIER_INSTALLER_VERBOSE`);
  assert.ok(script.includes('--verbose)'), `${name} should parse --verbose`);
  assert.ok(script.includes('VERBOSE_MODE="1"'), `${name} should set VERBOSE_MODE`);
  assert.ok(script.includes('  --verbose'), `${name} usage should mention --verbose`);

  // Debug implies verbose (keeps tmp dir + surfaces underlying tool output).
  assert.ok(
    script.includes('--debug)\n      DEBUG_MODE="1"\n      VERBOSE_MODE="1"'),
    `${name} --debug should imply verbose`,
  );
  assert.ok(
    script.includes('if [[ "${DEBUG_MODE}" == "1" ]]; then\n  VERBOSE_MODE="1"'),
    `${name} DEBUG_MODE should imply VERBOSE_MODE`,
  );

  // In verbose mode, do not suppress tar warnings (useful for diagnostics).
  assert.match(
    script,
    /tar_extract_gz\(\)[\s\S]*if \[\[ "\$\{VERBOSE_MODE\}" == "1" \]\]; then\s+tar -xzf /,
    `${name} tar_extract_gz should not filter in verbose mode`,
  );

  // Verbose mode should keep the temp dir for inspection (same as debug).
  assert.ok(
    script.includes('if [[ "${DEBUG_MODE}" == "1" || "${VERBOSE_MODE}" == "1" ]]; then'),
    `${name} should keep TMP_DIR in verbose/debug mode`,
  );
}

test('installers support a --verbose flag without enabling set -x', async () => {
  const installSh = await readFile(installShPath, 'utf8');
  const selfHostSh = await readFile(selfHostShPath, 'utf8');

  assertInstallerVerboseMode(installSh, 'install.sh');
  assertInstallerVerboseMode(selfHostSh, 'self-host.sh');

  // set -x stays exclusive to --debug.
  assert.ok(extractArgCaseBlock(installSh, '--debug)').includes('DEBUG_MODE="1"'));
  assert.ok(!extractArgCaseBlock(installSh, '--verbose)').includes('set -x'));
  assert.ok(extractArgCaseBlock(selfHostSh, '--debug)').includes('DEBUG_MODE="1"'));
  assert.ok(!extractArgCaseBlock(selfHostSh, '--verbose)').includes('set -x'));
});
