import { runCapture } from './proc.mjs';

const WINDOWS_FINGERPRINT_PREFIX = 'win32-cim:';

const LIST_PROCESSES_SCRIPT = [
  '$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CreationDate } | ForEach-Object {',
  '[pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; creationDate = $_.CreationDate.ToUniversalTime().ToString("O") }',
  '}); ConvertTo-Json -InputObject $rows -Compress',
].join(' ');

const INCONCLUSIVE = { status: 'inconclusive', reason: 'process_tree_unavailable' };

function isProcessRow(row) {
  return Number.isInteger(row?.pid) && Number.isInteger(row?.parentPid) && typeof row?.creationDate === 'string' && row.creationDate;
}

/**
 * Lists what is still running from the tree of an exited leader. A live process names its parent by
 * PID even after that parent has gone, and creation times separate real children from older processes
 * that only share a reused PID. A child that exited earlier breaks the chain to anything it left
 * running, so `none` means no live process traces back to the leader.
 */
export async function observeWindowsProcessDescendants(pid, {
  fingerprint,
  timeoutMs,
  signal,
  runCaptureImpl = runCapture,
} = {}) {
  const expected = String(fingerprint ?? '').trim();
  if (!expected.startsWith(WINDOWS_FINGERPRINT_PREFIX)) return INCONCLUSIVE;

  let rows;
  try {
    const script = ['-NoProfile', '-NonInteractive', '-Command', LIST_PROCESSES_SCRIPT];
    rows = JSON.parse(String(await runCaptureImpl('powershell.exe', script, { timeoutMs, signal }) ?? ''));
  } catch {
    return INCONCLUSIVE;
  }
  if (!Array.isArray(rows) || !rows.every(isProcessRow)) return INCONCLUSIVE;
  if (rows.some((row) => row.pid === pid)) return INCONCLUSIVE;

  const createdAtByPid = new Map([[pid, expected.slice(WINDOWS_FINGERPRINT_PREFIX.length)]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      const parentCreatedAt = createdAtByPid.get(row.parentPid);
      if (createdAtByPid.has(row.pid) || parentCreatedAt === undefined || row.creationDate < parentCreatedAt) continue;
      createdAtByPid.set(row.pid, row.creationDate);
      grew = true;
    }
  }
  const pids = [...createdAtByPid.keys()].slice(1);
  return pids.length > 0 ? { status: 'present', pids } : { status: 'none' };
}
