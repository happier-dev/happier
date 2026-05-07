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
  assert.ok(bashSource.includes('doctor repair --json'), 'expected bash installer to prefer aggregated doctor repair preflight when available');
  assert.ok(bashSource.includes('daemonRunning'), 'expected bash installer to consume aggregated daemon status from doctor repair preflight');
  assert.ok(
    bashSource.includes('defaultFollowingMatchesSelectedReleaseChannel'),
    'expected bash installer to consume aggregated default-following channel matching from doctor repair preflight when available',
  );
  assert.ok(bashSource.includes('doctor repair --report-only'), 'expected bash installer to delegate interactive post-install reporting to doctor repair');
  assert.ok(bashSource.includes('run_background_service_repair_if_supported'), 'expected bash installer replace-existing path to route through the repair compatibility helper');
  assert.ok(bashSource.includes('background_service_inventory_has_default_following'), 'expected bash installer to distinguish singleton default services from add-another flows');

  assert.ok(powershellSource.includes('service", "list", "--json"'), 'expected PowerShell installer to preflight installed background services');
  assert.ok(powershellSource.includes('daemonRunning'), 'expected PowerShell installer to consume aggregated daemon status from doctor repair preflight');
  assert.ok(powershellSource.includes('@("doctor", "repair", "--report-only")'), 'expected PowerShell installer to delegate interactive post-install reporting to doctor repair');
  assert.ok(powershellSource.includes('Invoke-DoctorRepairIfSupported'), 'expected PowerShell installer replace-existing path to route through the repair compatibility helper');
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
  assert.match(
    powershellSource,
    /if \(\$entries\.Count -gt 0 -or \$services\.Count -gt 0 -or \$propertyNames -contains 'entries' -or \$propertyNames -contains 'services'\)/,
    'expected PowerShell installer to treat empty legacy inventories as supported rather than unsupported',
  );
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

test('installers preserve existing background services during noninteractive preview/dev updates', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /if background_service_inventory_is_supported "\$\{services_json\}" && ! background_service_inventory_is_empty "\$\{services_json\}"; then[\s\S]*if \[\[ "\$\{NONINTERACTIVE\}" == "1" \]\]; then[\s\S]*echo "1"/,
    'expected bash installer to preserve existing managed services during noninteractive updates',
  );
  assert.match(
    powershellSource,
    /\$hasExistingServices = \$Entries\.Count -gt 0[\s\S]*if \(\$Noninteractive -eq "1"\) \{[\s\S]*if \(\$hasExistingServices\) \{[\s\S]*return "1"/,
    'expected PowerShell installer to preserve existing managed services during noninteractive updates',
  );
});

test('installers prefer doctor repair --report-only for interactive post-install summaries when supported', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('doctor repair --report-only'), 'expected bash installer to prefer doctor repair --report-only for post-install summaries');
  assert.doesNotMatch(
    bashSource,
    /report_text=.*doctor repair --report-only|doctor repair --report-only.*report_text=/,
    'expected bash installer to stream doctor repair --report-only directly (preserving colors) rather than capturing output',
  );
  assert.doesNotMatch(
    bashSource,
    /print_installed_background_service_summary|Installed background services:|Local relays:/,
    'expected bash installer to avoid shell-owned post-install summary rendering',
  );
  assert.ok(
    powershellSource.includes('@("doctor", "repair", "--report-only")'),
    'expected PowerShell installer to prefer doctor repair --report-only for post-install summaries',
  );
  assert.doesNotMatch(
    powershellSource,
    /Get-BackgroundServiceReportText|Invoke-NativeCommandCapturingOutput[\s\S]{0,1200}@\(\"doctor\",\s*\"repair\",\s*\"--report-only\"\)/,
    'expected PowerShell installer to stream doctor repair --report-only directly (preserving colors) rather than capturing output',
  );
  assert.doesNotMatch(
    powershellSource,
    /Show-InstalledBackgroundServiceSummary|Show-InstalledLocalRelaySummary|Installed background services:|Local relays:/,
    'expected PowerShell installer to avoid PowerShell-owned post-install summary rendering',
  );
});

test('PowerShell installer attempts doctor repair --report-only even before any background service exists', async () => {
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    powershellSource,
    /\$shouldInspectBackgroundServices[\s\S]*\$backgroundServiceInventory = Get-InstalledBackgroundServiceInventory[\s\S]*\$backgroundServiceInventory\.RepairSupported[\s\S]*@\(\"doctor\",\s*\"repair\",\s*\"--report-only\"\)/,
    'expected PowerShell installer to try doctor repair --report-only for interactive installs even when no background service is installed yet',
  );
});

test('PowerShell installer treats doctor repair preflight crashes as non-fatal', async () => {
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    powershellSource,
    /\$doctorPreflightResult\s*=\s*Invoke-NativeCommandCapturingOutput[\s\S]*@\("doctor",\s*"repair",\s*"--json"\)/,
    'expected doctor repair preflight to be captured as a native command result',
  );
  assert.match(
    powershellSource,
    /if\s*\(\$doctorPreflightResult\.ExitCode\s*-eq\s*0\s*-and\s*\$preflightJsonIsSupported\s*-and\s*-not\s*\$preflightLooksLikePlainReport\)/,
    'expected installer to parse doctor repair JSON only after a successful native exit AND the output passed the fail-closed shape checks (mirrors install.sh:835-862)',
  );
  assert.match(
    powershellSource,
    /Write-Warning\s+"Automatic startup inspection failed; continuing without blocking install/,
    'expected installer to warn briefly instead of aborting when doctor repair preflight crashes',
  );
  assert.match(
    powershellSource,
    /\$serviceListResult\s*=\s*Invoke-NativeCommandCapturingOutput[\s\S]*@\("service",\s*"list",\s*"--json"\)/,
    'expected installer to fall back to legacy service list preflight after doctor repair failure',
  );
});

test('installers reuse --yes when auto-installing a background service after noninteractive repair', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('run_background_service_repair_if_supported'), 'expected bash installer to centralize repair compatibility handling');
  assert.ok(bashSource.includes('run_background_service_install_compatibly'), 'expected bash installer to centralize service-install compatibility handling');
  assert.ok(powershellSource.includes('Invoke-DoctorRepairIfSupported'), 'expected PowerShell installer to centralize repair compatibility handling');
  assert.ok(powershellSource.includes('Invoke-BackgroundServiceInstallCompatibly'), 'expected PowerShell installer to centralize service-install compatibility handling');
});

test('installers skip doctor repair execution when the installed CLI only exposes legacy service commands', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /run_background_service_repair_if_supported[\s\S]*if \[\[ "\$\{repair_status\}" == "2" \]\]; then[\s\S]*run_background_service_install_compatibly/,
    'expected bash installer to bypass doctor repair execution when the command is unsupported and continue with legacy service install',
  );
  assert.match(
    powershellSource,
    /Invoke-DoctorRepairIfSupported[\s\S]*elseif \(\$repairResult\.Status -eq 'unsupported'\) \{[\s\S]*Invoke-BackgroundServiceInstallCompatibly/,
    'expected PowerShell installer to bypass doctor repair execution when the command is unsupported and continue with legacy service install',
  );
});

test('installers filter unsupported setup-relay default flags against the installed CLI help surface', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('filter_supported_setup_relay_default_args'), 'expected bash installer to filter setup-relay default args against relay host install help');
  assert.match(
    powershellSource,
    /Get-SupportedSetupRelayDefaultArgs[\s\S]*relay host install --help/,
    'expected PowerShell installer to filter setup-relay default args against relay host install help',
  );
});
