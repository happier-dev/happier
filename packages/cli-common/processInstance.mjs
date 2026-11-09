import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function normalizePid(pid) {
  const value = Number(pid);
  return Number.isInteger(value) && value > 1 ? value : null;
}

function runProbe(command, args, { spawnSyncImpl }) {
  const result = spawnSyncImpl(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result?.error || result?.status !== 0) return null;
  const value = String(result?.stdout ?? '').trim();
  return value || null;
}

const WINDOWS_PROCESS_NOT_FOUND_EXIT_CODE = 3;

function buildWindowsFingerprintScript(pid) {
  return [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop`,
    `if ($null -eq $p) { exit ${WINDOWS_PROCESS_NOT_FOUND_EXIT_CODE} }`,
    '$p.CreationDate.ToUniversalTime().ToString("O")',
  ].join('; ');
}

function buildWindowsPowerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

function formatWindowsFingerprint(creationDate) {
  return `win32-cim:${creationDate}`;
}

function readLinuxProcFingerprint(pid, readFileSyncImpl) {
  try {
    const stat = String(readFileSyncImpl(`/proc/${pid}/stat`, 'utf8'));
    const closingParen = stat.lastIndexOf(')');
    const fieldsAfterCommand = closingParen >= 0
      ? stat.slice(closingParen + 1).trim().split(/\s+/)
      : [];
    const startTimeTicks = fieldsAfterCommand[19];
    return /^\d+$/.test(String(startTimeTicks ?? '')) ? `linux-proc:${startTimeTicks}` : null;
  } catch {
    return null;
  }
}

export function readProcessInstanceFingerprintSync(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;

  if (platform === 'linux') {
    const fingerprint = readLinuxProcFingerprint(normalizedPid, readFileSyncImpl);
    if (fingerprint) return fingerprint;
  }

  if (platform === 'win32') {
    const value = runProbe('powershell.exe', buildWindowsPowerShellArgs(buildWindowsFingerprintScript(normalizedPid)), { spawnSyncImpl });
    return value ? formatWindowsFingerprint(value) : null;
  }

  const value = runProbe('ps', ['-o', 'lstart=', '-p', String(normalizedPid)], { spawnSyncImpl });
  return value ? `${platform}-ps:${value}` : null;
}

function classifyProbeBudget({ timeoutMs, signal }) {
  if (signal?.aborted) return { status: 'inconclusive', reason: 'process-identity-cancelled' };
  // A zero or missing budget must never reach a subprocess boundary, where it would mean "no limit".
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return { status: 'inconclusive', reason: 'process-identity-timeout' };
  }
  return null;
}

function classifyProbeError(error) {
  if (error?.code === 'ETIMEDOUT') return { status: 'inconclusive', reason: 'process-identity-timeout' };
  if (error?.code === 'ABORT_ERR') return { status: 'inconclusive', reason: 'process-identity-cancelled' };
  return { status: 'inconclusive', reason: 'process-identity-unavailable' };
}

/**
 * Deadline-bound, cancellable process identity. Unlike the synchronous reader it runs through the
 * caller's abortable process boundary, so a stalled probe cannot outlive the caller's budget. Failure
 * is inconclusive; there is deliberately no synchronous or alternate fallback.
 */
export async function observeProcessInstanceFingerprint(pid, {
  timeoutMs,
  signal,
  runCaptureImpl,
  platform = process.platform,
  readFileSyncImpl = readFileSync,
} = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return { status: 'not_found' };
  const budgetFailure = classifyProbeBudget({ timeoutMs, signal });
  if (budgetFailure) return budgetFailure;

  if (platform === 'linux') {
    const fingerprint = readLinuxProcFingerprint(normalizedPid, readFileSyncImpl);
    if (fingerprint) return { status: 'ok', fingerprint };
  }

  const isWindows = platform === 'win32';
  const command = isWindows ? 'powershell.exe' : 'ps';
  const args = isWindows
    ? buildWindowsPowerShellArgs(buildWindowsFingerprintScript(normalizedPid))
    : ['-o', 'lstart=', '-p', String(normalizedPid)];
  try {
    const value = String(await runCaptureImpl(command, args, { timeoutMs, signal }) ?? '').trim();
    if (!value) return { status: 'inconclusive', reason: 'process-identity-unavailable' };
    return { status: 'ok', fingerprint: isWindows ? formatWindowsFingerprint(value) : `${platform}-ps:${value}` };
  } catch (error) {
    const missingExitCode = isWindows ? WINDOWS_PROCESS_NOT_FOUND_EXIT_CODE : 1;
    if (error?.code === 'EEXIT' && error?.exitCode === missingExitCode) return { status: 'not_found' };
    return classifyProbeError(error);
  }
}

/**
 * One bounded walk from `pid` towards `stopAtPid` with each process's creation identity. The walk
 * ends at the stop process, a missing process or a repeated PID; verifying the chain is the
 * caller's decision through `isVerifiedProcessAncestry`.
 */
export async function observeWindowsProcessAncestry(pid, {
  stopAtPid,
  timeoutMs,
  signal,
  runCaptureImpl,
} = {}) {
  const normalizedPid = normalizePid(pid);
  const normalizedStopPid = normalizePid(stopAtPid);
  if (!normalizedPid || !normalizedStopPid) return { status: 'inconclusive', reason: 'process-identity-unavailable' };
  const budgetFailure = classifyProbeBudget({ timeoutMs, signal });
  if (budgetFailure) return budgetFailure;

  const script = [
    `$currentPid = ${normalizedPid}`,
    `$stopPid = ${normalizedStopPid}`,
    '$rows = @()',
    '$seen = @{}',
    'while ($currentPid -gt 0 -and -not $seen.ContainsKey($currentPid)) {',
    '  $seen[$currentPid] = $true',
    '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction Stop',
    '  if ($null -eq $proc) { break }',
    '  $rows += [pscustomobject]@{ pid = [int]$proc.ProcessId; parentPid = [int]$proc.ParentProcessId; creationDate = $proc.CreationDate.ToUniversalTime().ToString("O") }',
    '  if ($currentPid -eq $stopPid) { break }',
    '  $currentPid = [int]$proc.ParentProcessId',
    '}',
    'ConvertTo-Json -InputObject @($rows) -Compress',
  ].join('; ');
  try {
    const raw = await runCaptureImpl('powershell.exe', buildWindowsPowerShellArgs(script), { timeoutMs, signal });
    const parsed = JSON.parse(String(raw ?? ''));
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: normalizePid(row?.pid),
      parentPid: Number(row?.parentPid),
      fingerprint: typeof row?.creationDate === 'string' && row.creationDate
        ? formatWindowsFingerprint(row.creationDate)
        : null,
    }));
    if (rows.some((row) => !row.pid || !Number.isInteger(row.parentPid) || !row.fingerprint)) {
      return { status: 'inconclusive', reason: 'process-identity-unavailable' };
    }
    return { status: 'ok', rows };
  } catch (error) {
    return classifyProbeError(error);
  }
}

/**
 * True only for an unbroken leaf-to-ancestor chain in which no parent is newer than its child and
 * the ancestor still has the identity captured at spawn. A reused PID in the chain breaks ordering.
 */
export function isVerifiedProcessAncestry(rows, { leafPid, ancestorPid, ancestorFingerprint } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  if (rows[0]?.pid !== leafPid) return false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.pid === ancestorPid) {
      return processInstanceFingerprintMatches(ancestorFingerprint, row.fingerprint);
    }
    const parent = rows[index + 1];
    if (!parent || parent.pid !== row.parentPid) return false;
    if (String(parent.fingerprint) > String(row.fingerprint)) return false;
  }
  return false;
}

export function processInstanceFingerprintMatches(expected, observed) {
  const normalizedExpected = String(expected ?? '').trim();
  const normalizedObserved = String(observed ?? '').trim();
  return Boolean(normalizedExpected && normalizedObserved && normalizedExpected === normalizedObserved);
}
