import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const harnessScriptPath = join(repoRoot, 'scripts', 'release', 'windows-clean-wave-single-session.ps1');

test('L59 clean-wave harness uses install-specific timeout budgets and timeout diagnostics', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function\s+Resolve-InstallerRowTimeoutSeconds/i,
    'expected the harness to define an install-timeout resolver with env-configurable budgets',
  );
  assert.match(
    trimmed,
    /function\s+Get-InstallerTimeoutDiagnostics/i,
    'expected the harness to capture deterministic diagnostics when install rows time out',
  );
  assert.match(
    trimmed,
    /Resolve-InstallerRowTimeoutSeconds\s+-DefaultSeconds\s+\$DefaultSeconds/i,
    'expected installer wrapper to derive timeout budgets from the shared install-timeout resolver',
  );
  assert.match(
    trimmed,
    /if\s*\(\$result\.timedOut\)\s*\{[\s\S]*Get-InstallerTimeoutDiagnostics/i,
    'expected timeout diagnostics to execute in the row-command path when an install command times out',
  );
});

test('L59 clean-wave harness preflights stale installer holders before each installer invocation', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function\s+Invoke-InstallerCommandWithPreflight/i,
    'expected a dedicated wrapper that runs scoped preflight before installer commands',
  );
  assert.match(
    trimmed,
    /Invoke-InstallerHolderPreflightCleanup/i,
    'expected installer wrapper to run stale-holder cleanup before invoking helper install actions',
  );
});

test('L59 clean-wave harness falls back to taskkill when preflight stop-process fails', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function\s+Stop-InstallerHolderProcess/i,
    'expected harness to centralize stale-holder termination in a helper',
  );
  assert.match(
    trimmed,
    /Stop-InstallerHolderProcess[\s\S]*Stop-Process[\s\S]*taskkill\.exe/i,
    'expected stale-holder termination to fall back to taskkill.exe after Stop-Process failures',
  );
  assert.match(
    trimmed,
    /Stop-InstallerHolderProcess\s+-ProcessId\s+\$proc\.ProcessId\s+-ProcessName\s+\$proc\.Name/i,
    'expected preflight cleanup to route matching stale holders through the termination helper',
  );
});

test('L59 clean-wave harness emits a compact final row-status summary', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function\s+Build-RunFinalSummary/i,
    'expected harness to define a compact final-summary builder for post-run JSON emission',
  );
  assert.match(
    trimmed,
    /rowStatus\s*=\s*@\(/i,
    'expected final summary to expose row-level statuses for machine-readable closure checks',
  );
  assert.match(
    trimmed,
    /ConvertTo-Json\s+-Depth\s+6\s+-Compress/i,
    'expected compact JSON emission to use bounded depth and compressed output',
  );
  assert.match(
    trimmed,
    /\$runFinalSummary\s*=\s*Build-RunFinalSummary\s+-Run\s+\$run/i,
    'expected final emission to serialize the compact row-status summary instead of raw nested runtime objects',
  );
});

test('L59 clean-wave harness bounds WMI process lookups with safe timeout wrapper', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function\s+Get-CimProcessesSafe/i,
    'expected harness to define a safe process-query wrapper around WMI calls',
  );
  assert.match(
    trimmed,
    /-OperationTimeoutSec\s+\$TimeoutSeconds/i,
    'expected WMI lookups to use bounded operation timeout to avoid indefinite preflight hangs',
  );
  assert.match(
    trimmed,
    /Get-CimProcessesSafe\s*(\||-Filter)/i,
    'expected WMI process retrieval call sites to route through the safe wrapper',
  );
});

test('L59 clean-wave harness captures timeout tasklist diagnostics via bounded external invocation', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /Get-InstallerTimeoutDiagnostics[\s\S]*Invoke-External\s+-FilePath\s+"cmd\.exe"[\s\S]*-TimeoutSeconds\s+20/i,
    'expected timeout diagnostics to collect tasklist output through Invoke-External with explicit timeout',
  );
  assert.doesNotMatch(
    trimmed,
    /Get-InstallerTimeoutDiagnostics[\s\S]*cmd\.exe\s+\/d\s+\/s\s+\/c\s+"tasklist/i,
    'expected timeout diagnostics to avoid raw tasklist command execution that can abort the harness',
  );
});

test('L59 clean-wave harness removes stale bak directories via best-effort long-path cleanup helper', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function\s+Remove-DirectoryTreeBestEffort/i,
    'expected harness to define a dedicated best-effort directory cleanup helper for stale bak trees',
  );
  assert.match(
    trimmed,
    /Remove-DirectoryTreeBestEffort\s+-Path\s+\$dir\.FullName/i,
    'expected stale bak cleanup call sites to route through the best-effort helper',
  );
  assert.match(
    trimmed,
    /rd\s+\/s\s+\/q/i,
    'expected best-effort cleanup helper to include cmd rd fallback for deep Windows path trees',
  );
});

test('L59 clean-wave harness preflight cleans qa extract root to prevent disk-exhaustion retries', async () => {
  const raw = await readFile(harnessScriptPath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /function\s+Invoke-QaExtractRootPreflightCleanup/i,
    'expected harness to define extract-root preflight cleanup helper',
  );
  assert.match(
    trimmed,
    /Invoke-QaExtractRootPreflightCleanup\s+-RowId\s+"PREFLIGHT"/i,
    'expected preflight stage to invoke extract-root cleanup before installer rows',
  );
  assert.match(
    trimmed,
    /Preflight extract cleanup removed dirs:/i,
    'expected preflight stage to emit extract cleanup counts for evidence traceability',
  );
});
