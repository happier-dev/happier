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

export function readProcessInstanceFingerprintSync(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;

  if (platform === 'linux') {
    try {
      const stat = String(readFileSyncImpl(`/proc/${normalizedPid}/stat`, 'utf8'));
      const closingParen = stat.lastIndexOf(')');
      const fieldsAfterCommand = closingParen >= 0
        ? stat.slice(closingParen + 1).trim().split(/\s+/)
        : [];
      const startTimeTicks = fieldsAfterCommand[19];
      if (/^\d+$/.test(String(startTimeTicks ?? ''))) {
        return `linux-proc:${startTimeTicks}`;
      }
    } catch {
      // Fall through to the portable POSIX probe.
    }
  }

  if (platform === 'win32') {
    // This probe is synchronous and runs on the daemon's event loop, so its cost matters.
    // The WMI/CIM query is the slow part (6-14 s observed on a managed Windows 11 laptop), while
    // .NET's Process.StartTime reads the same kernel creation time directly (~1-2 s, mostly
    // PowerShell startup). WMI reports CreationDate with microsecond precision, so truncating the
    // .NET value to whole microseconds produces exactly the same "O"-formatted string, and existing
    // fingerprints keep matching. A missing process (ArgumentException) exits 3 like the CIM path;
    // any other .NET failure (for example access denied) falls back to the original CIM query.
    const script = [
      `$t = $null; try { $t = [System.Diagnostics.Process]::GetProcessById(${normalizedPid}).StartTime.ToUniversalTime() } catch [System.ArgumentException] { exit 3 } catch { $t = $null }`,
      'if ($null -ne $t) { [DateTime]::new($t.Ticks - ($t.Ticks % 10), [DateTimeKind]::Utc).ToString("O"); exit 0 }',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${normalizedPid}" -ErrorAction Stop`,
      'if ($null -eq $p) { exit 3 }',
      '$p.CreationDate.ToUniversalTime().ToString("O")',
    ].join('; ');
    const value = runProbe('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], { spawnSyncImpl });
    return value ? `win32-cim:${value}` : null;
  }

  const value = runProbe('ps', ['-o', 'lstart=', '-p', String(normalizedPid)], { spawnSyncImpl });
  return value ? `${platform}-ps:${value}` : null;
}

export function processInstanceFingerprintMatches(expected, observed) {
  const normalizedExpected = String(expected ?? '').trim();
  const normalizedObserved = String(observed ?? '').trim();
  return Boolean(normalizedExpected && normalizedObserved && normalizedExpected === normalizedObserved);
}
