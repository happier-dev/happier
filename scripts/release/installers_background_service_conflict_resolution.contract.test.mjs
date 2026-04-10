import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('installers perform installed-service preflight before interactive background-service replacement choices', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('service list --json'), 'expected bash installer to preflight installed background services');
  assert.ok(bashSource.includes('service repair --json'), 'expected bash installer to prefer aggregated background-service repair preflight when available');
  assert.ok(bashSource.includes('service list 2>/dev/null'), 'expected bash installer to print installed background-service summaries');
  assert.ok(bashSource.includes('service status 2>/dev/null'), 'expected bash installer to print current background-service owner status');
  assert.match(
    bashSource,
    /Switching managed background-service startup to this release-channel[\s\S]*service repair --yes/,
    'expected bash installer replace-existing path to route through service repair',
  );
  assert.ok(bashSource.includes('background_service_inventory_has_default_following'), 'expected bash installer to distinguish singleton default services from add-another flows');

  assert.ok(powershellSource.includes('service", "list", "--json"'), 'expected PowerShell installer to preflight installed background services');
  assert.ok(powershellSource.includes('@("service", "list")'), 'expected PowerShell installer to print installed background-service summaries');
  assert.ok(powershellSource.includes('@("service", "status")'), 'expected PowerShell installer to print current background-service owner status');
  assert.match(
    powershellSource,
    /Switching managed background-service startup to this release-channel[\s\S]*@\("service", "repair", "--yes"\)/,
    'expected PowerShell installer replace-existing path to route through service repair',
  );
  assert.ok(powershellSource.includes(".targetMode -eq 'default-following'"), 'expected PowerShell installer to distinguish singleton default services from add-another flows');
});

test('installers accept both service-list JSON shapes used by dev and remote-dev', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /"\(entries\|services\|existingServices\)"/,
    'expected bash installer to recognize entries/services/existingServices inventory shapes',
  );
  assert.match(
    bashSource,
    /"\(entries\|services\|existingServices\)".*\\\[/,
    'expected bash installer to recognize empty inventories even when JSON is pretty-printed',
  );

  assert.ok(powershellSource.includes('$payload.entries'), 'expected PowerShell installer to read entries inventories');
  assert.ok(powershellSource.includes('$payload.services'), 'expected PowerShell installer to read services inventories');
});

test('installers silently skip automatic background-service setup when the installed CLI lacks service-list support', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(
    bashSource.includes('background_service_inventory_is_supported'),
    'expected bash installer to detect unsupported background-service management surfaces',
  );
  assert.ok(
    powershellSource.includes('Supported = $false'),
    'expected PowerShell installer to detect unsupported background-service management surfaces',
  );
});

test('installers explain existing background services before asking whether to update startup behavior', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('Current background services:'), 'expected bash installer to show installed background services before prompting');
  assert.ok(
    bashSource.includes('Switch the managed default background service to this release-channel'),
    'expected bash installer to explain managed default release-channel behavior when services already exist',
  );

  assert.ok(powershellSource.includes('Current background services:'), 'expected PowerShell installer to show installed background services before prompting');
  assert.ok(
    powershellSource.includes('Switch the managed default background service to this release-channel'),
    'expected PowerShell installer to explain managed default release-channel behavior when services already exist',
  );
});

test('installers reuse --yes when auto-installing a background service after noninteractive repair', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /Reconciling existing background services \(best-effort\)\.\.\.[\s\S]*service repair --yes[\s\S]*service install --yes/,
    'expected bash installer to auto-confirm service install after noninteractive repair',
  );
  assert.match(
    powershellSource,
    /Reconciling existing background services \(best-effort\)\.\.\.[\s\S]*@\("service", "repair", "--yes"\)[\s\S]*@\("service", "install", "--yes"\)/,
    'expected PowerShell installer to auto-confirm service install after noninteractive repair',
  );
});
